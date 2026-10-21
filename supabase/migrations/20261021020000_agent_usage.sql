-- 官方代理的本週用量公開（維護者 10-21：「透明」；policy-tw #725 第二段）
-- ============================================================
--
-- 來源：Aegis 三個 Claude 訂閱帳號的週額度。aegis-tokyo 上的 root cron 每 10 分鐘把它寫進 VM 訪客屬性
-- aegis-quota/<帳號>＝"<已用%>|<重置 ISO UTC>"；能讀這組屬性的只有 policy-console 的 Edge Function console-vm
-- （服務帳號 console-vm@greenshepherdcomtw，自訂角色 consoleVmQuotaRead）。正見後端的 GCP_SA_KEY 沒有這個權限，不改 IAM，
-- 所以由 console-vm 新增唯讀 action snapshot_quota 把額度整理後寫進這張表（console-vm 與正見在同一個 Supabase 專案）。
--
-- 這張表不存 email 與帳號名：帳號只用「帳號 A／B／C」標示（console-vm 端固定排序對照）。
-- 呼叫憑證照 console-fetch：Vault 的 agent_usage_cron_secret（沒有才產）、pg_cron 放在 x-cron-secret 標頭、
-- console-vm 用 service_role 呼叫 RPC agent_usage_cron_secret_ok 請資料庫比對（不持有密鑰值）。

CREATE TABLE IF NOT EXISTS agent_usage (
  provider       TEXT NOT NULL,
  account_label  TEXT NOT NULL,
  pct            NUMERIC NOT NULL CHECK (pct >= 0),
  resets_at      TIMESTAMPTZ,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, account_label)
);
COMMENT ON TABLE agent_usage IS '官方代理各帳號的本週用量（已用百分比與重置時間）；console-vm 的 snapshot_quota 每 15 分鐘整批更新，捐款頁顯示用，公開唯讀；不存 email 與帳號名';
ALTER TABLE agent_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_usage_public_read ON agent_usage;
CREATE POLICY agent_usage_public_read ON agent_usage FOR SELECT USING (true);

-- ── 密鑰：沒有才產 ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'agent_usage_cron_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'agent_usage_cron_secret',
      'console-vm snapshot_quota 的 pg_cron 呼叫憑證（migration 自動產生；console-vm 用 agent_usage_cron_secret_ok 驗，不持有這個值）'
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.agent_usage_cron_secret_ok(p_secret text)
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
        WHERE s.name = 'agent_usage_cron_secret'
          AND extensions.digest(s.decrypted_secret, 'sha256') = extensions.digest(p_secret, 'sha256')
     );
$$;
REVOKE ALL ON FUNCTION public.agent_usage_cron_secret_ok(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_usage_cron_secret_ok(text) FROM anon;
REVOKE ALL ON FUNCTION public.agent_usage_cron_secret_ok(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.agent_usage_cron_secret_ok(text) TO service_role;
COMMENT ON FUNCTION public.agent_usage_cron_secret_ok(text) IS 'console-vm snapshot_quota 驗 x-cron-secret 用：跟 Vault 的 agent_usage_cron_secret 比對，只授權 service_role';

-- ── 排程：每 15 分鐘（函式還沒部署時 net.http_post 只會收到 404，無害）──────
SELECT cron.unschedule('agent-usage-15min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agent-usage-15min');
SELECT cron.schedule('agent-usage-15min', '11,26,41,56 * * * *', $$
  SELECT net.http_post(
    url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/console-vm',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'agent_usage_cron_secret' LIMIT 1), '')
    ),
    body := '{"action":"snapshot_quota"}'::jsonb,
    timeout_milliseconds := 30000
  );
$$);

NOTIFY pgrst, 'reload schema';
