-- ============================================================
-- 修正政見統計初始化
-- ============================================================

-- 先將所有 policy_count 歸零，重新計算
UPDATE politician_stats_by_region SET policy_count = 0;

-- 1. 縣市層級政見統計（使用更明確的 JOIN）
WITH city_policy_counts AS (
  SELECT
    p.region,
    COUNT(pol.id) as cnt
  FROM policies pol
  INNER JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL
  GROUP BY p.region
)
UPDATE politician_stats_by_region stats
SET policy_count = cpc.cnt
FROM city_policy_counts cpc
WHERE stats.region = cpc.region
  AND stats.sub_region IS NULL
  AND stats.village IS NULL;

-- 2. 鄉鎮層級政見統計
WITH district_policy_counts AS (
  SELECT
    p.region,
    p.sub_region,
    COUNT(pol.id) as cnt
  FROM policies pol
  INNER JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL AND p.sub_region IS NOT NULL
  GROUP BY p.region, p.sub_region
)
UPDATE politician_stats_by_region stats
SET policy_count = dpc.cnt
FROM district_policy_counts dpc
WHERE stats.region = dpc.region
  AND stats.sub_region = dpc.sub_region
  AND stats.village IS NULL;

-- 3. 村里層級政見統計
WITH village_policy_counts AS (
  SELECT
    p.region,
    p.sub_region,
    p.village,
    COUNT(pol.id) as cnt
  FROM policies pol
  INNER JOIN politicians p ON pol.politician_id = p.id
  WHERE p.region IS NOT NULL AND p.sub_region IS NOT NULL AND p.village IS NOT NULL
  GROUP BY p.region, p.sub_region, p.village
)
UPDATE politician_stats_by_region stats
SET policy_count = vpc.cnt
FROM village_policy_counts vpc
WHERE stats.region = vpc.region
  AND stats.sub_region = vpc.sub_region
  AND stats.village = vpc.village;
