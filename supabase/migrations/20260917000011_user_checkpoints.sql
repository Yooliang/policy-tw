-- 「我的追蹤」（檢核點）登入後帶著走。
--
-- 2026-09-17 小良哥：「沒登入也能用嗎？登入沒記錄這個嗎？」查下去兩個都成立——
-- 檢核點只存在瀏覽器的 localStorage（zhengjian_checkpoints），登入完全沒有寫進資料庫。
-- 結果是換一台裝置、換瀏覽器、清快取就全部消失，即使你有登入。
--
-- 不登入也能用是刻意的（不該逼人註冊才能追蹤政見），所以 localStorage 那條路保留；
-- 這張表只負責「登入之後帶著走」：登入時把本機的合併上來，之後兩邊一起寫。

CREATE TABLE IF NOT EXISTS user_checkpoints (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  policy_id  UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, policy_id)
);

COMMENT ON TABLE user_checkpoints IS '登入者追蹤的政見（我的追蹤）。未登入者的清單留在瀏覽器 localStorage，不進這張表。';

-- 依使用者取整份清單是唯一的讀法
CREATE INDEX IF NOT EXISTS idx_user_checkpoints_user ON user_checkpoints (user_id, created_at DESC);

ALTER TABLE user_checkpoints ENABLE ROW LEVEL SECURITY;

-- 只能讀寫自己的：這是「誰在追蹤哪一筆政見」，別人不該看得到，也不該替別人加
DROP POLICY IF EXISTS "own checkpoints select" ON user_checkpoints;
CREATE POLICY "own checkpoints select" ON user_checkpoints
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "own checkpoints insert" ON user_checkpoints;
CREATE POLICY "own checkpoints insert" ON user_checkpoints
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own checkpoints delete" ON user_checkpoints;
CREATE POLICY "own checkpoints delete" ON user_checkpoints
  FOR DELETE USING (auth.uid() = user_id);
