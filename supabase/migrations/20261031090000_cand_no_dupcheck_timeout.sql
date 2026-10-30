-- 整批號次落庫前的重複檢查逾時（2026-10-31，維護者批准「做」）
--
-- 事故：10-30～31 整批號次交件（cand_numbers）203 件被自動退件、5 件 apply_failed，全是村里長整批 36～50 人，錯誤都是
--   cand_no_batch_conflicts: canceling statement due to statement timeout；真正號次重複只有 8 件。
-- 原因：cand_no_batch_conflicts() 對每一個 item 撈 2026 同選舉別、同號次的全部參選紀錄再逐筆呼叫 ballot_number_unit，
--   村里長 1 號有 5,900 多筆 → 50 人整批要算 30 萬次單位（正式庫 EXPLAIN ANALYZE：50 人整批 21.9 秒、shared hit 184 萬頁）；
--   而且 politician_elections 沒有任何 cand_no 相關索引。
--
-- 本檔五件事：
--   1. 索引 politician_elections (election_id, election_type, cand_no) WHERE cand_no IS NOT NULL
--      （一般 CREATE INDEX：migration 在交易裡跑，CONCURRENTLY 不能；3.7 萬列建索引是毫秒級，沿用 20261019010000 的慣例）
--   2. 重寫 cand_no_batch_conflicts：每個 (選舉, 選舉別, 號次) 組合只撈一次已上線的紀錄、每筆只算一次號次單位（MATERIALIZED），
--      再用單位對單位雜湊連接——成本跟整批人數無關，只跟「那個號次的全國筆數」有關
--   3. 補號次臂（contribution_auto_tasks_ballot_numbers）排除「同選舉、同號次單位、同名（正規化）、不同人物、對方已有號次」的列：
--      這種列補不上（會撞同號），多半是同一位候選人被建成兩筆人物，先交給合併任務
--   4. 同名人物配對（contribution_auto_tasks_dup）多一個來源：上述配對（縣市不同、出生年不明，原本的條件配不到），
--      target 帶 cand_no_gap／cand_no_unit；cand_no_front_pull 把這種合併任務拉到最前（3 × visitor_front_seconds）
--   5. cand_no_progress() 多兩欄：今天因逾時退件的整批數、今天因號次重複退件的整批數（只回數字）
-- 守門：supabase/functions/_shared/cand-numbers.test.ts（SQL 行為與還原驗證）、cand-no-dupcheck-timeout.test.ts。
-- 以下各函式皆以最新定義為底，只動上列處（其餘一字不差）。

CREATE INDEX IF NOT EXISTS idx_politician_elections_cand_no ON politician_elections (election_id, election_type, cand_no) WHERE cand_no IS NOT NULL;

-- 號次重複的落庫前逐列檢查：回傳「不能寫」的列與原因（整批沒衝突就回空）
--    衝突有兩種：①同一批裡另一位（同選舉、同號次單位、不同人）填了同一個號次——兩列都回，不知道誰抄錯；
--    ②已上線的參選紀錄裡另一位（同選舉別、同號次單位、不是同一個人）已經是這個號次。
--    號次單位的算法與 cand_no_dup_conflicts、視圖 ballot_number_units 同一支 ballot_number_unit，單位算不出來的列不檢查。
--    效能（20261031090000）：live 只依 (election_id, election_type, cand_no) 取一次並一次算好單位，不逐列呼叫；走索引 idx_politician_elections_cand_no。
CREATE OR REPLACE FUNCTION cand_no_batch_conflicts(p_items JSONB) RETURNS TABLE (politician_election_id INTEGER, cand_no INTEGER, reason TEXT)
LANGUAGE sql STABLE AS $$
  WITH it AS (
    SELECT (x->>'politician_election_id')::INTEGER AS pe_id, (x->>'cand_no')::INTEGER AS no
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) x
     WHERE (x->>'politician_election_id') ~ '^[0-9]{1,9}$' AND (x->>'cand_no') ~ '^[0-9]{1,6}$' AND (x->>'cand_no')::INTEGER > 0
  ),
  me AS (
    SELECT it.pe_id, it.no, pe.election_id, pe.election_type, p.id AS pid, p.name,
           ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) AS unit
      FROM it
      JOIN politician_elections pe ON pe.id = it.pe_id
      JOIN politicians p ON p.id = pe.politician_id
      LEFT JOIN regions r ON r.id = pe.region_id
  ),
  intra AS (
    SELECT a.pe_id, a.no, '同一批的「' || b.name || '」也填了 ' || a.no || ' 號（同一個號次單位：' || replace(a.unit, '|', ' ') || '）' AS why
      FROM me a
      JOIN me b ON b.pe_id <> a.pe_id AND b.election_id = a.election_id AND b.election_type = a.election_type AND b.unit = a.unit AND b.no = a.no AND b.pid <> a.pid
     WHERE a.unit IS NOT NULL
  ),
  keys AS (
    SELECT DISTINCT m.election_id, m.election_type, m.no FROM me m WHERE m.unit IS NOT NULL
  ),
  live AS MATERIALIZED (
    SELECT k.election_id, k.election_type, k.no, pe2.id AS pe2_id, p2.id AS pid2, p2.name AS name2,
           ballot_number_unit(pe2.election_type, COALESCE(r2.region, p2.region), r2.sub_region, r2.sub_region, r2.village) AS unit
      FROM keys k
      JOIN politician_elections pe2 ON pe2.election_id = k.election_id AND pe2.election_type = k.election_type AND pe2.cand_no = k.no
      JOIN politicians p2 ON p2.id = pe2.politician_id AND p2.merged_into IS NULL
      LEFT JOIN regions r2 ON r2.id = pe2.region_id
  ),
  recs AS (
    SELECT a.pe_id, a.no, '已上線的「' || l.name2 || '」已經是 ' || a.no || ' 號（同一個號次單位：' || replace(a.unit, '|', ' ') || '）' AS why
      FROM me a
      JOIN live l ON l.election_id = a.election_id AND l.election_type = a.election_type AND l.no = a.no AND l.unit = a.unit AND l.pe2_id <> a.pe_id AND l.pid2 <> a.pid
     WHERE a.unit IS NOT NULL
  )
  SELECT x.pe_id, x.no, string_agg(DISTINCT x.why, '；') FROM (SELECT * FROM intra UNION ALL SELECT * FROM recs) x GROUP BY x.pe_id, x.no
$$;
COMMENT ON FUNCTION cand_no_batch_conflicts IS '整批號次（cand_numbers）落庫前的逐列重複檢查：回傳不能寫的列（同批同號、或已上線的他人同號）與原因；沒衝突回空。號次單位同 cand_no_dup_conflicts；已上線那側每個號次只撈一次、一次算好單位（#781，20261031090000 修逾時）';
REVOKE EXECUTE ON FUNCTION cand_no_batch_conflicts(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cand_no_batch_conflicts(JSONB) TO service_role;

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
           -- 號次單位與正規化姓名（20261031090000）：排除「同單位同名不同人、對方已有號次」的列用（算法同 ballot_number_unit／同名人物配對）
           ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) AS unit,
           regexp_replace(regexp_replace(p.name, '[．·‧・•.\s]', '', 'g'), '臺', '台', 'g') AS nkey,
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
       -- 同一個選舉、同一個號次單位裡有同名（正規化）的另一個人物、而對方已有號次：這一列多半是同一位候選人被建成兩筆人物，
       -- 抄公告也補不上（補上去會撞「與已上線他人同號」）。先不派，等 duplicate_politician 合併任務處理（合併後同一人只剩一列）
       AND NOT EXISTS (SELECT 1 FROM g_all o
                        WHERE o.election_id = rk.election_id AND o.election_type = rk.election_type AND o.unit = rk.unit AND o.nkey = rk.nkey
                          AND o.cand_no IS NOT NULL AND o.politician_id <> rk.politician_id AND rk.unit IS NOT NULL)
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
  '補號次（2026-10-08；#464 代表選舉區；#781 整批交件，2026-10-30）：已登記（candidacy_status＝filed）、沒有號次的參選紀錄，依單位（屆別×選舉別×縣市；鄉鎮市長、區長、村里長與代表到鄉鎮市區；超過 50 位拆件）整批派 candidacy_source_missing（target.kind＝cand_no），代理一件交一份 cand_numbers（items 每位一列）；等票中的 candidacy／cand_numbers 涵蓋的人不重複派；同號次單位同名不同人且對方已有號次的列不派（交合併任務，20261031090000）；另把號次單位的重複與跳號照派工單位聚成 cand_no_recheck。';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_dup()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH n AS (
    SELECT p.id, p.name, p.party, p.region, p.birth_year, p.current_position,
           regexp_replace(regexp_replace(p.name, '[．·‧・•.\s]', '', 'g'), '臺', '台', 'g') AS nkey
    FROM politicians p WHERE p.merged_into IS NULL
  ),
  -- 擋住號次缺口的配對（20261031090000）：同一個選舉、同一個號次單位（ballot_number_unit）裡同名（正規化）的兩個人物，一個已有號次、一個沒有。
  -- 同單位同名同時登記，多半是同一位候選人被建成兩筆；縣市不同、出生年不明，原本的「同縣市或同出生年」條件配不到。
  ue AS (
    SELECT pe.election_id, pe.election_type, p.id AS pid, pe.cand_no,
           ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) AS unit,
           regexp_replace(regexp_replace(p.name, '[．·‧・•.\s]', '', 'g'), '臺', '台', 'g') AS nkey
      FROM politician_elections pe
      JOIN elections e ON e.id = pe.election_id AND e.election_date >= activity_today() - 1
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.candidacy_status = 'filed' AND pe.election_type IS NOT NULL AND COALESCE(r.region, p.region) IS NOT NULL
  ),
  up AS (
    SELECT LEAST(x.pid, y.pid) AS a_id, GREATEST(x.pid, y.pid) AS b_id, min(x.unit) AS unit
      FROM ue x JOIN ue y ON y.election_id = x.election_id AND y.election_type = x.election_type AND y.unit = x.unit AND y.nkey = x.nkey AND y.pid <> x.pid
     WHERE x.unit IS NOT NULL AND x.cand_no IS NULL AND y.cand_no IS NOT NULL
     GROUP BY 1, 2
  )
  SELECT 'auto:duplicate_politician:' || a.id || '|' || b.id, 'duplicate_politician',
         jsonb_build_object(
           'pair_key', a.id || '|' || b.id,
           'a', jsonb_build_object('id', a.id, 'name', a.name, 'party', a.party, 'region', a.region, 'birth_year', a.birth_year, 'current_position', a.current_position),
           'b', jsonb_build_object('id', b.id, 'name', b.name, 'party', b.party, 'region', b.region, 'birth_year', b.birth_year, 'current_position', b.current_position))
           || CASE WHEN up.a_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cand_no_gap', true, 'cand_no_unit', replace(up.unit, '|', ' ')) END,
         '「' || a.name || '」有兩筆人物資料（' || COALESCE(a.region, '') || ' ' || COALESCE(a.party, '') || '／' || COALESCE(b.region, '') || ' ' || COALESCE(b.party, '') || '），很可能是同一個人。'
           || '請查中選會候選人資料庫（歷屆參選、出生年、政黨）或官方名單，確認是不是同一人。'
           || '用 merge_politician 回報：same_person=true 帶 keep_id（保留資料較完整、參選紀錄較多的那筆）與 remove_id；確認是不同人就 same_person=false。'
           || '兩種都要 reason（≥20 字）與 source_urls。item.current.a／b 是兩筆的全欄＋參選紀錄＋政見標題，current.system_vote 是系統的判定。'
           || '**system_vote 只看我們自己資料庫裡的欄位，不是獨立證據**——它說不同人，你還是要自己查一次官方來源。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會歷屆參選，同一人會列在同一筆', 'POST /functions/v1/fetch-cec-data {"queryName":"姓名"}', '該縣市議會／政府官網的人物簡介'],
         2, COALESCE(a.region, b.region)
  FROM n a JOIN n b ON a.nkey = b.nkey AND a.id < b.id
  LEFT JOIN up ON up.a_id = a.id AND up.b_id = b.id
  WHERE (COALESCE(a.region, '') = COALESCE(b.region, '') OR (a.birth_year IS NOT NULL AND a.birth_year = b.birth_year) OR up.a_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM politician_pair_resolutions x WHERE x.pair_key = a.id || '|' || b.id)
    -- Jev 判「不同人」：只認**最新一筆**判定（原本是「有沒有任何一筆 diff」，後來改判 same 也壓不掉舊的），
    -- 而且只壓 jev_pair_exclusion_days() 天（原本永久）。
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT j.choice, j.probability, j.asked_at
        FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.subject_id = a.id || '|' || b.id
        ORDER BY j.asked_at DESC
        LIMIT 1
      ) latest
      WHERE latest.choice = 'diff'
        AND latest.probability >= system_one_min_probability()
        AND latest.asked_at > now() - (jev_pair_exclusion_days() || ' days')::INTERVAL
    )
    AND NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.contribution_type = 'merge_politician' AND c.status IN ('pending', 'verified', 'disputed')
        AND c.payload->>'keep_id' ~* '^[0-9a-f-]{36}$' AND c.payload->>'remove_id' ~* '^[0-9a-f-]{36}$'
        AND politician_pair_key((c.payload->>'keep_id')::UUID, (c.payload->>'remove_id')::UUID) = a.id || '|' || b.id)
$fn$;

COMMENT ON FUNCTION contribution_auto_tasks_dup IS
  '同名人物配對 → duplicate_politician 任務；已有人類結論的不派，Jev 最新一筆高信心「不同人」的壓 90 天（不是永久）；另收「同選舉同號次單位同名、一個有號次一個沒有」的配對（縣市不同也派，target.cand_no_gap／cand_no_unit，20261031090000）';

CREATE OR REPLACE FUNCTION cand_no_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER; v_boost BIGINT; v_top BIGINT; v_seq BIGINT; v_cur TEXT;
BEGIN
  IF activity_today() > DATE '2026-11-28' THEN RETURN 0; END IF;
  SELECT 2 * q.visitor_front_seconds, 3 * q.visitor_front_seconds, 5 * q.visitor_front_seconds / 2
    INTO v_boost, v_top, v_seq FROM queue_settings q WHERE q.id = 1;
  IF v_boost IS NULL OR v_boost <= 0 THEN RETURN 0; END IF;
  -- 當前提前職位：依序清單中第一個還有號次缺口列的職位
  SELECT s.et INTO v_cur
    FROM unnest(ARRAY['鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']) WITH ORDINALITY AS s(et, ord)
   WHERE EXISTS (SELECT 1 FROM task_dispatches t WHERE t.target->>'kind' = 'cand_no' AND t.target->>'election_type' = s.et)
   ORDER BY s.ord LIMIT 1;
  UPDATE task_dispatches d
     SET boost_seconds = x.want, cooling = false
    FROM (
      SELECT d2.task_id,
             CASE WHEN d2.target->>'cand_no_gap' = 'true' THEN v_top   -- 擋住號次缺口的同名人物合併任務（contribution_auto_tasks_dup 的 target.cand_no_gap）
                  WHEN d2.target->>'kind' = 'cand_no' THEN
                    CASE WHEN d2.target->>'election_type' IN ('縣市長', '縣市議員') THEN v_top
                         WHEN d2.target->>'election_type' = v_cur THEN v_seq
                         ELSE v_boost END
                  ELSE
                    (SELECT CASE WHEN c.payload->>'election_type' IN ('縣市長', '縣市議員') THEN v_top
                                 WHEN c.contribution_type = 'cand_numbers' AND c.payload->>'election_type' = v_cur THEN v_seq
                                 ELSE v_boost END
                       FROM contributions c
                      WHERE d2.task_id = 'verify:' || c.id::text
                        AND c.status = 'pending'
                        AND ((c.contribution_type = 'candidacy' AND c.payload ? 'cand_no')
                             OR c.contribution_type = 'cand_numbers'))
             END AS want
        FROM task_dispatches d2
    ) x
   WHERE d.task_id = x.task_id
     AND x.want IS NOT NULL
     AND d.boost_seconds < x.want;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION cand_no_front_pull IS '號次的缺口列與等票的驗證列（單人 candidacy 帶 cand_no、整批 cand_numbers 都算），插隊秒數至少拉到 2 × visitor_front_seconds；縣市長、縣市議員 3 ×；依序清單（鄉鎮市長→山地原住民區長→鄉鎮市民代表→山地原住民區民代表→村里長）中第一個還有缺口列的職位拉到 2.5 ×；擋住號次缺口的同名人物合併任務（target.cand_no_gap）3 ×；pg_cron 每小時第 3 分；2026-11-28 之後不做事（2026-10-31）';

-- 號次進度彙總：多兩欄（今天因逾時退件的整批數、今天因號次重複退件的整批數）；其餘一字不差（以 20261030140000 為底）。
-- 判斷：review_notes 的 [auto] 說明——逾時＝「statement timeout」（落庫連續失敗退件），重複＝「號次重複」且不是逾時。
CREATE OR REPLACE FUNCTION public.cand_no_progress() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '8s' AS $$
  WITH t AS (SELECT (date_trunc('day', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei') AS d0),
  c AS (
    SELECT c.status, c.created_at, (c.contribution_type = 'cand_numbers') AS is_batch,
           (c.status = 'rejected' AND c.contribution_type = 'cand_numbers' AND c.review_notes LIKE '%statement timeout%') AS is_timeout,
           (c.status = 'rejected' AND c.contribution_type = 'cand_numbers' AND c.review_notes LIKE '%號次重複%' AND c.review_notes NOT LIKE '%statement timeout%') AS is_dup
      FROM contributions c
     WHERE (c.contribution_type = 'candidacy' AND c.payload ? 'cand_no') OR c.contribution_type = 'cand_numbers'
  )
  SELECT jsonb_build_object(
    'as_of', now(),
    'gap_tasks_in_queue', (SELECT count(*) FROM task_dispatches WHERE target->>'kind' = 'cand_no'),
    'gap_boosted', (SELECT count(*) FROM task_dispatches WHERE target->>'kind' = 'cand_no' AND boost_seconds > 0),
    'submitted_today', (SELECT count(*) FROM c, t WHERE c.created_at >= t.d0),
    'submitted_1h', (SELECT count(*) FROM c WHERE c.created_at >= now() - interval '1 hour'),
    'pending_now', (SELECT count(*) FROM c WHERE c.status = 'pending'),
    'verified_now', (SELECT count(*) FROM c WHERE c.status = 'verified'),
    'applied_total', (SELECT count(*) FROM c WHERE c.status = 'applied'),
    'rejected_today', (SELECT count(*) FROM c, t WHERE c.status = 'rejected' AND c.created_at >= t.d0),
    'candidacies_with_no', (SELECT count(*) FROM politician_elections WHERE election_id = 2026 AND cand_no IS NOT NULL),
    'filed_total', (SELECT count(*) FROM politician_elections WHERE election_id = 2026 AND candidacy_status IN ('filed', 'qualified', 'elected', 'not_elected')),
    'votes_1h', (SELECT count(*) FROM contribution_votes v JOIN contributions k ON k.id = v.contribution_id
                  WHERE ((k.contribution_type = 'candidacy' AND k.payload ? 'cand_no') OR k.contribution_type = 'cand_numbers')
                    AND v.created_at >= now() - interval '1 hour'),
    'batch_pending_now', (SELECT count(*) FROM c WHERE c.is_batch AND c.status = 'pending'),
    'batch_submitted_1h', (SELECT count(*) FROM c WHERE c.is_batch AND c.created_at >= now() - interval '1 hour'),
    'batch_timeout_rejected_today', (SELECT count(*) FROM c, t WHERE c.is_timeout AND c.created_at >= t.d0),
    'batch_dup_rejected_today', (SELECT count(*) FROM c, t WHERE c.is_dup AND c.created_at >= t.d0)
  );
$$;
REVOKE ALL ON FUNCTION public.cand_no_progress() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cand_no_progress() TO anon, authenticated;
COMMENT ON FUNCTION public.cand_no_progress IS '號次進度彙總（公開唯讀，只回數字）：單筆帶號次 candidacy＋整批 cand_numbers；batch_timeout_rejected_today／batch_dup_rejected_today＝今天交的整批因逾時／號次重複退件的數量；給工作機小畫面每分鐘讀';
