-- 票數預算的影子模式排進排程（小良哥 2026-09-23）
--
-- 09-21 上線的 system-one?action=vote_budget 只能手動一筆一筆打，資料庫裡只有 2 筆測試紀錄，
-- 「先看真實分布再決定要不要接上」一直沒有分布可看。這裡每 10 分鐘撿 20 筆 pending 且還沒算過的貢獻各問一次，
-- 只記錄不套用（現行門檻仍由 contribution_effective_agree 決定）。全站約 1,400 筆等票，一天內掃完，之後跟得上新件。
-- 每筆約 0.0001～0.0002 美元。

-- 候選：pending、型別有定義風險維度（_shared/vote-budget.ts 的 VOTE_DIMENSIONS）、還沒算過票數預算
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
    )
  -- 新的先：新件的影子結果之後才對得到它的實際結果；舊件一天內也會輪到
  ORDER BY c.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 60));
$$;
COMMENT ON FUNCTION system_one_vote_budget_candidates IS
  '票數預算影子模式的候選：pending、有風險維度、還沒算過。給 system-one?action=vote_budget_sweep 用。';

SELECT cron.unschedule('system-one-vote-budget-10min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-vote-budget-10min');
SELECT cron.schedule(
  'system-one-vote-budget-10min',
  '8,18,28,38,48,58 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=vote_budget_sweep&limit=20',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
