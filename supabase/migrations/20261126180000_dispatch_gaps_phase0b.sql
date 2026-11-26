-- 派工臂事件驅動化 第 0 期 PR-2：臂模式表、總表二段式（預設 off 等價）、seed 開頭 drain 開關、雙軌／對帳／保留 cron、各臂暫存量測、觸發器覆蓋補齊
--
-- 設計文件：docs/dispatch-arms-event-driven-plan.md 第 2.5～2.8 節、第 5 節第 0 期、附錄 A。接 PR-1（20261126170000，常駐缺口地基）。
--
-- 預設狀態下派工行為一個字不變：
--   · 每一支臂的模式都是 off：總表每支臂照舊「即時算」（臂函式整支跑一次），dispatch_gaps 開著的列不被讀。
--   · seed 開頭的 drain 受 dispatch_gap_settings.seed_drain_enabled 控制，預設 false；關著時 seed 與前一版逐行相同（只多一次讀設定的查詢）。
--   · 觸發器函式 dispatch_gap_on_change() 只補函式分支，仍沒有掛到任何正式表。
--   · 新增的 cron 全部只讀正式資料、只寫缺口相關的小表（雙軌比對只處理模式不是 off 的臂；全 off 時等於空轉）。
--
-- 模式怎麼切（臂登記在 dispatch_gap_arm_keys 才能切成 shadow／live）：
--   SELECT dispatch_gap_set_mode('legacy', 'shadow', '備註');   -- shadow：照舊即時算，同時雙軌比對與每日對帳會維持常駐表
--   SELECT dispatch_gap_set_mode('legacy', 'live',   '備註');   -- live：總表這支臂改讀 dispatch_gaps 開著的列
--   SELECT dispatch_gap_set_mode('legacy', 'off',    '回滾');   -- 立刻退回即時算（常駐表留著）
--   總開關（seed 開頭是否 drain）：UPDATE dispatch_gap_settings SET seed_drain_enabled = true WHERE id = 1;
--   事件緊急開關（PR-1）：UPDATE dispatch_gap_settings SET events_enabled = false WHERE id = 1;
--
-- 總表二段式的做法：
--   前一版（20261120170000 的定義）整支原封不動保留成 contribution_auto_tasks_arms_v20261126()，供雙軌比對與回滾。
--   新的 contribution_auto_tasks_arms() 只多兩處：
--     ① 開頭多一個 CTE live_arms（模式是 live 的臂名，全 off 時是空集合）。
--     ② 每支臂的分支多一個「沒有被切成 live」的條件（uncorrelated EXISTS，planner 當一次性條件），
--        並多一個共用的 live 分支：從 dispatch_gaps 開著的列取（dispatch_gap_rows_all()），名單清查收斂開關關著才出的七支臂維持原本的閘。
--        raw 與 deadline_due 因為是 CTE（還被別處引用），在 CTE 本身做同樣的二選一。
--   其餘（名單清查收斂、名單缺口、職位補齊、開窗、流量開窗）一個字不動。
--   traffic:* 不是獨立的臂（由來源臂的列在列層換臂名），不登記模式；它們跟著來源臂走。
--
-- 暫存量測（第 0 期要量「總表後半 CTE 鏈＋seed 本體約 290MB 暫存」來源）：
--   實測（正式庫 PG 17.6，唯讀探測）：同一個交易內 pg_stat_database.temp_bytes 不會即時更新（前後值相同，連 pg_stat_force_next_flush 也一樣，
--   統計要等交易結束才送出）；pg_stat_statements 又只追蹤頂層語句（track=top），seed 函式內的語句看不到。所以「seed 本體各段前後差」做不出來。
--   改成：新增程序 seed_arm_temp_probe()，每支臂與整張總表各自一個交易（每段之間 COMMIT），用交易前後的 temp_bytes 差，寫進 seed_arm_timings.temp_bytes
--   （arm 欄是 temp:<臂名>，整張總表是 temp:arms_all）。「總表後半 CTE 鏈」的暫存 ≈ temp:arms_all 減各臂 temp 加總；seed 本體的其餘暫存要另案量。
--   該數字含同一時段其他連線造成的暫存（資料庫層級統計），所以排在清晨低流量時段每天一次，看大小量級，不要當精確值。
--
-- 回滾（互不依賴，可只做一部分）：
--   SELECT cron.unschedule('dispatch-gap-shadow-compare-hourly'); SELECT cron.unschedule('dispatch-gap-reconcile-daily');
--   SELECT cron.unschedule('dispatch-gap-retention-daily'); SELECT cron.unschedule('seed-arm-temp-probe-daily');
--   把總表換回舊版：CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms() 的本體換成 contribution_auto_tasks_arms_v20261126() 的本體（SET work_mem 要帶）；
--   seed_auto_task_queue() 換回 20261126150000 的定義（SET statement_timeout、SET work_mem 要一起帶）；
--   dispatch_gap_reconcile_all／dispatch_gap_on_change 換回 20261126170000 的定義；
--   然後 DROP 新物件：函式 dispatch_gap_rows_all()、gap_arm_mode(TEXT)、dispatch_gap_set_mode(TEXT,TEXT,TEXT)、dispatch_gap_seed_drain_enabled()、
--   dispatch_gap_shadow_run()、dispatch_gap_retention()、dispatch_gap_enqueue_reg(TEXT,TEXT,TEXT)、contribution_auto_tasks_arms_v20261126()，
--   程序 seed_arm_temp_probe()；表 dispatch_gap_arms；欄位 dispatch_gap_settings.seed_drain_enabled、seed_arm_timings.temp_bytes。

-- ------------------------------------------------------------
-- 1. 臂模式表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch_gap_arms (
  arm        TEXT PRIMARY KEY,
  mode       TEXT        NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'shadow', 'live')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note       TEXT
);
ALTER TABLE dispatch_gap_arms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_gap_arms FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE dispatch_gap_arms IS '派工臂的缺口模式（20261126180000）。off＝總表即時算（現行）；shadow＝仍即時算、同時維持常駐表並雙軌比對；live＝總表讀 dispatch_gaps。查不到＝off。切換用 dispatch_gap_set_mode()。';

-- 總表所有臂（含 raw 的 8 個任務型別、名單清查收斂開關下停用的七支）都先登記成 off；traffic:* 不是獨立的臂，不登記
INSERT INTO dispatch_gap_arms (arm, mode, note)
SELECT a, 'off', '第 0 期初始登記'
  FROM unnest(activity_arm_names()) AS a
 WHERE a NOT LIKE 'traffic:%'
ON CONFLICT (arm) DO NOTHING;

CREATE OR REPLACE FUNCTION gap_arm_mode(p_arm TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT a.mode FROM dispatch_gap_arms a WHERE a.arm = p_arm), 'off')
$$;

-- 切換模式（只有 service_role／postgres 能呼叫）。shadow 與 live 要求臂已登記在 dispatch_gap_arm_keys（否則 drain 與對帳算不了）
CREATE OR REPLACE FUNCTION dispatch_gap_set_mode(p_arm TEXT, p_mode TEXT, p_note TEXT DEFAULT NULL) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  IF p_mode NOT IN ('off', 'shadow', 'live') THEN
    RAISE EXCEPTION 'dispatch_gap_set_mode：模式只能是 off／shadow／live，收到 %', p_mode;
  END IF;
  IF p_mode <> 'off' AND NOT EXISTS (SELECT 1 FROM dispatch_gap_arm_keys k WHERE k.arm = p_arm) THEN
    RAISE EXCEPTION 'dispatch_gap_set_mode：臂 % 還沒登記在 dispatch_gap_arm_keys，不能切成 %', p_arm, p_mode;
  END IF;
  INSERT INTO dispatch_gap_arms (arm, mode, updated_at, note) VALUES (p_arm, p_mode, now(), p_note)
  ON CONFLICT (arm) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now(), note = COALESCE(EXCLUDED.note, dispatch_gap_arms.note);
  RETURN p_mode;
END;
$$;

REVOKE ALL ON FUNCTION gap_arm_mode(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_set_mode(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. 總開關：seed 開頭是否 drain
-- ------------------------------------------------------------
ALTER TABLE dispatch_gap_settings ADD COLUMN IF NOT EXISTS seed_drain_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION dispatch_gap_seed_drain_enabled() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT s.seed_drain_enabled FROM dispatch_gap_settings s WHERE s.id = 1), false)
$$;
REVOKE ALL ON FUNCTION dispatch_gap_seed_drain_enabled() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. 常駐表開著的列，還原成臂函式輸出的形狀（總表的 live 分支用）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_rows_all()
RETURNS TABLE (arm TEXT, task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT g.arm, g.gap_key, g.payload ->> 'task_type', g.payload -> 'target', g.payload ->> 'what_we_need',
         CASE WHEN jsonb_typeof(g.payload -> 'hint_sources') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(g.payload -> 'hint_sources')) END,
         (g.payload ->> 'reward')::INTEGER, g.payload ->> 'region'
    FROM dispatch_gaps g
   WHERE g.closed_at IS NULL
$$;
REVOKE ALL ON FUNCTION dispatch_gap_rows_all() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. 總表：前一版整支保留（雙軌比對與回滾用），新版二段式
--    前一版＝20261120170000_lineage_arms_start_date.sql 的 contribution_auto_tasks_arms()，只改函式名，本體逐字相同
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms_v20261126()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE SET work_mem = '16MB' AS $$
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
  UNION ALL SELECT 'lineage_status' AS arm, t.* FROM contribution_auto_tasks_lineage_status() t
  UNION ALL SELECT 'lineage_stances' AS arm, t.* FROM contribution_auto_tasks_lineage_stances() t
  UNION ALL SELECT 'lineage_events' AS arm, t.* FROM contribution_auto_tasks_lineage_events() t
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
COMMENT ON FUNCTION contribution_auto_tasks_arms_v20261126 IS '派工總表的前一版（20261120170000 的定義，逐字保留；20261126180000 起總表改二段式）。雙軌比對（全 off 時兩版輸出必須逐列相同）與回滾用，沒有任何排程或程式呼叫它。';
REVOKE ALL ON FUNCTION contribution_auto_tasks_arms_v20261126() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE SET work_mem = '16MB' AS $$
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
  UNION ALL SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'dup')
  UNION ALL SELECT 'legacy' AS arm, t.* FROM contribution_auto_tasks_legacy() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'legacy')
  UNION ALL SELECT 'mismatch' AS arm, t.* FROM contribution_auto_tasks_mismatch() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'mismatch')
  UNION ALL SELECT 'policy_dup' AS arm, t.* FROM contribution_auto_tasks_policy_dup() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'policy_dup')
  UNION ALL SELECT 'not_running' AS arm, t.* FROM contribution_auto_tasks_not_running() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'not_running')
  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'mayor_policies')
  UNION ALL SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_term_policies() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'term_policies')
  UNION ALL SELECT 'roster_villages' AS arm, t.* FROM contribution_auto_tasks_roster_villages() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_villages')
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'township_gap')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'region_gap')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'elected_missing')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'roster_cec_gap' AS arm, t.* FROM contribution_auto_tasks_roster_cec_gap() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_cec_gap')
  UNION ALL SELECT 'district_seats' AS arm, t.* FROM contribution_auto_tasks_district_seats() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'district_seats')
  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM contribution_auto_tasks_policy_elements() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'policy_elements')
  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM due t
  UNION ALL SELECT 'lineage_candidates' AS arm, t.* FROM contribution_auto_tasks_lineage_candidates() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_candidates')
  UNION ALL SELECT 'handover_missing' AS arm, t.* FROM contribution_auto_tasks_handover_missing() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'handover_missing')
  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM contribution_auto_tasks_lineage_roles() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_roles')
  UNION ALL SELECT 'lineage_links' AS arm, t.* FROM contribution_auto_tasks_lineage_links() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_links')
  UNION ALL SELECT 'career_sources' AS arm, t.* FROM contribution_auto_tasks_career_sources() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'career_sources')
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM contribution_auto_tasks_withdrawn_filing() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'withdrawn_filing')
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'party_gap')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'party_roster')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'party_info')
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'placeholder_politicians')
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'election_results')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'owner_mismatch')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'ballot_numbers')
  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'manual_visitor')
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'manual_open')
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'regional_stats_missing')
  UNION ALL SELECT 'issue_too_broad' AS arm, t.* FROM contribution_auto_tasks_issue_too_broad() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'issue_too_broad')
  UNION ALL SELECT 'lineage_status' AS arm, t.* FROM contribution_auto_tasks_lineage_status() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_status')
  UNION ALL SELECT 'lineage_stances' AS arm, t.* FROM contribution_auto_tasks_lineage_stances() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_stances')
  UNION ALL SELECT 'lineage_events' AS arm, t.* FROM contribution_auto_tasks_lineage_events() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_events')
  -- >>> 缺口二段式：模式是 live 的臂（raw 與 deadline_due 已在各自的 CTE 處理）改讀常駐表開著的列；名單清查收斂開關開著時，原本被閘掉的七支臂維持被閘掉
  UNION ALL SELECT g.arm, g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region
    FROM dispatch_gap_rows_all() g
   WHERE g.arm IN (SELECT l.arm FROM live_arms l)
     AND g.arm NOT LIKE 'raw:%' AND g.arm <> 'deadline_due'
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
COMMENT ON FUNCTION contribution_auto_tasks_arms IS '派工總表。20261126180000：二段式——臂模式（dispatch_gap_arms）是 live 的臂改讀 dispatch_gaps 開著的列，其餘（預設全部）照舊即時算；前一版保留在 contribution_auto_tasks_arms_v20261126()。20261101020000：名冊類差異併進 roster_check（原臂在 roster_unify_settings.enabled 為真時停用；單位清查掛 target.items）';

-- ------------------------------------------------------------
-- 5. seed 本體：以 20261126150000 的現行定義為底，只在開頭多一個標記區塊（缺口表 drain，總開關預設關）
--    CREATE OR REPLACE 會洗掉函式層級的 SET，所以兩個 SET 一起寫進定義
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql
SET statement_timeout = '280s'
SET work_mem = '16MB'
AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
  v_run TIMESTAMPTZ := clock_timestamp(); v_t TIMESTAMPTZ := clock_timestamp(); v_n INTEGER;  -- 各段計時（20261126150000）
BEGIN
  -- >>> 缺口表 drain（20261126180000）：總開關 dispatch_gap_settings.seed_drain_enabled 預設 false；關著時這一段什麼都不做。drain 失敗只丟 WARNING，不讓 seed 掛掉
  IF dispatch_gap_seed_drain_enabled() THEN
    BEGIN
      PERFORM dispatch_gap_drain();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'dispatch_gap_drain：%', SQLERRM;
    END;
    PERFORM seed_arm_timing_log(v_run, 'stage:gap_drain', v_t, NULL); v_t := clock_timestamp();
  END IF;
  -- <<< 缺口表 drain
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  -- >>> 暫存表瘦身：_gaps_all 保留總表完整輸出並加列號 rn（只讀、不改）；寬欄（what_we_need、hint_sources、task_type、reward、region）只留在這裡，後面要寫進 task_dispatches 時才用 rn 回來取
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT row_number() OVER ()::INTEGER AS rn, a.* FROM contribution_auto_tasks_arms() a;
  GET DIAGNOSTICS v_n = ROW_COUNT;  -- 各段計時（20261126150000）
  PERFORM seed_arm_timing_log(v_run, 'stage:arms_all', v_t, v_n); v_t := clock_timestamp();  -- 各段計時（20261126150000）
  CREATE UNIQUE INDEX ON _gaps_all (rn);
  -- <<< 暫存表瘦身
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  -- >>> 暫存表瘦身：_gaps 只帶後面會讀、會改的欄（task_id、arm、target、opened_by），加 src_rn 指回 _gaps_all 取寬欄。下面五次 UPDATE 每次都整列重寫，列越窄落碟越少
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.task_id, g.rn AS src_rn, g.arm, g.target, g.opened_by, g.task_type FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id, g.rn;
  GET DIAGNOSTICS v_n = ROW_COUNT;  -- 各段計時（20261126150000）
  PERFORM seed_arm_timing_log(v_run, 'stage:gaps', v_t, v_n); v_t := clock_timestamp();  -- 各段計時（20261126150000）
  -- <<< 暫存表瘦身

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小；20261011350000 起相符的規則 id 也從這裡記，不再另算層）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER, ADD COLUMN priority_rule_id BIGINT;
  -- >>> 帶狀優先（20261121）：不再呼叫 activity_priority_seconds（規則秒數不再被讀，下面的優先秒數整個重新算）；priority_rule_id 維持 NULL，opened_by 不再記 priority_rule_id
  -- <<< 帶狀優先
  -- <<< 優先秒數

  -- >>> 流量提層：人物頁、政見頁近 window_days 天有真實流量（page_traffic_hot）的，名下缺口標 opened_by.traffic_boost（下一段給秒數）；page_traffic 與狀態都是空的就什麼都不做（參數與規則見 traffic_boost_settings、traffic_boost_apply）
  PERFORM traffic_boost_apply();
  PERFORM seed_arm_timing_log(v_run, 'stage:traffic_boost', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）
  -- <<< 流量提層
  -- >>> 帶狀優先（20261121）：優先秒數從這裡重新算——先清掉規則秒數（activity_rules 的優先秒數不再疊加），再給流量提層的比例制秒數：
  --     近 window_days 天不重複訪客數（opened_by.traffic_users，traffic_boost_apply 標的）× traffic_boost_settings.per_user_seconds；無門檻、無上限；沒有流量旗標＝0
  UPDATE _gaps g SET priority_seconds = CASE WHEN s.enabled AND g.opened_by->>'traffic_boost' = 'true'
                                             THEN COALESCE(NULLIF(g.opened_by->>'traffic_users', '')::BIGINT, 0) * s.per_user_seconds ELSE 0 END
    FROM traffic_boost_settings s WHERE s.id = 1;
  -- <<< 帶狀優先
  -- >>> 需求疊加（20261112070100）：同一張工作卡被不同人要過就加優先秒數（work_card_demand_seconds：單位數×2 天、上限 14 天、派出沒產出減半、冷卻中／結案為 0）。
  --     快照不論旗標都寫（乾跑視圖用）；demand_enabled 預設 false，關著時 priority_seconds 與前一版逐列相同。疊在流量提層（取最大）之後、選舉年（相加）之前
  BEGIN
    PERFORM work_card_demand_refresh();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'work_card_demand_refresh：%', SQLERRM;  -- 快照失敗不能讓整個 seed 掛掉（旗標關著時更不行）
  END;
  IF COALESCE((SELECT q.demand_enabled FROM queue_settings q WHERE q.id = 1), false) THEN
    UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0) + c.demand_seconds::INTEGER
      FROM task_dispatches t
      JOIN work_cards c ON c.work_key = t.work_key AND c.demand_seconds > 0
     WHERE t.task_id = g.task_id;
  END IF;
  -- <<< 需求疊加
  -- >>> 帶狀優先（20261121）：優先秒數再加「屆基準 ＋ 層級 ＋ 種類」（task_year_priority_seconds、task_band_seconds）。
  --     屆基準：插隊中的缺口（既有列 boost_seconds > 0；新缺口是手動臂且 manual_front_seconds > 0）用最新一屆（latest_election_base_seconds），其餘用 target 自己那一屆（沒有選舉 id 當 2026）；
  --     層級與種類見 task_level_days／task_kind_days（lineage_* 用 target.level、有選舉類別的用職位、都沒有的查這個人的參選紀錄、「其他」組無層級）。
  --     疊在流量提層與需求疊加之後，所以排序鍵、冷卻判斷、驗證票沿用母任務的位置都自動吃到
  UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0)
         + task_year_priority_seconds(g.target, COALESCE((SELECT d.boost_seconds > 0 FROM task_dispatches d WHERE d.task_id = g.task_id),
                                                         g.arm LIKE 'manual\_%' AND COALESCE(manual_front_seconds(g.task_id), 0) > 0))
         + task_band_seconds(g.task_type, g.target);
  PERFORM seed_arm_timing_log(v_run, 'stage:priority', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）
  -- <<< 帶狀優先

  -- >>> 換號沿用排隊位置（20261019040000）：帶清單指紋的臂（task_rekey_arms）的 task_id 末段是那一格內容的指紋，格子裡任何一條政見一動指紋就變：
  --     舊列被收回、新列用新 task_id 出生，進隊時間重算＝排回隊尾（正式庫 10-19：佇列延遲約 14 天、這幾臂的列壽命中位數 12～21 小時，幾乎永遠輪不到）。
  --     收回之前先記下「穩定鍵」（task_id 去掉末段指紋）相同、這一輪就要被取代的舊列的排隊位置，下面新增時沿用；沒有舊列的新缺口照舊
  DROP TABLE IF EXISTS _rekey_prev;
  CREATE TEMP TABLE _rekey_prev ON COMMIT DROP AS
  WITH fresh AS MATERIALIZED (
    SELECT DISTINCT task_rekey_stable_key(g.task_id) AS skey
      FROM _gaps g
     WHERE task_rekey_stable_key(g.task_id) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM task_dispatches y WHERE y.task_id = g.task_id)
  )
  SELECT DISTINCT ON (d.skey) d.skey, d.task_id AS prev_task_id, d.last_dispatched_at, d.dispatch_count, d.boost_seconds,
         COALESCE((d.opened_by->>'chain_opened_at')::TIMESTAMPTZ, d.opened_at) AS chain_opened_at
    FROM (SELECT x.*, task_rekey_stable_key(x.task_id) AS skey FROM task_dispatches x WHERE x.task_id LIKE 'auto:%') d
    JOIN fresh f ON f.skey = d.skey
   WHERE NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND COALESCE((SELECT q.rekey_keep_position FROM queue_settings q WHERE q.id = 1), true)
   ORDER BY d.skey, d.queue_at, d.task_id;
  -- <<< 換號沿用排隊位置
  PERFORM seed_arm_timing_log(v_run, 'stage:rekey_prev', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- >>> gap_events window：臂自己還算得出來這個缺口、只是規則的窗口關了（例：party_roster 過了投票日）→ 收回，原因記 window（交給觸發器寫進 closed 事件）
  PERFORM set_config('gap.close_reason', 'window', true);
  PERFORM set_config('gap.close_detail', '{"via":"seed_window"}', true);
  DELETE FROM task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  -- <<< gap_events window

  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）
  DELETE FROM task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);
  PERFORM seed_arm_timing_log(v_run, 'stage:close_gaps', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- 既有的只更新內容，不動排隊位置
  -- >>> 內容沒變不重寫（#465）：六個內容欄任一欄真的變了才更新；沒變的列不碰（每 10 分鐘約 8,000 列整列重寫的成本，幾乎都是白做）。refreshed_at 的語意因此是「內容最後一次被改寫的時間」
  UPDATE task_dispatches d SET task_type = a.task_type, target = g.target, what_we_need = a.what_we_need,
         hint_sources = a.hint_sources, reward = a.reward, region = a.region, refreshed_at = now()
    FROM _gaps g JOIN _gaps_all a ON a.rn = g.src_rn  -- 暫存表瘦身：寬欄從 _gaps_all 取
   WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (a.task_type, g.target, a.what_we_need, a.hint_sources, a.reward, a.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數
  PERFORM seed_arm_timing_log(v_run, 'stage:update_existing', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority_seconds, boost_seconds)
  SELECT g.task_id, COALESCE(r.last_dispatched_at, now()), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', COALESCE(r.dispatch_count, 0),  -- 換號沿用排隊位置（queue_at 這個值觸發器會照進隊時間重算）
         a.task_type, g.target, a.what_we_need, a.hint_sources, a.reward, a.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds))
           || CASE WHEN r.skey IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('rekey_of', r.prev_task_id, 'chain_opened_at', r.chain_opened_at) END,  -- 換號沿用排隊位置
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE COALESCE(r.boost_seconds, 0) END  -- 換號沿用排隊位置
         -- <<< 優先秒數
    FROM _gaps g
    JOIN _gaps_all a ON a.rn = g.src_rn  -- 暫存表瘦身：寬欄從 _gaps_all 取
    LEFT JOIN _rekey_prev r ON r.skey = task_rekey_stable_key(g.task_id)  -- 換號沿用排隊位置
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;
  PERFORM seed_arm_timing_log(v_run, 'stage:insert_new', v_t, v_new); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- 觸發器漏掉的驗證列補進來
  -- >>> 驗證票跟著任務（20261017010000）：位置由觸發器 task_dispatches_queue_key 照 verify_queue_key 算，這裡不再呼叫 contribution_queue_at（原本給 1970）
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), now(), 0
  -- <<< 驗證票跟著任務
    FROM contributions c
   WHERE c.status = 'pending'
     -- >>> 一人一包（20261112065000）：還在包裡、不是載體（bundle_carrier_id）的條目沒有自己的票（票在載體上），不補；載體本身（含移轉後的新載體）照補
     AND NOT (c.bundle_id IS NOT NULL AND c.bundle_released_at IS NULL AND c.id IS DISTINCT FROM bundle_carrier_id(c.bundle_id))
     -- <<< 一人一包
     AND NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;
  PERFORM seed_arm_timing_log(v_run, 'stage:verify_insert', v_t, v_verify); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM refresh_verify_targets();
  PERFORM seed_arm_timing_log(v_run, 'stage:refresh_blocked_targets', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM manual_front_pull();
  -- <<< 固定時段插隊
  -- >>> 優先秒數（20261011320000）：不再重排（驗證：任務＝2:1 取消，維護者 10-13「什麼時候進隊伍就處理」）；
  --     queue_at 由觸發器 task_dispatches_queue_key 照排序鍵算，上面改到優先秒數、冷卻、插隊秒數的列已經跟著換了位置
  -- <<< 優先秒數
  -- >>> 驗證票跟著任務（20261017010000）：上面任務列的鍵可能剛換（秒數、冷卻、固定時段拉回），還跟著母任務的驗證票跟著換
  PERFORM refresh_verify_ticket_keys();
  -- <<< 驗證票跟著任務
  PERFORM seed_arm_timing_log(v_run, 'stage:front_pull_ticket_keys', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- >>> 各段計時（20261126150000）：整輪總秒數＋清掉 7 天前的紀錄（只寫小表，不影響上面任何一步的結果）
  PERFORM seed_arm_timing_log(v_run, 'stage:total', v_run, v_new + v_verify);
  DELETE FROM seed_arm_timings WHERE run_started_at < now() - INTERVAL '7 days';
  -- <<< 各段計時

  RETURN v_new + v_verify;
END;
$$;

-- ------------------------------------------------------------
-- 6. 對帳：mode＝off 的臂只記差異、不改常駐表（避免在 off 狀態改動缺口表後被誤讀）；shadow／live 照舊補開補關
--    其餘與 20261126170000 的 dispatch_gap_reconcile_all 逐字相同
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_reconcile_all(p_arms TEXT[] DEFAULT NULL) RETURNS SETOF dispatch_gap_reconcile_runs
LANGUAGE plpgsql AS $$
DECLARE
  v_arm TEXT;
  v_row dispatch_gap_reconcile_runs;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('dispatch_gap_writer')) THEN
    RETURN;
  END IF;
  FOR v_arm IN SELECT arm FROM dispatch_gap_arm_keys WHERE p_arms IS NULL OR arm = ANY (p_arms) ORDER BY arm LOOP
    BEGIN
      v_row := dispatch_gap_reconcile_arm(v_arm, gap_arm_mode(v_arm) <> 'off', 'reconcile');  -- 模式 off：只記差異不改表
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO dispatch_gap_reconcile_runs (arm, mode, error) VALUES (v_arm, 'reconcile', left(SQLERRM, 500)) RETURNING * INTO v_row;
    END;
    RETURN NEXT v_row;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION dispatch_gap_reconcile_all(TEXT[]) FROM PUBLIC, anon, authenticated;

-- 雙軌比對的 cron 入口：只比模式不是 off 的臂（全 off 時什麼都不做，不白跑整表函式）
CREATE OR REPLACE FUNCTION dispatch_gap_shadow_run() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_arms TEXT[];
  v_n    INTEGER;
BEGIN
  SELECT array_agg(a.arm ORDER BY a.arm) INTO v_arms
    FROM dispatch_gap_arms a JOIN dispatch_gap_arm_keys k ON k.arm = a.arm
   WHERE a.mode <> 'off';
  IF v_arms IS NULL THEN
    RETURN 0;
  END IF;
  SELECT count(*)::INTEGER INTO v_n FROM dispatch_gap_shadow_compare(v_arms);
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION dispatch_gap_shadow_run() FROM PUBLIC, anon, authenticated;

-- 保留清理：events 處理完超過 7 天、reconcile_runs 超過 30 天
CREATE OR REPLACE FUNCTION dispatch_gap_retention() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_a INTEGER;
  v_b INTEGER;
BEGIN
  DELETE FROM dispatch_gap_events WHERE processed_at IS NOT NULL AND processed_at < now() - INTERVAL '7 days';
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM dispatch_gap_reconcile_runs WHERE run_at < now() - INTERVAL '30 days';
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END;
$$;
REVOKE ALL ON FUNCTION dispatch_gap_retention() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 7. 觸發器函式覆蓋補齊（仍不掛任何正式表）：politician_elections、politicians、contributions、tracking_logs
--    以 20261126170000 的定義為底，多四個分支與一個「只對已登記臂入列」的小函式（沒登記的臂入列了 drain 也處理不了）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_enqueue_reg(p_arm TEXT, p_key TEXT, p_kind TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dispatch_gap_arm_keys k WHERE k.arm = p_arm) THEN
    RETURN false;
  END IF;
  RETURN dispatch_gap_enqueue(p_arm, p_key, p_kind);
END;
$$;
REVOKE ALL ON FUNCTION dispatch_gap_enqueue_reg(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION dispatch_gap_on_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_new     JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_old     JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_row     JSONB;
  v_kind    TEXT := lower(TG_OP);
  v_cols    TEXT[];
  v_changed BOOLEAN;
  v_arm     TEXT;
  v_pid     TEXT;
  v_tid     TEXT;
BEGIN
  IF NOT dispatch_gap_events_enabled() THEN
    RETURN NULL;
  END IF;
  v_row := COALESCE(v_new, v_old);

  IF TG_TABLE_NAME = 'policies' THEN
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['title', 'description', 'category', 'status', 'proposed_date', 'last_updated', 'progress',
                      'election_id', 'politician_id', 'removed_at', 'lineage_id'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_changed;
      IF NOT v_changed THEN
        RETURN NULL;
      END IF;
    END IF;
    PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'id'), v_kind);
    PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || (v_row ->> 'id'), v_kind);
    PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);   -- 反推不出（縣市，議題），整臂重算；同一時段只會留一筆

  ELSIF TG_TABLE_NAME = 'jev_decisions' THEN
    IF TG_OP = 'INSERT' AND v_row ->> 'subject_type' = 'policy' AND v_row ->> 'question' = 'election' THEN
      PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || (v_row ->> 'subject_id'), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'edit_history' THEN
    IF TG_OP = 'INSERT' AND v_row ->> 'table_name' = 'policies' AND v_row ->> 'field' IN ('audit', '*') THEN
      PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'record_id'), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'source_refs' THEN
    IF TG_OP IN ('INSERT', 'DELETE') AND v_row ->> 'target_table' = 'policies' THEN
      PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'target_id'), v_kind);
    END IF;

  -- >>> 20261126180000 補齊：politician_elections、politicians、contributions、tracking_logs（附錄 A.1）
  ELSIF TG_TABLE_NAME = 'politician_elections' THEN
    -- 參選紀錄影響政見×屆別的比對（mismatch）與縣市議題的承諾數（issue_too_broad）：反推不出是哪幾條政見，整臂重算（同一時段只留一筆）。
    -- 其他臂（profile_gap、term_policies…）還沒登記，登記了才會入列
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['candidacy_status', 'cand_no', 'region_id', 'election_type', 'election_id', 'party_basis', 'source_note',
                      'withdrawn_after_filing', 'politician_id', 'position'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_changed;
      IF NOT v_changed THEN
        RETURN NULL;
      END IF;
    END IF;
    PERFORM dispatch_gap_enqueue('mismatch', '*', v_kind);
    PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);
    v_pid := v_row ->> 'politician_id';
    PERFORM dispatch_gap_enqueue_reg('raw:profile_gap', 'politician:' || v_pid, v_kind);
    PERFORM dispatch_gap_enqueue_reg('term_policies', 'politician:' || v_pid, v_kind);

  ELSIF TG_TABLE_NAME = 'politicians' THEN
    -- 人物改名、出生年、狀態會改變這個人名下政見的 mismatch 訊號：入該人名下每一條政見的單位
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['name', 'birth_year', 'status', 'party_id', 'avatar_url', 'current_position'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_changed;
      IF NOT v_changed THEN
        RETURN NULL;
      END IF;
    END IF;
    v_pid := v_row ->> 'id';
    FOR v_tid IN SELECT p.id::TEXT FROM policies p WHERE p.politician_id::TEXT = v_pid LOOP
      PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || v_tid, v_kind);
    END LOOP;
    PERFORM dispatch_gap_enqueue_reg('dup', 'politician:' || v_pid, v_kind);
    PERFORM dispatch_gap_enqueue_reg('raw:profile_gap', 'politician:' || v_pid, v_kind);

  ELSIF TG_TABLE_NAME = 'contributions' THEN
    -- 在途交件會讓臂排除該缺口：只有新增、或狀態在 pending／verified／apply_failed／applied 之間進出時才有影響；
    -- 對到哪個缺口只看 task_id（頂層欄位或 payload.task_id），反推不出的不入列（對帳會補）
    IF TG_OP = 'UPDATE' AND v_old ->> 'status' IS NOT DISTINCT FROM v_new ->> 'status' THEN
      RETURN NULL;
    END IF;
    v_tid := COALESCE(NULLIF(v_row ->> 'task_id', ''), v_row #>> '{payload,task_id}');
    IF v_tid LIKE 'auto:legacy_audit:%' THEN
      PERFORM dispatch_gap_enqueue('legacy', dispatch_gap_scope_key('legacy', v_tid), v_kind);
    ELSIF v_tid LIKE 'auto:policy_election_mismatch:%' THEN
      PERFORM dispatch_gap_enqueue('mismatch', dispatch_gap_scope_key('mismatch', v_tid), v_kind);
    ELSIF v_tid LIKE 'auto:issue_too_broad:%' THEN
      PERFORM dispatch_gap_enqueue('issue_too_broad', dispatch_gap_scope_key('issue_too_broad', v_tid), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'tracking_logs' THEN
    -- 追蹤紀錄只影響進度類臂（progress_stale、deadline_due），它們登記為雙軌臂之前入列函式會略過
    IF TG_OP IN ('INSERT', 'DELETE') THEN
      PERFORM dispatch_gap_enqueue_reg('raw:progress_stale', 'policy:' || (v_row ->> 'policy_id'), v_kind);
      PERFORM dispatch_gap_enqueue_reg('deadline_due', 'policy:' || (v_row ->> 'policy_id'), v_kind);
    END IF;
  -- <<< 20261126180000 補齊

  ELSIF TG_TABLE_NAME IN ('elections', 'election_milestones', 'activity_rules', 'activity_overrides', 'election_task_config',
                          'traffic_watch_levels', 'lineage_settings') THEN
    -- 規則與設定變動：登記的每一支臂都整臂重算
    FOR v_arm IN SELECT arm FROM dispatch_gap_arm_keys ORDER BY arm LOOP
      PERFORM dispatch_gap_enqueue(v_arm, '*', 'config');
    END LOOP;

  ELSE
    RAISE WARNING 'dispatch_gap_on_change：不認得的來源表 %，略過', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION dispatch_gap_on_change() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 8. 各臂暫存量測：seed_arm_timings.temp_bytes ＋ 程序 seed_arm_temp_probe()
-- ------------------------------------------------------------
ALTER TABLE seed_arm_timings ADD COLUMN IF NOT EXISTS temp_bytes BIGINT;
COMMENT ON COLUMN seed_arm_timings.temp_bytes IS '這一筆執行期間資料庫層級 temp_bytes 的增量（20261126180000）。只有 arm 以 temp: 開頭的列有值（seed_arm_temp_probe 每支臂各自一個交易量的），含同時段其他連線的暫存，看量級不當精確值；其餘列為空。';

-- 每支臂與整張總表各自一個交易，交易前後比 pg_stat_database.temp_bytes。
-- 為什麼要程序＋COMMIT：同一交易內 temp_bytes 不更新（正式庫 PG17 實測），seed 函式內量不到；程序可以在臂與臂之間 COMMIT，統計才會送出。
-- 程序不能帶 SET 子句（會擋 COMMIT），所以逾時與記憶體用 set_config 設在連線上（pg_cron 每次一條新連線）。
CREATE OR REPLACE PROCEDURE seed_arm_temp_probe()
LANGUAGE plpgsql
AS $$
DECLARE
  r       RECORD;
  v_run   TIMESTAMPTZ := clock_timestamp();
  v_t     TIMESTAMPTZ;
  v_n     INTEGER;
  v_ok    BOOLEAN;
  v_err   TEXT;
  v_b0    BIGINT;
  v_b1    BIGINT;
  v_unify BOOLEAN := false;
BEGIN
  PERFORM set_config('statement_timeout', '280s', false);
  PERFORM set_config('work_mem', '16MB', false);
  BEGIN
    EXECUTE 'SELECT roster_unify_on()' INTO v_unify;
  EXCEPTION WHEN OTHERS THEN
    v_unify := false;
  END;
  BEGIN PERFORM pg_stat_force_next_flush(); EXCEPTION WHEN OTHERS THEN NULL; END;
  COMMIT;
  FOR r IN SELECT * FROM (VALUES
    ('raw', 'contribution_auto_tasks_raw()', null),
    ('dup', 'contribution_auto_tasks_dup()', null),
    ('legacy', 'contribution_auto_tasks_legacy()', null),
    ('mismatch', 'contribution_auto_tasks_mismatch()', null),
    ('policy_dup', 'contribution_auto_tasks_policy_dup()', null),
    ('not_running', 'contribution_auto_tasks_not_running()', null),
    ('mayor_policies', 'contribution_auto_tasks_mayor_policies()', null),
    ('term_policies', 'contribution_auto_tasks_term_policies()', null),
    ('roster_villages', 'contribution_auto_tasks_roster_villages()', null),
    ('township_gap', 'contribution_auto_tasks_township_gap()', 'off'),
    ('region_gap', 'contribution_auto_tasks_region_gap()', 'off'),
    ('elected_missing', 'contribution_auto_tasks_elected_missing()', 'off'),
    ('roster_cec_gap', 'contribution_auto_tasks_roster_cec_gap()', null),
    ('district_seats', 'contribution_auto_tasks_district_seats()', null),
    ('policy_elements', 'contribution_auto_tasks_policy_elements()', null),
    ('deadline_due', 'contribution_auto_tasks_deadline_due()', null),
    ('lineage_candidates', 'contribution_auto_tasks_lineage_candidates()', null),
    ('handover_missing', 'contribution_auto_tasks_handover_missing()', null),
    ('lineage_roles', 'contribution_auto_tasks_lineage_roles()', null),
    ('lineage_links', 'contribution_auto_tasks_lineage_links()', null),
    ('career_sources', 'contribution_auto_tasks_career_sources()', null),
    ('withdrawn_filing', 'contribution_auto_tasks_withdrawn_filing()', null),
    ('party_gap', 'contribution_auto_tasks_party_gap()', 'off'),
    ('party_roster', 'contribution_auto_tasks_party_roster()', 'off'),
    ('party_info', 'contribution_auto_tasks_party_info()', null),
    ('placeholder_politicians', 'contribution_auto_tasks_placeholder_politicians()', null),
    ('election_results', 'contribution_auto_tasks_election_results()', 'off'),
    ('owner_mismatch', 'contribution_auto_tasks_owner_mismatch()', 'off'),
    ('ballot_numbers', 'contribution_auto_tasks_ballot_numbers()', null),
    ('manual_visitor', 'contribution_auto_tasks_manual(true)', null),
    ('manual_open', 'contribution_auto_tasks_manual(false)', null),
    ('regional_stats_missing', 'contribution_auto_tasks_regional_stats_missing()', null),
    ('issue_too_broad', 'contribution_auto_tasks_issue_too_broad()', null),
    ('lineage_status', 'contribution_auto_tasks_lineage_status()', null),
    ('lineage_stances', 'contribution_auto_tasks_lineage_stances()', null),
    ('lineage_events', 'contribution_auto_tasks_lineage_events()', null),
    ('roster_unit_findings', 'roster_unit_findings()', 'on'),
    ('roster_gap_units', 'roster_gap_units()', 'on'),
    ('roster_gap_fresh_units', 'roster_gap_fresh_units()', 'on'),
    ('arms_all', 'contribution_auto_tasks_arms()', null)   -- 整張總表：減掉各臂加總＝總表後半 CTE 鏈自己的暫存
  ) AS a(arm, call_sql, gate) LOOP
    IF (r.gate = 'off' AND v_unify) OR (r.gate = 'on' AND NOT v_unify) THEN
      CONTINUE;  -- 總表裡這支臂被開關整支略過，沒有暫存可量
    END IF;
    SELECT d.temp_bytes INTO v_b0 FROM pg_stat_database d WHERE d.datname = current_database();
    v_t := clock_timestamp();
    v_ok := true; v_err := NULL; v_n := NULL;
    BEGIN
      EXECUTE 'SELECT count(*)::INTEGER FROM ' || r.call_sql INTO v_n;
    EXCEPTION WHEN OTHERS THEN
      v_ok := false; v_err := left(SQLERRM, 300);
    END;
    BEGIN PERFORM pg_stat_force_next_flush(); EXCEPTION WHEN OTHERS THEN NULL; END;
    COMMIT;
    SELECT d.temp_bytes INTO v_b1 FROM pg_stat_database d WHERE d.datname = current_database();
    INSERT INTO seed_arm_timings (run_started_at, arm, elapsed_ms, row_count, ok, error, temp_bytes)
    VALUES (v_run, 'temp:' || r.arm, GREATEST(0, round(EXTRACT(EPOCH FROM (clock_timestamp() - v_t)) * 1000))::INTEGER, v_n, v_ok, v_err,
            CASE WHEN v_b0 IS NULL OR v_b1 IS NULL THEN NULL ELSE GREATEST(0, v_b1 - v_b0) END);
    COMMIT;
  END LOOP;
END;
$$;
REVOKE ALL ON PROCEDURE seed_arm_temp_probe() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 9. 排程（分鐘全部避開 :x0、:29、:35 與奇數分鐘；seed 在整十分鐘、queue-task-counts-refresh 在奇數分鐘，見 20261126160000）
--    · dispatch-gap-shadow-compare-hourly  :48              雙軌比對（只比模式不是 off 的臂）
--    · dispatch-gap-reconcile-daily        UTC 19:32 ＝ 台北 03:32   每日全量對帳（off 的臂只記差異）。整點分 :30 與 seed 同分鐘，所以晚兩分鐘
--    · dispatch-gap-retention-daily        UTC 20:26 ＝ 台北 04:26   清 events（處理完 >7 天）、reconcile_runs（>30 天）
--    · seed-arm-temp-probe-daily           UTC 20:44 ＝ 台北 04:44   各臂暫存量測（清晨低流量）
--    pg_cron 以 UTC 計時。
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('dispatch-gap-shadow-compare-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-gap-shadow-compare-hourly')$q$;
    EXECUTE $q$SELECT cron.schedule('dispatch-gap-shadow-compare-hourly', '48 * * * *', 'SET statement_timeout TO ''120s''; SELECT dispatch_gap_shadow_run();')$q$;
    EXECUTE $q$SELECT cron.unschedule('dispatch-gap-reconcile-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-gap-reconcile-daily')$q$;
    EXECUTE $q$SELECT cron.schedule('dispatch-gap-reconcile-daily', '32 19 * * *', 'SET statement_timeout TO ''240s''; SELECT count(*) FROM dispatch_gap_reconcile_all();')$q$;
    EXECUTE $q$SELECT cron.unschedule('dispatch-gap-retention-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-gap-retention-daily')$q$;
    EXECUTE $q$SELECT cron.schedule('dispatch-gap-retention-daily', '26 20 * * *', 'SELECT dispatch_gap_retention();')$q$;
    EXECUTE $q$SELECT cron.unschedule('seed-arm-temp-probe-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'seed-arm-temp-probe-daily')$q$;
    EXECUTE $q$SELECT cron.schedule('seed-arm-temp-probe-daily', '44 20 * * *', 'CALL seed_arm_temp_probe();')$q$;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 10. 自我檢查：臂模式表登記齊全且全是 off、總表二段式接上、前一版還在、seed 開頭 drain 預設關
-- ------------------------------------------------------------
DO $$
DECLARE
  v_def TEXT := pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure);
BEGIN
  IF EXISTS (SELECT 1 FROM dispatch_gap_arms WHERE mode <> 'off') THEN
    RAISE EXCEPTION '第 0 期所有臂的模式都必須是 off';
  END IF;
  IF (SELECT count(*) FROM dispatch_gap_arms) <> (SELECT count(*) FROM unnest(activity_arm_names()) a WHERE a NOT LIKE 'traffic:%') THEN
    RAISE EXCEPTION '臂模式表沒有登記齊全（activity_arm_names 去掉 traffic:*）';
  END IF;
  IF strpos(v_def, 'live_arms') = 0 OR strpos(v_def, 'dispatch_gap_rows_all()') = 0 THEN
    RAISE EXCEPTION '總表沒有接上二段式';
  END IF;
  IF to_regprocedure('contribution_auto_tasks_arms_v20261126()') IS NULL THEN
    RAISE EXCEPTION '前一版總表沒有保留';
  END IF;
  IF dispatch_gap_seed_drain_enabled() THEN
    RAISE EXCEPTION 'seed 開頭 drain 的總開關預設必須是關';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
