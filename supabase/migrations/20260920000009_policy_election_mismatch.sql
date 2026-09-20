-- 政見的屆別標錯（使用者 2026-09-20）：提出日期晚於所屬選舉的投票日，資料自己打架——
-- 蔡培慧「南投醫療升準醫學中心」來源是 2026 年報導、標成 2024，卡片顯示「2026 承諾／未當選」。實查 17 筆（2024 的 11、2022 的 6）。
-- policy_election_missing 補「空的」，這一條修「錯的」：同一套 correction 流程，Jev 對 election 那題有判定的排前面。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  SELECT 'auto:policy_election_mismatch:' || pl.id, 'policy_election_mismatch',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'election_id', pl.election_id, 'election_date', e.election_date, 'source_url', pl.source_url),
         '政見「' || pl.title || '」（' || p.name || '）標的是 ' || pl.election_id || ' 那一屆，但提出日期 ' || pl.proposed_date::TEXT || ' 晚於那場選舉的投票日 ' || e.election_date::TEXT || '，兩者對不上。'
           || '請打開來源確認：這是哪一場選舉的承諾（或哪個任期內的施政）？'
           || '屆別標錯 → 用 correction 把 policies.election_id 改成正確年份；提出日期填錯 → 用 correction 改 policies.proposed_date（來源有寫日期才改，沒有就清空）。'
           || '判斷依據是來源本身；分不出來就用 no_change 回報你查了什麼。',
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁'], 1, p.region
  FROM policies pl
  JOIN politicians p ON p.id = pl.politician_id
  JOIN elections e ON e.id = pl.election_id
  WHERE pl.removed_at IS NULL
    AND pl.proposed_date IS NOT NULL
    AND pl.proposed_date > e.election_date
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_mismatch IS '提出日期晚於所屬選舉投票日的政見 → policy_election_mismatch 任務（correction 改屆別或日期）';

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
    UNION ALL
    SELECT * FROM contribution_auto_tasks_legacy()
    UNION ALL
    SELECT * FROM contribution_auto_tasks_mismatch()
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
  ORDER BY
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
  '自動任務派工（含同名配對、早期匯入核對、屆別矛盾）：合格判斷都在 LIMIT 之前；排序＝（沒派過且系統有判定）一次性插隊 → 最久沒派 → task_id';
