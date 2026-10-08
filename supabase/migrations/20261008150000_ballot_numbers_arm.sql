-- 補號次：新派工臂 ballot_numbers（2026-10-08，缺口盤點 R8；docs/PLAN-task-activation.md 第 11 節）
-- ============================================================
--
-- 缺口：2026 參選紀錄的號次 cand_no 是 0／1,637，沒有任何臂會在抽籤之後派。中選會預定 2026-10-23 抽籤（roster_check_scope.ballot_draw_on），
-- 各縣市選舉委員會抽完公告候選人名單（名單上印著號次）、選舉公報也印；協議早就收 candidacy 的 cand_no（20260925000004 補了欄位、apply-contribution 會寫），
-- 只是沒有任何東西叫代理去補。這支新增一支臂，把「已登記、沒有號次」的參選紀錄按單位整批派出去；再加上號次的重複與跳號檢查（維護者 10-08：「同一場選舉的號次有沒有重複很好被找出來，有沒有跳號也可以」）。
--
-- 一、臂 contribution_auto_tasks_ballot_numbers（沿用任務型別 candidacy_source_missing）
--   * 補號次（target.kind＝cand_no，任務編號 auto:candidacy_source_missing:cand_no:<屆別>:<選舉別>:<縣市>[:<鄉鎮市區>][:pN]）
--     條件：candidacy_status＝filed（已登記；名單公告後仍是 filed，交件的詞換成 qualified）、cand_no 空、人物沒被併走。退選（withdrawn）、表態未登記（declared）不派。
--     臂本身不比日期——「抽籤之後、投票日以前」由規則決定（見三）；也不限定屆別：只要某屆有 draw 里程碑，那一屆已登記沒號次的就會派，2028 不用再改。
--     派工單位：屆別×選舉別×縣市；鄉鎮市長、直轄市山地原住民區長、村里長、鄉鎮市民代表、直轄市山地原住民區民代表再細到鄉鎮市區（一個鄉鎮的名單公告是一份；
--     鄉鎮市長的參選紀錄多半還沒記到鄉鎮，記了才分、沒記的留在縣市那一件）。單位超過 50 位拆成幾件（:p1、:p2…，依選舉區、村里、姓名排序）。
--     target 帶 election_id、election_type（總表用這兩個欄位對規則問窗口）、region（縣市）、sub_region、draw_on／list_on、candidate_status（名單公告前 registered、公告後 qualified）、
--     items（politician_election_id、politician_id、name，另有的單位帶 electoral_district、sub_region、village）。整份 target 含人物 uuid，#448 的測試名人物隔離照常管用。
--     已經有人交了這一人這一屆帶 cand_no 的 candidacy、還在等票（pending／verified）的先不派；退件了就會再派。
--   * 重查（target.kind＝cand_no_recheck，task_id auto:candidacy_source_missing:cand_no_recheck:…）：視圖 ballot_number_anomalies（見二）有列的號次單位，照派工單位聚成一件（一件最多 25 個號次單位），
--     target.units 附每個單位的異常內容（重複的號次、缺的號次、成員與目前記的號次），任務說明逐單位寫出來。同一個活動名（ballot_numbers）、同一條規則，窗口一樣是抽籤當天起到投票日當天止。
--
-- 二、號次單位與重複／跳號（函式 ballot_number_unit、視圖 ballot_number_units／ballot_number_anomalies）
--   號次是每個「號次單位」各自從 1 編起的，不是派工單位：縣市長＝縣市；縣市議員＝選舉區；鄉鎮市長、直轄市山地原住民區長＝鄉鎮市區；村里長＝村里；
--   鄉鎮市民代表、直轄市山地原住民區民代表＝選舉區，但我們的參選紀錄與交件只記到鄉鎮、沒有代表的選舉區，單位算不出來＝不檢查（寧可不檢查，也不要把同鄉鎮不同選舉區的同號誤報成重複；
--   等 #449 的登記彙總表資料表把 district 補進參選紀錄就能納入）。派工可以照舊按大單位，但檢查一定按號次單位。
--   重複＝同一個單位兩位以上同號（人數沒到齊也算）。跳號＝已有號次的人數等於名單人數（到齊），而號次不是 1..N 連續；人數沒到齊不算，所以不誤報。
--   注意名單人數是「我們的名單」：名單缺人（例如只收了當選人的 2022 屆、2026 還沒清查完的村里長）時，號次會看起來跳號——這正是要重查的：不是號次抄錯，就是公告上有人我們沒有。
--   視圖不分屆別都算（歷史屆別的列大多是名單缺落選人），但派工只在規則窗口內（目前只有 2026），activity_health 只報還沒投票的選舉。
--   交件時的重複檢查（系統票 not_supported）在 20261008151000_cand_no_dup_check.sql。
--
-- 三、draw 里程碑與規則
--   * draw 里程碑：roster_check_scope.ballot_draw_on 已存抽籤日（2026-10-23），但還沒人搬成里程碑（P0 第 7 點記為 P2 動 roster_check 時再搬）。這支自己補：照 P0 回填登記截止／名單公告的寫法，
--     一個職位一列（election_type＝職位），basis＝official，status 依日期；ON CONFLICT DO NOTHING——別的 PR 也搬了同一個里程碑時誰先上線誰贏。ballot_draw_on 欄位本身不動（roster_check 臂還在讀它）。
--     只寫職位專屬列、不寫整場列：activity_open 找里程碑時職位專屬列優先、沒有才退回整場列（election_type 空），而派工的 target 一定帶 election_type；
--     寫整場列反而會讓沒有自己抽籤日的職位（例如總統）也開窗。activity_open_now 的「整場」那一列因此顯示關著，那只是監控視圖的顯示，沒有任何派工讀它。
--   * 規則 ballot_numbers：event、from_kind＝draw／+0（抽籤當天起）、until_kind＝polling／+0（到投票日當天為止，含當天）、min_status＝announced，範圍不限，台北日界含頭含尾：
--     2026-10-22 不開、10-23 開、11-28 開、11-29 關；關了由 seed 收回，原因記 window。優先層照 #443 通則（投票日前 180 天＝前段），不另加規則。
--     新臂直接種成窗口、不經過「永遠開」；要在換總表之前種，不然總表過濾時對「連一列規則都沒有」的臂 RAISE EXCEPTION。
--
-- 四、新增一支臂的三處登記（計畫第 11 節）：總表加 UNION 分支與臂名標籤（機械替換：以 main 最新版 20261008121000 為底，在 owner_mismatch 後面多一行）、activity_arm_names() 加名字、activity_rules 種一條規則。
--   測試名人物隔離（#448）的 ph／phe 與 gap.arms_all 旗標整段一字不動。
--
-- 五、同一支 migration 順手做的三個機械替換（各只多一個條件，其餘一字不差；同儕審查 agy 提出）
--   * task_dispatches_drop_applied（P0 的現行定義）：補號次的任務是一個單位一件、代理一位一筆交 candidacy，任何一筆落庫就 DELETE 整件任務，下一輪 seed 又把它當新缺口插回隊尾（gap_events 一直 closed／reopened）。
--     編號 auto:candidacy_source_missing:cand_no 開頭的（補號次與重查）不在落庫時收回，交給 seed 每 10 分鐘依缺口是否還在收回（缺口補完 filled、窗口關了 window）。
--   * roster_batch_candidates（20260924000013 的現行定義）：登記彙總表逐位核對（roster_batch）只比姓名、縣市、政黨、選區，沒有號次；帶 cand_no 的 candidacy 若引用名冊 PDF（或 web.cec.gov.tw/api/file/ 下的公告 PDF）
--     會一票放行、號次沒人核。在查詢裡就排除（不是撈 500 筆再在記憶體丟掉，那樣這些交件會永遠佔著 LIMIT 的前面，擠掉後面正常的名冊）。
--   * activity_health（20261008113000 的現行定義）：多一段 ballot_number_anomaly（還沒投票的選舉裡有重複或跳號的號次單位，按選舉×選舉別彙總成一列）。
--
-- 六、系統核對：號次本身不做來源核對（理由見 docs/DECISIONS.md 2026-10-08「補選票號次」）：09-24 的「登記名冊例外」只涵蓋登記彙總表上有的欄位，登記彙總表沒有號次；
--   號次公告每個選委會一份、版面不一，2026 的還沒出，沒有真實檔案可以測。做的是內部一致性檢查（不是來源核對）：同一個號次單位裡跟已上線或等票中的另一位同號，系統票 not_supported（+1），
--   見 20261008151000。
--
-- 不動：candidacy_list_published()、not_running、candidate_status_stale 三處（另一條 PR 在改）；臂用的 candidacy_protocol_status／candidacy_list_published 的簽名與呼叫方式照 party_roster
--   （依賴：candidacy_list_published 目前傳 CURRENT_DATE，另一條 PR 改寫它的日界時，這支的呼叫處跟著它走）。
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：politician_elections.cand_no／candidacy_status／region_id、regions(region, sub_region, village)、politicians(merged_into, region)、
--   elections.election_date、election_milestones／election_milestones_all、roster_check_scope.ballot_draw_on、candidacy_protocol_status(text, boolean)、candidacy_list_published(integer, text, date)、
--   contributions(contribution_type, status, payload)、activity_rules、P0／P1 的 activity_open／activity_require_rule／activity_arm_names。
--
-- 守門：supabase/functions/_shared/activity-ballot-numbers.test.ts、ballot-number-checks.test.ts；scripts/arms-parity-ballot.ts：正式庫唯讀快照，今天總表筆數與全欄雜湊相等（不進 CI，PR 說明附結果）。

-- ------------------------------------------------------------
-- 1. 里程碑 draw：從 roster_check_scope.ballot_draw_on 回填（一個職位一列）
-- ------------------------------------------------------------
INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
SELECT s.election_id, 'draw', s.election_type, s.ballot_draw_on, 'official',
       CASE WHEN s.ballot_draw_on <= activity_today() THEN 'done' ELSE 'announced' END,
       '2026-10-08 由 roster_check_scope.ballot_draw_on 回填（補號次臂的窗口起點）'
  FROM roster_check_scope s
 WHERE s.ballot_draw_on IS NOT NULL
ON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;

-- ------------------------------------------------------------
-- 2. 規則：新臂直接種成窗口（要在換總表之前：總表對沒有規則的臂 RAISE）
-- ------------------------------------------------------------
INSERT INTO activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, enabled, note)
SELECT 'ballot_numbers', 'event', 'draw', 0, 'polling', 0, 'announced', true,
       '補號次：抽籤當天起到投票日當天為止（含頭含尾，台北日界）；範圍不限、每場選舉各自從自己的抽籤日算；優先層走 #443 的通則（投票日前 180 天＝前段），不另加規則'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'ballot_numbers');

-- 規則不是預期的一條（沒種成、被別的規則蓋過、窗口形狀不對）就不能上線
DO $$
BEGIN
  IF (SELECT count(*) FROM activity_rules r WHERE r.activity = 'ballot_numbers') <> 1
     OR NOT EXISTS (SELECT 1 FROM activity_rules r
                     WHERE r.activity = 'ballot_numbers' AND r.enabled AND r.window_kind = 'event'
                       AND r.from_kind = 'draw' AND r.from_offset = 0 AND r.until_kind = 'polling' AND r.until_offset = 0
                       AND r.reasons IS NULL AND r.levels IS NULL AND r.election_types IS NULL AND r.jurisdictions IS NULL) THEN
    RAISE EXCEPTION '補號次：ballot_numbers 的規則不是預期的一條「抽籤當天起到投票日當天為止」';
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 3. 號次單位與重複／跳號檢查
-- ------------------------------------------------------------
-- 號次是每個「號次單位」各自從 1 編起的，不是派工的單位：
--   縣市長＝縣市；縣市議員＝選舉區（縣市＋第NN選舉區）；鄉鎮市長、直轄市山地原住民區長＝鄉鎮市區（縣市＋鄉鎮市區）；村里長＝村里（縣市＋鄉鎮市區＋村里）；
--   鄉鎮市民代表、直轄市山地原住民區民代表＝選舉區，但我們的參選紀錄與交件都只記到鄉鎮（沒有代表的選舉區），單位算不出來，所以回 NULL＝不檢查
--   （等 #449 的登記彙總表資料表把 district 補進參選紀錄之後才能納入；寧可不檢查，也不要拿「同鄉鎮同號」誤報成重複）。
-- 算不出單位的（縣市議員沒記到選舉區、村里長沒記到村里、鄉鎮市長沒記到鄉鎮…）也回 NULL。
-- 派工單位（臂的 :p1 拆件、縣市×選舉別、村里長與代表到鄉鎮）可以照舊按大單位，但重複與跳號的檢查一定按這個單位。
CREATE OR REPLACE FUNCTION ballot_number_unit(p_election_type TEXT, p_county TEXT, p_district TEXT, p_town TEXT, p_village TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_county), '') IS NULL THEN NULL
    WHEN p_election_type = '縣市長' THEN replace(btrim(p_county), '臺', '台')
    WHEN p_election_type = '縣市議員' AND btrim(COALESCE(p_district, '')) LIKE '%選舉區' THEN replace(btrim(p_county), '臺', '台') || '|' || replace(btrim(p_district), ' ', '')
    WHEN p_election_type IN ('鄉鎮市長', '直轄市山地原住民區長') AND NULLIF(btrim(p_town), '') IS NOT NULL THEN replace(btrim(p_county), '臺', '台') || '|' || btrim(p_town)
    WHEN p_election_type = '村里長' AND NULLIF(btrim(p_town), '') IS NOT NULL AND NULLIF(btrim(p_village), '') IS NOT NULL THEN replace(btrim(p_county), '臺', '台') || '|' || btrim(p_town) || '|' || btrim(p_village)
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION ballot_number_unit IS
  '號次單位（每個單位各自從 1 編起）：縣市長＝縣市、縣市議員＝縣市|選舉區、鄉鎮市長與區長＝縣市|鄉鎮市區、村里長＝縣市|鄉鎮市區|村里；代表（沒有記選舉區）與資料不全的回 NULL＝不檢查。'
  '參選紀錄（region_id 指到的 regions）與交件 payload（region／electoral_district／sub_region／village）共用這一支，補號次 20261008150000';

-- 每個號次單位一列：名單上有幾位（registered）、幾位有號次（numbered）、用了哪些號次、成員。
-- 名單＝已登記（filed）＋已有結果（elected／not_elected）＋退選但有號次的（抽籤時他在名單裡，號次不會因為他退選而讓出來）。
CREATE OR REPLACE VIEW ballot_number_units AS
  WITH m AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.politician_id, p.name, pe.cand_no, pe.candidacy_status,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           CASE WHEN pe.election_type <> '縣市議員' THEN r.sub_region END AS town,
           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region END AS district,
           r.village,
           ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) AS unit
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.candidacy_status IN ('filed', 'elected', 'not_elected') OR (pe.candidacy_status = 'withdrawn' AND pe.cand_no IS NOT NULL)
  )
  SELECT m.election_id, m.election_type, m.unit,
         min(m.county) AS county, min(m.town) AS town, min(m.district) AS district, min(m.village) AS village,
         count(*)::INTEGER AS registered, count(m.cand_no)::INTEGER AS numbered, count(DISTINCT m.cand_no)::INTEGER AS distinct_numbers, max(m.cand_no) AS max_no,
         COALESCE(array_agg(DISTINCT m.cand_no ORDER BY m.cand_no) FILTER (WHERE m.cand_no IS NOT NULL), ARRAY[]::INTEGER[]) AS numbers,
         jsonb_agg(jsonb_build_object('politician_election_id', m.pe_id, 'politician_id', m.politician_id, 'name', m.name, 'cand_no', m.cand_no, 'candidacy_status', m.candidacy_status)
                   ORDER BY m.cand_no NULLS LAST, m.pe_id) AS members
    FROM m
   WHERE m.unit IS NOT NULL
   GROUP BY m.election_id, m.election_type, m.unit;
COMMENT ON VIEW ballot_number_units IS
  '每個號次單位（ballot_number_unit）一列：名單人數 registered、有號次的 numbered、不重複的號次數 distinct_numbers、用了哪些號次 numbers、成員 members。補號次 20261008150000';

-- 重複與跳號。重複：同一個單位有兩位以上用同一個號次（人數沒到齊也算）。
-- 跳號：已有號次的人數等於名單人數（到齊了），而號次不是 1..N 連續。人數還沒到齊不算跳號（可能只是還沒補完），所以不誤報。
CREATE OR REPLACE VIEW ballot_number_anomalies AS
  SELECT u.election_id, u.election_type, u.unit, u.county, u.town, u.district, u.village, u.registered, u.numbered,
         CASE WHEN u.distinct_numbers < u.numbered THEN 'duplicate' ELSE 'gap' END AS kind,
         ARRAY(SELECT (e->>'cand_no')::INTEGER FROM jsonb_array_elements(u.members) e WHERE e->>'cand_no' IS NOT NULL
                GROUP BY 1 HAVING count(*) > 1 ORDER BY 1) AS duplicates,
         CASE WHEN u.numbered = u.registered
              THEN ARRAY(SELECT g FROM generate_series(1, u.registered) g EXCEPT SELECT unnest(u.numbers) ORDER BY 1)
              ELSE ARRAY[]::INTEGER[] END AS missing,
         u.numbers, u.members
    FROM ballot_number_units u
   WHERE u.distinct_numbers < u.numbered
      OR (u.numbered = u.registered AND u.distinct_numbers = u.registered AND u.max_no <> u.registered);
COMMENT ON VIEW ballot_number_anomalies IS
  '號次單位裡的重複（duplicate：兩位以上同號）與跳號（gap：號次人數＝名單人數卻不是 1..N 連續；人數未到齊不算）。duplicates＝被重複用的號次，missing＝到齊時 1..N 裡沒出現的號次。'
  '正常是空的；有列＝要重查（派工臂 cand_no_recheck）。退選／資格不符造成的真跳號也會列在這裡，代理核對公告後用 no_change 確認。補號次 20261008150000';
GRANT SELECT ON ballot_number_units, ballot_number_anomalies TO anon, authenticated;

-- ------------------------------------------------------------
-- 4. 臂：contribution_auto_tasks_ballot_numbers（補號次 cand_no，與重複／跳號的重查 cand_no_recheck）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, p.id AS politician_id, p.name,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           -- 名單公告是一個鄉鎮一份的：鄉鎮市長、直轄市山地原住民區長、村里長、鄉鎮市民代表、直轄市山地原住民區民代表再細到鄉鎮市區
           -- （鄉鎮市長的參選紀錄多半還沒記到鄉鎮，r.sub_region 空＝留在縣市層級那一件，代理從公告上補 sub_region）
           CASE WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN r.sub_region END AS unit_town,
           -- 縣市議員的 regions.sub_region 存的是選舉區（第NN選舉區）
           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region END AS district,
           CASE WHEN pe.election_type = '村里長' THEN r.village END AS village
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     -- 抽籤之後、投票日以前才派：不在臂裡比日期，由規則決定（activity_rules「ballot_numbers」：draw +0 起、polling +0 止，補號次 20261008150000）
     WHERE pe.candidacy_status = 'filed' AND pe.cand_no IS NULL AND pe.election_type IS NOT NULL
       AND COALESCE(r.region, p.region) IS NOT NULL
       -- 已經有人交了這一人這一屆帶號次的 candidacy、還在等票的先不派（退件了就會再派）
       AND NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'politician_id' = p.id::TEXT AND c.payload->>'election_id' = pe.election_id::TEXT
                          AND c.payload->>'cand_no' IS NOT NULL)
  ),
  numbered AS (
    SELECT g.*,
           (row_number() OVER w - 1) / 50 + 1 AS part,
           (count(*) OVER (PARTITION BY g.election_id, g.election_type, g.county, g.unit_town) - 1) / 50 + 1 AS parts
      FROM g
    WINDOW w AS (PARTITION BY g.election_id, g.election_type, g.county, g.unit_town
                 ORDER BY g.district NULLS LAST, g.village NULLS LAST, g.name, g.pe_id)
  ),
  grouped AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts, count(*) AS items_count,
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
  -- 重複與跳號的重查：視圖 ballot_number_anomalies 一個號次單位一列，這裡照派工單位（跟上面同一套切法）聚成一件，一件最多 25 個號次單位
  ra AS (
    SELECT a.*, CASE WHEN a.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN a.town END AS unit_town
      FROM ballot_number_anomalies a
  ),
  rn AS (
    SELECT ra.*,
           (row_number() OVER w - 1) / 25 + 1 AS part,
           (count(*) OVER (PARTITION BY ra.election_id, ra.election_type, ra.county, ra.unit_town) - 1) / 25 + 1 AS parts,
           CASE WHEN position('|' IN ra.unit) > 0 THEN replace(substr(ra.unit, position('|' IN ra.unit) + 1), '|', ' ') ELSE ra.county END AS label,
           (SELECT string_agg((t.m->>'name') || CASE WHEN t.m->>'cand_no' IS NOT NULL THEN '（' || (t.m->>'cand_no') || '號）' ELSE '（沒有號次）' END, '、' ORDER BY t.ord)
              FROM jsonb_array_elements(ra.members) WITH ORDINALITY AS t(m, ord)) AS who
      FROM ra
    WINDOW w AS (PARTITION BY ra.election_id, ra.election_type, ra.county, ra.unit_town ORDER BY ra.unit)
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
           || CASE u.election_type WHEN '縣市議員' THEN '、electoral_district 照 target.items' WHEN '村里長' THEN '、village 照 target.items' ELSE '' END
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
  '臂內沒有日期：抽籤當天起到投票日當天為止由規則 activity_rules「ballot_numbers」決定（draw +0、polling +0，補號次 20261008150000）。沒有來源的系統核對（見 DECISIONS 2026-10-08）；重複由 cand_no_dup_system_check 投系統票。';

-- ------------------------------------------------------------
-- 5. 活動名清單：加 ballot_numbers（其餘一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'raw:policy_missing',
    'raw:profile_gap',
    'raw:policy_validity',
    'raw:progress_stale',
    'raw:candidacy_source_missing',
    'raw:roster_check',
    'raw:policy_election_missing',
    'raw:candidate_status_stale',
    'raw:election_result_missing',
    'dup',
    'legacy',
    'mismatch',
    'policy_dup',
    'not_running',
    'mayor_policies',
    'term_policies',
    'roster_villages',
    'township_gap',
    'region_gap',
    'elected_missing',
    'roster_cec_gap',
    'district_seats',
    'policy_elements',
    'deadline_due',
    'lineage_candidates',
    'handover_missing',
    'lineage_roles',
    'lineage_links',
    'career_sources',
    'withdrawn_filing',
    'party_gap',
    'party_roster',
    'party_info',
    'placeholder_politicians',
    'election_results',
    'owner_mismatch',
    'ballot_numbers'
  ]::TEXT[]
$$;
COMMENT ON FUNCTION activity_arm_names IS
  '派工總表 contribution_auto_tasks_arms() 的活動名清單（29 個 UNION 分支；raw 依任務型別拆成 raw:<型別>）。新增一支臂時：這裡加名字、總表加分支與標籤、activity_rules 種一條規則——'
  '漏任何一步，activity_health 的 arm_without_rule 或守門測試會紅。2026-10-08（PLAN-task-activation 3.1）；補號次（20261008150000）加 ballot_numbers';

-- 萬一上面沒種齊，下面換掉總表就會把整支臂濾光，seed 隔一輪就把派工列全收回——寧可讓這支 migration 失敗
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(activity_arm_names()) AS a(arm)
              WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm AND r.enabled)) THEN
    RAISE EXCEPTION '補號次：activity_arm_names() 裡有活動沒有啟用中的規則';
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 6. 總表：以 main 最新版（20261008121000）為底，只在 owner_mismatch 後面多一行 UNION 分支（臂名標籤 ballot_numbers）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),
       -- 姓名看起來是測試資料的人物（2026-10-08）：他們的任務只走 placeholder_politician（見檔頭）
       ph AS MATERIALIZED (SELECT p.id::TEXT AS pid FROM politicians p WHERE politician_name_is_placeholder(p.name)),
       phe AS MATERIALIZED (SELECT pe.id AS peid FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name)),
       tagged AS (
  SELECT 'raw:' || r.task_type AS arm, r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END AS what_we_need,
         r.hint_sources, r.reward, r.region
    FROM raw r
   WHERE (r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region))
     AND NOT (r.task_type = 'progress_stale' AND EXISTS (SELECT 1 FROM due d WHERE d.target->>'policy_id' = r.target->>'policy_id'))
  UNION ALL SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t
  UNION ALL SELECT 'legacy' AS arm, t.* FROM contribution_auto_tasks_legacy() t
  UNION ALL SELECT 'mismatch' AS arm, t.* FROM contribution_auto_tasks_mismatch() t
  UNION ALL SELECT 'policy_dup' AS arm, t.* FROM contribution_auto_tasks_policy_dup() t
  UNION ALL SELECT 'not_running' AS arm, t.* FROM contribution_auto_tasks_not_running() t
  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t
  UNION ALL SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_term_policies() t
  UNION ALL SELECT 'roster_villages' AS arm, t.* FROM contribution_auto_tasks_roster_villages() t
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t
  UNION ALL SELECT 'roster_cec_gap' AS arm, t.* FROM contribution_auto_tasks_roster_cec_gap() t
  UNION ALL SELECT 'district_seats' AS arm, t.* FROM contribution_auto_tasks_district_seats() t
  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM contribution_auto_tasks_policy_elements() t
  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM due t
  UNION ALL SELECT 'lineage_candidates' AS arm, t.* FROM contribution_auto_tasks_lineage_candidates() t
  UNION ALL SELECT 'handover_missing' AS arm, t.* FROM contribution_auto_tasks_handover_missing() t
  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM contribution_auto_tasks_lineage_roles() t
  UNION ALL SELECT 'lineage_links' AS arm, t.* FROM contribution_auto_tasks_lineage_links() t
  UNION ALL SELECT 'career_sources' AS arm, t.* FROM contribution_auto_tasks_career_sources() t
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM contribution_auto_tasks_withdrawn_filing() t
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t
       ),
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       keyed AS (
  SELECT g.*, election_id_or_null(g.target->>'election_id') AS eid, NULLIF(g.target->>'election_type', '') AS etype FROM tagged g
       ),
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until
    FROM (SELECT x.arm, x.eid, x.etype
            FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d OFFSET 0) x
           WHERE activity_require_rule(x.arm) OFFSET 0) k  -- 每組（約 84 組）檢查一次；OFFSET 0 擋住檢查被推到 7 千多列上去
    LEFT JOIN LATERAL (  -- LEFT：窗口關著的組也留下來（o.source 是 NULL），旗標 gap.arms_all 開著時 seed 要看它們
      SELECT * FROM activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o ON true
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         CASE WHEN o.source IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
   WHERE (o.source IS NOT NULL OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
     AND (g.arm = 'placeholder_politicians'
      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)
              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT)))
$$;

COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '全站自動缺口總表：29 個分支 UNION，每個分支貼臂名（arm），再依 activity_rules／activity_overrides 過濾（沒有開窗的規則＝濾掉）。'
  '測試名人物（politician_name_is_placeholder）的非 placeholder 任務不出現（#448）。'
  'opened_by＝開窗的規則＋里程碑＋迄日（seed 寫進 task_dispatches.opened_by）。seed_auto_task_queue() 每 10 分鐘算一次（約 4 秒）。'
  '交易內旗標 gap.arms_all＝on 時多回傳被規則濾掉的列（opened_by 是 NULL；開著的列一定不是 NULL），seed 用它分辨收回原因是 window 還是 filled；沒設旗標＝只回開著的列。2026-10-08（P2 20261008121000）；'
  '補號次（20261008150000）加 ballot_numbers 分支';
-- ------------------------------------------------------------
-- 7. 健康檢查：多一段 ballot_number_anomaly（20261008113000 的現行定義，其餘一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW activity_health AS
  SELECT 'election_without_polling'::TEXT AS check_name, e.id::TEXT AS subject, '選舉沒有投票日（elections.election_date 是空的），所有以投票日為起點的規則都開不起來'::TEXT AS detail
    FROM elections e WHERE e.election_date IS NULL
  UNION ALL
  SELECT 'activity_all_rules_disabled', r.activity, '這個活動的規則全部停用，等於整類任務不派（要停就用覆寫 closed 留下理由）'
    FROM activity_rules r GROUP BY r.activity HAVING NOT bool_or(r.enabled)
  UNION ALL
  SELECT 'override_without_rule', o.activity, '有覆寫但這個活動沒有任何規則（拼錯活動名？）'
    FROM activity_overrides o WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = o.activity) GROUP BY o.activity
  UNION ALL
  SELECT 'window_inverted', 'rule ' || r.id || ' / election ' || f.election_id,
         '起日 ' || (f.on_date + r.from_offset) || ' 晚於迄日 ' || (u.on_date + r.until_offset) || '，這條規則在這場選舉永遠不會開'
    FROM activity_rules r
    JOIN election_milestones_all f ON f.kind = r.from_kind
    JOIN election_milestones_all u ON u.kind = r.until_kind AND u.election_id = f.election_id
         AND (u.election_type IS NOT DISTINCT FROM f.election_type OR u.election_type IS NULL OR f.election_type IS NULL)
   WHERE r.enabled AND f.on_date + r.from_offset > u.on_date + r.until_offset
  UNION ALL
  SELECT 'milestone_scope_drift', s.election_id || ' / ' || s.election_type,
         'roster_check_scope 的登記截止／名單公告日與 election_milestones 對不上（兩份真相）：改了舊欄位沒同步到里程碑，或相反'
    FROM roster_check_scope s
   WHERE NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = s.election_id AND m.kind = 'registration_close'
                        AND m.election_type = s.election_type AND m.on_date = s.registration_closed_on)
      OR NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = s.election_id AND m.kind = 'list_published'
                        AND m.election_type = s.election_type AND m.on_date = s.list_announced_on)
  UNION ALL
  SELECT 'arm_without_rule', a.arm, '派工臂「' || a.arm || '」沒有任何規則：contribution_auto_tasks_arms() 對它的每一列都會因為沒有開窗的規則而被濾掉（整支臂無聲消失）'
    FROM unnest(activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm)
  UNION ALL
  SELECT 'bulletin_milestone_missing', e.id::TEXT,
         '選舉有公報資料夾（bulletin_dir）、還沒投票，卻沒有整場的 bulletin_published 里程碑：bulletin-watch 不會偵測它（bulletin_watch_targets 只看有里程碑列的選舉），「公報之前」的降級規則也開不起來。新增選舉時要在 election_milestones 補那一列（預估用 expected／statutory；公報已上架就補 done／official）'
    FROM elections e
   WHERE e.bulletin_dir IS NOT NULL
     AND e.election_date >= activity_today()
     AND NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL)
  UNION ALL
  SELECT 'ballot_number_anomaly', a.election_id || ' / ' || a.election_type,
         count(*) || ' 個號次單位的號次有重複或跳號（重複 ' || count(*) FILTER (WHERE a.kind = 'duplicate') || '、跳號 ' || count(*) FILTER (WHERE a.kind = 'gap') || '）：看視圖 ballot_number_anomalies；名單缺人時也會這樣，派工臂 cand_no_recheck 會請代理對公告重查'
    FROM ballot_number_anomalies a JOIN elections e ON e.id = a.election_id
   WHERE e.election_date >= activity_today()
   GROUP BY a.election_id, a.election_type
  UNION ALL
  SELECT 'clock_overridden', current_setting('app.activity_today', true), '時鐘被 app.activity_today 覆寫了：所有時間窗都在用這個假日期（只該出現在測試）'
   WHERE NULLIF(current_setting('app.activity_today', true), '') IS NOT NULL;
COMMENT ON VIEW activity_health IS
  '派工時間窗的健康檢查，正常是空的：選舉缺投票日、活動的規則全停用、覆寫指到沒有規則的活動、窗口起迄顛倒、roster_check_scope 與里程碑對不上、派工臂沒有任何規則（arm_without_rule，P1）、'
  '有公報資料夾又還沒投票的選舉缺整場的 bulletin_published 里程碑（bulletin_milestone_missing，2026-10-08 公報偵測）、號次單位有重複或跳號（ballot_number_anomaly，還沒投票的選舉，補號次 20261008150000）、時鐘被覆寫。2026-10-08（PLAN-task-activation 3 風險第 2 點）';

-- ------------------------------------------------------------
-- 8. 補號次的任務不在單筆落庫時收回（task_dispatches_drop_applied 只多一個條件）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_dispatches_drop_applied() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND NEW.task_id LIKE 'auto:%'
     -- 補號次與重查是一個單位一件、代理一位一筆交：一筆落庫不代表整件做完，由 seed 依缺口還在不在收回（補號次 20261008150000）
     AND NEW.task_id NOT LIKE 'auto:candidacy_source_missing:cand_no%' THEN
    -- >>> gap_events：收回原因與是哪一筆貢獻，交給 task_dispatches 的 AFTER DELETE 觸發器記進 closed 事件
    PERFORM set_config('gap.close_reason', 'filled', true);
    PERFORM set_config('gap.close_detail', jsonb_build_object('via', 'drop_applied', 'contribution_id', NEW.id)::TEXT, true);
    -- <<< gap_events
    DELETE FROM task_dispatches WHERE task_id = NEW.task_id;
    -- >>> gap_events：用完就清，不影響同一個交易裡之後的刪除
    PERFORM set_config('gap.close_reason', '', true);
    PERFORM set_config('gap.close_detail', '', true);
    -- <<< gap_events
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 9. roster_batch_candidates：帶號次的 candidacy 不撿（只多一個條件）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION roster_batch_candidates(p_limit INTEGER DEFAULT 500)
RETURNS TABLE (id UUID, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.payload, c.source_urls FROM contributions c
   WHERE c.status = 'pending' AND c.contribution_type = 'candidacy'
     -- 帶號次的不撿：登記彙總表沒有號次，名冊判 supported 會讓沒人核過的號次一票過（補號次 20261008150000）；在查詢裡排除，不佔 LIMIT
     AND (c.payload->>'cand_no' IS NULL OR c.payload->>'cand_no' = '')
     AND EXISTS (SELECT 1 FROM unnest(c.source_urls) u WHERE u ~* '^https://web\.cec\.gov\.tw/api/file/[0-9a-f-]+\.pdf$')
     AND NOT EXISTS (SELECT 1 FROM jev_decisions j WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT
                       AND j.question = 'source_support' AND j.model LIKE 'policy-tw/roster-batch%')
   ORDER BY c.created_at
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 1000))
$$;
