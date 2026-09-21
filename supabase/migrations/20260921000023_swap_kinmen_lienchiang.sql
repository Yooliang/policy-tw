-- 金門縣／連江縣在系統表裡整批對調回來（使用者 2026-09-21 裁示 #12a）。
--
-- 根因：fetch-cec-data 與 AdminScraper.vue 的縣市代碼把 09_007／09_020 配反（程式已修，#158）。
-- 證據是那支自己抓回來的鄉鎮：007 回南竿北竿莒光東引（馬祖），020 回金城金寧金沙金湖烈嶼烏坵（金門）。
-- 影響（leatherback 全查完，187 筆兩縣政治人物）：
--   村里長、鄉鎮市長（sub_region 是鄉鎮）118 筆全對；縣市長、立委 22 筆全對；
--   縣市議員 47 筆全錯（32 標連江實為金門、15 標金門實為連江）——唯一走選舉區對照表那條路的一類。
--   結構指紋：標成金門的那批橫跨第01～04（連江的結構），標成連江的只有第01～03（金門的結構），光看選舉區個數就能發現。
-- 這 47 筆 politicians.region 已由代理走貢獻流程提更正（32＋15 筆 correction），這支不碰 politicians。
-- 這支只動協議管不到的系統表：electoral_district_areas（10 列）與 regions 的選舉區層級列（7 列）。
-- regions 的鄉鎮層級列本來就是對的（366 金門縣金城鎮、871 連江縣北竿鄉），不動。
--
-- 對調要過 UNIQUE (region, sub_region, village)，兩邊直接互換會在語句中途撞唯一鍵，所以走暫時值。

UPDATE electoral_district_areas SET region = '__swap__' WHERE region = '金門縣';
UPDATE electoral_district_areas SET region = '金門縣' WHERE region = '連江縣';
UPDATE electoral_district_areas SET region = '連江縣' WHERE region = '__swap__';

UPDATE regions SET region = '__swap__' WHERE region = '金門縣' AND village IS NULL AND sub_region LIKE '第%選舉區';
UPDATE regions SET region = '金門縣' WHERE region = '連江縣' AND village IS NULL AND sub_region LIKE '第%選舉區';
UPDATE regions SET region = '連江縣' WHERE region = '__swap__';

-- 自我檢查：對調後標金門的鄉鎮要是金門的，標連江的要是馬祖的；錯了整支 migration 回滾
DO $$
DECLARE bad INTEGER;
BEGIN
  SELECT count(*) INTO bad FROM electoral_district_areas
   WHERE (region = '金門縣' AND township IN ('南竿鄉','北竿鄉','莒光鄉','東引鄉'))
      OR (region = '連江縣' AND township IN ('金城鎮','金寧鄉','金沙鎮','金湖鎮','烈嶼鄉','烏坵鄉'));
  IF bad > 0 THEN RAISE EXCEPTION '金門／連江對調後仍有 % 列鄉鎮與縣市不符', bad; END IF;
  SELECT count(*) INTO bad FROM regions WHERE region = '__swap__';
  IF bad > 0 THEN RAISE EXCEPTION '暫時值沒清乾淨（% 列）', bad; END IF;
END $$;
