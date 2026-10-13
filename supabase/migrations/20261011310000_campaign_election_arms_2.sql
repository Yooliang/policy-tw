-- 拿掉派工臂裡寫死的年份（第二批）：region_gap、township_gap、roster_villages、term_policies（2026-10-13，維護者「A B C」的 A；前一批 20261011300000）
-- ============================================================
--
-- 目標同前一批：新增一場選舉只要加資料列，不用改臂。用前一批的 campaign_election_id()、election_year_text()，派工輸出今天逐件不變。
--
--   1. region_gap：「這一屆有中選會登記彙總表」原本寫死 election_id = 2026，改看 cec_registration_sources 有沒有這一屆（今天只有 2026）；
--      任務說明的「2026 的縣市與選區」改由 election_year_text() 算。
--   2. township_gap：當屆參選人原本寫死 2026，改讀 campaign_election_id()。
--   3. roster_villages：我們名下的村里長人數原本只數 2026，改成按清查範圍（roster_check_scope）各屆分開數；
--      名冊標題「115 年村里長選舉候選人登記彙總表」的民國年改由該屆投票日算。
--   4. term_policies：「當屆還沒投票的現任者」那段原本寫死 2026，改讀 campaign_election_id()。
--
-- 沒動的：任務說明裡當範例用的年份（ballot_numbers、policy_elements、deadline_due）、統計資料的年份（regional_stats_missing）、
-- 中選會公告網址；職位字面值是結構，不是年份。
--
-- 四支臂的新定義＝前一版加一串機械式替換（守門 campaign-election-arms-2.test.ts 把替換倒回去，必須一字不差回到前一版）；
-- 正式庫逐件比對：scripts/arms-parity-campaign.ts gen <out.sql> 20261011310000_campaign_election_arms_2.sql region_gap township_gap roster_villages term_policies。

-- ------------------------------------------------------------
-- 1. region_gap（前一版 20261009070000；只做檔頭列的替換）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_region_gap()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    -- candidate_status＝交件協議的詞（下面的任務說明與 target 用），由 candidacy_status 換算，不是舊欄位
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status, pe.position,
           p.id AS politician_id, p.name, p.party,
           COALESCE(r.region, p.region) AS county,
           NULLIF(concat_ws(' ', r.sub_region, r.village), '') AS attached_below_county,
           pe.region_id IS NULL AS no_region,
           pe.election_type IN ('縣市議員', '立法委員')
             AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
             AND NOT region_is_electoral_district(pe.election_type, r.region, r.sub_region) AS no_district,
           -- 掛錯層級：不是縣市層級、也不是這種選舉的選區（立委的「全國」那一列算縣市層級，缺的是選區）
           pe.region_id IS NOT NULL
             AND (r.village IS NOT NULL
                  OR (r.sub_region IS NOT NULL AND NOT region_is_electoral_district(pe.election_type, r.region, r.sub_region))) AS wrong_level
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.election_type IN ('縣市長', '縣市議員', '立法委員')
  ),
  -- 代表的選舉區（#464）：鄉鎮市民代表、直轄市山地原住民區民代表的參選紀錄只記到鄉鎮（region_id 指到鄉鎮那一列），沒有選舉區。
  -- 代表的號次是按選舉區編的，沒有選舉區就檢查不了同一區的號次有沒有重複或跳號。只派「中選會登記彙總表（cec_registrations）上找得到他、
  -- 那一列寫了選舉區」的：任務附上名冊那一列的選舉區當提示，代理照名冊交件、系統逐位核對（選舉區也核）。名冊上找不到他、
  -- 或那個鄉鎮名冊根本沒有選舉區（單一選區的鄉，例如金門縣、蘭嶼鄉）的不派——沒有依據就不猜。
  -- region_id 是空的那一種是 township_gap 的缺口（補鄉鎮），這裡不碰；退選、表態未登記（considering）的人不派（狀態算不算進名冊是名單清查的事）。
  rep_gaps AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, p.id AS politician_id, p.name, p.party,
           r.region AS county, r.sub_region AS town,
           candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status,
           reg.districts, reg.parties, reg.source_url, reg.n
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN regions r ON r.id = pe.region_id AND r.village IS NULL AND r.sub_region IS NOT NULL AND r.sub_region !~ '選舉區$'
      CROSS JOIN LATERAL (
        SELECT array_agg(DISTINCT c.district ORDER BY c.district) AS districts,
               array_agg(DISTINCT c.party ORDER BY c.party) AS parties,
               min(c.source_url) AS source_url, count(*)::INTEGER AS n
          FROM cec_registrations c
          JOIN cec_registration_sources s ON s.source_url = c.source_url AND s.superseded_by IS NULL
         WHERE c.election_id = pe.election_id AND c.election_type = pe.election_type
           AND c.region = replace(r.region, '臺', '台') AND c.district IS NOT NULL
           AND replace(c.sub_region, '臺', '台') = replace(r.sub_region, '臺', '台')
           AND c.name_key = cec_name_key(p.name)
      ) reg
     WHERE pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
       AND candidacy_is_listed(pe.candidacy_status) AND reg.n > 0
  ),
  gaps AS (
    SELECT g.*,
           -- 這一屆有中選會登記彙總表（cec_registration_sources）：任務說明指去名冊，原本寫死 election_id = 2026
           EXISTS (SELECT 1 FROM cec_registration_sources rs WHERE rs.election_id = g.election_id) AS has_registry,
           -- 縣市長掛錯層級＝縣市待確認；議員、立委掛錯層級本來就算缺選區
           g.no_region OR (g.wrong_level AND g.election_type = '縣市長') AS need_region,
           CASE g.candidate_status
             WHEN 'not_running' THEN '表態不參選' WHEN 'registered' THEN '已登記' WHEN 'confirmed' THEN '表態參選'
             WHEN 'qualified' THEN '審定合格' ELSE g.candidate_status END AS status_label,
           CASE WHEN g.election_type = '立法委員'
                THEN '「第NN選區」（區域立委）；不分區或原住民立委 region 填「全國」、electoral_district 填「不分區」「平地原住民」或「山地原住民」'
                ELSE '「第NN選舉區」（例：第04選舉區）' END AS district_how
      FROM g
     WHERE g.no_region OR g.no_district OR g.wrong_level
  )
  SELECT 'auto:candidacy_source_missing:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'person_party', x.party, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'politician_election_id', x.pe_id,
                            'missing', to_jsonb(array_remove(ARRAY[CASE WHEN x.need_region THEN 'region' END,
                                                                   CASE WHEN x.no_district THEN 'electoral_district' END], NULL)),
                            'attached_to', CASE WHEN x.wrong_level THEN x.county || ' ' || x.attached_below_county END,
                            'submitted_region', sub.submitted_region,
                            'cec_listed_as', cec.listed_as, 'cec_party', cec.party),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '，' || x.status_label || '）的參選紀錄'
           || CASE WHEN x.no_region AND x.no_district THEN '沒有縣市也沒有選區'
                   WHEN x.no_region THEN '沒有縣市'
                   WHEN x.wrong_level
                   THEN '掛在「' || x.county || ' ' || x.attached_below_county || '」——'
                        || CASE WHEN x.election_type = '縣市長' THEN '縣市長的參選紀錄只該記到縣市' ELSE '那不是' || x.election_type || '的選區' END
                        || '（多半是同一個人其他選舉的地區，例如里長那一筆的村里、立委那一筆的選區）'
                   ELSE '只記到縣市、沒有選區' END
           || '，網站的' || CASE WHEN x.no_region THEN '縣市篩選撈不到他'
                                WHEN x.wrong_level AND x.election_type = '縣市長' THEN '參選地區顯示錯了'
                                WHEN x.wrong_level THEN '選區分組把他放錯地方'
                                ELSE '選區篩選撈不到他' END || '。'
           || CASE WHEN sub.submitted_region IS NOT NULL
                   THEN '【先確認是不是同一個人】建立這筆紀錄的交件寫的縣市是「' || sub.submitted_region || '」，現在卻記在「' || COALESCE(x.county, '（空的）')
                        || '」——多半是同名的另一個人被對到這位人物名下。請用登記名冊與出生年、經歷核對：是同一個人就照名冊填 region 與選區重交；'
                        || '不是同一個人就不要交 candidacy（會把別人的參選掛在他名下），改用 no_change 回報，finding 寫「掛錯人：名冊上的是' || sub.submitted_region || '的同名者」。'
                   ELSE '' END
           || CASE WHEN x.candidate_status = 'not_running'
                   THEN '這筆是「表態不參選」的紀錄，要補的是他當初被傳要選、後來表態不選的那個縣市'
                        || COALESCE('（職位欄現在寫「' || x.position || '」，可以當線索，但要附出處）', '') || '。'
                   ELSE '' END
           || '請查證後用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、region 填縣市（用「台」不用「臺」）'
           || CASE WHEN x.no_district THEN '、electoral_district 填' || x.district_how ELSE '' END
           || '，candidate_status 照現況填「' || x.candidate_status || '」（狀態本身有錯是另一件事，不要在這筆改），其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party）；'
           || CASE WHEN cec.party IS NOT NULL THEN '中選會名單上他那一屆的推薦政黨是「' || cec.party || '」。' ELSE '' END
           || 'source_urls 附看得出' || CASE WHEN x.no_district THEN '選區' ELSE '縣市' END || '的出處。'
           || CASE WHEN cec.listed_as IS NOT NULL
                   THEN '中選會選舉資料庫的名單上記的是「' || cec.listed_as || '」：請打開 db.cec.gov.tw 核對是同一個人後照填，source_urls 附你核對的那一頁。'
                   WHEN x.has_registry AND x.candidate_status <> 'not_running'
                   THEN election_year_text(x.election_id) || ' 的縣市與選區在中選會候選人登記彙總表（web.cec.gov.tw/central/article/64709，各級選舉的 PDF 逐列寫著選區）；'
                        || '已登記的要附中選會名冊或登記截止後的報導，不然交件會被擋；附名冊網址的，系統會逐位核對、吻合的一票就過。'
                   WHEN x.candidate_status = 'not_running'
                   THEN '不參選的出處通常是當事人表態或政黨提名的新聞報導。'
                   ELSE '' END
           || '查不到可信出處就用 no_change 回報你查了哪些網址，不要猜。',
         CASE WHEN x.candidate_status = 'not_running'
              THEN ARRAY['cna.com.tw', 'udn.com', 'ltn.com.tw', '政黨官網的提名公告']
              WHEN x.has_registry
              THEN ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表（逐列有選區）',
                         COALESCE(x.county, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com']
              ELSE ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會歷屆參選，回選舉區',
                         'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份}', 'cna.com.tw'] END,
         1, x.county
    FROM gaps x
    -- 中選會名單（已投票的屆別才有）上全國同名同選舉別只有一位時，把他的縣市＋選區當線索附上；同名多位就不給，免得指錯人
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*) = 1 THEN min(c.region || COALESCE(' ' || c.sub_region, '')) END AS listed_as,
             CASE WHEN count(*) = 1 THEN min(c.party) END AS party
        FROM cec_candidates c
       WHERE c.election_id = x.election_id AND c.election_type = x.election_type AND c.name_norm = cec_name_key(x.name)
    ) cec ON true
    -- 建立這筆參選紀錄的交件寫的縣市（只看建立那一次；edit_history 有 (table_name, record_id) 索引，缺口只有幾百筆）。
    -- 跟現在記的縣市一樣、交件沒寫縣市、是全國、或現在根本沒有縣市（那是「補縣市」，不是對錯人）就不提
    LEFT JOIN LATERAL (
      SELECT s.submitted_region
        FROM (SELECT translate(c.payload->>'region', '臺', '台') AS submitted_region
                FROM edit_history eh
                JOIN contributions c ON c.id = eh.contribution_id
               WHERE eh.table_name = 'politician_elections' AND eh.record_id = x.pe_id::TEXT AND eh.field = '*'
               ORDER BY eh.applied_at
               LIMIT 1) s
       WHERE x.county IS NOT NULL
         AND s.submitted_region IS NOT NULL AND s.submitted_region <> '全國'
         AND s.submitted_region <> translate(x.county, '臺', '台')
    ) sub ON true
  UNION ALL
  SELECT 'auto:candidacy_source_missing:' || y.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', y.politician_id, 'name', y.name, 'person_party', y.party, 'region', y.county, 'sub_region', y.town,
                            'election_id', y.election_id, 'election_type', y.election_type, 'candidate_status', y.candidate_status,
                            'politician_election_id', y.pe_id, 'missing', to_jsonb(ARRAY['electoral_district']),
                            'cec_districts', to_jsonb(y.districts), 'cec_party', CASE WHEN cardinality(y.parties) = 1 THEN y.parties[1] END,
                            'cec_matches', y.n, 'cec_source_url', y.source_url),
         y.name || '（' || y.county || y.town || ' ' || y.election_id || ' ' || y.election_type || '，'
           || CASE y.candidate_status WHEN 'registered' THEN '已登記' WHEN 'qualified' THEN '審定合格' WHEN 'confirmed' THEN '表態參選' ELSE y.candidate_status END
           || '）的參選紀錄只記到鄉鎮、沒有選舉區。代表的號次是按選舉區各自從 1 編起的，沒有選舉區，系統就沒辦法檢查同一區的號次有沒有重複或跳號。'
           || CASE WHEN y.n = 1
                   THEN '中選會登記彙總表上他那一列寫的選舉區是「' || y.districts[1] || '」（政黨「' || y.parties[1] || '」）。'
                   ELSE '中選會登記彙總表上同鄉鎮有 ' || y.n || ' 位同名的，選舉區分別是 ' || array_to_string(y.districts, '、')
                        || '，請用政黨（' || array_to_string(y.parties, '、') || '）、出生年分辨哪一位是他，不能確定就不要交。' END
           || '請打開名冊核對後用 candidacy 型別重交同一人同一屆：politician_id 填「' || y.politician_id || '」、election_id 填 ' || y.election_id
           || '、election_type 填「' || y.election_type || '」、region 填「' || y.county || '」、sub_region 填「' || y.town
           || '」（鄉鎮市區名，不要把選舉區寫在這裡）、electoral_district 填「第NN選舉區」（例：第04選舉區），candidate_status 照現況填「' || y.candidate_status
           || '」（狀態本身有錯是另一件事，不要在這筆改）；其餘欄位不用帶，party 不要照抄他現在的政黨——人會換黨。'
           || 'source_urls 第一個放這份名冊：' || y.source_url || '——系統會逐位核對名冊上的姓名、縣市、鄉鎮、政黨與選舉區，對得上的一張同意就通過。'
           || '名冊上對不起來（姓名、鄉鎮、政黨有一項不同）就不要交，用 no_change 回報你看到什麼，不要猜。',
         ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表（逐列有選舉區）', y.county || '選舉委員會官網的登記公告'],
         1, y.county
    FROM rep_gaps y
$$;
COMMENT ON FUNCTION contribution_auto_tasks_region_gap IS '縣市長／縣市議員／立委：參選紀錄缺縣市（region_id 空）、缺選區（議員、立委只到縣市層級）、或掛錯層級（村里、鄉鎮、別種選舉的選區），沿用 candidacy_source_missing 型別；建立時交件的縣市跟現在不同會在說明裡講出來（2026-10-05）；2026-10-06 起其餘欄位照那一屆的名冊填、不叫代理照抄現在的政黨（target.person_party 只供對照、cec_party 是那一屆的推薦政黨）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result｜#464（2026-10-09）：另派鄉鎮市民代表、區民代表「只記到鄉鎮、沒有選舉區」的參選紀錄——中選會登記彙總表（cec_registrations）上找得到他、那一列有選舉區才派，target.cec_districts 附名冊的選舉區';

-- ------------------------------------------------------------
-- 2. township_gap（前一版 20261006220000；只做檔頭列的替換）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_township_gap()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:candidacy_source_missing:' || pe.id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'person_party', p.party, 'region', p.region,
                            'election_id', pe.election_id, 'election_type', pe.election_type, 'candidate_status', candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE))),
         CASE WHEN pe.election_type = '村里長' THEN
           p.name || '（' || COALESCE(p.region, '') || ' ' || pe.election_id || ' 村里長候選人）的參選紀錄少了鄉鎮市區與村里，網站沒辦法把他放進正確的村里頁。'
             || '請查這個人的登記資料，確認他參選的鄉鎮市區與村里，用 candidacy 型別重交同一人同一屆：region 填「' || COALESCE(p.region, '')
             || '」、sub_region 填鄉鎮市區、village 填村里名，candidate_status 照現況，其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party），'
             || 'source_urls 附名冊或登記公告網址（中選會名冊系統會逐位核對、吻合的一票就過）。'
         ELSE
           p.name || '（' || COALESCE(p.region, '') || ' ' || pe.election_id || ' ' || pe.election_type || '候選人）的參選紀錄少了鄉鎮市區，網站沒辦法把他放進正確的鄉鎮頁。'
             || '請查這個人的登記資料，確認他參選的鄉鎮市區，用 candidacy 型別重交同一人同一屆：region 填「' || COALESCE(p.region, '')
             || '」、sub_region 填鄉鎮市區，candidate_status 照現況，其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party），source_urls 附名冊或登記公告網址（中選會名冊系統會逐位核對、吻合的一票就過）。'
         END,
         ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表', COALESCE(p.region, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'],
         1, p.region
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  WHERE pe.election_id = (SELECT campaign_election_id())  -- 當屆（原本寫死 2026）
    AND pe.election_type IN ('鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
    AND pe.region_id IS NULL
    AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
    AND p.merged_into IS NULL
$$;
COMMENT ON FUNCTION contribution_auto_tasks_township_gap IS '2026 鄉鎮層級五種選舉的參選紀錄缺鄉鎮（村里長缺村里），沿用 candidacy_source_missing；2026-10-06 起其餘欄位照那一屆的名冊填、不叫代理照抄現在的政黨｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

-- ------------------------------------------------------------
-- 3. roster_villages（前一版 20261008170000；只做檔頭列的替換）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_roster_villages()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    -- roc_year：名冊標題的民國年（原本寫死 115）
    SELECT sc.*, (EXTRACT(YEAR FROM e.election_date)::INTEGER - 1911) AS roc_year
      FROM roster_check_scope sc JOIN elections e ON e.id = sc.election_id
     WHERE sc.election_type = '村里長' AND sc.enabled
  ),
  towns AS (
    SELECT DISTINCT replace(a.region, '臺', '台') AS county, a.township
    FROM electoral_district_areas a
    WHERE a.township IS NOT NULL AND btrim(a.township) <> ''
  ),
  ours AS (
    SELECT pe.election_id, per.region AS county, per.sub_region AS township, COUNT(*) AS n
    FROM politician_elections pe
    JOIN regions per ON per.id = pe.region_id
    WHERE pe.election_id IN (SELECT s.election_id FROM s) AND pe.election_type::TEXT = '村里長'  -- 清查範圍那幾屆（原本寫死 2026）
    GROUP BY 1, 2, 3
  )
  SELECT 'auto:roster_check:' || s.election_id || ':' || t.county || t.township || ':村里長',
         'roster_check',
         jsonb_build_object('election_id', s.election_id, 'region', t.county || t.township, 'county', t.county, 'township', t.township,
                            'election_type', '村里長', 'ours_count', COALESCE(o.n, 0), 'last_checked', rc.last_checked,
                            'last_failed_attempt', rc.last_attempt_without_count, 'list_announced_on', s.list_announced_on,
                            'official_list_published', CURRENT_DATE >= s.list_announced_on),
         t.county || t.township || ' ' || s.election_id || ' 村里長的名單需要清查。請找這個鄉鎮市區的村里長候選人登記名單'
           || '（中選會「' || s.roc_year || ' 年村里長選舉候選人登記彙總表」PDF，或' || t.county || '選舉委員會的登記公告），跟我們現有的 '
           || COALESCE(o.n, 0) || ' 筆比對。名單上有、我們沒有的，每位用 candidacy 型別補一筆：region 填「' || t.county
           || '」、sub_region 填「' || t.township || '」、village 填村里名、election_type 填村里長、candidate_status 填 registered，'
           || 'source_urls 附名冊網址（中選會 web.cec.gov.tw/api/file/…pdf 的名冊系統會逐位核對、吻合的一票就過）；一次最多 150 筆（整批都是 candidacy、source_urls 放這份名冊、每一筆都跟名冊逐位吻合才收；其他型別一次最多 20 筆），可分多次交。'
           || '最後用 roster_check 回報：election_id、region、election_type 三欄照任務 target 原樣帶回（region 就是「' || t.county || t.township
           || '」這一串），cec_count 填這個鄉鎮市區名冊上的人數。查不到名冊就不要猜：roster_check 的 cec_count 留空、note 寫你查了哪些網址。',
         ARRAY['web.cec.gov.tw ' || s.roc_year || ' 年村里長選舉候選人登記彙總表', t.county || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'],
         2, t.county
  FROM s
  CROSS JOIN towns t
  LEFT JOIN ours o ON o.election_id = s.election_id AND o.county = t.county AND o.township = t.township
  LEFT JOIN LATERAL (
    SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count
    FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = t.county || t.township AND x.election_type = '村里長'
  ) rc ON TRUE
  WHERE (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
    AND (rc.last_attempt_without_count IS NULL
         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_roster_villages IS
  '村里長名單清查：一個鄉鎮市區一筆任務（region＝縣市＋鄉鎮市區），清單取自 electoral_district_areas（2026-10-04）';

-- ------------------------------------------------------------
-- 4. term_policies（前一版 20261011030000；只做檔頭列的替換）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_term_policies()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH pb AS (SELECT * FROM politician_bulletins),
  elected AS (
    -- 原本的對象：當選人，公報推不推得出來都派
    SELECT DISTINCT ON (pe.politician_id, pe.election_id)
           pe.politician_id, pe.election_id, pe.election_type, 'elected'::TEXT AS result,
           COALESCE(r.region, p.region) AS region, 0 AS pri
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id
      LEFT JOIN regions r ON r.id = pe.region_id
      JOIN election_task_config cfg ON cfg.election_id = pe.election_id AND cfg.enabled AND pe.election_type = ANY (cfg.positions)
     WHERE p.merged_into IS NULL
       AND pe.candidacy_status = 'elected'
     ORDER BY pe.politician_id, pe.election_id, pe.election_type
  ),
  from_bulletin AS (
    -- 推得出公報的參選人：結果以我們的紀錄為準，沒有就照中選會名單
    SELECT DISTINCT ON (b.politician_id, b.election_id)
           b.politician_id, b.election_id, b.election_type,
           COALESCE(b.election_result, CASE WHEN b.elected THEN 'elected' WHEN b.elected = false THEN 'not_elected' END) AS result,
           b.region, 1 AS pri
      FROM pb b
      JOIN election_task_config cfg ON cfg.election_id = b.election_id AND cfg.enabled
     ORDER BY b.politician_id, b.election_id, (b.election_type = '村里長'), b.election_type
  ),
  i0 AS (
    SELECT DISTINCT ON (u.politician_id, u.election_id) u.*
      FROM (SELECT * FROM elected UNION ALL SELECT * FROM from_bulletin) u
     ORDER BY u.politician_id, u.election_id, u.pri
  ),
  i AS (
    SELECT 'auto:term_policy_missing:' || i0.politician_id || ':' || i0.election_id AS tid,
           i0.politician_id, i0.election_id, i0.election_type, i0.result, i0.region,
           p.name, p.party, b.urls, b.cand_no, COALESCE(b.elected, i0.result = 'elected') AS is_elected,
           concat_ws(' ', b.region, NULLIF(b.sub_region, ''), NULLIF(b.village, '')) AS unit
      FROM i0
      JOIN politicians p ON p.id = i0.politician_id
      LEFT JOIN pb b ON b.politician_id = i0.politician_id AND b.election_id = i0.election_id AND b.election_type = i0.election_type
     WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = i0.politician_id AND pl.election_id = i0.election_id AND pl.removed_at IS NULL)
       -- 去重：零政見的 2026 候選人留給 policy_missing（跟 raw 臂 c2026 同條件）
       -- 只在 2026 還沒投票時去重（OPS #81）：當屆缺政見投票日就收，投票隔天起零政見的 2026 參選人改由這支接手，不然兩邊都不派
       AND (NOT EXISTS (SELECT 1 FROM politician_elections c JOIN elections ce ON ce.id = c.election_id WHERE c.politician_id = i0.politician_id AND c.election_id = (SELECT campaign_election_id()) AND ce.election_date >= activity_today() AND c.candidacy_status IS DISTINCT FROM 'withdrawn')
            OR EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = i0.politician_id AND pl.removed_at IS NULL))
  ),
  village AS (
    -- 村里長限量：已經開出去的照舊，空位依「當選人先、再依地區」遞補
    SELECT v.* FROM (
      SELECT w.*, count(*) FILTER (WHERE w.live) OVER () AS live_n,
             row_number() OVER (PARTITION BY w.live ORDER BY w.is_elected DESC, w.unit, w.cand_no, w.politician_id) AS rn
        FROM (SELECT i.*, EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = i.tid) AS live
                FROM i WHERE i.election_type = '村里長') w
    ) v
     WHERE v.live OR v.rn <= GREATEST(term_policy_village_cap() - v.live_n, 0)
  ),
  picked AS (
    SELECT tid, politician_id, election_id, election_type, result, region, name, party, urls, cand_no, is_elected, unit FROM i WHERE election_type <> '村里長'
    UNION ALL
    SELECT tid, politician_id, election_id, election_type, result, region, name, party, urls, cand_no, is_elected, unit FROM village
  )
  SELECT x.tid, 'term_policy_missing',
         jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'party', x.party, 'region', x.region,
                            'election_id', x.election_id, 'election_type', x.election_type, 'election_result', x.result)
           || CASE WHEN x.urls IS NOT NULL
                   THEN jsonb_build_object('bulletin_urls', to_jsonb(x.urls), 'cand_no', x.cand_no, 'bulletin_unit', x.unit)
                   ELSE '{}'::JSONB END,
         x.name || '（' || COALESCE(x.region, '') || ' ' || x.election_id || ' ' || x.election_type
           || CASE x.result WHEN 'elected' THEN '當選' WHEN 'not_elected' THEN '參選，未當選' ELSE '參選' END || '）'
           || '沒有任何 ' || x.election_id || ' 這一屆的政見。'
           || CASE WHEN x.urls IS NOT NULL THEN
                '**這一屆的中選會選舉公報已經找到了**：' || x.urls[1]
                || CASE WHEN cardinality(x.urls) > 1 THEN '（共 ' || cardinality(x.urls) || ' 份，見 target.bulletin_urls；正反面或分份，他在其中一份上）' ELSE '' END
                || '，他在公報上是**號次 ' || COALESCE(x.cand_no::TEXT, '？') || '**（' || x.unit || '）。'
                || '請打開公報，依姓名與號次找到他自己那一欄——公報常是圖片版，要裁切放大核對，不要看成隔壁候選人的——'
                || '把那一欄的政見**逐條**交成 policy：每條一筆、election_id 填 ' || x.election_id || '、status 填 Campaign Pledge、'
                || 'source_urls 放這份公報網址、note 寫「公報第幾頁、號次 ' || COALESCE(x.cand_no::TEXT, '？') || '、第幾點」。'
                || '公報上列幾條就交幾條，一次交完（第一筆上線後這個任務就會關）；只有口號、標語或「為民服務」這種沒有具體內容的不交。'
                || '那一欄真的是空白或只有口號，回 no_change＋outcome=not_found，checked_urls 附這份公報與你另外查過的頁面，finding 寫公報那一欄寫了什麼。'
              ELSE
                '請找他**那一屆的競選政見**：最多 5 筆、每筆一個 policy 型別、各附自己的出處；'
                || 'election_id 填 ' || x.election_id || '，status 填 Campaign Pledge（競選承諾，之後會有任務追「兌現了沒」）。'
                || '**首選中選會選舉公報**——每位候選人登記的政見原文都印在公報上（見 hint_sources 的入口，依縣市、選舉別、選舉區找 PDF）；'
                || '其次本人官網／臉書的競選政見頁、當年的新聞。'
                || '找到幾筆交幾筆，不要為了湊數交標語、口號、願景或個人表態——那些不是政見。'
              END
           || '先看 current.queued_policies 與既有政見，別人交了還在等票的不要再交；' || COALESCE(cfgx.scope_note, '任內才宣布的施政、之後新提出的政見不是這一屆的競選政見。'),
         CASE WHEN x.urls IS NOT NULL THEN
           ARRAY(SELECT u || ' ← 中選會 ' || x.election_id || ' 選舉公報（號次 ' || COALESCE(x.cand_no::TEXT, '？') || '，' || x.unit || '）' FROM unnest(x.urls) AS u)
           || ARRAY['候選人當年的官網／臉書競選政見頁', 'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）']
         ELSE
           ARRAY[COALESCE(cfgx.bulletin_hint,
                          'https://eebulletin.cec.gov.tw/ ← 中選會 ' || x.election_id || '（' || cfgx.bulletin_roc_year || ' 年）選舉公報：地方選舉在這個站，點到縣市、選舉別、選舉區 PDF，候選人登記的政見原文在上面；中央選舉的公報在 https://bulletin.cec.gov.tw/'),
                 '候選人當年的官網／臉書競選政見頁',
                 'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）',
                 'cna.com.tw']
         END,
         1, x.region
    FROM picked x
    JOIN election_task_config cfgx ON cfgx.election_id = x.election_id
$$;
COMMENT ON FUNCTION contribution_auto_tasks_term_policies IS '補該屆政見（term_policy_missing）：設定表 election_task_config 開著（enabled）的屆別——當選人（職位在該屆的 positions 裡；2026-10-07 起讀設定表，種子是原本寫死的 2022 縣市長／縣市議員／鄉鎮市長、2024 立委）沒有那一屆的政見，或推得出選舉公報的參選人（含落選、村里長、代表、原住民區長／區民代表；村里長一次最多 term_policy_village_cap() 件）沒有那一屆的政見；推得出公報就把公報網址與號次放進 target。零政見的 2026 候選人留給 policy_missing。2026-10-02 起、10-06 擴充｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄｜2026-10-07：屆別、職位、公報入口改讀 election_task_config';

-- ------------------------------------------------------------
-- 5. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF campaign_election_id() IS NULL THEN
    RAISE EXCEPTION '當屆選舉算不出來：elections 沒有任何定期選舉（election_reason＝regular）';
  END IF;
END;
$$;
