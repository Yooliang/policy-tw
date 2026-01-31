-- Add verified field to politician_elections
ALTER TABLE politician_elections
ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS source_note TEXT; -- 來源備註（如：AI搜尋、中選會、新聞等）

-- Add comment
COMMENT ON COLUMN politician_elections.verified IS '是否已核實此參選資料';
COMMENT ON COLUMN politician_elections.verified_at IS '核實時間';
COMMENT ON COLUMN politician_elections.verified_by IS '核實者';
COMMENT ON COLUMN politician_elections.source_note IS '資料來源備註';
