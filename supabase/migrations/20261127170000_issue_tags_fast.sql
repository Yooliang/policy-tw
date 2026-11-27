-- ============================================================
-- 議題標籤判定加速：issues_scoped 改集合運算，標籤只判一次（2026-11-27，輸出逐列不變）
-- ============================================================
--
-- 為什麼慢（正式庫 2026-11-27 量測）：
--   缺口臂 issue_too_broad 的整表函式 contribution_auto_tasks_issue_too_broad() 要 7.35 秒，
--   其中建 MATERIALIZED CTE sc（issues_scoped 逐縣市展開，約 5 萬列）占 5.4 秒；
--   sc 裡約 4.4 秒是 issues_scoped 對每筆承諾逐列呼叫 issue_tags_of（約 87 微秒一次），
--   而 issue_tags_of 對每個標籤呼叫 issue_tag_is_junk：先拿一個約千名的姓名陣列做 = ANY，再跑 5 個正規表示式。
--   承諾有幾萬筆，但「不同的標籤字串」只有幾百個，同一個標籤的判定結果其實只需要算一次。
--
-- 改了什麼（不改任何函式簽名、回傳型別、權限）：
--   1. issues_scoped：先把這個縣市這一屆範圍內承諾的原始標籤 unnest、去重，只對 distinct 標籤算一次 issue_tag_is_junk
--      （結果放進 MATERIALIZED 小集合 good），每筆承諾再用雜湊比對取出自己的乾淨標籤；
--      退回 category 的規則（沒有任何乾淨標籤、category 去空白後不是空字串也不是「其他」）原樣照搬。
--      承諾×議題各一列、同一承諾多個參選紀錄就多列的行為都沒變。
--   2. issue_tag_is_junk：OR 子句重排，把「每次都要掃整個姓名陣列」的 = ANY 移到最後，
--      便宜的長度、固定清單、正規表示式先判（OR 的真值不受子句順序影響，連 NULL 的三值邏輯結果都相同）。
--   3. issue_tag_is_junk、issue_tags_of 標 PARALLEL SAFE（兩者是純函式，沒有查表、沒有副作用）。
--      issue_tags_of 本體一個字不動，policy_subtopic_issue 等其他呼叫端行為不變。
--
-- 行為變更：無。輸出逐列相同，證明方式見 supabase/functions/_shared/issue-tags-fast.test.ts：
--   舊本體以 _legacy 名稱裝進同一個 PGlite，對涵蓋姓名命中、各條正規表示式、全形半形、空標籤、重複標籤、NULL、多標籤排序
--   的 fixture 逐列比對 issue_tags_of／issues_scoped，並比對 contribution_auto_tasks_issue_too_broad() 整體結果集。
--
-- 每日呼叫量變化：無新增排程；issue_tags_of 每日呼叫次數不變、每次成本降低；
--   issues_scoped 的呼叫次數不變，但每次不再逐列呼叫 issue_tags_of，改為每個 distinct 標籤判一次 issue_tag_is_junk。
--
-- 回滾：把 issue_tag_is_junk、issue_tags_of、issues_scoped 三支換回 20261031130000_issues_summary_page.sql 的定義即可
--   （CREATE OR REPLACE，不動資料、不動索引、不動權限）。
--
-- 若這樣還不夠（只提案、這支 migration 沒做）：在 policies 上存預先算好的「乾淨標籤」欄位或表，
--   改動資料結構與寫入路徑，要另案裁決。

CREATE OR REPLACE FUNCTION issue_tag_is_junk(p_tag text, p_names text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT t.v IS NULL
      OR char_length(t.v) < 2
      OR t.v = ANY (ARRAY['民生優先', '務實施政', '行政經驗', '治理能力', '承擔責任', '實踐承諾', '穩定發展', '選戰策略', '選舉', '政見', '競選承諾', '其他', '未分類', '無', '待補'])
      OR t.v ~ '^[0-9]{4}$'
      OR t.v ~ '^[0-9]{4}.*(市長|縣長|議員|立委|立法委員|總統|選舉|選戰)'
      OR t.v ~ '(市長|縣長|議員|立委|總統)(候選人|選舉|選戰)?$'
      OR t.v ~ '(RSS|rss|中央社|新聞|報導|媒體|來源|網站|官網|臉書|Facebook|粉專)'
      OR t.v ~ '^(台|臺)?(北|新北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江)(市|縣)?$'
      OR t.v = ANY (COALESCE(p_names, '{}'::text[]))
  FROM (SELECT btrim(p_tag, E' \t\r\n　') AS v) t
$$;

-- 本體與 20261031130000 逐字相同，只多 PARALLEL SAFE
CREATE OR REPLACE FUNCTION issue_tags_of(p_tags text[], p_category text, p_names text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN cardinality(k.arr) > 0 THEN k.arr
    WHEN k.cat <> '' AND k.cat <> '其他' THEN ARRAY[k.cat]
    ELSE '{}'::text[]
  END
  FROM (
    SELECT ARRAY(
             SELECT DISTINCT s.t
               FROM (SELECT btrim(x, E' \t\r\n　') AS t FROM unnest(COALESCE(p_tags, '{}'::text[])) AS x) s
              WHERE s.t <> '' AND NOT issue_tag_is_junk(s.t, p_names)
           ) AS arr,
           btrim(COALESCE(p_category, ''), E' \t\r\n　') AS cat
  ) k
$$;

CREATE OR REPLACE FUNCTION issues_scoped(p_election_id integer, p_region text)
RETURNS TABLE (
  policy_id uuid,
  politician_id uuid,
  issue text,
  level text,
  level_rank int,
  lineage_id uuid,
  proposed_date date,
  title text,
  category text
)
LANGUAGE sql
STABLE
AS $$
  WITH rg AS (
    SELECT r.id, r.sub_region
      FROM regions r
     WHERE replace(r.region, '臺', '台') = replace(p_region, '臺', '台')
  ),
  -- 不是議題的名字：這個縣市這一屆的候選人名＋鄉鎮市區名（含去掉區／鄉／鎮／市後綴的寫法）
  junk AS (
    SELECT COALESCE(array_agg(DISTINCT n), '{}'::text[]) AS names
      FROM (
        SELECT po.name AS n
          FROM politician_elections pe
          JOIN rg ON rg.id = pe.region_id
          JOIN politicians po ON po.id = pe.politician_id
         WHERE pe.election_id = p_election_id
        UNION
        SELECT rg.sub_region FROM rg WHERE rg.sub_region IS NOT NULL AND rg.sub_region !~ '選舉區$'
        UNION
        SELECT regexp_replace(rg.sub_region, '[區鄉鎮市]$', '') FROM rg WHERE rg.sub_region IS NOT NULL AND rg.sub_region !~ '選舉區$'
      ) x
     WHERE n IS NOT NULL
  ),
  -- 範圍內的承諾（每個參選紀錄一列，跟舊版的 JOIN 結構相同）
  base AS MATERIALIZED (
    SELECT p.id, p.politician_id, p.lineage_id, p.proposed_date, p.title, p.category, p.tags, pe.election_type
      FROM policies p
      JOIN politician_elections pe ON pe.politician_id = p.politician_id AND pe.election_id = p_election_id
      JOIN rg ON rg.id = pe.region_id
     WHERE p.election_id = p_election_id
       AND p.status = 'Campaign Pledge'
       AND p.removed_at IS NULL
       AND issue_level_of(pe.election_type) IS NOT NULL
  ),
  -- 不同的標籤字串只判一次：留下「不是雜訊」的乾淨標籤
  good AS MATERIALIZED (
    SELECT d.t
      FROM (
        SELECT DISTINCT btrim(x.v, E' \t\r\n　') AS t
          FROM base b
          CROSS JOIN LATERAL unnest(COALESCE(b.tags, '{}'::text[])) AS x(v)
      ) d
      CROSS JOIN junk
     WHERE d.t <> '' AND NOT issue_tag_is_junk(d.t, junk.names)
  )
  SELECT b.id, b.politician_id, i.issue, issue_level_of(b.election_type),
         issue_level_rank(issue_level_of(b.election_type)), b.lineage_id, b.proposed_date, b.title, b.category
    FROM base b
    CROSS JOIN LATERAL (
      -- 規則同 issue_tags_of：有乾淨標籤就用（去重、排序）；一個都沒有就退回 category（空字串與「其他」不算）
      SELECT CASE
               WHEN cardinality(k.arr) > 0 THEN k.arr
               WHEN k.cat <> '' AND k.cat <> '其他' THEN ARRAY[k.cat]
               ELSE '{}'::text[]
             END AS issues
        FROM (
          SELECT ARRAY(
                   SELECT DISTINCT s.t
                     FROM (SELECT btrim(x, E' \t\r\n　') AS t FROM unnest(COALESCE(b.tags, '{}'::text[])) AS x) s
                    WHERE s.t IN (SELECT g.t FROM good g)
                 ) AS arr,
                 btrim(COALESCE(b.category, ''), E' \t\r\n　') AS cat
        ) k
    ) z
    CROSS JOIN LATERAL unnest(z.issues) AS i(issue)
$$;
