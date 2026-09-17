-- cec-verify 掛上排程：每 10 分鐘掃一次待驗證的 candidacy／politician，
-- 對得上中選會就直接上線、對不上就退件、查不到就留給同儕。
--
-- 2026-09-17 量到的缺口：924 筆待驗證合計還差 2,592 票才清得完，其中 candidacy 一種
-- 就佔 1,542 票（59%、平均每筆差 3.9 票）。這些是中選會查得到的事實，不該等人投票。
--
-- 走 pg_net 打自己的 Edge Function（cec-verify 的 verify_jwt = false，不需要金鑰；
-- 內部呼叫也不必經過公網以外的設定）。limit=20 是一輪最多處理幾筆：每筆會打 1～2 次
-- 中選會，10 分鐘一輪、一輪 20 筆對對方是很輕的流量，也不會讓函式跑超過執行時間上限。

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule(
  'cec-verify-10min',
  '*/10 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-verify?limit=20',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
