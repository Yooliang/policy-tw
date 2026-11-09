-- quota_asn_gate：放寬 slot 檢查，允許 agy 多帳號（Yooliang/policy-console 的 agy_<cid>，例如 agy_a2）
-- ============================================================
-- 原本只收 'agy'、'grok'。agy 現在像 Claude 一樣有多個帳號：a1 沿用 slot 'agy'，其餘 cid 用 'agy_<cid>'。
-- 只放寬 CHECK，不動資料、權限與 RLS。
ALTER TABLE quota_asn_gate DROP CONSTRAINT IF EXISTS quota_asn_gate_slot_check;
ALTER TABLE quota_asn_gate
  ADD CONSTRAINT quota_asn_gate_slot_check CHECK (slot ~ '^(grok|agy|agy_[a-z][a-z0-9]{0,7})$');
