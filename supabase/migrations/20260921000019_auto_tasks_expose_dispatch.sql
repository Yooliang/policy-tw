-- 自動缺口也回報 last_dispatched_at（使用者 2026-09-21）。
--
-- 「手動任務那個一開始就做錯了。當一個手動任務被建立的時候，它應該被排在最前面，
--   而不是整個手動任務的列表都卡在最前面。任務一建立它就是最快會被進行的，
--   之後就照著流程走。」
--
-- 現況是 /next 裡 `if (freeManual.length > 0)` ——整份手動清單無條件壓在自動缺口前面。
-- 裁決任務就是手動的、現在 86 筆，所以任何自動缺口的優先序都輪不到。
--
-- 但反過來把手動排到自動後面也不行：自動缺口有一千多筆、永遠用不完，
-- 那 86 筆裁決會變成永遠派不出去——那條線今天早上才剛救活。
--
-- 正解是兩邊進同一個佇列、按「最久沒派」排（沒派過的算最久）。
-- contribution_tasks 本來就有 last_dispatched_at，這裡讓自動缺口也回報它，兩邊才比得了。
-- 加一欄對既有呼叫端是相容的（/tasks 忽略它）。

DROP FUNCTION IF EXISTS contribution_auto_tasks(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, last_dispatched_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH t AS (SELECT * FROM contribution_auto_tasks_arms()),
  inflight AS (
    SELECT c.task_id, COUNT(*) AS n FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed') GROUP BY c.task_id
  )
  SELECT t.task_id, t.task_type, t.target, t.what_we_need, t.hint_sources, t.reward, d.last_dispatched_at
  FROM t
  LEFT JOIN inflight f ON f.task_id = t.task_id
  LEFT JOIN task_dispatches d ON d.task_id = t.task_id
  WHERE (p_type IS NULL OR t.task_type = p_type)
    AND (p_region IS NULL OR t.region = p_region)
    -- 冷卻（有人回報過 no_change 並已落庫）：拿不到來源的那種只壓短時間，換一台機器可能就開得了
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id
        AND tc.checked_at > now() - (
          CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days'
        )::INTERVAL
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
  ORDER BY
    -- 2026 縣市長的基本資料最前、政見次之（使用者 2026-09-21：網站進來最大的賣點）
    task_priority_tier(t.task_type, t.target),
    -- 一次性插隊：Jev 有高信心答案、而且還沒派過的，排最前（派過一次就跟大家一樣按最久沒派排）
    CASE WHEN d.task_id IS NULL AND system_one_priority_enabled() AND (
      EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'election' AND j.choice <> 'unknown'
          AND j.probability >= system_one_min_probability()
          AND t.task_id IN ('auto:policy_election_missing:' || j.subject_id, 'auto:policy_election_mismatch:' || j.subject_id))
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.choice = 'same'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:duplicate_politician:' || j.subject_id)
      -- 早期匯入的政見：系統核過來源（支持或矛盾都算，矛盾更該先看）的排前面
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'source_support' AND j.choice IN ('supported', 'not_supported')
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:legacy_audit:' || j.subject_id)
    ) THEN 0 ELSE 1 END,
    -- 最久沒派的優先；沒派過的算最久。這就是全序，不需要隨機（同時派給多人由 SQL 裡的認領排除擋）
    d.last_dispatched_at ASC NULLS FIRST,
    t.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_auto_tasks IS
  '自動任務派工：回報 last_dispatched_at 讓呼叫端能跟手動任務放進同一個佇列比較。排序＝2026 縣市長（基本資料→政見）→一次性插隊→最久沒派→task_id。';
