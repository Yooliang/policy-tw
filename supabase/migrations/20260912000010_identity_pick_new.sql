-- 身份指認多一個選項：resolved_politician_id = 'new'（都不是候選人物，建新的）
--   兩票都說 new → 建新人物；一票 new 一票指定某人 → disputed（進裁決任務）
--   欄位從 UUID FK 改成 TEXT（uuid 或 'new'），仍以 CHECK 限制格式

ALTER TABLE contribution_votes DROP CONSTRAINT IF EXISTS contribution_votes_resolved_politician_id_fkey;
ALTER TABLE contribution_votes ALTER COLUMN resolved_politician_id TYPE TEXT USING resolved_politician_id::text;
ALTER TABLE contribution_votes DROP CONSTRAINT IF EXISTS contribution_votes_resolved_politician_id_check;
ALTER TABLE contribution_votes ADD CONSTRAINT contribution_votes_resolved_politician_id_check
  CHECK (resolved_politician_id IS NULL OR resolved_politician_id = 'new'
         OR resolved_politician_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
COMMENT ON COLUMN contribution_votes.resolved_politician_id IS 'politician／candidacy 驗證者指認：候選人物的 uuid，或 ''new''（都不是，建新人物）；兩票同一個值才生效，不一致 → disputed';
