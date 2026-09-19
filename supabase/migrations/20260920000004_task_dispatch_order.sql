-- 自動任務也要「派過就排後面」，而且合格判斷要在 LIMIT 之前（2026-09-20，W-Policy 整晚領不到任務）。
--
-- 原本：SQL 先排序（Jev 有答案的優先層在最前）再取 12 筆，程式才排掉「別人認領中／同 IP 交過在等票／在途 ≥5／
-- 24 小時內 skip 過／有人回報 no_change」。優先層 30 筆一旦 ≥12，那一頁永遠全在優先層；忙碌時段 12 筆全被排掉就回 none，
-- 後面 800 多筆從來不會進到頁裡。而且自動任務是現算的虛擬列，沒有「派過了」的記憶（手動任務有 last_dispatched_at）。
--
-- 改法：task_dispatches 記每個自動任務最後一次派出；contribution_auto_tasks 多收 p_ip_hash／p_agent，五種排除搬進 WHERE，
-- 排序＝優先層（只收 0 在途的）→ 最久沒派的 → 隨機。跟 contribution_verify_pool 同一個形狀。

CREATE TABLE IF NOT EXISTS task_dispatches (
  task_id TEXT PRIMARY KEY,
  last_dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatch_count INTEGER NOT NULL DEFAULT 1
);
COMMENT ON TABLE task_dispatches IS '自動任務（auto:…）最後一次派出的時間：派過就排後面，讓 800 多筆輪得到';
ALTER TABLE task_dispatches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "task_dispatches public read" ON task_dispatches;
CREATE POLICY "task_dispatches public read" ON task_dispatches FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION task_dispatched(p_task_id TEXT) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO task_dispatches (task_id, last_dispatched_at, dispatch_count) VALUES (p_task_id, now(), 1)
  ON CONFLICT (task_id) DO UPDATE SET last_dispatched_at = now(), dispatch_count = task_dispatches.dispatch_count + 1
$$;

CREATE INDEX IF NOT EXISTS contributions_task_id_status_idx ON contributions (task_id, status) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contributions_no_change_task_idx ON contributions ((payload->>'task_id')) WHERE contribution_type = 'no_change';

/** 認領表用的目標鍵，跟 TS taskTargetKey 同一套：policy:<id>／politician:<id>／task:<task_id> */
CREATE OR REPLACE FUNCTION task_target_key(p_task_id TEXT, p_target JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_target->>'policy_id' IS NOT NULL THEN 'policy:' || (p_target->>'policy_id')
              WHEN p_target->>'politician_id' IS NOT NULL THEN 'politician:' || (p_target->>'politician_id')
              ELSE 'task:' || p_task_id END
$$;

DROP FUNCTION IF EXISTS contribution_auto_tasks(TEXT, TEXT, INTEGER, TEXT);
CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT * FROM contribution_auto_tasks_raw()
    UNION ALL
    SELECT * FROM contribution_auto_tasks_dup()
  ),
  inflight AS (
    SELECT c.task_id, COUNT(*) AS n FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed') GROUP BY c.task_id
  )
  SELECT t.task_id, t.task_type, t.target, t.what_we_need, t.hint_sources, t.reward
  FROM t
  LEFT JOIN inflight f ON f.task_id = t.task_id
  LEFT JOIN task_dispatches d ON d.task_id = t.task_id
  WHERE (p_type IS NULL OR t.task_type = p_type)
    AND (p_region IS NULL OR t.region = p_region)
    -- 冷卻（有人回報過 no_change 並已落庫）
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id AND tc.checked_at > now() - (task_check_cooldown_days() || ' days')::INTERVAL
    )
    -- 底下在途 ≥5 筆：它缺的是票不是更多提交
    AND COALESCE(f.n, 0) < 5
    -- 有人回報「查了沒東西」還在等票：期間不派
    AND NOT EXISTS (
      SELECT 1 FROM contributions c WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified') AND c.payload->>'task_id' = t.task_id
    )
    -- 以下三種是「對這個代理」的排除，沒帶身份就不做
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = t.task_id OR l.target_key = task_target_key(t.task_id, t.target))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = t.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_skips s WHERE s.task_id = t.task_id AND s.ip_hash = p_ip_hash AND s.skipped_at > now() - INTERVAL '24 hours'
    ))
  ORDER BY
    -- 第一層：Jev 有高信心答案、而且底下還沒有人交的排前面（已有在途提交的，該去的是驗證不是再交一份）
    CASE WHEN system_one_priority_enabled() AND COALESCE(f.n, 0) = 0 AND (
      EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'election' AND j.choice <> 'unknown'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:policy_election_missing:' || j.subject_id)
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.choice = 'same'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:duplicate_politician:' || j.subject_id)
    ) THEN 0 ELSE 1 END,
    -- 第二層：派過就排後面（沒派過的最前）
    COALESCE(d.last_dispatched_at, '1970-01-01'::TIMESTAMPTZ) ASC,
    -- 第三層：同時間派過的隨機，免得所有代理盯同一筆
    md5(t.task_id || COALESCE(p_seed, ''))
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_auto_tasks IS
  '自動任務派工：冷卻／在途飽和／no_change 在途／別人認領中／同 IP 或同代號交過／24h 內 skip 過都在 LIMIT 之前排掉；排序＝Jev 優先層（0 在途）→ 最久沒派 → 隨機';
