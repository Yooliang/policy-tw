-- ============================================================
-- 派工總表後半段抽成可吃「臂集合＋鍵集合」的函式（2026-11-28）：純重構，輸出與前一版逐列相同
-- 設計：docs/dispatch-arms-event-driven-plan.md「第 3 期（2026-11-28 改版）」3-D（改為地基）
--
-- 為什麼：
--   3-F（seed 瘦身成時間型掃描）要讓 drain 與 seed 只重算「這一批臂、這一批鍵」，但總表 contribution_auto_tasks_arms()
--   是一整句 SQL：臂輸出之後還串著窗口開關（opened）、名單族改寫（fnd／gapu／fresh_units／unify_attach）、測試名人物過濾（ph／phe）、
--   流量閘與 traffic: 改名。這些整表狀態不是鍵事件，沒有把它們也變成「可指定範圍」的函式，drain 套用只會漏。
--   原本設計的 3-D（drain 直接套用 live 臂到 task_dispatches）因此做不到逐列一致，改成先做這個地基。
--
-- 做了什麼：
--   1. 新函式 contribution_auto_tasks_arms_tail(p_arms TEXT[] DEFAULT NULL, p_keys TEXT[] DEFAULT NULL)：本體＝前一版總表
--      （20261126180000 的 contribution_auto_tasks_arms）整句搬進來，只多：
--        · 每支臂的分支多一個 AND contribution_arm_selected(p_arms, '臂名')：沒被選到的臂整支分支被一次性條件剪掉；
--          raw 與 deadline_due 的 CTE 與函式本身仍整支算（它們被別處引用），raw 的列不剪。
--        · keyed 多帶 src_arm（改名成 traffic: 之前的來源臂名），最後的 WHERE 多一個臂篩選與一個鍵篩選。
--      p_arms 與 p_keys 都是 NULL＝全量（等於前一版總表）。
--   2. 新函式 contribution_arm_selected(p_arms, p_arm)：沒給臂集合就都選；選到臂名本身或它改名後的 traffic: 名；
--      roster_villages、roster_cec_gap、raw:roster_check 一律選（它們的列是 roster_check，名單族彙總會拿它們比對
--      「這個單位已經有清查」，剪掉會讓 findings_only 的列誤出現）。
--   3. 總表 contribution_auto_tasks_arms() 改成 SELECT * FROM contribution_auto_tasks_arms_tail(NULL, NULL)，簽名與欄位不變。
--      前一版整支仍保留在 contribution_auto_tasks_arms_v20261126()（雙軌比對與回滾用）。
--
-- 子集語意（p_arms、p_keys 都給時取交集）：
--   p_arms：輸出列的臂名（含 traffic: 改名後）或來源臂名在集合內。
--   p_keys：'*' 或空＝不限；否則 dispatch_gap_scope_key(來源臂名, task_id) 在集合內。
--   子集輸出＝全量輸出用同樣條件過濾後的結果（守門 B），所以之後 drain 可以只對一批臂與鍵取輸出再套用。
--
-- 這支沒有接任何呼叫者：drain、seed 本體、觸發器、排程都沒動。函式層級 SET 兩支都帶（work_mem、hash_mem_multiplier；
--   CREATE OR REPLACE 會洗掉 20261128010000 用 ALTER 設的 hash_mem_multiplier，所以重新寫進定義）。
--
-- 每日呼叫量變化：0（沒有新排程、觸發器或對外呼叫）
--
-- 回滾：重貼 20261126180000 的 contribution_auto_tasks_arms() 定義（二段式那一版；不是 contribution_auto_tasks_arms_v20261126()，
--   那是二段式之前的版本），帶 SET work_mem = '16MB' 與 SET hash_mem_multiplier = '1'，再 DROP 兩支新函式。
-- ============================================================

CREATE OR REPLACE FUNCTION contribution_arm_selected(p_arms TEXT[], p_arm TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT p_arms IS NULL
      OR p_arm = ANY (p_arms)
      OR traffic_watch_arm(p_arm) = ANY (p_arms)
      OR p_arm IN ('roster_villages', 'roster_cec_gap', 'raw:roster_check')  -- 這三支的列是 roster_check，名單族彙總要拿它們比對，不能剪
$$;
REVOKE ALL ON FUNCTION contribution_arm_selected(TEXT[], TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms_tail(p_arms TEXT[] DEFAULT NULL, p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE SET work_mem = '16MB' SET hash_mem_multiplier = '1' AS $$
  WITH -- >>> 缺口二段式（20261126180000）：模式是 live 的臂名（全 off 時是空集合）；這些臂改讀 dispatch_gaps 開著的列，其餘照舊即時算
       live_arms AS MATERIALIZED (SELECT a.arm FROM dispatch_gap_arms a WHERE a.mode = 'live'),
       -- <<< 缺口二段式
       raw AS (SELECT r0.* FROM contribution_auto_tasks_raw() r0
                WHERE ('raw:' || r0.task_type) NOT IN (SELECT l.arm FROM live_arms l)  -- 缺口二段式：raw 各任務型別各自的模式
               UNION ALL
               SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region FROM dispatch_gap_rows_all() g
                WHERE g.arm LIKE 'raw:%' AND g.arm IN (SELECT l.arm FROM live_arms l)),
       due AS (SELECT d0.* FROM contribution_auto_tasks_deadline_due() d0
                WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'deadline_due')  -- 缺口二段式
               UNION ALL
               SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region FROM dispatch_gap_rows_all() g
                WHERE g.arm = 'deadline_due' AND EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'deadline_due')),
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
  UNION ALL SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'dup') AND contribution_arm_selected(p_arms, 'dup')
  UNION ALL SELECT 'legacy' AS arm, t.* FROM contribution_auto_tasks_legacy() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'legacy') AND contribution_arm_selected(p_arms, 'legacy')
  UNION ALL SELECT 'mismatch' AS arm, t.* FROM contribution_auto_tasks_mismatch() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'mismatch') AND contribution_arm_selected(p_arms, 'mismatch')
  UNION ALL SELECT 'policy_dup' AS arm, t.* FROM contribution_auto_tasks_policy_dup() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'policy_dup') AND contribution_arm_selected(p_arms, 'policy_dup')
  UNION ALL SELECT 'not_running' AS arm, t.* FROM contribution_auto_tasks_not_running() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'not_running') AND contribution_arm_selected(p_arms, 'not_running')
  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'mayor_policies') AND contribution_arm_selected(p_arms, 'mayor_policies')
  UNION ALL SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_term_policies() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'term_policies') AND contribution_arm_selected(p_arms, 'term_policies')
  UNION ALL SELECT 'roster_villages' AS arm, t.* FROM contribution_auto_tasks_roster_villages() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_villages') AND contribution_arm_selected(p_arms, 'roster_villages')
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'township_gap') AND contribution_arm_selected(p_arms, 'township_gap')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'region_gap') AND contribution_arm_selected(p_arms, 'region_gap')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'elected_missing') AND contribution_arm_selected(p_arms, 'elected_missing')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'roster_cec_gap' AS arm, t.* FROM contribution_auto_tasks_roster_cec_gap() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_cec_gap') AND contribution_arm_selected(p_arms, 'roster_cec_gap')
  UNION ALL SELECT 'district_seats' AS arm, t.* FROM contribution_auto_tasks_district_seats() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'district_seats') AND contribution_arm_selected(p_arms, 'district_seats')
  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM contribution_auto_tasks_policy_elements() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'policy_elements') AND contribution_arm_selected(p_arms, 'policy_elements')
  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM due t WHERE contribution_arm_selected(p_arms, 'deadline_due')
  UNION ALL SELECT 'lineage_candidates' AS arm, t.* FROM contribution_auto_tasks_lineage_candidates() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_candidates') AND contribution_arm_selected(p_arms, 'lineage_candidates')
  UNION ALL SELECT 'handover_missing' AS arm, t.* FROM contribution_auto_tasks_handover_missing() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'handover_missing') AND contribution_arm_selected(p_arms, 'handover_missing')
  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM contribution_auto_tasks_lineage_roles() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_roles') AND contribution_arm_selected(p_arms, 'lineage_roles')
  UNION ALL SELECT 'lineage_links' AS arm, t.* FROM contribution_auto_tasks_lineage_links() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_links') AND contribution_arm_selected(p_arms, 'lineage_links')
  UNION ALL SELECT 'career_sources' AS arm, t.* FROM contribution_auto_tasks_career_sources() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'career_sources') AND contribution_arm_selected(p_arms, 'career_sources')
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM contribution_auto_tasks_withdrawn_filing() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'withdrawn_filing') AND contribution_arm_selected(p_arms, 'withdrawn_filing')
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'party_gap') AND contribution_arm_selected(p_arms, 'party_gap')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'party_roster') AND contribution_arm_selected(p_arms, 'party_roster')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'party_info') AND contribution_arm_selected(p_arms, 'party_info')
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'placeholder_politicians') AND contribution_arm_selected(p_arms, 'placeholder_politicians')
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'election_results') AND contribution_arm_selected(p_arms, 'election_results')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'owner_mismatch') AND contribution_arm_selected(p_arms, 'owner_mismatch')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'ballot_numbers') AND contribution_arm_selected(p_arms, 'ballot_numbers')
  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'manual_visitor') AND contribution_arm_selected(p_arms, 'manual_visitor')
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'manual_open') AND contribution_arm_selected(p_arms, 'manual_open')
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'regional_stats_missing') AND contribution_arm_selected(p_arms, 'regional_stats_missing')
  UNION ALL SELECT 'issue_too_broad' AS arm, t.* FROM contribution_auto_tasks_issue_too_broad() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'issue_too_broad') AND contribution_arm_selected(p_arms, 'issue_too_broad')
  UNION ALL SELECT 'lineage_status' AS arm, t.* FROM contribution_auto_tasks_lineage_status() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_status') AND contribution_arm_selected(p_arms, 'lineage_status')
  UNION ALL SELECT 'lineage_stances' AS arm, t.* FROM contribution_auto_tasks_lineage_stances() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_stances') AND contribution_arm_selected(p_arms, 'lineage_stances')
  UNION ALL SELECT 'lineage_events' AS arm, t.* FROM contribution_auto_tasks_lineage_events() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_events') AND contribution_arm_selected(p_arms, 'lineage_events')
  -- >>> 缺口二段式：模式是 live 的臂（raw 與 deadline_due 已在各自的 CTE 處理）改讀常駐表開著的列；名單清查收斂開關開著時，原本被閘掉的七支臂維持被閘掉
  UNION ALL SELECT g.arm, g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region
    FROM dispatch_gap_rows_all() g
   WHERE g.arm IN (SELECT l.arm FROM live_arms l)
     AND g.arm NOT LIKE 'raw:%' AND g.arm <> 'deadline_due' AND contribution_arm_selected(p_arms, g.arm)
     AND (g.arm NOT IN ('township_gap', 'region_gap', 'elected_missing', 'party_gap', 'party_roster', 'election_results', 'owner_mismatch') OR NOT roster_unify_on())
  -- <<< 缺口二段式
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
         k.task_id, k.task_type, k.target, k.what_we_need, k.hint_sources, k.reward, k.region, k.eid, k.etype,
         k.arm AS src_arm  -- 臂與鍵篩選：改名成 traffic: 之前的來源臂名（20261128040000）
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
     -- >>> 臂與鍵篩選（20261128040000）：p_arms／p_keys 都是 NULL＝全量；給了就只回這批臂（輸出臂名或來源臂名在 p_arms 內）、這批鍵（'*' 不限）的列
     AND (p_arms IS NULL OR g.arm = ANY (p_arms) OR g.src_arm = ANY (p_arms))
     AND (p_keys IS NULL OR '*' = ANY (p_keys) OR dispatch_gap_scope_key(g.src_arm, g.task_id) = ANY (p_keys))
     -- <<< 臂與鍵篩選
$$;
REVOKE ALL ON FUNCTION contribution_auto_tasks_arms_tail FROM PUBLIC, anon, authenticated;  -- 函式名唯一，可省略參數；寫成不帶括號是因為有守門測試用「FUNCTION 名稱(」找最後一次定義
COMMENT ON FUNCTION contribution_auto_tasks_arms_tail IS '派工總表本體（20261128040000 從 contribution_auto_tasks_arms 抽出）。p_arms／p_keys 都是 NULL＝全量，與 contribution_auto_tasks_arms() 逐列相同；給了就只回這批臂與鍵的列（子集＝全量用同樣條件過濾）。臂集合對 roster_villages、roster_cec_gap、raw:roster_check 一律不剪。';

-- 總表：簽名與欄位不變，本體改成呼叫上面那支（全量）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE SET work_mem = '16MB' SET hash_mem_multiplier = '1' AS $$
  SELECT * FROM contribution_auto_tasks_arms_tail(NULL::TEXT[], NULL::TEXT[])
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS '派工總表。20261128040000：本體抽成 contribution_auto_tasks_arms_tail(p_arms, p_keys)，這裡只呼叫它（NULL, NULL＝全量，輸出與 20261126180000 版逐列相同）；二段式、名單清查收斂、名單缺口、開窗等說明見該函式與 20261126180000。前一版保留在 contribution_auto_tasks_arms_v20261126()。';

DO $$
DECLARE r RECORD; v_fn TEXT; v_bad TEXT := '';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.contribution_auto_tasks_arms()', 'public.contribution_auto_tasks_arms_tail(text[],text[])'] LOOP
    SELECT p.proconfig INTO r FROM pg_proc p WHERE p.oid = v_fn::regprocedure;
    IF NOT ('hash_mem_multiplier=1' = ANY (COALESCE(r.proconfig, ARRAY[]::TEXT[]))) THEN v_bad := v_bad || ' ' || v_fn || ':hash_mem_multiplier'; END IF;
    IF NOT ('work_mem=16MB' = ANY (COALESCE(r.proconfig, ARRAY[]::TEXT[]))) THEN v_bad := v_bad || ' ' || v_fn || ':work_mem'; END IF;
  END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION '總表函式層級 SET 沒帶全：%', v_bad; END IF;
END $$;
