-- ============================================================
-- 修正 politicians 表中 region 欄位錯誤的資料
-- 將鄉鎮名稱正確對應到所屬縣市
-- ============================================================

-- 建立臨時的鄉鎮對應縣市對照表
CREATE TEMP TABLE township_to_city (
  township TEXT PRIMARY KEY,
  city TEXT NOT NULL
);

-- 屏東縣鄉鎮
INSERT INTO township_to_city VALUES
  ('屏東市', '屏東縣'), ('潮州鎮', '屏東縣'), ('東港鎮', '屏東縣'), ('恆春鎮', '屏東縣'),
  ('萬丹鄉', '屏東縣'), ('長治鄉', '屏東縣'), ('麟洛鄉', '屏東縣'), ('九如鄉', '屏東縣'),
  ('里港鄉', '屏東縣'), ('鹽埔鄉', '屏東縣'), ('高樹鄉', '屏東縣'), ('萬巒鄉', '屏東縣'),
  ('內埔鄉', '屏東縣'), ('竹田鄉', '屏東縣'), ('新埤鄉', '屏東縣'), ('枋寮鄉', '屏東縣'),
  ('新園鄉', '屏東縣'), ('崁頂鄉', '屏東縣'), ('林邊鄉', '屏東縣'), ('南州鄉', '屏東縣'),
  ('佳冬鄉', '屏東縣'), ('琉球鄉', '屏東縣'), ('車城鄉', '屏東縣'), ('滿州鄉', '屏東縣'),
  ('枋山鄉', '屏東縣'), ('三地門鄉', '屏東縣'), ('霧臺鄉', '屏東縣'), ('霧台鄉', '屏東縣'),
  ('瑪家鄉', '屏東縣'), ('泰武鄉', '屏東縣'), ('來義鄉', '屏東縣'), ('春日鄉', '屏東縣'),
  ('獅子鄉', '屏東縣'), ('牡丹鄉', '屏東縣');

-- 雲林縣鄉鎮
INSERT INTO township_to_city VALUES
  ('斗六市', '雲林縣'), ('斗南鎮', '雲林縣'), ('虎尾鎮', '雲林縣'), ('西螺鎮', '雲林縣'),
  ('土庫鎮', '雲林縣'), ('北港鎮', '雲林縣'), ('古坑鄉', '雲林縣'), ('大埤鄉', '雲林縣'),
  ('莿桐鄉', '雲林縣'), ('林內鄉', '雲林縣'), ('二崙鄉', '雲林縣'), ('崙背鄉', '雲林縣'),
  ('麥寮鄉', '雲林縣'), ('東勢鄉', '雲林縣'), ('褒忠鄉', '雲林縣'), ('臺西鄉', '雲林縣'),
  ('台西鄉', '雲林縣'), ('元長鄉', '雲林縣'), ('四湖鄉', '雲林縣'), ('口湖鄉', '雲林縣'),
  ('水林鄉', '雲林縣');

-- 彰化縣鄉鎮
INSERT INTO township_to_city VALUES
  ('彰化市', '彰化縣'), ('鹿港鎮', '彰化縣'), ('和美鎮', '彰化縣'), ('線西鄉', '彰化縣'),
  ('伸港鄉', '彰化縣'), ('福興鄉', '彰化縣'), ('秀水鄉', '彰化縣'), ('花壇鄉', '彰化縣'),
  ('芬園鄉', '彰化縣'), ('員林市', '彰化縣'), ('溪湖鎮', '彰化縣'), ('田中鎮', '彰化縣'),
  ('大村鄉', '彰化縣'), ('埔鹽鄉', '彰化縣'), ('埔心鄉', '彰化縣'), ('永靖鄉', '彰化縣'),
  ('社頭鄉', '彰化縣'), ('二水鄉', '彰化縣'), ('北斗鎮', '彰化縣'), ('二林鎮', '彰化縣'),
  ('田尾鄉', '彰化縣'), ('埤頭鄉', '彰化縣'), ('芳苑鄉', '彰化縣'), ('大城鄉', '彰化縣'),
  ('竹塘鄉', '彰化縣'), ('溪州鄉', '彰化縣');

-- 南投縣鄉鎮
INSERT INTO township_to_city VALUES
  ('南投市', '南投縣'), ('埔里鎮', '南投縣'), ('草屯鎮', '南投縣'), ('竹山鎮', '南投縣'),
  ('集集鎮', '南投縣'), ('名間鄉', '南投縣'), ('鹿谷鄉', '南投縣'), ('中寮鄉', '南投縣'),
  ('魚池鄉', '南投縣'), ('國姓鄉', '南投縣'), ('水里鄉', '南投縣'), ('信義鄉', '南投縣'),
  ('仁愛鄉', '南投縣');

-- 嘉義縣鄉鎮
INSERT INTO township_to_city VALUES
  ('太保市', '嘉義縣'), ('朴子市', '嘉義縣'), ('布袋鎮', '嘉義縣'), ('大林鎮', '嘉義縣'),
  ('民雄鄉', '嘉義縣'), ('溪口鄉', '嘉義縣'), ('新港鄉', '嘉義縣'), ('六腳鄉', '嘉義縣'),
  ('東石鄉', '嘉義縣'), ('義竹鄉', '嘉義縣'), ('鹿草鄉', '嘉義縣'), ('水上鄉', '嘉義縣'),
  ('中埔鄉', '嘉義縣'), ('竹崎鄉', '嘉義縣'), ('梅山鄉', '嘉義縣'), ('番路鄉', '嘉義縣'),
  ('大埔鄉', '嘉義縣'), ('阿里山鄉', '嘉義縣');

-- 苗栗縣鄉鎮
INSERT INTO township_to_city VALUES
  ('苗栗市', '苗栗縣'), ('頭份市', '苗栗縣'), ('竹南鎮', '苗栗縣'), ('後龍鎮', '苗栗縣'),
  ('通霄鎮', '苗栗縣'), ('苑裡鎮', '苗栗縣'), ('卓蘭鎮', '苗栗縣'), ('造橋鄉', '苗栗縣'),
  ('西湖鄉', '苗栗縣'), ('頭屋鄉', '苗栗縣'), ('公館鄉', '苗栗縣'), ('銅鑼鄉', '苗栗縣'),
  ('三義鄉', '苗栗縣'), ('大湖鄉', '苗栗縣'), ('獅潭鄉', '苗栗縣'), ('三灣鄉', '苗栗縣'),
  ('南庄鄉', '苗栗縣'), ('泰安鄉', '苗栗縣');

-- 新竹縣鄉鎮
INSERT INTO township_to_city VALUES
  ('竹北市', '新竹縣'), ('竹東鎮', '新竹縣'), ('新埔鎮', '新竹縣'), ('關西鎮', '新竹縣'),
  ('湖口鄉', '新竹縣'), ('新豐鄉', '新竹縣'), ('芎林鄉', '新竹縣'), ('橫山鄉', '新竹縣'),
  ('北埔鄉', '新竹縣'), ('寶山鄉', '新竹縣'), ('峨眉鄉', '新竹縣'), ('尖石鄉', '新竹縣'),
  ('五峰鄉', '新竹縣');

-- 宜蘭縣鄉鎮
INSERT INTO township_to_city VALUES
  ('宜蘭市', '宜蘭縣'), ('羅東鎮', '宜蘭縣'), ('蘇澳鎮', '宜蘭縣'), ('頭城鎮', '宜蘭縣'),
  ('礁溪鄉', '宜蘭縣'), ('壯圍鄉', '宜蘭縣'), ('員山鄉', '宜蘭縣'), ('冬山鄉', '宜蘭縣'),
  ('五結鄉', '宜蘭縣'), ('三星鄉', '宜蘭縣'), ('大同鄉', '宜蘭縣'), ('南澳鄉', '宜蘭縣');

-- 花蓮縣鄉鎮
INSERT INTO township_to_city VALUES
  ('花蓮市', '花蓮縣'), ('鳳林鎮', '花蓮縣'), ('玉里鎮', '花蓮縣'), ('新城鄉', '花蓮縣'),
  ('吉安鄉', '花蓮縣'), ('壽豐鄉', '花蓮縣'), ('光復鄉', '花蓮縣'), ('豐濱鄉', '花蓮縣'),
  ('瑞穗鄉', '花蓮縣'), ('富里鄉', '花蓮縣'), ('秀林鄉', '花蓮縣'), ('萬榮鄉', '花蓮縣'),
  ('卓溪鄉', '花蓮縣');

-- 台東縣鄉鎮
INSERT INTO township_to_city VALUES
  ('臺東市', '台東縣'), ('台東市', '台東縣'), ('成功鎮', '台東縣'), ('關山鎮', '台東縣'),
  ('卑南鄉', '台東縣'), ('大武鄉', '台東縣'), ('太麻里鄉', '台東縣'), ('東河鄉', '台東縣'),
  ('長濱鄉', '台東縣'), ('鹿野鄉', '台東縣'), ('池上鄉', '台東縣'), ('綠島鄉', '台東縣'),
  ('延平鄉', '台東縣'), ('海端鄉', '台東縣'), ('達仁鄉', '台東縣'), ('金峰鄉', '台東縣'),
  ('蘭嶼鄉', '台東縣');

-- 澎湖縣鄉鎮
INSERT INTO township_to_city VALUES
  ('馬公市', '澎湖縣'), ('湖西鄉', '澎湖縣'), ('白沙鄉', '澎湖縣'), ('西嶼鄉', '澎湖縣'),
  ('望安鄉', '澎湖縣'), ('七美鄉', '澎湖縣');

-- 金門縣鄉鎮
INSERT INTO township_to_city VALUES
  ('金城鎮', '金門縣'), ('金湖鎮', '金門縣'), ('金沙鎮', '金門縣'), ('金寧鄉', '金門縣'),
  ('烈嶼鄉', '金門縣'), ('烏坵鄉', '金門縣');

-- 連江縣鄉鎮
INSERT INTO township_to_city VALUES
  ('南竿鄉', '連江縣'), ('北竿鄉', '連江縣'), ('莒光鄉', '連江縣'), ('東引鄉', '連江縣');

-- ============================================================
-- 更新 politicians 表：將錯誤的 region 修正為正確的縣市
-- ============================================================

-- 更新那些 region 是鄉鎮名稱的記錄
UPDATE politicians p
SET region = t.city
FROM township_to_city t
WHERE p.region = t.township
  AND p.region NOT IN ('台北市','新北市','桃園市','台中市','台南市','高雄市',
                       '基隆市','新竹市','嘉義市','新竹縣','苗栗縣','彰化縣',
                       '南投縣','雲林縣','嘉義縣','屏東縣','宜蘭縣','花蓮縣',
                       '台東縣','澎湖縣','金門縣','連江縣');

-- ============================================================
-- 重新計算統計表（因為資料已修正）
-- ============================================================

-- 清空統計表
TRUNCATE politician_stats_by_region RESTART IDENTITY;

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
WHERE region IS NOT NULL AND sub_region IS NOT NULL
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
WHERE region IS NOT NULL AND sub_region IS NOT NULL AND village IS NOT NULL
GROUP BY region, sub_region, village;
