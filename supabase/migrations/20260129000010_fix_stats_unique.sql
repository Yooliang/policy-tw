-- ============================================================
-- 修正統計表的 UNIQUE 約束（處理 NULL 值）
-- ============================================================

-- 1. 刪除測試資料（如果存在）
DELETE FROM politicians WHERE name = '觸發器測試';

-- 2. 合併重複的統計記錄
-- 先刪除重複的記錄（保留 id 最小的）
DELETE FROM politician_stats_by_region a
USING politician_stats_by_region b
WHERE a.id > b.id
  AND a.region = b.region
  AND a.sub_region IS NOT DISTINCT FROM b.sub_region
  AND a.village IS NOT DISTINCT FROM b.village;

-- 3. 移除舊的 UNIQUE 約束
ALTER TABLE politician_stats_by_region
  DROP CONSTRAINT IF EXISTS politician_stats_by_region_region_sub_region_village_key;

-- 4. 新增使用 NULLS NOT DISTINCT 的 UNIQUE 約束（PostgreSQL 15+）
ALTER TABLE politician_stats_by_region
  ADD CONSTRAINT politician_stats_by_region_unique_region
  UNIQUE NULLS NOT DISTINCT (region, sub_region, village);

-- 5. 更新觸發器函數，使用 IS NOT DISTINCT FROM 進行比對
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
