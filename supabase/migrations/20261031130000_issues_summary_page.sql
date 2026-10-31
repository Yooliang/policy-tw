-- ============================================================
-- 議題串聯改在資料庫端聚合與分頁（2026-10-31，維護者批准「做吧」）
-- ============================================================
--
-- 串聯檢視（/election/2026/高雄市?view=issues）原本要先撈整個縣市的參選人（高雄 2026 約 1,764 人，其中村里長 1,609）
-- 與全部政見，再在前端依議題分組。政見將來可能到 1.7 萬筆，前端撈全部撐不住。
-- 這裡只新增唯讀函式與索引，不改任何資料、不動任何既有物件。
--
--   issues_summary(p_election_id, p_region)                     每個議題的總數、各層級筆數、代表性標題前 3 筆
--   issues_page(p_election_id, p_region, p_issue, p_level, ...)  一個議題的政見分頁（層級 → 脈絡 → 時間）
--
-- 分組依據（照 lib/issue-tags.ts 的 issueTagsOf 原意）：一筆政見的議題 = 它的 tags 去掉「不是議題的名字」
-- （候選人名、該縣市鄉鎮市區名、口號、年份、來源、縣市名…），一個都不剩就退回 category（「其他」不算）。
-- 一筆政見可有多個議題標籤，會在每個議題各算一次（跟畫面原本的行為一致）。
-- 規則的 SQL 版是 issue_tag_is_junk／issue_tags_of；TS 版與它逐案對照，見 issues-summary-sql.test.ts。
--
-- 範圍（照畫面原本的 regionPolicies）：policies.status = 'Campaign Pledge'、policies.election_id = 這一屆、
-- removed_at 為空、作者在 politician_elections 有這一屆的參選紀錄、參選紀錄的 regions.region = 縣市（臺／台不分）。
-- 層級（照 VerticalStack）：縣市長／議員／鄉鎮市區長（鄉鎮市長＋直轄市山地原住民區長）／
-- 代表（鄉鎮市民代表＋直轄市山地原住民區民代表）／村里長；總統、立委不在串聯內。
--
-- 權限：SECURITY INVOKER（RLS 照呼叫者）、STABLE，另 grant anon／authenticated 明確可執行；
-- 函式內 SET statement_timeout = '5s'，慢查詢不拖垮資料庫。

-- ------------------------------------------------------------
-- 1. 議題標籤規則（lib/issue-tags.ts 的 SQL 版）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION issue_tag_is_junk(p_tag text, p_names text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT t.v IS NULL
      OR char_length(t.v) < 2
      OR t.v = ANY (ARRAY['民生優先', '務實施政', '行政經驗', '治理能力', '承擔責任', '實踐承諾', '穩定發展', '選戰策略', '選舉', '政見', '競選承諾', '其他', '未分類', '無', '待補'])
      OR t.v = ANY (COALESCE(p_names, '{}'::text[]))
      OR t.v ~ '^[0-9]{4}$'
      OR t.v ~ '^[0-9]{4}.*(市長|縣長|議員|立委|立法委員|總統|選舉|選戰)'
      OR t.v ~ '(市長|縣長|議員|立委|總統)(候選人|選舉|選戰)?$'
      OR t.v ~ '(RSS|rss|中央社|新聞|報導|媒體|來源|網站|官網|臉書|Facebook|粉專)'
      OR t.v ~ '^(台|臺)?(北|新北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江)(市|縣)?$'
  FROM (SELECT btrim(p_tag, E' \t\r\n　') AS v) t
$$;

CREATE OR REPLACE FUNCTION issue_tags_of(p_tags text[], p_category text, p_names text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
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

-- 職位 → 串聯層級（總統、立委等不在串聯內回 NULL）與排序
CREATE OR REPLACE FUNCTION issue_level_of(p_election_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_election_type
    WHEN '縣市長' THEN '縣市長'
    WHEN '縣市議員' THEN '議員'
    WHEN '鄉鎮市長' THEN '鄉鎮市區長'
    WHEN '直轄市山地原住民區長' THEN '鄉鎮市區長'
    WHEN '鄉鎮市民代表' THEN '代表'
    WHEN '直轄市山地原住民區民代表' THEN '代表'
    WHEN '村里長' THEN '村里長'
  END
$$;

CREATE OR REPLACE FUNCTION issue_level_rank(p_level text)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_level WHEN '縣市長' THEN 1 WHEN '議員' THEN 2 WHEN '鄉鎮市區長' THEN 3 WHEN '代表' THEN 4 WHEN '村里長' THEN 5 END
$$;

-- ------------------------------------------------------------
-- 2. 範圍：這一屆、這個縣市、每筆政見×每個議題一列
-- ------------------------------------------------------------
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
  )
  SELECT p.id, p.politician_id, i.issue, issue_level_of(pe.election_type),
         issue_level_rank(issue_level_of(pe.election_type)), p.lineage_id, p.proposed_date, p.title, p.category
    FROM policies p
    JOIN politician_elections pe ON pe.politician_id = p.politician_id AND pe.election_id = p_election_id
    JOIN rg ON rg.id = pe.region_id
    CROSS JOIN junk
    CROSS JOIN LATERAL unnest(issue_tags_of(p.tags, p.category, junk.names)) AS i(issue)
   WHERE p.election_id = p_election_id
     AND p.status = 'Campaign Pledge'
     AND p.removed_at IS NULL
     AND issue_level_of(pe.election_type) IS NOT NULL
$$;

-- ------------------------------------------------------------
-- 3. 議題清單：每個議題的總數、各層級筆數、代表性標題前 3 筆
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION issues_summary(p_election_id integer, p_region text)
RETURNS TABLE (
  issue text,
  total bigint,
  by_level jsonb,
  samples text[]
)
LANGUAGE sql
STABLE
SET statement_timeout = '5s'
AS $$
  WITH s AS (SELECT * FROM issues_scoped(p_election_id, p_region)),
  lv AS (
    SELECT issue, level, count(*) AS n FROM s GROUP BY issue, level
  ),
  smp AS (
    SELECT issue, array_agg(title ORDER BY rn) AS samples
      FROM (
        SELECT issue, title,
               row_number() OVER (PARTITION BY issue ORDER BY level_rank, proposed_date DESC NULLS LAST, policy_id) AS rn
          FROM s
      ) q
     WHERE rn <= 3
     GROUP BY issue
  )
  SELECT lv.issue,
         sum(lv.n)::bigint AS total,
         jsonb_object_agg(lv.level, lv.n) AS by_level,
         smp.samples
    FROM lv
    JOIN smp ON smp.issue = lv.issue
   GROUP BY lv.issue, smp.samples
   ORDER BY sum(lv.n) DESC, lv.issue
$$;

-- ------------------------------------------------------------
-- 4. 議題分頁：層級（縣市長→議員→鄉鎮市區長→代表→村里長）→ 脈絡串在一起 → 時間（新到舊）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION issues_page(
  p_election_id integer,
  p_region text,
  p_issue text,
  p_level text DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 30
)
RETURNS TABLE (
  policy_id uuid,
  title text,
  category text,
  proposed_date date,
  lineage_id uuid,
  level text,
  politician_id uuid,
  name text,
  position_title text,
  cand_no integer,
  avatar_url text,
  party text,
  total bigint
)
LANGUAGE sql
STABLE
SET statement_timeout = '5s'
AS $$
  WITH s AS (
    SELECT * FROM issues_scoped(p_election_id, p_region)
     WHERE issue = p_issue AND (p_level IS NULL OR level = p_level)
  ),
  ranked AS (
    SELECT s.*,
           -- 同一條脈絡的政見排在一起：脈絡內最新的一筆決定這一串的位置；沒有脈絡的各自一串
           max(s.proposed_date) OVER (PARTITION BY s.level_rank, COALESCE(s.lineage_id, s.policy_id)) AS cluster_date,
           COALESCE(s.lineage_id, s.policy_id) AS cluster_key,
           count(*) OVER () AS total
      FROM s
  ),
  pg AS (
    SELECT * FROM ranked
     ORDER BY level_rank, cluster_date DESC NULLS LAST, cluster_key, proposed_date DESC NULLS LAST, policy_id
     OFFSET GREATEST(COALESCE(p_offset, 0), 0)
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100)
  )
  SELECT pg.policy_id, pg.title, pg.category, pg.proposed_date, pg.lineage_id, pg.level,
         pg.politician_id, po.name, pe.position, pe.cand_no, po.avatar_url,
         COALESCE(pa.short_name, pa.name, po.party::text),
         pg.total
    FROM pg
    JOIN politicians po ON po.id = pg.politician_id
    JOIN politician_elections pe ON pe.politician_id = pg.politician_id AND pe.election_id = p_election_id
    LEFT JOIN parties pa ON pa.id = pe.party_id
   ORDER BY pg.level_rank, pg.cluster_date DESC NULLS LAST, pg.cluster_key, pg.proposed_date DESC NULLS LAST, pg.policy_id
$$;

GRANT EXECUTE ON FUNCTION issue_tag_is_junk(text, text[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION issue_tags_of(text[], text, text[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION issue_level_of(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION issue_level_rank(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION issues_scoped(integer, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION issues_summary(integer, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION issues_page(integer, text, text, text, integer, integer) TO anon, authenticated;

COMMENT ON FUNCTION issues_summary(integer, text) IS
  '議題串聯首屏：該屆該縣市每個議題的政見總數、各層級筆數、代表性標題前 3 筆。唯讀、SECURITY INVOKER。分組規則同 lib/issue-tags.ts。';
COMMENT ON FUNCTION issues_page(integer, text, text, text, integer, integer) IS
  '議題串聯分頁：一個議題的政見，依層級→脈絡→時間排序，附作者精簡欄位與該議題（含層級篩選）總筆數。每頁最多 100 筆。唯讀。';

-- ------------------------------------------------------------
-- 5. 索引
-- ------------------------------------------------------------
-- 串聯只看「這一屆、競選承諾、沒被移除」的政見，且要用 politician_id 接參選紀錄
CREATE INDEX IF NOT EXISTS policies_issues_idx
  ON policies (election_id, politician_id)
  WHERE removed_at IS NULL AND status = 'Campaign Pledge';
-- 這一屆 × 地區 → 參選人（職位一起帶，免回表）
CREATE INDEX IF NOT EXISTS politician_elections_election_region_idx
  ON politician_elections (election_id, region_id) INCLUDE (politician_id, election_type);
