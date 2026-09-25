-- 中選會名單每週同步＋比對開任務（2026-09-26）
-- cec-sync 一次呼叫跑一屆×一種選舉別；同一單位 24 小時內同步過會空轉。每週日台灣時間凌晨 3 點 2022、3 點半 2024，
-- 每屆 9 種選舉別並行（每支函式內部請求間隔 ≥0.5 秒）；4 點半把新發現開成任務（cec_reconcile_open_tasks）。
-- 2026 等投票（11/28）之後再加進來。

SELECT cron.unschedule(j) FROM unnest(ARRAY['cec-sync-2022-weekly', 'cec-sync-2024-weekly', 'cec-reconcile-weekly']) j
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = j);

SELECT cron.schedule('cec-sync-2022-weekly', '0 19 * * 6', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-sync',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := jsonb_build_object('election_id', 2022, 'election_type', t), timeout_milliseconds := 150000)
    FROM unnest(ARRAY['縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']) AS t;
$$);
SELECT cron.schedule('cec-sync-2024-weekly', '30 19 * * 6', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-sync',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := jsonb_build_object('election_id', 2024, 'election_type', t), timeout_milliseconds := 150000)
    FROM unnest(ARRAY['總統副總統', '立法委員']) AS t;
$$);
SELECT cron.schedule('cec-reconcile-weekly', '30 20 * * 6', $$SELECT cec_reconcile_open_tasks();$$);
