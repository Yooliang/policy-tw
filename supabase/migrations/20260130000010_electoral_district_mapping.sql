-- ============================================================
-- 建立選舉區與鄉鎮區的對應表
-- 用於議員篩選：使用者選「茂林區」→ 自動顯示「第01選舉區」的議員
-- ============================================================

CREATE TABLE IF NOT EXISTS electoral_district_areas (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,              -- 縣市名稱 (高雄市)
  electoral_district TEXT NOT NULL,  -- 選舉區名稱 (第01選舉區)
  township TEXT NOT NULL,            -- 鄉鎮區名稱 (茂林區)
  election_id INTEGER,               -- 選舉年份 (2022)
  prv_code TEXT,                     -- 中選會省代碼
  area_code TEXT,                    -- 中選會選舉區代碼
  dept_code TEXT,                    -- 中選會鄉鎮代碼
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(region, electoral_district, township, election_id)
);

-- 建立索引加速查詢
CREATE INDEX IF NOT EXISTS idx_electoral_district_areas_region_township
  ON electoral_district_areas(region, township, election_id);

CREATE INDEX IF NOT EXISTS idx_electoral_district_areas_region_district
  ON electoral_district_areas(region, electoral_district, election_id);

-- RLS 政策
ALTER TABLE electoral_district_areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access on electoral_district_areas"
  ON electoral_district_areas FOR SELECT
  USING (true);

-- 註解
COMMENT ON TABLE electoral_district_areas IS '選舉區與鄉鎮區的對應表，用於議員篩選';
COMMENT ON COLUMN electoral_district_areas.region IS '縣市名稱';
COMMENT ON COLUMN electoral_district_areas.electoral_district IS '議員選舉區名稱';
COMMENT ON COLUMN electoral_district_areas.township IS '鄉鎮市區名稱';
COMMENT ON COLUMN electoral_district_areas.election_id IS '選舉年份';
