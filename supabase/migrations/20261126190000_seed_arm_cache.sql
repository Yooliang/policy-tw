-- seed 排程減負：最貴的四支臂改「每小時算一次存進快取表、10 分鐘的 seed 讀快取」；探針降為每 6 小時（只改排程與讀法，不改任何臂的查詢本體、不改總表、不改 seed）
--
-- 背景：pg_cron seed-auto-task-queue-10min 每 10 分鐘呼叫 seed_auto_task_queue()，核心是派工總表 contribution_auto_tasks_arms()（約 35 支缺口臂各查整庫現況）。
-- 11-26 上線的計時（20261126150000）量到：seed 單輪均約 55 秒，其中總表約 38 秒；探針逐臂單獨計時，最貴四支合計約占探針總和的 74%：
--     mismatch 8.4 秒｜roster_unit_findings 4.4 秒｜issue_too_broad 3.4 秒｜legacy 2.4 秒（四支合計 18.6 秒，探針總和 25.2 秒）
--   其餘各臂都在 1.5 秒以下，單支不值得快取。
--
-- 做法（為什麼是「改名＋換一層薄函式」，不動總表也不動 seed）：
--   總表 contribution_auto_tasks_arms() 是單一敘述，約 20 支測試守著它的歷史定義鏈，seed 也被好幾支測試守著；兩者本體一個字都不動。
--   四支重臂各自改名成 <原名>_live（ALTER FUNCTION … RENAME，本體、SET、註解、權限原樣保留），原名換成一支薄函式：
--     快取「就緒」（有刷新紀錄、沒過期）→ 讀快取表 seed_arm_cache；否則（第一次上線、刷新失敗過久、開關關著）→ 呼叫 <原名>_live() 即時算。
--   所以任何呼叫者（seed、/tasks、/request-task、探針以外的一切）看到的輸出欄位與型別完全不變；快取空或過期時行為與改前逐字相同，不會因為快取壞掉少派任務。
--   總表裡這四支的下游（開窗 activity_open、流量開窗、測試名人物過濾、名單缺口、名單清查收斂）全部照舊即時算，只有「缺口列從哪來」換成快取。
--
-- 新物件：
--   表 seed_arm_cache(arm, row_no, payload jsonb)：每支重臂一組列，payload＝該列的 to_jsonb（讀回時用 jsonb_to_record 還原成原欄位型別）
--   表 seed_arm_cache_arms(arm, live_fn, enabled, refreshed_at, row_count, elapsed_ms, last_error)：重臂清單（要加減重臂改這張表＋加一支薄函式，見 CLAUDE.md）
--   表 seed_arm_cache_settings(id=1, enabled, max_age_minutes)：整體開關與過期時限（初值 180 分鐘＝刷新連續失敗兩輪以上才退回即時算）
--   函式 seed_arm_cache_ready(arm)、seed_arm_cache_rows(arm)（SECURITY DEFINER：臂函式本來就 anon 可呼叫，薄函式不能因為讀不到快取表而壞；只回該臂的列，與臂函式本來公開的內容相同）
--   函式 seed_arm_cache_refresh(arms text[] 預設全部)：每支臂一個子交易，DELETE＋INSERT 在同一個交易內提交，讀的人看到的不是舊的整批就是新的整批；單臂失敗只記 last_error，保留舊快取
--   pg_cron seed-arm-cache-refresh-heavy：每小時第 29 分（避開整十分鐘與 :35 探針；seed 在 :20 跑完、:30 才再起跑）
--   探針 seed_arm_timing_probe() 重點：四支重臂改呼叫 _live（量真實成本，不是量快取讀取）；排程 seed-arm-timing-probe-hourly 改 35 */6 * * *
--
-- 正確性邊界（最重要，PR 說明同）：
--   ① 重臂的缺口「新出現」最多晚 60 分鐘進佇列（刷新週期）。這四支臂都是補資料／查核類（屆別疑似標錯、早期匯入未核對、議題過寬、名單清查單位彙總），沒有時效性窗口。
--   ② 缺口「被補上」最多晚 60 分鐘收回：seed 的收回只認 _gaps（含快取列），補上後最多再留 60 分鐘。這段時間任務若被領走，代理回報會看到現況已無缺口（no_change）；
--      不會重複派工（task_id 不變、同一列），也不會錯誤收回（收回只發生在臂算不出來時，快取只會讓它晚一點算不出來）。
--   ③ 窗口關了的收回（gap_events reason=window）與開窗、流量提層、測試名人物過濾都在快取的下游，照舊每 10 分鐘即時判斷；快取只換「缺口列的來源」。
--   ④ 刷新與讀取在不同交易：刷新交易提交前，seed 讀到的是上一版整批快取，不會讀到半批。
--   ⑤ 快取過期（超過 max_age_minutes 沒刷新成功）或開關關掉，薄函式自動退回即時算＝改前行為。
--
-- 回滾（一支遷移就夠，互不依賴的幾步可以只做一部分）：
--   SELECT cron.unschedule('seed-arm-cache-refresh-heavy');
--   立刻退回即時算、不改函式：UPDATE seed_arm_cache_settings SET enabled = false WHERE id = 1;
--   完全拿掉：對四支臂各做 DROP FUNCTION <原名>(); ALTER FUNCTION <原名>_live() RENAME TO <原名>;（contribution_auto_tasks_mismatch、contribution_auto_tasks_issue_too_broad、contribution_auto_tasks_legacy、roster_unit_findings）
--   再 DROP FUNCTION seed_arm_cache_refresh(TEXT[]), seed_arm_cache_rows(TEXT), seed_arm_cache_ready(TEXT)；DROP TABLE seed_arm_cache, seed_arm_cache_arms, seed_arm_cache_settings；
--   探針排程改回 35 * * * *，探針函式換回 20261126150000 的定義。
--
-- 風險：刷新每小時一次，約 19 秒（四支臂各自的即時成本），在 :29 單獨跑、不在 seed 的交易裡；寫入量是約 1,100 列的 DELETE＋INSERT。薄函式多一次 jsonb_to_record，約 1,100 列、毫秒級。

-- ------------------------------------------------------------
-- 1. 表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seed_arm_cache (
  arm     TEXT    NOT NULL,
  row_no  INTEGER NOT NULL,
  payload JSONB   NOT NULL,
  PRIMARY KEY (arm, row_no)
);
ALTER TABLE seed_arm_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE seed_arm_cache FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE seed_arm_cache IS '派工臂快取（20261126190000）：重臂每小時算一次的整批輸出，一臂一組列，payload＝該列 to_jsonb。沒有任何 policy＝只有 service_role／postgres 直接讀得到；薄函式經 seed_arm_cache_rows 讀。';

CREATE TABLE IF NOT EXISTS seed_arm_cache_arms (
  arm          TEXT PRIMARY KEY,
  live_fn      TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  refreshed_at TIMESTAMPTZ,
  row_count    INTEGER,
  elapsed_ms   INTEGER,
  last_error   TEXT
);
ALTER TABLE seed_arm_cache_arms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE seed_arm_cache_arms FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE seed_arm_cache_arms IS '快取的重臂清單與刷新狀態（20261126190000）。live_fn＝即時算的函式名（<臂函式>_live）；refreshed_at 是最近一次刷新成功的時間，薄函式據此判斷是否過期。';

CREATE TABLE IF NOT EXISTS seed_arm_cache_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  max_age_minutes INTEGER NOT NULL DEFAULT 180 CHECK (max_age_minutes >= 10)
);
ALTER TABLE seed_arm_cache_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE seed_arm_cache_settings FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE seed_arm_cache_settings IS '派工臂快取的整體開關與過期時限（20261126190000）。enabled=false 立刻全部退回即時算；max_age_minutes 預設 180＝刷新每小時一次、連續失敗兩輪後退回即時算。';
INSERT INTO seed_arm_cache_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

INSERT INTO seed_arm_cache_arms (arm, live_fn) VALUES
  ('mismatch',             'contribution_auto_tasks_mismatch_live'),
  ('issue_too_broad',      'contribution_auto_tasks_issue_too_broad_live'),
  ('legacy',               'contribution_auto_tasks_legacy_live'),
  ('roster_unit_findings', 'roster_unit_findings_live')
ON CONFLICT (arm) DO NOTHING;

-- ------------------------------------------------------------
-- 2. 讀快取的小工具（SECURITY DEFINER：臂函式 anon 可呼叫，薄函式不能因為讀不到快取表而壞）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_arm_cache_ready(p_arm TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT s.enabled AND a.enabled AND a.refreshed_at IS NOT NULL
                          AND a.refreshed_at > now() - make_interval(mins => s.max_age_minutes)
                     FROM seed_arm_cache_settings s, seed_arm_cache_arms a
                    WHERE s.id = 1 AND a.arm = p_arm), false)
$$;
COMMENT ON FUNCTION seed_arm_cache_ready IS '這支臂的快取可用嗎：整體開關開著、這支臂啟用、有刷新成功紀錄、沒超過 max_age_minutes。不可用時薄函式退回即時算。';

CREATE OR REPLACE FUNCTION seed_arm_cache_rows(p_arm TEXT)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.payload FROM seed_arm_cache c WHERE c.arm = p_arm AND seed_arm_cache_ready(p_arm) ORDER BY c.row_no
$$;
COMMENT ON FUNCTION seed_arm_cache_rows IS '某支臂的快取列（payload），快取不可用時回空集合（薄函式再去呼叫即時版）。';

GRANT EXECUTE ON FUNCTION seed_arm_cache_ready(TEXT), seed_arm_cache_rows(TEXT) TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. 四支重臂：改名成 _live，原名換成薄函式
--    ALTER FUNCTION … RENAME 保留本體、SET、註解與權限；呼叫原名的一切（總表、/tasks、其他函式）自動走薄函式
-- ------------------------------------------------------------
ALTER FUNCTION contribution_auto_tasks_mismatch() RENAME TO contribution_auto_tasks_mismatch_live;
ALTER FUNCTION contribution_auto_tasks_issue_too_broad() RENAME TO contribution_auto_tasks_issue_too_broad_live;
ALTER FUNCTION contribution_auto_tasks_legacy() RENAME TO contribution_auto_tasks_legacy_live;
ALTER FUNCTION roster_unit_findings() RENAME TO roster_unit_findings_live;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT r.* FROM seed_arm_cache_rows('mismatch') AS c(p),
         LATERAL jsonb_to_record(c.p) AS r(task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  UNION ALL
  SELECT l.* FROM contribution_auto_tasks_mismatch_live() l WHERE NOT seed_arm_cache_ready('mismatch')
$$;
COMMENT ON FUNCTION contribution_auto_tasks_mismatch IS '薄函式（20261126190000）：快取就緒讀 seed_arm_cache，否則呼叫即時版 contribution_auto_tasks_mismatch_live()。臂的邏輯在 _live。';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_issue_too_broad()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT r.* FROM seed_arm_cache_rows('issue_too_broad') AS c(p),
         LATERAL jsonb_to_record(c.p) AS r(task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  UNION ALL
  SELECT l.* FROM contribution_auto_tasks_issue_too_broad_live() l WHERE NOT seed_arm_cache_ready('issue_too_broad')
$$;
COMMENT ON FUNCTION contribution_auto_tasks_issue_too_broad IS '薄函式（20261126190000）：快取就緒讀 seed_arm_cache，否則呼叫即時版 contribution_auto_tasks_issue_too_broad_live()。臂的邏輯在 _live。';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_legacy()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT r.* FROM seed_arm_cache_rows('legacy') AS c(p),
         LATERAL jsonb_to_record(c.p) AS r(task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  UNION ALL
  SELECT l.* FROM contribution_auto_tasks_legacy_live() l WHERE NOT seed_arm_cache_ready('legacy')
$$;
COMMENT ON FUNCTION contribution_auto_tasks_legacy IS '薄函式（20261126190000）：快取就緒讀 seed_arm_cache，否則呼叫即時版 contribution_auto_tasks_legacy_live()。臂的邏輯在 _live。';

CREATE OR REPLACE FUNCTION roster_unit_findings()
RETURNS TABLE (task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT, voted BOOLEAN,
               items JSONB, items_count INTEGER, kinds JSONB, origin_task_ids TEXT[], target JSONB, what_we_need TEXT, hint_sources TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT r.* FROM seed_arm_cache_rows('roster_unit_findings') AS c(p),
         LATERAL jsonb_to_record(c.p) AS r(task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT, voted BOOLEAN,
                                           items JSONB, items_count INTEGER, kinds JSONB, origin_task_ids TEXT[], target JSONB, what_we_need TEXT, hint_sources TEXT[])
  UNION ALL
  SELECT l.* FROM roster_unit_findings_live() l WHERE NOT seed_arm_cache_ready('roster_unit_findings')
$$;
COMMENT ON FUNCTION roster_unit_findings IS '薄函式（20261126190000）：快取就緒讀 seed_arm_cache，否則呼叫即時版 roster_unit_findings_live()。單位清查的邏輯在 _live。';

-- ------------------------------------------------------------
-- 4. 刷新函式：每支臂一個子交易（失敗保留舊快取、只記 last_error），成功就整批替換並更新 refreshed_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_arm_cache_refresh(p_arms TEXT[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SET statement_timeout = '280s'
SET work_mem = '16MB'
AS $$
DECLARE r RECORD; v_t TIMESTAMPTZ; v_run TIMESTAMPTZ := clock_timestamp(); v_n INTEGER; v_done INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('seed_arm_cache_refresh'));  -- 手動與排程同時跑時排隊，不互相蓋
  FOR r IN SELECT a.arm, a.live_fn FROM seed_arm_cache_arms a
            WHERE a.enabled AND (p_arms IS NULL OR a.arm = ANY (p_arms)) ORDER BY a.arm LOOP
    v_t := clock_timestamp();
    BEGIN
      DELETE FROM seed_arm_cache WHERE arm = r.arm;
      EXECUTE format('INSERT INTO seed_arm_cache (arm, row_no, payload) SELECT %L, (row_number() OVER ())::INTEGER, to_jsonb(t) FROM %I() t', r.arm, r.live_fn);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      UPDATE seed_arm_cache_arms SET refreshed_at = clock_timestamp(), row_count = v_n,
             elapsed_ms = GREATEST(0, round(EXTRACT(EPOCH FROM (clock_timestamp() - v_t)) * 1000))::INTEGER, last_error = NULL
       WHERE arm = r.arm;
      PERFORM seed_arm_timing_log(v_run, 'stage:cache_refresh:' || r.arm, v_t, v_n);
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE seed_arm_cache_arms SET last_error = left(SQLERRM, 300) WHERE arm = r.arm;
      PERFORM seed_arm_timing_log(v_run, 'stage:cache_refresh:' || r.arm, v_t, NULL, false, left(SQLERRM, 300));
    END;
  END LOOP;
  PERFORM seed_arm_timing_log(v_run, 'stage:cache_refresh_total', v_run, v_done);
  RETURN v_done;
END;
$$;
REVOKE ALL ON FUNCTION seed_arm_cache_refresh(TEXT[]) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION seed_arm_cache_refresh IS '刷新重臂快取（20261126190000）：對 seed_arm_cache_arms 裡啟用的臂（或 p_arms 指定的）呼叫即時版、整批替換快取列。每臂一個子交易，單臂失敗保留舊快取。回傳成功的臂數。';

-- ------------------------------------------------------------
-- 5. 探針：重臂改量即時版（_live），其餘不變；內容以 20261126150000 為底，只換四行的呼叫
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_arm_timing_probe()
RETURNS INTEGER
LANGUAGE plpgsql
SET statement_timeout = '280s'
SET work_mem = '16MB'
AS $$
DECLARE r RECORD; v_run TIMESTAMPTZ := clock_timestamp(); v_t TIMESTAMPTZ; v_n INTEGER; v_cnt INTEGER := 0; v_unify BOOLEAN;
BEGIN
  v_unify := roster_unify_on();
  FOR r IN SELECT * FROM (VALUES
    ('raw', 'contribution_auto_tasks_raw()', null),
    ('dup', 'contribution_auto_tasks_dup()', null),
    ('legacy', 'contribution_auto_tasks_legacy_live()', null),
    ('mismatch', 'contribution_auto_tasks_mismatch_live()', null),
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
    ('issue_too_broad', 'contribution_auto_tasks_issue_too_broad_live()', null),
    ('lineage_status', 'contribution_auto_tasks_lineage_status()', null),
    ('lineage_stances', 'contribution_auto_tasks_lineage_stances()', null),
    ('lineage_events', 'contribution_auto_tasks_lineage_events()', null),
    ('roster_unit_findings', 'roster_unit_findings_live()', 'on'),
    ('roster_gap_units', 'roster_gap_units()', 'on'),
    ('roster_gap_fresh_units', 'roster_gap_fresh_units()', 'on')
  ) AS a(arm, call_sql, gate) LOOP
    v_t := clock_timestamp();
    IF (r.gate = 'off' AND v_unify) OR (r.gate = 'on' AND NOT v_unify) THEN
      -- 總表裡這支臂被開關整支略過，不呼叫
      INSERT INTO seed_arm_timings (run_started_at, arm, elapsed_ms, row_count, ok, error) VALUES (v_run, r.arm, 0, NULL, true, '開關略過');
    ELSE
      BEGIN
        EXECUTE 'SELECT count(*)::INTEGER FROM ' || r.call_sql INTO v_n;
        PERFORM seed_arm_timing_log(v_run, r.arm, v_t, v_n);
      EXCEPTION WHEN OTHERS THEN
        PERFORM seed_arm_timing_log(v_run, r.arm, v_t, NULL, false, left(SQLERRM, 300));
      END;
    END IF;
    v_cnt := v_cnt + 1;
  END LOOP;
  PERFORM seed_arm_timing_log(v_run, 'stage:probe_total', v_run, v_cnt);
  RETURN v_cnt;
END;
$$;
REVOKE ALL ON FUNCTION seed_arm_timing_probe() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 6. 排程：刷新每小時第 29 分；探針降為每 6 小時（:35）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'seed-arm-cache-refresh-heavy') THEN
    PERFORM cron.unschedule('seed-arm-cache-refresh-heavy');
  END IF;
  PERFORM cron.schedule('seed-arm-cache-refresh-heavy', '29 * * * *', $cmd$SELECT seed_arm_cache_refresh();$cmd$);
  PERFORM cron.alter_job(j.jobid, schedule := m.new_schedule)
  FROM (VALUES
    ('seed-arm-timing-probe-hourly', '35 */6 * * *')
  ) AS m(jobname, new_schedule)
  JOIN cron.job j ON j.jobname = m.jobname
  WHERE j.schedule IS DISTINCT FROM m.new_schedule;
END;
$$;

-- ------------------------------------------------------------
-- 7. 自我檢查：四支薄函式與 _live 都在、刷新函式與清單都在、總表與 seed 一個字沒動（仍直接呼叫原名）
-- ------------------------------------------------------------
DO $$
DECLARE v_arms TEXT := pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure);
BEGIN
  IF (SELECT count(*) FROM seed_arm_cache_arms) < 4 THEN
    RAISE EXCEPTION '重臂清單少於四支';
  END IF;
  IF to_regprocedure('contribution_auto_tasks_mismatch_live()') IS NULL
     OR to_regprocedure('contribution_auto_tasks_issue_too_broad_live()') IS NULL
     OR to_regprocedure('contribution_auto_tasks_legacy_live()') IS NULL
     OR to_regprocedure('roster_unit_findings_live()') IS NULL THEN
    RAISE EXCEPTION '即時版 _live 函式沒建成';
  END IF;
  IF strpos(v_arms, 'contribution_auto_tasks_mismatch()') = 0 OR strpos(v_arms, 'contribution_auto_tasks_legacy()') = 0
     OR strpos(v_arms, 'contribution_auto_tasks_issue_too_broad()') = 0 OR strpos(v_arms, 'roster_unit_findings()') = 0 THEN
    RAISE EXCEPTION '總表要繼續呼叫原名（薄函式），不能被改過';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
