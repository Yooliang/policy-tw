-- 補號次臂：整批交件說明＋等票中的 cand_numbers 不重複派（issue #781，維護者 2026-10-30 批准；接 20261030100000）
--
-- 以 20261009070000 的現行定義為底，只動兩處（其餘一字不差，重查 cand_no_recheck 那一支完全不動）：
--   1. numbered：多一條 NOT EXISTS——等票中（pending／verified）的 cand_numbers 交件 items 涵蓋的人先不派（跟既有的「等票中的 candidacy 帶號次」同一個意思）；
--   2. what_we_need：教代理整個任務交一份 cand_numbers（payload.items 每位一列），不再一人一份 candidacy。
-- 派工單位、每 50 位拆件、task_id、target 都不變。
-- 守門：supabase/functions/_shared/cand-numbers.test.ts（還原驗證：拿掉排除條件，等票中的人會被重派而變紅）。
CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH pending_batch AS MATERIALIZED (
    SELECT cb.payload->>'election_id' AS election_id, bi->>'politician_election_id' AS pe_id
      FROM contributions cb, jsonb_array_elements(CASE WHEN jsonb_typeof(cb.payload->'items') = 'array' THEN cb.payload->'items' ELSE '[]'::jsonb END) bi
     WHERE cb.contribution_type = 'cand_numbers' AND cb.status IN ('pending', 'verified')
  ),
  g_all AS (
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
       -- 整批交件（cand_numbers，#781）還在等票（pending／verified）而且 items 涵蓋他的先不派（退件了就會再派；落庫時被標錯或同號的列沒寫，缺口還在就會重派）；
       -- 等票中的整批在 pending_batch 只算一次（雜湊反連接），不是每個候選列各展開一遍
       AND NOT EXISTS (SELECT 1 FROM pending_batch pb WHERE pb.election_id = rk.election_id::TEXT AND pb.pe_id = rk.pe_id::TEXT)
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
           || '，查得到號次的每位列進**一份** cand_numbers 交件（整個任務一份、不要一人一份 candidacy；contribution_type 填 cand_numbers，task_id 照這一件）：payload.election_id 填 ' || u.election_id || '、election_type 填「' || u.election_type
           || '」、region 填「' || u.county || '」'
           || CASE WHEN u.unit_town IS NOT NULL THEN '、sub_region 填「' || u.unit_town || '」'
                   WHEN u.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') THEN '、sub_region 填他所在的鄉鎮市區（公告是按鄉鎮分的）' ELSE '' END
           || '，payload.items 每位一列 {politician_election_id（照 target.items 的 politician_election_id）, cand_no（公告上的號次，正整數）}，最多 150 列；'
           || 'source_urls 第一個放你看到他號次的那一頁公告網址（縣市選委會的公告頁或選舉公報），不要放登記彙總表——它沒有號次，也不會被拿來核號次。'
           || '公告上找不到的人不要放進 items，不要猜、不要依名單順序推；公告還沒出來就先不要交。'
           || '驗證者只會開一次公告逐列核對：抄錯的列會被標出來、只退那幾列（其餘照過），不會整批作廢；落庫前系統也逐列檢查同一個號次單位裡有沒有同號，同號的列不寫、回到缺口重派。',
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
  '補號次（2026-10-08；#464 代表選舉區；#781 整批交件，2026-10-30）：已登記（candidacy_status＝filed）、沒有號次的參選紀錄，依單位（屆別×選舉別×縣市；鄉鎮市長、區長、村里長與代表到鄉鎮市區；超過 50 位拆件）整批派 candidacy_source_missing（target.kind＝cand_no），代理一件交一份 cand_numbers（items 每位一列）；等票中的 candidacy／cand_numbers 涵蓋的人不重複派；另把號次單位的重複與跳號照派工單位聚成 cand_no_recheck。';
