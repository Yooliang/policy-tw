-- ============================================================
-- 修正村里長資料：region = village 的錯誤記錄
-- 根據 sub_region（區名）推斷正確的縣市
-- ============================================================

-- 建立區名對應縣市的對照表（允許重複區名）
CREATE TEMP TABLE district_to_city (
  district TEXT NOT NULL,
  city TEXT NOT NULL
);

-- 台北市的區（獨有）
INSERT INTO district_to_city VALUES
  ('大同區', '台北市'), ('松山區', '台北市'),
  ('萬華區', '台北市'), ('士林區', '台北市'),
  ('北投區', '台北市'), ('內湖區', '台北市'), ('南港區', '台北市'), ('文山區', '台北市');

-- 新北市的區（全部獨有）
INSERT INTO district_to_city VALUES
  ('板橋區', '新北市'), ('三重區', '新北市'), ('中和區', '新北市'), ('永和區', '新北市'),
  ('新莊區', '新北市'), ('新店區', '新北市'), ('土城區', '新北市'), ('蘆洲區', '新北市'),
  ('樹林區', '新北市'), ('汐止區', '新北市'), ('鶯歌區', '新北市'), ('三峽區', '新北市'),
  ('淡水區', '新北市'), ('瑞芳區', '新北市'), ('五股區', '新北市'), ('泰山區', '新北市'),
  ('林口區', '新北市'), ('深坑區', '新北市'), ('石碇區', '新北市'), ('坪林區', '新北市'),
  ('三芝區', '新北市'), ('石門區', '新北市'), ('八里區', '新北市'), ('平溪區', '新北市'),
  ('雙溪區', '新北市'), ('貢寮區', '新北市'), ('金山區', '新北市'), ('萬里區', '新北市'),
  ('烏來區', '新北市');

-- 桃園市的區（獨有）
INSERT INTO district_to_city VALUES
  ('桃園區', '桃園市'), ('中壢區', '桃園市'), ('平鎮區', '桃園市'), ('八德區', '桃園市'),
  ('楊梅區', '桃園市'), ('蘆竹區', '桃園市'), ('大溪區', '桃園市'), ('龍潭區', '桃園市'),
  ('龜山區', '桃園市'), ('大園區', '桃園市'), ('觀音區', '桃園市'), ('新屋區', '桃園市');

-- 台中市的區（獨有）
INSERT INTO district_to_city VALUES
  ('北屯區', '台中市'), ('西屯區', '台中市'), ('南屯區', '台中市'),
  ('太平區', '台中市'), ('大里區', '台中市'), ('霧峰區', '台中市'), ('烏日區', '台中市'),
  ('豐原區', '台中市'), ('后里區', '台中市'), ('石岡區', '台中市'),
  ('新社區', '台中市'), ('潭子區', '台中市'), ('大雅區', '台中市'),
  ('神岡區', '台中市'), ('大肚區', '台中市'), ('沙鹿區', '台中市'), ('龍井區', '台中市'),
  ('梧棲區', '台中市'), ('清水區', '台中市'), ('大甲區', '台中市'), ('外埔區', '台中市');

-- 台南市的區（獨有）
INSERT INTO district_to_city VALUES
  ('新營區', '台南市'), ('鹽水區', '台南市'), ('白河區', '台南市'), ('柳營區', '台南市'),
  ('後壁區', '台南市'), ('麻豆區', '台南市'), ('下營區', '台南市'),
  ('六甲區', '台南市'), ('官田區', '台南市'), ('大內區', '台南市'), ('佳里區', '台南市'),
  ('學甲區', '台南市'), ('西港區', '台南市'), ('七股區', '台南市'), ('將軍區', '台南市'),
  ('北門區', '台南市'), ('新化區', '台南市'), ('善化區', '台南市'), ('新市區', '台南市'),
  ('安定區', '台南市'), ('山上區', '台南市'), ('玉井區', '台南市'), ('楠西區', '台南市'),
  ('南化區', '台南市'), ('左鎮區', '台南市'), ('仁德區', '台南市'), ('歸仁區', '台南市'),
  ('關廟區', '台南市'), ('龍崎區', '台南市'), ('永康區', '台南市'),
  ('安南區', '台南市'), ('安平區', '台南市'), ('中西區', '台南市');

-- 高雄市的區（獨有）
INSERT INTO district_to_city VALUES
  ('楠梓區', '高雄市'), ('左營區', '高雄市'), ('鼓山區', '高雄市'), ('三民區', '高雄市'),
  ('鹽埕區', '高雄市'), ('前金區', '高雄市'), ('新興區', '高雄市'), ('苓雅區', '高雄市'),
  ('前鎮區', '高雄市'), ('旗津區', '高雄市'), ('小港區', '高雄市'), ('鳳山區', '高雄市'),
  ('林園區', '高雄市'), ('大寮區', '高雄市'), ('大樹區', '高雄市'), ('大社區', '高雄市'),
  ('仁武區', '高雄市'), ('鳥松區', '高雄市'), ('岡山區', '高雄市'), ('橋頭區', '高雄市'),
  ('燕巢區', '高雄市'), ('田寮區', '高雄市'), ('阿蓮區', '高雄市'), ('路竹區', '高雄市'),
  ('湖內區', '高雄市'), ('茄萣區', '高雄市'), ('彌陀區', '高雄市'),
  ('梓官區', '高雄市'), ('旗山區', '高雄市'), ('美濃區', '高雄市'), ('六龜區', '高雄市'),
  ('甲仙區', '高雄市'), ('杉林區', '高雄市'), ('內門區', '高雄市'), ('茂林區', '高雄市'),
  ('桃源區', '高雄市'), ('那瑪夏區', '高雄市');

-- 基隆市的區（獨有）
INSERT INTO district_to_city VALUES
  ('安樂區', '基隆市'), ('暖暖區', '基隆市'), ('七堵區', '基隆市');

-- 新竹市的區（獨有）
INSERT INTO district_to_city VALUES
  ('香山區', '新竹市');

-- 注意：以下區名在多個縣市重複，需要其他方式處理
-- 中正區：台北市、基隆市
-- 中山區：台北市、基隆市
-- 信義區：台北市、基隆市
-- 仁愛區：基隆市
-- 大安區：台北市、台中市
-- 東區：台中市、台南市、新竹市、嘉義市
-- 南區：台中市、台南市
-- 北區：台中市、台南市、新竹市
-- 西區：台中市、嘉義市
-- 中區：台中市
-- 東山區：台南市
-- 東勢區：台中市
-- 和平區：台中市
-- 復興區：桃園市
-- 永安區：高雄市

-- ============================================================
-- 更新 politicians 表：修正 region = village 的記錄
-- ============================================================

-- 先處理可以對應到區的資料
UPDATE politicians p
SET region = d.city
FROM district_to_city d
WHERE p.region = p.village  -- 只更新 region = village 的錯誤記錄
  AND p.sub_region = d.district;

-- 清理可能的亂碼區名（如 萬華�、文山�� 等）
UPDATE politicians
SET sub_region = REGEXP_REPLACE(sub_region, '[^\u4e00-\u9fff\u0000-\u007F]', '', 'g')
WHERE sub_region ~ '[^\u4e00-\u9fff\u0000-\u007F]';

-- ============================================================
-- 重新計算統計表
-- ============================================================

-- 定義有效的縣市列表
CREATE TEMP TABLE valid_cities (name TEXT PRIMARY KEY);
INSERT INTO valid_cities VALUES
  ('台北市'),('新北市'),('桃園市'),('台中市'),('台南市'),('高雄市'),
  ('基隆市'),('新竹市'),('嘉義市'),
  ('新竹縣'),('苗栗縣'),('彰化縣'),('南投縣'),('雲林縣'),('嘉義縣'),
  ('屏東縣'),('宜蘭縣'),('花蓮縣'),('台東縣'),('澎湖縣'),('金門縣'),('連江縣');

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
WHERE region IN (SELECT name FROM valid_cities)
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
WHERE region IN (SELECT name FROM valid_cities) AND sub_region IS NOT NULL
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
WHERE region IN (SELECT name FROM valid_cities) AND sub_region IS NOT NULL AND village IS NOT NULL
GROUP BY region, sub_region, village;

-- 4. 待確認統計
INSERT INTO politician_stats_by_region (
  region, sub_region, village,
  total_politicians, mayor_count, councilor_count,
  township_mayor_count, representative_count, village_chief_count
)
SELECT
  '待確認', NULL, NULL,
  COUNT(*),
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市長'),
  COUNT(*) FILTER (WHERE election_type::TEXT = '縣市議員'),
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市長', '直轄市山地原住民區長')),
  COUNT(*) FILTER (WHERE election_type::TEXT IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')),
  COUNT(*) FILTER (WHERE election_type::TEXT = '村里長')
FROM politicians
WHERE region NOT IN (SELECT name FROM valid_cities);
