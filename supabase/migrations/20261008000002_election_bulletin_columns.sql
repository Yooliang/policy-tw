-- 選舉公報入口改讀 elections，並預先填好 2026（盤點 #2，2026-10-07 維護者同意）
--
-- 起因：公報入口有兩份真相，而且都沒有 2026：
--   TS  _shared/election-bulletin.ts 的 BULLETIN_YEAR_DIR（{2014,2018,2022,2024}）
--   SQL contribution_auto_tasks_policy_elements 的 CASE election_year WHEN 2022 … WHEN 2024 …（兩個網址寫死）
-- 2026 的公報投票前十日（約 11-18）上架，到時候要在兩邊各加一條；現在改成 elections 加欄位、填一個值就生效。
--
-- 三個欄位（都在 elections，一列＝一場選舉）：
--   bulletin_dir          公報站的民國年資料夾（'111'），選舉公報對照（build-election-bulletins.ts／matchBulletin）用
--   bulletin_hint         給代理的公報入口（網址 ← 說明），任務說明的 hint_sources 直接用這一行
--   bulletin_published_on 公報上架日；到這天之前 hint 不出現（沒上架的網址是死連結）。NULL＝已上架
-- 2022、2024 回填成原本寫死的字（一字不差，published_on 留 NULL）；2026 預先填好，bulletin_published_on 填 2026-11-18
-- （投票日 11-28 前十日，請維護者核對），所以現在 2026 的任務說明仍是原本那句「投票前約兩週才出版…」，11-18 起自動換成入口網址。
--
-- 動的 SQL 函式只有 contribution_auto_tasks_policy_elements（只換 hint_sources 的一項）。
-- 不動 contribution_auto_tasks_term_policies（另一條線在改成 election_task_config）與 contribution_auto_tasks_district_seats
-- （它的公報網址是整站首頁、不分屆）。行為不變：2022、2024、2026 三屆的任務說明與改之前逐字相同。

ALTER TABLE elections
  ADD COLUMN IF NOT EXISTS bulletin_dir TEXT,
  ADD COLUMN IF NOT EXISTS bulletin_hint TEXT,
  ADD COLUMN IF NOT EXISTS bulletin_published_on DATE;

COMMENT ON COLUMN elections.bulletin_dir IS '中選會公報站的民國年資料夾（111／113／115），選舉公報對照用（TS: election-bulletin.ts matchBulletin 的 yearDirs）。NULL＝這場選舉沒有（或還不知道）公報資料夾';
COMMENT ON COLUMN elections.bulletin_hint IS '給代理的公報入口一行：網址 ← 說明。政見三要素任務（policy_elements_missing）的 hint_sources 用。NULL＝沒有可給的入口';
COMMENT ON COLUMN elections.bulletin_published_on IS '公報上架日（約投票前十日）。這天之前 bulletin_hint 不給（還沒上架的網址是死連結）。NULL＝已上架';

UPDATE elections SET bulletin_dir = '111', bulletin_hint = 'https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022（111 年）地方選舉公報：點縣市 → 選舉別 → 選舉區 PDF，候選人登記的政見原文在上面' WHERE id = 2022;
UPDATE elections SET bulletin_dir = '113', bulletin_hint = 'https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86 ← 中選會 2024（113 年）第 11 屆立委選舉公報' WHERE id = 2024;
UPDATE elections SET bulletin_dir = '115', bulletin_hint = 'https://eebulletin.cec.gov.tw/?dir=115 ← 中選會 2026（115 年）地方選舉公報：點縣市 → 選舉別 → 選舉區 PDF，候選人登記的政見原文在上面', bulletin_published_on = DATE '2026-11-18' WHERE id = 2026;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_elements()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH inflight AS (
    -- 已經有人交了、還在等票或自動重試中：先不派，免得兩個代理拆同一條；被退件就會回來
    SELECT DISTINCT c.payload->>'policy_id' AS policy_id
      FROM contributions c
     WHERE c.contribution_type = 'policy_elements' AND c.status IN ('pending', 'verified', 'apply_failed')
  ),
  cand AS (
    SELECT pl.id AS policy_id, pl.title, pl.status::TEXT AS status, pl.election_id, policy_primary_url(pl.id) AS source_url,
           p.id AS politician_id, p.name, p.party, COALESCE(r.region, p.region) AS region,
           x.election_type, e.election_date, e.bulletin_hint, e.bulletin_published_on,
           -- 屆別年份從投票日取，不從 id 推（#344：之後新增的選舉 id 不保證是年份）
           EXTRACT(YEAR FROM e.election_date)::INTEGER AS election_year,
           office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, x.election_type) AS term_end,
           ARRAY(SELECT k FROM unnest(ARRAY['target', 'deadline', 'funding']) WITH ORDINALITY AS u(k, n)
                  WHERE NOT EXISTS (SELECT 1 FROM policy_elements pe WHERE pe.policy_id = pl.id AND pe.element = u.k)
                  ORDER BY u.n) AS missing
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pl.election_id
      -- 這個人那一屆的參選紀錄（同一屆有兩筆時取當選的、在選的那一筆）
      JOIN LATERAL (
        SELECT q.election_type, q.candidacy_status, q.region_id
          FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
         ORDER BY (q.candidacy_status = 'elected') DESC NULLS LAST,
                  (q.candidacy_status IS DISTINCT FROM 'withdrawn') DESC NULLS LAST, q.id
         LIMIT 1
      ) x ON true
      LEFT JOIN regions r ON r.id = x.region_id
     WHERE pl.removed_at IS NULL
       AND (
         -- 還沒投票：在選的人（選前要能並排比較）
         (e.election_date >= CURRENT_DATE AND x.candidacy_status IS DISTINCT FROM 'withdrawn')
         -- 已投票：當選者、而且還沒達成也沒跳票（期限要接得上追蹤）
         OR (e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected' AND pl.status::TEXT NOT IN ('Achieved', 'Failed'))
       )
  )
  SELECT 'auto:policy_elements_missing:' || c.policy_id, 'policy_elements_missing',
         jsonb_build_object('policy_id', c.policy_id, 'policy_title', c.title, 'status', c.status, 'source_url', c.source_url,
                            'politician_id', c.politician_id, 'name', c.name, 'party', c.party, 'region', c.region,
                            'election_id', c.election_id, 'election_type', c.election_type, 'term_end', c.term_end,
                            'missing', to_jsonb(c.missing)),
         '「' || c.title || '」（' || c.name || '，' || c.election_year || ' ' || COALESCE(c.election_type, '') || '）還沒拆成政見三要素，還缺：'
           || array_to_string(ARRAY(SELECT CASE k WHEN 'target' THEN '數值目標' WHEN 'deadline' THEN '達成期限' ELSE '財源' END
                                      FROM unnest(c.missing) WITH ORDINALITY AS u(k, n) ORDER BY u.n), '、') || '。'
           || '請打開這條政見的**原文**（選舉公報、政見發表會、候選人官網或競選文宣的政見頁；政見上的 source_url 若只是轉述的新聞，先找到原文），'
           || '逐一看原文有沒有寫：數值目標（做到多少、做到什麼程度）、達成期限（什麼時候之前）、財源（錢從哪裡來）。'
           || '有寫的照原文寫進 text（120 字內，不補數字、不換算、不評價）；查過原文沒寫的 stated 填 false——那也是答案，畫面會顯示「未說明」。'
           || '每個要素都要附原句位置（source_locator），沒寫的也要寫你查的是原文哪一段。'
           || '期限換得成日期就填 deadline_date：會計年度是曆年，「2028 年前」填 2028-12-31，「任內」填這一任的卸任日 ' || COALESCE(c.term_end::TEXT, '（target.term_end）') || '。'
           || '用 policy_elements 型別交一筆；找不到原文就用 no_change 回報你查了哪裡，不要拿我們的政見摘要當原文。',
         ARRAY_REMOVE(ARRAY[
           CASE WHEN c.source_url IS NOT NULL THEN c.source_url || ' ← 這條政見現在掛的出處（先看它是不是原文）' END,
           -- 公報入口讀 elections.bulletin_hint（公報上架日 bulletin_published_on 之後才給；沒填或還沒上架就給下面那句）
           CASE WHEN c.bulletin_hint IS NOT NULL AND (c.bulletin_published_on IS NULL OR c.bulletin_published_on <= CURRENT_DATE)
                THEN c.bulletin_hint
                ELSE '中選會選舉公報（投票前約兩週才出版；出版前看候選人官網、競選臉書的政見頁）'
           END,
           '政見發表會影片（各縣市選委會的 YouTube 頻道）',
           'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見）'
         ], NULL),
         1, c.region
    FROM cand c
   WHERE cardinality(c.missing) > 0
     AND NOT EXISTS (SELECT 1 FROM inflight i WHERE i.policy_id = c.policy_id::TEXT)
$function$
;
COMMENT ON FUNCTION contribution_auto_tasks_policy_elements IS '政見還沒拆完三要素 → policy_elements_missing（還沒投票的屆別：在選者；已投票的屆別：當選者、未達成也未跳票）。已有人交了在等票的先不派（#364，2026-10-05）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result｜2026-10-07：公報入口改讀 elections.bulletin_hint（公報上架日之後才給）';
