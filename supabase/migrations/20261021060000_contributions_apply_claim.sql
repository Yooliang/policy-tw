-- 落庫前原子認領（2026-10-21）：同一筆已驗證貢獻被兩個執行同時落庫，建出兩個人物（4010ebc0 陳清泉）。
-- auto-apply 在呼叫 applyFn 之前先條件式 UPDATE 這一欄搶認領；搶輸的放棄。寫回狀態時一併清成 NULL，
-- 執行中途死掉沒清的，租約（10 分鐘，_shared/auto-apply.ts APPLY_CLAIM_LEASE_MS）過後別人可接手。
-- 只加欄位、不動 status CHECK，所有讀 status 的地方不受影響。
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS apply_claimed_at TIMESTAMPTZ;
COMMENT ON COLUMN contributions.apply_claimed_at IS '自動落庫的認領時間；NULL＝沒人在落庫。落庫前條件式 UPDATE 搶、寫回狀態時清掉，超過 10 分鐘視為過期可接手';
