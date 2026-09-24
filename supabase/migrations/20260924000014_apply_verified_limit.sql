-- 自動落庫排程每輪 20 筆 → 100 筆（2026-09-24）：中選會名冊逐位核對一次讓 69 筆同時達標，每 10 分鐘 20 筆要排好幾輪
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'apply-verified-10min'),
  command := replace((SELECT command FROM cron.job WHERE jobname = 'apply-verified-10min'), '/functions/v1/apply-verified''', '/functions/v1/apply-verified?limit=100''')
);
