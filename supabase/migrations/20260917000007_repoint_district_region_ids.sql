-- 承 20260917000005／000006：那兩列不可能的組合刪不掉，因為還有東西指著它們——
--   regions 8983（金門縣 ／ 連江縣第01選區）：3 筆參選紀錄
--   regions 8984（連江縣 ／ 金門縣第01選區）：3 筆參選紀錄 ＋ 陳玉珍的 region_id
-- 前兩支只用鄉鎮名做對照，沒有處理「選區字串本身就寫著縣市」的這幾筆。
-- 外鍵是 ON DELETE SET NULL，硬刪會把這些指標清成 NULL，等於把資料弄丟，所以先搬再刪。

-- 選區字串開頭的縣市才是對的：連江縣第01選區 → 連江縣，金門縣第01選區 → 金門縣
CREATE TEMP TABLE district_fix ON COMMIT DROP AS
SELECT bad.id AS bad_id, good.id AS good_id
FROM regions bad
JOIN regions good
  ON good.region = LEFT(bad.sub_region, 3)
 AND good.sub_region = bad.sub_region
 AND good.village IS NOT DISTINCT FROM bad.village
WHERE bad.region IN ('金門縣','連江縣')
  AND bad.sub_region IS NOT NULL
  AND (bad.sub_region LIKE '金門縣%' OR bad.sub_region LIKE '連江縣%')
  AND LEFT(bad.sub_region, 3) <> bad.region;

UPDATE politician_elections pe SET region_id = f.good_id
FROM district_fix f WHERE pe.region_id = f.bad_id;

UPDATE politicians p SET region_id = f.good_id
FROM district_fix f WHERE p.region_id = f.bad_id;

DELETE FROM regions r
USING district_fix f
WHERE r.id = f.bad_id
  AND COALESCE(r.total_politicians,0) = 0 AND COALESCE(r.policy_count,0) = 0
  AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.region_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.region_id = r.id);

-- 收尾自檢：這兩縣不該再有「鄉鎮或選區屬於另一個縣」的列
DO $$
DECLARE v_left INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_left FROM regions r
  WHERE r.region IN ('金門縣','連江縣') AND r.sub_region IS NOT NULL
    AND (r.sub_region LIKE '金門縣%' OR r.sub_region LIKE '連江縣%')
    AND LEFT(r.sub_region, 3) <> r.region;
  IF v_left > 0 THEN
    RAISE EXCEPTION '還有 % 列選區與縣市對不起來，不繼續', v_left;
  END IF;
END $$;
