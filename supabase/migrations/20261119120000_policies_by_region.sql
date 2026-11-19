-- 全部政見頁按縣市載入：policies_by_region（政見列附縣市與「列在 /tracking」旗標）、
-- policy_region_category_counts（縣市 × 分類的筆數，給方塊格上的數字）。
--
-- 為什麼：/tracking 以前進頁就把全站 14,700 筆政見整份載下來（20.5 MB、15 趟循序請求、約 11.6 秒），
--   縣市與分類篩選都在瀏覽器裡做。政見列沒有縣市欄，縣市要靠 politician_id → politicians.region 查，
--   所以前端只能整份載。現在縣市放進視圖，前端用 `region=eq.新北市` 只載那一個縣市。
--
-- 縣市怎麼算：跟 politicians_with_elections 同一個式子 COALESCE(regions.region, politicians.region)
--   （politicians.region_id 對到 regions 就用 regions 的，沒有才用 politicians 自己的），
--   也就是前端 lib/policy-region.ts 的 policyMatchesRegion 用的 politician.region，兩邊同一個縣市。
-- listed 怎麼算：/tracking 只列「政見」「施政」兩個階段（lib/policy-stage.ts 的 isPostElectionStage）：
--   不是競選承諾來源（origin 有值且不是 pledge；origin 沒標時看 status 是不是 Campaign Pledge），
--   或那一屆已投票且提出者在那一屆有 elected 紀錄（跟 policy_is_elected_term 同一個條件，投票日當天算還沒投票）。
--   只算 listed 的話 14,700 筆只剩約 3,400 筆，按縣市載入再省一大截，方塊格上的數字也才等於頁面真的會列出的筆數。
--   TS 與 SQL 兩份規則要一起改（守門 lib/policy-region-counts.test.ts 讀這支 migration 的內容）。
-- 欄位順序：policies_by_region 是 policies_with_logs.* 後面接 region、listed。
--   ⚠ 這支視圖依賴 policies_with_logs：之後要 DROP＋CREATE policies_with_logs（加欄位時的慣例，見 20260921000028）
--   必須先 DROP VIEW policies_by_region，改完再照這支重建，否則 DROP 會被依賴擋下。
-- 權限：比照 politician_election_policy_counts——security_invoker＋給 anon／authenticated 讀；底層表的 RLS 照常生效。
-- 索引：politicians(region)、policies(politician_id) WHERE removed_at IS NULL（policies_visible_idx）都已存在，不用新增。

CREATE OR REPLACE VIEW policies_by_region AS
SELECT
  pl.*,
  COALESCE(r.region, po.region) AS region,
  (
    NOT (CASE WHEN COALESCE(pl.origin, '') <> '' THEN pl.origin = 'pledge' ELSE pl.status = 'Campaign Pledge' END)
    OR (
      pl.election_id IS NOT NULL
      AND e.election_date < activity_today()
      AND EXISTS (
        SELECT 1 FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id AND q.candidacy_status = 'elected'
      )
    )
  ) AS listed
FROM policies_with_logs pl
JOIN politicians po ON po.id = pl.politician_id
LEFT JOIN regions r ON r.id = po.region_id
LEFT JOIN elections e ON e.id = pl.election_id
WHERE pl.removed_at IS NULL;

ALTER VIEW policies_by_region SET (security_invoker = on);
GRANT SELECT ON policies_by_region TO anon, authenticated;
COMMENT ON VIEW policies_by_region IS
  '未移除的政見（同 policies_with_logs）附 region（所屬人物的縣市）與 listed（全部政見頁會不會列出：選後政見／施政）。全部政見頁按縣市載入用：region=eq.新北市&listed=eq.true。依賴 policies_with_logs，改那支視圖前要先 DROP 這支。';

CREATE OR REPLACE VIEW policy_region_category_counts AS
SELECT
  COALESCE(r.region, po.region) AS region,
  pl.category,
  count(*)::int AS n,
  count(*) FILTER (WHERE
    NOT (CASE WHEN COALESCE(pl.origin, '') <> '' THEN pl.origin = 'pledge' ELSE pl.status = 'Campaign Pledge' END)
    OR (
      pl.election_id IS NOT NULL
      AND e.election_date < activity_today()
      AND EXISTS (
        SELECT 1 FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id AND q.candidacy_status = 'elected'
      )
    )
  )::int AS listed_n
FROM policies pl
JOIN politicians po ON po.id = pl.politician_id
LEFT JOIN regions r ON r.id = po.region_id
LEFT JOIN elections e ON e.id = pl.election_id
WHERE pl.removed_at IS NULL
GROUP BY COALESCE(r.region, po.region), pl.category;

ALTER VIEW policy_region_category_counts SET (security_invoker = on);
GRANT SELECT ON policy_region_category_counts TO anon, authenticated;
COMMENT ON VIEW policy_region_category_counts IS
  '縣市 × 分類的政見筆數（未移除）：n＝全部、listed_n＝全部政見頁會列出的（選後政見／施政，同 policies_by_region.listed）。約 400 列，全部政見頁的縣市／分類方塊格讀它，不必為了數字載整份政見。';
