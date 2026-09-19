-- precheck 每輪 200 → 60：limit=100 手動打就撞 WORKER_RESOURCE_LIMIT（每筆最多三個來源＋PDF 抽字）。
-- 端點自己也降到 2 筆並行、40 秒預算；一輪做不完下一輪接，候選查詢冪等。
SELECT cron.unschedule('system-one-precheck-10min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-precheck-10min');
SELECT cron.schedule(
  'system-one-precheck-10min',
  '3,13,23,33,43,53 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=precheck&limit=60',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
