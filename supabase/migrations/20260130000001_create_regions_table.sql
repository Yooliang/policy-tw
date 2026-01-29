-- ============================================================
-- Phase 1.1: Create regions table for normalized location data
-- ============================================================

-- Create regions table (stores all unique region combinations)
CREATE TABLE IF NOT EXISTS regions (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,           -- County/City (台北市, 新北市...)
  sub_region TEXT,                -- District/Township (信義區, 板橋區...)
  village TEXT,                   -- Village (永吉里, 光復里...)
  CONSTRAINT regions_unique_combo UNIQUE NULLS NOT DISTINCT (region, sub_region, village)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_regions_region ON regions(region);
CREATE INDEX IF NOT EXISTS idx_regions_sub_region ON regions(sub_region) WHERE sub_region IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_regions_composite ON regions(region, sub_region);

-- Enable RLS
ALTER TABLE regions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON regions FOR SELECT USING (true);

-- Migrate unique regions from existing politicians table
INSERT INTO regions (region, sub_region, village)
SELECT DISTINCT region, sub_region, village
FROM politicians
WHERE region IS NOT NULL
ON CONFLICT DO NOTHING;

-- Supplement from locations table (if any)
INSERT INTO regions (region, sub_region, village)
SELECT DISTINCT name, NULL, NULL
FROM locations
WHERE name IS NOT NULL
ON CONFLICT DO NOTHING;

-- Pre-insert "全國" record for national-level elections (President, At-large legislators)
INSERT INTO regions (region, sub_region, village)
VALUES ('全國', NULL, NULL)
ON CONFLICT DO NOTHING;

-- Add comments
COMMENT ON TABLE regions IS 'Normalized region table storing unique combinations of region/sub_region/village';
COMMENT ON COLUMN regions.region IS 'County/City name (縣市) or "全國" for national level';
COMMENT ON COLUMN regions.sub_region IS 'District/Township name (鄉鎮市區), NULL for city-level';
COMMENT ON COLUMN regions.village IS 'Village name (村里), NULL for township-level';
