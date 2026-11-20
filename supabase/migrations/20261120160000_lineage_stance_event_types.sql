-- 脈絡「一件事的全貌」第二期 2a（policy-tw#675）：開放兩種新交件型別 lineage_stance（立場）、lineage_event（事件）。
--
-- 這支只做「收得進來」：
--   1. contributions.contribution_type 的 CHECK 加兩個值（以 20261105200000 的現行清單為底，只多兩個；漏這個 CHECK 的話代理交件全被擋而測試全綠）
--   2. 票數預算影子排程的候選型別清單同步加兩個值（TS 的 VOTE_DIMENSIONS 已有，以 20261105200000 的定義為底，只多兩個）
-- 落庫寫的是一期（20261120120000）建好的 lineage_stances／lineage_events；表、觸發器（含承諾防線）一個字不動。
-- 這支**不動** activity_rules、不新增派工臂：兩種任務型別（lineage_stance_missing／lineage_event_missing）要等 2b 的臂與起跑日才會派，
-- 所以上線後派工列沒有任何新任務；既有三支臂（lineage_candidates／lineage_links／lineage_roles）開著不動。
--
-- 回滾：把 CHECK 與 system_one_vote_budget_candidates 用 20261105200000 的版本蓋回即可（沒有任何這兩型別的交件時無損；
-- 已有交件的話先把它們 status 改 rejected 或留著不動，CHECK 蓋回前要先處理，否則 ADD CONSTRAINT 會因現有列不合而失敗）。

ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'election_results', 'reassign_candidacy', 'regional_stat', 'cand_numbers', 'policy_subtopics', 'lineage_status', 'lineage_stance', 'lineage_event'));

CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link',
                                'party_info', 'election_results', 'reassign_candidacy', 'regional_stat', 'cand_numbers', 'policy_subtopics', 'lineage_status',
                                'lineage_stance', 'lineage_event')
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget'
        AND (c.contribution_type <> 'no_change' OR j.state->'target' ? 'outcome')
    )
    AND (c.contribution_type <> 'no_change' OR (
      SELECT COUNT(*) FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget') < 2)
  -- 新的先：新件的影子結果之後才對得到它的實際結果；舊件一天內也會輪到
  ORDER BY c.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 60));
$$;

-- 自我檢查：兩個型別都收得進
DO $$
BEGIN
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'contributions_contribution_type_check' AND conrelid = 'contributions'::regclass)) NOT LIKE '%lineage_stance%'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'contributions_contribution_type_check' AND conrelid = 'contributions'::regclass)) NOT LIKE '%lineage_event%' THEN
    RAISE EXCEPTION '貢獻型別 CHECK 漏了 lineage_stance／lineage_event';
  END IF;
END $$;
