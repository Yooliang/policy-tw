-- 承 20260917000005：人物側已經修好，regions 還剩兩列不可能的組合——
--   金門縣 ／ 連江縣第01選區、連江縣 ／ 金門縣第01選區
-- 前一支的清理只比對鄉鎮名，沒有涵蓋「選區字串本身就寫著另一個縣」的情況。
--
-- 兩列現在統計全 0（原本掛在上面的立委陳雪生等四人已經搬到正確的縣），
-- 一樣只在沒有任何東西指著它時才刪。

DELETE FROM regions r
WHERE r.region IN ('金門縣','連江縣')
  AND r.sub_region IS NOT NULL
  AND (r.sub_region LIKE '金門縣%' OR r.sub_region LIKE '連江縣%')
  AND LEFT(r.sub_region, 3) <> r.region
  AND COALESCE(r.total_politicians,0) = 0 AND COALESCE(r.policy_count,0) = 0
  AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.region_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.region_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM politicians p
                  WHERE p.region = r.region AND p.sub_region IS NOT DISTINCT FROM r.sub_region);
