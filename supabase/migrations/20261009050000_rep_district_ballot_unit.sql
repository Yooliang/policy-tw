-- 代表的號次單位改用選舉區：鄉鎮市民代表、直轄市山地原住民區民代表（2026-10-09，#464；接 #452 的號次檢查 20261008150000／20261008151000）
-- ============================================================
--
-- 背景：#452 的號次檢查（函式 ballot_number_unit、視圖 ballot_number_units／ballot_number_anomalies、重複檢查 cand_no_dup_check）按「號次單位」算。
-- 代表類的號次單位是選舉區（每個鄉鎮市區裡按選舉區各自從 1 編起），但我們的參選紀錄只記到鄉鎮（region_id 指到鄉鎮那一列），單位算不出來，所以兩類一直不檢查。
-- 中選會登記彙總表的資料表 cec_registrations（#449）每一列都有 district，這支把選舉區補進流程：
--
--   一、選舉區怎麼進參選紀錄（照「資料走流程」：這支 migration 不寫任何人物或參選紀錄，只改派工臂與純函式）
--     * 沿用既有的形狀：代表的選舉區記在 regions 的「<鄉鎮>第NN選舉區」那一列（2022 區民代表 82 筆就是這樣；cec-sync、election_districts、讀取端 get_politicians_by_level 都是同一個寫法）。
--     * 交件端：candidacy 的 electoral_district（協議本來就收，議員必填）＋sub_region（鄉鎮）——落庫（apply-contribution.ts 的 repDistrictRegionPatch）把 region_id 指到那一列；
--       regions 沒有那一列時，只有選舉區有官方根據（cec_registrations 或 cec_candidates 上有這個鄉鎮的這一區）才新建；已經記了選舉區的重交只帶鄉鎮，不降回鄉鎮那一列。
--     * 派工：contribution_auto_tasks_region_gap（補選區臂）多派「代表的參選紀錄只記到鄉鎮、沒有選舉區」——而且名冊上找得到他（姓名＋縣市＋鄉鎮對得上 cec_registrations，那一列有 district）才派，
--       任務附名冊那一列的選舉區（target.cec_districts）與名冊網址，代理照名冊交件，名冊逐位吻合的由 roster_batch 逐位核對（鄉鎮、政黨、選舉區都核，#440）。
--       名冊上找不到他、或那個鄉鎮名冊沒有選舉區（金門縣、蘭嶼鄉等單一選區）的不派——沒有依據就不猜。不新增臂，所以 contribution_auto_tasks_arms()／activity_arm_names() 一字不動。
--     * 名單清查（roster_check）派出去時已經把名冊上每個缺的人連同選舉區附上（registration.missing[].district），任務提示改成代表也要帶 electoral_district，新進來的代表一開始就有選舉區。
--
--   二、號次單位（ballot_number_unit，「現行定義＋機械替換」：只在 ELSE NULL 前多一個代表的分支，其餘一字不差）
--     代表：縣市|鄉鎮第NN選舉區（例：連江縣|北竿鄉第02選舉區），選舉區數字補成兩位、臺→台。參選紀錄那一邊 regions.sub_region 就是「北竿鄉第02選舉區」（呼叫處把它同時當 district 與 town 傳）；
--     交件 payload 那一邊是 electoral_district＋sub_region（也接受整個寫成「北竿鄉第2選舉區」）。沒有選舉區、沒有鄉鎮、看不出第幾區的照舊回 NULL＝不檢查。
--
--   三、視圖與臂跟著生效（只改代表那一支的 town／district 兩個欄位，其餘一字不差）
--     * ballot_number_units：代表的 town 取鄉鎮、district 取「第NN選舉區」（其他選舉別照舊）；視圖欄位清單不變，anomalies 與 activity_health 不用動。
--     * contribution_auto_tasks_ballot_numbers：補號次的派工單位照舊是鄉鎮（unit_town 去掉選舉區，不然記了選舉區的代表會讓 task_id 與 target.sub_region 變成「北竿鄉第02選舉區」），
--       items 多帶 electoral_district（有記才帶）；重查（cand_no_recheck）靠視圖，已經是對的。
--     * cand_no_dup_conflicts：不用改（它呼叫的 ballot_number_unit 變了，自動生效）。
--
--   parity（正式庫唯讀快照，PR 說明附結果）：今天所有臂的輸出逐件不變，新增的只有代表缺選舉區的補選區任務（2026：連江縣鄉鎮市民代表 26 件）。
--   守門：supabase/functions/_shared/rep-district.test.ts（落庫）、rep-district-sql.test.ts（SQL，含還原驗證）；scripts/arms-parity-rep-district.ts。

-- ------------------------------------------------------------
-- 1. 號次單位：代表改用選舉區（ELSE NULL 前多一個分支）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ballot_number_unit(p_election_type TEXT, p_county TEXT, p_district TEXT, p_town TEXT, p_village TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_county), '') IS NULL THEN NULL
    WHEN p_election_type = '縣市長' THEN replace(btrim(p_county), '臺', '台')
    WHEN p_election_type = '縣市議員' AND btrim(COALESCE(p_district, '')) LIKE '%選舉區' THEN replace(btrim(p_county), '臺', '台') || '|' || replace(replace(btrim(p_district), ' ', ''), '臺', '台')
    WHEN p_election_type IN ('鄉鎮市長', '直轄市山地原住民區長') AND NULLIF(btrim(p_town), '') IS NOT NULL THEN replace(btrim(p_county), '臺', '台') || '|' || replace(btrim(p_town), '臺', '台')
    WHEN p_election_type = '村里長' AND NULLIF(btrim(p_town), '') IS NOT NULL AND NULLIF(btrim(p_village), '') IS NOT NULL THEN replace(btrim(p_county), '臺', '台') || '|' || replace(btrim(p_town), '臺', '台') || '|' || replace(btrim(p_village), '臺', '台')
    -- 鄉鎮市民代表、直轄市山地原住民區民代表（#464）：號次單位＝鄉鎮市區＋選舉區（縣市|麥寮鄉第04選舉區，跟 regions 存代表選舉區的寫法一樣）。
    -- 兩種來源共用這一支：參選紀錄指到的 regions 列（sub_region 就是「麥寮鄉第04選舉區」，呼叫處把它同時當 p_district 與 p_town 傳進來）；
    -- 交件 payload（electoral_district＝「第04選舉區」、sub_region＝「麥寮鄉」；electoral_district 也可能整個寫成「麥寮鄉第4選舉區」）。
    -- 選舉區的數字一律補成兩位（第4＝第04）；沒有選舉區（只記到鄉鎮）、沒有鄉鎮、或選舉區看不出第幾區的回 NULL＝不檢查，不猜。
    WHEN p_election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN (
      SELECT CASE WHEN rd.num IS NOT NULL AND rd.num <> '0' AND rd.town <> ''
                  THEN replace(btrim(p_county), '臺', '台') || '|' || replace(rd.town, '臺', '台') || '第' || lpad(rd.num, 2, '0') || '選舉區' END
        FROM (SELECT (regexp_match(d.s, '第0*([0-9]+)選舉區$'))[1] AS num,
                     COALESCE(NULLIF(regexp_replace(d.s, '第[0-9]+選舉區$', ''), ''),
                              regexp_replace(replace(btrim(COALESCE(p_town, '')), ' ', ''), '(第[0-9]+)?選舉區$', '')) AS town
                FROM (SELECT replace(btrim(COALESCE(p_district, '')), ' ', '') AS s) d) rd)
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION ballot_number_unit IS
  '號次單位（每個單位各自從 1 編起）：縣市長＝縣市、縣市議員＝縣市|選舉區、鄉鎮市長與區長＝縣市|鄉鎮市區、村里長＝縣市|鄉鎮市區|村里、代表（鄉鎮市民代表、區民代表）＝縣市|鄉鎮第NN選舉區；沒有選舉區的代表與資料不全的回 NULL＝不檢查；臺／台正規化成台。'
  '參選紀錄（region_id 指到的 regions）與交件 payload（region／electoral_district／sub_region／village）共用這一支，補號次 20261008150000；代表改用選舉區 20261009050000（#464）';

-- ------------------------------------------------------------
-- 2. 視圖：代表的 town／district 拆開（其餘一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW ballot_number_units AS
  WITH m AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.politician_id, p.name, pe.cand_no, pe.candidacy_status,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           -- 代表的 regions.sub_region 是「麥寮鄉第04選舉區」：town 取鄉鎮、district 取「第04選舉區」（#464）；其他選舉別照舊
           CASE WHEN pe.election_type = '縣市議員' THEN NULL
                WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN NULLIF(regexp_replace(r.sub_region, '(第[0-9]+)?選舉區$', ''), '')
                ELSE r.sub_region END AS town,
           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region
                WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN substring(r.sub_region from '第[0-9]+選舉區$') END AS district,
           r.village,
           ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) AS unit
      FROM politician_elections pe
      JOIN elections e ON e.id = pe.election_id AND e.election_date >= activity_today() - 1
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.candidacy_status IN ('filed', 'elected', 'not_elected') OR (pe.candidacy_status = 'withdrawn' AND pe.cand_no IS NOT NULL)
  )
  SELECT m.election_id, m.election_type, m.unit,
         min(m.county) AS county, min(m.town) AS town, min(m.district) AS district, min(m.village) AS village,
         count(*)::INTEGER AS registered, count(m.cand_no)::INTEGER AS numbered, count(DISTINCT m.cand_no)::INTEGER AS distinct_numbers, max(m.cand_no) AS max_no,
         COALESCE(array_agg(DISTINCT m.cand_no ORDER BY m.cand_no) FILTER (WHERE m.cand_no IS NOT NULL), ARRAY[]::INTEGER[]) AS numbers,
         jsonb_agg(jsonb_build_object('politician_election_id', m.pe_id, 'politician_id', m.politician_id, 'name', m.name, 'cand_no', m.cand_no, 'candidacy_status', m.candidacy_status)
                   ORDER BY m.cand_no NULLS LAST, m.pe_id) AS members,
         -- 重複：兩位以上同號（人數沒到齊也算）。跳號：已有號次的人數等於名單人數（到齊），而號次不是 1..N 連續；人數沒到齊不算，所以不誤報
         CASE WHEN count(DISTINCT m.cand_no) < count(m.cand_no) THEN 'duplicate'
              WHEN count(m.cand_no) = count(*) AND count(DISTINCT m.cand_no) = count(*) AND max(m.cand_no) <> count(*) THEN 'gap' END AS kind
    FROM m
   WHERE m.unit IS NOT NULL
   GROUP BY m.election_id, m.election_type, m.unit;
COMMENT ON VIEW ballot_number_units IS
  '每個號次單位（ballot_number_unit）一列：名單人數 registered、有號次的 numbered、不重複的號次數 distinct_numbers、用了哪些號次 numbers、成員 members、問題種類 kind（duplicate／gap／空＝沒問題）。只算還沒投票的選舉。補號次 20261008150000；代表的 town 是鄉鎮、district 是「第NN選舉區」（#464，20261009050000）';

-- ------------------------------------------------------------
-- 3. 補號次臂：代表的派工單位照舊是鄉鎮，選舉區放 items（其餘一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g_all AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.cand_no, p.id AS politician_id, p.name,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           -- 名單公告是一個鄉鎮一份的：鄉鎮市長、直轄市山地原住民區長、村里長、鄉鎮市民代表、直轄市山地原住民區民代表再細到鄉鎮市區
           -- （鄉鎮市長的參選紀錄多半還沒記到鄉鎮，r.sub_region 空＝留在縣市層級那一件，代理從公告上補 sub_region）
           -- 代表的 regions.sub_region 可能是「麥寮鄉第04選舉區」（#464）：派工單位照舊是鄉鎮，選舉區放 district
           CASE WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN NULLIF(regexp_replace(r.sub_region, '(第[0-9]+)?選舉區$', ''), '')
                WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長') THEN r.sub_region END AS unit_town,
           -- 縣市議員的 regions.sub_region 存的是選舉區（第NN選舉區）；代表的選舉區取尾巴的「第NN選舉區」
           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region
                WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN substring(r.sub_region from '第[0-9]+選舉區$') END AS district,
           CASE WHEN pe.election_type = '村里長' THEN r.village END AS village
      FROM politician_elections pe
      -- 抽籤之後、投票日以前才派：窗口（起點）由規則決定（activity_rules「ballot_numbers」：draw +0 起、polling +0 止，補號次 20261008150000）；
      -- 這裡的 election_date 只是效能預篩（已投票的屆別不算，不然 seed 每 10 分鐘要掃全部歷史），不是第二份窗口。
      -- 投票日隔天還要算（- 1）：規則的窗口在隔天才關，seed 要看得到「臂還算得出來、窗口關了」才會把收回記成 window，不是 filled
      JOIN elections e ON e.id = pe.election_id AND e.election_date >= activity_today() - 1
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.candidacy_status = 'filed' AND pe.election_type IS NOT NULL AND COALESCE(r.region, p.region) IS NOT NULL
  ),
  ranked AS (
    SELECT g.*,
           (row_number() OVER w - 1) / 50 + 1 AS part,
           (count(*) OVER (PARTITION BY g.election_id, g.election_type, g.county, g.unit_town) - 1) / 50 + 1 AS parts
      FROM g_all g
    WINDOW w AS (PARTITION BY g.election_id, g.election_type, g.county, g.unit_town
                 ORDER BY g.district NULLS LAST, g.village NULLS LAST, g.name, g.pe_id)
  ),
  numbered AS (
    SELECT rk.*
      FROM ranked rk
     WHERE rk.cand_no IS NULL
       -- 已經有人交了這一人這一屆帶號次的 candidacy、還在等票（pending／verified）的先不派（退件了就會再派）；
       -- 交件可以只給姓名、沒給 politician_id（協議允許）：沒給的用姓名＋選舉別＋縣市對
       AND NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'election_id' = rk.election_id::TEXT AND c.payload->>'cand_no' IS NOT NULL
                          AND (c.payload->>'politician_id' = rk.politician_id::TEXT
                               OR (NULLIF(c.payload->>'politician_id', '') IS NULL AND btrim(c.payload->>'name') = rk.name
                                   AND c.payload->>'election_type' = rk.election_type
                                   AND replace(COALESCE(c.payload->>'region', rk.county), '臺', '台') = rk.county)))
  ),
  grouped AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts, count(*) AS items_count, bool_or(n.district IS NOT NULL) AS has_district,
           jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'politician_election_id', n.pe_id, 'politician_id', n.politician_id, 'name', n.name,
             'electoral_district', n.district, 'sub_region', n.unit_town, 'village', n.village))
             ORDER BY n.district NULLS LAST, n.village NULLS LAST, n.name, n.pe_id) AS items
      FROM numbered n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  ),
  u AS (
    SELECT gr.*, e.election_date,
           (SELECT m.on_date FROM election_milestones_all m
             WHERE m.election_id = gr.election_id AND m.kind = 'draw' AND (m.election_type = gr.election_type OR m.election_type IS NULL)
             ORDER BY m.election_type NULLS LAST LIMIT 1) AS draw_on,
           (SELECT m.on_date FROM election_milestones_all m
             WHERE m.election_id = gr.election_id AND m.kind = 'list_published' AND (m.election_type = gr.election_type OR m.election_type IS NULL)
             ORDER BY m.election_type NULLS LAST LIMIT 1) AS list_on,
           -- candidate_status＝交件協議的詞（名單公告前 registered、公告後 qualified），由 candidacy_status 換算，不是舊欄位
           candidacy_protocol_status('filed', candidacy_list_published(gr.election_id, gr.election_type, CURRENT_DATE)) AS candidate_status
      FROM grouped gr
      JOIN elections e ON e.id = gr.election_id
  ),
  -- 重複與跳號的重查：號次單位的名次先算在派工單位的全部號次單位上，再留下有問題的（kind 有值），一件最多 25 個號次單位
  ru AS (
    SELECT bu.*,
           CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END AS unit_town,
           (row_number() OVER w - 1) / 25 + 1 AS part,
           (count(*) OVER (PARTITION BY bu.election_id, bu.election_type, bu.county,
                           CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END) - 1) / 25 + 1 AS parts
      FROM ballot_number_units bu
    WINDOW w AS (PARTITION BY bu.election_id, bu.election_type, bu.county,
                              CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END
                 ORDER BY bu.unit)
  ),
  rn AS (
    SELECT ru.*, ballot_number_dups(ru.members) AS duplicates, ballot_number_missing(ru.registered, ru.numbered, ru.numbers) AS missing,
           CASE WHEN position('|' IN ru.unit) > 0 THEN replace(substr(ru.unit, position('|' IN ru.unit) + 1), '|', ' ') ELSE ru.county END AS label,
           (SELECT string_agg((t.m->>'name') || CASE WHEN t.m->>'cand_no' IS NOT NULL THEN '（' || (t.m->>'cand_no') || '號）' ELSE '（沒有號次）' END, '、' ORDER BY t.ord)
              FROM jsonb_array_elements(ru.members) WITH ORDINALITY AS t(m, ord)) AS who
      FROM ru
     WHERE ru.kind IS NOT NULL
  ),
  rg AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts, count(*) AS units_count,
           jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'unit', n.label, 'anomaly', n.kind, 'registered', n.registered, 'numbered', n.numbered,
             'duplicates', to_jsonb(n.duplicates), 'missing', to_jsonb(n.missing),
             'electoral_district', n.district, 'sub_region', n.town, 'village', n.village, 'members', n.members))
             ORDER BY n.unit) AS units,
           string_agg(n.label || '：' || CASE n.kind
                        WHEN 'duplicate' THEN '號次 ' || array_to_string(n.duplicates, '、') || ' 重複'
                                              || CASE WHEN cardinality(n.missing) > 0 THEN '，名單 ' || n.registered || ' 位都有號次卻缺 ' || array_to_string(n.missing, '、') ELSE '' END
                        ELSE '名單 ' || n.registered || ' 位都有號次，但號次不是 1 到 ' || n.registered || ' 連續，缺 ' || array_to_string(n.missing, '、') END
                      || '（' || n.who || '）', '；' ORDER BY n.unit) AS summary
      FROM rn n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  ),
  rc AS (
    SELECT rg.*, e.election_date,
           candidacy_protocol_status('filed', candidacy_list_published(rg.election_id, rg.election_type, CURRENT_DATE)) AS candidate_status
      FROM rg
      JOIN elections e ON e.id = rg.election_id
  )
  SELECT 'auto:candidacy_source_missing:cand_no:' || u.election_id || ':' || u.election_type || ':' || u.county
           || COALESCE(':' || u.unit_town, '') || CASE WHEN u.parts > 1 THEN ':p' || u.part ELSE '' END,
         'candidacy_source_missing',
         jsonb_strip_nulls(jsonb_build_object('kind', 'cand_no', 'election_id', u.election_id, 'election_type', u.election_type,
                            'region', u.county, 'sub_region', u.unit_town, 'election_date', u.election_date,
                            'draw_on', u.draw_on, 'list_on', u.list_on, 'candidate_status', u.candidate_status,
                            'missing', jsonb_build_array('cand_no'),
                            'part', u.part, 'parts', u.parts, 'items_count', u.items_count, 'items', u.items)),
         u.county || COALESCE(u.unit_town, '') || ' ' || u.election_id || ' ' || u.election_type || '：我們有 ' || u.items_count || ' 位已登記的參選人還沒有選票上的號次（cand_no）'
           || CASE WHEN u.parts > 1 THEN '（這個單位太大，拆成 ' || u.parts || ' 件，這是第 ' || u.part || ' 件）' ELSE '' END
           || '。號次是抽籤決定的（中選會預定 ' || COALESCE(u.draw_on::TEXT, '抽籤日') || ' 抽籤），抽完各縣市選舉委員會公告的候選人名單（預定 ' || COALESCE(u.list_on::TEXT, '名單公告日')
           || ' 前後公告）和選舉公報上都印著每個人的號次。號次是每個選舉區（村里長是每個村里、鄉鎮市長是每個鄉鎮）各自從 1 編起的，同一個單位不會有兩位同號。'
           || '名單在 target.items：請到該縣市選舉委員會網站（web.cec.gov.tw/<縣市代碼>ec/）找候選人名單公告或抽籤結果，逐位核對姓名'
           || CASE u.election_type WHEN '縣市議員' THEN '與選舉區' WHEN '村里長' THEN '與村里' ELSE '' END
           || '，查得到號次的每位用 candidacy 重交同一人同一屆：politician_id 與 name 照 target.items、election_id 填 ' || u.election_id || '、election_type 填「' || u.election_type
           || '」、region 填「' || u.county || '」'
           || CASE WHEN u.unit_town IS NOT NULL THEN '、sub_region 填「' || u.unit_town || '」'
                   WHEN u.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') THEN '、sub_region 填他所在的鄉鎮市區（公告是按鄉鎮分的）' ELSE '' END
           || CASE u.election_type WHEN '縣市議員' THEN '、electoral_district 照 target.items' WHEN '村里長' THEN '、village 照 target.items'
                                   WHEN '鄉鎮市民代表' THEN CASE WHEN u.has_district THEN '、items 裡有 electoral_district 的照填（代表的號次是按選舉區編的，沒有的不要自己加）' ELSE '' END
                                   WHEN '直轄市山地原住民區民代表' THEN CASE WHEN u.has_district THEN '、items 裡有 electoral_district 的照填（代表的號次是按選舉區編的，沒有的不要自己加）' ELSE '' END
                                   ELSE '' END
           || '、cand_no 填公告上的號次（正整數）、candidate_status 填「' || COALESCE(u.candidate_status, '') || '」；其他欄位（含政黨）不用帶、不要改。'
           || 'source_urls 第一個放你看到他號次的那一頁公告網址（縣市選委會的公告頁或選舉公報），不要放登記彙總表——它沒有號次，也不會被拿來核號次。'
           || '公告還沒出來就先不要交；一次最多交 20 筆，這一件可以分幾次交。查不到號次的位別留著不交，不要猜、不要依名單順序推。'
           || '系統會比對同一個號次單位裡的號次：跟已上線或等票中的另一位同號，這一筆會多要一張同意票，請先確認公告。',
         ARRAY['https://web.cec.gov.tw/<縣市選委會代碼>ec/ ← 該縣市選舉委員會網站：「候選人名單公告」「抽籤結果」（2022 年的長相：https://web.cec.gov.tw/tyec/article/37003 ← 桃園市長名單，「（1）張善政（2）賴香伶…」括號裡就是號次）',
               'https://web.cec.gov.tw/central/article/20892 ← 中選會「各種選舉公告」，列出各縣市選委會的公告',
               'https://eebulletin.cec.gov.tw ← 選舉公報（11 月中旬後上架，每位候選人那一欄印著號次）',
               '村里長、代表：鄉鎮市區公所／縣市選委會的「候選人登記冊（含抽籤號次）」（2022 年苗栗縣選委會 10-21 當天就公布了逐里的抽籤號次表）'],
         1, u.county
    FROM u
  UNION ALL
  SELECT 'auto:candidacy_source_missing:cand_no_recheck:' || rc.election_id || ':' || rc.election_type || ':' || rc.county
           || COALESCE(':' || rc.unit_town, '') || CASE WHEN rc.parts > 1 THEN ':p' || rc.part ELSE '' END,
         'candidacy_source_missing',
         jsonb_strip_nulls(jsonb_build_object('kind', 'cand_no_recheck', 'election_id', rc.election_id, 'election_type', rc.election_type,
                            'region', rc.county, 'sub_region', rc.unit_town, 'election_date', rc.election_date, 'candidate_status', rc.candidate_status,
                            'missing', jsonb_build_array('cand_no'),
                            'part', rc.part, 'parts', rc.parts, 'units_count', rc.units_count, 'units', rc.units)),
         rc.county || COALESCE(rc.unit_town, '') || ' ' || rc.election_id || ' ' || rc.election_type || '：有 ' || rc.units_count || ' 個號次單位的號次對不起來，請對公告重查'
           || CASE WHEN rc.parts > 1 THEN '（拆成 ' || rc.parts || ' 件，這是第 ' || rc.part || ' 件）' ELSE '' END
           || '。' || rc.summary || '。'
           || '號次是每個選舉區（村里長是每個村里、鄉鎮市長是每個鄉鎮）各自從 1 編起的：同一個單位出現同號＝至少一位的號次抄錯了；名單到齊、號次卻不是 1 到 N 連續＝有號次抄錯，或公告上有人我們名單沒有。'
           || '每個單位的成員與目前記的號次在 target.units[].members。請打開該單位的候選人名單公告或選舉公報逐位核對：'
           || '①我們記錯的，用 candidacy 重交那一位（politician_id、name、election_id、election_type、region 照 target，sub_region／village／electoral_district 照 target.units，cand_no 填公告上的號次，candidate_status 填「'
           || COALESCE(rc.candidate_status, '') || '」），只交跟公告不同的；②公告上有、我們名單沒有的人，用 candidacy 補進來（附同一份公告）；'
           || '③公告本身就跳號（候選人退選或資格不符、號次沒有遞補）而我們的號次都跟公告一致，用 no_change（outcome 填 confirmed）回報，finding 寫公告上的號次與頁碼。'
           || '公告還沒出來就略過這一件，不要回 no_change not_found（14 天內不再派）。',
         ARRAY['https://web.cec.gov.tw/<縣市選委會代碼>ec/ ← 該縣市選舉委員會網站：「候選人名單公告」「抽籤結果」',
               'https://eebulletin.cec.gov.tw ← 選舉公報（每位候選人那一欄印著號次）',
               '村里長、代表：鄉鎮市區公所／縣市選委會的「候選人登記冊（含抽籤號次）」'],
         1, rc.county
    FROM rc
$$;
COMMENT ON FUNCTION contribution_auto_tasks_ballot_numbers IS
  '補號次（缺口盤點 R8，2026-10-08）：已登記（candidacy_status＝filed）、沒有號次的參選紀錄，依單位（屆別×選舉別×縣市；鄉鎮市長、區長、村里長與代表到鄉鎮市區；超過 50 位拆件）整批派 candidacy_source_missing（target.kind＝cand_no，items 列名單）；'
  '另把號次單位裡的重複與跳號（視圖 ballot_number_anomalies）照派工單位聚成 cand_no_recheck（一件最多 25 個號次單位，target.units 附異常內容）。'
  '臂內沒有日期：抽籤當天起到投票日當天為止由規則 activity_rules「ballot_numbers」決定（draw +0、polling +0，補號次 20261008150000）。沒有來源的系統核對（見 DECISIONS 2026-10-08）；重複由 cand_no_dup_system_check 投系統票。'
  '代表（#464，20261009050000）：派工單位照舊是鄉鎮，記了選舉區的代表 items 多帶 electoral_district。';

-- ------------------------------------------------------------
-- 4. 補選區臂：多派「代表只記到鄉鎮、沒有選舉區」（名冊上找得到他才派；不新增臂）
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
           AND c.name_key = COALESCE(cec_name_key(p.name), NULLIF(cec_name_norm(p.name), ''))
      ) reg
     WHERE pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
       AND candidacy_is_listed(pe.candidacy_status) AND reg.n > 0
  ),
  gaps AS (
    SELECT g.*,
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
