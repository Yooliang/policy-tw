-- `candidate_status = 'not_running'` 是全站影響面最大的一個永久排除（2026-09-21，子代理掃出來、使用者裁示要修）。
--
-- 一筆「他沒登記」讓這個人的四種缺口同時消失：policy_missing、profile_gap、
-- candidacy_source_missing、election_result_missing 全都從 c2026 那個 CTE 濾掉 not_running，
-- candidate_status_stale 只挑 rumored／likely，election_result_missing 明文排除它。
-- 沒有任何任務會回頭看，也沒有冷卻、沒有重查週期。
--
-- 實查 2026 的資料才發現風險跟原本想的不一樣：
--   - not_running 有 102 筆（registered 280、rumored 35、confirmed 6）
--   - 但 edit_history 裡 candidate_status 的修改總共只有 4 筆
--   → 絕大多數不是代理判的，是匯入就那樣，從來沒有人核對過。
--   - 102 筆裡 90 筆有 source_note，內容卻是「AI搜尋匯入: 曾任立法委員，可能再次挑戰」
--     這種——寫著「可能再次挑戰」卻標成「不參選」。source_note 是匯入來歷，不是查核證據。
--   - verified 欄位全站 2026 這一屆沒有任何一列是 true，等於沒在用。
--
-- 所以重查的觸發點不是「過了多久」，而是「**登記截止了，官方名單現在查得到，而這一列從來沒有人對過名單**」。
-- 2026 的登記在 9/4 截止（roster_check_scope.registration_closed_on），名單已經存在。
--
-- 用 verified 當「對過名單」的標記：
--   - 任務條件：not_running、登記已截止、verified 不是 true
--   - 代理查名單後：在名單上 → correction 改成 registered（既有流程）；
--     確實不在名單上 → no_change 且 outcome=confirmed → 這時才把 verified 設成 true
--   - 只有 confirmed 會蓋這個章，而且走 recordUpdate 留履歷、可還原（照 2026-09-21 定下的規矩）

CREATE OR REPLACE FUNCTION contribution_auto_tasks_not_running()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  SELECT 'auto:not_running_recheck:' || pe.id, 'not_running_recheck',
         jsonb_build_object('politician_election_id', pe.id, 'politician_id', p.id, 'name', p.name,
                            'election_id', pe.election_id, 'election_type', pe.election_type,
                            'region', COALESCE(r.region, p.region), 'source_note', pe.source_note,
                            'registration_closed_on', s.registration_closed_on),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '被標成「不參選」，但沒有任何人對過官方登記名單——這一列多半是早期匯入時就這樣寫的。'
           || '**這個標記的代價很大**：標成不參選之後，這個人的政見、基本資料、參選來源、選舉結果四種缺口都不會再被派給任何人，所以它值得被核對一次。'
           || '登記已經在 ' || s.registration_closed_on::TEXT || ' 截止，名單現在查得到。請打開該縣市選舉委員會的登記公告（或媒體整理的完整登記名單）核對：'
           || '**他在名單上** → 用 correction 把 politician_elections.candidate_status 改成 registered，附那份名單；'
           || '**確實不在名單上** → 用 no_change 回報、outcome 填 confirmed，checked_urls 放你核對的那份名單（這時系統才會把這一列標成已核對，不再重派）；'
           || '**找不到該縣市的名單** → no_change 但 outcome 填 unreachable 或 not_found，那不會把它標成已核對，過幾天換人再試。'
           || 'target.source_note 是這一列的匯入來歷，僅供參考——實測很多寫著「可能再次挑戰」卻被標成不參選，不要拿它當證據。',
         ARRAY['該縣市選舉委員會官網的登記公告', 'cna.com.tw 登記參選名單', 'ltn.com.tw', 'udn.com'],
         2, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
  LEFT JOIN regions r ON r.id = pe.region_id
  JOIN roster_check_scope s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
  JOIN elections e ON e.id = pe.election_id
  WHERE pe.candidate_status = 'not_running'
    AND s.registration_closed_on <= CURRENT_DATE
    -- 投票日過了就不必再問「他有沒有登記」，那時該問的是結果
    AND (e.election_date IS NULL OR e.election_date >= CURRENT_DATE)
    AND pe.verified IS NOT TRUE
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_not_running IS
  '被標成不參選、但沒人對過官方登記名單的參選紀錄 → not_running_recheck 任務；no_change 且 outcome=confirmed 才把 verified 設 true';

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
    UNION ALL
    SELECT * FROM contribution_auto_tasks_policy_dup()
    UNION ALL
    SELECT * FROM contribution_auto_tasks_not_running()
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
    CASE WHEN d.task_id IS NULL AND system_one_priority_enabled() AND (
      EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'election' AND j.choice <> 'unknown'
          AND j.probability >= system_one_min_probability()
          AND t.task_id IN ('auto:policy_election_missing:' || j.subject_id, 'auto:policy_election_mismatch:' || j.subject_id))
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.choice = 'same'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:duplicate_politician:' || j.subject_id)
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'source_support' AND j.choice IN ('supported', 'not_supported')
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:legacy_audit:' || j.subject_id)
    ) THEN 0 ELSE 1 END,
    d.last_dispatched_at ASC NULLS FIRST,
    t.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_auto_tasks IS
  '自動任務派工（含同名配對、早期匯入核對、屆別矛盾、政見重複清查、不參選重查）：合格判斷都在 LIMIT 之前；冷卻依 task_checks.outcome 分長短';
