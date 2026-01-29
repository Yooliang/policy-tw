-- ============================================================
-- 新增政見數量到統計表
-- ============================================================

-- 1. 新增政見數量欄位
ALTER TABLE politician_stats_by_region
ADD COLUMN IF NOT EXISTS policy_count INTEGER DEFAULT 0;

-- ============================================================
-- 輔助函數：根據 politician_id 取得地區資訊
-- ============================================================
CREATE OR REPLACE FUNCTION get_politician_region(p_politician_id UUID)
RETURNS TABLE(region TEXT, sub_region TEXT, village TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT p.region, p.sub_region, p.village
  FROM politicians p
  WHERE p.id = p_politician_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- 輔助函數：更新指定地區的政見統計
-- ============================================================
CREATE OR REPLACE FUNCTION update_policy_stats_for_region(
  p_region TEXT,
  p_sub_region TEXT,
  p_village TEXT,
  p_delta INTEGER
)
RETURNS VOID AS $$
BEGIN
  IF p_region IS NULL THEN
    RETURN;
  END IF;

  -- 使用 UPSERT
  INSERT INTO politician_stats_by_region (region, sub_region, village, policy_count, total_politicians, updated_at)
  VALUES (p_region, p_sub_region, p_village, GREATEST(0, p_delta), 0, NOW())
  ON CONFLICT (region, sub_region, village)
  DO UPDATE SET
    policy_count = GREATEST(0, politician_stats_by_region.policy_count + p_delta),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 政見觸發器函數：處理 INSERT/UPDATE/DELETE
-- ============================================================
CREATE OR REPLACE FUNCTION update_policy_stats()
RETURNS TRIGGER AS $$
DECLARE
  v_old_region TEXT;
  v_old_sub_region TEXT;
  v_old_village TEXT;
  v_new_region TEXT;
  v_new_sub_region TEXT;
  v_new_village TEXT;
BEGIN
  -- DELETE: 減少舊統計
  IF TG_OP = 'DELETE' THEN
    SELECT region, sub_region, village
    INTO v_old_region, v_old_sub_region, v_old_village
    FROM politicians WHERE id = OLD.politician_id;

    IF v_old_region IS NOT NULL THEN
      -- 縣市層級
      PERFORM update_policy_stats_for_region(v_old_region, NULL, NULL, -1);
      -- 鄉鎮層級
      IF v_old_sub_region IS NOT NULL THEN
        PERFORM update_policy_stats_for_region(v_old_region, v_old_sub_region, NULL, -1);
      END IF;
      -- 村里層級
      IF v_old_village IS NOT NULL AND v_old_sub_region IS NOT NULL THEN
        PERFORM update_policy_stats_for_region(v_old_region, v_old_sub_region, v_old_village, -1);
      END IF;
    END IF;

    RETURN OLD;
  END IF;

  -- INSERT: 增加新統計
  IF TG_OP = 'INSERT' THEN
    SELECT region, sub_region, village
    INTO v_new_region, v_new_sub_region, v_new_village
    FROM politicians WHERE id = NEW.politician_id;

    IF v_new_region IS NOT NULL THEN
      -- 縣市層級
      PERFORM update_policy_stats_for_region(v_new_region, NULL, NULL, 1);
      -- 鄉鎮層級
      IF v_new_sub_region IS NOT NULL THEN
        PERFORM update_policy_stats_for_region(v_new_region, v_new_sub_region, NULL, 1);
      END IF;
      -- 村里層級
      IF v_new_village IS NOT NULL AND v_new_sub_region IS NOT NULL THEN
        PERFORM update_policy_stats_for_region(v_new_region, v_new_sub_region, v_new_village, 1);
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE: 檢查 politician_id 是否變更
  IF TG_OP = 'UPDATE' THEN
    IF OLD.politician_id IS DISTINCT FROM NEW.politician_id THEN
      -- 減少舊政治人物的地區統計
      SELECT region, sub_region, village
      INTO v_old_region, v_old_sub_region, v_old_village
      FROM politicians WHERE id = OLD.politician_id;

      IF v_old_region IS NOT NULL THEN
        PERFORM update_policy_stats_for_region(v_old_region, NULL, NULL, -1);
        IF v_old_sub_region IS NOT NULL THEN
          PERFORM update_policy_stats_for_region(v_old_region, v_old_sub_region, NULL, -1);
        END IF;
        IF v_old_village IS NOT NULL AND v_old_sub_region IS NOT NULL THEN
          PERFORM update_policy_stats_for_region(v_old_region, v_old_sub_region, v_old_village, -1);
        END IF;
      END IF;

      -- 增加新政治人物的地區統計
      SELECT region, sub_region, village
      INTO v_new_region, v_new_sub_region, v_new_village
      FROM politicians WHERE id = NEW.politician_id;

      IF v_new_region IS NOT NULL THEN
        PERFORM update_policy_stats_for_region(v_new_region, NULL, NULL, 1);
        IF v_new_sub_region IS NOT NULL THEN
          PERFORM update_policy_stats_for_region(v_new_region, v_new_sub_region, NULL, 1);
        END IF;
        IF v_new_village IS NOT NULL AND v_new_sub_region IS NOT NULL THEN
          PERFORM update_policy_stats_for_region(v_new_region, v_new_sub_region, v_new_village, 1);
        END IF;
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 建立政見觸發器
-- ============================================================
DROP TRIGGER IF EXISTS trg_policy_stats ON policies;
CREATE TRIGGER trg_policy_stats
AFTER INSERT OR UPDATE OR DELETE ON policies
FOR EACH ROW EXECUTE FUNCTION update_policy_stats();

-- ============================================================
-- 初始化現有政見統計
-- ============================================================

-- 1. 縣市層級政見統計
UPDATE politician_stats_by_region stats
SET policy_count = COALESCE((
  SELECT COUNT(*)
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region = stats.region
), 0)
WHERE stats.sub_region IS NULL AND stats.village IS NULL;

-- 2. 鄉鎮層級政見統計
UPDATE politician_stats_by_region stats
SET policy_count = COALESCE((
  SELECT COUNT(*)
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region = stats.region AND p.sub_region = stats.sub_region
), 0)
WHERE stats.sub_region IS NOT NULL AND stats.village IS NULL;

-- 3. 村里層級政見統計
UPDATE politician_stats_by_region stats
SET policy_count = COALESCE((
  SELECT COUNT(*)
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region = stats.region AND p.sub_region = stats.sub_region AND p.village = stats.village
), 0)
WHERE stats.village IS NOT NULL;

-- 加上註解
COMMENT ON COLUMN politician_stats_by_region.policy_count IS '政見總數';
