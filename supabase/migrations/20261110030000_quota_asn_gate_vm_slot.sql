-- quota_asn_gate：放寬 slot 檢查，允許 VM 上報來源的 vm_agy_<帳號>（Yooliang/policy-console；目前 vm_agy_it、vm_agy_gsetp）
-- ============================================================
-- 原本收 'grok'、'agy'、'agy_<cid>'、'claude_<帳號>'。agy-it／agy-gsetp 的額度改讀 verify VM 上報的外部額度服務，
-- 節流與退避沿用這張 gate 表，slot 用 'vm_agy_<帳號>'。只放寬 CHECK，不動資料、權限與 RLS。
ALTER TABLE quota_asn_gate DROP CONSTRAINT IF EXISTS quota_asn_gate_slot_check;
ALTER TABLE quota_asn_gate
  ADD CONSTRAINT quota_asn_gate_slot_check CHECK (slot ~ '^(grok|agy|agy_[a-z][a-z0-9]{0,7}|claude_[a-z][a-z0-9]{0,7}|vm_agy_[a-z][a-z0-9]{0,7})$');
