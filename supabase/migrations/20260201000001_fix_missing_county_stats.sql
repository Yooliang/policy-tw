-- ============================================================
-- 修復缺少縣市層級統計記錄的問題
-- 問題：某些縣市所有政治人物都有 sub_region，導致沒有 sub_region IS NULL 的記錄
-- ============================================================

-- 1. 確保所有縣市都有縣市層級記錄 (sub_region IS NULL)
INSERT INTO regions (region, sub_region, village, total_politicians, mayor_count, councilor_count, township_mayor_count, representative_count, village_chief_count, policy_count)
SELECT DISTINCT
  region,
  NULL,
  NULL,
  0, 0, 0, 0, 0, 0, 0
FROM politicians
WHERE region IS NOT NULL
ON CONFLICT (region, sub_region, village) DO NOTHING;

-- 2. 重新計算縣市層級人數統計
WITH city_stats AS (
  SELECT
    region,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長') as mayor,
    COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員') as councilor,
    COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')) as township,
    COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')) as rep,
    COUNT(*) FILTER (WHERE election_type::TEXT = '村里長') as village_chief
  FROM politicians
  WHERE region IS NOT NULL
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

-- 3. 重新計算縣市層級政見數
WITH city_policies AS (
  SELECT p.region, COUNT(pol.id) as cnt
  FROM policies pol
  JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL
  GROUP BY p.region
)
UPDATE regions r SET
  policy_count = cp.cnt,
  updated_at = NOW()
FROM city_policies cp
WHERE r.region = cp.region AND r.sub_region IS NULL AND r.village IS NULL;

-- 4. 驗證結果
DO $$
DECLARE
  v_missing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_missing_count
  FROM (
    SELECT DISTINCT region FROM politicians WHERE region IS NOT NULL
    EXCEPT
    SELECT region FROM regions WHERE sub_region IS NULL AND village IS NULL
  ) missing;

  IF v_missing_count > 0 THEN
    RAISE NOTICE 'Warning: Still missing % county-level records', v_missing_count;
  ELSE
    RAISE NOTICE 'Success: All counties have county-level records';
  END IF;
END $$;
