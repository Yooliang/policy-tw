-- 金門縣／連江縣（馬祖）縣市欄位對調的修正。
--
-- 2026-09-12 代理 a-zhen 回報 regions 表金門／連江錯置（task_suggestion，卡在票數不足）。
-- 實查之後，regions 只是影子：它的列是從 politicians 同步出來的，真正錯的是人物資料——
--   politicians 有 103 筆的 region 跟 sub_region 對不起來：
--     連江縣 ＋ 金城鎮／金沙鎮／金湖鎮／金寧鄉／烈嶼鄉／烏坵鄉   70 筆（其實是金門）
--     金門縣 ＋ 南竿鄉／北竿鄉／東引鄉／莒光鄉                  33 筆（其實是連江）
--   99 筆村里長、4 筆立法委員（含連江縣立委陳雪生被記成金門縣）。
--
-- 鄉鎮屬於哪個縣是客觀事實，不需要投票，所以直接修。判準只用鄉鎮名，
-- sub_region 是「第01選舉區」這種看不出縣市的一律不動（regions 裡還有 7 筆，留著）。
--
-- 三件事一起做，缺一不可：
--   1. 人物的 region 與 region_id（region_id 有外鍵，只改文字會指到錯的那一列）
--   2. politician_elections.region_id 同樣要跟著搬
--   3. regions 的統計整段重算——統計是 trigger 逐筆增減維護的，本來就會漂，
--      與其相信增減，不如就這兩縣從 politicians／policies 重新數一次

-- 鄉鎮 → 正確縣市。這份對照是內政部的行政區劃，不是推測。
CREATE TEMP TABLE township_county (sub_region TEXT PRIMARY KEY, region TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO township_county VALUES
  ('金城鎮','金門縣'),('金沙鎮','金門縣'),('金湖鎮','金門縣'),
  ('金寧鄉','金門縣'),('烈嶼鄉','金門縣'),('烏坵鄉','金門縣'),
  ('南竿鄉','連江縣'),('北竿鄉','連江縣'),('東引鄉','連江縣'),('莒光鄉','連江縣');

-- 每一筆該落在哪個縣市；「金門縣第01選區」這種選區字串看字首就知道
CREATE TEMP VIEW politician_fix AS
SELECT p.id,
       p.region AS old_region,
       COALESCE(tc.region,
                CASE WHEN p.sub_region LIKE '金門縣%' THEN '金門縣'
                     WHEN p.sub_region LIKE '連江縣%' THEN '連江縣' END) AS new_region,
       p.sub_region, p.village
FROM politicians p
LEFT JOIN township_county tc ON tc.sub_region = p.sub_region
WHERE p.region IN ('金門縣','連江縣');

-- 1. 正確的組合先確保 regions 有列（trigger 也會建，但 region_id 要先有對象可指）
INSERT INTO regions (region, sub_region, village)
SELECT DISTINCT f.new_region, NULL, NULL FROM politician_fix f WHERE f.new_region IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO regions (region, sub_region, village)
SELECT DISTINCT f.new_region, f.sub_region, NULL FROM politician_fix f
WHERE f.new_region IS NOT NULL AND f.sub_region IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO regions (region, sub_region, village)
SELECT DISTINCT f.new_region, f.sub_region, f.village FROM politician_fix f
WHERE f.new_region IS NOT NULL AND f.sub_region IS NOT NULL AND f.village IS NOT NULL
ON CONFLICT DO NOTHING;

-- 2. 人物：文字欄位與 region_id 一起改（trigger 會順手把統計的增減做掉）
UPDATE politicians p
SET region = f.new_region,
    region_id = (SELECT r.id FROM regions r
                 WHERE r.region = f.new_region
                   AND r.sub_region IS NOT DISTINCT FROM f.sub_region
                   AND r.village IS NOT DISTINCT FROM f.village)
FROM politician_fix f
WHERE p.id = f.id AND f.new_region IS NOT NULL AND f.new_region <> f.old_region;

-- 3. 參選紀錄指到的 region 列同樣要搬（外鍵是 ON DELETE SET NULL，放著不管會在清理時被清成 NULL）
UPDATE politician_elections pe
SET region_id = (SELECT r2.id FROM regions r2
                 WHERE r2.region = tc.region
                   AND r2.sub_region IS NOT DISTINCT FROM r1.sub_region
                   AND r2.village IS NOT DISTINCT FROM r1.village)
FROM regions r1
JOIN township_county tc ON tc.sub_region = r1.sub_region
WHERE pe.region_id = r1.id
  AND r1.region IN ('金門縣','連江縣')
  AND r1.region <> tc.region;

-- 4. 這兩縣的統計整段重算（欄位對應沿用 get_stat_column_for_type）
UPDATE regions r SET
  mayor_count = s.mayor, councilor_count = s.councilor, township_mayor_count = s.township_mayor,
  representative_count = s.representative, village_chief_count = s.village_chief,
  total_politicians = s.mayor + s.councilor + s.township_mayor + s.representative + s.village_chief,
  policy_count = s.policies, updated_at = NOW()
FROM (
  SELECT r.id,
    COUNT(*) FILTER (WHERE p.election_type::TEXT = '縣市長') AS mayor,
    COUNT(*) FILTER (WHERE p.election_type::TEXT = '縣市議員') AS councilor,
    COUNT(*) FILTER (WHERE p.election_type::TEXT IN ('鄉鎮市長','直轄市山地原住民區長')) AS township_mayor,
    COUNT(*) FILTER (WHERE p.election_type::TEXT IN ('鄉鎮市民代表','直轄市山地原住民區民代表')) AS representative,
    COUNT(*) FILTER (WHERE p.election_type::TEXT = '村里長') AS village_chief,
    COALESCE(SUM((SELECT COUNT(*) FROM policies pol WHERE pol.politician_id = p.id)), 0) AS policies
  FROM regions r
  LEFT JOIN politicians p
    ON p.region = r.region
   AND (r.sub_region IS NULL OR p.sub_region = r.sub_region)
   AND (r.village IS NULL OR p.village = r.village)
  WHERE r.region IN ('金門縣','連江縣')
  GROUP BY r.id
) s
WHERE r.id = s.id;

-- 5. 清掉錯置留下的空殼列（連江縣＋金城鎮這種不存在的組合）。
--    只有「統計全 0、沒有任何人物或參選紀錄指著它」才刪，其餘一律留著。
DELETE FROM regions r
USING township_county tc
WHERE r.sub_region = tc.sub_region
  AND r.region IN ('金門縣','連江縣')
  AND r.region <> tc.region
  AND COALESCE(r.total_politicians,0) = 0 AND COALESCE(r.policy_count,0) = 0
  AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.region_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.region_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM politicians p
                  WHERE p.region = r.region
                    AND p.sub_region IS NOT DISTINCT FROM r.sub_region
                    AND p.village IS NOT DISTINCT FROM r.village);

-- 6. 收尾自檢：人物側不該再有鄉鎮與縣市對不起來的（對不上就整個 migration 退回去）
DO $$
DECLARE v_left INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_left
  FROM politicians p JOIN township_county tc ON tc.sub_region = p.sub_region
  WHERE p.region IN ('金門縣','連江縣') AND p.region <> tc.region;
  IF v_left > 0 THEN
    RAISE EXCEPTION '還有 % 筆人物的鄉鎮與縣市對不起來，不繼續', v_left;
  END IF;
END $$;
