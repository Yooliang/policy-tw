-- ============================================================
-- verified 即自動落庫、edit_history 可整筆還原、政見相似度守門
--   1. contributions.status 加 apply_failed／needs_review／reverted；加 applied_at
--   2. edit_history：apply 造成的每一個 UPDATE／INSERT 都留一列，revert 用它倒回
--   3. pg_trgm：政見標題相似度（find_similar_policies）
--   4. 掃地機：apply-verified Edge Function 每 10 分鐘掃 status=verified 且 5 分鐘前的（cron 設定見 docs/CONTRIBUTIONS-ADMIN.md）
-- ============================================================

-- ------------------------------------------------------------
-- 1. contributions 狀態擴充
-- ------------------------------------------------------------
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_status_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_status_check
  CHECK (status IN ('pending', 'verified', 'disputed', 'approved', 'rejected', 'applied', 'apply_failed', 'needs_review', 'reverted'));
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
COMMENT ON COLUMN contributions.status IS 'pending→verified（同儕）→applied（自動落庫）；apply_failed＝落庫出錯；needs_review＝身份模稜兩可或政見疑似重複，等維護者；disputed＝2 票反對；reverted＝維護者整筆還原';

-- ------------------------------------------------------------
-- 2. edit_history
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edit_history (
  id               BIGSERIAL PRIMARY KEY,
  table_name       TEXT NOT NULL,
  record_id        TEXT NOT NULL,
  field            TEXT NOT NULL,                 -- '*' 代表整列 INSERT
  old_value        JSONB,
  new_value        JSONB,
  contribution_id  UUID REFERENCES contributions(id) ON DELETE SET NULL,
  agent_name       TEXT,
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at      TIMESTAMPTZ,
  reverted_by      TEXT
);
COMMENT ON TABLE edit_history IS 'apply 對正式表做的每一個變更；revert 依 contribution_id 由新到舊倒回（UPDATE 還原 old_value、INSERT 刪列）';
CREATE INDEX IF NOT EXISTS idx_edit_history_contribution ON edit_history (contribution_id, id);
CREATE INDEX IF NOT EXISTS idx_edit_history_record ON edit_history (table_name, record_id);
ALTER TABLE edit_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON edit_history;
CREATE POLICY "Public read" ON edit_history FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role all" ON edit_history;
CREATE POLICY "Service role all" ON edit_history FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 3. 政見相似度守門（pg_trgm）
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_policies_title_trgm ON policies USING gin (title gin_trgm_ops);

-- 同一人既有政見中，標題 similarity ≥ 門檻 或 互相包含 的
CREATE OR REPLACE FUNCTION find_similar_policies(p_politician_id UUID, p_title TEXT, p_threshold REAL DEFAULT 0.6)
RETURNS TABLE (id UUID, title TEXT, category TEXT, status TEXT, similarity REAL)
LANGUAGE sql STABLE AS $$
  SELECT p.id, p.title, p.category, p.status::TEXT, similarity(p.title, p_title) AS similarity
  FROM policies p
  WHERE p.politician_id = p_politician_id
    AND (
      similarity(p.title, p_title) >= p_threshold
      OR p.title ILIKE '%' || p_title || '%'
      OR p_title ILIKE '%' || p.title || '%'
    )
  ORDER BY similarity DESC
  LIMIT 10;
$$;
