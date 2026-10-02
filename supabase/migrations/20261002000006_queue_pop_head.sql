-- 佇列照原設計：排程排好快照、/next 只拿隊頭；插隊的跳過冷卻（2026-10-02 維護者裁示）
--
-- 設計（維護者）：每 10 分鐘算缺口、排成一份快照；有人來領就拿最前面那筆、把它的時間改成現在（排到隊尾）；
-- 沒做完就一直留在列表裡，做完就從列表消失，10 分鐘後補上新算的。插隊只是把快照裡特定幾筆的時間改到最前面。
--
-- 實際上 /next 呼叫的 contribution_auto_tasks 每次都對整份快照（2,459 筆）逐筆查冷卻、在途數、查無在等票，
-- 再排序取前幾筆。實測每筆約 7 毫秒，整份約 17 秒，超過時間上限回 500。#309 先加窗口止住（4.6~5.2 秒），
-- 這一支照原設計把篩選搬回排程，/next 只剩「照時間取隊頭，跳過對這台機器不合格的」。
--
-- ① 冷卻天數**不動**（14／2 天，協議 skill.md 也這樣告訴代理；protocol-guard 測試會擋 SQL 與 TS 不一致）。
--    改的是：**插隊的任務（queue_at 早於 2000 年，跟 dispatch.ts 的 isFrontQueueAt 同一條線）跳過冷卻**。
--    插隊是人明確要求先做，冷卻擋住它等於插隊無效 —— 今天插隊的 407 筆缺照片就是被冷卻擋住，三個多小時只領走 3 筆。
-- ② task_dispatches 加兩個欄位，排程每 10 分鐘用集合運算一次算好：
--    cooling＝在冷卻中（task_checks 14 天／打不開 2 天）；blocked＝正在被處理（在途貢獻 ≥5 筆、或有人回報查無還在等票）。
--    最多 10 分鐘的落差：派出後 task_dispatched 會把它排到隊尾，不會在隊頭被反覆領；
--    /next 程式裡原本的過濾器（filterSaturatedTasks／filterReportedDeadEnds）也還在當保險，只對回來的那幾筆做。
-- ③ contribution_auto_tasks 改寫：照 queue_at 走索引、看兩個欄位、只對走到的那幾筆查「別人認領中／這台機器交過」，
--    到 p_limit 就停。插隊判定看 queue_at（即時），所以剛插隊的不必等下一輪排程就能跳過冷卻。
--    拿掉恆為 1 的 jev 排序段（d.task_id IS NULL 在 INNER JOIN 下恆假）。同簽名、同回傳欄位。
--    request-task（p_limit=100000、不帶 p_ip_hash）沒有逐筆子查詢了，一樣快、結果不變。

-- ② blocked ---------------------------------------------------------------------------------------
ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS cooling BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN task_dispatches.cooling IS
  '在冷卻中（task_checks：查過無異動 14 天、打不開 2 天）。插隊的（queue_at 早於 2000 年）不看這個欄位。排程每 10 分鐘算。';
COMMENT ON COLUMN task_dispatches.blocked IS
  '正在被處理、先不要派：在途貢獻 ≥5 筆，或有人回報查無還在等票。排程每 10 分鐘由 refresh_dispatch_blocked() 一次算好。';

CREATE OR REPLACE FUNCTION refresh_dispatch_blocked() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  WITH saturated AS (
    SELECT c.task_id FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed')
    GROUP BY c.task_id HAVING COUNT(*) >= 5
  ), nochange AS (
    SELECT DISTINCT c.payload->>'task_id' AS task_id FROM contributions c
    WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified')
      AND c.payload->>'task_id' IS NOT NULL
  ), b AS (
    SELECT task_id FROM saturated UNION SELECT task_id FROM nochange
  )
  , cool AS (
    SELECT DISTINCT tc.task_id FROM task_checks tc
    WHERE tc.checked_at > now() - (
      CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days'
    )::INTERVAL
  )
  UPDATE task_dispatches d
     SET blocked = EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id),
         cooling = EXISTS (SELECT 1 FROM cool c WHERE c.task_id = d.task_id)
   WHERE d.task_id LIKE 'auto:%'
     AND (d.blocked IS DISTINCT FROM EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id)
       OR d.cooling IS DISTINCT FROM EXISTS (SELECT 1 FROM cool c WHERE c.task_id = d.task_id));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION refresh_dispatch_blocked IS
  '重算 task_dispatches.blocked 與 cooling（集合運算，一次掃完）。seed_auto_task_queue 每 10 分鐘呼叫。';

-- 排程裡加一行（其餘照抄 20260924000005）
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM contribution_auto_tasks_arms() g ORDER BY g.task_id;

  -- 已經不存在的缺口（補上了）：收回號碼牌
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'auto:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id;

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now()
    FROM _gaps g
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的驗證列補進來
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), contribution_queue_at(c.contribution_type, c.task_id, c.created_at), 0
    FROM contributions c
   WHERE c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 每 10 分鐘重排成 驗證：任務＝2:1（維護者 09-24：不要手動調）
  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM refresh_dispatch_blocked();

  PERFORM rebalance_queue();

  RETURN v_new + v_verify;
END;
$$;

-- ③ /next 拿隊頭 -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks(
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
  WHERE d.task_id LIKE 'auto:%' AND d.task_type IS NOT NULL
    AND NOT d.blocked
    -- 插隊的（queue_at 早於 2000 年）跳過冷卻：人明確要求先做的，冷卻不該擋
    AND (NOT d.cooling OR d.queue_at < '2000-01-01T00:00:00Z')
    AND (p_type IS NULL OR d.task_type = p_type)
    AND (p_region IS NULL OR d.region = p_region)
    -- 下面兩項跟「是誰來領」有關，排程算不了；只對照時間走到的那幾筆查，到 p_limit 就停
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = d.task_id OR l.target_key = task_target_key(d.task_id, d.target))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = d.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_auto_tasks IS
  '/next 拿隊頭：照 queue_at 取，跳過 blocked、冷卻中（插隊的除外）、對這台機器不合格的。篩選在排程（refresh_dispatch_blocked）做。2026-10-02。';

-- 套上就先算一次，不用等下一輪排程
SELECT refresh_dispatch_blocked();
