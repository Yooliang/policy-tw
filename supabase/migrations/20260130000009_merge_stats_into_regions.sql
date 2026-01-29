-- ============================================================
-- 將統計資料合併到 regions 表
-- ============================================================

-- 0. 先移除舊的觸發器（避免衝突）
DROP TRIGGER IF EXISTS trg_politician_stats ON politicians;
DROP TRIGGER IF EXISTS trg_policy_stats ON policies;

-- 1. 在 regions 表新增統計欄位
ALTER TABLE regions
ADD COLUMN IF NOT EXISTS total_politicians INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS mayor_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS councilor_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS township_mayor_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS representative_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS village_chief_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS policy_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2. 從 politician_stats_by_region 遷移資料到 regions（如果該表存在）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'politician_stats_by_region' AND table_type = 'BASE TABLE') THEN
    UPDATE regions r
    SET
      total_politicians = COALESCE(s.total_politicians, 0),
      mayor_count = COALESCE(s.mayor_count, 0),
      councilor_count = COALESCE(s.councilor_count, 0),
      township_mayor_count = COALESCE(s.township_mayor_count, 0),
      representative_count = COALESCE(s.representative_count, 0),
      village_chief_count = COALESCE(s.village_chief_count, 0),
      policy_count = COALESCE(s.policy_count, 0),
      updated_at = COALESCE(s.updated_at, NOW())
    FROM politician_stats_by_region s
    WHERE r.region = s.region
      AND COALESCE(r.sub_region, '') = COALESCE(s.sub_region, '')
      AND COALESCE(r.village, '') = COALESCE(s.village, '');
  END IF;
END $$;

-- 3. 確保輔助函數存在
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

-- 4. 更新觸發器函數：改為更新 regions 表
CREATE OR REPLACE FUNCTION update_region_stats(
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

  -- 查找或建立 region 記錄
  SELECT id INTO v_region_id
  FROM regions
  WHERE region = p_region
    AND COALESCE(sub_region, '') = COALESCE(p_sub_region, '')
    AND COALESCE(village, '') = COALESCE(p_village, '');

  IF v_region_id IS NULL THEN
    INSERT INTO regions (region, sub_region, village, total_politicians)
    VALUES (p_region, p_sub_region, p_village, 0)
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

  -- 更新統計
  v_sql := format(
    'UPDATE regions SET
       total_politicians = GREATEST(0, total_politicians + $1),
       %I = GREATEST(0, %I + $1),
       updated_at = NOW()
     WHERE id = $2',
    p_stat_column, p_stat_column
  );

  EXECUTE v_sql USING p_delta, v_region_id;
END;
$$ LANGUAGE plpgsql;

-- 4. 更新政治人物統計觸發器
CREATE OR REPLACE FUNCTION update_politician_stats()
RETURNS TRIGGER AS $$
DECLARE
  v_old_stat_column TEXT;
  v_new_stat_column TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_stat_column := get_stat_column_for_type(OLD.election_type::TEXT);
    PERFORM update_region_stats(OLD.region, NULL, NULL, v_old_stat_column, -1);
    IF OLD.sub_region IS NOT NULL THEN
      PERFORM update_region_stats(OLD.region, OLD.sub_region, NULL, v_old_stat_column, -1);
    END IF;
    IF OLD.village IS NOT NULL AND OLD.sub_region IS NOT NULL THEN
      PERFORM update_region_stats(OLD.region, OLD.sub_region, OLD.village, v_old_stat_column, -1);
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_new_stat_column := get_stat_column_for_type(NEW.election_type::TEXT);
    PERFORM update_region_stats(NEW.region, NULL, NULL, v_new_stat_column, 1);
    IF NEW.sub_region IS NOT NULL THEN
      PERFORM update_region_stats(NEW.region, NEW.sub_region, NULL, v_new_stat_column, 1);
    END IF;
    IF NEW.village IS NOT NULL AND NEW.sub_region IS NOT NULL THEN
      PERFORM update_region_stats(NEW.region, NEW.sub_region, NEW.village, v_new_stat_column, 1);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.region IS DISTINCT FROM NEW.region OR
       OLD.sub_region IS DISTINCT FROM NEW.sub_region OR
       OLD.village IS DISTINCT FROM NEW.village OR
       OLD.election_type::TEXT IS DISTINCT FROM NEW.election_type::TEXT THEN

      v_old_stat_column := get_stat_column_for_type(OLD.election_type::TEXT);
      PERFORM update_region_stats(OLD.region, NULL, NULL, v_old_stat_column, -1);
      IF OLD.sub_region IS NOT NULL THEN
        PERFORM update_region_stats(OLD.region, OLD.sub_region, NULL, v_old_stat_column, -1);
      END IF;
      IF OLD.village IS NOT NULL AND OLD.sub_region IS NOT NULL THEN
        PERFORM update_region_stats(OLD.region, OLD.sub_region, OLD.village, v_old_stat_column, -1);
      END IF;

      v_new_stat_column := get_stat_column_for_type(NEW.election_type::TEXT);
      PERFORM update_region_stats(NEW.region, NULL, NULL, v_new_stat_column, 1);
      IF NEW.sub_region IS NOT NULL THEN
        PERFORM update_region_stats(NEW.region, NEW.sub_region, NULL, v_new_stat_column, 1);
      END IF;
      IF NEW.village IS NOT NULL AND NEW.sub_region IS NOT NULL THEN
        PERFORM update_region_stats(NEW.region, NEW.sub_region, NEW.village, v_new_stat_column, 1);
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 5. 更新政見統計觸發器
CREATE OR REPLACE FUNCTION update_policy_stats()
RETURNS TRIGGER AS $$
DECLARE
  v_region TEXT;
  v_sub_region TEXT;
  v_village TEXT;
  v_region_id INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT region, sub_region, village INTO v_region, v_sub_region, v_village
    FROM politicians WHERE id = OLD.politician_id;

    IF v_region IS NOT NULL THEN
      -- 縣市層級
      UPDATE regions SET policy_count = GREATEST(0, policy_count - 1), updated_at = NOW()
      WHERE region = v_region AND sub_region IS NULL AND village IS NULL;
      -- 鄉鎮層級
      IF v_sub_region IS NOT NULL THEN
        UPDATE regions SET policy_count = GREATEST(0, policy_count - 1), updated_at = NOW()
        WHERE region = v_region AND sub_region = v_sub_region AND village IS NULL;
      END IF;
      -- 村里層級
      IF v_village IS NOT NULL AND v_sub_region IS NOT NULL THEN
        UPDATE regions SET policy_count = GREATEST(0, policy_count - 1), updated_at = NOW()
        WHERE region = v_region AND sub_region = v_sub_region AND village = v_village;
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT region, sub_region, village INTO v_region, v_sub_region, v_village
    FROM politicians WHERE id = NEW.politician_id;

    IF v_region IS NOT NULL THEN
      -- 確保 region 記錄存在並更新
      INSERT INTO regions (region, sub_region, village, policy_count)
      VALUES (v_region, NULL, NULL, 1)
      ON CONFLICT (region, sub_region, village)
      DO UPDATE SET policy_count = regions.policy_count + 1, updated_at = NOW();

      IF v_sub_region IS NOT NULL THEN
        INSERT INTO regions (region, sub_region, village, policy_count)
        VALUES (v_region, v_sub_region, NULL, 1)
        ON CONFLICT (region, sub_region, village)
        DO UPDATE SET policy_count = regions.policy_count + 1, updated_at = NOW();
      END IF;

      IF v_village IS NOT NULL AND v_sub_region IS NOT NULL THEN
        INSERT INTO regions (region, sub_region, village, policy_count)
        VALUES (v_region, v_sub_region, v_village, 1)
        ON CONFLICT (region, sub_region, village)
        DO UPDATE SET policy_count = regions.policy_count + 1, updated_at = NOW();
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.politician_id IS DISTINCT FROM NEW.politician_id THEN
    -- 處理舊的
    SELECT region, sub_region, village INTO v_region, v_sub_region, v_village
    FROM politicians WHERE id = OLD.politician_id;
    IF v_region IS NOT NULL THEN
      UPDATE regions SET policy_count = GREATEST(0, policy_count - 1), updated_at = NOW()
      WHERE region = v_region AND sub_region IS NULL AND village IS NULL;
      IF v_sub_region IS NOT NULL THEN
        UPDATE regions SET policy_count = GREATEST(0, policy_count - 1), updated_at = NOW()
        WHERE region = v_region AND sub_region = v_sub_region AND village IS NULL;
      END IF;
      IF v_village IS NOT NULL AND v_sub_region IS NOT NULL THEN
        UPDATE regions SET policy_count = GREATEST(0, policy_count - 1), updated_at = NOW()
        WHERE region = v_region AND sub_region = v_sub_region AND village = v_village;
      END IF;
    END IF;

    -- 處理新的
    SELECT region, sub_region, village INTO v_region, v_sub_region, v_village
    FROM politicians WHERE id = NEW.politician_id;
    IF v_region IS NOT NULL THEN
      INSERT INTO regions (region, sub_region, village, policy_count)
      VALUES (v_region, NULL, NULL, 1)
      ON CONFLICT (region, sub_region, village)
      DO UPDATE SET policy_count = regions.policy_count + 1, updated_at = NOW();

      IF v_sub_region IS NOT NULL THEN
        INSERT INTO regions (region, sub_region, village, policy_count)
        VALUES (v_region, v_sub_region, NULL, 1)
        ON CONFLICT (region, sub_region, village)
        DO UPDATE SET policy_count = regions.policy_count + 1, updated_at = NOW();
      END IF;

      IF v_village IS NOT NULL AND v_sub_region IS NOT NULL THEN
        INSERT INTO regions (region, sub_region, village, policy_count)
        VALUES (v_region, v_sub_region, v_village, 1)
        ON CONFLICT (region, sub_region, village)
        DO UPDATE SET policy_count = regions.policy_count + 1, updated_at = NOW();
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. 重新計算統計（確保資料正確）
-- 先歸零
UPDATE regions SET
  total_politicians = 0,
  mayor_count = 0,
  councilor_count = 0,
  township_mayor_count = 0,
  representative_count = 0,
  village_chief_count = 0,
  policy_count = 0;

-- 縣市層級人數
WITH city_stats AS (
  SELECT
    region,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長') as mayor,
    COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員') as councilor,
    COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')) as township,
    COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')) as rep,
    COUNT(*) FILTER (WHERE election_type::TEXT = '村里長') as village_chief
  FROM politicians WHERE region IS NOT NULL
  GROUP BY region
)
UPDATE regions r SET
  total_politicians = cs.total,
  mayor_count = cs.mayor,
  councilor_count = cs.councilor,
  township_mayor_count = cs.township,
  representative_count = cs.rep,
  village_chief_count = cs.village_chief,
  updated_at = NOW()
FROM city_stats cs
WHERE r.region = cs.region AND r.sub_region IS NULL AND r.village IS NULL;

-- 鄉鎮層級人數
WITH district_stats AS (
  SELECT
    region, sub_region,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長') as mayor,
    COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員') as councilor,
    COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')) as township,
    COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')) as rep,
    COUNT(*) FILTER (WHERE election_type::TEXT = '村里長') as village_chief
  FROM politicians WHERE region IS NOT NULL AND sub_region IS NOT NULL
  GROUP BY region, sub_region
)
UPDATE regions r SET
  total_politicians = ds.total,
  mayor_count = ds.mayor,
  councilor_count = ds.councilor,
  township_mayor_count = ds.township,
  representative_count = ds.rep,
  village_chief_count = ds.village_chief,
  updated_at = NOW()
FROM district_stats ds
WHERE r.region = ds.region AND r.sub_region = ds.sub_region AND r.village IS NULL;

-- 村里層級人數
WITH village_stats AS (
  SELECT
    region, sub_region, village,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長') as mayor,
    COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員') as councilor,
    COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')) as township,
    COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')) as rep,
    COUNT(*) FILTER (WHERE election_type::TEXT = '村里長') as village_chief
  FROM politicians WHERE region IS NOT NULL AND sub_region IS NOT NULL AND village IS NOT NULL
  GROUP BY region, sub_region, village
)
UPDATE regions r SET
  total_politicians = vs.total,
  mayor_count = vs.mayor,
  councilor_count = vs.councilor,
  township_mayor_count = vs.township,
  representative_count = vs.rep,
  village_chief_count = vs.village_chief,
  updated_at = NOW()
FROM village_stats vs
WHERE r.region = vs.region AND r.sub_region = vs.sub_region AND r.village = vs.village;

-- 縣市層級政見數
WITH city_policies AS (
  SELECT p.region, COUNT(pol.id) as cnt
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL
  GROUP BY p.region
)
UPDATE regions r SET policy_count = cp.cnt
FROM city_policies cp
WHERE r.region = cp.region AND r.sub_region IS NULL AND r.village IS NULL;

-- 鄉鎮層級政見數
WITH district_policies AS (
  SELECT p.region, p.sub_region, COUNT(pol.id) as cnt
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL AND p.sub_region IS NOT NULL
  GROUP BY p.region, p.sub_region
)
UPDATE regions r SET policy_count = dp.cnt
FROM district_policies dp
WHERE r.region = dp.region AND r.sub_region = dp.sub_region AND r.village IS NULL;

-- 村里層級政見數
WITH village_policies AS (
  SELECT p.region, p.sub_region, p.village, COUNT(pol.id) as cnt
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL AND p.sub_region IS NOT NULL AND p.village IS NOT NULL
  GROUP BY p.region, p.sub_region, p.village
)
UPDATE regions r SET policy_count = vp.cnt
FROM village_policies vp
WHERE r.region = vp.region AND r.sub_region = vp.sub_region AND r.village = vp.village;

-- 7. 刪除舊的 politician_stats_by_region 表
DROP TABLE IF EXISTS politician_stats_by_region CASCADE;

-- 8. 建立向後相容的 View（如果有其他地方還在用）
CREATE OR REPLACE VIEW politician_stats_by_region AS
SELECT
  id,
  region,
  sub_region,
  village,
  total_politicians,
  mayor_count,
  councilor_count,
  township_mayor_count,
  representative_count,
  village_chief_count,
  policy_count,
  updated_at
FROM regions;

-- 9. 建立新的觸發器
DROP TRIGGER IF EXISTS trg_region_politician_stats ON politicians;
CREATE TRIGGER trg_region_politician_stats
AFTER INSERT OR UPDATE OR DELETE ON politicians
FOR EACH ROW EXECUTE FUNCTION update_politician_stats();

DROP TRIGGER IF EXISTS trg_region_policy_stats ON policies;
CREATE TRIGGER trg_region_policy_stats
AFTER INSERT OR UPDATE OR DELETE ON policies
FOR EACH ROW EXECUTE FUNCTION update_policy_stats();

-- 10. 加註解
COMMENT ON COLUMN regions.total_politicians IS '該地區政治人物總數';
COMMENT ON COLUMN regions.policy_count IS '該地區政見總數';
COMMENT ON COLUMN regions.mayor_count IS '縣市長數';
COMMENT ON COLUMN regions.councilor_count IS '縣市議員數';
COMMENT ON COLUMN regions.township_mayor_count IS '鄉鎮市長數';
COMMENT ON COLUMN regions.representative_count IS '代表數';
COMMENT ON COLUMN regions.village_chief_count IS '村里長數';
COMMENT ON COLUMN regions.updated_at IS '統計更新時間';
