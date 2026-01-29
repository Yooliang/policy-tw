-- ============================================================
-- 重構 politician_stats_by_region 使用 region_id
-- ============================================================

-- 1. 確保 regions 表有所有層級的記錄（縣市、鄉鎮、村里）
-- 縣市層級（sub_region=NULL, village=NULL）
INSERT INTO regions (region, sub_region, village)
SELECT DISTINCT region, NULL, NULL
FROM politicians
WHERE region IS NOT NULL
ON CONFLICT (region, sub_region, village) DO NOTHING;

-- 鄉鎮層級（village=NULL）
INSERT INTO regions (region, sub_region, village)
SELECT DISTINCT region, sub_region, NULL
FROM politicians
WHERE region IS NOT NULL AND sub_region IS NOT NULL
ON CONFLICT (region, sub_region, village) DO NOTHING;

-- 2. 新增 region_id 欄位
ALTER TABLE politician_stats_by_region
ADD COLUMN IF NOT EXISTS region_id INTEGER REFERENCES regions(id);

-- 3. 建立索引
CREATE INDEX IF NOT EXISTS idx_stats_region_id ON politician_stats_by_region(region_id);

-- 4. 填入 region_id
UPDATE politician_stats_by_region stats
SET region_id = r.id
FROM regions r
WHERE stats.region = r.region
  AND COALESCE(stats.sub_region, '') = COALESCE(r.sub_region, '')
  AND COALESCE(stats.village, '') = COALESCE(r.village, '');

-- 5. 更新觸發器函數：使用 region_id
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
  v_region_id INTEGER;
BEGIN
  IF p_stat_column IS NULL OR p_region IS NULL THEN
    RETURN;
  END IF;

  -- 查找或建立 region_id
  SELECT id INTO v_region_id
  FROM regions
  WHERE region = p_region
    AND COALESCE(sub_region, '') = COALESCE(p_sub_region, '')
    AND COALESCE(village, '') = COALESCE(p_village, '');

  -- 如果沒有對應的 regions 記錄，先建立
  IF v_region_id IS NULL THEN
    INSERT INTO regions (region, sub_region, village)
    VALUES (p_region, p_sub_region, p_village)
    ON CONFLICT (region, sub_region, village) DO NOTHING
    RETURNING id INTO v_region_id;

    -- 如果 INSERT 被 ON CONFLICT 跳過，重新查詢
    IF v_region_id IS NULL THEN
      SELECT id INTO v_region_id
      FROM regions
      WHERE region = p_region
        AND COALESCE(sub_region, '') = COALESCE(p_sub_region, '')
        AND COALESCE(village, '') = COALESCE(p_village, '');
    END IF;
  END IF;

  -- 使用 UPSERT
  v_sql := format(
    'INSERT INTO politician_stats_by_region (region, sub_region, village, region_id, total_politicians, %I, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, NOW())
     ON CONFLICT (region, sub_region, village)
     DO UPDATE SET
       region_id = $4,
       total_politicians = politician_stats_by_region.total_politicians + $5,
       %I = politician_stats_by_region.%I + $5,
       updated_at = NOW()',
    p_stat_column, p_stat_column, p_stat_column
  );

  EXECUTE v_sql USING p_region, p_sub_region, p_village, v_region_id, p_delta;
END;
$$ LANGUAGE plpgsql;

-- 6. 更新政見統計觸發器函數
CREATE OR REPLACE FUNCTION update_policy_stats_for_region(
  p_region TEXT,
  p_sub_region TEXT,
  p_village TEXT,
  p_delta INTEGER
)
RETURNS VOID AS $$
DECLARE
  v_region_id INTEGER;
BEGIN
  IF p_region IS NULL THEN
    RETURN;
  END IF;

  -- 查找 region_id
  SELECT id INTO v_region_id
  FROM regions
  WHERE region = p_region
    AND COALESCE(sub_region, '') = COALESCE(p_sub_region, '')
    AND COALESCE(village, '') = COALESCE(p_village, '');

  -- 如果沒有，建立
  IF v_region_id IS NULL THEN
    INSERT INTO regions (region, sub_region, village)
    VALUES (p_region, p_sub_region, p_village)
    ON CONFLICT (region, sub_region, village) DO NOTHING
    RETURNING id INTO v_region_id;

    IF v_region_id IS NULL THEN
      SELECT id INTO v_region_id
      FROM regions
      WHERE region = p_region
        AND COALESCE(sub_region, '') = COALESCE(p_sub_region, '')
        AND COALESCE(village, '') = COALESCE(p_village, '');
    END IF;
  END IF;

  -- UPSERT
  INSERT INTO politician_stats_by_region (region, sub_region, village, region_id, policy_count, total_politicians, updated_at)
  VALUES (p_region, p_sub_region, p_village, v_region_id, GREATEST(0, p_delta), 0, NOW())
  ON CONFLICT (region, sub_region, village)
  DO UPDATE SET
    region_id = v_region_id,
    policy_count = GREATEST(0, politician_stats_by_region.policy_count + p_delta),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- 7. 重新計算政見統計（使用更可靠的方式）
UPDATE politician_stats_by_region SET policy_count = 0;

-- 縣市層級
WITH city_counts AS (
  SELECT p.region, COUNT(pol.id) as cnt
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL
  GROUP BY p.region
)
UPDATE politician_stats_by_region stats
SET policy_count = cc.cnt
FROM city_counts cc
WHERE stats.region = cc.region
  AND stats.sub_region IS NULL
  AND stats.village IS NULL;

-- 鄉鎮層級
WITH district_counts AS (
  SELECT p.region, p.sub_region, COUNT(pol.id) as cnt
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL AND p.sub_region IS NOT NULL
  GROUP BY p.region, p.sub_region
)
UPDATE politician_stats_by_region stats
SET policy_count = dc.cnt
FROM district_counts dc
WHERE stats.region = dc.region
  AND stats.sub_region = dc.sub_region
  AND stats.village IS NULL;

-- 村里層級
WITH village_counts AS (
  SELECT p.region, p.sub_region, p.village, COUNT(pol.id) as cnt
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL AND p.sub_region IS NOT NULL AND p.village IS NOT NULL
  GROUP BY p.region, p.sub_region, p.village
)
UPDATE politician_stats_by_region stats
SET policy_count = vc.cnt
FROM village_counts vc
WHERE stats.region = vc.region
  AND stats.sub_region = vc.sub_region
  AND stats.village = vc.village;

-- 8. 加上註解
COMMENT ON COLUMN politician_stats_by_region.region_id IS '關聯到 regions 表的 ID（正規化）';
