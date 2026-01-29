-- ============================================================
-- 政治人物統計表 - 按地區自動統計人數
-- ============================================================

-- 0. 先清理可能存在的同名 View（之前可能手動建立的）
DROP VIEW IF EXISTS politician_stats_by_region CASCADE;
DROP TABLE IF EXISTS politician_stats_by_region CASCADE;

-- 1. 建立統計表（單一表 + 階層結構）
CREATE TABLE politician_stats_by_region (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,                  -- 縣市（必填）
  sub_region TEXT,                       -- 鄉鎮區（NULL 表示縣市層級）
  village TEXT,                          -- 村里（NULL 表示鄉鎮層級）
  total_politicians INTEGER DEFAULT 0,   -- 總人數
  mayor_count INTEGER DEFAULT 0,         -- 縣市長
  councilor_count INTEGER DEFAULT 0,     -- 縣市議員
  township_mayor_count INTEGER DEFAULT 0,-- 鄉鎮市長 + 原住民區長
  representative_count INTEGER DEFAULT 0,-- 鄉鎮市民代表 + 原住民區民代表
  village_chief_count INTEGER DEFAULT 0, -- 村里長
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(region, sub_region, village)
);

-- 2. 建立索引
CREATE INDEX idx_stats_region ON politician_stats_by_region(region);
CREATE INDEX idx_stats_sub_region ON politician_stats_by_region(region, sub_region)
  WHERE sub_region IS NOT NULL;
CREATE INDEX idx_stats_city_level ON politician_stats_by_region(region)
  WHERE sub_region IS NULL AND village IS NULL;

-- 3. 啟用 RLS
ALTER TABLE politician_stats_by_region ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON politician_stats_by_region FOR SELECT USING (true);

-- ============================================================
-- 輔助函數：取得 election_type 對應的統計欄位
-- ============================================================
CREATE OR REPLACE FUNCTION get_stat_column_for_type(p_election_type TEXT)
RETURNS TEXT AS $$
BEGIN
  CASE p_election_type
    WHEN '縣市長' THEN RETURN 'mayor_count';
    WHEN '縣市議員' THEN RETURN 'councilor_count';
    WHEN '鄉鎮市長' THEN RETURN 'township_mayor_count';
    WHEN '直轄市山地原住民區長' THEN RETURN 'township_mayor_count';
    WHEN '鄉鎮市民代表' THEN RETURN 'representative_count';
    WHEN '直轄市山地原住民區民代表' THEN RETURN 'representative_count';
    WHEN '村里長' THEN RETURN 'village_chief_count';
    ELSE RETURN NULL;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- 輔助函數：更新指定地區的統計
-- ============================================================
CREATE OR REPLACE FUNCTION update_stats_for_region(
  p_region TEXT,
  p_sub_region TEXT,
  p_village TEXT,
  p_stat_column TEXT,
  p_delta INTEGER
)
RETURNS VOID AS $$
DECLARE
  v_sql TEXT;
BEGIN
  IF p_stat_column IS NULL OR p_region IS NULL THEN
    RETURN;
  END IF;

  -- 使用 UPSERT (INSERT ... ON CONFLICT)
  v_sql := format(
    'INSERT INTO politician_stats_by_region (region, sub_region, village, total_politicians, %I, updated_at)
     VALUES ($1, $2, $3, $4, $4, NOW())
     ON CONFLICT (region, sub_region, village)
     DO UPDATE SET
       total_politicians = politician_stats_by_region.total_politicians + $4,
       %I = politician_stats_by_region.%I + $4,
       updated_at = NOW()',
    p_stat_column, p_stat_column, p_stat_column
  );

  EXECUTE v_sql USING p_region, p_sub_region, p_village, p_delta;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 主觸發器函數：處理 INSERT/UPDATE/DELETE
-- ============================================================
CREATE OR REPLACE FUNCTION update_politician_stats()
RETURNS TRIGGER AS $$
DECLARE
  v_old_stat_column TEXT;
  v_new_stat_column TEXT;
BEGIN
  -- DELETE: 減少舊值統計
  IF TG_OP = 'DELETE' THEN
    v_old_stat_column := get_stat_column_for_type(OLD.election_type::TEXT);

    -- 更新三個層級：縣市、鄉鎮、村里
    -- 縣市層級（sub_region=NULL, village=NULL）
    PERFORM update_stats_for_region(OLD.region, NULL, NULL, v_old_stat_column, -1);

    -- 鄉鎮層級（village=NULL）- 如果有 sub_region
    IF OLD.sub_region IS NOT NULL THEN
      PERFORM update_stats_for_region(OLD.region, OLD.sub_region, NULL, v_old_stat_column, -1);
    END IF;

    -- 村里層級 - 如果有 village
    IF OLD.village IS NOT NULL AND OLD.sub_region IS NOT NULL THEN
      PERFORM update_stats_for_region(OLD.region, OLD.sub_region, OLD.village, v_old_stat_column, -1);
    END IF;

    RETURN OLD;
  END IF;

  -- INSERT: 增加新值統計
  IF TG_OP = 'INSERT' THEN
    v_new_stat_column := get_stat_column_for_type(NEW.election_type::TEXT);

    -- 更新三個層級
    PERFORM update_stats_for_region(NEW.region, NULL, NULL, v_new_stat_column, 1);

    IF NEW.sub_region IS NOT NULL THEN
      PERFORM update_stats_for_region(NEW.region, NEW.sub_region, NULL, v_new_stat_column, 1);
    END IF;

    IF NEW.village IS NOT NULL AND NEW.sub_region IS NOT NULL THEN
      PERFORM update_stats_for_region(NEW.region, NEW.sub_region, NEW.village, v_new_stat_column, 1);
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE: 檢查相關欄位是否變更
  IF TG_OP = 'UPDATE' THEN
    -- 檢查是否有地區或類型變更
    IF OLD.region IS DISTINCT FROM NEW.region OR
       OLD.sub_region IS DISTINCT FROM NEW.sub_region OR
       OLD.village IS DISTINCT FROM NEW.village OR
       OLD.election_type::TEXT IS DISTINCT FROM NEW.election_type::TEXT THEN

      -- 減少舊統計
      v_old_stat_column := get_stat_column_for_type(OLD.election_type::TEXT);
      PERFORM update_stats_for_region(OLD.region, NULL, NULL, v_old_stat_column, -1);
      IF OLD.sub_region IS NOT NULL THEN
        PERFORM update_stats_for_region(OLD.region, OLD.sub_region, NULL, v_old_stat_column, -1);
      END IF;
      IF OLD.village IS NOT NULL AND OLD.sub_region IS NOT NULL THEN
        PERFORM update_stats_for_region(OLD.region, OLD.sub_region, OLD.village, v_old_stat_column, -1);
      END IF;

      -- 增加新統計
      v_new_stat_column := get_stat_column_for_type(NEW.election_type::TEXT);
      PERFORM update_stats_for_region(NEW.region, NULL, NULL, v_new_stat_column, 1);
      IF NEW.sub_region IS NOT NULL THEN
        PERFORM update_stats_for_region(NEW.region, NEW.sub_region, NULL, v_new_stat_column, 1);
      END IF;
      IF NEW.village IS NOT NULL AND NEW.sub_region IS NOT NULL THEN
        PERFORM update_stats_for_region(NEW.region, NEW.sub_region, NEW.village, v_new_stat_column, 1);
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 建立觸發器
-- ============================================================
DROP TRIGGER IF EXISTS trg_politician_stats ON politicians;
CREATE TRIGGER trg_politician_stats
AFTER INSERT OR UPDATE OR DELETE ON politicians
FOR EACH ROW EXECUTE FUNCTION update_politician_stats();

-- ============================================================
-- 初始化現有資料（從 politicians 聚合）
-- ============================================================

-- 1. 縣市層級統計
INSERT INTO politician_stats_by_region (
  region, sub_region, village,
  total_politicians, mayor_count, councilor_count,
  township_mayor_count, representative_count, village_chief_count
)
SELECT
  region,
  NULL AS sub_region,
  NULL AS village,
  COUNT(*) AS total_politicians,
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長') AS mayor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員') AS councilor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')) AS township_mayor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')) AS representative_count,
  COUNT(*) FILTER (WHERE election_type::TEXT = '村里長') AS village_chief_count
FROM politicians
WHERE region IS NOT NULL
GROUP BY region;

-- 2. 鄉鎮層級統計（只有有 sub_region 的資料）
INSERT INTO politician_stats_by_region (
  region, sub_region, village,
  total_politicians, mayor_count, councilor_count,
  township_mayor_count, representative_count, village_chief_count
)
SELECT
  region,
  sub_region,
  NULL AS village,
  COUNT(*) AS total_politicians,
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長') AS mayor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員') AS councilor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')) AS township_mayor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')) AS representative_count,
  COUNT(*) FILTER (WHERE election_type::TEXT = '村里長') AS village_chief_count
FROM politicians
WHERE region IS NOT NULL AND sub_region IS NOT NULL
GROUP BY region, sub_region;

-- 3. 村里層級統計（只有有 village 的資料）
INSERT INTO politician_stats_by_region (
  region, sub_region, village,
  total_politicians, mayor_count, councilor_count,
  township_mayor_count, representative_count, village_chief_count
)
SELECT
  region,
  sub_region,
  village,
  COUNT(*) AS total_politicians,
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長') AS mayor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員') AS councilor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')) AS township_mayor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')) AS representative_count,
  COUNT(*) FILTER (WHERE election_type::TEXT = '村里長') AS village_chief_count
FROM politicians
WHERE region IS NOT NULL AND sub_region IS NOT NULL AND village IS NOT NULL
GROUP BY region, sub_region, village;

-- 加上註解
COMMENT ON TABLE politician_stats_by_region IS '政治人物統計表 - 按地區自動統計人數（由觸發器維護）';
COMMENT ON COLUMN politician_stats_by_region.region IS '縣市名稱（必填）';
COMMENT ON COLUMN politician_stats_by_region.sub_region IS '鄉鎮區名稱（NULL 表示縣市層級統計）';
COMMENT ON COLUMN politician_stats_by_region.village IS '村里名稱（NULL 表示鄉鎮層級統計）';
