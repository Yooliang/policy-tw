-- agy／Grok 額度改讀 ASN 的節流表（Yooliang/policy-console#117 的 console-vm asn-quota.ts）
-- ============================================================
-- 每個帳號（slot）一列：上次真的打 ASN 的時間、退避到期時間、上次回應。不存查詢代碼。
-- 不公開：RLS 開且 FORCE、不建任何 policy；只有 service_role 能 SELECT／INSERT／UPDATE（不給 DELETE）。
CREATE TABLE IF NOT EXISTS quota_asn_gate (
  slot          TEXT PRIMARY KEY CHECK (slot IN ('agy', 'grok')),
  last_call_at  TIMESTAMPTZ NOT NULL,
  backoff_until TIMESTAMPTZ,
  last_status   TEXT NOT NULL CHECK (last_status IN ('ok', 'none', 'error')),
  last_body     JSONB,
  CONSTRAINT quota_asn_gate_last_body_size CHECK (last_body IS NULL OR octet_length(last_body::text) <= 4096)
);
COMMENT ON TABLE quota_asn_gate IS 'console-vm 讀 ASN 額度的節流狀態（60 秒一次、查無／錯誤退避 10 分鐘）；不公開，只有 service_role';

ALTER TABLE quota_asn_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_asn_gate FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quota_asn_gate FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON quota_asn_gate TO service_role;
