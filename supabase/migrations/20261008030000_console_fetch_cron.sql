-- 站務主控台的 GA4／AdSense 抓取，從 GitHub Actions 搬到 Edge Function console-fetch，由 pg_cron 每小時第 17 分叫（2026-10-08）
-- ============================================================
--
-- 為什麼搬：私人 repo policy-console 的 .github/workflows/fetch.yml 每小時第 17 分跑 scripts/fetch.mjs，GitHub 常跳過排程，
-- 站務主控台的「今日」數字就停在上一次有跑的時候。Supabase 的 pg_cron 不會被跳過，函式本身（supabase/functions/console-fetch）
-- 逐項照 fetch.mjs 搬（GA 指標、回填 30 天、批次與併發、429 退避、AdSense、Firestore 文件路徑與欄位、meta/status）。
-- policy-console 的 fetch.yml 先留著當手動備援；這條排程穩定一段時間之後，才由 policy-console 的維護者拿掉它的定時。
--
-- 跟其他排程不一樣的地方：呼叫要帶憑證，而且憑證只存在資料庫裡，不需要人去放。
--   現有的 pg_cron → Edge Function 呼叫（cec-sync、moi-sync、news-fetch、source-archive、system-one…）全部不帶任何憑證，
--   閘道不驗 JWT，靠「同一單位 N 小時內抓過就空轉」讓外人重複打也無害（2026-10-07 唯讀查 cron.job：沒有任何一條帶 Authorization 或用 vault）。
--   console-fetch 每次都會打 GA／AdSense／Firestore 並寫入，沒有可以空轉的單位，所以不能公開：
--     1. 這支 migration 在 Vault 裡沒有 console_fetch_cron_secret 時自己產一個隨機值放進去（已經有就不動，重跑安全；值不在版控、不在任何人手上）；
--     2. cron 執行時從 Vault 讀出來放在 x-cron-secret 標頭；
--     3. 函式端不持有這個值：用 Edge runtime 自帶的 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY 呼叫 RPC console_fetch_cron_secret_ok，
--        請資料庫拿標頭的值跟 Vault 比對（SECURITY DEFINER，只授權 service_role；anon、authenticated、PUBLIC 都不能執行）。
--   維護者手動呼叫仍可用 service role bearer（見 _shared/console-fetch-auth.ts）。要換密鑰：更新 Vault 那一筆（vault.update_secret）即可，函式端不用動。
--
-- 上線後要做的只剩資料來源的四個 Supabase secrets（與 GitHub 同名）：GCP_SA_KEY、ADSENSE_REFRESH_TOKEN、ADSENSE_CLIENT_ID、ADSENSE_CLIENT_SECRET。
-- 缺的時候函式回 500 並把失敗寫進 Firestore 的 meta/status（站務主控台「狀態」頁看得到）。
--
-- 逾時：函式一次跑完約 1 分鐘（GitHub 上整個 job 含安裝約 1～1.5 分鐘，估計值），Edge Function 回應上限約 150 秒，timeout_milliseconds 對齊。
-- 同一小時叫了兩次也無害：每次都是整份覆寫同一批 Firestore 文件。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認）：擴充 pg_cron、pg_net、supabase_vault（schema vault）、pgcrypto（schema extensions，
-- gen_random_bytes 與 digest 在這裡）都已安裝；vault.create_secret(new_secret, new_name, new_description, new_key_id)、view vault.decrypted_secrets 存在；
-- cron.job 沒有名為 console-fetch-hourly 的排程；沒有叫 console_fetch_cron_secret_ok 的函式。
-- 這支 migration 比函式早一點點上線沒有風險：函式還沒部署時，net.http_post 只會收到 404。

-- ── 1. 密鑰：沒有才產（64 字元十六進位，32 位元組隨機） ───────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'console_fetch_cron_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'console_fetch_cron_secret',
      'console-fetch 的 pg_cron 呼叫憑證（migration 自動產生；函式端用 console_fetch_cron_secret_ok 驗，不持有這個值）'
    );
  END IF;
END
$$;

-- ── 2. 驗證用 RPC：Edge Function 以 service_role 呼叫 ───────────────────
-- 比對兩邊的 SHA-256 摘要而不是原字串，不讓「前幾個字元對了比較慢」洩漏資訊；太短的輸入一律不通過。
-- search_path 清空、全部寫全名：SECURITY DEFINER 函式不吃呼叫者的 search_path。
CREATE OR REPLACE FUNCTION public.console_fetch_cron_secret_ok(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_secret IS NOT NULL
     AND length(p_secret) >= 16
     AND EXISTS (
       SELECT 1
         FROM vault.decrypted_secrets s
        WHERE s.name = 'console_fetch_cron_secret'
          AND extensions.digest(s.decrypted_secret, 'sha256') = extensions.digest(p_secret, 'sha256')
     );
$$;

-- Supabase 預設會把 public 新函式的 EXECUTE 明確授給 anon、authenticated、service_role，所以要逐一收回，只留 service_role
REVOKE ALL ON FUNCTION public.console_fetch_cron_secret_ok(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.console_fetch_cron_secret_ok(text) FROM anon;
REVOKE ALL ON FUNCTION public.console_fetch_cron_secret_ok(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.console_fetch_cron_secret_ok(text) TO service_role;

COMMENT ON FUNCTION public.console_fetch_cron_secret_ok(text) IS
  'console-fetch 驗 x-cron-secret 用（2026-10-08）：拿輸入值跟 Vault 的 console_fetch_cron_secret 比對，只授權 service_role；密鑰由 migration 產生、不離開資料庫';

-- ── 3. 排程 ───────────────────────────────────────────────
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

NOTIFY pgrst, 'reload schema';