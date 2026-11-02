-- 2026 名單清查只派「有缺口的單位」，缺的人逐位列出（policy-ops#180，小良哥 2026-11-02「好，做」）；取代 #840 的單人任務
-- ============================================================
--
-- 起因：2026 名單清查（roster_check）有 206 單位未完成，但多數其實已對齊或只差幾人；結案條件是人數對齊，少一人就永遠掛著。
--   #840（20261102210000）另開單人任務又卡「清查已結案」的死結（花蓮市國盛里 周玉梅 1 號，清查兩次被退）。
--
-- 做法（沿用既有 roster_check 任務與臂，不新造任務型別、不新增第三種去重；資料仍走代理交件＋同儕驗證，系統不直寫任何參選資料）：
--   1. roster_gap_units()：以官方名冊鏡像算出「有缺口的單位」，單位切法＝roster_check 任務編號 auto:roster_check:2026:<縣市[鄉鎮]>:<選舉別>。
--      缺口＝cec_roster_diff() 有 kind=missing（官方有、本站沒有），或官方有號次、本站已有此人（同單位同姓名鍵）卻沒有 cand_no。
--      每單位一列，items 逐人列出：姓名、村里（村里長用 li_code 對 regions.admin_code 末三碼）、選舉區、號次、政黨、出生年、官方 JSON 網址。
--   2. 總表 contribution_auto_tasks_arms()（現行＝20261102010000）再加兩處（開關沿用 roster_unify_on()，關掉整套回復）：
--      (a) 2026 的 roster_check 列，單位有缺口 → 缺口 items 併進 target.items（取代舊的缺人項），說明加一段怎麼逐人交；
--          單位還沒有 roster_check 列（人數已對齊而結案）但有缺口 → 為它開一列（target 形狀同 findings_only）；
--      (b) 2026 的 roster_check 列，單位的官方名冊鏡像是新鮮的（3 天內抓成功且有資料）、卻沒有缺口、也沒有別種名冊差異 → 不派
--          （收回：task_dispatches 的列消失，seed 走一般缺口消失的收回）。名冊鏡像不新鮮的單位照舊，不因為抓不到官方名冊就收回。
--      派工完全由「現在有沒有缺口」決定，所以退過的人下一輪仍在：交件被退不會讓缺口消失，也不寫任何冷卻（冷卻只有 task_checks 的 no_change，照舊）。
--   3. 取代 #840：停掉 cec-missing-person-tasks-daily 排程、刪掉 cec_missing_person_tasks_create；已開（open）的 roster_missing 單人任務收掉
--      （contribution_tasks 設 closed、closed_at；不動任何參選資料）。
-- 守門：_shared/roster-gap-units.test.ts。

-- ▼▼ SECTION: gap ▼▼
CREATE OR REPLACE FUNCTION roster_gap_tid(p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT replace(p_task_id, '臺', '台') $$;

-- 逐人怎麼交（接在說明後面；一單位一張，不分單人任務）
CREATE OR REPLACE FUNCTION roster_gap_text() RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT '【逐位補缺口】target.items 的 kind＝缺人（中選會名單有、本站沒有這個人）或缺號次（本站已有此人、只缺號次），每項帶姓名、official（村里、選舉區、號次、政黨、出生年〔民國年月日與西元年〕）與 source_url（官方名單 JSON 網址）。'
    || '缺人→先查人物是否已存在（同名者依 official.birth_year、縣市與經歷判斷是不是同一人）；已存在→用 candidacy 帶 politician_id 掛上既有人物，不存在→用 candidacy 新增（附人物基本資料）。'
    || '兩種都要：election_id 2026、election_type 與縣市（target.county）照 target，村里長另填 sub_region 鄉鎮、village 村里，議員與代表填選舉區，candidate_status 填 registered，'
    || 'cand_no 填 official.cand_no（同時交號次，不用另開單），party 照名單原字，source_urls 第一個放 item.source_url。'
    || '缺號次→用 candidacy 重交同一人同一屆（politician_id 照 item），cand_no 填 official.cand_no。'
    || '名單的姓名其實是本站某位已有的人（寫法不同）→用 no_change 說明，不要重複新增；官方資料有誤才用 no_change 附來源。'
    || '全部處理完用 roster_check 收尾（election_id、region、election_type 照 target 原樣帶回；cec_count 可留空，note 寫補了誰）；只處理一部分就不要交 roster_check——缺口還在，系統下一輪會把剩下的人再列出來。'
$$;

-- 官方名冊鏡像新鮮的單位（用 roster_check 任務編號表示；3 天內抓成功且有資料）
CREATE OR REPLACE FUNCTION roster_gap_fresh_units() RETURNS SETOF TEXT
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT 'auto:roster_check:2026:' || replace(u.county, '臺', '台')
                  || CASE WHEN u.election_type = '村里長' THEN replace(u.town, '臺', '台') ELSE '' END || ':' || u.election_type
    FROM cec_roster_units u
   WHERE u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days' AND u.row_count > 0
$$;

CREATE OR REPLACE FUNCTION roster_gap_units()
RETURNS TABLE (task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT,
               items JSONB, items_count INTEGER, kinds JSONB, target JSONB, what_we_need TEXT, hint_sources TEXT[])
LANGUAGE sql STABLE SET enable_nestloop = off AS $fn$
  WITH cap AS (SELECT COALESCE((SELECT s.max_items FROM roster_unify_settings s WHERE s.id = 1), 120) AS n),
  fresh AS MATERIALIZED (
    SELECT u.election_type, replace(u.county, '臺', '台') AS county, replace(u.town, '臺', '台') AS town
      FROM cec_roster_units u WHERE u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days'
  ),
  -- 官方有、本站沒有（人物不存在，或不在這個單位）
  ms AS MATERIALIZED (
    SELECT d.election_type, d.county, d.town, d.unit, d.cand_no, d.roster_name AS name, d.roster_party AS party, d.roster_birth AS birth,
           d.roster_url AS url, d.roster_li_code AS li, rr.district,
           CASE WHEN length(COALESCE(d.roster_birth, '')) >= 7 THEN 1911 + NULLIF(substr(d.roster_birth, 1, 3), '')::INTEGER
                WHEN length(COALESCE(d.roster_birth, '')) = 6 THEN 1911 + NULLIF(substr(d.roster_birth, 1, 2), '')::INTEGER END AS birth_year
      FROM cec_roster_diff() d
      LEFT JOIN cec_roster_2026 rr ON rr.id = d.roster_id
     WHERE d.kind = 'missing' AND d.roster_name IS NOT NULL AND btrim(d.roster_name) <> ''
  ),
  -- 官方有號次、本站已有此人（同單位、同姓名鍵）卻沒有 cand_no
  cn AS MATERIALIZED (
    SELECT DISTINCT ON (pe.id) pe.id AS pe_id, pe.politician_id AS pid, p.name, pe.election_type, o.county, o.scope_town AS town,
           r.cand_no, r.party, r.birth, r.unit_url AS url, r.li_code AS li, r.district, rg.village
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
      CROSS JOIN LATERAL (SELECT replace(COALESCE(rg.region, p.region), '臺', '台') AS county,
                                 CASE WHEN pe.election_type = '村里長' THEN COALESCE(replace(rg.sub_region, '臺', '台'), '') ELSE '' END AS scope_town) o
      JOIN fresh f ON f.election_type = pe.election_type AND f.county = o.county AND f.town = o.scope_town
      JOIN cec_roster_2026 r ON r.election_type = pe.election_type AND replace(r.county, '臺', '台') = o.county
                            AND (pe.election_type <> '村里長' OR replace(r.town, '臺', '台') = o.scope_town)
                            AND r.cand_no IS NOT NULL
                            AND COALESCE(r.name_key, roster_name_key(r.name)) = roster_name_key(p.name)
                            AND r.unit_key = CASE WHEN pe.election_type = '村里長' THEN o.county || '|' || o.scope_town
                                                  ELSE cec_roster_norm_unit(ballot_number_unit(pe.election_type, o.county, rg.sub_region, rg.sub_region, rg.village)) END
                            AND (pe.election_type <> '村里長' OR rg.village IS NULL OR r.li_code = right(rg.admin_code, 3))
     WHERE pe.election_id = 2026 AND pe.cand_no IS NULL AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
       AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')
       AND o.county IS NOT NULL
     ORDER BY pe.id, r.cand_no
  ),
  it AS MATERIALIZED (
    SELECT m.election_type, m.county, m.town, 1 AS ord, m.name AS sort_name, m.cand_no AS sort_no,
           jsonb_strip_nulls(jsonb_build_object(
             'kind', '缺人', 'name', m.name,
             'current', jsonb_build_object('region', m.county, 'record', NULL),
             'official', jsonb_build_object('village', v.village, 'district', NULLIF(m.district, ''), 'unit', m.unit, 'cand_no', m.cand_no, 'party', m.party,
                                            'birth_roc', m.birth, 'birth_year', m.birth_year),
             'source_url', m.url)) AS item
      FROM ms m
      LEFT JOIN LATERAL (
        SELECT g.village FROM regions g
         WHERE m.election_type = '村里長' AND m.li ~ '^[0-9]{3}$' AND g.village IS NOT NULL
           AND replace(g.region, '臺', '台') = m.county AND replace(g.sub_region, '臺', '台') = m.town AND right(g.admin_code, 3) = m.li
         ORDER BY g.id LIMIT 1) v ON true
    UNION ALL
    SELECT c.election_type, c.county, c.town, 2, c.name, c.cand_no,
           jsonb_strip_nulls(jsonb_build_object(
             'kind', '缺號次', 'name', c.name, 'politician_id', c.pid, 'politician_election_id', c.pe_id,
             'current', jsonb_build_object('cand_no', NULL),
             'official', jsonb_build_object('village', c.village, 'district', NULLIF(c.district, ''), 'cand_no', c.cand_no, 'party', c.party, 'birth_roc', c.birth),
             'source_url', c.url))
      FROM cn c
  ),
  g AS (
    SELECT i.election_type, i.county, i.town, i.county || i.town AS unit, count(*)::INTEGER AS n,
           jsonb_path_query_array(jsonb_agg(i.item ORDER BY i.ord, i.sort_no NULLS LAST, i.sort_name), ('$[0 to ' || ((SELECT cap.n FROM cap) - 1) || ']')::jsonpath) AS items,
           jsonb_strip_nulls(jsonb_build_object('缺人', NULLIF(count(*) FILTER (WHERE i.ord = 1), 0), '缺號次', NULLIF(count(*) FILTER (WHERE i.ord = 2), 0))) AS kinds
      FROM it i GROUP BY i.election_type, i.county, i.town
  )
  SELECT 'auto:roster_check:2026:' || g.unit || ':' || g.election_type,
         CASE WHEN g.election_type = '村里長' THEN 'roster_villages' ELSE 'raw:roster_check' END,
         2026, g.election_type, g.county, g.town, g.unit, g.items, g.n, g.kinds,
         jsonb_build_object('election_id', 2026, 'region', g.unit, 'county', g.county, 'township', NULLIF(g.town, ''), 'election_type', g.election_type,
                            'findings_only', true, 'voted', false, 'roster_gap', true) || roster_unify_extra(g.items, g.n, g.kinds),
         g.unit || ' 2026 ' || g.election_type || '名單缺口：這個單位有 ' || g.n || ' 位要補（' || roster_unify_kinds_text(g.kinds) || '），逐位列在 target.items。'
           || roster_gap_text(),
         ARRAY['https://info.cec.gov.tw/vote2026/static/json/ ← 中選會選舉專區候選人名單（含號次）', 'https://web.cec.gov.tw/central/article/64709 ← 中選會各級選舉候選人登記彙總表',
               g.county || '選舉委員會官網的登記公告']
    FROM g
$fn$;
COMMENT ON FUNCTION roster_gap_units IS '2026 名單缺口按單位彙總（單位＝roster_check 任務編號）：缺人（cec_roster_diff 的 missing）與缺號次（本站已有此人、官方有號次）逐位列出，一單位一列。只讀官方名冊鏡像與我們的參選紀錄，不寫任何資料。2026-11-03';

-- 單位已經有 roster_check 時：缺口項取代舊的缺人項，其餘種類的差異項留著
CREATE OR REPLACE FUNCTION roster_gap_attach(p_target JSONB, p_items JSONB, p_count INTEGER, p_kinds JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  WITH old AS (
    SELECT COALESCE(jsonb_agg(i), '[]'::JSONB) AS items, count(*)::INTEGER AS n
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_target->'items') = 'array' THEN p_target->'items' ELSE '[]'::JSONB END) i
     WHERE i->>'kind' NOT IN ('缺人', '缺號次')
  ), allx AS (
    SELECT p_items || old.items AS items, p_count + old.n AS n,
           (COALESCE(p_target->'items_kinds', '{}'::JSONB) - '缺人' - '缺號次') || p_kinds AS kinds
      FROM old
  )
  SELECT roster_unify_extra(jsonb_path_query_array(allx.items, '$[0 to 119]'), allx.n, allx.kinds) || jsonb_build_object('roster_gap', true) FROM allx
$$;
-- ▲▲ SECTION: gap ▲▲

-- ------------------------------------------------------------
-- 總表：現行定義（20261102010000）加兩處（tagged_g 一段、keyed0 改讀它），其餘一字不改
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),
       -- 姓名看起來是測試資料的人物（2026-10-08）：他們的任務只走 placeholder_politician（見檔頭）
       ph AS MATERIALIZED (SELECT p.id::TEXT AS pid FROM politicians p WHERE politician_name_is_placeholder(p.name)),
       phe AS MATERIALIZED (SELECT pe.id AS peid FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name)),
       -- >>> 名單清查收斂：名冊類差異按單位彙總（開關關著就不算）；原臂在開關開著時停用，單位清查掛 items（見 20261101020000）
       fnd AS MATERIALIZED (SELECT * FROM roster_unit_findings() WHERE roster_unify_on()),
       -- <<< 名單清查收斂
       tagged0 AS (
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
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
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
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t
  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t
  UNION ALL SELECT 'issue_too_broad' AS arm, t.* FROM contribution_auto_tasks_issue_too_broad() t
       ),
       -- >>> 名單清查收斂：單位已經有 roster_check（raw、roster_villages、roster_cec_gap）就掛 items；沒有、但有差異的單位開一張（findings_only）
       tagged AS (
  SELECT t0.arm, t0.task_id, t0.task_type, t0.target || COALESCE(x.extra, '{}'::JSONB) AS target,
         CASE WHEN x.extra IS NULL THEN t0.what_we_need
              ELSE t0.what_we_need || ' ' || roster_unify_text((x.extra->>'items_count')::INTEGER, COALESCE(f.voted, t0.target->>'list_source' = 'cec', false)) END AS what_we_need,
         t0.hint_sources, t0.reward, t0.region
    FROM tagged0 t0
    LEFT JOIN fnd f ON t0.task_type = 'roster_check' AND f.task_id = t0.task_id
    CROSS JOIN LATERAL (SELECT CASE WHEN t0.task_type = 'roster_check' AND roster_unify_on() THEN roster_unify_attach(t0.target, f.items, f.items_count, f.kinds) END AS extra) x
  UNION ALL
  SELECT f.arm, f.task_id, 'roster_check', f.target, f.what_we_need, f.hint_sources, 2, f.county
    FROM fnd f
   WHERE NOT EXISTS (SELECT 1 FROM tagged0 t0 WHERE t0.task_id = f.task_id)
       ),
       -- <<< 名單清查收斂
       -- >>> 名單缺口只派有缺口的單位（20261103010000，policy-ops#180）：2026 的 roster_check 列，單位有缺口 → 缺口 items 併進 target.items；
       --     單位沒有 roster_check 列但有缺口 → 開一列；官方名冊鏡像新鮮、卻無缺口也無別種差異 → 不派（收回）。開關同 roster_unify_on()
       gapu AS MATERIALIZED (SELECT * FROM roster_gap_units() WHERE roster_unify_on()),
       gapfresh AS MATERIALIZED (SELECT x.tid FROM roster_gap_fresh_units() AS x(tid) WHERE roster_unify_on()),
       tagged_g AS (
  SELECT t.arm, t.task_id, t.task_type,
         CASE WHEN gu.task_id IS NULL THEN t.target ELSE t.target || roster_gap_attach(t.target, gu.items, gu.items_count, gu.kinds) END AS target,
         CASE WHEN gu.task_id IS NULL THEN t.what_we_need ELSE t.what_we_need || ' ' || roster_gap_text() END AS what_we_need,
         t.hint_sources, t.reward, t.region
    FROM tagged t
    LEFT JOIN gapu gu ON t.task_type = 'roster_check' AND gu.task_id = roster_gap_tid(t.task_id)
   WHERE NOT (t.task_type = 'roster_check' AND t.task_id LIKE 'auto:roster_check:2026:%' AND gu.task_id IS NULL
              AND roster_gap_tid(t.task_id) IN (SELECT f.tid FROM gapfresh f)
              AND (COALESCE(t.target->'items_kinds', '{}'::JSONB) - '缺人' - '缺號次') = '{}'::JSONB)
  UNION ALL
  SELECT gu.arm, gu.task_id, 'roster_check', gu.target, gu.what_we_need, gu.hint_sources, 2, gu.county
    FROM gapu gu
   WHERE NOT EXISTS (SELECT 1 FROM tagged t WHERE t.task_type = 'roster_check' AND roster_gap_tid(t.task_id) = gu.task_id)
       ),
       -- <<< 名單缺口
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       -- >>> 村里長進度：target 沒有職位的臂（進度追蹤的 progress_stale、deadline_due），若這支臂有規則要看職位（except_election_types 排除清單或 election_types 正向清單，任何一種），職位從人物在那一屆的參選紀錄補；其餘臂的分組一個字不變
       -- 兩種都要看：只看排除清單的話，排除規則一被停用，職位全是 NULL，「村里長、要流量」那條正向規則就永遠比對不到、缺口被無聲收回（agy 審查 #480）
       needs_etype AS MATERIALIZED (SELECT DISTINCT r.activity FROM activity_rules r WHERE r.enabled AND (r.except_election_types IS NOT NULL OR r.election_types IS NOT NULL)
                                    -- >>> 有人看才追：來源臂一律補職位（要照職位決定歸不歸流量臂）
                                    UNION SELECT s.arm FROM unnest(traffic_watch_source_arms()) AS s(arm)
                                    -- <<< 有人看才追
                                   ),
       -- <<< 村里長進度
       keyed0 AS (
  SELECT g.*, election_id_or_null(g.target->>'election_id') AS eid,
         COALESCE(NULLIF(g.target->>'election_type', ''),
                  CASE WHEN g.arm IN (SELECT n.activity FROM needs_etype n)
                       THEN (SELECT pe.election_type FROM politician_elections pe
                              WHERE pe.politician_id = uuid_or_null(g.target->>'politician_id') AND pe.election_id = election_id_or_null(g.target->>'election_id')
                              ORDER BY pe.id LIMIT 1) END) AS etype
    FROM tagged_g g
       ),
       -- >>> 有人看才追：來源臂裡、職位在 traffic_watch_levels 開著的列，改歸流量臂 traffic:<型別>（task_id、內容一個字不變，只換臂名）；其餘照舊
       traffic_levels AS MATERIALIZED (SELECT l.election_type FROM traffic_watch_levels l WHERE l.enabled),
       keyed AS (
  SELECT CASE WHEN k.arm = ANY (traffic_watch_source_arms()) AND k.etype IN (SELECT t.election_type FROM traffic_levels t)
              THEN traffic_watch_arm(k.arm) ELSE k.arm END AS arm,
         k.task_id, k.task_type, k.target, k.what_we_need, k.hint_sources, k.reward, k.region, k.eid, k.etype
    FROM keyed0 k
       ),
       -- <<< 有人看才追
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
         CASE WHEN w.ok THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until,
           'traffic_gate', CASE WHEN g.arm LIKE 'traffic:%' THEN true END)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
    -- >>> 流量開窗：窗口有開（o.source），而且是流量臂（traffic:）時，這一列的人物頁或政見頁要在 page_traffic_hot；沒開的列照舊（旗標 gap.arms_all 開著時留下，opened_by 是 NULL）
    CROSS JOIN LATERAL (SELECT o.source IS NOT NULL AND (g.arm NOT LIKE 'traffic:%' OR EXISTS (
           SELECT 1 FROM page_traffic_hot h
            WHERE (h.kind = 'politician' AND h.target_id = g.target->>'politician_id') OR (h.kind = 'policy' AND h.target_id = g.target->>'policy_id'))) AS ok) w
    -- <<< 流量開窗
   WHERE (w.ok OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
     AND (g.arm = 'placeholder_politicians'
      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)
              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT)))
$$;

-- ------------------------------------------------------------
-- 取代 #840 單人任務
-- ------------------------------------------------------------
DO $do$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.unschedule(bigint)') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'cec-missing-person-tasks-daily';
  END IF;
END
$do$;
DROP FUNCTION IF EXISTS cec_missing_person_tasks_create(TEXT);
-- 已開的單人任務收掉（缺的人改列在單位的 roster_check items）；只關任務，不動參選資料
UPDATE contribution_tasks
   SET status = 'closed', closed_at = now()
 WHERE task_type = 'candidacy_source_missing' AND target->>'kind' = 'roster_missing' AND status = 'open';

-- 自我檢查：總表接上了缺口段
DO $$
BEGIN
  IF strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'roster_gap_units()') = 0 THEN
    RAISE EXCEPTION '總表沒有接上 roster_gap_units';
  END IF;
  IF strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'issue_too_broad') = 0 THEN
    RAISE EXCEPTION '總表漏了 issue_too_broad（抄底錯版）';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
