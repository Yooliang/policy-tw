-- 驗證票的排序跟著它所屬的任務；任務有交件在途就停放（2026-10-17，policy-ops docs/work/2026-10-17-派工隊頭堵塞.md「第二步」，小良哥「可以…開工」）
-- ============================================================
--
-- 根源（小良哥）：10-13 把網站請求與插隊改成秒數，只改到任務列，驗證票沒跟著改——驗證票仍是「交件時間 − 優先秒數 − 14 天」，
-- 網站請求交件與 /boost 驗證另留 1970／1980 固定年段（決定檔寫成「照舊」）。照片二選一的任務被插隊推前 5 年排在隊頭，
-- 它的驗證票卻排在 1,300 多筆後面。
--
-- 一條規則：驗證票的排序時間＝它所屬任務的排序時間 − 14 天（queue_settings.verify_priority_seconds）。
--   1. 一般任務做完的交件（補欄位、更正、查無、照片、裁決…）：所屬任務＝原任務（contributions.task_id，欄是空的看 payload.task_id）
--      → 驗證票的排序時間＝原任務現在的排序鍵（task_dispatches.queue_at＝task_queue_key，含優先秒數、冷卻、插隊／網站請求的秒數）− 14 天。
--      原任務的鍵變了（seed 換秒數、/boost、固定時段拉回），還沒被領走的驗證票跟著換（refresh_verify_ticket_keys，seed 與 task_boost 呼叫）。
--   2. 「新增」型交件（交件本身就是一筆新資料；清單只有一處：verify_ticket_is_new）：每一份交件就是一個新任務、建立於現在，
--      驗證票的排序時間＝交件建立時間 − 14 天，不接手母任務的位置（母任務被插隊也不會把這幾張卡在隊頭）。
--      網站請求的補政見交件因此不再排 1970，改成建立時間 − 14 天。
--   3. 拿掉驗證票的 1970／1980 固定年段：verify_front_keep／verify_front_insert／verify_row_is_front／verify_front_tail 與兩個觸發器全刪；
--      /boost 驗證票改成秒數，跟任務一樣每次加 queue_settings.boost_seconds（task_dispatches.boost_seconds，派出就歸零）。
--   4. 任務底下有任何一份交件在途（pending／verified／disputed，經 task_id 欄或 payload.task_id）就停放：還在 task_dispatches（鍵不動），
--      只是 contribution_queue_tasks 不給（新標記「合格：任務停放」）。任一份通過 → 任務結束（既有：手動任務 shouldCloseOnApplied／觸發器
--      contributions_drop_dispatch 立刻收回 auto: 缺口列，task_id 欄就是派工列的 task_id，對應可靠）；全部被退 → 停放條件消失，任務在原本的位置再派。
--      不停放的三型（保留各自既有的規則）：question（一題最多收 3 份答案）、adjudicate（另有「已有裁決在等」）、roster_check（一單位交很多筆，另有「在途未額滿」）。
--   5. 驗證票派出後的其餘規則照舊：派出（被某個驗證者領走）一次，就以派出時間為基準回到隊尾（派出時間 − 入列時記下的優先秒數 − 14 天），插隊秒數歸零，
--      之後不再跟著母任務（task_dispatches.verify_follows_task 由 true 變 false；今天的行為也是派一次就回隊尾）。
--      既有的驗證票（連同派出過的）在這支 migration 裡照新規則重算一次——所以它們的 verify_follows_task 一律是 true，下一次被領走時才回隊尾。
--
-- 只動正見（public）。日本站（policy_jp）的複本函式不跟（走樣守門 policy-jp-dispatch-drift.test.ts 登記「日本站暫不跟」，比對改讀這支之前的版本）。
-- 簽名與回傳型別一字不動（CREATE OR REPLACE），可以單獨先上；舊的 Edge Function（next、boost）不用改。

-- ------------------------------------------------------------
-- 1. 停放用的索引：任務編號只在 payload.task_id 的在途交件（欄是空的），跟 contributions_task_id_status_idx 互補
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS contributions_payload_task_inflight_idx
  ON contributions ((payload->>'task_id'))
  WHERE task_id IS NULL AND status IN ('pending', 'verified', 'disputed');

-- ------------------------------------------------------------
-- 1b. 驗證票「還跟著母任務」的旗標：true＝位置照母任務（或建立時間）算；被領走一次就改 false，之後回隊尾照舊（下面的觸發器）
-- ------------------------------------------------------------
ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS verify_follows_task BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN task_dispatches.verify_follows_task IS '驗證列：true＝排序鍵照新規則（母任務的排序鍵 − 14 天；新增型＝建立時間 − 14 天）；被領走（dispatch_count 變了）一次就變 false，之後是 派出時間 − 優先秒數 − 14 天（回隊尾，照舊）。任務列不看這欄。2026-10-17';

-- ------------------------------------------------------------
-- 2. 驗證票的排序鍵
-- ------------------------------------------------------------
-- 「新增」型交件清單（單一處）：交件本身就是一筆新資料。判斷依據是 apply-contribution.ts 的落庫行為（2026-10-17 逐型別讀過）：
--   新增：policy（INSERT policies，每條政見一列）、question_answer（INSERT question_answers，一題最多收 3 份）、
--         task_suggestion（INSERT contribution_tasks，交件本身就是一個新任務）、
--         candidacy／politician 且母任務是 roster_check（名單清查：缺的人一位一筆，INSERT politicians／politician_elections）
--   不是（照一般任務）：correction、no_change、adjudication、removal、merge_politician、reassign_candidacy、election_results、roster_check（清查回報）、
--         candidacy／politician 的其他母任務（補欄位、補來源、改狀態：UPDATE 既有列）
--   不確定、暫列一般任務（PR 說明列出請小良哥看）：policy_progress（INSERT tracking_logs，但答的是「這條政見有沒有進度」）、policy_elements、
--         district_seats、party_info、regional_stat、lineage／lineage_participants／lineage_handover／lineage_link（INSERT 或 UPDATE 視資料而定，
--         母任務就是要補的那一格）
CREATE OR REPLACE FUNCTION verify_ticket_is_new(p_contribution_type TEXT, p_task_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_contribution_type IN ('policy', 'question_answer', 'task_suggestion')
      OR (p_contribution_type IN ('candidacy', 'politician') AND p_task_type = 'roster_check')
$$;
COMMENT ON FUNCTION verify_ticket_is_new IS '「新增」型交件（交件本身就是一筆新資料，驗證票排序時間＝建立時間 − 14 天，不接手母任務位置）的唯一清單：policy、question_answer、task_suggestion、母任務是 roster_check 的 candidacy／politician。其餘照一般任務（驗證票＝母任務的排序鍵 − 14 天）。2026-10-17';

-- 一張驗證票（task_id＝verify:<貢獻 id>）的母任務與分類
CREATE OR REPLACE FUNCTION verify_ticket_parent(p_verify_task_id TEXT)
RETURNS TABLE (contribution_type TEXT, created_at TIMESTAMPTZ, parent_id TEXT, parent_task_type TEXT, is_new BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT c.contribution_type, c.created_at, c.pid, c.ptype, verify_ticket_is_new(c.contribution_type, c.ptype)
    FROM (SELECT x.contribution_type, x.created_at, x.pid,
                 COALESCE((SELECT p.task_type FROM task_dispatches p WHERE p.task_id = x.pid),
                          CASE WHEN x.pid LIKE 'auto:%' THEN split_part(x.pid, ':', 2) END,
                          (SELECT t.task_type FROM contribution_tasks t WHERE t.id = uuid_or_null(x.pid))) AS ptype
            FROM (SELECT b.contribution_type, b.created_at, COALESCE(b.task_id, b.payload->>'task_id') AS pid
                    FROM contributions b WHERE b.id = uuid_or_null(substr(p_verify_task_id, 8))) x) c
$$;
COMMENT ON FUNCTION verify_ticket_parent IS '驗證票的母任務：contributions.task_id，欄是空的看 payload.task_id；母任務型別先看派工列、再看 auto: 的第二段、再看手動任務。2026-10-17';

-- 驗證票入列時記下的優先秒數（派出後的位置用；派出前不看它）：一般任務沿用母任務的（照舊 verify_inherited_priority_seconds），新增型沒有母任務的位置可沿用＝0
CREATE OR REPLACE FUNCTION verify_ticket_priority_seconds(p_verify_task_id TEXT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN COALESCE((SELECT t.is_new FROM verify_ticket_parent(p_verify_task_id) t), false) THEN 0
              ELSE verify_inherited_priority_seconds(p_verify_task_id) END
$$;
COMMENT ON FUNCTION verify_ticket_priority_seconds IS '驗證票入列時記下的優先秒數：新增型 0，一般任務沿用母任務的（verify_inherited_priority_seconds）。只在派出後的位置用到。2026-10-17';

-- 排序鍵（驗證票所有寫入 queue_at 的路徑都經過這支，由觸發器 task_dispatches_queue_key 呼叫）：
--   領走過一次（verify_follows_task＝false）：派出時間 − 優先秒數 − 14 天（照舊，回隊尾）
--   還沒被領走、新增型：交件建立時間 − 14 天
--   還沒被領走、一般任務：母任務現在的排序鍵 − 14 天；母任務的派工列不在了（已結束）就退回 進隊時間 − 優先秒數 − 14 天（照舊）
--   最後都再減自己的插隊秒數（/boost 每次加 queue_settings.boost_seconds）
CREATE OR REPLACE FUNCTION verify_queue_key(
  p_task_id TEXT, p_follows_task BOOLEAN, p_last_dispatched_at TIMESTAMPTZ, p_priority_seconds INTEGER, p_boost_seconds BIGINT
) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN NOT COALESCE(p_follows_task, true)
             THEN COALESCE(p_last_dispatched_at, now()) - make_interval(secs => COALESCE(p_priority_seconds, 0) + s.vs)
           WHEN t.is_new
             THEN COALESCE(t.created_at, p_last_dispatched_at, now()) - make_interval(secs => s.vs)
           ELSE COALESCE((SELECT p.queue_at FROM task_dispatches p WHERE p.task_id = t.parent_id) - make_interval(secs => s.vs),
                         COALESCE(p_last_dispatched_at, now()) - make_interval(secs => COALESCE(p_priority_seconds, 0) + s.vs))
         END - make_interval(secs => COALESCE(p_boost_seconds, 0))
    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM queue_settings q WHERE q.id = 1), 0) AS vs) s
    LEFT JOIN verify_ticket_parent(p_task_id) t ON true
$$;
COMMENT ON FUNCTION verify_queue_key IS '驗證票的排序鍵（2026-10-17）：一般任務＝母任務的排序鍵 − 14 天、新增型＝建立時間 − 14 天、派出後＝派出時間 − 優先秒數 − 14 天；再減自己的插隊秒數。沒有 1970／1980 年段';

-- queue_at＝排序鍵：所有寫入 task_dispatches 的路徑（seed、/next 的 task_dispatched、手動任務入列、/boost、冷卻）都經過這裡。
-- 任務列同 20261011320000；驗證列改走 verify_queue_key，不再放行 1970／1980 年段。
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
    NEW.queue_at := verify_queue_key(NEW.task_id, NEW.verify_follows_task, NEW.last_dispatched_at, NEW.priority_seconds, NEW.boost_seconds);
  ELSE
    NEW.queue_at := task_queue_key(COALESCE(NEW.last_dispatched_at, now()), NEW.priority_seconds, NEW.cool_until, NEW.boost_seconds);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION task_dispatches_queue_key IS
  'task_dispatches 的 BEFORE INSERT／UPDATE 觸發器：queue_at 一律照排序鍵重算（任務列 task_queue_key、驗證列 verify_queue_key＝母任務的排序鍵 − 14 天／新增型建立時間 − 14 天／派出後 派出時間 − 優先秒數 − 14 天）；派出時插隊秒數歸零。'
  '2026-10-17 起驗證列沒有 1970／1980 年段（verify_front_* 已刪）';

-- 1970／1980 年段（驗證票）整套拿掉：觸發器先、函式後
DROP TRIGGER IF EXISTS trg_task_dispatches_verify_front ON task_dispatches;
DROP TRIGGER IF EXISTS trg_task_dispatches_verify_front_insert ON task_dispatches;
DROP FUNCTION IF EXISTS verify_front_keep();
DROP FUNCTION IF EXISTS verify_front_insert();
DROP FUNCTION IF EXISTS verify_row_is_front(TEXT);
DROP FUNCTION IF EXISTS verify_front_tail();

-- 還跟著母任務的驗證票（沒被領走過、或這支 migration 之前就在的）跟著母任務的鍵換位置（seed 每 10 分鐘、task_boost 插完隊後呼叫）。領走過的位置只看派出時間，不用動
CREATE OR REPLACE FUNCTION refresh_verify_ticket_keys() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE task_dispatches d
     SET queue_at = verify_queue_key(d.task_id, d.verify_follows_task, d.last_dispatched_at, d.priority_seconds, d.boost_seconds)
   WHERE d.task_id LIKE 'verify:%' AND d.verify_follows_task
     AND d.queue_at IS DISTINCT FROM verify_queue_key(d.task_id, d.verify_follows_task, d.last_dispatched_at, d.priority_seconds, d.boost_seconds);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION refresh_verify_ticket_keys IS '還跟著母任務的驗證票（verify_follows_task）跟著母任務現在的排序鍵換位置（母任務被換秒數、插隊、固定時段拉回）；回傳真的換了位置的列數。seed_auto_task_queue、task_boost 呼叫。2026-10-17';

-- 新貢獻的驗證列：位置由觸發器 task_dispatches_queue_key 算，這裡不再自己決定 queue_at（原本呼叫 contribution_queue_at 給 1970）
CREATE OR REPLACE FUNCTION contribution_queue_row() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
    VALUES ('verify:' || NEW.id, now(), now(), 0)
    ON CONFLICT (task_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

-- ------------------------------------------------------------
-- 3. seed：以 20261011350000 的現行定義為底，兩處機械式替換（標 >>> 驗證票跟著任務）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT * FROM contribution_auto_tasks_arms();
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id;

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小；20261011350000 起相符的規則 id 也從這裡記，不再另算層）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority_seconds = p.seconds, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.seconds, x.rule_id
            FROM (SELECT DISTINCT y.arm, election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL activity_priority_seconds(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先秒數

  -- >>> 流量提層：人物頁、政見頁近 window_days 天有真實流量（page_traffic_hot）的，名下缺口標 opened_by.traffic_boost（下一段給秒數）；page_traffic 與狀態都是空的就什麼都不做（參數與規則見 traffic_boost_settings、traffic_boost_apply）
  PERFORM traffic_boost_apply();
  -- <<< 流量提層
  -- >>> 優先秒數：流量提層的缺口（opened_by.traffic_boost）至少給 traffic_boost_settings.boost_seconds
  UPDATE _gaps g SET priority_seconds = GREATEST(COALESCE(g.priority_seconds, 0), s.boost_seconds)
    FROM traffic_boost_settings s
   WHERE s.id = 1 AND s.enabled AND g.opened_by->>'traffic_boost' = 'true';
  -- <<< 優先秒數

  -- >>> gap_events window：臂自己還算得出來這個缺口、只是規則的窗口關了（例：party_roster 過了投票日）→ 收回，原因記 window（交給觸發器寫進 closed 事件）
  PERFORM set_config('gap.close_reason', 'window', true);
  PERFORM set_config('gap.close_detail', '{"via":"seed_window"}', true);
  DELETE FROM task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  -- <<< gap_events window

  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）
  DELETE FROM task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  -- >>> 內容沒變不重寫（#465）：六個內容欄任一欄真的變了才更新；沒變的列不碰（每 10 分鐘約 8,000 列整列重寫的成本，幾乎都是白做）。refreshed_at 的語意因此是「內容最後一次被改寫的時間」
  UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority_seconds, boost_seconds)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds)),
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE 0 END
         -- <<< 優先秒數
    FROM _gaps g
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的驗證列補進來
  -- >>> 驗證票跟著任務（20261017010000）：位置由觸發器 task_dispatches_queue_key 照 verify_queue_key 算，這裡不再呼叫 contribution_queue_at（原本給 1970）
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), now(), 0
  -- <<< 驗證票跟著任務
    FROM contributions c
   WHERE c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM refresh_verify_targets();

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM manual_front_pull();
  -- <<< 固定時段插隊
  -- >>> 優先秒數（20261011320000）：不再重排（驗證：任務＝2:1 取消，維護者 10-13「什麼時候進隊伍就處理」）；
  --     queue_at 由觸發器 task_dispatches_queue_key 照排序鍵算，上面改到優先秒數、冷卻、插隊秒數的列已經跟著換了位置
  -- <<< 優先秒數
  -- >>> 驗證票跟著任務（20261017010000）：上面任務列的鍵可能剛換（秒數、冷卻、固定時段拉回），還跟著母任務的驗證票跟著換
  PERFORM refresh_verify_ticket_keys();
  -- <<< 驗證票跟著任務

  RETURN v_new + v_verify;
END;
$$;
COMMENT ON FUNCTION seed_auto_task_queue IS '排程每 10 分鐘：重算全站缺口，新缺口發號碼牌、內容寫進 task_dispatches（內容沒變的列不重寫）、補上的收回；算每個缺口的優先秒數（與相符的規則 id）；補驗證列、清掉已定案的；不重排（queue_at＝排序鍵，觸發器算）；最後讓還跟著母任務的驗證票換位置（refresh_verify_ticket_keys）。2026-10-17';

-- ------------------------------------------------------------
-- 4. 插隊：驗證票也改成秒數（以 20261011320000 的現行定義為底，只換驗證那一段）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ;
BEGIN
  PERFORM seed_auto_task_queue();
  INSERT INTO task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  TRUNCATE _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM task_boost_matches(p_filter);
  UPDATE contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  -- >>> 驗證票跟著任務（20261017010000）：任務列與驗證票一樣加插隊秒數（queue_settings.boost_seconds，插幾次加幾份，派出就歸零），
  --     queue_at 由觸發器照排序鍵馬上重算；插隊的不受冷卻擋（cooling 只有任務列有）。驗證票原本排到 1980 年段（LEAST(queue_at, v_at)），拿掉
  UPDATE task_dispatches d SET boost_seconds = d.boost_seconds + q.boost_seconds, cooling = false
    FROM _boost_hits h, queue_settings q WHERE q.id = 1 AND h.task_id = d.task_id;
  -- 母任務剛被插隊的，它還跟著它的驗證票跟著走
  PERFORM refresh_verify_ticket_keys();
  -- <<< 驗證票跟著任務
  -- 回傳值的 queue_at：這次插隊命中的列現在最前面的排序鍵（原本是 1980 年段的位置；沒有命中的列就是 NULL）
  SELECT min(d.queue_at) INTO v_at FROM task_dispatches d JOIN _boost_hits h ON h.task_id = d.task_id;
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'queue_at', v_at);
END;
$$;

CREATE OR REPLACE FUNCTION task_boost_remaining(p_id BIGINT)
RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'tasks', count(*) FILTER (WHERE m.kind = 'task' AND (d.queue_at < TIMESTAMPTZ '1990-01-01' OR d.boost_seconds > 0)),  -- 20261011320000：任務列的插隊改成秒數
    'verifies', count(*) FILTER (WHERE m.kind = 'verify' AND d.boost_seconds > 0)  -- 20261017010000：驗證票的插隊也是秒數（派出就歸零）
  )
  FROM task_boosts b
  JOIN LATERAL task_boost_matches(b.filter) m ON true
  LEFT JOIN task_dispatches d ON d.task_id = m.task_id
  WHERE b.id = p_id;
$$;

-- ------------------------------------------------------------
-- 5. 任務停放：contribution_queue_tasks 以 20261017000301 的現行定義為底，在「同機器交過」後面加一段（標記「合格：任務停放」）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_queue_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.queue_at
  FROM task_dispatches d
  WHERE d.task_id NOT LIKE 'verify:%' AND d.task_type IS NOT NULL
    AND NOT d.blocked
    -- 插隊的（queue_at 早於 2000 年）跳過冷卻：人明確要求先做的，冷卻不該擋
    AND (NOT d.cooling OR d.queue_at < '2000-01-01T00:00:00Z')
    AND (p_type IS NULL OR d.task_type = p_type)
    AND (p_region IS NULL OR d.region = p_region)
    -- 下面所有「合格」條件都在 LIMIT 之前：不合格的列不佔窗口（程式裡的過濾器發生在 LIMIT 之後，會讓窗口被不合格的列塞滿、全部剔掉就沒有任務可派）
    -- >>> 合格：認領中
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = d.task_id OR l.target_key = task_target_key(d.task_id, d.target))
    ))
    -- <<< 合格：認領中
    -- >>> 合格：同機器交過
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = d.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
    -- <<< 合格：同機器交過
    -- >>> 合格：任務停放
    -- 底下有任何一份交件還在途（pending／verified／disputed；任務編號看 contributions.task_id，欄是空的看 payload.task_id）的任務就停放：
    -- 派工列還在、排序鍵不動，只是不可派（20261017010000）。任一份通過 → 任務結束（手動任務 shouldCloseOnApplied、auto: 缺口列由觸發器
    -- contributions_drop_dispatch 收回）；全部被退 → 這個條件不成立，任務在原本的位置再派。不分誰來領，所以 p_ip_hash 為 NULL 也排。
    -- 不停放的三型（各有自己的既有規則，下面的標記照舊）：question（一題最多收 3 份答案）、adjudicate（已有裁決在等）、roster_check（一單位會交很多筆、在途額滿 5）
    -- 寫成兩個各自獨立的 NOT EXISTS（欄一個、payload 一個），不用 OR 包起來：OR 會讓規劃器改走逐列的子查詢（正式庫唯讀實測全量版本 5.5 秒），
    -- 分開寫才會變成 anti join、各走各的索引（contributions_task_id_status_idx、contributions_payload_task_inflight_idx）；三型例外放在子查詢裡當外層條件
    AND NOT EXISTS (
      SELECT 1 FROM contributions f
      WHERE d.task_type NOT IN ('question', 'adjudicate', 'roster_check')
        AND f.status IN ('pending', 'verified', 'disputed') AND f.task_id = d.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM contributions f
      WHERE d.task_type NOT IN ('question', 'adjudicate', 'roster_check')
        AND f.status IN ('pending', 'verified', 'disputed') AND f.task_id IS NULL AND f.payload->>'task_id' = d.task_id
    )
    -- <<< 合格：任務停放
    -- >>> 合格：查無回報在等票
    -- 有人回報查無（no_change）還在等票或已通過、還沒落庫的任務，/next 不派給任何人（filterReportedDeadEnds）；不分誰來領，所以 p_ip_hash 為 NULL 也排
    AND NOT EXISTS (
      SELECT 1 FROM contributions n
      WHERE n.contribution_type = 'no_change' AND n.status IN ('pending', 'verified')
        AND n.payload->>'task_id' = d.task_id
    )
    -- <<< 合格：查無回報在等票
    -- >>> 合格：在途未額滿
    -- 這個任務底下在等票（pending／verified／disputed）的貢獻到 5 筆（TASK_INFLIGHT_CAP）就先不再派（filterSaturatedTasks）；LIMIT 5 讓計數最多數到 5 筆
    AND (SELECT count(*) FROM (
      SELECT 1 FROM contributions f
      WHERE f.task_id = d.task_id AND f.status IN ('pending', 'verified', 'disputed') LIMIT 5
    ) inflight) < 5
    -- <<< 合格：在途未額滿
    -- >>> 合格：提問未滿額
    -- 手動任務裡的公民提問（task_type＝question、不是 auto:）：已上線答案（citizen_questions.answer_count）＋還在等票的 question_answer ≥ question_answer_cap() 就不派（fullQuestionIdsOf）
    AND (d.task_type <> 'question' OR d.task_id LIKE 'auto:%' OR uuid_or_null(d.target->>'question_id') IS NULL OR
         COALESCE((SELECT q.answer_count FROM citizen_questions q WHERE q.id = uuid_or_null(d.target->>'question_id')), 0)
         + (SELECT count(*) FROM contributions a
             WHERE a.task_id = d.task_id AND a.contribution_type = 'question_answer' AND a.status IN ('pending', 'verified'))
         < question_answer_cap())
    -- <<< 合格：提問未滿額
    -- >>> 合格：提問這台答過
    -- 這個代號答過這一題（question_answers，含已上線）、或這個代號／IP 交過這個任務的 question_answer（含 applied）就不再派給他（my_answers + filterAnsweredQuestionTasks）
    AND (p_ip_hash IS NULL OR d.task_type <> 'question' OR d.task_id LIKE 'auto:%' OR (
      NOT EXISTS (SELECT 1 FROM question_answers qa
                   WHERE qa.question_id = uuid_or_null(d.target->>'question_id') AND lower(qa.agent_name) = lower(COALESCE(p_agent, '')))
      AND NOT EXISTS (SELECT 1 FROM contributions m
                       WHERE m.task_id = d.task_id AND m.contribution_type = 'question_answer' AND m.status = 'applied'
                         AND (m.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND m.agent_name = p_agent)))
    ))
    -- <<< 合格：提問這台答過
    -- >>> 合格：裁決任務
    -- 裁決任務（task_type＝adjudicate，target.contribution_id＝原貢獻）：這筆爭議已有 pending／verified 的裁決在等票就不再派（不分誰來領）；
    -- 原貢獻是他自己交的、或這台機器（p_ip_hash）對原貢獻投過票的不派給他（filterAdjudicateTasks；過渡期的舊雜湊那一半仍在程式裡）
    AND (d.task_type <> 'adjudicate' OR (
      NOT EXISTS (SELECT 1 FROM contributions j
                   WHERE j.contribution_type = 'adjudication' AND j.status IN ('pending', 'verified')
                     AND j.payload->>'contribution_id' = d.target->>'contribution_id')
      AND (p_ip_hash IS NULL OR (
        (p_agent IS NULL OR lower(d.target->>'contributor') IS DISTINCT FROM lower(p_agent))
        AND NOT EXISTS (SELECT 1 FROM contribution_votes v
                         WHERE v.contribution_id = uuid_or_null(d.target->>'contribution_id') AND v.verifier_ip_hash = p_ip_hash)
      ))
    ))
    -- <<< 合格：裁決任務
  -- 同一個 queue_at 內：公民提問依支持度（target.stance_up，排程寫入）高的先、再依進佇列時間；自動缺口沒有 stance_up，這兩個鍵對它們全是 NULL，順序與 contribution_auto_tasks 一樣
  ORDER BY d.queue_at ASC,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN (d.target->>'stance_up')::NUMERIC END DESC NULLS LAST,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN d.opened_at END ASC NULLS LAST,
           d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_queue_tasks IS
  '/next、queue_preview、contribution_queue_task_counts、queue_head_stale 拿隊頭：task_dispatches 裡所有「任務」列（自動缺口 auto: 與 open 的手動任務 uuid，不含 verify:），照 queue_at 取，跳過 blocked、冷卻中（插隊的除外）、對這台機器不合格的。'
  '所有合格條件都在 LIMIT 之前（20261017000301）：認領中、同機器交過、查無回報在等票、在途額滿（5）、提問滿額／答過、裁決不合格；/next 的過濾器只剩 skip 與舊雜湊投票兩項留在程式裡。'
  '20261017010000：底下有交件在途的任務停放（合格：任務停放；question、adjudicate、roster_check 除外）。'
  'contribution_auto_tasks（/tasks、/request-task 用）仍只回 auto: 列，輸出不變。同 queue_at 內公民提問依 target.stance_up 高的先。2026-10-08、2026-10-17';

-- ------------------------------------------------------------
-- 6. 既有的驗證票一次換算
-- ------------------------------------------------------------
-- /boost 過的驗證列（1971～1999 年段，原本 1980 減 n 分鐘）換成插隊秒數：一次 boost_seconds，越早的（越晚插隊的）多給幾秒保留先後（同任務列 20261011320000 的換法）。
-- 1970 年段（網站請求、公民提問的交件）不是人下的插隊，不換——它們回到各自的位置（見下）
UPDATE task_dispatches d
   SET boost_seconds = q.boost_seconds + GREATEST(0, floor(extract(epoch FROM TIMESTAMPTZ '1980-01-01 00:00:00+00' - d.queue_at)))::BIGINT
  FROM queue_settings q
 WHERE q.id = 1 AND d.task_id LIKE 'verify:%' AND d.queue_at >= TIMESTAMPTZ '1971-01-01' AND d.queue_at < TIMESTAMPTZ '2000-01-01';
-- 新增型：優先秒數歸零（新增型不沿用母任務的位置；被領走之前不看它，領走後的位置才用到）
UPDATE task_dispatches d SET priority_seconds = 0
 WHERE d.task_id LIKE 'verify:%' AND d.priority_seconds <> 0
   AND COALESCE((SELECT t.is_new FROM verify_ticket_parent(d.task_id) t), false);
-- 既有的驗證票（連同領走過的）全部照新規則重算一次：verify_follows_task 的預設值是 true，觸發器 task_dispatches_queue_key 重算 queue_at；
-- 1970／1980 年段的驗證列在這裡回到正常的位置。下一次被領走時才回隊尾（今天的行為）
UPDATE task_dispatches SET queue_at = queue_at WHERE task_id LIKE 'verify:%';

-- ------------------------------------------------------------
-- 7. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id LIKE 'verify:%'
              AND d.queue_at IS DISTINCT FROM verify_queue_key(d.task_id, d.verify_follows_task, d.last_dispatched_at, d.priority_seconds, d.boost_seconds)) THEN
    RAISE EXCEPTION '有驗證票的 queue_at 不是排序鍵';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('trg_task_dispatches_verify_front', 'trg_task_dispatches_verify_front_insert') AND NOT tgisinternal) THEN
    RAISE EXCEPTION '驗證票的 1970／1980 年段觸發器還在';
  END IF;
  IF to_regprocedure('verify_front_keep()') IS NOT NULL OR to_regprocedure('verify_front_tail()') IS NOT NULL THEN
    RAISE EXCEPTION 'verify_front_* 函式還在';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
