-- 補號次任務帶上中選會選舉專區候選人 JSON（含 candNo 號次）（2026-10-31，維護者批准「作 A」）
--
-- 背景：2026 缺號次約 1,207 筆，其中約 982 筆在中選會選舉專區 JSON 已有 candNo；代理沒找到是因為任務的 hint_sources 只有選委會網站、公告頁、公報與 2022 例子。
--   info.cec.gov.tw/vote2026/static/json/ 是靜態檔（直接 GET 就是 JSON，不必跑 JS），欄位有 name、candNo、party、home、birth（村里長另有 liCode）。
-- 網址規則（前綴 https://info.cec.gov.tw/vote2026/static/json/cand/）：縣市長 C1/<縣市碼>.json；縣市議員 T/<縣市碼>.json；鄉鎮市長 D1/<縣市碼>.json；
--   直轄市山地原住民區長 D2/<縣市碼>.json；鄉鎮市民代表 R/<縣市碼>.json；直轄市山地原住民區民代表 R3/<縣市碼>.json；村里長 V1/<縣市碼>/<縣市碼><鄉鎮碼>.json（每鄉鎮一檔）。
--   縣市碼、鄉鎮碼取自 dist/prvCityDept.json（22 縣市、368 個鄉鎮市區），下面 INSERT 一次寫進對照表 cec_vote2026_codes（名稱臺→台正規化，跟派工單位的 county／unit_town 同寫法）。
--
-- 本檔三件事：
--   1. 對照表 cec_vote2026_codes＋函式 cec_vote2026_cand_url(選舉別, 縣市, 鄉鎮)：組出該單位的 JSON 網址（對不到就回 NULL，任務照舊不帶）；
--   2. contribution_auto_tasks_ballot_numbers 以 20261031090000 為底，只動三處（其餘一字不差）：target 多 cec_json_url、what_we_need 多一段「JSON 已含號次請以姓名對應」、
--      hint_sources 第一順位放這個網址（只有 2026 屆）；cand_no 與 cand_no_recheck 兩種都加。既有任務由 seed_auto_task_queue 下次執行時依內容變了才重寫（#465），不必另外 UPDATE；
--   3. 村里長 items 的 liCode：中選會 JSON 只給 liCode（村里序號），沒有村里名稱，對照表沒有「村里名→liCode」的來源，所以不附（代理用姓名＋birth 對，同名再看 liCode）。
-- 驗證者端（程式碼，不在這支）：cand_numbers 與帶號次 candidacy 的驗證票 current 多 cec_json_url，呼叫 cec_vote2026_cand_url。
-- 守門：supabase/functions/_shared/cec-json-hint.test.ts。

CREATE TABLE IF NOT EXISTS cec_vote2026_codes (
  county      TEXT NOT NULL,
  county_code TEXT NOT NULL,
  town        TEXT NOT NULL DEFAULT '',   -- 空字串＝縣市那一列
  town_code   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (county, town)
);
ALTER TABLE cec_vote2026_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cec_vote2026_codes_read ON cec_vote2026_codes;
CREATE POLICY cec_vote2026_codes_read ON cec_vote2026_codes FOR SELECT USING (true);
COMMENT ON TABLE cec_vote2026_codes IS '中選會選舉專區（info.cec.gov.tw/vote2026）的縣市碼與鄉鎮市區碼，取自 static/json/dist/prvCityDept.json；名稱臺→台正規化。town 空字串＝縣市列';

INSERT INTO cec_vote2026_codes (county, county_code, town, town_code) VALUES
('台北市', '63000', '', ''),
('台北市', '63000', '士林區', '110'),
('台北市', '63000', '北投區', '120'),
('台北市', '63000', '南港區', '090'),
('台北市', '63000', '內湖區', '100'),
('台北市', '63000', '松山區', '010'),
('台北市', '63000', '信義區', '020'),
('台北市', '63000', '中山區', '040'),
('台北市', '63000', '大同區', '060'),
('台北市', '63000', '中正區', '050'),
('台北市', '63000', '萬華區', '070'),
('台北市', '63000', '大安區', '030'),
('台北市', '63000', '文山區', '080'),
('新北市', '65000', '', ''),
('新北市', '65000', '淡水區', '100'),
('新北市', '65000', '三芝區', '210'),
('新北市', '65000', '石門區', '220'),
('新北市', '65000', '八里區', '230'),
('新北市', '65000', '五股區', '150'),
('新北市', '65000', '泰山區', '160'),
('新北市', '65000', '林口區', '170'),
('新北市', '65000', '新莊區', '050'),
('新北市', '65000', '三重區', '020'),
('新北市', '65000', '蘆洲區', '140'),
('新北市', '65000', '板橋區', '010'),
('新北市', '65000', '中和區', '030'),
('新北市', '65000', '永和區', '040'),
('新北市', '65000', '樹林區', '070'),
('新北市', '65000', '鶯歌區', '080'),
('新北市', '65000', '三峽區', '090'),
('新北市', '65000', '土城區', '130'),
('新北市', '65000', '新店區', '060'),
('新北市', '65000', '深坑區', '180'),
('新北市', '65000', '石碇區', '190'),
('新北市', '65000', '坪林區', '200'),
('新北市', '65000', '烏來區', '290'),
('新北市', '65000', '瑞芳區', '120'),
('新北市', '65000', '平溪區', '240'),
('新北市', '65000', '雙溪區', '250'),
('新北市', '65000', '貢寮區', '260'),
('新北市', '65000', '汐止區', '110'),
('新北市', '65000', '金山區', '270'),
('新北市', '65000', '萬里區', '280'),
('桃園市', '68000', '', ''),
('桃園市', '68000', '桃園區', '010'),
('桃園市', '68000', '復興區', '130'),
('桃園市', '68000', '龜山區', '070'),
('桃園市', '68000', '八德區', '080'),
('桃園市', '68000', '蘆竹區', '050'),
('桃園市', '68000', '大園區', '060'),
('桃園市', '68000', '大溪區', '030'),
('桃園市', '68000', '中壢區', '020'),
('桃園市', '68000', '平鎮區', '100'),
('桃園市', '68000', '楊梅區', '040'),
('桃園市', '68000', '龍潭區', '090'),
('桃園市', '68000', '新屋區', '110'),
('桃園市', '68000', '觀音區', '120'),
('台中市', '66000', '', ''),
('台中市', '66000', '大甲區', '110'),
('台中市', '66000', '外埔區', '210'),
('台中市', '66000', '大安區', '220'),
('台中市', '66000', '清水區', '120'),
('台中市', '66000', '沙鹿區', '130'),
('台中市', '66000', '梧棲區', '140'),
('台中市', '66000', '烏日區', '230'),
('台中市', '66000', '大肚區', '240'),
('台中市', '66000', '龍井區', '250'),
('台中市', '66000', '豐原區', '090'),
('台中市', '66000', '后里區', '150'),
('台中市', '66000', '神岡區', '160'),
('台中市', '66000', '潭子區', '170'),
('台中市', '66000', '大雅區', '180'),
('台中市', '66000', '西屯區', '060'),
('台中市', '66000', '南屯區', '070'),
('台中市', '66000', '北屯區', '080'),
('台中市', '66000', '北區', '050'),
('台中市', '66000', '中區', '010'),
('台中市', '66000', '西區', '040'),
('台中市', '66000', '東區', '020'),
('台中市', '66000', '南區', '030'),
('台中市', '66000', '太平區', '270'),
('台中市', '66000', '霧峰區', '260'),
('台中市', '66000', '大里區', '280'),
('台中市', '66000', '東勢區', '100'),
('台中市', '66000', '新社區', '190'),
('台中市', '66000', '石岡區', '200'),
('台中市', '66000', '和平區', '290'),
('台南市', '67000', '', ''),
('台南市', '67000', '新營區', '010'),
('台南市', '67000', '鹽水區', '020'),
('台南市', '67000', '白河區', '030'),
('台南市', '67000', '柳營區', '040'),
('台南市', '67000', '後壁區', '050'),
('台南市', '67000', '東山區', '060'),
('台南市', '67000', '佳里區', '120'),
('台南市', '67000', '學甲區', '130'),
('台南市', '67000', '西港區', '140'),
('台南市', '67000', '七股區', '150'),
('台南市', '67000', '將軍區', '160'),
('台南市', '67000', '北門區', '170'),
('台南市', '67000', '麻豆區', '070'),
('台南市', '67000', '下營區', '080'),
('台南市', '67000', '六甲區', '090'),
('台南市', '67000', '官田區', '100'),
('台南市', '67000', '大內區', '110'),
('台南市', '67000', '玉井區', '230'),
('台南市', '67000', '楠西區', '240'),
('台南市', '67000', '南化區', '250'),
('台南市', '67000', '左鎮區', '260'),
('台南市', '67000', '新化區', '180'),
('台南市', '67000', '善化區', '190'),
('台南市', '67000', '新市區', '200'),
('台南市', '67000', '安定區', '210'),
('台南市', '67000', '山上區', '220'),
('台南市', '67000', '安南區', '350'),
('台南市', '67000', '永康區', '310'),
('台南市', '67000', '北區', '340'),
('台南市', '67000', '中西區', '370'),
('台南市', '67000', '南區', '330'),
('台南市', '67000', '安平區', '360'),
('台南市', '67000', '東區', '320'),
('台南市', '67000', '仁德區', '270'),
('台南市', '67000', '歸仁區', '280'),
('台南市', '67000', '關廟區', '290'),
('台南市', '67000', '龍崎區', '300'),
('高雄市', '64000', '', ''),
('高雄市', '64000', '旗山區', '300'),
('高雄市', '64000', '美濃區', '310'),
('高雄市', '64000', '六龜區', '320'),
('高雄市', '64000', '甲仙區', '330'),
('高雄市', '64000', '杉林區', '340'),
('高雄市', '64000', '內門區', '350'),
('高雄市', '64000', '茂林區', '360'),
('高雄市', '64000', '桃源區', '370'),
('高雄市', '64000', '那瑪夏區', '380'),
('高雄市', '64000', '田寮區', '220'),
('高雄市', '64000', '阿蓮區', '230'),
('高雄市', '64000', '路竹區', '240'),
('高雄市', '64000', '湖內區', '250'),
('高雄市', '64000', '茄萣區', '260'),
('高雄市', '64000', '岡山區', '190'),
('高雄市', '64000', '橋頭區', '200'),
('高雄市', '64000', '燕巢區', '210'),
('高雄市', '64000', '永安區', '270'),
('高雄市', '64000', '彌陀區', '280'),
('高雄市', '64000', '梓官區', '290'),
('高雄市', '64000', '左營區', '030'),
('高雄市', '64000', '楠梓區', '040'),
('高雄市', '64000', '大樹區', '150'),
('高雄市', '64000', '大社區', '160'),
('高雄市', '64000', '仁武區', '170'),
('高雄市', '64000', '鳥松區', '180'),
('高雄市', '64000', '鹽埕區', '010'),
('高雄市', '64000', '鼓山區', '020'),
('高雄市', '64000', '旗津區', '100'),
('高雄市', '64000', '三民區', '050'),
('高雄市', '64000', '新興區', '060'),
('高雄市', '64000', '前金區', '070'),
('高雄市', '64000', '苓雅區', '080'),
('高雄市', '64000', '鳳山區', '120'),
('高雄市', '64000', '前鎮區', '090'),
('高雄市', '64000', '小港區', '110'),
('高雄市', '64000', '林園區', '130'),
('高雄市', '64000', '大寮區', '140'),
('新竹縣', '10004', '', ''),
('新竹縣', '10004', '新豐鄉', '060'),
('新竹縣', '10004', '竹北市', '010'),
('新竹縣', '10004', '竹東鎮', '020'),
('新竹縣', '10004', '新埔鎮', '030'),
('新竹縣', '10004', '關西鎮', '040'),
('新竹縣', '10004', '湖口鄉', '050'),
('新竹縣', '10004', '芎林鄉', '070'),
('新竹縣', '10004', '橫山鄉', '080'),
('新竹縣', '10004', '北埔鄉', '090'),
('新竹縣', '10004', '寶山鄉', '100'),
('新竹縣', '10004', '峨眉鄉', '110'),
('新竹縣', '10004', '尖石鄉', '120'),
('新竹縣', '10004', '五峰鄉', '130'),
('苗栗縣', '10005', '', ''),
('苗栗縣', '10005', '苗栗市', '010'),
('苗栗縣', '10005', '苑裡鎮', '020'),
('苗栗縣', '10005', '通霄鎮', '030'),
('苗栗縣', '10005', '竹南鎮', '040'),
('苗栗縣', '10005', '頭份市', '050'),
('苗栗縣', '10005', '後龍鎮', '060'),
('苗栗縣', '10005', '卓蘭鎮', '070'),
('苗栗縣', '10005', '大湖鄉', '080'),
('苗栗縣', '10005', '公館鄉', '090'),
('苗栗縣', '10005', '銅鑼鄉', '100'),
('苗栗縣', '10005', '南庄鄉', '110'),
('苗栗縣', '10005', '頭屋鄉', '120'),
('苗栗縣', '10005', '三義鄉', '130'),
('苗栗縣', '10005', '西湖鄉', '140'),
('苗栗縣', '10005', '造橋鄉', '150'),
('苗栗縣', '10005', '三灣鄉', '160'),
('苗栗縣', '10005', '獅潭鄉', '170'),
('苗栗縣', '10005', '泰安鄉', '180'),
('彰化縣', '10007', '', ''),
('彰化縣', '10007', '彰化市', '010'),
('彰化縣', '10007', '鹿港鎮', '020'),
('彰化縣', '10007', '和美鎮', '030'),
('彰化縣', '10007', '線西鄉', '040'),
('彰化縣', '10007', '伸港鄉', '050'),
('彰化縣', '10007', '福興鄉', '060'),
('彰化縣', '10007', '秀水鄉', '070'),
('彰化縣', '10007', '花壇鄉', '080'),
('彰化縣', '10007', '芬園鄉', '090'),
('彰化縣', '10007', '員林市', '100'),
('彰化縣', '10007', '溪湖鎮', '110'),
('彰化縣', '10007', '田中鎮', '120'),
('彰化縣', '10007', '大村鄉', '130'),
('彰化縣', '10007', '埔鹽鄉', '140'),
('彰化縣', '10007', '埔心鄉', '150'),
('彰化縣', '10007', '永靖鄉', '160'),
('彰化縣', '10007', '社頭鄉', '170'),
('彰化縣', '10007', '二水鄉', '180'),
('彰化縣', '10007', '北斗鎮', '190'),
('彰化縣', '10007', '二林鎮', '200'),
('彰化縣', '10007', '田尾鄉', '210'),
('彰化縣', '10007', '埤頭鄉', '220'),
('彰化縣', '10007', '芳苑鄉', '230'),
('彰化縣', '10007', '大城鄉', '240'),
('彰化縣', '10007', '竹塘鄉', '250'),
('彰化縣', '10007', '溪州鄉', '260'),
('南投縣', '10008', '', ''),
('南投縣', '10008', '南投市', '010'),
('南投縣', '10008', '名間鄉', '060'),
('南投縣', '10008', '草屯鎮', '030'),
('南投縣', '10008', '中寮鄉', '080'),
('南投縣', '10008', '集集鎮', '050'),
('南投縣', '10008', '魚池鄉', '090'),
('南投縣', '10008', '水里鄉', '110'),
('南投縣', '10008', '信義鄉', '120'),
('南投縣', '10008', '竹山鎮', '040'),
('南投縣', '10008', '鹿谷鄉', '070'),
('南投縣', '10008', '埔里鎮', '020'),
('南投縣', '10008', '國姓鄉', '100'),
('南投縣', '10008', '仁愛鄉', '130'),
('雲林縣', '10009', '', ''),
('雲林縣', '10009', '斗六市', '010'),
('雲林縣', '10009', '斗南鎮', '020'),
('雲林縣', '10009', '虎尾鎮', '030'),
('雲林縣', '10009', '西螺鎮', '040'),
('雲林縣', '10009', '土庫鎮', '050'),
('雲林縣', '10009', '北港鎮', '060'),
('雲林縣', '10009', '古坑鄉', '070'),
('雲林縣', '10009', '大埤鄉', '080'),
('雲林縣', '10009', '莿桐鄉', '090'),
('雲林縣', '10009', '林內鄉', '100'),
('雲林縣', '10009', '二崙鄉', '110'),
('雲林縣', '10009', '崙背鄉', '120'),
('雲林縣', '10009', '麥寮鄉', '130'),
('雲林縣', '10009', '東勢鄉', '140'),
('雲林縣', '10009', '褒忠鄉', '150'),
('雲林縣', '10009', '台西鄉', '160'),
('雲林縣', '10009', '元長鄉', '170'),
('雲林縣', '10009', '四湖鄉', '180'),
('雲林縣', '10009', '口湖鄉', '190'),
('雲林縣', '10009', '水林鄉', '200'),
('嘉義縣', '10010', '', ''),
('嘉義縣', '10010', '太保市', '010'),
('嘉義縣', '10010', '朴子市', '020'),
('嘉義縣', '10010', '布袋鎮', '030'),
('嘉義縣', '10010', '大林鎮', '040'),
('嘉義縣', '10010', '民雄鄉', '050'),
('嘉義縣', '10010', '溪口鄉', '060'),
('嘉義縣', '10010', '新港鄉', '070'),
('嘉義縣', '10010', '六腳鄉', '080'),
('嘉義縣', '10010', '東石鄉', '090'),
('嘉義縣', '10010', '義竹鄉', '100'),
('嘉義縣', '10010', '鹿草鄉', '110'),
('嘉義縣', '10010', '水上鄉', '120'),
('嘉義縣', '10010', '中埔鄉', '130'),
('嘉義縣', '10010', '竹崎鄉', '140'),
('嘉義縣', '10010', '梅山鄉', '150'),
('嘉義縣', '10010', '番路鄉', '160'),
('嘉義縣', '10010', '大埔鄉', '170'),
('嘉義縣', '10010', '阿里山鄉', '180'),
('屏東縣', '10013', '', ''),
('屏東縣', '10013', '屏東市', '010'),
('屏東縣', '10013', '潮州鎮', '020'),
('屏東縣', '10013', '東港鎮', '030'),
('屏東縣', '10013', '恆春鎮', '040'),
('屏東縣', '10013', '萬丹鄉', '050'),
('屏東縣', '10013', '長治鄉', '060'),
('屏東縣', '10013', '麟洛鄉', '070'),
('屏東縣', '10013', '九如鄉', '080'),
('屏東縣', '10013', '里港鄉', '090'),
('屏東縣', '10013', '鹽埔鄉', '100'),
('屏東縣', '10013', '高樹鄉', '110'),
('屏東縣', '10013', '萬巒鄉', '120'),
('屏東縣', '10013', '內埔鄉', '130'),
('屏東縣', '10013', '竹田鄉', '140'),
('屏東縣', '10013', '新埤鄉', '150'),
('屏東縣', '10013', '枋寮鄉', '160'),
('屏東縣', '10013', '新園鄉', '170'),
('屏東縣', '10013', '崁頂鄉', '180'),
('屏東縣', '10013', '林邊鄉', '190'),
('屏東縣', '10013', '南州鄉', '200'),
('屏東縣', '10013', '佳冬鄉', '210'),
('屏東縣', '10013', '琉球鄉', '220'),
('屏東縣', '10013', '車城鄉', '230'),
('屏東縣', '10013', '滿州鄉', '240'),
('屏東縣', '10013', '枋山鄉', '250'),
('屏東縣', '10013', '三地門鄉', '260'),
('屏東縣', '10013', '霧台鄉', '270'),
('屏東縣', '10013', '瑪家鄉', '280'),
('屏東縣', '10013', '泰武鄉', '290'),
('屏東縣', '10013', '來義鄉', '300'),
('屏東縣', '10013', '春日鄉', '310'),
('屏東縣', '10013', '獅子鄉', '320'),
('屏東縣', '10013', '牡丹鄉', '330'),
('宜蘭縣', '10002', '', ''),
('宜蘭縣', '10002', '宜蘭市', '010'),
('宜蘭縣', '10002', '羅東鎮', '020'),
('宜蘭縣', '10002', '蘇澳鎮', '030'),
('宜蘭縣', '10002', '頭城鎮', '040'),
('宜蘭縣', '10002', '礁溪鄉', '050'),
('宜蘭縣', '10002', '壯圍鄉', '060'),
('宜蘭縣', '10002', '員山鄉', '070'),
('宜蘭縣', '10002', '冬山鄉', '080'),
('宜蘭縣', '10002', '五結鄉', '090'),
('宜蘭縣', '10002', '三星鄉', '100'),
('宜蘭縣', '10002', '大同鄉', '110'),
('宜蘭縣', '10002', '南澳鄉', '120'),
('花蓮縣', '10015', '', ''),
('花蓮縣', '10015', '花蓮市', '010'),
('花蓮縣', '10015', '鳳林鎮', '020'),
('花蓮縣', '10015', '玉里鎮', '030'),
('花蓮縣', '10015', '新城鄉', '040'),
('花蓮縣', '10015', '吉安鄉', '050'),
('花蓮縣', '10015', '壽豐鄉', '060'),
('花蓮縣', '10015', '光復鄉', '070'),
('花蓮縣', '10015', '豐濱鄉', '080'),
('花蓮縣', '10015', '瑞穗鄉', '090'),
('花蓮縣', '10015', '富里鄉', '100'),
('花蓮縣', '10015', '秀林鄉', '110'),
('花蓮縣', '10015', '萬榮鄉', '120'),
('花蓮縣', '10015', '卓溪鄉', '130'),
('台東縣', '10014', '', ''),
('台東縣', '10014', '蘭嶼鄉', '160'),
('台東縣', '10014', '台東市', '010'),
('台東縣', '10014', '成功鎮', '020'),
('台東縣', '10014', '關山鎮', '030'),
('台東縣', '10014', '卑南鄉', '040'),
('台東縣', '10014', '鹿野鄉', '050'),
('台東縣', '10014', '池上鄉', '060'),
('台東縣', '10014', '東河鄉', '070'),
('台東縣', '10014', '長濱鄉', '080'),
('台東縣', '10014', '太麻里鄉', '090'),
('台東縣', '10014', '大武鄉', '100'),
('台東縣', '10014', '綠島鄉', '110'),
('台東縣', '10014', '海端鄉', '120'),
('台東縣', '10014', '延平鄉', '130'),
('台東縣', '10014', '金峰鄉', '140'),
('台東縣', '10014', '達仁鄉', '150'),
('澎湖縣', '10016', '', ''),
('澎湖縣', '10016', '望安鄉', '050'),
('澎湖縣', '10016', '馬公市', '010'),
('澎湖縣', '10016', '湖西鄉', '020'),
('澎湖縣', '10016', '白沙鄉', '030'),
('澎湖縣', '10016', '西嶼鄉', '040'),
('澎湖縣', '10016', '七美鄉', '060'),
('基隆市', '10017', '', ''),
('基隆市', '10017', '中正區', '010'),
('基隆市', '10017', '信義區', '070'),
('基隆市', '10017', '仁愛區', '040'),
('基隆市', '10017', '中山區', '050'),
('基隆市', '10017', '安樂區', '060'),
('基隆市', '10017', '暖暖區', '030'),
('基隆市', '10017', '七堵區', '020'),
('新竹市', '10018', '', ''),
('新竹市', '10018', '東區', '010'),
('新竹市', '10018', '北區', '020'),
('新竹市', '10018', '香山區', '030'),
('嘉義市', '10020', '', ''),
('嘉義市', '10020', '東區', '010'),
('嘉義市', '10020', '西區', '020'),
('金門縣', '09020', '', ''),
('金門縣', '09020', '金城鎮', '010'),
('金門縣', '09020', '金沙鎮', '020'),
('金門縣', '09020', '金湖鎮', '030'),
('金門縣', '09020', '金寧鄉', '040'),
('金門縣', '09020', '烈嶼鄉', '050'),
('金門縣', '09020', '烏坵鄉', '060'),
('連江縣', '09007', '', ''),
('連江縣', '09007', '南竿鄉', '010'),
('連江縣', '09007', '北竿鄉', '020'),
('連江縣', '09007', '莒光鄉', '030'),
('連江縣', '09007', '東引鄉', '040')
ON CONFLICT (county, town) DO UPDATE SET county_code = EXCLUDED.county_code, town_code = EXCLUDED.town_code;

CREATE OR REPLACE FUNCTION cec_vote2026_cand_url(p_election_type TEXT, p_county TEXT, p_town TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_election_type = '村里長' THEN
             (SELECT 'https://info.cec.gov.tw/vote2026/static/json/cand/V1/' || c.county_code || '/' || c.county_code || t.town_code || '.json'
                FROM cec_vote2026_codes c JOIN cec_vote2026_codes t ON t.county = c.county AND t.town <> ''
               WHERE c.county = replace(p_county, '臺', '台') AND c.town = '' AND t.town = replace(p_town, '臺', '台'))
           ELSE
             (SELECT 'https://info.cec.gov.tw/vote2026/static/json/cand/'
                     || CASE p_election_type WHEN '縣市長' THEN 'C1' WHEN '縣市議員' THEN 'T' WHEN '鄉鎮市長' THEN 'D1' WHEN '直轄市山地原住民區長' THEN 'D2'
                                             WHEN '鄉鎮市民代表' THEN 'R' WHEN '直轄市山地原住民區民代表' THEN 'R3' END
                     || '/' || c.county_code || '.json'
                FROM cec_vote2026_codes c
               WHERE c.county = replace(p_county, '臺', '台') AND c.town = ''
                 AND p_election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表'))
         END
$$;
COMMENT ON FUNCTION cec_vote2026_cand_url IS '中選會選舉專區 2026 候選人 JSON 的網址（含 candNo）：七種選舉別各一種路徑；村里長要鄉鎮（每鄉鎮一檔）；縣市或鄉鎮對不到回 NULL。只對 2026 屆有意義';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH pending_batch AS MATERIALIZED (
    SELECT cb.payload->>'election_id' AS election_id, bi->>'politician_election_id' AS pe_id
      FROM contributions cb, jsonb_array_elements(CASE WHEN jsonb_typeof(cb.payload->'items') = 'array' THEN cb.payload->'items' ELSE '[]'::jsonb END) bi
     WHERE cb.contribution_type = 'cand_numbers' AND cb.status IN ('pending', 'verified')
  ),
  g_all AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.cand_no, p.id AS politician_id, p.name,
           -- 號次單位與正規化姓名（20261031090000）：排除「同單位同名不同人、對方已有號次」的列用（算法同 ballot_number_unit／同名人物配對）
           ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) AS unit,
           regexp_replace(regexp_replace(p.name, '[．·‧・•.\s]', '', 'g'), '臺', '台', 'g') AS nkey,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           -- 名單公告是一個鄉鎮一份的：鄉鎮市長、直轄市山地原住民區長、村里長、鄉鎮市民代表、直轄市山地原住民區民代表再細到鄉鎮市區
           -- （鄉鎮市長的參選紀錄多半還沒記到鄉鎮，r.sub_region 空＝留在縣市層級那一件，代理從公告上補 sub_region）
           -- 代表的 regions.sub_region 可能是「麥寮鄉第04選舉區」（#464）：派工單位照舊是鄉鎮，選舉區放 district
           CASE WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN NULLIF(regexp_replace(r.sub_region, '(第[0-9]+)?選舉區$', ''), '')
                WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長') THEN r.sub_region END AS unit_town,
           -- 縣市議員的 regions.sub_region 存的是選舉區（第NN選舉區）；代表的選舉區取尾巴的「第NN選舉區」
           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region
                WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN substring(r.sub_region from '第[0-9]+選舉區$') END AS district,
           CASE WHEN pe.election_type = '村里長' THEN r.village END AS village
      FROM politician_elections pe
      -- 抽籤之後、投票日以前才派：窗口（起點）由規則決定（activity_rules「ballot_numbers」：draw +0 起、polling +0 止，補號次 20261008150000）；
      -- 這裡的 election_date 只是效能預篩（已投票的屆別不算，不然 seed 每 10 分鐘要掃全部歷史），不是第二份窗口。
      -- 投票日隔天還要算（- 1）：規則的窗口在隔天才關，seed 要看得到「臂還算得出來、窗口關了」才會把收回記成 window，不是 filled
      JOIN elections e ON e.id = pe.election_id AND e.election_date >= activity_today() - 1
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.candidacy_status = 'filed' AND pe.election_type IS NOT NULL AND COALESCE(r.region, p.region) IS NOT NULL
  ),
  ranked AS (
    SELECT g.*,
           (row_number() OVER w - 1) / 50 + 1 AS part,
           (count(*) OVER (PARTITION BY g.election_id, g.election_type, g.county, g.unit_town) - 1) / 50 + 1 AS parts
      FROM g_all g
    WINDOW w AS (PARTITION BY g.election_id, g.election_type, g.county, g.unit_town
                 ORDER BY g.district NULLS LAST, g.village NULLS LAST, g.name, g.pe_id)
  ),
  numbered AS (
    SELECT rk.*
      FROM ranked rk
     WHERE rk.cand_no IS NULL
       -- 整批交件（cand_numbers，#781）還在等票（pending／verified）而且 items 涵蓋他的先不派（退件了就會再派；落庫時被標錯或同號的列沒寫，缺口還在就會重派）；
       -- 等票中的整批在 pending_batch 只算一次（雜湊反連接），不是每個候選列各展開一遍
       AND NOT EXISTS (SELECT 1 FROM pending_batch pb WHERE pb.election_id = rk.election_id::TEXT AND pb.pe_id = rk.pe_id::TEXT)
       -- 同一個選舉、同一個號次單位裡有同名（正規化）的另一個人物、而對方已有號次：這一列多半是同一位候選人被建成兩筆人物，
       -- 抄公告也補不上（補上去會撞「與已上線他人同號」）。先不派，等 duplicate_politician 合併任務處理（合併後同一人只剩一列）
       AND NOT EXISTS (SELECT 1 FROM g_all o
                        WHERE o.election_id = rk.election_id AND o.election_type = rk.election_type AND o.unit = rk.unit AND o.nkey = rk.nkey
                          AND o.cand_no IS NOT NULL AND o.politician_id <> rk.politician_id AND rk.unit IS NOT NULL)
       -- 已經有人交了這一人這一屆帶號次的 candidacy、還在等票（pending／verified）的先不派（退件了就會再派）；
       -- 交件可以只給姓名、沒給 politician_id（協議允許）：沒給的用姓名＋選舉別＋縣市對
       AND NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'election_id' = rk.election_id::TEXT AND c.payload->>'cand_no' IS NOT NULL
                          AND (c.payload->>'politician_id' = rk.politician_id::TEXT
                               OR (NULLIF(c.payload->>'politician_id', '') IS NULL AND btrim(c.payload->>'name') = rk.name
                                   AND c.payload->>'election_type' = rk.election_type
                                   AND replace(COALESCE(c.payload->>'region', rk.county), '臺', '台') = rk.county)))
  ),
  grouped AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts, count(*) AS items_count, bool_or(n.district IS NOT NULL) AS has_district,
           jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'politician_election_id', n.pe_id, 'politician_id', n.politician_id, 'name', n.name,
             'electoral_district', n.district, 'sub_region', n.unit_town, 'village', n.village))
             ORDER BY n.district NULLS LAST, n.village NULLS LAST, n.name, n.pe_id) AS items
      FROM numbered n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  ),
  u AS (
    SELECT gr.*, e.election_date,
           (SELECT m.on_date FROM election_milestones_all m
             WHERE m.election_id = gr.election_id AND m.kind = 'draw' AND (m.election_type = gr.election_type OR m.election_type IS NULL)
             ORDER BY m.election_type NULLS LAST LIMIT 1) AS draw_on,
           (SELECT m.on_date FROM election_milestones_all m
             WHERE m.election_id = gr.election_id AND m.kind = 'list_published' AND (m.election_type = gr.election_type OR m.election_type IS NULL)
             ORDER BY m.election_type NULLS LAST LIMIT 1) AS list_on,
           -- candidate_status＝交件協議的詞（名單公告前 registered、公告後 qualified），由 candidacy_status 換算，不是舊欄位
           candidacy_protocol_status('filed', candidacy_list_published(gr.election_id, gr.election_type, CURRENT_DATE)) AS candidate_status,
           -- 中選會選舉專區的候選人 JSON（含 candNo）：只有 2026 年這一屆有（static/json 路徑是 vote2026）
           CASE WHEN gr.election_id = 2026 THEN cec_vote2026_cand_url(gr.election_type, gr.county, gr.unit_town) END AS cec_url
      FROM grouped gr
      JOIN elections e ON e.id = gr.election_id
  ),
  -- 重複與跳號的重查：號次單位的名次先算在派工單位的全部號次單位上，再留下有問題的（kind 有值），一件最多 25 個號次單位
  ru AS (
    SELECT bu.*,
           CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END AS unit_town,
           (row_number() OVER w - 1) / 25 + 1 AS part,
           (count(*) OVER (PARTITION BY bu.election_id, bu.election_type, bu.county,
                           CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END) - 1) / 25 + 1 AS parts
      FROM ballot_number_units bu
    WINDOW w AS (PARTITION BY bu.election_id, bu.election_type, bu.county,
                              CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END
                 ORDER BY bu.unit)
  ),
  rn AS (
    SELECT ru.*, ballot_number_dups(ru.members) AS duplicates, ballot_number_missing(ru.registered, ru.numbered, ru.numbers) AS missing,
           CASE WHEN position('|' IN ru.unit) > 0 THEN replace(substr(ru.unit, position('|' IN ru.unit) + 1), '|', ' ') ELSE ru.county END AS label,
           (SELECT string_agg((t.m->>'name') || CASE WHEN t.m->>'cand_no' IS NOT NULL THEN '（' || (t.m->>'cand_no') || '號）' ELSE '（沒有號次）' END, '、' ORDER BY t.ord)
              FROM jsonb_array_elements(ru.members) WITH ORDINALITY AS t(m, ord)) AS who
      FROM ru
     WHERE ru.kind IS NOT NULL
  ),
  rg AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts, count(*) AS units_count,
           jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'unit', n.label, 'anomaly', n.kind, 'registered', n.registered, 'numbered', n.numbered,
             'duplicates', to_jsonb(n.duplicates), 'missing', to_jsonb(n.missing),
             'electoral_district', n.district, 'sub_region', n.town, 'village', n.village, 'members', n.members))
             ORDER BY n.unit) AS units,
           string_agg(n.label || '：' || CASE n.kind
                        WHEN 'duplicate' THEN '號次 ' || array_to_string(n.duplicates, '、') || ' 重複'
                                              || CASE WHEN cardinality(n.missing) > 0 THEN '，名單 ' || n.registered || ' 位都有號次卻缺 ' || array_to_string(n.missing, '、') ELSE '' END
                        ELSE '名單 ' || n.registered || ' 位都有號次，但號次不是 1 到 ' || n.registered || ' 連續，缺 ' || array_to_string(n.missing, '、') END
                      || '（' || n.who || '）', '；' ORDER BY n.unit) AS summary
      FROM rn n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  ),
  rc AS (
    SELECT rg.*, e.election_date,
           candidacy_protocol_status('filed', candidacy_list_published(rg.election_id, rg.election_type, CURRENT_DATE)) AS candidate_status,
           CASE WHEN rg.election_id = 2026 THEN cec_vote2026_cand_url(rg.election_type, rg.county, rg.unit_town) END AS cec_url
      FROM rg
      JOIN elections e ON e.id = rg.election_id
  )
  SELECT 'auto:candidacy_source_missing:cand_no:' || u.election_id || ':' || u.election_type || ':' || u.county
           || COALESCE(':' || u.unit_town, '') || CASE WHEN u.parts > 1 THEN ':p' || u.part ELSE '' END,
         'candidacy_source_missing',
         jsonb_strip_nulls(jsonb_build_object('kind', 'cand_no', 'election_id', u.election_id, 'election_type', u.election_type,
                            'region', u.county, 'sub_region', u.unit_town, 'election_date', u.election_date,
                            'draw_on', u.draw_on, 'list_on', u.list_on, 'candidate_status', u.candidate_status, 'cec_json_url', u.cec_url,
                            'missing', jsonb_build_array('cand_no'),
                            'part', u.part, 'parts', u.parts, 'items_count', u.items_count, 'items', u.items)),
         u.county || COALESCE(u.unit_town, '') || ' ' || u.election_id || ' ' || u.election_type || '：我們有 ' || u.items_count || ' 位已登記的參選人還沒有選票上的號次（cand_no）'
           || CASE WHEN u.parts > 1 THEN '（這個單位太大，拆成 ' || u.parts || ' 件，這是第 ' || u.part || ' 件）' ELSE '' END
           || '。號次是抽籤決定的（中選會預定 ' || COALESCE(u.draw_on::TEXT, '抽籤日') || ' 抽籤），抽完各縣市選舉委員會公告的候選人名單（預定 ' || COALESCE(u.list_on::TEXT, '名單公告日')
           || ' 前後公告）和選舉公報上都印著每個人的號次。號次是每個選舉區（村里長是每個村里、鄉鎮市長是每個鄉鎮）各自從 1 編起的，同一個單位不會有兩位同號。'
           || CASE WHEN u.cec_url IS NOT NULL THEN '**中選會選舉專區的候選人 JSON 已含號次（candNo），請以姓名對應**：' || u.cec_url || '（靜態 JSON，直接 GET 即可、不必跑 JS；每位有 name、candNo、party、home、birth' || CASE WHEN u.election_type = '村里長' THEN '、liCode（村里序號）' ELSE '' END || CASE WHEN u.election_type IN ('縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN '，議員與代表的檔依選舉區分組（各區的 cands），要連選舉區一起對' WHEN u.election_type = '村里長' THEN '，同名要連 birth 與 liCode 對' ELSE '，這一檔涵蓋整個縣市，請只取本件單位的人' END || '；這份 JSON 裡找不到的人再退回縣市選委會公告）。' ELSE '' END
           || '名單在 target.items：請到該縣市選舉委員會網站（web.cec.gov.tw/<縣市代碼>ec/）找候選人名單公告或抽籤結果，逐位核對姓名'
           || CASE u.election_type WHEN '縣市議員' THEN '與選舉區' WHEN '村里長' THEN '與村里' ELSE '' END
           || '，查得到號次的每位列進**一份** cand_numbers 交件（整個任務一份、不要一人一份 candidacy；contribution_type 填 cand_numbers，task_id 照這一件）：payload.election_id 填 ' || u.election_id || '、election_type 填「' || u.election_type
           || '」、region 填「' || u.county || '」'
           || CASE WHEN u.unit_town IS NOT NULL THEN '、sub_region 填「' || u.unit_town || '」'
                   WHEN u.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') THEN '、sub_region 填他所在的鄉鎮市區（公告是按鄉鎮分的）' ELSE '' END
           || '，payload.items 每位一列 {politician_election_id（照 target.items 的 politician_election_id）, cand_no（公告上的號次，正整數）}，最多 150 列；'
           || 'source_urls 第一個放你看到他號次的那一頁公告網址（縣市選委會的公告頁或選舉公報），不要放登記彙總表——它沒有號次，也不會被拿來核號次。'
           || '公告上找不到的人不要放進 items，不要猜、不要依名單順序推；公告還沒出來就先不要交。'
           || '驗證者只會開一次公告逐列核對：抄錯的列會被標出來、只退那幾列（其餘照過），不會整批作廢；落庫前系統也逐列檢查同一個號次單位裡有沒有同號，同號的列不寫、回到缺口重派。',
         CASE WHEN u.cec_url IS NOT NULL THEN ARRAY[u.cec_url || ' ← 中選會選舉專區候選人 JSON（含 candNo 號次，靜態檔直接 GET，以姓名對應）'] ELSE ARRAY[]::text[] END
         || ARRAY['https://web.cec.gov.tw/<縣市選委會代碼>ec/ ← 該縣市選舉委員會網站：「候選人名單公告」「抽籤結果」（2022 年的長相：https://web.cec.gov.tw/tyec/article/37003 ← 桃園市長名單，「（1）張善政（2）賴香伶…」括號裡就是號次）',
               'https://web.cec.gov.tw/central/article/20892 ← 中選會「各種選舉公告」，列出各縣市選委會的公告',
               'https://eebulletin.cec.gov.tw ← 選舉公報（11 月中旬後上架，每位候選人那一欄印著號次）',
               '村里長、代表：鄉鎮市區公所／縣市選委會的「候選人登記冊（含抽籤號次）」（2022 年苗栗縣選委會 10-21 當天就公布了逐里的抽籤號次表）'],
         1, u.county
    FROM u
  UNION ALL
  SELECT 'auto:candidacy_source_missing:cand_no_recheck:' || rc.election_id || ':' || rc.election_type || ':' || rc.county
           || COALESCE(':' || rc.unit_town, '') || CASE WHEN rc.parts > 1 THEN ':p' || rc.part ELSE '' END,
         'candidacy_source_missing',
         jsonb_strip_nulls(jsonb_build_object('kind', 'cand_no_recheck', 'election_id', rc.election_id, 'election_type', rc.election_type,
                            'region', rc.county, 'sub_region', rc.unit_town, 'election_date', rc.election_date, 'candidate_status', rc.candidate_status, 'cec_json_url', rc.cec_url,
                            'missing', jsonb_build_array('cand_no'),
                            'part', rc.part, 'parts', rc.parts, 'units_count', rc.units_count, 'units', rc.units)),
         rc.county || COALESCE(rc.unit_town, '') || ' ' || rc.election_id || ' ' || rc.election_type || '：有 ' || rc.units_count || ' 個號次單位的號次對不起來，請對公告重查'
           || CASE WHEN rc.parts > 1 THEN '（拆成 ' || rc.parts || ' 件，這是第 ' || rc.part || ' 件）' ELSE '' END
           || '。' || rc.summary || '。'
           || '號次是每個選舉區（村里長是每個村里、鄉鎮市長是每個鄉鎮）各自從 1 編起的：同一個單位出現同號＝至少一位的號次抄錯了；名單到齊、號次卻不是 1 到 N 連續＝有號次抄錯，或公告上有人我們名單沒有。'
           || CASE WHEN rc.cec_url IS NOT NULL THEN '**中選會選舉專區的候選人 JSON 已含號次（candNo），請以姓名對應**：' || rc.cec_url || '（靜態 JSON，直接 GET 即可、不必跑 JS；每位有 name、candNo、party、home、birth' || CASE WHEN rc.election_type = '村里長' THEN '、liCode（村里序號）' ELSE '' END || CASE WHEN rc.election_type IN ('縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN '，議員與代表的檔依選舉區分組（各區的 cands），要連選舉區一起對' WHEN rc.election_type = '村里長' THEN '，同名要連 birth 與 liCode 對' ELSE '，這一檔涵蓋整個縣市，請只取本件單位的人' END || '；這份 JSON 裡找不到的人再退回縣市選委會公告）。' ELSE '' END
           || '每個單位的成員與目前記的號次在 target.units[].members。請打開該單位的候選人名單公告或選舉公報逐位核對：'
           || '①我們記錯的，用 candidacy 重交那一位（politician_id、name、election_id、election_type、region 照 target，sub_region／village／electoral_district 照 target.units，cand_no 填公告上的號次，candidate_status 填「'
           || COALESCE(rc.candidate_status, '') || '」），只交跟公告不同的；②公告上有、我們名單沒有的人，用 candidacy 補進來（附同一份公告）；'
           || '③公告本身就跳號（候選人退選或資格不符、號次沒有遞補）而我們的號次都跟公告一致，用 no_change（outcome 填 confirmed）回報，finding 寫公告上的號次與頁碼。'
           || '公告還沒出來就略過這一件，不要回 no_change not_found（14 天內不再派）。',
         CASE WHEN rc.cec_url IS NOT NULL THEN ARRAY[rc.cec_url || ' ← 中選會選舉專區候選人 JSON（含 candNo 號次，靜態檔直接 GET，以姓名對應）'] ELSE ARRAY[]::text[] END
         || ARRAY['https://web.cec.gov.tw/<縣市選委會代碼>ec/ ← 該縣市選舉委員會網站：「候選人名單公告」「抽籤結果」',
               'https://eebulletin.cec.gov.tw ← 選舉公報（每位候選人那一欄印著號次）',
               '村里長、代表：鄉鎮市區公所／縣市選委會的「候選人登記冊（含抽籤號次）」'],
         1, rc.county
    FROM rc
$$;

COMMENT ON FUNCTION contribution_auto_tasks_ballot_numbers IS
  '補號次（2026-10-08；#464 代表選舉區；#781 整批交件，2026-10-30）：已登記（candidacy_status＝filed）、沒有號次的參選紀錄，依單位（屆別×選舉別×縣市；鄉鎮市長、區長、村里長與代表到鄉鎮市區；超過 50 位拆件）整批派 candidacy_source_missing（target.kind＝cand_no），代理一件交一份 cand_numbers（items 每位一列）；等票中的 candidacy／cand_numbers 涵蓋的人不重複派；同號次單位同名不同人且對方已有號次的列不派（交合併任務，20261031090000）；另把號次單位的重複與跳號照派工單位聚成 cand_no_recheck。';

-- cand_no_front_pull：補號次缺口任務的 no_change 驗證票也插隊（3 × visitor_front_seconds）（2026-10-31，維護者批准）
--   235 個缺口任務有 228 個被代理先前交的 no_change（找不到號次）擋住，這些 no_change 驗證票沒有插隊、排在後面（近 6 小時才驗 76 票）。
--   只改缺口任務的 hint 沒用——任務被擋住不會再派。驗證端的 hint 會附中選會 JSON，JSON 已有該單位的 candNo 就投 disagree；disagree 後缺口解除、帶新 hint 重派。
--   以 20261031090000 的定義為底，只多 no_change 一種驗證票（其餘一字不差）。
CREATE OR REPLACE FUNCTION cand_no_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER; v_boost BIGINT; v_top BIGINT; v_seq BIGINT; v_cur TEXT;
BEGIN
  IF activity_today() > DATE '2026-11-28' THEN RETURN 0; END IF;
  SELECT 2 * q.visitor_front_seconds, 3 * q.visitor_front_seconds, 5 * q.visitor_front_seconds / 2
    INTO v_boost, v_top, v_seq FROM queue_settings q WHERE q.id = 1;
  IF v_boost IS NULL OR v_boost <= 0 THEN RETURN 0; END IF;
  -- 當前提前職位：依序清單中第一個還有號次缺口列的職位
  SELECT s.et INTO v_cur
    FROM unnest(ARRAY['鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']) WITH ORDINALITY AS s(et, ord)
   WHERE EXISTS (SELECT 1 FROM task_dispatches t WHERE t.target->>'kind' = 'cand_no' AND t.target->>'election_type' = s.et)
   ORDER BY s.ord LIMIT 1;
  UPDATE task_dispatches d
     SET boost_seconds = x.want, cooling = false
    FROM (
      SELECT d2.task_id,
             CASE WHEN d2.target->>'cand_no_gap' = 'true' THEN v_top   -- 擋住號次缺口的同名人物合併任務（contribution_auto_tasks_dup 的 target.cand_no_gap）
                  WHEN d2.target->>'kind' = 'cand_no' THEN
                    CASE WHEN d2.target->>'election_type' IN ('縣市長', '縣市議員') THEN v_top
                         WHEN d2.target->>'election_type' = v_cur THEN v_seq
                         ELSE v_boost END
                  ELSE
                    (SELECT CASE WHEN c.contribution_type = 'no_change' THEN v_top   -- 補號次缺口的 no_change 驗證票：3 ×，快點驗掉
                                 WHEN c.payload->>'election_type' IN ('縣市長', '縣市議員') THEN v_top
                                 WHEN c.contribution_type = 'cand_numbers' AND c.payload->>'election_type' = v_cur THEN v_seq
                                 ELSE v_boost END
                       FROM contributions c
                      WHERE d2.task_id = 'verify:' || c.id::text
                        AND c.status = 'pending'
                        AND ((c.contribution_type = 'candidacy' AND c.payload ? 'cand_no')
                             OR c.contribution_type = 'cand_numbers'
                             -- 補號次缺口任務的 no_change（「找不到號次」）：任務被它擋住（冷卻）、驗證票沒插隊排在後面，驗掉才會解除並帶新 hint 重派（2026-10-31）
                             OR (c.contribution_type = 'no_change' AND c.payload->>'task_id' LIKE 'auto:candidacy_source_missing:cand_no:%')))
             END AS want
        FROM task_dispatches d2
    ) x
   WHERE d.task_id = x.task_id
     AND x.want IS NOT NULL
     AND d.boost_seconds < x.want;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION cand_no_front_pull IS '號次的缺口列與等票的驗證列（單人 candidacy 帶 cand_no、整批 cand_numbers 都算），插隊秒數至少拉到 2 × visitor_front_seconds；縣市長、縣市議員 3 ×；依序清單（鄉鎮市長→山地原住民區長→鄉鎮市民代表→山地原住民區民代表→村里長）中第一個還有缺口列的職位拉到 2.5 ×；擋住號次缺口的同名人物合併任務（target.cand_no_gap）3 ×；pg_cron 每小時第 3 分；2026-11-28 之後不做事（2026-10-31）';
