-- ============================================================
-- 刪除 region 無效的資料（待確認的資料）
-- 這些資料可以用修正後的 AdminScraper 重新抓取
-- ============================================================

-- 定義有效的縣市列表
CREATE TEMP TABLE valid_cities (name TEXT PRIMARY KEY);
INSERT INTO valid_cities VALUES
  ('台北市'),('新北市'),('桃園市'),('台中市'),('台南市'),('高雄市'),
  ('基隆市'),('新竹市'),('嘉義市'),
  ('新竹縣'),('苗栗縣'),('彰化縣'),('南投縣'),('雲林縣'),('嘉義縣'),
  ('屏東縣'),('宜蘭縣'),('花蓮縣'),('台東縣'),('澎湖縣'),('金門縣'),('連江縣');

-- 刪除 region 不在有效縣市列表中的資料
DELETE FROM politicians
WHERE region NOT IN (SELECT name FROM valid_cities);

-- 重新計算統計表
TRUNCATE politician_stats_by_region RESTART IDENTITY;

-- 1. 縣市層級統計
INSERT INTO politician_stats_by_region (
  region, sub_region, village,
  total_politicians, mayor_count, councilor_count,
  township_mayor_count, representative_count, village_chief_count
)
SELECT
  region, NULL, NULL,
  COUNT(*),
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長'),
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員'),
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')),
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')),
  COUNT(*) FILTER (WHERE election_type::TEXT = '村里長')
FROM politicians
GROUP BY region;

-- 2. 鄉鎮層級統計
INSERT INTO politician_stats_by_region (
  region, sub_region, village,
  total_politicians, mayor_count, councilor_count,
  township_mayor_count, representative_count, village_chief_count
)
SELECT
  region, sub_region, NULL,
  COUNT(*),
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長'),
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員'),
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')),
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')),
  COUNT(*) FILTER (WHERE election_type::TEXT = '村里長')
FROM politicians
WHERE sub_region IS NOT NULL
GROUP BY region, sub_region;

-- 3. 村里層級統計
INSERT INTO politician_stats_by_region (
  region, sub_region, village,
  total_politicians, mayor_count, councilor_count,
  township_mayor_count, representative_count, village_chief_count
)
SELECT
  region, sub_region, village,
  COUNT(*),
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長'),
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員'),
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')),
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')),
  COUNT(*) FILTER (WHERE election_type::TEXT = '村里長')
FROM politicians
WHERE sub_region IS NOT NULL AND village IS NOT NULL
GROUP BY region, sub_region, village;
