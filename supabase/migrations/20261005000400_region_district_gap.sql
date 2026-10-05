-- 補縣市、補選區、當選人缺參選紀錄：三種缺口自動派工（2026-10-05）
--
-- 小良哥 2026-10-05 常設裁決：資料一律走流程（代理領任務、附出處交件、其他代理驗證上線），
-- 主線只補流程缺口（docs/DECISIONS.md 2026-10-05）；不用 service_role、不在 migration 裡直接改人物資料。
-- 所以這支**只新增派工臂與兩個純函式，不碰任何人物或參選紀錄**。
--
-- ① 補縣市：縣市長／縣市議員／立法委員的參選紀錄 region_id 是空的。
--    get_politicians_by_filters 是 politician_elections LEFT JOIN regions 再比縣市，空的那一筆用任何縣市篩選
--    都撈不到、也不報錯。10-05 線上：2026 有 79 筆（表態不參選的縣市長 74、已登記的縣市議員 5）；
--    #339 只補了已登記的 102 筆，不參選那 74 筆留給流程。
-- ② 補選區：縣市議員、立法委員的參選紀錄只指到縣市層級（或指到不是選區的列，例如 2022 的「台北市 中山大同區」）。
--    10-05 線上：2026 已登記的縣市議員 100 筆只到縣市（#339 刻意只補縣市、不猜選區），2022 縣市議員 47 筆。
--    表態不參選的不問選區（他沒有選區）。
--    鄉鎮層級的五種選舉不在這裡：那是 contribution_auto_tasks_township_gap（20261004000004）的範圍。
-- ③ 當選人缺參選紀錄：中選會名單（cec_candidates）上當選了、我們卻沒有他那一屆同一種選舉的參選紀錄。
--    #332 第 2b 項：2024 不分區與原住民立委一筆都沒有——cec-sync 從來只抓區域立委（見 _shared/cec-sync.ts 的
--    pickTheme），這次一起補上；名單同步進來之後，就由這支臂派任務請代理補參選紀錄（附中選會出處、驗證後上線）。
--    範圍只放「有任期政見要追」的五種（同 term_policy_missing）：村里長、代表當選人上萬，不在這裡。
--
-- 派任務都沿用既有型別，不新增任務型別（不必清點四處）：
--   ①② 用 candidacy_source_missing——那個型別本來就是「這筆參選紀錄缺東西，請用 candidacy 型別重交同一人同一屆」，
--       township_gap 已經這樣用；task_id 用參選紀錄的 id（auto:candidacy_source_missing:<pe.id>），
--       跟 township_gap 同一種寫法但選舉別不重疊，不會撞號。
--   ③ 用 election_result_missing——缺的正是「那一屆的結果」；task_id 是 auto:election_result_missing:cec:<中選會場次 id>:<中選會候選人 id>，
--       這兩個每次同步都一樣（cec_candidates 自己的 id 每週先刪後寫會變，不能用）。
-- 補上之後缺口自己消失（seed_auto_task_queue 收回號碼牌）；交件端的地區解析在 apply-contribution.ts
-- （districtRegionPatch／legislatorRegionPatch／countyRegionPatch），對不上時回覆會講出來。

-- 這一列算不算「選區」（縣市議員：第NN選舉區；立委：<縣市>第NN選區，或全國的不分區／平地原住民／山地原住民）。
-- 規則跟 _shared/electoral-district.ts 的 legislatorDistrictKey 同一套；改一邊要改另一邊（region-gap.test.ts 盯著）。
CREATE OR REPLACE FUNCTION region_is_electoral_district(p_election_type TEXT, p_region TEXT, p_sub_region TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_election_type
    WHEN '縣市議員' THEN COALESCE(p_sub_region ~ '^第[0-9]+選舉區$', false)
    WHEN '立法委員' THEN COALESCE(p_sub_region ~ '第[0-9]+選區$', false)
                      OR (p_region = '全國' AND p_sub_region IN ('不分區', '平地原住民', '山地原住民'))
    ELSE false
  END
$$;
COMMENT ON FUNCTION region_is_electoral_district IS
  '參選紀錄指到的 regions 列是不是選區：縣市議員「第NN選舉區」；立委「<縣市>第NN選區」或全國的不分區／平地原住民／山地原住民（2026-10-05）';

-- 拿來跟 cec_candidates.name_norm 比的姓名鍵：cec_name_norm 再去掉尾端拉丁拼音。
-- cec_candidates.name_norm（_shared/cec-sync.ts 的 cecNameNorm）多做了「去尾端拉丁拼音」這一步，SQL 的 cec_name_norm 沒做；
-- 人物表也有「洪英雄Salizan.binkinuan」這種寫法，只用 cec_name_norm 比，原住民立委補進來之後缺口永遠關不掉
-- （PGlite 實跑抓到的：伍麗華 Saidhai．Tahovecahe）。全是拉丁字母的姓名去完是空字串，回 NULL、不拿來比。
CREATE OR REPLACE FUNCTION cec_name_key(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(cec_name_norm(p), '[A-Za-z]+$', ''), '')
$$;
COMMENT ON FUNCTION cec_name_key IS '跟 cec_candidates.name_norm 同一套的姓名鍵（cec_name_norm＋去尾端拉丁拼音），2026-10-05';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_region_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.candidate_status, pe.position,
           p.id AS politician_id, p.name, p.party,
           COALESCE(r.region, p.region) AS county,
           pe.region_id IS NULL AS no_region,
           pe.election_type IN ('縣市議員', '立法委員')
             AND pe.candidate_status <> 'not_running'
             AND NOT region_is_electoral_district(pe.election_type, r.region, r.sub_region) AS no_district
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.election_type IN ('縣市長', '縣市議員', '立法委員')
  ),
  gaps AS (
    SELECT g.*,
           CASE g.candidate_status
             WHEN 'not_running' THEN '表態不參選' WHEN 'registered' THEN '已登記' WHEN 'confirmed' THEN '確定參選'
             WHEN 'qualified' THEN '審定合格' ELSE g.candidate_status END AS status_label,
           CASE WHEN g.election_type = '立法委員'
                THEN '「第NN選區」（區域立委）；不分區或原住民立委 region 填「全國」、electoral_district 填「不分區」「平地原住民」或「山地原住民」'
                ELSE '「第NN選舉區」（例：第04選舉區）' END AS district_how
      FROM g
     WHERE g.no_region OR g.no_district
  )
  SELECT 'auto:candidacy_source_missing:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'party', x.party, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'politician_election_id', x.pe_id,
                            'missing', to_jsonb(array_remove(ARRAY[CASE WHEN x.no_region THEN 'region' END,
                                                                   CASE WHEN x.no_district THEN 'electoral_district' END], NULL)),
                            'cec_listed_as', cec.listed_as),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '，' || x.status_label || '）的參選紀錄'
           || CASE WHEN x.no_region AND x.no_district THEN '沒有縣市也沒有選區'
                   WHEN x.no_region THEN '沒有縣市'
                   ELSE '只記到縣市、沒有選區' END
           || '，網站的' || CASE WHEN x.no_region THEN '縣市篩選撈不到他' ELSE '選區篩選撈不到他' END || '。'
           || CASE WHEN x.candidate_status = 'not_running'
                   THEN '這筆是「表態不參選」的紀錄，要補的是他當初被傳要選、後來表態不選的那個縣市'
                        || COALESCE('（職位欄現在寫「' || x.position || '」，可以當線索，但要附出處）', '') || '。'
                   ELSE '' END
           || '請查證後用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、region 填縣市（用「台」不用「臺」）'
           || CASE WHEN x.no_district THEN '、electoral_district 填' || x.district_how ELSE '' END
           || '，candidate_status 照現況填「' || x.candidate_status || '」（狀態本身有錯是另一件事，不要在這筆改），其餘欄位照現有資料原樣帶；'
           || 'source_urls 附看得出' || CASE WHEN x.no_district THEN '選區' ELSE '縣市' END || '的出處。'
           || CASE WHEN cec.listed_as IS NOT NULL
                   THEN '中選會選舉資料庫的名單上記的是「' || cec.listed_as || '」：請打開 db.cec.gov.tw 核對是同一個人後照填，source_urls 附你核對的那一頁。'
                   WHEN x.election_id = 2026 AND x.candidate_status <> 'not_running'
                   THEN '2026 的縣市與選區在中選會候選人登記彙總表（web.cec.gov.tw/central/article/64709，各級選舉的 PDF 逐列寫著選區）；'
                        || '已登記的要附中選會名冊或登記截止後的報導，不然交件會被擋；附名冊網址的，系統會逐位核對、吻合的一票就過。'
                   WHEN x.candidate_status = 'not_running'
                   THEN '不參選的出處通常是當事人表態或政黨提名的新聞報導。'
                   ELSE '' END
           || '查不到可信出處就用 no_change 回報你查了哪些網址，不要猜。',
         CASE WHEN x.candidate_status = 'not_running'
              THEN ARRAY['cna.com.tw', 'udn.com', 'ltn.com.tw', '政黨官網的提名公告']
              WHEN x.election_id = 2026
              THEN ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表（逐列有選區）',
                         COALESCE(x.county, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com']
              ELSE ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會歷屆參選，回選舉區',
                         'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份}', 'cna.com.tw'] END,
         1, x.county
    FROM gaps x
    -- 中選會名單（已投票的屆別才有）上全國同名同選舉別只有一位時，把他的縣市＋選區當線索附上；同名多位就不給，免得指錯人
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*) = 1 THEN min(c.region || COALESCE(' ' || c.sub_region, '')) END AS listed_as
        FROM cec_candidates c
       WHERE c.election_id = x.election_id AND c.election_type = x.election_type AND c.name_norm = cec_name_key(x.name)
    ) cec ON true
$$;
COMMENT ON FUNCTION contribution_auto_tasks_region_gap IS
  '縣市長／縣市議員／立委：參選紀錄缺縣市（region_id 空）或缺選區（縣市議員、立委只到縣市層級），沿用 candidacy_source_missing 型別（2026-10-05）';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_elected_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH ours AS (
    -- 我們已經有的（屆別, 選舉別, 正規化姓名）；不看狀態——有紀錄但結果空白的是 election_result_missing 另一支臂的事
    SELECT DISTINCT pe.election_id, pe.election_type, cec_name_key(p.name) AS nn
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
     WHERE pe.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')
  ),
  missing AS (
    SELECT c.*
      FROM cec_candidates c
     WHERE c.elected
       AND c.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')
       AND NOT EXISTS (SELECT 1 FROM ours o
                        WHERE o.election_id = c.election_id AND o.election_type = c.election_type AND o.nn = c.name_norm)
  ),
  same_name AS (
    SELECT cec_name_key(p.name) AS nn, count(*) AS n
      FROM politicians p
     WHERE p.merged_into IS NULL
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
           || '、election_type 填「' || m.election_type || '」、candidate_status 填 confirmed、election_result 填 elected'
           || CASE WHEN m.region = '全國' THEN '、region 填「全國」、electoral_district 填「' || COALESCE(m.sub_region, '') || '」'
                   WHEN m.election_type IN ('縣市議員', '立法委員') THEN '、region 填「' || m.region || '」、electoral_district 填選區'
                   WHEN m.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') THEN '、region 填「' || m.region || '」、sub_region 填「' || COALESCE(m.sub_region, '鄉鎮市區') || '」'
                   ELSE '、region 填「' || m.region || '」' END
           || '，查得到就一起補得票數與得票率；cec_cand_id 填 ' || COALESCE(m.cec_cand_id::TEXT, '（中選會候選人 id）')
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
COMMENT ON FUNCTION contribution_auto_tasks_elected_missing IS
  '中選會名單上當選、我們沒有那一屆參選紀錄的人（立委／縣市長／縣市議員／鄉鎮市長／原住民區長），沿用 election_result_missing 型別（2026-10-05）';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END,
         r.hint_sources, r.reward, r.region
    FROM contribution_auto_tasks_raw() r
   WHERE r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region)
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_villages()
  UNION ALL SELECT * FROM contribution_auto_tasks_township_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_region_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_elected_missing()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-02 暫時移除 contribution_auto_tasks_profile_details（/next statement timeout 止血），函式本體保留。'
  '2026-10-03 名單清查依 roster_check_scope.regions 濾掉沒有這種選舉的縣市。'
  '2026-10-04 加村里長（鄉鎮市區層級）的清查臂；鄉鎮市長／代表類的清查說明補「要填 sub_region」。'
  '2026-10-04 加 township_gap：region_id 空的鄉鎮／村里層級參選紀錄缺鄉鎮（村里長缺村里），沿用 candidacy_source_missing 型別。'
  '2026-10-05 加 region_gap（縣市長／議員／立委缺縣市或缺選區）與 elected_missing（中選會當選、我們沒有參選紀錄）。';
