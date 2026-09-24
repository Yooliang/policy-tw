-- 無變動的票數預算重算一次（2026-09-25）
--
-- 發現：no_change 的 payload 沒有 name／title，claimOf 落到預設欄位，Jev 答票數預算時 target 是空的——
-- stamps_without_source／finding_too_thin／source_unrelated 三維全是沒看到內容的空答。
-- 修正在 _shared/system-one.ts（no_change 改送 task_id／outcome／checked_urls／finding），
-- 同一批加第四維 search_not_targeted（查無卻只列首頁、通用公告）。
--
-- 這裡讓還在等票的 no_change 再被撿一次：之前那筆的 target 沒有 outcome 就當沒算過。
-- 防無限重問：同一筆最多兩筆 vote_budget（函式若還沒部署，重問一次仍是空答，之後就不再撿）。
-- 約 630 筆 × 0.0001～0.0002 美元，排程每 10 分鐘 20 筆，約 5 小時掃完。

CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion')
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
