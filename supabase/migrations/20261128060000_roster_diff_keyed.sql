-- 20261128060000_roster_diff_keyed.sql
-- 派工臂事件驅動化 第 2 期 PR-3：roster_diff_findings(p_keys) 底下七支臂函式真的只算指定單位
--
-- 為什麼：
--   PR-2（20261127093000）把 p_keys 推進 roster_diff_findings()，但七支臂函式（party_roster、party_gap、township_gap、region_gap、
--   owner_mismatch、elected_missing、election_results）沒有單位參數，每次整支跑，只在合併後過濾。正式庫實測：每小時探針
--   roster_unit_findings 單獨呼叫 7～9 秒（總表 arms_all 13～22 秒裡最大的一塊，因為總表的 fnd／gapu CTE 每輪整表跑它）；
--   gap_drain 的名單族按鍵重算也付同樣的固定成本。
--
-- 做法（輸出不變）：
--   七支臂各複製一支帶鍵的孿生函式 contribution_auto_tasks_<臂>_keyed(p_keys TEXT[] DEFAULT NULL)，本體＝原臂函式＋鍵過濾，
--   鍵過濾放在輸入端（先把單位鍵拆成選舉別、職位，到來源表挑出該單位的參選紀錄，再往下做 LATERAL、EXISTS、整批比對），不是算完再濾。
--   p_keys 為 NULL＝整表，與原臂函式逐列相同。roster_diff_findings(p_keys) 改呼叫孿生函式。
--   **原臂函式（無參數版）一個字都沒動**：派工總表（contribution_auto_tasks_arms／_tail）、各種守門測試、系統票與驗證項仍用它們；
--   不 DROP 舊簽名，所以沒有「舊簽名被 DROP、呼叫者還在用」的空窗，也不需要分兩次上。
--   代價是兩份本體要一起維護：之後改七支原臂函式，孿生函式要同步改（roster-diff-keyed.test.ts 把孿生本體倒回去，必須與原臂最新定義一字不差）。
--
-- 七支各自的判斷：
--   party_roster、party_gap、township_gap、region_gap（含代表選舉區那一段）
--       以參選紀錄為單位，輸出列只依賴自己那一筆參選紀錄與查詢用的表 → 輸入端 pe.id 過濾（鍵→參選紀錄在 roster_diff_keyed_pe_ids，
--       鍵的組法與 roster_diff_findings 的 b／pe_f 完全相同：選舉、縣市＋roster_unify_town、職位）。
--   owner_mismatch
--       同上；它的訊號函式 candidacy_owner_mismatch_signals() 整表算（含 ① 中選會名冊整批連接），所以另做孿生
--       candidacy_owner_mismatch_signals_keyed(p_keys)：五種訊號各自只算指定單位（③ 相隔一屆換縣市看的是同一人的另一筆，但輸出的 id 是後一筆，
--       只以後一筆的單位過濾，另一筆照舊讀整表）。
--   elected_missing
--       輸出是「中選會當選名單有、我們沒有」的列，單位＝選舉、縣市、職位（town 空）；在 missing 輸入端用單位鍵過濾，
--       ours（我們已有的）只取涉及的（選舉, 職位）；same_name 在 missing 為空時整個略過。
--   election_results（結果類，成本最大的一支）
--       整批件（auto:election_results_missing）依「選舉、職位、縣市、鄉鎮（只有村里長、鄉鎮市民代表、原住民區民代表有）」分組、每 120 位拆一件，
--       任務編號帶 :pN；分組的粒度與 roster_diff_findings 的單位粒度一致，所以先依單位鍵挑出參選紀錄（roster_diff_result_pe_ids，
--       縣市、鄉鎮的算法與 election_result_cec_matches 相同），整個單位的人一起進來，分件與任務編號與整表版逐位相同；
--       「我們標的跟中選會相反」那一段（auto.mismatch）另外依單位過濾。election_result_cec_matches 因此只算該單位，不再對全部未投票的參選紀錄各探一次。
--   刻意維持整表的：沒有。七支都能以單位過濾而輸出不變。已確認的跨單位依賴只有兩處，都不影響輸出列：
--       ① owner_mismatch 的 same_name（同名他人）、other_records（同人其他屆）是單列附帶的線索，讀整表；
--       ② election_results 的分件編號只在單位內（見上）。
--   roster_region_mismatch_findings()（縣市長縣市不符）沒動：本來就只算 2026 縣市長。
--
-- 風險與回滾：
--   * 只加函式、CREATE OR REPLACE roster_diff_findings(同一個簽名)，沒有表、觸發器、排程；輸出由 roster-diff-keyed.test.ts 對 PR-2 版（_legacy）雙向 EXCEPT 驗為 0。
--   * 每日呼叫量變化：0（不新增排程、觸發器或對外呼叫）。
--   * 回滾：把 roster_diff_findings(TEXT[]) 換回 20261127093000 第 2 節的定義（七支臂改回無參數版），再
--       DROP FUNCTION contribution_auto_tasks_party_roster_keyed(TEXT[]), contribution_auto_tasks_party_gap_keyed(TEXT[]),
--         contribution_auto_tasks_township_gap_keyed(TEXT[]), contribution_auto_tasks_region_gap_keyed(TEXT[]),
--         contribution_auto_tasks_owner_mismatch_keyed(TEXT[]), contribution_auto_tasks_elected_missing_keyed(TEXT[]),
--         contribution_auto_tasks_election_results_keyed(TEXT[]), candidacy_owner_mismatch_signals_keyed(TEXT[]),
--         roster_diff_keyed_pe_ids(TEXT[]), roster_diff_result_pe_ids(TEXT[]), roster_key_scopes(TEXT[]);
--     （其他函式不依賴孿生函式，換回 roster_diff_findings 之後再 DROP 即可，兩步在同一個交易裡做）。

-- ------------------------------------------------------------
-- 1. 鍵 → 參選紀錄（單位鍵的拆解與挑選，全部集中在這三支）
-- ------------------------------------------------------------
-- 鍵（unit:<選舉>:<縣市＋鄉鎮>:<職位>）涉及哪些（選舉, 職位）；不是 unit: 開頭的鍵（seats:、ballot:）不會進來，忽略
CREATE OR REPLACE FUNCTION roster_key_scopes(p_keys TEXT[])
RETURNS TABLE (election_id INTEGER, election_type TEXT)
LANGUAGE sql IMMUTABLE AS $$
  SELECT DISTINCT split_part(k, ':', 2)::INTEGER, regexp_replace(k, '^.*:', '')
    FROM unnest(p_keys) AS k
   WHERE k ~ '^unit:[0-9]{1,9}:.*:[^:]+$'
$$;

-- 單位鍵 → 參選紀錄 id：鍵的組法同 roster_diff_findings 的 b／pe_f（縣市取參選紀錄的 region，沒有才取人物的；鄉鎮只看參選紀錄那一列的 sub_region；
-- 是否已投票看投票日）。先用（選舉, 職位）縮小，再用完整鍵比對
CREATE OR REPLACE FUNCTION roster_diff_keyed_pe_ids(p_keys TEXT[])
RETURNS TABLE (id INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT pe.id
    FROM roster_key_scopes(p_keys) sc
    JOIN politician_elections pe ON pe.election_id = sc.election_id AND pe.election_type = sc.election_type
    JOIN politicians p ON p.id = pe.politician_id
    JOIN elections e ON e.id = pe.election_id
    LEFT JOIN regions r ON r.id = pe.region_id
   WHERE dispatch_gap_roster_unit_key(pe.election_id,
           replace(COALESCE(r.region, p.region), '臺', '台') || roster_unify_town((e.election_date < CURRENT_DATE), pe.election_type, r.sub_region),
           pe.election_type) = ANY (p_keys)
$$;

-- 結果類用的單位鍵 → 參選紀錄 id：縣市、鄉鎮的算法同 election_result_cec_matches（鄉鎮取參選紀錄那一列，沒有才取人物的，去掉選舉區字尾），
-- 單位鍵同 roster_diff_findings 的 er_f（已投票屆，roster_unify_town(true, …)）
CREATE OR REPLACE FUNCTION roster_diff_result_pe_ids(p_keys TEXT[])
RETURNS TABLE (id INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT pe.id
    FROM roster_key_scopes(p_keys) sc
    JOIN politician_elections pe ON pe.election_id = sc.election_id AND pe.election_type = sc.election_type
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
   WHERE dispatch_gap_roster_unit_key(pe.election_id,
           replace(COALESCE(r.region, p.region), '臺', '台')
             || roster_unify_town(true, pe.election_type,
                  CASE WHEN pe.election_type IN ('鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                       THEN NULLIF(replace(regexp_replace(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.sub_region END, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), '')
                  END),
           pe.election_type) = ANY (p_keys)
$$;

-- ------------------------------------------------------------
-- 2. 七支臂的帶鍵孿生函式（本體＝原臂最新定義＋鍵過濾；p_keys 為 NULL＝整表）
-- ------------------------------------------------------------

-- 2.1 party_roster（原：20261008121000）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_roster_keyed(p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    -- candidate_status＝交件協議的詞（派工說明「照現況填」那一句用），由 candidacy_status 換算，不是舊欄位
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status,
           p.id AS politician_id, p.name, p.party AS person_party,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county, r.sub_region
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
      -- 投票日當天之前才派：移到規則（activity_rules「party_roster」：到投票日 +0 為止，P2 20261008121000）；這裡不再比日期
      LEFT JOIN regions r ON r.id = pe.region_id
     -- 還沒投票的屆別、已登記（名冊上才有他）、我們不知道這一次的政黨
     WHERE pe.party_basis IS NULL AND pe.candidacy_status = 'filed'
       AND (p_keys IS NULL OR pe.id IN (SELECT k.id FROM roster_diff_keyed_pe_ids(p_keys) k))
  ),
  x AS (
    SELECT g.*,
           (SELECT array_agg(v.list_url ORDER BY v.sort, v.id) FROM verification_sources v
             WHERE v.kind = 'cec' AND v.status = 'ok' AND v.list_url IS NOT NULL AND 'roster' = ANY (v.provides)
               AND g.election_type = ANY (v.election_types) AND g.county = ANY (v.regions)) AS rosters
      FROM g
     -- 已經有人交了這一人這一屆的 candidacy 還在等票的先不派
     WHERE NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'politician_id' = g.politician_id::TEXT AND c.payload->>'election_id' = g.election_id::TEXT)
  )
  SELECT 'auto:candidacy_source_missing:party:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('kind', 'party_roster', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'missing', jsonb_build_array('party'), 'person_party', x.person_party,
                            'rosters', to_jsonb(x.rosters)),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '，已登記）這一次參選的政黨我們不知道——'
           || '網站只看得到他現在登記的政黨（「' || COALESCE(x.person_party, '空的') || '」），參選紀錄要記的是這一次登記時的推薦政黨。'
           || '這一屆還沒投票，中選會選舉資料庫還沒有名單：請打開中選會候選人登記彙總表'
           || COALESCE('（' || array_to_string(x.rosters, '、') || '）', '（web.cec.gov.tw/central/article/64709）')
           || '找到他那一列，用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、name 填「' || x.name
           || '」、election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、region 填「' || COALESCE(x.county, '') || '」'
           || CASE WHEN x.election_type = '縣市議員' THEN '、electoral_district 填名冊上的選舉區' ELSE '' END
           || '、party 照那一列的「推薦之政黨」原字填（寫「無」就填「無」，不要填他現在的政黨）、candidate_status 照現況填「' || COALESCE(x.candidate_status, '') || '」；'
           || 'source_urls 第一個放那份登記彙總表：系統會逐位核對名冊上的姓名、縣市、政黨，吻合的一票就過。名冊上找不到他就用 no_change 回報，不要猜。',
         COALESCE(x.rosters, ARRAY[]::TEXT[]) || ARRAY['https://web.cec.gov.tw/central/article/64709 ← 中選會各級選舉候選人登記彙總表'],
         1, x.county
    FROM x
$$;

-- 2.2 party_gap（原：20261019100000）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_gap_keyed(p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    -- candidate_status＝交件協議的詞（派工說明「照現況填」那一句用），由 candidacy_status 換算，不是舊欄位
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status,
           p.id AS politician_id, p.name, p.party AS person_party,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
      -- 投票日之後才派：移到規則（activity_rules「party_gap」：投票日 +1 起，P2 20261008120000）；這裡不再比日期
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.party_basis IS NULL
       AND (p_keys IS NULL OR pe.id IN (SELECT k.id FROM roster_diff_keyed_pe_ids(p_keys) k))
       -- 中選會名冊唯一對上而且那個選區已開完的，由系統直接寫（cec_results_auto_apply，party_basis＝cec），不派代理
       AND pe.id NOT IN (SELECT a.politician_election_id FROM cec_results_auto_plan() a WHERE a.write_party)
  ),
  m AS (
    -- 中選會名單上同屆、同選舉別、同縣市、同名只有一位（同名多位不派，免得指錯人）；名冊的政黨寫法要對得到（對不到的看 party_alias_gaps）
    SELECT g.*, c.name AS cec_name, c.region AS cec_region, c.sub_region AS cec_sub_region, c.village AS cec_village,
           c.party AS cec_party, c.cand_no, c.elected, c.cec_cand_id, c.cec_theme_id,
           a.party_id AS cec_party_id, a.kind = 'independent' AS cec_independent, pt.name AS cec_party_name
      FROM g
      JOIN LATERAL (
        SELECT x.*, count(*) OVER () AS n
          FROM cec_candidates x
         WHERE x.election_id = g.election_id AND x.election_type = g.election_type
           AND replace(x.region, '臺', '台') = g.county AND x.name_norm = cec_name_key(g.name)
      ) c ON c.n = 1
      JOIN party_aliases a ON a.alias_key = party_alias_key(c.party)
      LEFT JOIN parties pt ON pt.id = a.party_id
  ),
  x AS (
    SELECT m.*,
           -- candidacy 的地區欄位：照中選會那一筆填（跟 roster_cec_gap 同一套；縣市議員沒帶選舉區交件會被退回）
           CASE
             WHEN m.election_type = '村里長'
               THEN jsonb_build_object('region', m.county, 'sub_region', m.cec_sub_region, 'village', m.cec_village)
             WHEN m.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
               THEN jsonb_build_object('region', m.county, 'sub_region', NULLIF(regexp_replace(COALESCE(m.cec_sub_region, ''), '(第[0-9]+)?選舉區$', ''), ''))
             WHEN m.election_type IN ('鄉鎮市長', '直轄市山地原住民區長')
               THEN jsonb_build_object('region', m.county, 'sub_region', m.cec_sub_region)
             WHEN m.election_type IN ('縣市議員', '立法委員')
               THEN jsonb_build_object('region', m.county, 'electoral_district', m.cec_sub_region)
             ELSE jsonb_build_object('region', m.county)
           END AS fill,
           CASE WHEN m.elected THEN 'elected' ELSE 'not_elected' END AS cec_result
      FROM m
     -- 已經有人交了這一人這一屆的 candidacy 還在等票的先不派（落庫時就會寫政黨；退件了就會再派）
     WHERE NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'politician_id' = m.politician_id::TEXT AND c.payload->>'election_id' = m.election_id::TEXT)
  )
  SELECT 'auto:candidacy_source_missing:party:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('kind', 'party', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'missing', jsonb_build_array('party'),
                            'person_party', x.person_party,
                            'fill', x.fill,
                            'cec', jsonb_build_object('name', x.cec_name, 'region', x.cec_region, 'sub_region', x.cec_sub_region, 'village', x.cec_village,
                                                      'party', x.cec_party, 'cand_no', x.cand_no, 'elected', x.elected, 'election_result', x.cec_result,
                                                      'cec_cand_id', x.cec_cand_id, 'cec_theme_id', x.cec_theme_id),
                            'cec_party', jsonb_build_object('text', x.cec_party, 'party_id', x.cec_party_id, 'party_name', x.cec_party_name,
                                                            'independent', x.cec_independent)),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '）這一次參選的政黨我們不知道——'
           || '網站只看得到他現在登記的政黨（「' || COALESCE(x.person_party, '空的') || '」），過去的參選要記當時的政黨，人會換黨。'
           || '中選會名冊上這一屆的他（' || COALESCE(x.cec_region || COALESCE(' ' || x.cec_sub_region, '') || COALESCE(' ' || x.cec_village, ''), '')
           || COALESCE('，號次 ' || x.cand_no, '') || '，' || CASE WHEN x.elected THEN '當選' ELSE '落選' END
           || '）推薦政黨記的是「' || x.cec_party || '」'
           || CASE WHEN x.cec_independent THEN '（無黨籍）' WHEN x.cec_party_name IS NOT NULL AND x.cec_party_name <> x.cec_party THEN '（＝' || x.cec_party_name || '）' ELSE '' END || '。'
           || '請打開中選會選舉資料庫核對是同一個人後，用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、name 填「' || x.name
           || '」、election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、地區照 target.fill 填'
           || '、party 照名冊填「' || x.cec_party || '」（不要填他現在的政黨）、candidate_status 照現況填「' || COALESCE(x.candidate_status, '') || '」'
           || '、election_result 照中選會填 ' || x.cec_result || '；source_urls 附你核對的中選會頁面。'
           || '系統會拿中選會的資料自動核對：我們只有一位同名、當選與否與推薦政黨都對得上就直接上線。'
           || '名冊上的不是同一個人（同名同姓）就不要交 candidacy，改用 no_change 回報、finding 寫「掛錯人」；查不到就用 no_change 說明你查了哪些網址。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name || ' ← 中選會歷屆參選（含推薦政黨、當選與否）',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || x.name || '","electionId":' || x.election_id || '}',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, x.county
    FROM x
$$;

-- 2.3 township_gap（原：20261011310000）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_township_gap_keyed(p_keys TEXT[] DEFAULT NULL)
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
    AND (p_keys IS NULL OR pe.id IN (SELECT k.id FROM roster_diff_keyed_pe_ids(p_keys) k))
$$;

-- 2.4 region_gap（原：20261011310000；縣市長／議員／立委缺縣市選區，加代表只記到鄉鎮的選舉區）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_region_gap_keyed(p_keys TEXT[] DEFAULT NULL)
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
       AND (p_keys IS NULL OR pe.id IN (SELECT k.id FROM roster_diff_keyed_pe_ids(p_keys) k))
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
       AND (p_keys IS NULL OR pe.id IN (SELECT k.id FROM roster_diff_keyed_pe_ids(p_keys) k))
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

-- 2.5 owner_mismatch 的訊號函式（原：20261019010000 的 candidacy_owner_mismatch_signals()；五種訊號各自只算指定單位的參選紀錄）
CREATE OR REPLACE FUNCTION candidacy_owner_mismatch_signals_keyed(p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE (politician_election_id INTEGER, signal TEXT, detail TEXT)
LANGUAGE sql STABLE AS $$
  WITH kp AS MATERIALIZED (SELECT k.id FROM roster_diff_keyed_pe_ids(p_keys) k),
  pe AS (
    SELECT pe.id, pe.politician_id, pe.election_id, pe.election_type, e.election_date, p.name, p.birth_year,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
      LEFT JOIN regions r ON r.id = pe.region_id
  ),
  -- ①中選會名冊唯一對上的那一列，出生年跟人物不同
  -- 20261019010000（policy-ops#136）：原本把 1.6 萬筆參選紀錄 id 全部丟進 election_result_cec_matches(ARRAY(…))，函式本體對每筆逐列 LATERAL 探索引
  -- （正式庫實測 1.05 秒、195,690 個緩衝區），而這裡只要「唯一對上、而且出生年不同」的那 2 筆。改成同一組比對條件的整批連接：
  -- 規則一字不改地照 election_result_cec_matches（同屆、同選舉、同縣市、cec_name_key 同名；有鄉鎮、村里就一起對），
  -- 對上的筆數 = 1 才算（cec_hits = 1），出生年取那一筆的。
  cec AS (
    SELECT x.id, min(cc.birth_year) AS cec_birth_year
      FROM (
        SELECT pe.id, pe.election_id, pe.election_type,
               replace(COALESCE(r.region, p.region), '臺', '台') AS county,
               cec_name_key(p.name) AS nn,
               CASE WHEN pe.election_type IN ('鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                    THEN NULLIF(regexp_replace(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.sub_region END, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '')
               END AS town,
               CASE WHEN pe.election_type = '村里長'
                    THEN NULLIF(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.village END, p.village, ''), '')
               END AS village
          FROM politician_elections pe
          JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
          JOIN elections e ON e.id = pe.election_id
          LEFT JOIN regions r ON r.id = pe.region_id
         WHERE p.birth_year IS NOT NULL
           AND (p_keys IS NULL OR pe.id IN (SELECT id FROM kp))
      ) x
      JOIN cec_candidates cc
        ON cc.election_id = x.election_id AND cc.election_type = x.election_type
       AND cc.region = x.county AND cc.name_norm = x.nn
       AND (x.town IS NULL OR regexp_replace(COALESCE(cc.sub_region, ''), '(第[0-9]+)?選舉區$', '') = x.town)
       AND (x.village IS NULL OR cc.village = x.village)
     GROUP BY x.id
    HAVING count(*) = 1
  )
  SELECT x.id, 'cec_birth_year', '中選會名冊上這一筆的出生年是 ' || c.cec_birth_year || '，這個人記的是 ' || x.birth_year
    FROM pe x JOIN cec c ON c.id = x.id
   WHERE c.cec_birth_year IS NOT NULL AND c.cec_birth_year <> x.birth_year
  UNION ALL
  -- ②建立這筆的交件寫的縣市，跟現在掛的縣市不同（簡嘉佑：交件寫台中市，掛到了桃園市的同名者）
  SELECT DISTINCT x.id, 'submitted_region',
         '建立這筆的交件寫的是「' || replace(c.payload->>'region', '臺', '台') || '」，現在掛的這個人在「' || x.county || '」'
    FROM pe x JOIN contributions c
      ON c.contribution_type = 'candidacy' AND c.status = 'applied' AND c.applied_politician_id = x.politician_id
     AND c.payload->>'election_id' = x.election_id::TEXT
   WHERE x.county IS NOT NULL AND c.payload->>'region' IS NOT NULL AND c.payload->>'region' <> '全國'
     AND left(replace(c.payload->>'region', '臺', '台'), 3) <> left(x.county, 3)
     AND (p_keys IS NULL OR x.id IN (SELECT id FROM kp))
  UNION ALL
  -- ③同一人相隔一屆在不同縣市參選地方選舉（楊寶楨：2022 台北市議員、2026 台中市議員）
  SELECT DISTINCT b.id, 'county_jump',
         '同一個人 ' || a.election_id || ' 在' || a.county || '參選' || a.election_type || '，這一筆在' || b.county
    FROM pe a JOIN pe b ON a.politician_id = b.politician_id AND a.election_date < b.election_date
   WHERE a.election_type IN ('縣市議員', '鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
     AND b.election_type IN ('縣市議員', '鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
     AND a.county IS NOT NULL AND b.county IS NOT NULL AND a.county <> b.county AND a.county <> '全國' AND b.county <> '全國'
     AND b.election_date - a.election_date < 1700
     AND (p_keys IS NULL OR b.id IN (SELECT id FROM kp))
  UNION ALL
  -- ④查證者在這筆的任務上回 no_change、理由寫明「不是同一人」（沒有改掛的型別時只能這樣回）
  SELECT DISTINCT x.id, 'said_different', '有人在這筆的任務上回報「不是同一人」，但當時只能回 no_change'
    FROM contributions c
    JOIN pe x ON x.id = substring(c.task_id FROM ':([0-9]{1,9})$')::INTEGER
   WHERE c.contribution_type = 'no_change' AND c.status NOT IN ('rejected', 'withdrawn')
     AND c.task_id ~ '^auto:[a-z_]+:[0-9]{1,9}$'
     AND COALESCE(c.payload->>'finding', '') || ' ' || COALESCE(c.note, '') ~ '(不是|並非|非|不為)同一(個)?(人|位)|同名不同人|掛錯'
     AND COALESCE(c.payload->>'finding', '') || ' ' || COALESCE(c.note, '') !~ '(不是|非|並非)同名不同人'
     AND (p_keys IS NULL OR x.id IN (SELECT id FROM kp))
  UNION ALL
  -- ⑤驗證者理由寫明「不是同一人」，這筆卻掛在一位另有別屆紀錄的既有人物上（楊忠俊：驗證者說分不出、同意建新人物，結果掛到了金寧鄉長）
  SELECT DISTINCT x.id, 'vote_said_different', '驗證這筆的人寫了「不是同一人」，這筆卻掛在一位另有別屆紀錄的既有人物上'
    FROM contribution_votes v
    JOIN contributions c ON c.id = v.contribution_id AND c.contribution_type = 'candidacy' AND c.status = 'applied'
    JOIN pe x ON x.politician_id = c.applied_politician_id AND c.payload->>'election_id' = x.election_id::TEXT
   WHERE v.note ~ '(不是|並非|非)同一(個)?(人|位)|同名不同人'
     AND v.note !~ '(不是|非|並非)同名不同人'
     AND EXISTS (SELECT 1 FROM politician_elections o WHERE o.politician_id = x.politician_id AND o.id <> x.id)
     AND (p_keys IS NULL OR x.id IN (SELECT id FROM kp))
$$;

-- 2.6 owner_mismatch（原：20261008180000）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_owner_mismatch_keyed(p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT g.politician_election_id AS id,
           jsonb_agg(jsonb_build_object('kind', g.signal, 'detail', g.detail) ORDER BY g.signal) AS signals,
           string_agg(g.detail, '；' ORDER BY g.signal) AS text
      FROM candidacy_owner_mismatch_signals_keyed(p_keys) g
     GROUP BY g.politician_election_id
  ),
  -- 同名比對用的姓名鍵：全部人物算一次放著；原本每一筆缺口都掃全部人物、每人重算兩次姓名鍵（約 1.6 萬次正規式 × 每筆）
  pk AS MATERIALIZED (
    SELECT q.id, q.name, q.birth_year, q.party, q.region, cec_name_key(q.name) AS nk FROM politicians q WHERE q.merged_into IS NULL
  )
  SELECT 'auto:candidacy_owner_mismatch:' || pe.id,
         'candidacy_owner_mismatch',
         jsonb_build_object(
           'politician_election_id', pe.id, 'politician_id', p.id, 'name', p.name, 'birth_year', p.birth_year, 'party', p.party,
           'election_id', pe.election_id, 'election_type', pe.election_type,
           'region', replace(COALESCE(r.region, p.region), '臺', '台'), 'district', r.sub_region, 'village', r.village,
           'signals', s.signals,
           -- 這個人名下其他參選紀錄（判斷是不是同一人要一起看）
           'other_records', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('politician_election_id', o.id, 'election_id', o.election_id, 'election_type', o.election_type,
                                                 'region', ro.region, 'district', ro.sub_region, 'village', ro.village, 'candidacy_status', o.candidacy_status)
                              ORDER BY o.election_id)
               FROM politician_elections o LEFT JOIN regions ro ON ro.id = o.region_id
              WHERE o.politician_id = p.id AND o.id <> pe.id), '[]'::jsonb),
           -- 資料庫裡同名的其他人（改掛的候選對象）
           'same_name', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('politician_id', q.id, 'name', q.name, 'birth_year', q.birth_year, 'party', q.party, 'region', q.region))
               FROM (SELECT q.* FROM pk q
                      WHERE q.id <> p.id AND q.nk = (SELECT cec_name_key(p.name))
                      ORDER BY q.birth_year NULLS LAST LIMIT 10) q), '[]'::jsonb),
           -- 中選會名冊上這一屆同選舉同名的人（已投票的屆別才有；出生年是分辨同名最有力的根據）
           'cec_same_name', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('region', cc.region, 'sub_region', cc.sub_region, 'village', cc.village,
                                                 'birth_year', cc.birth_year, 'elected', cc.elected) ORDER BY cc.region, cc.sub_region)
               FROM cec_candidates cc
              WHERE cc.election_id = pe.election_id AND cc.election_type = pe.election_type AND cc.name_norm = cec_name_key(p.name)), '[]'::jsonb)),
         p.name || '（' || COALESCE(replace(COALESCE(r.region, p.region), '臺', '台'), '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '')
           || '）這筆參選紀錄可能掛錯人：' || s.text || '。'
           || '請查中選會名冊（已投票的屆別看選舉資料庫的出生年；2026 看登記彙總表的推薦政黨與選舉區）與報導，判斷這筆是不是掛著的這個人。'
           || '**不是**：交 reassign_candidacy（from_politician_id 填 target.politician_id）——改掛到 target.same_name 裡的另一位（to_politician_id），或都不是就新建（new_politician：姓名、出生年、政黨）；'
           || 'evidence 寫出處上這一筆的出生年、推薦政黨或選舉區，reason 寫你憑什麼分辨。'
           || '掛錯的也可能是 target.other_records 裡的另一筆（換縣市那種兩筆都要看）：改掛時 politician_election_id 填真正掛錯的那一筆。'
           || '只是縣市或選區寫錯、人沒掛錯的，用 candidacy 重交同一人同一屆把地區改對，這一件回 no_change（outcome=confirmed）說明。'
           || '**是同一個人**（例如真的換了縣市參選）：交 no_change、outcome=confirmed，finding 寫你怎麼確認的——確認過的不會再派。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || p.name || ' ← 中選會歷屆參選（出生年、選區、政黨）',
               'https://web.cec.gov.tw/central/article/64709 ← 2026 候選人登記彙總表（選舉區、推薦政黨）',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || p.name || '","electionId":' || pe.election_id || '}'],
         1, replace(COALESCE(r.region, p.region), '臺', '台')
    FROM s
    JOIN politician_elections pe ON pe.id = s.id
    JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
    LEFT JOIN regions r ON r.id = pe.region_id
   WHERE NOT EXISTS (SELECT 1 FROM contributions c
                      WHERE c.contribution_type = 'reassign_candidacy' AND c.status IN ('pending', 'verified')
                        AND c.payload->>'politician_election_id' = pe.id::TEXT)
     -- 確認過是同一人的（no_change confirmed 通過）不再派
     AND NOT EXISTS (SELECT 1 FROM task_checks tc
                      WHERE tc.task_id = 'auto:candidacy_owner_mismatch:' || pe.id AND tc.outcome = 'confirmed')
$$;

-- 2.7 elected_missing（原：20261006100000）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_elected_missing_keyed(p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH ours AS (
    -- 我們已經有的（屆別, 選舉別, 正規化姓名）；不看狀態——有紀錄但結果空白的是 election_result_missing 另一支臂的事
    SELECT DISTINCT pe.election_id, pe.election_type, cec_name_key(p.name) AS nn
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
     WHERE pe.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')
       AND (p_keys IS NULL OR (pe.election_id, pe.election_type) IN (SELECT sc.election_id, sc.election_type FROM roster_key_scopes(p_keys) sc))
  ),
  missing AS (
    SELECT c.*
      FROM cec_candidates c
     WHERE c.elected
       AND c.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')
       AND (p_keys IS NULL OR dispatch_gap_roster_unit_key(c.election_id, c.region, c.election_type) = ANY (p_keys))
       AND NOT EXISTS (SELECT 1 FROM ours o
                        WHERE o.election_id = c.election_id AND o.election_type = c.election_type AND o.nn = c.name_norm)
  ),
  same_name AS (
    SELECT cec_name_key(p.name) AS nn, count(*) AS n
      FROM politicians p
     WHERE p.merged_into IS NULL
       AND EXISTS (SELECT 1 FROM missing)
       AND cec_name_key(p.name) IN (SELECT m.name_norm FROM missing m)
     GROUP BY 1
  )
  -- 中選會候選人 id 只在同一個場次（theme）內唯一，所以連場次一起放；兩者每次同步都一樣
  SELECT 'auto:election_result_missing:cec:' || COALESCE(m.cec_theme_id, m.election_id::TEXT) || ':' || COALESCE(m.cec_cand_id::TEXT, m.name_norm),
         'election_result_missing',
         jsonb_build_object('name', m.name, 'region', m.region, 'sub_region', m.sub_region,
                            'election_id', m.election_id, 'election_type', m.election_type, 'election_date', e.election_date,
                            'cec_cand_id', m.cec_cand_id, 'cec_theme_id', m.cec_theme_id,
                            'same_name_politicians', COALESCE(s.n, 0), 'record_missing', true),
         '中選會 ' || m.election_id || ' ' || m.election_type || ' 的當選名單上有「' || m.name || '」（'
           || m.region || COALESCE(' ' || m.sub_region, '') || '），我們卻沒有他這一屆的參選紀錄——網站上他沒有這個職稱，名下的競選承諾也追不動。'
           || '請到中選會選舉資料庫（db.cec.gov.tw）核對後，用 candidacy 型別補一筆：election_id 填 ' || m.election_id
           || '、election_type 填「' || m.election_type || '」、candidate_status 填 qualified（中選會名單上的人；confirmed 只表示表態參選）、election_result 填 elected'
           || CASE WHEN m.region = '全國' THEN '、region 填「全國」、electoral_district 填「' || COALESCE(m.sub_region, '') || '」'
                   WHEN m.election_type IN ('縣市議員', '立法委員') THEN '、region 填「' || m.region || '」、electoral_district 填選區'
                   WHEN m.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') THEN '、region 填「' || m.region || '」、sub_region 填「' || COALESCE(m.sub_region, '鄉鎮市區') || '」'
                   ELSE '、region 填「' || m.region || '」' END
           || '（得票數、得票率不收，不用查）；cec_cand_id 填 ' || COALESCE(m.cec_cand_id::TEXT, '（中選會候選人 id）')
           || '、cec_theme_id 填「' || COALESCE(m.cec_theme_id, '') || '」。'
           || CASE WHEN COALESCE(s.n, 0) = 0 THEN '我們的資料庫裡沒有同名的人，只填 name 就好，系統會建立人物。'
                   ELSE '我們的資料庫裡有 ' || s.n || ' 位同名的人，先用第 7 節的唯讀查詢看他們的參選紀錄與出生年，確定是同一人才填他的 politician_id；不是就只填 name，系統會請你指認。' END
           || 'source_urls 附中選會的頁面。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || m.name || ' ← 中選會歷屆參選與當選',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || m.name || '","electionId":' || m.election_id || '}',
               'https://db.cec.gov.tw/'],
         1, m.region
    FROM missing m
    JOIN elections e ON e.id = m.election_id
    LEFT JOIN same_name s ON s.nn = m.name_norm
$$;

-- 2.8 election_results（原：20261019100000；單位鍵先挑出整個單位的參選紀錄，分件編號與整表版相同）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_election_results_keyed(p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  -- 系統自己寫得了的（唯一對上＋選區已開完）與「我們標的跟中選會相反」的，都從同一支計畫函式來；整支只算一次
  WITH auto AS MATERIALIZED (SELECT * FROM cec_results_auto_plan()),
  gap AS (
    SELECT pe.id
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
     -- 投票日之後才派：移到規則（activity_rules「election_results」：投票日 +1 起，P2 20261008070000）；這裡不再比日期
     WHERE COALESCE(pe.candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')
       AND (p_keys IS NULL OR pe.id IN (SELECT k.id FROM roster_diff_result_pe_ids(p_keys) k))
  ),
  -- 已經有人交了、還在等票的不再派（同一份名單抄一次就夠；退件了就會再派）
  queued AS (
    SELECT DISTINCT (it->>'politician_election_id')::INTEGER AS id
      FROM contributions c
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'items') = 'array' THEN c.payload->'items' ELSE '[]'::jsonb END) it
     WHERE c.contribution_type = 'election_results' AND c.status IN ('pending', 'verified')
       AND (it->>'politician_election_id') ~ '^[0-9]{1,9}$'
  ),
  m AS (
    SELECT * FROM election_result_cec_matches(ARRAY(SELECT g.id FROM gap g WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.id = g.id)))
  ),
  units AS (
    SELECT m.*,
           CASE WHEN m.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN m.town END AS unit_town
      FROM m
     WHERE m.cec_hits = 1
       -- 唯一對上而且那個選區已開完的，由系統直接寫（cec_results_auto_apply），不派代理；
       -- 剩下的（應選名額還沒登錄、當選數對不上席次、同一位中選會名單被我們兩筆對到）才聚成批次派
       AND m.politician_election_id NOT IN (SELECT a.politician_election_id FROM auto a WHERE a.write_result)
  ),
  numbered AS (
    SELECT u.*,
           (row_number() OVER w - 1) / 120 + 1 AS part,
           (count(*) OVER (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town) - 1) / 120 + 1 AS parts
      FROM units u
    WINDOW w AS (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town
                 ORDER BY u.town NULLS LAST, u.village NULLS LAST, u.name, u.politician_election_id)
  ),
  grouped AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts,
           count(*) AS items_count,
           jsonb_agg(n.politician_election_id ORDER BY n.town NULLS LAST, n.village NULLS LAST, n.name, n.politician_election_id) AS ids
      FROM numbered n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  )
  -- 批次：一個單位一件（超過 120 位拆成幾件）
  SELECT 'auto:election_results_missing:' || g.election_id || ':' || g.election_type || ':' || g.county
           || COALESCE(':' || g.unit_town, '') || CASE WHEN g.parts > 1 THEN ':p' || g.part ELSE '' END,
         'election_results_missing',
         jsonb_build_object('election_id', g.election_id, 'election_type', g.election_type, 'region', g.county,
                            'sub_region', g.unit_town, 'election_date', e.election_date,
                            'part', g.part, 'parts', g.parts, 'items_count', g.items_count,
                            'politician_election_ids', g.ids),
         g.county || COALESCE(g.unit_town, '') || ' ' || g.election_id || ' ' || g.election_type || '：'
           || '我們有 ' || g.items_count || ' 位參選人的選舉結果還空著'
           || CASE WHEN g.parts > 1 THEN '（這個單位太大，拆成 ' || g.parts || ' 件，這是第 ' || g.part || ' 件）' ELSE '' END
           || '，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。系統已經把「中選會名單唯一對上、而且那個選區已開完（標當選的人數＝應選席次）」的直接寫進去了；留給你的是系統確認不了的（這個選區的應選名額還沒登錄、當選數對不上席次、或同一位中選會名單被我們兩筆對到）。名單在 current.items：每一位附系統比對到的中選會那一列（cec），那是線索不是答案。'
           || '請打開中選會選舉資料庫這個單位的結果逐位核對（同名不同人要看選區、村里、出生年），交一筆 election_results：'
           || 'election_id 填 ' || g.election_id || '、election_type 填「' || g.election_type || '」、region 填「' || g.county || '」'
           || CASE WHEN g.unit_town IS NOT NULL THEN '、sub_region 填「' || g.unit_town || '」' ELSE '' END
           || '，items 每位一項 {politician_election_id, election_result：elected 或 not_elected}。核對不了或不是同一個人的不要放進 items，在 note 寫是哪幾位。'
           || 'source_urls 第一個放你核對的中選會那一頁。',
         ARRAY['https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：依屆別、選舉、縣市（鄉鎮）點到結果表，當選者有標記',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 個別查一位的歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 直接回中選會的當選與否'],
         1, g.county
    FROM grouped g
    JOIN elections e ON e.id = g.election_id
  UNION ALL
  -- 對不上的（同縣市同名多位、名單查無）：各自派 election_result_missing，附名單上同縣市同名的人請代理指認。
  -- 名下有政見的也在這裡派（20261010170000 起逐筆版 raw:election_result_missing 收掉，OPS #72）
  SELECT 'auto:election_result_missing:' || m.politician_election_id,
         'election_result_missing',
         jsonb_build_object('politician_id', m.politician_id, 'name', m.name, 'region', m.county,
                            'sub_region', m.town, 'village', m.village,
                            'election_id', m.election_id, 'election_type', m.election_type, 'election_date', e.election_date,
                            'cec_hits', m.cec_hits,
                            'cec_same_name', COALESCE((
                              SELECT jsonb_agg(jsonb_build_object('sub_region', cc.sub_region, 'village', cc.village, 'birth_year', cc.birth_year,
                                                                  'elected', cc.elected, 'cec_cand_id', cc.cec_cand_id, 'cec_theme_id', cc.cec_theme_id)
                                               ORDER BY cc.sub_region, cc.village)
                                FROM cec_candidates cc
                               WHERE cc.election_id = m.election_id AND cc.election_type = m.election_type
                                 AND cc.region = m.county AND cc.name_norm = cec_name_key(m.name)), '[]'::jsonb)),
         m.name || '（' || COALESCE(m.county, '') || COALESCE(' ' || m.town, '') || COALESCE(' ' || m.village, '') || ' '
           || m.election_id || ' ' || m.election_type || '）的選舉結果還空著，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。'
           || CASE WHEN m.cec_hits = 0 THEN '系統在中選會名單上找不到同縣市同名、地區也對得上的人（多半是地區或姓名寫錯）。'
                   ELSE '中選會名單上同縣市同名、地區也對得上的有 ' || m.cec_hits || ' 位，系統分不出是哪一位（target.cec_same_name）。' END
           || '請到中選會選舉資料庫核對他是哪一位，用 candidacy 補 election_result（elected 或 not_elected），帶 politician_id；'
           || '名單上真的沒有他、或確定不是同一個人，用 no_change 回報你查了哪些網址，不要猜。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || m.name || ' ← 中選會歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || m.name || '","electionId":' || m.election_id || '}'],
         1, m.county
    FROM m
    JOIN elections e ON e.id = m.election_id
   WHERE m.cec_hits <> 1
  UNION ALL
  -- 我們標的跟中選會不一樣：唯一對上、那個選區已開完，而且我們已經有結果（elected／not_elected）卻跟名單相反。
  -- 系統不覆蓋（維護者 2026-10-19：不一致才是缺口），派代理核對是不是同一個人、哪一邊錯。task_id 與逐位件同一個形式（這一筆不是空白，兩邊不會撞）
  SELECT 'auto:election_result_missing:' || x.politician_election_id,
         'election_result_missing',
         jsonb_build_object('kind', 'result_mismatch', 'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'sub_region', x.town, 'village', x.village,
                            'election_id', x.election_id, 'election_type', x.election_type, 'election_date', e.election_date,
                            'ours', jsonb_build_object('candidacy_status', x.cur_status),
                            'cec', jsonb_build_object('elected', x.cec_elected, 'sub_region', x.cec_sub_region, 'village', x.cec_village,
                                                      'birth_year', x.cec_birth_year, 'cec_cand_id', x.cec_cand_id, 'cec_theme_id', x.cec_theme_id),
                            'unit', jsonb_build_object('seats', x.unit_seats, 'cec_elected', x.unit_elected)),
         x.name || '（' || COALESCE(x.county, '') || COALESCE(' ' || x.town, '') || COALESCE(' ' || x.village, '') || ' '
           || x.election_id || ' ' || x.election_type || '）我們標的是「' || CASE WHEN x.cur_status = 'elected' THEN '當選' ELSE '落選' END
           || '」，但中選會這個選區已經開完（應選 ' || x.unit_seats || ' 席、名單上標當選 ' || x.unit_elected || ' 位），名單上同縣市同名、地區也對得上的他是「'
           || CASE WHEN x.cec_elected THEN '當選' ELSE '落選' END || '」，兩邊不一致。'
           || '請到中選會選舉資料庫核對：①是不是同一個人（同名不同人看選區、村里、出生年）；②他到底當選了沒有。'
           || '我們標錯了就用 candidacy 改 election_result（帶 politician_id，附中選會那一頁）；中選會那一列是別人、或名單本身有誤，就用 no_change 回報你查了哪些網址。'
           || '系統不會自動覆蓋我們已有的結果。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name || ' ← 中選會歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || x.name || '","electionId":' || x.election_id || '}',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, x.county
    FROM auto x
    JOIN elections e ON e.id = x.election_id
   WHERE x.mismatch
     AND (p_keys IS NULL OR x.politician_election_id IN (SELECT k.id FROM roster_diff_result_pe_ids(p_keys) k))
$$;

-- ------------------------------------------------------------
-- 3. roster_diff_findings(p_keys)：七支臂改呼叫孿生函式（其餘與 20261127093000 逐字相同）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION roster_diff_findings(p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE (election_id INTEGER, election_type TEXT, county TEXT, town TEXT, voted BOOLEAN, kind TEXT,
               politician_id UUID, politician_election_id INTEGER, name TEXT,
               current_value JSONB, official_value JSONB, source_url TEXT, origin_task_id TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS MATERIALIZED (
              SELECT 'party_roster'::TEXT AS arm, t.* FROM contribution_auto_tasks_party_roster_keyed(p_keys) t
    UNION ALL SELECT 'party_gap', t.* FROM contribution_auto_tasks_party_gap_keyed(p_keys) t
    UNION ALL SELECT 'township_gap', t.* FROM contribution_auto_tasks_township_gap_keyed(p_keys) t
    UNION ALL SELECT 'region_gap', t.* FROM contribution_auto_tasks_region_gap_keyed(p_keys) t
    UNION ALL SELECT 'owner_mismatch', t.* FROM contribution_auto_tasks_owner_mismatch_keyed(p_keys) t
  ),
  -- 以參選紀錄為單位的五種（任務編號最後一段就是 politician_elections.id）
  b AS MATERIALIZED (
    SELECT s.arm, s.task_id, s.target, pe.id AS pe_id, pe.election_id, pe.election_type, pe.candidacy_status,
           p.id AS pid, p.name, p.party AS person_party, p.birth_year,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county, r.region AS r_region, r.sub_region AS r_sub, r.village AS r_village,
           (e.election_date < CURRENT_DATE) AS voted
      FROM s
      JOIN politician_elections pe ON pe.id = (regexp_match(s.task_id, ':([0-9]+)$'))[1]::INTEGER
      JOIN politicians p ON p.id = pe.politician_id
      JOIN elections e ON e.id = pe.election_id
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE NOT politician_name_is_placeholder(p.name)
  ),
  pe_f AS (
    SELECT x.election_id, x.election_type, x.county, roster_unify_town(x.voted, x.election_type, x.r_sub) AS town, x.voted,
           CASE x.arm WHEN 'party_roster' THEN '政黨' WHEN 'party_gap' THEN '政黨' WHEN 'township_gap' THEN '鄉鎮' WHEN 'region_gap' THEN '縣市' ELSE '掛錯人' END AS kind,
           x.pid, x.pe_id, x.name,
           CASE x.arm
             WHEN 'party_roster' THEN jsonb_build_object('party', NULL, 'person_party', x.person_party, 'candidacy_status', x.candidacy_status)
             WHEN 'party_gap' THEN jsonb_build_object('party', NULL, 'person_party', x.person_party, 'candidacy_status', x.candidacy_status)
             WHEN 'township_gap' THEN jsonb_build_object('region', x.county, 'sub_region', NULL, 'village', x.r_village)
             WHEN 'region_gap' THEN jsonb_build_object('region', x.r_region, 'sub_region', x.r_sub, 'village', x.r_village, 'missing', x.target->'missing')
             ELSE jsonb_build_object('birth_year', x.birth_year, 'party', x.person_party, 'region', x.county, 'district', x.target->>'district', 'village', x.target->>'village',
                                     'other_records', x.target->'other_records')
           END AS cur,
           CASE x.arm
             WHEN 'party_roster' THEN jsonb_build_object('party_basis', '登記彙總表推薦之政黨欄', 'rosters', x.target->'rosters')
             WHEN 'party_gap' THEN jsonb_build_object('party', x.target->'cec'->>'party', 'cand_no', x.target->'cec'->'cand_no', 'election_result', x.target->'cec'->>'election_result',
                                                      'cec_party', x.target->'cec_party', 'fill', x.target->'fill')
             WHEN 'township_gap' THEN jsonb_build_object('need', CASE WHEN x.election_type = '村里長' THEN '鄉鎮市區與村里' ELSE '鄉鎮市區' END)
             WHEN 'region_gap' THEN jsonb_build_object('cec_districts', x.target->'cec_districts', 'cec_party', x.target->'cec_party', 'cec_source_url', x.target->'cec_source_url')
             ELSE jsonb_build_object('signals', x.target->'signals', 'same_name', x.target->'same_name', 'cec_same_name', x.target->'cec_same_name')
           END AS off,
           CASE x.arm
             WHEN 'party_roster' THEN COALESCE(x.target->'rosters'->>0, 'https://web.cec.gov.tw/central/article/64709')
             WHEN 'party_gap' THEN 'https://db.cec.gov.tw/ElecTable/Election'
             WHEN 'owner_mismatch' THEN 'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name
             ELSE COALESCE(x.target->>'cec_source_url', CASE WHEN x.voted THEN 'https://db.cec.gov.tw/ElecTable/Election' ELSE 'https://web.cec.gov.tw/central/article/64709' END)
           END AS url,
           x.task_id
      FROM b x
     -- ★ 單位鍵過濾
     WHERE (p_keys IS NULL OR dispatch_gap_roster_unit_key(x.election_id, x.county || roster_unify_town(x.voted, x.election_type, x.r_sub), x.election_type) = ANY (p_keys))
  ),
  -- 當選名單有、站上沒有（已投票屆）
  em AS (
    SELECT (t.target->>'election_id')::INTEGER AS election_id, t.target->>'election_type' AS election_type,
           replace(t.target->>'region', '臺', '台') AS county, ''::TEXT AS town, true AS voted, '缺人'::TEXT AS kind,
           NULL::UUID AS pid, NULL::INTEGER AS pe_id, t.target->>'name' AS name,
           jsonb_build_object('record', NULL, 'same_name_politicians', t.target->'same_name_politicians') AS cur,
           jsonb_build_object('elected', true, 'region', t.target->>'region', 'sub_region', t.target->>'sub_region',
                              'cec_cand_id', t.target->'cec_cand_id', 'cec_theme_id', t.target->>'cec_theme_id') AS off,
           'https://db.cec.gov.tw/ElecTable/Election'::TEXT AS url, t.task_id
      FROM contribution_auto_tasks_elected_missing_keyed(p_keys) t
      JOIN elections ev ON ev.id = (t.target->>'election_id')::INTEGER
     WHERE ev.election_date < CURRENT_DATE  -- 投票日已過才有「結果」類差異
       -- ★ 單位鍵過濾
       AND (p_keys IS NULL OR dispatch_gap_roster_unit_key((t.target->>'election_id')::INTEGER, replace(t.target->>'region', '臺', '台'), t.target->>'election_type') = ANY (p_keys))
  ),
  -- 結果空白或不一致（已投票屆）：整批件展開成逐位，逐位件與「我們標的跟中選會相反」件直接用
  er AS MATERIALIZED (SELECT t.* FROM contribution_auto_tasks_election_results_keyed(p_keys) t),
  er_ids AS (
    SELECT er.task_id, er.target, x.id::INTEGER AS pe_id,
           CASE WHEN er.target->>'kind' = 'result_mismatch' THEN 'result_mismatch' WHEN er.task_type = 'election_results_missing' THEN 'result_blank' ELSE 'result_unmatched' END AS sub
      FROM er
      CROSS JOIN LATERAL (
        SELECT jsonb_array_elements_text(er.target->'politician_election_ids') AS id WHERE er.task_type = 'election_results_missing'
        UNION ALL SELECT (regexp_match(er.task_id, ':([0-9]+)$'))[1] WHERE er.task_type <> 'election_results_missing'
      ) x
     WHERE x.id IS NOT NULL
       -- ★ 單位鍵過濾（超集，下面 er_f 再做精確的）：先把不在這批單位的參選紀錄擋掉，election_result_cec_matches 才不用算整份
       AND (p_keys IS NULL OR EXISTS (SELECT 1 FROM politician_elections pk
                                        JOIN politicians pp ON pp.id = pk.politician_id
                                        LEFT JOIN regions rk ON rk.id = pk.region_id
                                       WHERE pk.id = x.id::INTEGER
                                         AND dispatch_gap_roster_keys(pk.election_id, pk.election_type, COALESCE(rk.region, pp.region), COALESCE(rk.sub_region, pp.sub_region)) && p_keys))
  ),
  cm AS MATERIALIZED (SELECT * FROM election_result_cec_matches(ARRAY(SELECT DISTINCT i.pe_id FROM er_ids i))),
  er_f AS (
    SELECT c.election_id, c.election_type, c.county,
           roster_unify_town(true, c.election_type, c.town) AS town, true AS voted, '結果'::TEXT AS kind,
           c.politician_id AS pid, c.politician_election_id AS pe_id, c.name,
           jsonb_build_object('candidacy_status', c.current_result, 'region', c.county, 'sub_region', c.town, 'village', c.village, 'district', c.district) AS cur,
           CASE WHEN i.sub = 'result_mismatch'
                THEN jsonb_build_object('elected', i.target->'cec'->'elected', 'sub_region', i.target->'cec'->>'sub_region', 'cec_cand_id', i.target->'cec'->'cec_cand_id',
                                        'cec_theme_id', i.target->'cec'->>'cec_theme_id', 'unit', i.target->'unit', 'kind', 'result_mismatch')
                ELSE jsonb_build_object('elected', c.cec_elected, 'cec_hits', c.cec_hits, 'sub_region', c.cec_sub_region, 'cec_cand_id', c.cec_cand_id,
                                        'cec_theme_id', c.cec_theme_id, 'cec_same_name', i.target->'cec_same_name', 'kind', i.sub) END AS off,
           'https://db.cec.gov.tw/ElecTable/Election'::TEXT AS url, i.task_id
      FROM er_ids i
      JOIN cm c ON c.politician_election_id = i.pe_id
      JOIN elections ev ON ev.id = c.election_id
     WHERE NOT politician_name_is_placeholder(c.name)
       AND ev.election_date < CURRENT_DATE  -- 投票日已過才有「結果」類差異（election_results 臂不比日期，閘門在 activity_rules；這裡自己守）
       -- ★ 單位鍵過濾
       AND (p_keys IS NULL OR dispatch_gap_roster_unit_key(c.election_id, c.county || roster_unify_town(true, c.election_type, c.town), c.election_type) = ANY (p_keys))
  ),
  -- 縣市長縣市不符（單位＝官方名冊的縣市）
  rm AS (
    SELECT m.election_id, '縣市長'::TEXT AS election_type, m.official_county AS county, ''::TEXT AS town, false AS voted, '縣市'::TEXT AS kind,
           m.politician_id AS pid, m.politician_election_id AS pe_id, m.name,
           jsonb_build_object('region', m.cur_county, 'region_id', m.current_region_id, 'kind', 'region_mismatch') AS cur,
           jsonb_build_object('region', m.official_county, 'proposed_region_id', m.proposed_region_id, 'fix', 'correction 改 politician_elections.region_id') AS off,
           m.source_url AS url, NULL::TEXT AS task_id
      FROM roster_region_mismatch_findings() m
     -- ★ 單位鍵過濾
     WHERE (p_keys IS NULL OR dispatch_gap_roster_unit_key(m.election_id, m.official_county, '縣市長') = ANY (p_keys))
  )
  SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM pe_f f
  UNION ALL SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM em f
  UNION ALL SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM er_f f
  UNION ALL SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM rm f
$$;
COMMENT ON FUNCTION roster_diff_findings(TEXT[]) IS '名冊類差異（finding）：缺人／政黨／鄉鎮／縣市／結果／掛錯人。結果類（elected_missing、election_results）只算投票日已過的屆。p_keys（unit:<選舉>:<縣市＋鄉鎮>:<職位>）為 NULL＝整表，非 NULL＝只算並只回那些單位（七支臂的帶鍵孿生函式在輸入端過濾，各分支合併前再過濾一次）。2026-11-01，2026-11-27 加單位鍵，2026-11-28 七支臂接鍵';

-- ------------------------------------------------------------
-- 4. 權限與自我檢查
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION roster_key_scopes(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION roster_diff_keyed_pe_ids(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION roster_diff_result_pe_ids(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_auto_tasks_party_roster_keyed(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_auto_tasks_party_gap_keyed(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_auto_tasks_township_gap_keyed(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_auto_tasks_region_gap_keyed(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION candidacy_owner_mismatch_signals_keyed(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_auto_tasks_owner_mismatch_keyed(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_auto_tasks_elected_missing_keyed(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_auto_tasks_election_results_keyed(TEXT[]) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regprocedure('roster_diff_findings(text[])') IS NULL OR to_regprocedure('roster_diff_findings()') IS NOT NULL THEN
    RAISE EXCEPTION '第 2 期 PR-3：roster_diff_findings 要只剩帶 p_keys 的簽名';
  END IF;
  IF to_regprocedure('contribution_auto_tasks_party_roster()') IS NULL OR to_regprocedure('contribution_auto_tasks_election_results()') IS NULL
     OR to_regprocedure('candidacy_owner_mismatch_signals()') IS NULL THEN
    RAISE EXCEPTION '第 2 期 PR-3：原臂函式（無參數版）必須留著，派工總表還在用';
  END IF;
END $$;
