-- 「查無變更」（no_change）的驗證票往後排（2026-10-28，維護者）
--
-- 起因：近 12 小時上線 794 筆，其中 439 筆是 no_change——不增加收錄人數；待審的驗證票裡 no_change 有 1,167 件（775 件超過 24 小時），
-- 跟人物資料、候選資料、政見混在一起照時間排，擠掉真的帶新內容的驗證票。
-- 維護者的順序：網站請求 > 其他型別 > 查無變更（被延後）。
--
-- 做法（沿用優先秒數那一套，反向用）：
--   · task_dispatches.defer_seconds：驗證列的延後秒數，排序鍵最後「加」這個值（插隊秒數是減）。
--   · queue_settings.no_change_verify_defer_seconds（預設 1 天）：no_change 的驗證票第一次進隊的延後。
--   · queue_settings.no_change_verify_redispatch_defer_seconds（預設 2 天）：被派出去沒湊滿票、回到隊列的每一次，延後改成這個值（不累加）。
--   · 網站請求來源（母任務 source='web_request'）的 no_change 不延後——網站請求在最前面。
--   · 這支 migration 把現有待審的 no_change 驗證票一次延後 10 天。
--   · 延後只改 queue_at 的順序，不是停派；驗證池（contribution_verify_pool）依 queue_at 排、沒有「晚於現在不派」的條件，所以延後到的人照樣會被輪到。
-- 要調整：UPDATE queue_settings SET no_change_verify_defer_seconds = 0 …（0＝不延後）；日本站不跟（維持原樣）。

ALTER TABLE queue_settings
  ADD COLUMN IF NOT EXISTS no_change_verify_defer_seconds INTEGER NOT NULL DEFAULT 86400
    CHECK (no_change_verify_defer_seconds BETWEEN 0 AND 31536000),
  ADD COLUMN IF NOT EXISTS no_change_verify_redispatch_defer_seconds INTEGER NOT NULL DEFAULT 172800
    CHECK (no_change_verify_redispatch_defer_seconds BETWEEN 0 AND 31536000);
COMMENT ON COLUMN queue_settings.no_change_verify_defer_seconds IS 'no_change 驗證票第一次進隊的延後秒數（1 天）；0＝不延後。網站請求來源的不延後。2026-10-28';
COMMENT ON COLUMN queue_settings.no_change_verify_redispatch_defer_seconds IS 'no_change 驗證票被派出去沒湊滿票、回到隊列時的延後秒數（2 天，不累加）；0＝不延後。2026-10-28';

ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS defer_seconds INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN task_dispatches.defer_seconds IS '驗證列：排序鍵最後加的延後秒數（no_change 往後排，queue_settings.no_change_verify_*）；任務列不看這欄，一律 0。2026-10-28';

-- 這張驗證票現在該延後幾秒：只有 no_change 且母任務不是網站請求才延後
CREATE OR REPLACE FUNCTION verify_ticket_defer_seconds(p_verify_task_id TEXT, p_redispatched BOOLEAN) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT CASE WHEN p_redispatched THEN q.no_change_verify_redispatch_defer_seconds ELSE q.no_change_verify_defer_seconds END
      FROM contributions c, queue_settings q
     WHERE c.id = uuid_or_null(substr(p_verify_task_id, 8))
       AND c.contribution_type = 'no_change'
       AND q.id = 1
       AND NOT EXISTS (SELECT 1 FROM contribution_tasks t
                        WHERE t.id = uuid_if_canonical(COALESCE(c.task_id, c.payload->>'task_id')) AND t.source = 'web_request')
  ), 0)
$$;
COMMENT ON FUNCTION verify_ticket_defer_seconds IS '驗證票的延後秒數（2026-10-28）：no_change 且母任務不是網站請求＝queue_settings 的延後值（第一次進隊用 no_change_verify_defer_seconds，被派出過用 no_change_verify_redispatch_defer_seconds），其餘 0';

-- 排序鍵多一個延後參數（最後加）；舊的五參數版本拿掉，避免兩個版本並存
DROP FUNCTION IF EXISTS verify_queue_key(TEXT, BOOLEAN, TIMESTAMPTZ, INTEGER, BIGINT);
CREATE OR REPLACE FUNCTION verify_queue_key(
  p_task_id TEXT, p_follows_task BOOLEAN, p_last_dispatched_at TIMESTAMPTZ, p_priority_seconds INTEGER, p_boost_seconds BIGINT,
  p_defer_seconds INTEGER DEFAULT 0
) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN NOT COALESCE(p_follows_task, true)
             THEN COALESCE(p_last_dispatched_at, now()) - make_interval(secs => COALESCE(p_priority_seconds, 0) + s.vs)
           WHEN t.is_new
             THEN COALESCE(t.created_at, p_last_dispatched_at, now()) - make_interval(secs => s.vs)
           ELSE COALESCE((SELECT task_queue_key(COALESCE(p.last_dispatched_at, now()),
                                                CASE WHEN s.inherit_negative THEN p.priority_seconds ELSE GREATEST(p.priority_seconds, 0) END,
                                                p.cool_until, p.boost_seconds)
                            FROM task_dispatches p WHERE p.task_id = t.parent_id) - make_interval(secs => s.vs),
                         COALESCE(p_last_dispatched_at, now()) - make_interval(secs => COALESCE(p_priority_seconds, 0) + s.vs))
         END - make_interval(secs => COALESCE(p_boost_seconds, 0)) + make_interval(secs => COALESCE(p_defer_seconds, 0))
    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM queue_settings q WHERE q.id = 1), 0) AS vs,
                 COALESCE((SELECT q.verify_inherit_negative FROM queue_settings q WHERE q.id = 1), false) AS inherit_negative) s
    LEFT JOIN verify_ticket_parent(p_task_id) t ON true
$$;
COMMENT ON FUNCTION verify_queue_key IS '驗證票的排序鍵（2026-10-17；2026-10-28 加延後）：一般任務＝母任務的排序鍵 − 14 天、新增型＝建立時間 − 14 天、派出後＝派出時間 − 優先秒數 − 14 天；最後減自己的插隊秒數、加延後秒數（no_change 往後排，task_dispatches.defer_seconds）';

CREATE OR REPLACE FUNCTION task_dispatches_queue_key() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count THEN
    NEW.boost_seconds := 0;  -- 插隊是一次性的：派出就歸零，回隊尾
  END IF;
  IF NEW.task_id LIKE 'verify:%' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.priority_seconds := verify_ticket_priority_seconds(NEW.task_id);
    END IF;
    -- 被領走一次就不再跟著母任務（回隊尾，照舊）：UPDATE 時 dispatch_count 變了，或直接以派出過的狀態 INSERT（task_dispatched 補列）
    IF (TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count) OR (TG_OP = 'INSERT' AND COALESCE(NEW.dispatch_count, 0) > 0) THEN
      NEW.verify_follows_task := false;
    END IF;
    -- >>> no_change 往後排（20261028140000）：進隊與每次被派出去回隊列時重算延後秒數；其他更新沿用現有值
    IF TG_OP = 'INSERT' THEN
      NEW.defer_seconds := verify_ticket_defer_seconds(NEW.task_id, COALESCE(NEW.dispatch_count, 0) > 0);
    ELSIF NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count THEN
      NEW.defer_seconds := verify_ticket_defer_seconds(NEW.task_id, true);
    END IF;
    NEW.queue_at := verify_queue_key(NEW.task_id, NEW.verify_follows_task, NEW.last_dispatched_at, NEW.priority_seconds, NEW.boost_seconds, NEW.defer_seconds);
    -- <<< no_change 往後排
  ELSE
    NEW.queue_at := task_queue_key(COALESCE(NEW.last_dispatched_at, now()), NEW.priority_seconds, NEW.cool_until, NEW.boost_seconds);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION task_dispatches_queue_key IS
  'task_dispatches 的 BEFORE INSERT／UPDATE 觸發器：queue_at 一律照排序鍵重算（任務列 task_queue_key、驗證列 verify_queue_key＝母任務的排序鍵 − 14 天／新增型建立時間 − 14 天／派出後回隊尾，再加 no_change 的延後秒數）。'
  '2026-10-17 起驗證列沒有 1970／1980 年段；2026-10-28 加 defer_seconds';

CREATE OR REPLACE FUNCTION refresh_verify_ticket_keys() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE task_dispatches d
     SET queue_at = verify_queue_key(d.task_id, d.verify_follows_task, d.last_dispatched_at, d.priority_seconds, d.boost_seconds, d.defer_seconds)
   WHERE d.task_id LIKE 'verify:%' AND d.verify_follows_task
     AND d.queue_at IS DISTINCT FROM verify_queue_key(d.task_id, d.verify_follows_task, d.last_dispatched_at, d.priority_seconds, d.boost_seconds, d.defer_seconds);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION refresh_verify_ticket_keys IS '還跟著母任務的驗證票（verify_follows_task）跟著母任務現在的排序鍵換位置（母任務被換秒數、插隊、固定時段拉回）；2026-10-28 起連同自己的延後秒數；回傳換了位置的張數';

-- 現有待審的 no_change 驗證票（網站請求來源除外）一次延後 10 天；觸發器照新鍵重算 queue_at
UPDATE task_dispatches d SET defer_seconds = 864000
 WHERE d.task_id LIKE 'verify:%'
   AND d.defer_seconds = 0
   AND verify_ticket_defer_seconds(d.task_id, false) > 0
   AND EXISTS (SELECT 1 FROM contributions c WHERE c.id = uuid_or_null(substr(d.task_id, 8)) AND c.status = 'pending');

NOTIFY pgrst, 'reload schema';
