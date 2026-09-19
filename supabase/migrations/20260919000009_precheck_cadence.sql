-- precheck 排程加大：每 10 分鐘 200 筆（使用者 2026-09-19：「n 也太小了吧」）。
-- 端點自己的成本上限同步改成 300／10 分鐘；最壞情況每天約 $9，這是防外人狂打的護欄，不是預算。
SELECT cron.unschedule('system-one-precheck-15min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-precheck-15min');
SELECT cron.unschedule('system-one-precheck-10min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-precheck-10min');
SELECT cron.schedule(
  'system-one-precheck-10min',
  '3,13,23,33,43,53 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=precheck&limit=200',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
