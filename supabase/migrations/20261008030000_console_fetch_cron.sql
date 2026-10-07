-- 站務主控台的 GA4／AdSense 抓取，從 GitHub Actions 搬到 Edge Function console-fetch，由 pg_cron 每小時第 17 分叫（2026-10-08）
-- ============================================================
--
-- 為什麼搬：私人 repo policy-console 的 .github/workflows/fetch.yml 每小時第 17 分跑 scripts/fetch.mjs，GitHub 常跳過排程，
-- 站務主控台的「今日」數字就停在上一次有跑的時候。Supabase 的 pg_cron 不會被跳過，函式本身（supabase/functions/console-fetch）
-- 逐項照 fetch.mjs 搬（GA 指標、回填 30 天、批次與併發、429 退避、AdSense、Firestore 文件路徑與欄位、meta/status）。
-- policy-console 的 fetch.yml 先留著當手動備援；這條排程穩定一段時間之後，才由 policy-console 的維護者拿掉它的定時。
--
-- 跟其他排程不一樣的地方：呼叫要帶憑證。
--   現有的 pg_cron → Edge Function 呼叫（cec-sync、moi-sync、news-fetch、source-archive、system-one…）全部不帶任何憑證，
--   閘道不驗 JWT，靠「同一單位 N 小時內抓過就空轉」讓外人重複打也無害（2026-10-07 唯讀查 cron.job：沒有任何一條帶 Authorization 或用 vault）。
--   console-fetch 每次都會打 GA／AdSense／Firestore 並寫入，沒有可以空轉的單位，所以不能公開：函式用 x-cron-secret 標頭
--   （＝環境變數 CONSOLE_FETCH_CRON_SECRET）或 service role bearer 驗呼叫者，兩種都沒設定時一律拒絕（見 _shared/console-fetch-auth.ts）。
--   開源倉庫不能把金鑰寫進 migration，所以 cron 在執行時從 Supabase Vault 讀同一個值帶過去。
--
-- 上線後要做一次（由有權限的人，不在 migration 裡，金鑰值不進版控）：
--   1. 產一個隨機字串（至少 16 字元，例如 openssl rand -hex 32），同一個值放兩處：
--        SELECT vault.create_secret('<值>', 'console_fetch_cron_secret');          -- 資料庫（pg_cron 讀）
--        supabase secrets set CONSOLE_FETCH_CRON_SECRET=<值>                       -- Edge Function（驗證用）
--   2. 另外設好四個 Supabase secrets（與 GitHub 同名）：GCP_SA_KEY、ADSENSE_REFRESH_TOKEN、ADSENSE_CLIENT_ID、ADSENSE_CLIENT_SECRET。
--   在 1 做完之前，這條排程每小時打過去只會收到 401（Vault 裡沒有值時帶空標頭）——失敗是關起來的方向，不會有人能叫它做事；
--   看 net._http_response 可以確認；缺環境變數時函式會回 500 並把失敗寫進 Firestore 的 meta/status（站務主控台「狀態」頁看得到）。
--
-- 逾時：函式一次跑完約 1 分鐘（GitHub 上整個 job 含安裝約 1～1.5 分鐘），Edge Function 回應上限約 150 秒，timeout_milliseconds 對齊。
-- 同一小時叫了兩次也無害：每次都是整份覆寫同一批 Firestore 文件。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認）：擴充 pg_cron、pg_net、supabase_vault 都已安裝；cron.job 沒有名為 console-fetch-hourly 的排程。
-- 這支 migration 比函式早一點點上線沒有風險：函式還沒部署時，net.http_post 只會收到 404。

SELECT cron.unschedule('console-fetch-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'console-fetch-hourly');

SELECT cron.schedule('console-fetch-hourly', '17 * * * *', $$
  SELECT net.http_post(
    url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/console-fetch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'console_fetch_cron_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
$$);