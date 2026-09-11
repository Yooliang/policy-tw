-- 人工介入點收斂成一種：disputed。
--   needs_review（疑似重複政見）→ 廢除：相似度改在派驗證時給驗證者判斷（/next verify item 的 current.similar_policies），不再攔落庫
--   approved（身份待人工）→ 廢除：派驗證時附 identity_candidates，驗證者投 agree 可帶 resolved_politician_id 指認；
--     兩票指同一位就用那位落庫，指不同位或都沒指認且系統判不出 → disputed
--   apply_failed → 自動重試：10 分鐘後重試、最多 3 次（retry_count／last_error／next_retry_at），連續 3 次仍失敗才轉 disputed
--   既有卡在 needs_review／approved 的列轉回 pending，並清掉它們的票讓驗證者重新處理（2026-09-12 dry-run：prod 兩者都是 0 筆）

ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS retry_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error    TEXT,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

ALTER TABLE contribution_votes
  ADD COLUMN IF NOT EXISTS resolved_politician_id UUID REFERENCES politicians(id) ON DELETE SET NULL;
COMMENT ON COLUMN contribution_votes.resolved_politician_id IS 'politician／candidacy 驗證者指認「就是這一位」；兩票同一位即用該 id 落庫';

-- 卡住的列：清票 → 觸發器把計數歸零 → 轉回 pending 重新驗證
DELETE FROM contribution_votes
 WHERE contribution_id IN (SELECT id FROM contributions WHERE status IN ('needs_review', 'approved'));
UPDATE contributions
   SET status = 'pending',
       review_notes = concat_ws('；', review_notes, '[migration 000008] 人工狀態廢除，退回 pending 由驗證者重新處理'),
       reviewed_by = NULL, reviewed_at = NULL
 WHERE status IN ('needs_review', 'approved');

ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_status_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_status_check
  CHECK (status IN ('pending', 'verified', 'disputed', 'rejected', 'applied', 'apply_failed', 'reverted'));
COMMENT ON COLUMN contributions.status IS 'pending→verified（同儕）→applied（自動落庫）；apply_failed＝落庫出錯、10 分鐘後自動重試最多 3 次；disputed＝2 票反對、或身份指認衝突、或連續 3 次落庫失敗——唯一的人工點；rejected／reverted＝維護者裁決';

CREATE INDEX IF NOT EXISTS idx_contributions_retry ON contributions (next_retry_at) WHERE status = 'apply_failed';
