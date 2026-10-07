-- 補號次：新派工臂 ballot_numbers（2026-10-08，缺口盤點 R8；docs/PLAN-task-activation.md 第 11 節）
-- ============================================================
--
-- 缺口：2026 參選紀錄的號次 cand_no 是 0／1,637，沒有任何一支臂會在抽籤之後派。中選會預定 2026-10-23 抽籤（roster_check_scope.ballot_draw_on），
-- 各縣市選舉委員會抽完公告候選人名單（名單上印著號次）、選舉公報也印；協議早就收 candidacy 的 cand_no（20260925000004 補了欄位、apply-contribution 會寫），
-- 只是沒有任何東西叫代理去補。這支新增一支臂，把「已登記、沒有號次」的參選紀錄按單位整批派出去。
--
-- 一、臂 contribution_auto_tasks_ballot_numbers（沿用任務型別 candidacy_source_missing，target.kind＝cand_no；任務編號
--      auto:candidacy_source_missing:cand_no:<屆別>:<選舉別>:<縣市>[:<鄉鎮市區>][:pN]）
--   * 條件：2026 這類屆別裡 candidacy_status＝filed（已登記；名單公告後還是 filed，只是交件的詞換成 qualified）、cand_no 空、人物沒被併走。
--     退選（withdrawn）、表態未登記（declared）、考慮中不派。臂本身不比日期——「抽籤之後、投票日以前」由規則決定（見三）；
--     臂也不限定屆別：只要某屆有 draw 里程碑（現在只有 2026），那一屆已登記沒號次的就會派，2028 不用再改。
--   * 單位：屆別×選舉別×縣市；村里長、鄉鎮市民代表、直轄市山地原住民區民代表再細到鄉鎮市區（一個鄉鎮的名單公告是一份）。
--     單位超過 50 位拆成幾件（:p1、:p2…，依選舉區、鄉鎮、村里、姓名排序，同一選舉區盡量在同一件）。
--   * target 帶 election_id、election_type（總表就是用這兩個欄位對規則問窗口）、region（縣市）、sub_region（鄉鎮市區，有的單位才有）、draw_on／list_on（里程碑日期）、
--     candidate_status（交件協議的詞：名單公告前 registered、公告後 qualified）、items（politician_election_id、politician_id、name，另有的單位帶 electoral_district、sub_region、village）。
--     整份 target 含人物 uuid，所以 #448 的測試名人物隔離照常管用（單位裡有測試人物，整件先不派）。
--   * 已經有人交了這一人這一屆帶 cand_no 的 candidacy、還在等票（pending／verified）的先不派；退件了就會再派。
--   * 臂本體沒有任何寫死的年份、日期、職位名單（只有「哪幾種選舉別再細到鄉鎮」這個結構常數，跟 election_results 臂一樣）。
--
-- 二、里程碑 draw：窗口的起點。roster_check_scope.ballot_draw_on 已經存著抽籤日（2026-10-23），但還沒有人把它搬成里程碑（P0 第 7 點記為 P2 動 roster_check 時再搬）。
--   這支 migration 自己補：照 P0 回填登記截止／名單公告的寫法，一個職位一列（election_type＝職位），basis＝official，status 依日期（已過＝done，否則 announced）；
--   ON CONFLICT DO NOTHING——別的 PR 也搬了同一個里程碑時，誰先上線誰贏，內容相同（兩邊都取 roster_check_scope.ballot_draw_on）；
--   這支也就不依賴別的 PR 先合。roster_check_scope 的 ballot_draw_on 欄位本身不動（roster_check 臂還在讀它）。
--
-- 三、規則（新臂，直接種成窗口，不經過「永遠開」）：activity='ballot_numbers'、window_kind='event'、
--      from_kind='draw'／from_offset=0（抽籤當天起）、until_kind='polling'／until_offset=0（到投票日當天為止，含當天）、min_status='announced'，範圍不限。
--   * 台北日界、含頭含尾：2026-10-22 不開、10-23 開、11-28 開、11-29 關（party_roster 到 11-28 為止，這支同樣）。
--   * 迄日：投票日以後號次已經沒有用處（候選人選完了），窗口關了 seed 會把還沒補上的收回，原因記 window（P2 party_roster 做的）。
--   * 優先層：照 #443 的通則（投票日前 180 天內＝前段）就好，不另加規則——10-23 在投票日前 36 天，自動落在前段。
--   * 不經過「永遠開」：總表過濾時對「連一列規則都沒有」的臂 RAISE EXCEPTION，所以規則要在換總表之前就種好（這支先種規則、再換總表）。
--
-- 四、新增一支臂的三處登記（計畫第 11 節）：總表加 UNION 分支與臂名標籤（機械替換：在 owner_mismatch 後面多一行）、activity_arm_names() 加名字、
--   activity_rules 種一條規則。總表以 main 最新版（20261008121000，party_roster 那支 P2）為底，只多一行；activity_arm_names() 以 P1 的定義為底，只多一個名字。
--   測試名人物隔離（#448）的 ph／phe 與 gap.arms_all 旗標整段一字不動。
--
-- 五、系統核對：不做（理由見 docs/DECISIONS.md 2026-10-08「補號次」）。簡述：09-24 的「登記名冊例外」只涵蓋登記彙總表（姓名、縣市、政黨、選區），登記彙總表沒有號次；
--   號次公告（各縣市選委會的候選人名單公告、抽籤結果）每個選委會一份、版面不一（2022 有掃描影像的用印版與可抽字的網站版、「（1）姓名（2）姓名」連寫的市長名單、
--   「選舉區 抽籤號次 姓名 政黨」逐列表），2026 的還沒出，沒有真實檔案可以測；號次錯了的代價是選票上的號次錯，不是缺一欄。所以只做任務提示與驗證提示。
--   同時關掉一個會被這個功能放大的洞：登記彙總表逐位核對（roster_batch）只比姓名、縣市、政黨、選區，帶 cand_no 的 candidacy 若引用登記彙總表會一票過、號次沒人核——
--   system-one 的 roster_batch 改成不撿帶 cand_no 的交件（_shared/cec-roster.ts rosterBatchEligible）。這不是新增系統核對，是不讓既有核對替它沒核過的欄位背書。
--
-- 不動：candidacy_list_published()、not_running、candidate_status_stale 三處（另一條 PR 在改）；臂用的 candidacy_protocol_status／candidacy_list_published 的簽名與呼叫方式照 party_roster。
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：politician_elections.cand_no／candidacy_status／region_id、regions(region, sub_region, village)、politicians(merged_into, region)、
--   elections.election_date、election_milestones／election_milestones_all、roster_check_scope.ballot_draw_on、candidacy_protocol_status(text, boolean)、candidacy_list_published(integer, text, date)、
--   contributions(contribution_type, status, payload)、activity_rules、P0／P1 的 activity_open／activity_require_rule。
--
-- 守門：supabase/functions/_shared/activity-ballot-numbers.test.ts（文字層：總表＝前一版加一行、臂名清單多一個名字、這支只動這幾樣；PGlite 行為層：假時鐘 10-22 不開、10-23 開、11-28 開、11-29 關，
--   今天輸出逐件不變，seed 窗口關了記 window；每條守門做還原驗證）；scripts/arms-parity-p2.ts ballot_numbers：正式庫唯讀快照，今天總表筆數與全欄雜湊相等（不進 CI，PR 說明附結果）。

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
-- 3. 臂：contribution_auto_tasks_ballot_numbers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, p.id AS politician_id, p.name,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           -- 名單公告是一個鄉鎮一份的：村里長、鄉鎮市民代表、直轄市山地原住民區民代表再細到鄉鎮市區
           CASE WHEN pe.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN r.sub_region END AS unit_town,
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
           || ' 前後公告）和選舉公報上都印著每個人的號次。名單在 target.items：請到該縣市選舉委員會網站（web.cec.gov.tw/<縣市代碼>ec/）找候選人名單公告或抽籤結果，逐位核對姓名'
           || CASE u.election_type WHEN '縣市議員' THEN '與選舉區' WHEN '村里長' THEN '與村里' ELSE '' END
           || '，查得到號次的每位用 candidacy 重交同一人同一屆：politician_id 與 name 照 target.items、election_id 填 ' || u.election_id || '、election_type 填「' || u.election_type
           || '」、region 填「' || u.county || '」'
           || CASE WHEN u.unit_town IS NOT NULL THEN '、sub_region 填「' || u.unit_town || '」' ELSE '' END
           || CASE u.election_type WHEN '縣市議員' THEN '、electoral_district 照 target.items' WHEN '村里長' THEN '、village 照 target.items' ELSE '' END
           || '、cand_no 填公告上的號次（正整數）、candidate_status 填「' || COALESCE(u.candidate_status, '') || '」；其他欄位（含政黨）不用帶、不要改。'
           || 'source_urls 第一個放你看到他號次的那一頁公告網址（縣市選委會的公告頁或選舉公報），不要放登記彙總表——它沒有號次，也不會被拿來核號次。'
           || '公告還沒出來就先不要交；一次最多交 20 筆，這一件可以分幾次交。查不到號次的位別留著不交，不要猜、不要依名單順序推。',
         ARRAY['https://web.cec.gov.tw/<縣市選委會代碼>ec/ ← 該縣市選舉委員會網站：「候選人名單公告」「抽籤結果」（2022 年的長相：https://web.cec.gov.tw/tyec/article/37003 ← 桃園市長名單，「（1）張善政（2）賴香伶…」括號裡就是號次）',
               'https://web.cec.gov.tw/central/article/20892 ← 中選會「各種選舉公告」，列出各縣市選委會的公告',
               'https://eebulletin.cec.gov.tw ← 選舉公報（11 月中旬後上架，每位候選人那一欄印著號次）',
               '村里長、代表：鄉鎮市區公所／縣市選委會的「候選人登記冊（含抽籤號次）」（2022 年苗栗縣選委會 10-21 當天就公布了逐里的抽籤號次表）'],
         1, u.county
    FROM u
$$;
COMMENT ON FUNCTION contribution_auto_tasks_ballot_numbers IS
  '補號次（缺口盤點 R8，2026-10-08）：已登記（candidacy_status＝filed）、沒有號次的參選紀錄，依單位（屆別×選舉別×縣市；村里長與代表到鄉鎮市區；超過 50 位拆件）整批派 candidacy_source_missing（target.kind＝cand_no，items 列名單）。'
  '臂內沒有日期：抽籤當天起到投票日當天為止由規則 activity_rules「ballot_numbers」決定（draw +0、polling +0，補號次 20261008150000）。沒有系統核對（見 DECISIONS 2026-10-08）。';

-- ------------------------------------------------------------
-- 4. 活動名清單：加 ballot_numbers（其餘一字不差）
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
-- 5. 總表：以 main 最新版（20261008121000）為底，只在 owner_mismatch 後面多一行 UNION 分支（臂名標籤 ballot_numbers）
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
