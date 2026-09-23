-- 兩件（小良哥 2026-09-23）：
-- 1. Jev 讀投票備註找範圍外的問題（question='followup'，subject_type='vote'），判「有」就開任務。
--    驗證者寫在 note 裡的「欄位外的問題，留給之後處理」沒有任何下游會接（7 天約 65 張），陳泓維的政黨就是這樣掉在地上。
-- 2. 「十分鐘內有提交的都稽查」：票數預算原本每 10 分鐘 20 筆，三天內單一十分鐘最多進 36 筆，會落後。改 60（RPC 上限）。
--    系統來源票（precheck）本來就是 60。

-- 與 _shared/system-one.ts 的 QUESTIONS 同一份清單，漏改一邊會「測試全綠、線上寫不進去」
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract', 'vote_budget', 'followup'));

SELECT cron.unschedule('system-one-vote-budget-10min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-vote-budget-10min');
SELECT cron.schedule(
  'system-one-vote-budget-10min',
  '8,18,28,38,48,58 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=vote_budget_sweep&limit=60',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);

-- 每 10 分鐘看最近 1 小時的票（重疊是故意的：判過的會跳過，漏掉一輪下一輪補得到）
SELECT cron.unschedule('system-one-followups-10min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-followups-10min');
SELECT cron.schedule(
  'system-one-followups-10min',
  '5,15,25,35,45,55 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=followups&since_hours=1&limit=60',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
