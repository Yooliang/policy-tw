-- ============================================================
-- 修正議員選區的 region 欄位
-- 將「第01選舉區」等選區名稱從 region 移到 sub_region
-- ============================================================

-- 找出所有 region 是選區名稱的議員記錄
-- 特徵：region 以「第」開頭且包含「選舉區」
-- 這些記錄的 region 應該是縣市名稱，但錯誤存成了選區名稱

-- 由於無法直接知道正確的縣市名稱，需要從其他線索推斷
-- 暫時標記這些記錄，讓管理員手動確認

-- 先查看有哪些錯誤的 region
-- SELECT DISTINCT region FROM politicians WHERE region LIKE '第%選舉區';

-- 統計這些錯誤資料
-- SELECT region, COUNT(*) FROM politicians WHERE region LIKE '第%選舉區' GROUP BY region;

-- 暫時方案：將選區名稱移到 sub_region，region 設為需確認
-- 但這樣會遺失原本的縣市資訊

-- 更好的方案：透過 politician_elections 和 elections 表來推斷
-- 但這需要更複雜的邏輯

-- 目前僅更新統計表，排除這些無效資料
-- 實際資料修正需要在重新抓取時處理

-- 重新計算統計表（排除無效的 region）
TRUNCATE politician_stats_by_region RESTART IDENTITY;

-- 定義有效的縣市列表
CREATE TEMP TABLE valid_cities (name TEXT PRIMARY KEY);
INSERT INTO valid_cities VALUES
  ('台北市'),('新北市'),('桃園市'),('台中市'),('台南市'),('高雄市'),
  ('基隆市'),('新竹市'),('嘉義市'),
  ('新竹縣'),('苗栗縣'),('彰化縣'),('南投縣'),('雲林縣'),('嘉義縣'),
  ('屏東縣'),('宜蘭縣'),('花蓮縣'),('台東縣'),('澎湖縣'),('金門縣'),('連江縣');

-- 1. 縣市層級統計（只計算有效縣市）
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
WHERE region IN (SELECT name FROM valid_cities)
GROUP BY region;

-- 2. 鄉鎮層級統計
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
WHERE region IN (SELECT name FROM valid_cities)
  AND sub_region IS NOT NULL
GROUP BY region, sub_region;

-- 3. 村里層級統計
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
WHERE region IN (SELECT name FROM valid_cities)
  AND sub_region IS NOT NULL
  AND village IS NOT NULL
GROUP BY region, sub_region, village;

-- 加入「其他/待確認」的統計（顯示有多少資料需要修正）
INSERT INTO politician_stats_by_region (
  region, sub_region, village,
  total_politicians, mayor_count, councilor_count,
  township_mayor_count, representative_count, village_chief_count
)
SELECT
  '待確認' AS region,
  NULL AS sub_region,
  NULL AS village,
  COUNT(*) AS total_politicians,
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長') AS mayor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員') AS councilor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')) AS township_mayor_count,
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')) AS representative_count,
  COUNT(*) FILTER (WHERE election_type::TEXT = '村里長') AS village_chief_count
FROM politicians
WHERE region NOT IN (SELECT name FROM valid_cities);
