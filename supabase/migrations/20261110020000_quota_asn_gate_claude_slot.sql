-- quota_asn_gate：放寬 slot 檢查，允許 Claude 帳號（Yooliang/policy-console 的 claude_<帳號>，目前只有 claude_cwen）
-- ============================================================
-- 原本收 'grok'、'agy'、'agy_<cid>'。cwen0708 的 Claude 訂閱額度改讀 ASN quota_read，slot 用 'claude_cwen'。
-- 只放寬 CHECK，不動資料、權限與 RLS。
ALTER TABLE quota_asn_gate DROP CONSTRAINT IF EXISTS quota_asn_gate_slot_check;
ALTER TABLE quota_asn_gate
  ADD CONSTRAINT quota_asn_gate_slot_check CHECK (slot ~ '^(grok|agy|agy_[a-z][a-z0-9]{0,7}|claude_[a-z][a-z0-9]{0,7})$');
