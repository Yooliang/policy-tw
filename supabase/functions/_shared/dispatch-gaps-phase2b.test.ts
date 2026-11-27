/**
 * 派工臂事件驅動化 第 2 期 PR-2（migration 20261127082000_dispatch_gaps_phase2b.sql）守門。
 * 設計：docs/dispatch-arms-event-driven-plan.md 第 5 節「第 2 期」與附錄 A.1／A.3。
 *
 * 用 PGlite 真的把第 0 期兩支、第 1 期、第 2 期 PR-1 與本支跑一遍。四支新臂（roster_cec_gap、roster_villages、district_seats、raw 的 roster_check 型）
 * 與 cec_roster_diff、roster_diff_findings 用「現行真定義」（從各自最新的遷移檔原文抽出來）；它們依賴的外部函式與資料表用最簡單的等價物。驗：
 *   A 最新定義沒被後來的遷移蓋掉；按鍵版與整表版本體只差鍵過濾（文字層，逐行）
 *   B 按鍵重算與整表函式限定同鍵的結果雙向 EXCEPT 為 0（四支）；cec_roster_diff、roster_diff_findings 帶 p_keys：NULL／全部鍵與舊版真定義雙向 0，部分鍵＝舊版輸出過濾；
 *     結果類的 election_result_cec_matches 只算該單位（成本證據）
 *   C 鍵的組法與入列函式
 *   D 觸發器：新來源表變動入列正確的鍵；不相關的更新不入列；PR-1 的入列行為不變
 *   E drain：變動後常駐表與整表結果一致，且證明走的是按鍵版
 *   F 雙軌比對：十支 shadow、差異為 0；總表輸出與前一版雙向 EXCEPT 為 0，且與遷移前逐列相同
 *   G 初始灌入
 *   H 遷移文字守門
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, mutate } from "./arms-pglite.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const PR1 = "20261126170000_dispatch_gaps_phase0.sql";
const PR2 = "20261126180000_dispatch_gaps_phase0b.sql";
const PH1A = "20261126193000_dispatch_gaps_phase1a.sql";
const PH2A = "20261127044503_dispatch_gaps_phase2a.sql";
const MIG_NAME = "20261127082000_dispatch_gaps_phase2b.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const pr1 = await read(PR1);
const pr2 = await read(PR2);
const ph1a = await read(PH1A);
const ph2a = await read(PH2A);
const mig = await read(MIG_NAME);
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ── 現行真定義（抽原文）──
const CEC_GAP_FILE = "20261008180000_arms_perf.sql";
const VILLAGES_FILE = "20261029030000_roster_batch_cap_80.sql";
const SEATS_FILE = "20261011080000_district_seats_registered_floor.sql";
const RAW_FILE = "20261115010000_profile_gap_hint_ipdb.sql";
const FINDINGS_FILE = "20261101040000_roster_result_findings_voted_only.sql";
const DIFF_FILE = "20261031160000_cec_roster_2026.sql";
const DIFF_PATCH_FILE = "20261109210000_roster_group_person_cooldown.sql";
const UNIFY_FILE = "20261101020000_roster_check_unify.sql";
const GAP_FILE = "20261103010000_roster_gap_units.sql";
const BALLOT_FILE = "20261109190000_cand_no_ladder_and_off_roster.sql";
const cecGapSrc = fnText(await read(CEC_GAP_FILE), "contribution_auto_tasks_roster_cec_gap");
const villagesSrc = fnText(await read(VILLAGES_FILE), "contribution_auto_tasks_roster_villages");
const seatsSrc = fnText(await read(SEATS_FILE), "contribution_auto_tasks_district_seats");
const rawSrc = fnText(await read(RAW_FILE), "contribution_auto_tasks_raw");
const findingsSrc = fnText(await read(FINDINGS_FILE), "roster_diff_findings");
const unifySql = await read(UNIFY_FILE);
const gapSql = await read(GAP_FILE);
const ballotSql = await read(BALLOT_FILE);
const unitFindingsSrc = fnText(unifySql, "roster_unit_findings");
const gapUnitsSrc = fnText(gapSql, "roster_gap_units");
const ballotSrc = fnText(ballotSql, "contribution_auto_tasks_ballot_numbers");
// cec_roster_diff：20261031160000 的本體＋20261109210000 的 dup 排除（那支遷移用 pg_get_functiondef 做一處替換）
const DUP_FROM = "FROM dg g";
const DUP_FILTER = "FROM dg g\n   WHERE NOT EXISTS (SELECT 1 FROM politician_pair_resolutions x WHERE x.pair_key = g.a_pid::TEXT || '|' || g.b_pid::TEXT AND x.resolution = 'different')";
const diffSrc = mutate(fnText(await read(DIFF_FILE), "cec_roster_diff"), DUP_FROM, DUP_FILTER);
const viewFile = await read("20261009070000_rep_district_ballot_unit.sql");
const unitsView = viewFile.slice(viewFile.indexOf("CREATE OR REPLACE VIEW ballot_number_units AS"), viewFile.indexOf("COMMENT ON VIEW ballot_number_units"));
assert(unitsView.length > 100, "抽不到 ballot_number_units 視圖");

// raw：只留 roster_check 這一段（含它用到的 ours、filed_out 兩個 CTE），其餘任務型別用回放表
const RAW_CTE_FROM = rawSrc.indexOf("  ours AS (");
const RAW_CTE_TO = rawSrc.indexOf("  SELECT 'auto:policy_missing:'");
const RAW_SEL_FROM = rawSrc.indexOf("  SELECT 'auto:roster_check:'");
const RAW_SEL_TO = rawSrc.indexOf("  UNION ALL\n  SELECT 'auto:policy_election_missing:'");
assert(RAW_CTE_FROM > 0 && RAW_CTE_TO > RAW_CTE_FROM && RAW_SEL_FROM > RAW_CTE_TO && RAW_SEL_TO > RAW_SEL_FROM, "抽不到 raw 的 roster_check 段");
const rawCtes = rawSrc.slice(RAW_CTE_FROM, RAW_CTE_TO);
const rawRosterSel = rawSrc.slice(RAW_SEL_FROM, RAW_SEL_TO);

// ── 假環境 ──
const ARM_FNS = [
  "dup", "legacy", "mismatch", "policy_dup", "not_running", "mayor_policies", "term_policies", "township_gap",
  "region_gap", "elected_missing", "policy_elements", "lineage_candidates", "handover_missing",
  "lineage_roles", "lineage_links", "career_sources", "withdrawn_filing", "party_gap", "party_roster", "party_info",
  "placeholder_politicians", "election_results", "owner_mismatch", "regional_stats_missing", "issue_too_broad",
  "lineage_status", "lineage_stances", "lineage_events",
];
const ARM_NAMES = [
  "raw:policy_missing", "raw:profile_gap", "raw:policy_validity", "raw:progress_stale", "raw:candidacy_source_missing", "raw:roster_check",
  "raw:policy_election_missing", "raw:candidate_status_stale", "dup", "legacy", "mismatch", "policy_dup", "not_running", "mayor_policies", "term_policies",
  "roster_villages", "township_gap", "region_gap", "elected_missing", "roster_cec_gap", "district_seats", "policy_elements", "deadline_due",
  "lineage_candidates", "handover_missing", "lineage_roles", "lineage_links", "career_sources", "withdrawn_filing", "party_gap", "party_roster", "party_info",
  "placeholder_politicians", "election_results", "owner_mismatch", "regional_stats_missing", "issue_too_broad", "lineage_status", "lineage_stances", "lineage_events",
  "ballot_numbers", "manual_visitor", "manual_open", "traffic:progress_stale", "traffic:deadline_due", "traffic:term_policies",
];
const RET = "RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT) LANGUAGE sql STABLE";
const fakeSel = (src: string) => `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = '${src}'`;
const NEWARMS = ["roster_cec_gap", "roster_villages", "district_seats", "raw:roster_check"] as const;
const ALL10 = ["ballot_numbers", "district_seats", "issue_too_broad", "legacy", "mismatch", "raw:roster_check", "roster_cec_gap", "roster_gap_units", "roster_unit_findings", "roster_villages"];
const FULL_FN: Record<string, string> = {
  roster_cec_gap: "contribution_auto_tasks_roster_cec_gap()",
  roster_villages: "contribution_auto_tasks_roster_villages()",
  district_seats: "contribution_auto_tasks_district_seats()",
  "raw:roster_check": "dispatch_gap_full_raw_roster_check()",
  roster_unit_findings: "roster_unit_findings()",
  roster_gap_units: "roster_gap_units()",
  ballot_numbers: "contribution_auto_tasks_ballot_numbers()",
};
const KEYED_FN: Record<string, string> = {
  roster_cec_gap: "dispatch_gap_recompute_roster_cec_gap",
  roster_villages: "dispatch_gap_recompute_roster_villages",
  district_seats: "dispatch_gap_recompute_district_seats",
  "raw:roster_check": "dispatch_gap_recompute_raw_roster_check",
  roster_unit_findings: "dispatch_gap_recompute_roster_unit_findings",
  roster_gap_units: "dispatch_gap_recompute_roster_gap_units",
  ballot_numbers: "dispatch_gap_recompute_ballot_numbers",
};

const DIFF_COLS = `kind TEXT, diff_key TEXT, election_type TEXT, county TEXT, town TEXT, unit TEXT, cand_no INTEGER,
  pe_id INTEGER, politician_id UUID, our_name TEXT, our_status TEXT, our_cand_no INTEGER,
  roster_id BIGINT, roster_name TEXT, roster_party TEXT, roster_birth TEXT, roster_url TEXT, roster_li_code TEXT,
  partner_pe_id INTEGER, partner_politician_id UUID, partner_name TEXT`;
const FIND_COLS = `election_id INTEGER, election_type TEXT, county TEXT, town TEXT, voted BOOLEAN, kind TEXT,
  politician_id UUID, politician_election_id INTEGER, name TEXT, current_value JSONB, official_value JSONB, source_url TEXT, origin_task_id TEXT`;

const ENV_BASE = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE fake_rows (src TEXT, task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT);
${ARM_FNS.map((n) => `CREATE FUNCTION contribution_auto_tasks_${n}() ${RET} AS $f$ ${fakeSel(n)} $f$;`).join("\n")}
CREATE FUNCTION contribution_auto_tasks_deadline_due() ${RET} AS $f$ ${fakeSel("deadline_due")} $f$;
CREATE FUNCTION contribution_auto_tasks_manual(p_visitor BOOLEAN) ${RET} AS $f$ SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = CASE WHEN p_visitor THEN 'manual_visitor' ELSE 'manual_open' END $f$;
CREATE FUNCTION activity_arm_names() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $f$ SELECT ARRAY[${ARM_NAMES.map((n) => `'${n}'`).join(",")}]::TEXT[] $f$;
CREATE TABLE roster_flag (on_ BOOLEAN NOT NULL);
INSERT INTO roster_flag VALUES (false);
CREATE FUNCTION roster_unify_on() RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT on_ FROM roster_flag $f$;
CREATE FUNCTION roster_gap_fresh_units() RETURNS SETOF TEXT LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT WHERE false $f$;
CREATE FUNCTION roster_scope_covers(TEXT, TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION roster_unify_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT '{}'::JSONB $f$;
CREATE FUNCTION roster_gap_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT '{}'::JSONB $f$;
CREATE FUNCTION roster_gap_tid(TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT $1 $f$;
CREATE FUNCTION politician_name_is_placeholder(TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT false $f$;
CREATE FUNCTION traffic_watch_source_arms() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $f$ SELECT ARRAY['raw:progress_stale','deadline_due','term_policies']::TEXT[] $f$;
CREATE TABLE traffic_watch_levels (election_type TEXT, enabled BOOLEAN);
CREATE FUNCTION traffic_watch_arm(TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $f$ SELECT 'traffic:' || regexp_replace($1, '^raw:', '') $f$;
CREATE FUNCTION election_id_or_null(TEXT) RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $f$ SELECT NULLIF(regexp_replace($1, '\\D', '', 'g'), '')::INTEGER $f$;
CREATE FUNCTION uuid_or_null(TEXT) RETURNS UUID LANGUAGE sql IMMUTABLE AS $f$ SELECT CASE WHEN $1 ~ '^[0-9a-f-]{36}$' THEN $1::UUID END $f$;
CREATE FUNCTION activity_require_rule(TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION activity_open(p_arm TEXT, p_eid INTEGER, p_etype TEXT)
  RETURNS TABLE (source TEXT, rule_id BIGINT, override_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE, open_until DATE)
  LANGUAGE sql STABLE AS $f$ SELECT 'rule'::TEXT, 7::BIGINT, NULL::BIGINT, NULL::TEXT, NULL::DATE, NULL::DATE, NULL::DATE $f$;
CREATE TABLE page_traffic_hot (kind TEXT, target_id TEXT);
CREATE TABLE seed_arm_timings (id BIGSERIAL PRIMARY KEY, run_started_at TIMESTAMPTZ NOT NULL, arm TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, row_count INTEGER, ok BOOLEAN NOT NULL DEFAULT true, error TEXT);
CREATE TABLE tracking_logs (id SERIAL PRIMARY KEY, policy_id UUID);
CREATE FUNCTION activity_today() RETURNS DATE LANGUAGE sql STABLE AS $f$ SELECT COALESCE(NULLIF(current_setting('app.activity_today', true), ''), '2026-11-26')::DATE $f$;
CREATE FUNCTION issue_too_broad_election() RETURNS INTEGER LANGUAGE sql STABLE AS $f$ SELECT 2026 $f$;

-- 觸發器會碰到的真表（欄位只放用得到的）
CREATE TABLE elections (id INTEGER PRIMARY KEY, election_date DATE NOT NULL, election_types TEXT[]);
CREATE TABLE regions (id INTEGER PRIMARY KEY, region TEXT, sub_region TEXT, village TEXT, admin_code TEXT);
CREATE TABLE politicians (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, birth_year INTEGER, status TEXT, region TEXT, sub_region TEXT, merged_into UUID, party TEXT);
CREATE TABLE politician_elections (id SERIAL PRIMARY KEY, politician_id UUID, election_id INTEGER, election_type TEXT, candidacy_status TEXT, region_id INTEGER,
  cand_no INTEGER, party_id BIGINT, party_basis TEXT, withdrawn_after_filing BOOLEAN);
CREATE TABLE policies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), politician_id UUID, title TEXT, description TEXT, category TEXT, tags TEXT[],
  status TEXT, proposed_date DATE, last_updated TIMESTAMPTZ, progress TEXT, election_id INTEGER, removed_at TIMESTAMPTZ, lineage_id UUID);
CREATE TABLE jev_decisions (id SERIAL PRIMARY KEY, subject_type TEXT, subject_id TEXT, question TEXT, choice TEXT, probability FLOAT, asked_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE edit_history (id SERIAL PRIMARY KEY, table_name TEXT, record_id TEXT, field TEXT);
CREATE TABLE contributions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id TEXT, status TEXT, payload JSONB, contribution_type TEXT, applied_policy_id UUID);
CREATE TABLE sources (id BIGSERIAL PRIMARY KEY, url TEXT);
CREATE TABLE source_refs (source_id BIGINT, target_table TEXT, target_id TEXT, role TEXT DEFAULT 'primary', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE policy_subtopics (policy_id UUID, issue TEXT, subtopic TEXT);
CREATE TABLE activity_rules (id SERIAL PRIMARY KEY, activity TEXT, enabled BOOLEAN DEFAULT true, params JSONB, except_election_types TEXT[], election_types TEXT[]);
CREATE TABLE election_milestones (id SERIAL PRIMARY KEY, election_id INTEGER, kind TEXT, election_type TEXT, on_date DATE);
CREATE TABLE election_milestones_all (election_id INTEGER, kind TEXT, election_type TEXT, on_date DATE);
CREATE TABLE contribution_tasks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_type TEXT, status TEXT, target JSONB);
CREATE TABLE roster_unify_settings (id SMALLINT PRIMARY KEY DEFAULT 1, enabled BOOLEAN NOT NULL DEFAULT true, max_items INTEGER NOT NULL DEFAULT 120);
INSERT INTO roster_unify_settings (id) VALUES (1);
CREATE TABLE cec_candidates (id SERIAL PRIMARY KEY, election_id INTEGER, election_type TEXT, region TEXT, sub_region TEXT, village TEXT, name TEXT, name_norm TEXT,
  elected BOOLEAN, cand_no INTEGER, cec_cand_id INTEGER, synced_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE cec_registrations (id SERIAL PRIMARY KEY, election_id INTEGER, election_type TEXT, region TEXT, sub_region TEXT, district TEXT, name TEXT, source_url TEXT);
CREATE TABLE cec_registration_sources (source_url TEXT PRIMARY KEY, superseded_by TEXT);
CREATE TABLE cec_roster_units (url TEXT PRIMARY KEY, election_type TEXT NOT NULL, county TEXT NOT NULL, town TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  row_count INTEGER NOT NULL DEFAULT 0, fetched_at TIMESTAMPTZ);
CREATE TABLE cec_roster_2026 (id BIGSERIAL PRIMARY KEY, election_type TEXT, county TEXT, town TEXT NOT NULL DEFAULT '', district TEXT NOT NULL DEFAULT '', li_code TEXT NOT NULL DEFAULT '',
  name TEXT, name_key TEXT, cand_no INTEGER, party TEXT, birth TEXT, unit_key TEXT, unit_url TEXT);
-- 本支新增觸發器會碰到的其他表
CREATE TABLE roster_checks (id BIGSERIAL PRIMARY KEY, election_id INTEGER NOT NULL, region TEXT NOT NULL, election_type TEXT NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT now(), cec_count INTEGER);
CREATE TABLE roster_reconcile_units (election_id INTEGER NOT NULL, election_type TEXT NOT NULL, county TEXT NOT NULL, town TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL DEFAULT 0,
  both_n INTEGER NOT NULL DEFAULT 0, creatable_n INTEGER NOT NULL DEFAULT 0, ambiguous_n INTEGER NOT NULL DEFAULT 0, extra_n INTEGER NOT NULL DEFAULT 0,
  status_mismatch_n INTEGER NOT NULL DEFAULT 0, needs_agent BOOLEAN NOT NULL DEFAULT false, people JSONB NOT NULL DEFAULT '[]', PRIMARY KEY (election_id, election_type, county, town));
CREATE TABLE roster_check_scope (election_id INTEGER, election_type TEXT, enabled BOOLEAN NOT NULL DEFAULT true, recheck_days INTEGER NOT NULL DEFAULT 30,
  list_announced_on DATE, registration_closed_on DATE, municipal_mayor_list_on DATE, qualification_review_by DATE, ballot_draw_on DATE);
CREATE TABLE election_districts (id SERIAL PRIMARY KEY, election_id INTEGER, election_type TEXT, region TEXT, sub_region TEXT, district_kind TEXT, seats INTEGER);
CREATE TABLE verification_sources (id SERIAL PRIMARY KEY, provides TEXT[], election_types TEXT[], regions TEXT[], election_ids INTEGER[]);
CREATE TABLE regions_dummy (x INTEGER);
CREATE TABLE parties (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE party_aliases (id SERIAL PRIMARY KEY, alias TEXT);
CREATE TABLE cec_results_auto_plan_rows (politician_election_id INTEGER PRIMARY KEY);
CREATE TABLE task_checks (id SERIAL PRIMARY KEY, task_id TEXT, outcome TEXT);
CREATE TABLE politician_pair_resolutions (pair_key TEXT, resolution TEXT);
CREATE TABLE locations (name TEXT);
CREATE TABLE electoral_district_areas (region TEXT, township TEXT);
CREATE TABLE admin_divisions (level TEXT, county TEXT);
CREATE TABLE task_dispatches (task_id TEXT PRIMARY KEY);

-- 名冊差異與官方名冊差異：先放空殼（讓第 2 期 PR-1 的函式建得起來），本支遷移會把它們換成帶 p_keys 的新簽名
CREATE FUNCTION roster_diff_findings() RETURNS TABLE (${FIND_COLS}) LANGUAGE sql STABLE AS $f$ SELECT NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TEXT, NULL::UUID, NULL::INTEGER, NULL::TEXT, NULL::JSONB, NULL::JSONB, NULL::TEXT, NULL::TEXT WHERE false $f$;
CREATE FUNCTION cec_roster_diff() RETURNS TABLE (${DIFF_COLS}) LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER, NULL::INTEGER, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INTEGER, NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER, NULL::UUID, NULL::TEXT WHERE false $f$;
-- 結果類與縣市不符的外部函式（回放表）；election_result_cec_matches 記下每次被呼叫時的 id 數（成本證據）
CREATE TABLE _cm (politician_election_id INTEGER, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, village TEXT, district TEXT, politician_id UUID, name TEXT,
  current_result TEXT, cec_elected BOOLEAN, cec_hits INTEGER, cec_sub_region TEXT, cec_cand_id INTEGER, cec_theme_id TEXT);
CREATE TABLE _cm_calls (n INTEGER);
CREATE FUNCTION election_result_cec_matches(p_ids INTEGER[]) RETURNS TABLE (politician_election_id INTEGER, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, village TEXT,
  district TEXT, politician_id UUID, name TEXT, current_result TEXT, cec_elected BOOLEAN, cec_hits INTEGER, cec_sub_region TEXT, cec_cand_id INTEGER, cec_theme_id TEXT)
  LANGUAGE plpgsql VOLATILE AS $f$ BEGIN INSERT INTO _cm_calls VALUES (cardinality(p_ids)); RETURN QUERY SELECT c.* FROM _cm c WHERE c.politician_election_id = ANY (p_ids); END $f$;
CREATE TABLE _rm (election_id INTEGER, official_county TEXT, politician_id UUID, politician_election_id INTEGER, name TEXT, cur_county TEXT, current_region_id INTEGER, proposed_region_id INTEGER, source_url TEXT);
CREATE FUNCTION roster_region_mismatch_findings() RETURNS TABLE (election_id INTEGER, official_county TEXT, politician_id UUID, politician_election_id INTEGER, name TEXT, cur_county TEXT,
  current_region_id INTEGER, proposed_region_id INTEGER, source_url TEXT) LANGUAGE sql STABLE AS $f$ SELECT * FROM _rm $f$;

-- 小函式（各有自己的測試，這裡取最簡單的等價物）
CREATE FUNCTION roster_name_key(TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $f$ SELECT replace(replace($1, '臺', '台'), ' ', '') $f$;
CREATE FUNCTION cec_name_key(TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $f$ SELECT replace(replace($1, '臺', '台'), ' ', '') $f$;
CREATE FUNCTION cec_name_fuzzy_eq(TEXT, TEXT, TEXT, TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $f$ SELECT $1 = $2 $f$;
CREATE FUNCTION cec_name_fuzzy_eq(TEXT, TEXT, INTEGER, INTEGER) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $f$ SELECT $1 = $2 $f$;
CREATE FUNCTION cec_roster_norm_unit(TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $f$ SELECT $1 $f$;
CREATE FUNCTION ballot_number_unit(p_et TEXT, p_county TEXT, p_district TEXT, p_town TEXT, p_village TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN p_county IS NULL THEN NULL
              WHEN p_et = '縣市長' THEN replace(p_county, '臺', '台')
              WHEN p_et = '縣市議員' THEN replace(p_county, '臺', '台') || '|' || COALESCE(p_district, '')
              WHEN p_et = '村里長' THEN replace(p_county, '臺', '台') || '|' || COALESCE(p_town, '') || '|' || COALESCE(p_village, '')
              ELSE replace(p_county, '臺', '台') || '|' || COALESCE(p_town, '') END $f$;
CREATE FUNCTION ballot_number_dups(p_members JSONB) RETURNS INTEGER[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT COALESCE(array_agg(x.n ORDER BY x.n), ARRAY[]::INTEGER[]) FROM (SELECT (m->>'cand_no')::INTEGER AS n FROM jsonb_array_elements(p_members) m
    WHERE m->>'cand_no' IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x $f$;
CREATE FUNCTION ballot_number_missing(p_registered INTEGER, p_numbered INTEGER, p_numbers INTEGER[]) RETURNS INTEGER[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT COALESCE(array_agg(g ORDER BY g), ARRAY[]::INTEGER[]) FROM generate_series(1, p_registered) g WHERE g <> ALL (p_numbers) $f$;
CREATE FUNCTION candidacy_list_published(INTEGER, TEXT, DATE) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION candidacy_protocol_status(TEXT, BOOLEAN) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT CASE WHEN $2 THEN 'qualified' ELSE 'registered' END $f$;
CREATE FUNCTION cec_vote2026_cand_url(TEXT, TEXT, TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT 'https://cec.example/' || $1 || '/' || $2 || COALESCE('/' || $3, '') $f$;
CREATE FUNCTION roster_attempt_cooldown_days() RETURNS INTEGER LANGUAGE sql STABLE AS $f$ SELECT 7 $f$;
CREATE FUNCTION roster_reconcile_text(JSONB) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT '' $f$;
CREATE FUNCTION roster_schedule_text(DATE, DATE, DATE, DATE, DATE) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT '' $f$;
CREATE FUNCTION election_year_text(INTEGER) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT $1::TEXT $f$;
CREATE FUNCTION roster_reconcile_unit(p_eid INTEGER, p_et TEXT, p_county TEXT, p_town TEXT DEFAULT NULL) RETURNS JSONB LANGUAGE sql STABLE AS $f$
  SELECT (SELECT jsonb_build_object('needs_agent', u.needs_agent, 'total', u.total) FROM roster_reconcile_units u
           WHERE u.election_id = p_eid AND u.election_type = p_et AND u.county = p_county AND u.town = COALESCE(p_town, '') LIMIT 1) $f$;
${unitsView}

-- 真定義：名冊差異彙總用的小函式、現行函式（從遷移原文抽出）
${fnText(unifySql, "roster_unify_town")}
${fnText(unifySql, "roster_unify_extra")}
${fnText(unifySql, "roster_unify_kinds_text")}
${fnText(unifySql, "roster_unify_text")}
${fnText(gapSql, "roster_gap_text")}
${unitFindingsSrc}
${gapUnitsSrc}
${ballotSrc}
${cecGapSrc}
${villagesSrc}
${seatsSrc}
-- 舊版真定義改名放著（B 的比對基準）
${diffSrc.replace("CREATE OR REPLACE FUNCTION cec_roster_diff()", "CREATE OR REPLACE FUNCTION old_cec_roster_diff()")}
${findingsSrc.replace("CREATE OR REPLACE FUNCTION roster_diff_findings()", "CREATE OR REPLACE FUNCTION old_roster_diff_findings()")}
-- raw：roster_check 用真的，其餘任務型別回放
CREATE FUNCTION contribution_auto_tasks_raw() ${RET} AS $function$
  WITH
${rawCtes}${rawRosterSel}
  UNION ALL
  SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = 'raw'
$function$;
`;

type Opts = { dataBeforeMig?: boolean; mig?: boolean };
async function freshDb(o: Opts = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV_BASE);
  await db.exec(pr1);
  await db.exec(pr2);
  // 第 1 期遷移要建三支舊臂的按鍵版（本體引用 PGlite 沒有的函式），本測試不驗它們的本體
  await db.exec("SET check_function_bodies = off");
  await db.exec(ph1a);
  await db.exec("RESET check_function_bodies");
  await db.exec(ph2a);
  if (o.dataBeforeMig) await db.exec(DATASET);
  if (o.mig !== false) await db.exec(mig);
  return db;
}

const one = async <T = unknown>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0]?.v;
const rows = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/**
 * 假資料（CURRENT_DATE 之後的 2026-11-28 當「還沒投票」；2022 已投票）。
 *  roster_cec_gap：2022 新北市縣市長（我們 0 筆）、2022 台北市縣市議員（八位只對上一位，其中一位當選＝別支臂派）、2022 花蓮縣花蓮市村里長（我們 0 筆）、
 *                   2022 花蓮縣縣市長（對上了，不派）、2022 宜蘭縣縣市長（近期清查過，不派）
 *  roster_villages：2026 清查範圍的村里長 × 三個鄉鎮
 *  raw:roster_check：2026 三個職位 × 三個縣市（臺北市縣市長有對帳資料、不用派代理）
 *  district_seats：2026／2022 縣市議員各縣市、2026 鄉鎮市民代表（由鄉鎮市長選舉區推出）
 *  cec_roster_diff：台北市縣市長（缺一位）、新北市縣市長（對不上＋同號兩筆）、花蓮市村里長（對上）、台北市縣市議員（缺一位）
 *  roster_diff_findings：五支以參選紀錄為單位的臂、當選名單缺人、結果類兩筆（不同單位）、縣市長縣市不符
 */
const DATASET = `
INSERT INTO elections VALUES (2022, '2022-11-26', ARRAY['縣市長','縣市議員','村里長']),
  (2026, '2099-11-28', ARRAY['縣市長','縣市議員','鄉鎮市長','鄉鎮市民代表','村里長']);
INSERT INTO regions VALUES (1, '臺北市', NULL, NULL, NULL), (2, '臺北市', '第01選舉區', NULL, NULL), (3, '花蓮縣', '花蓮市', '國盛里', 'A001'),
  (4, '新北市', NULL, NULL, NULL), (5, '花蓮縣', NULL, NULL, NULL), (6, '宜蘭縣', NULL, NULL, NULL), (7, '臺北市', '第02選舉區', NULL, NULL);
INSERT INTO locations VALUES ('臺北市'), ('新北市'), ('花蓮縣');
INSERT INTO admin_divisions VALUES ('county', '臺北市'), ('county', '花蓮縣');
INSERT INTO electoral_district_areas VALUES ('臺北市', '文山區'), ('花蓮縣', '花蓮市'), ('花蓮縣', '吉安鄉');
INSERT INTO roster_check_scope (election_id, election_type, list_announced_on, registration_closed_on) VALUES
  (2026, '縣市長', '2026-11-17', '2026-09-04'), (2026, '縣市議員', '2026-11-17', '2026-09-04'), (2026, '村里長', '2026-11-17', '2026-09-04');
INSERT INTO roster_reconcile_units (election_id, election_type, county, town, total, needs_agent) VALUES (2026, '縣市長', '臺北市', '', 3, false);

-- 人物與參選紀錄
INSERT INTO politicians (id, name, region) VALUES ('${U(1)}', 'P甲', '臺北市'), ('${U(2)}', 'P乙', '新北市'), ('${U(3)}', '里長1', '花蓮縣'),
  ('${U(4)}', 'Y甲', '花蓮縣'), ('${U(5)}', 'c1', '臺北市'), ('${U(6)}', 'c2', '臺北市'), ('${U(7)}', 'P丁', '新北市'), ('${U(8)}', 'M甲', '臺北市'), ('${U(9)}', 'Z甲', '宜蘭縣'),
  ('${U(10)}', '多餘人', '臺北市');
-- 參選紀錄沒指到選舉區列（region_id 空），鄉鎮只記在人物上：結果類的單位要用人物的縣市與鄉鎮（election_result_cec_matches 的回退）
INSERT INTO politicians (id, name, region, sub_region) VALUES ('${U(11)}', '無選區人', '花蓮縣', '花蓮市');
INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id, cand_no) VALUES (1011, '${U(11)}', 2022, '鄉鎮市民代表', 'elected', NULL, NULL);
INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id, cand_no) VALUES
  (1001, '${U(1)}', 2026, '縣市長', 'filed', 1, 1), (1002, '${U(2)}', 2026, '縣市長', 'filed', 4, 1), (1003, '${U(3)}', 2026, '村里長', 'filed', 3, 1),
  (1004, '${U(4)}', 2022, '縣市長', 'elected', 5, NULL), (1005, '${U(5)}', 2022, '縣市議員', 'elected', 2, NULL), (1006, '${U(6)}', 2022, '縣市議員', 'not_elected', 7, NULL),
  (1007, '${U(7)}', 2026, '縣市長', 'filed', 4, 1), (1008, '${U(8)}', 2026, '縣市議員', 'filed', 2, 1), (1009, '${U(9)}', 2022, '縣市長', 'not_elected', 6, NULL),
  (1010, '${U(10)}', 2026, '縣市長', 'filed', 1, 9);

-- roster_cec_gap：中選會 2022 名單
INSERT INTO cec_candidates (election_id, election_type, region, sub_region, village, name, name_norm, elected, cand_no, cec_cand_id) VALUES
  (2022, '縣市長', '新北市', NULL, NULL, 'X1', 'X1', true, 1, 11), (2022, '縣市長', '新北市', NULL, NULL, 'X2', 'X2', false, 2, 12),
  (2022, '縣市議員', '臺北市', '第01選舉區', NULL, 'c1', 'c1', false, 1, 21), (2022, '縣市議員', '臺北市', '第01選舉區', NULL, 'c2', 'c2', true, 2, 22),
  (2022, '縣市議員', '臺北市', '第01選舉區', NULL, 'c3', 'c3', false, 3, 23), (2022, '縣市議員', '臺北市', '第01選舉區', NULL, 'c4', 'c4', false, 4, 24),
  (2022, '縣市議員', '臺北市', '第01選舉區', NULL, 'c5', 'c5', false, 5, 25), (2022, '縣市議員', '臺北市', '第01選舉區', NULL, 'c6', 'c6', false, 6, 26),
  (2022, '縣市議員', '臺北市', '第01選舉區', NULL, 'c7', 'c7', false, 7, 27), (2022, '縣市議員', '臺北市', '第01選舉區', NULL, 'c8', 'c8', false, 8, 28),
  (2022, '村里長', '花蓮縣', '花蓮市', '國盛里', 'V1', 'V1', true, 1, 31), (2022, '村里長', '花蓮縣', '花蓮市', '國盛里', 'V2', 'V2', false, 2, 32),
  (2022, '縣市長', '花蓮縣', NULL, NULL, 'Y甲', 'Y甲', true, 1, 41), (2022, '縣市長', '宜蘭縣', NULL, NULL, 'Z1', 'Z1', true, 1, 51);
INSERT INTO roster_checks (election_id, region, election_type, checked_at, cec_count) VALUES (2022, '宜蘭縣', '縣市長', now() - INTERVAL '1 day', 1);

-- district_seats
INSERT INTO election_districts (election_id, election_type, region, sub_region, district_kind, seats) VALUES
  (2026, '縣市議員', '臺北市', '第01選舉區', NULL, 13), (2026, '縣市議員', '臺北市', '第02選舉區', NULL, NULL), (2026, '鄉鎮市長', '花蓮縣', '花蓮市', NULL, 1);
INSERT INTO verification_sources (provides, election_types, regions, election_ids) VALUES (ARRAY['seats'], ARRAY['縣市議員'], ARRAY['台北市'], ARRAY[2026]);
INSERT INTO cec_registration_sources VALUES ('http://reg1', NULL);
INSERT INTO cec_registrations (election_id, election_type, region, sub_region, district, name, source_url) VALUES
  (2026, '縣市議員', '臺北市', NULL, '第01選舉區', 'a', 'http://reg1'), (2026, '縣市議員', '臺北市', NULL, '第02選舉區', 'b', 'http://reg1'),
  (2026, '縣市議員', '臺北市', NULL, '第03選舉區', 'c', 'http://reg1');

-- cec_roster_diff：官方名冊鏡像
INSERT INTO cec_roster_units (url, election_type, county, town, status, row_count, fetched_at) VALUES
  ('u1', '縣市長', '臺北市', '', 'ok', 2, now()), ('u2', '縣市長', '新北市', '', 'ok', 1, now()), ('u3', '村里長', '花蓮縣', '花蓮市', 'ok', 1, now()),
  ('u4', '縣市議員', '臺北市', '', 'ok', 2, now());
INSERT INTO cec_roster_2026 (election_type, county, town, li_code, name, name_key, cand_no, unit_key, unit_url) VALUES
  ('縣市長', '臺北市', '', '', 'P甲', 'P甲', 1, '台北市', 'u1'), ('縣市長', '臺北市', '', '', '王某', '王某', 2, '台北市', 'u1'),
  ('縣市長', '新北市', '', '', '乙名冊', '乙名冊', 1, '台北市'::TEXT || '', 'u2'),
  ('村里長', '花蓮縣', '花蓮市', '001', '里長1', '里長1', 1, '花蓮縣|花蓮市', 'u3'), ('村里長', '花蓮縣', '花蓮市', '001', '里長2', '里長2', 2, '花蓮縣|花蓮市', 'u3'),
  ('縣市議員', '臺北市', '', '', 'M甲', 'M甲', 1, '台北市|第01選舉區', 'u4'), ('縣市議員', '臺北市', '', '', 'M乙', 'M乙', 2, '台北市|第01選舉區', 'u4');
UPDATE cec_roster_2026 SET unit_key = '新北市' WHERE election_type = '縣市長' AND county = '新北市';

-- roster_diff_findings：五支臂（任務編號最後一段是參選紀錄 id）、當選名單缺人、結果類（election_results）、縣市不符
INSERT INTO fake_rows VALUES
  ('party_gap', 'auto:party_gap:1001', 'party_gap', '{"cec":{"party":"甲黨","cand_no":1}}', 'x', ARRAY['h'], 1, '臺北市'),
  ('party_roster', 'auto:party_roster:1002', 'party_roster', '{"rosters":["http://r"]}', 'x', ARRAY['h'], 1, '新北市'),
  ('township_gap', 'auto:township_gap:1003', 'township_gap', '{}', 'x', ARRAY['h'], 1, '花蓮縣'),
  ('region_gap', 'auto:region_gap:1002', 'region_gap', '{"missing":["sub_region"]}', 'x', ARRAY['h'], 1, '新北市'),
  ('owner_mismatch', 'auto:candidacy_owner_mismatch:1001', 'candidacy_owner_mismatch', '{"signals":[]}', 'x', ARRAY['h'], 1, '臺北市'),
  ('elected_missing', 'auto:elected_missing:1', 'elected_missing', '{"election_id":2022,"election_type":"縣市長","region":"臺北市","name":"某當選人"}', 'x', ARRAY['h'], 1, '臺北市'),
  ('election_results', 'auto:election_results_missing:2022:x', 'election_results_missing', '{"politician_election_ids":[1004]}', 'x', ARRAY['h'], 1, '花蓮縣'),
  ('election_results', 'auto:election_result_unmatched:1005', 'election_result_unmatched', '{}', 'x', ARRAY['h'], 1, '臺北市'),
  ('election_results', 'auto:election_result_unmatched:1011', 'election_result_unmatched', '{}', 'x', ARRAY['h'], 1, '花蓮縣');
INSERT INTO _cm VALUES
  (1004, 2022, '縣市長', '花蓮縣', '', NULL, NULL, '${U(4)}', 'Y甲', 'elected', true, 1, NULL, 41, NULL),
  (1005, 2022, '縣市議員', '臺北市', '', NULL, '第01選舉區', '${U(5)}', 'c1', 'elected', false, 1, NULL, 21, NULL),
  (1011, 2022, '鄉鎮市民代表', '花蓮縣', '花蓮市', NULL, NULL, '${U(11)}', '無選區人', 'elected', false, 1, NULL, 61, NULL);
INSERT INTO _rm VALUES (2026, '新北市', '${U(2)}', 1002, 'P乙', '臺北市', 1, 4, 'http://m');
`;

const gapDiff = async (db: PGlite, arm: string): Promise<[number, number]> => {
  const full = `SELECT t.task_id AS gap_key, to_jsonb(t) - 'task_id' - 'arm' - 'opened_by' AS payload FROM ${FULL_FN[arm]} t`;
  const tab = `SELECT g.gap_key, g.payload FROM dispatch_gaps g WHERE g.arm = '${arm}' AND g.closed_at IS NULL`;
  const a = await one<number>(db, `SELECT count(*)::int AS v FROM (${full} EXCEPT ${tab}) x`);
  const b = await one<number>(db, `SELECT count(*)::int AS v FROM (${tab} EXCEPT ${full}) x`);
  return [a as number, b as number];
};
async function drainAll(db: PGlite) {
  for (let i = 0; i < 8; i++) {
    await db.exec("SELECT dispatch_gap_drain(500)");
    if ((await one<number>(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE processed_at IS NULL AND attempts < 5")) === 0) return;
  }
}
const ARMS7 = [...NEWARMS, "roster_unit_findings", "roster_gap_units", "ballot_numbers"] as const;
async function assertConsistent(db: PGlite, why: string, arms: readonly string[] = ARMS7) {
  for (const arm of arms) assertEquals(await gapDiff(db, arm), [0, 0], `${why}：${arm} 常駐表與整臂結果對不上`);
}
const pending = async (db: PGlite) =>
  (await rows(db, "SELECT arm || '|' || scope_key AS k FROM dispatch_gap_events WHERE processed_at IS NULL ORDER BY 1")).map((r) => r.k as string);
const clearEvents = (db: PGlite) => db.exec("DELETE FROM dispatch_gap_events");
const gapCount = async (db: PGlite, arm: string) => (await one<number>(db, `SELECT count(*)::int AS v FROM dispatch_gaps WHERE arm = '${arm}' AND closed_at IS NULL`)) as number;
const only = (xs: string[], arm: string) => xs.filter((x) => x.startsWith(arm + "|"));
const S = (xs: string[]) => [...xs].sort();

// ───────────────────────── A 最新定義與文字層 ─────────────────────────
Deno.test("A1 抽出來的現行定義就是最後一版（後面沒有遷移再改它們）；cec_roster_diff 只被 20261109210000 做過一處替換", async () => {
  const files = (await migrationNames()).filter((f) => f < MIG_NAME);
  const latest = async (re: RegExp) => {
    let last = "";
    for (const f of files) if (re.test(await read(f))) last = f;
    return last;
  };
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION contribution_auto_tasks_roster_cec_gap\(\)/), CEC_GAP_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION contribution_auto_tasks_roster_villages\(\)/), VILLAGES_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION contribution_auto_tasks_district_seats\(\)/), SEATS_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw\(\)/), RAW_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION roster_diff_findings\(\)/), FINDINGS_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION cec_roster_diff\(\)/), DIFF_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION roster_unit_findings\(\)/), UNIFY_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION roster_gap_units\(\)/), GAP_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers\(\)/), BALLOT_FILE);
  // cec_roster_diff 在 20261031160000 之後只有 20261109210000 動過（pg_get_functiondef 加 dup 排除），別的遷移碰它要重看鍵過濾
  const touching: string[] = [];
  for (const f of files) if (f > DIFF_FILE && /cec_roster_diff\(\)'::regprocedure|CREATE OR REPLACE FUNCTION cec_roster_diff\(|DROP FUNCTION[^;]*cec_roster_diff/.test(await read(f))) touching.push(f);
  assertEquals(touching, [DIFF_PATCH_FILE]);
  // raw 的 roster_check 段在 raw 函式裡剛好一處
  assertEquals(rawSrc.split("SELECT 'auto:roster_check:'").length - 1, 1);
});

const bodyLines = (fn: string) =>
  fn.split("\n").slice(1).map((l) => l.trim().replace(/^WITH /, "")).filter((l) => l && !l.startsWith("--") && !/^(AS \$|LANGUAGE|STABLE|RETURNS|\$\$|\$fn\$|\$function\$|CREATE OR REPLACE)/.test(l));
const isKeyLine = (l: string) => /p_keys/.test(l) && /dispatch_gap_(roster|ballot|seats)_unit_key/.test(l);

Deno.test("A2 按鍵版本體與整表版只差鍵過濾（逐行：整表版每一行都在按鍵版裡，按鍵版多出的行都是單位鍵過濾）", () => {
  const keyed = (name: string) => fnText(mig, name);
  const cases: Array<[string, string, string, number]> = [
    ["roster_cec_gap", cecGapSrc, keyed("dispatch_gap_recompute_roster_cec_gap"), 1],
    ["roster_villages", villagesSrc, keyed("dispatch_gap_recompute_roster_villages"), 1],
    ["district_seats", seatsSrc, keyed("dispatch_gap_recompute_district_seats"), 1],
  ];
  for (const [arm, full, key, nExtra] of cases) {
    const fl = bodyLines(full);
    const kl = bodyLines(key);
    const kset = new Set(kl);
    const fset = new Set(fl);
    assertEquals(fl.filter((l) => !kset.has(l)), [], `${arm}：整表版有、按鍵版沒有的行（不能少任何邏輯）`);
    const extra = kl.filter((l) => !fset.has(l));
    for (const l of extra) assert(isKeyLine(l), `${arm}：按鍵版多出來的行必須是單位鍵過濾：${l}`);
    assertEquals(extra.length, nExtra, `${arm}：多出的鍵過濾行數`);
  }
  // raw：整表版＝ours／filed_out 兩個 CTE＋roster_check 的 SELECT（從 raw 原文切出來），按鍵版多一行
  {
    const fl = bodyLines("X\n" + rawCtes + rawRosterSel);
    const kl = bodyLines(keyed("dispatch_gap_recompute_raw_roster_check"));
    const kset = new Set(kl);
    const fset = new Set(fl);
    assertEquals(fl.filter((l) => !kset.has(l)), [], "raw：整表版有、按鍵版沒有的行");
    const extra = kl.filter((l) => !fset.has(l));
    for (const l of extra) assert(isKeyLine(l), `raw：多出來的行必須是單位鍵過濾：${l}`);
    assertEquals(extra.length, 1);
  }
  // PR-1 的兩支：把鍵傳進底層（呼叫行差一個參數）＋ roster_gap_units 的 cn 多一行鍵過濾；其餘與整表版相同
  const norm = (l: string) => l.replace("roster_diff_findings(p_keys)", "roster_diff_findings()").replace("cec_roster_diff(p_keys)", "cec_roster_diff()");
  for (const [arm, full, key, nExtra] of [
    ["roster_unit_findings", unitFindingsSrc, keyed("dispatch_gap_recompute_roster_unit_findings"), 1],
    ["roster_gap_units", gapUnitsSrc, keyed("dispatch_gap_recompute_roster_gap_units"), 2],
  ] as Array<[string, string, string, number]>) {
    const fl = bodyLines(full);
    const kl = bodyLines(key).map(norm);
    const kset = new Set(kl);
    const fset = new Set(fl);
    assertEquals(fl.filter((l) => !kset.has(l)), [], `${arm}：整表版有、按鍵版沒有的行`);
    const extra = kl.filter((l) => !fset.has(l));
    for (const l of extra) assert(isKeyLine(l), `${arm}：多出來的行必須是單位鍵過濾：${l}`);
    assertEquals(extra.length, nExtra);
    assert(bodyLines(key).some((l) => /(roster_diff_findings|cec_roster_diff)\(p_keys\)/.test(l)), `${arm}：沒有把鍵傳下去`);
  }
});

Deno.test("A3 新簽名的 cec_roster_diff／roster_diff_findings 本體與舊版只差鍵過濾（逐行）", () => {
  const cases: Array<[string, string, string, number]> = [
    ["cec_roster_diff", diffSrc, fnText(mig, "cec_roster_diff"), 2],
    ["roster_diff_findings", findingsSrc, fnText(mig, "roster_diff_findings"), 9],
  ];
  for (const [name, oldFn, newFn, nExtra] of cases) {
    // 簽名行與 RETURNS TABLE 的欄位名單兩邊同一份（換簽名，欄位不能變）
    const ol = bodyLines(oldFn);
    const nl = bodyLines(newFn);
    const nset = new Set(nl);
    const oset = new Set(ol);
    assertEquals(ol.filter((l) => !nset.has(l)), [], `${name}：舊版有、新版沒有的行（不能少任何邏輯）`);
    const extra = nl.filter((l) => !oset.has(l));
    // 鍵過濾：帶 p_keys 的行，加上 er_ids 那段超集過濾的 EXISTS 子查詢（它自己的幾行 FROM／JOIN／WHERE）
    for (const l of extra) assert(/p_keys|politician_elections pk|JOIN politicians pp|LEFT JOIN regions rk|WHERE pk\.id|dispatch_gap_roster_keys/.test(l), `${name}：新版多出來的行必須是鍵過濾：${l}`);
    assertEquals(extra.length, nExtra, `${name}：多出的鍵過濾行數`);
    assert(newFn.includes(`${name}(p_keys TEXT[] DEFAULT NULL)`));
  }
  assert(fnText(mig, "cec_roster_diff").includes("SET enable_nestloop = off"), "cec_roster_diff 的 SET enable_nestloop = off 不能掉");
});

// ───────────────────────── B 按鍵重算 = 整表限定同鍵；底層帶 p_keys ─────────────────────────
Deno.test("B1 四支新臂（加 PR-1 兩支）按鍵重算與整表函式限定同鍵的結果雙向 EXCEPT 為 0；幽靈鍵與空陣列沒有列", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  const counts: Record<string, number> = {};
  for (const arm of [...NEWARMS, "roster_unit_findings", "roster_gap_units"]) {
    const keysOf = (await rows(db, `SELECT DISTINCT dispatch_gap_scope_key('${arm}', task_id) AS k FROM ${FULL_FN[arm]} ORDER BY 1`)).map((r) => r.k as string);
    assert(keysOf.length >= 2, `${arm} 的假資料至少要有兩個單位，實際 ${keysOf.length}：${JSON.stringify(keysOf)}`);
    counts[arm] = keysOf.length;
    const fnName = KEYED_FN[arm];
    const ghost = arm === "district_seats" ? "seats:2026:不存在市:縣市議員" : "unit:2026:不存在市:縣市長";
    const subsets: string[][] = [keysOf, [keysOf[0]], keysOf.slice(0, Math.max(1, Math.floor(keysOf.length / 2))), [...keysOf, ghost]];
    for (const ks of subsets) {
      const arr = `ARRAY[${ks.map((k) => `'${k}'`).join(",")}]::TEXT[]`;
      const keyedQ = `SELECT * FROM ${fnName}(${arr})`;
      const fullQ = `SELECT * FROM ${FULL_FN[arm]} t WHERE dispatch_gap_scope_key('${arm}', t.task_id) = ANY (${arr})`;
      const strip = (q: string) => `SELECT task_id, to_jsonb(x) - 'task_id' AS j FROM (${q}) x`;
      assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${strip(keyedQ)} EXCEPT ${strip(fullQ)}) y`), 0, `${arm} 按鍵版多出列 keys=${ks.length}`);
      assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${strip(fullQ)} EXCEPT ${strip(keyedQ)}) y`), 0, `${arm} 按鍵版缺列 keys=${ks.length}`);
    }
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM ${fnName}(ARRAY['${ghost}'])`), 0);
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM ${fnName}(ARRAY[]::TEXT[])`), 0);
  }
  console.log("[B1 各臂的單位數]", JSON.stringify(counts));
  assertEquals(counts.roster_cec_gap, 3, "新北市縣市長、台北市縣市議員、花蓮市村里長");
  assertEquals(counts.roster_villages, 3);
  assertEquals(counts["raw:roster_check"], 8, "三職位 × 三縣市，臺北市縣市長有對帳資料不派");
  assert(counts.district_seats >= 4);
  await db.close();
});

Deno.test("B2 cec_roster_diff(p_keys)：NULL、全部鍵、部分鍵與舊版真定義比（舊版輸出過濾到那些單位），雙向 EXCEPT 為 0；幽靈鍵沒有列", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  const oldQ = "SELECT * FROM old_cec_roster_diff()";
  const n = await one<number>(db, `SELECT count(*)::int AS v FROM (${oldQ}) x`);
  const kinds = (await rows(db, `SELECT DISTINCT kind AS k FROM (${oldQ}) x`)).map((r) => r.k as string).sort();
  assertEquals(kinds, ["dup", "extra", "missing"], "假資料要涵蓋三種差異");
  assert((n as number) >= 4, `舊版輸出太少 ${n}`);
  const keyExpr = (a: string) => `dispatch_gap_roster_unit_key(2026, ${a}.county || ${a}.town, ${a}.election_type)`;
  const allKeys = (await rows(db, `SELECT DISTINCT ${keyExpr("x")} AS k FROM (${oldQ}) x ORDER BY 1`)).map((r) => r.k as string);
  assert(allKeys.length >= 4, `單位數 ${allKeys.length}`);
  const cmp = async (why: string, arr: string | null) => {
    const newQ = arr === null ? "SELECT * FROM cec_roster_diff()" : `SELECT * FROM cec_roster_diff(${arr})`;
    const oldF = arr === null || arr.startsWith("NULL") ? oldQ : `SELECT * FROM (${oldQ}) x WHERE ${keyExpr("x")} = ANY (${arr})`;
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${newQ} EXCEPT ${oldF}) y`), 0, `${why}：新版多出列`);
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${oldF} EXCEPT ${newQ}) y`), 0, `${why}：新版缺列`);
  };
  await cmp("無參數呼叫（NULL＝整表）", null);
  await cmp("明給 NULL", "NULL::TEXT[]");
  const arr = (ks: string[]) => `ARRAY[${ks.map((k) => `'${k}'`).join(",")}]::TEXT[]`;
  await cmp("全部鍵", arr(allKeys));
  for (const k of allKeys) await cmp(`單一單位 ${k}`, arr([k]));
  await cmp("一半的鍵", arr(allKeys.slice(0, Math.floor(allKeys.length / 2))));
  await cmp("全部鍵加幽靈鍵", arr([...allKeys, "unit:2026:不存在市:縣市長"]));
  assertEquals(await one(db, `SELECT count(*)::int AS v FROM cec_roster_diff(ARRAY['unit:2026:不存在市:縣市長'])`), 0);
  assertEquals(await one(db, `SELECT count(*)::int AS v FROM cec_roster_diff(ARRAY[]::TEXT[])`), 0);
  // 已裁決「不同人」的一對不出 dup（20261109210000 的行為在新版仍在）
  const dup = await rows(db, "SELECT diff_key FROM cec_roster_diff() WHERE kind = 'dup'");
  assertEquals(dup.length, 1);
  const pairKey = String(dup[0].diff_key).replace("dup:", "");
  await db.exec(`INSERT INTO politician_pair_resolutions VALUES ('${pairKey}', 'different')`);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM cec_roster_diff() WHERE kind = 'dup'"), 0);
  await db.close();
});

Deno.test("B3 roster_diff_findings(p_keys)：NULL、全部鍵、部分鍵與舊版真定義比，雙向 EXCEPT 為 0；結果類的 election_result_cec_matches 只算該單位（成本證據）", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  const oldQ = "SELECT * FROM old_roster_diff_findings()";
  const kinds = (await rows(db, `SELECT DISTINCT kind AS k FROM (${oldQ}) x`)).map((r) => r.k as string).sort();
  assertEquals(kinds, ["政黨", "掛錯人", "縣市", "缺人", "結果", "鄉鎮"].sort(), "假資料要涵蓋六種差異");
  const keyExpr = (a: string) => `dispatch_gap_roster_unit_key(${a}.election_id, ${a}.county || ${a}.town, ${a}.election_type)`;
  const allKeys = (await rows(db, `SELECT DISTINCT ${keyExpr("x")} AS k FROM (${oldQ}) x ORDER BY 1`)).map((r) => r.k as string);
  assert(allKeys.length >= 4, `單位數 ${allKeys.length}：${JSON.stringify(allKeys)}`);
  const arr = (ks: string[]) => `ARRAY[${ks.map((k) => `'${k}'`).join(",")}]::TEXT[]`;
  const cmp = async (why: string, a: string | null) => {
    const newQ = a === null ? "SELECT * FROM roster_diff_findings()" : `SELECT * FROM roster_diff_findings(${a})`;
    const oldF = a === null || a.startsWith("NULL") ? oldQ : `SELECT * FROM (${oldQ}) x WHERE ${keyExpr("x")} = ANY (${a})`;
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${newQ} EXCEPT ${oldF}) y`), 0, `${why}：新版多出列`);
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${oldF} EXCEPT ${newQ}) y`), 0, `${why}：新版缺列`);
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${newQ}) y`), await one(db, `SELECT count(*)::int AS v FROM (${oldF}) y`), `${why}：筆數（含重複列）`);
  };
  await cmp("無參數呼叫", null);
  await cmp("明給 NULL", "NULL::TEXT[]");
  await cmp("全部鍵", arr(allKeys));
  for (const k of allKeys) await cmp(`單一單位 ${k}`, arr([k]));
  await cmp("一半的鍵", arr(allKeys.slice(0, Math.floor(allKeys.length / 2))));
  await cmp("全部鍵加幽靈鍵", arr([...allKeys, "unit:2026:不存在市:縣市長"]));
  assertEquals(await one(db, `SELECT count(*)::int AS v FROM roster_diff_findings(ARRAY['unit:2026:不存在市:縣市長'])`), 0);
  assertEquals(await one(db, `SELECT count(*)::int AS v FROM roster_diff_findings(ARRAY[]::TEXT[])`), 0);

  // 成本證據：election_result_cec_matches（整份最貴的一段）整表算兩位，只給一個單位只算一位
  await db.exec("DELETE FROM _cm_calls");
  await db.exec("SELECT count(*) FROM roster_diff_findings()");
  assertEquals((await rows(db, "SELECT n FROM _cm_calls")).map((r) => r.n), [3]);
  // region_id 空、鄉鎮只記在人物上的參選紀錄：帶鍵路徑也要找得到（回退用人物的鄉鎮）
  const fb = await rows(db, `SELECT politician_election_id AS pe FROM roster_diff_findings(ARRAY['unit:2022:花蓮縣花蓮市:鄉鎮市民代表']) WHERE kind = '結果'`);
  assertEquals(fb.map((r) => r.pe), [1011], "鄉鎮來自人物的 sub_region 時，結果類 finding 仍要在帶鍵路徑出現");
  assertEquals(await one(db, `SELECT count(*)::int AS v FROM old_roster_diff_findings() WHERE kind = '結果' AND politician_election_id = 1011 AND town = '花蓮市'`), 1);
  await db.exec("DELETE FROM _cm_calls");
  await db.exec(`SELECT count(*) FROM roster_diff_findings(ARRAY['unit:2022:花蓮縣:縣市長'])`);
  assertEquals((await rows(db, "SELECT n FROM _cm_calls")).map((r) => r.n), [1], "只給花蓮縣縣市長，結果類只該對一位參選紀錄去配中選會名單");
  await db.exec("DELETE FROM _cm_calls");
  await db.exec(`SELECT count(*) FROM roster_diff_findings(ARRAY['unit:2026:台北市:縣市長'])`);
  assertEquals((await rows(db, "SELECT n FROM _cm_calls")).map((r) => r.n), [0], "不含結果類單位的鍵，不用算任何一位");
  await db.close();
});

Deno.test("B4 兩支 PR-1 的整表函式（roster_unit_findings()、roster_gap_units()）在新簽名之下照舊可呼叫，按鍵版全鍵結果與整表一致", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  for (const arm of ["roster_unit_findings", "roster_gap_units"]) {
    const keysOf = (await rows(db, `SELECT DISTINCT dispatch_gap_scope_key('${arm}', task_id) AS k FROM ${FULL_FN[arm]} ORDER BY 1`)).map((r) => r.k as string);
    assert(keysOf.length >= 2, `${arm} 單位數 ${keysOf.length}`);
    const arr = `ARRAY[${keysOf.map((k) => `'${k}'`).join(",")}]::TEXT[]`;
    const strip = (q: string) => `SELECT task_id, to_jsonb(x) - 'task_id' AS j FROM (${q}) x`;
    const keyed = `SELECT * FROM ${KEYED_FN[arm]}(${arr})`;
    const full = `SELECT * FROM ${FULL_FN[arm]}`;
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${strip(keyed)} EXCEPT ${strip(full)}) y`), 0, `${arm} 多`);
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${strip(full)} EXCEPT ${strip(keyed)}) y`), 0, `${arm} 缺`);
  }
  await db.close();
});

// ───────────────────────── C 鍵的組法與入列函式 ─────────────────────────
Deno.test("C1 scope_key：四支新臂的 task_id → 鍵與資料欄位 → 鍵對得上（臺／台）；舊臂的鍵規則沒變；seats 鍵與入列函式", async () => {
  const db = await freshDb();
  const sk = async (arm: string, tid: string) => await one<string>(db, "SELECT dispatch_gap_scope_key($1, $2) AS v", [arm, tid]);
  assertEquals(await sk("raw:roster_check", "auto:roster_check:2026:臺北市:縣市長"), "unit:2026:台北市:縣市長");
  assertEquals(await sk("roster_villages", "auto:roster_check:2026:臺南市臺西區:村里長"), "unit:2026:台南市台西區:村里長");
  assertEquals(await sk("roster_cec_gap", "auto:roster_check:2022:花蓮縣花蓮市:村里長"), "unit:2022:花蓮縣花蓮市:村里長");
  assertEquals(await sk("district_seats", "auto:district_seats_missing:2026:臺北市:縣市議員"), "seats:2026:台北市:縣市議員");
  assertEquals(await sk("district_seats", "auto:district_seats_missing:2026:花蓮縣:鄉鎮市民代表"), "seats:2026:花蓮縣:鄉鎮市民代表");
  assertEquals(await sk("district_seats", "auto:x:y"), "auto:x:y");
  assertEquals(await sk("roster_unit_findings", "auto:roster_check:2026:臺北市:縣市長"), "unit:2026:台北市:縣市長");
  assertEquals(await sk("ballot_numbers", "auto:candidacy_source_missing:cand_no:2026:縣市議員:臺北市:p3"), "ballot:2026:縣市議員:台北市:");
  assertEquals(await sk("legacy", "auto:legacy_audit:abc"), "policy:abc");
  assertEquals(await sk("issue_too_broad", "auto:issue_too_broad:2026:台北市:交通"), "issue:2026:台北市:交通");
  assertEquals(await one(db, "SELECT dispatch_gap_seats_unit_key(2026, '縣市議員', '臺北市') AS v"), "seats:2026:台北市:縣市議員");
  assertEquals(await one(db, "SELECT dispatch_gap_seats_keys(2026, '縣市議員', '臺北市') AS v"), ["seats:2026:台北市:縣市議員"]);
  assertEquals(await one(db, "SELECT dispatch_gap_seats_keys(2026, '鄉鎮市長', '花蓮縣') AS v"), ["seats:2026:花蓮縣:鄉鎮市民代表", "seats:2026:花蓮縣:鄉鎮市長"]);
  assertEquals(await one(db, "SELECT dispatch_gap_seats_keys(2026, '直轄市山地原住民區長', '臺北市') AS v"), ["seats:2026:台北市:直轄市山地原住民區民代表", "seats:2026:台北市:直轄市山地原住民區長"]);
  await db.close();
});

Deno.test("C2 每個實際產生的 task_id 的鍵，都落在「該單位資料欄位可能組出的鍵」之內（事件不會漏）：roster_cec_gap、raw、villages 與 seats", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  // 名冊族三支：用候選人名單與參選紀錄各單位算出的可能鍵，涵蓋實際缺口的鍵
  const possible = new Set<string>();
  for (const r of await rows(db, `SELECT pe.election_id, pe.election_type, COALESCE(rg.region, p.region) AS county, rg.sub_region AS sub
                                    FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id LEFT JOIN regions rg ON rg.id = pe.region_id`)) {
    for (const k of (await one<string[]>(db, "SELECT dispatch_gap_roster_keys($1, $2, $3, $4) AS v", [r.election_id, r.election_type, r.county, r.sub]))!) possible.add(k);
    for (const k of (await one<string[]>(db, "SELECT dispatch_gap_roster_keys($1, $2, $3, $4) AS v", [r.election_id, r.election_type, r.county, null]))!) possible.add(k);
  }
  for (const r of await rows(db, "SELECT DISTINCT election_id, election_type, region, sub_region FROM cec_candidates")) {
    for (const k of (await one<string[]>(db, "SELECT dispatch_gap_roster_keys($1, $2, $3, $4) AS v", [r.election_id, r.election_type, r.region, r.sub_region]))!) possible.add(k);
  }
  for (const r of await rows(db, `SELECT DISTINCT dispatch_gap_scope_key('roster_cec_gap', task_id) AS k FROM ${FULL_FN.roster_cec_gap}`)) {
    assert(possible.has(r.k as string), `roster_cec_gap 缺口的鍵 ${r.k} 不在資料欄位可能組出的鍵裡（事件會漏）`);
  }
  // 村里長逐鄉鎮清查：每個鄉鎮（electoral_district_areas）都出一件，沒有參選紀錄的鄉鎮不靠參選紀錄事件（它的來源是鄉鎮清單，另有觸發器）；有參選紀錄的鄉鎮必須組得出
  for (const r of await rows(db, `SELECT DISTINCT dispatch_gap_scope_key('roster_villages', task_id) AS k, (target->>'ours_count')::int AS n FROM ${FULL_FN.roster_villages}`)) {
    if ((r.n as number) > 0) assert(possible.has(r.k as string), `roster_villages 缺口的鍵 ${r.k} 不在資料欄位可能組出的鍵裡（事件會漏）`);
  }
  assert((await rows(db, `SELECT 1 FROM ${FULL_FN.roster_villages} WHERE (target->>'ours_count')::int > 0`)).length >= 1, "假資料要有一個有參選紀錄的鄉鎮");
  // seats：每個缺口的鍵，要能由 election_districts 的某一列（或縣市議員的縣市清單）組出來
  const seatKeys = new Set<string>();
  for (const r of await rows(db, "SELECT DISTINCT election_id, election_type, region FROM election_districts")) {
    for (const k of (await one<string[]>(db, "SELECT dispatch_gap_seats_keys($1, $2, $3) AS v", [r.election_id, r.election_type, r.region]))!) seatKeys.add(k);
  }
  for (const r of await rows(db, "SELECT DISTINCT dispatch_gap_scope_key('district_seats', task_id) AS k FROM contribution_auto_tasks_district_seats()")) {
    const k = r.k as string;
    // 縣市議員的縣市清單來自 admin_divisions（靜態）；其他職位的縣市清單由選舉區推出來，必須在 election_districts 組得出
    if (!k.endsWith(":縣市議員")) assert(seatKeys.has(k), `district_seats 缺口的鍵 ${k} 組不出來（事件會漏）`);
  }
  await db.close();
});

Deno.test("C3 入列函式：dispatch_gap_enqueue_units 一次入名冊三支、補號次與新三支；沒登記或參數不全不入；enqueue_roster_arms 補 raw 的縣市層級鍵", async () => {
  const db = await freshDb();
  await clearEvents(db);
  await db.exec("SELECT dispatch_gap_enqueue_roster_arms(2026, '村里長', '花蓮縣', '花蓮市', 'manual')");
  assertEquals(await pending(db), S([
    "raw:roster_check|unit:2026:花蓮縣:村里長", "raw:roster_check|unit:2026:花蓮縣花蓮市:村里長",
    "roster_cec_gap|unit:2026:花蓮縣花蓮市:村里長", "roster_villages|unit:2026:花蓮縣花蓮市:村里長",
  ]));
  await clearEvents(db);
  await db.exec("SELECT dispatch_gap_enqueue_roster_arms(2022, '縣市長', '臺北市', NULL, 'manual')");
  assertEquals(await pending(db), S(["raw:roster_check|unit:2022:台北市:縣市長", "roster_cec_gap|unit:2022:台北市:縣市長"]));
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue_units(2026, '縣市長', '臺北市', NULL, 'manual') AS v"), 5, "名冊兩支＋新兩支（raw、roster_cec_gap）＋補號次一支；raw 的縣市層級鍵與可能鍵重複，不另算");
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue_units(NULL, '縣市長', '臺北市') AS v"), 0);
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue_roster_arms(2026, '', '臺北市', NULL, 'x') AS v"), 0);
  await db.close();
});

// ───────────────────────── D 觸發器 ─────────────────────────
Deno.test("D1 新來源表：roster_checks／roster_reconcile_units／roster_check_scope／election_districts／verification_sources／cec_registration_sources 各入正確的鍵", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2099-11-28', ARRAY['縣市議員','鄉鎮市民代表'])");
  await clearEvents(db);
  await db.exec("INSERT INTO roster_checks (election_id, region, election_type, cec_count) VALUES (2026, '臺北市', '縣市長', 3), (2026, '花蓮縣花蓮市', '村里長', 1)");
  assertEquals(await pending(db), S([
    "raw:roster_check|unit:2026:台北市:縣市長", "roster_cec_gap|unit:2026:台北市:縣市長", "roster_villages|unit:2026:台北市:縣市長",
    "raw:roster_check|unit:2026:花蓮縣花蓮市:村里長", "roster_cec_gap|unit:2026:花蓮縣花蓮市:村里長", "roster_villages|unit:2026:花蓮縣花蓮市:村里長",
  ]));
  await clearEvents(db);
  await db.exec("UPDATE roster_checks SET cec_count = 9 WHERE election_type = '縣市長'");
  assertEquals((await pending(db)).length, 3, "改了清查人數：該單位三支臂各入一筆");
  // 對帳單位彙總：縣市層級（raw）與縣市＋鄉鎮（raw、villages）各入自己的鍵；非村里長不入 villages
  await clearEvents(db);
  await db.exec("INSERT INTO roster_reconcile_units (election_id, election_type, county, town, needs_agent) VALUES (2026, '村里長', '花蓮縣', '花蓮市', true), (2026, '縣市長', '新北市', '', true)");
  assertEquals(await pending(db), S([
    "raw:roster_check|unit:2026:花蓮縣:村里長", "raw:roster_check|unit:2026:花蓮縣花蓮市:村里長", "roster_villages|unit:2026:花蓮縣花蓮市:村里長",
    "raw:roster_check|unit:2026:新北市:縣市長",
  ]));
  await clearEvents(db);
  await db.exec("UPDATE roster_reconcile_units SET needs_agent = false WHERE county = '新北市'");
  assertEquals(await pending(db), ["raw:roster_check|unit:2026:新北市:縣市長"], "縣市長：縣市層級與縣市＋鄉鎮是同一個鍵（鄉鎮空），也不入 villages");
  // 清查範圍：整臂
  await clearEvents(db);
  await db.exec("INSERT INTO roster_check_scope (election_id, election_type) VALUES (2026, '縣市長')");
  assertEquals(await pending(db), ["raw:roster_check|*", "roster_villages|*"]);
  // 選舉區：本身職位的鍵＋由鄉鎮市長推出的代表職位；region_gap 看選舉區現況，名冊差異整臂
  await clearEvents(db);
  await db.exec("INSERT INTO election_districts (election_id, election_type, region, sub_region, seats) VALUES (2026, '鄉鎮市長', '臺北市', '文山區', 1)");
  assertEquals(await pending(db), S(["district_seats|seats:2026:台北市:鄉鎮市長", "district_seats|seats:2026:台北市:鄉鎮市民代表", "roster_unit_findings|*"]));
  await clearEvents(db);
  await db.exec("UPDATE election_districts SET seats = 5 WHERE election_type = '鄉鎮市長'");
  assertEquals(await pending(db), S(["district_seats|seats:2026:台北市:鄉鎮市長", "district_seats|seats:2026:台北市:鄉鎮市民代表", "roster_unit_findings|*"]));
  await clearEvents(db);
  await db.exec("UPDATE election_districts SET sub_region = sub_region");
  assert((await pending(db)).length > 0, "SET 到 OF 欄位就入列（PostgreSQL 的 OF 看 SET 清單）");
  await db.exec("DELETE FROM election_districts");
  // 低頻設定表
  await clearEvents(db);
  await db.exec("INSERT INTO verification_sources (provides) VALUES (ARRAY['seats'])");
  assertEquals(await pending(db), ["district_seats|*"]);
  await clearEvents(db);
  await db.exec("INSERT INTO cec_registration_sources VALUES ('http://x', NULL)");
  assertEquals(await pending(db), ["district_seats|*", "roster_unit_findings|*"]);
  await db.close();
});

Deno.test("D2 交件與批次表：district_seats 型別從 payload 組鍵、組不出整臂、怪值不讓寫入失敗；名單族型別組不出單位時新三支也整臂；cec_candidates／cec_registrations 多入新臂", async () => {
  const db = await freshDb();
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'district_seats', '{"election_id": 2026, "election_type": "縣市議員", "region": "臺北市", "districts": []}')`);
  assertEquals(await pending(db), ["district_seats|seats:2026:台北市:縣市議員"]);
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'district_seats', '{}')`);
  assertEquals(await pending(db), ["district_seats|*"]);
  await clearEvents(db);
  for (const payload of [`{"election_id": 99999999999, "election_type": "縣市議員", "region": "臺北市"}`, `{"election_id": 2026, "election_type": ["x"], "region": {"a": 1}}`]) {
    await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'district_seats', '${payload}'::jsonb)`);
  }
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM contributions WHERE contribution_type = 'district_seats'"), 4, "怪值也寫進去了");
  await clearEvents(db);
  await db.exec(`UPDATE contributions SET status = 'verified' WHERE contribution_type = 'district_seats' AND payload = '{}'::jsonb`);
  assertEquals(await pending(db), ["district_seats|*"], "狀態變動也入列");
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'election_results', '{"items": []}')`);
  assertEquals(await pending(db), S(["ballot_numbers|*", "raw:roster_check|*", "roster_cec_gap|*", "roster_gap_units|*", "roster_unit_findings|*", "roster_villages|*"]));
  // 其他型別仍不入列
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'correction', '{}')`);
  assertEquals(await pending(db), []);
  // 批次表（語句層級）：cec_candidates 的觸發器本期拿掉（改由 cec-sync 結尾入列單位），寫它不再產生任何事件；cec_registrations 保留
  await clearEvents(db);
  await db.exec("INSERT INTO cec_candidates (name) SELECT 'n' || g FROM generate_series(1, 3) g");
  await db.exec("UPDATE cec_candidates SET name = 'z'");
  await db.exec("DELETE FROM cec_candidates");
  assertEquals(await pending(db), [], "cec_candidates 沒有觸發器了");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM pg_trigger WHERE tgrelid = 'cec_candidates'::regclass AND NOT tgisinternal"), 0);
  await clearEvents(db);
  await db.exec("INSERT INTO cec_registrations (name) SELECT 'r' || g FROM generate_series(1, 300) g");
  assertEquals(await pending(db), ["district_seats|*", "roster_unit_findings|*"], "三百列一個語句只入一筆");
  await db.close();
});

Deno.test("D3 設定與小表：elections／election_milestones／regions／parties／party_aliases／cec_results_auto_plan_rows／electoral_district_areas 各入整臂；PR-1 原有的入列不變", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2099-11-28', ARRAY['縣市議員'])");
  await clearEvents(db);
  await db.exec("UPDATE elections SET election_date = '2099-11-29' WHERE id = 2026");
  assertEquals(await pending(db), S(["ballot_numbers|*", "district_seats|*", "mismatch|*", "raw:roster_check|*", "roster_unit_findings|*"]));
  await clearEvents(db);
  await db.exec("INSERT INTO election_milestones (election_id, kind) VALUES (2026, 'draw')");
  assertEquals(await pending(db), S(["ballot_numbers|*", "raw:roster_check|*", "roster_gap_units|*", "roster_unit_findings|*"]));
  await clearEvents(db);
  await db.exec("INSERT INTO regions VALUES (1, '臺北市', NULL, NULL, NULL), (2, '新北市', NULL, NULL, NULL)");
  assertEquals(await pending(db), [], "regions 只掛 UPDATE／DELETE：新選區 INSERT 不入列（apply-contribution 建選區時不要每次整臂）");
  await db.exec("UPDATE regions SET sub_region = '第01選舉區' WHERE id = 1");
  assertEquals(await pending(db), S(["ballot_numbers|*", "raw:roster_check|*", "roster_cec_gap|*", "roster_gap_units|*", "roster_unit_findings|*", "roster_villages|*"]), "兩列一個語句");
  await clearEvents(db);
  await db.exec("DELETE FROM regions WHERE id = 2");
  assertEquals((await pending(db)).length, 6);
  await clearEvents(db);
  await db.exec("INSERT INTO parties VALUES (1, 'x')");
  assertEquals(await pending(db), ["roster_unit_findings|*"]);
  await clearEvents(db);
  await db.exec("INSERT INTO party_aliases (alias) VALUES ('y')");
  assertEquals(await pending(db), ["roster_unit_findings|*"]);
  await clearEvents(db);
  // cec_results_auto_plan_rows 不掛觸發器（refresh 每次整表 DELETE，語句觸發器會每 10 分鐘入整臂）
  await db.exec("INSERT INTO cec_results_auto_plan_rows VALUES (1)");
  await db.exec("DELETE FROM cec_results_auto_plan_rows");
  assertEquals(await pending(db), []);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM pg_trigger WHERE tgrelid = 'cec_results_auto_plan_rows'::regclass AND NOT tgisinternal"), 0);
  await clearEvents(db);
  await db.exec("INSERT INTO electoral_district_areas VALUES ('臺北市', '文山區')");
  assertEquals(await pending(db), ["roster_villages|*"]);
  // PR-1：設定表整臂（登記的每支臂都入，現在是十支）
  await clearEvents(db);
  await db.exec("INSERT INTO traffic_watch_levels VALUES ('村里長', true)");
  assertEquals((await pending(db)).length, 0, "traffic_watch_levels 沒掛觸發器（第 1 期沒有掛），不入列");
  await db.close();
});

Deno.test("D4 task_checks（只有掛錯人任務）與 edit_history（參選紀錄建立那一筆）：入該參選紀錄所屬的單位；不相干的列不入、WHEN 擋掉", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  await clearEvents(db);
  await db.exec("INSERT INTO task_checks (task_id, outcome) VALUES ('auto:policy_missing:abc', 'not_found'), ('auto:candidacy_owner_mismatch:abc', 'confirmed')");
  assertEquals(await pending(db), [], "別的任務、格式不對的都不入");
  await db.exec("INSERT INTO task_checks (task_id, outcome) VALUES ('auto:candidacy_owner_mismatch:1002', 'confirmed')");
  assertEquals(await pending(db), S(["roster_gap_units|unit:2026:新北市:縣市長", "roster_unit_findings|unit:2026:新北市:縣市長"]),
    "task_checks 只入名冊差異兩支（掛錯人臂是名冊差異的一部分），單位是那筆參選紀錄的縣市");
  await clearEvents(db);
  await db.exec("INSERT INTO edit_history (table_name, record_id, field) VALUES ('policies', 'x', 'title'), ('politician_elections', '1001', 'cand_no'), ('politician_elections', 'abc', '*')");
  assertEquals(await pending(db), [], "欄位不是 '*'、record_id 不是數字都不入");
  await db.exec("INSERT INTO edit_history (table_name, record_id, field) VALUES ('politician_elections', '1003', '*')");
  assertEquals(await pending(db), S([
    "ballot_numbers|ballot:2026:村里長:花蓮縣:", "ballot_numbers|ballot:2026:村里長:花蓮縣:花蓮市",
    "raw:roster_check|unit:2026:花蓮縣:村里長", "raw:roster_check|unit:2026:花蓮縣花蓮市:村里長", "roster_cec_gap|unit:2026:花蓮縣花蓮市:村里長",
    "roster_gap_units|unit:2026:花蓮縣花蓮市:村里長", "roster_unit_findings|unit:2026:花蓮縣花蓮市:村里長", "roster_villages|unit:2026:花蓮縣花蓮市:村里長",
  ]));
  // 舊行為：policies 的 audit 紀錄仍只入 legacy
  await clearEvents(db);
  await db.exec(`INSERT INTO edit_history (table_name, record_id, field) VALUES ('policies', '${U(500)}', 'audit')`);
  assertEquals(await pending(db), [`legacy|policy:${U(500)}`]);
  await db.close();
});

Deno.test("D5 politician_elections 與人物：改一列，入名冊三支＋新三支＋補號次的單位鍵（PR-1 的入列只多不少）；events_enabled=false 全部不入", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2099-11-28', ARRAY['縣市議員'])");
  await db.exec("INSERT INTO regions VALUES (3, '花蓮縣', '花蓮市', '國盛里', 'A001')");
  await db.exec(`INSERT INTO politicians (id, name, region) VALUES ('${U(1)}', '甲', '花蓮縣')`);
  await clearEvents(db);
  await db.exec(`INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id) VALUES (1, '${U(1)}', 2026, '村里長', 'filed', 3)`);
  assertEquals(await pending(db), S([
    "ballot_numbers|ballot:2026:村里長:花蓮縣:", "ballot_numbers|ballot:2026:村里長:花蓮縣:花蓮市",
    "raw:roster_check|unit:2026:花蓮縣:村里長", "raw:roster_check|unit:2026:花蓮縣花蓮市:村里長", "roster_cec_gap|unit:2026:花蓮縣花蓮市:村里長",
    "roster_gap_units|unit:2026:花蓮縣花蓮市:村里長", "roster_unit_findings|unit:2026:花蓮縣花蓮市:村里長", "roster_villages|unit:2026:花蓮縣花蓮市:村里長",
  ]));
  await clearEvents(db);
  await db.exec("UPDATE dispatch_gap_settings SET events_enabled = false");
  await db.exec(`UPDATE politician_elections SET cand_no = 5 WHERE id = 1`);
  await db.exec("INSERT INTO roster_checks (election_id, region, election_type) VALUES (2026, '花蓮縣花蓮市', '村里長')");
  await db.exec("INSERT INTO election_districts (election_id, election_type, region) VALUES (2026, '縣市議員', '臺北市')");
  await db.exec("INSERT INTO regions VALUES (9, 'x', NULL, NULL, NULL)");
  await db.exec("INSERT INTO electoral_district_areas VALUES ('a', 'b')");
  await db.exec("INSERT INTO task_checks (task_id) VALUES ('auto:candidacy_owner_mismatch:1')");
  assertEquals(await pending(db), []);
  await db.close();
});

Deno.test("D6 時間翻轉：名單公告日前後補 raw:roster_check、roster_villages；投票日前後多補 district_seats；其餘日子不補", async () => {
  const db = await freshDb();
  await db.exec("SET app.activity_today = ''");
  const today = await one<string>(db, "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS v");
  await db.exec(`SET app.activity_today = '${today}'`);
  await db.exec("INSERT INTO roster_check_scope (election_id, election_type, list_announced_on) VALUES (2026, '縣市長', CURRENT_DATE + 30)");
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip_roster() AS v"), 0, "離名單公告日 30 天、沒有選舉，什麼都不做");
  await db.exec("UPDATE roster_check_scope SET list_announced_on = CURRENT_DATE + 1");
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip_roster() AS v"), 1);
  assertEquals(await pending(db), ["raw:roster_check|*", "roster_villages|*"]);
  await db.exec("UPDATE roster_check_scope SET list_announced_on = CURRENT_DATE - 2");
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip_roster() AS v"), 1, "公告日後 2 天內還補（時區與每日兩次排程的空窗）");
  await db.exec("UPDATE roster_check_scope SET list_announced_on = CURRENT_DATE - 3");
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip_roster() AS v"), 0);
  await db.exec("INSERT INTO elections VALUES (2026, CURRENT_DATE + 1, ARRAY['縣市議員'])");
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip_roster() AS v"), 1);
  assertEquals(await pending(db), ["ballot_numbers|*", "district_seats|*", "roster_unit_findings|*"]);
  await db.close();
});

Deno.test("D7 新增分支的入列出錯只丟 WARNING、不讓來源表寫入失敗：edit_history（每筆貢獻都寫）、task_checks、roster_checks、roster_reconcile_units", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  await db.exec(`CREATE OR REPLACE FUNCTION dispatch_gap_enqueue_reg(p_arm TEXT, p_key TEXT, p_kind TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION '入列壞了'; END $f$`);
  await db.exec("INSERT INTO edit_history (table_name, record_id, field) VALUES ('politician_elections', '1001', '*')");
  await db.exec("INSERT INTO task_checks (task_id, outcome) VALUES ('auto:candidacy_owner_mismatch:1001', 'confirmed')");
  await db.exec("INSERT INTO roster_checks (election_id, region, election_type, cec_count) VALUES (2026, '臺北市', '縣市長', 1)");
  await db.exec("INSERT INTO roster_reconcile_units (election_id, election_type, county, town, needs_agent) VALUES (2026, '縣市長', '宜蘭縣', '', true)");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM edit_history WHERE record_id = '1001'"), 1);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM task_checks"), 1);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM roster_checks WHERE region = '臺北市'"), 1);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM roster_reconcile_units WHERE county = '宜蘭縣'"), 1);
  await db.close();
});

// ───────────────────────── E drain ─────────────────────────
Deno.test("E1 drain：資料變動後四支新臂的常駐表與整表結果一致（走的是按鍵版：整表函式弄壞也消化得了）", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  await drainAll(db);
  await assertConsistent(db, "初次（整臂事件）");
  for (const arm of NEWARMS) assert((await gapCount(db, arm)) > 0, `${arm} 常駐表要有資料`);
  await db.exec("CREATE FUNCTION boom() RETURNS TABLE (task_id TEXT) LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '整表版不該被呼叫'; END $$");
  const breakFull = () => db.exec(`UPDATE dispatch_gap_arm_keys SET full_fn = 'boom()' WHERE arm IN (${NEWARMS.map((a) => `'${a}'`).join(",")})`);
  const fixFull = async () => {
    for (const a of NEWARMS) await db.exec(`UPDATE dispatch_gap_arm_keys SET full_fn = '${FULL_FN[a]}' WHERE arm = '${a}'`);
  };
  const step = async (why: string, sql: string, expectKeys: string[]) => {
    await breakFull();
    await db.exec(sql);
    const p = await pending(db);
    assertEquals(p.filter((k) => k.endsWith("|*") && NEWARMS.some((a) => k.startsWith(a + "|"))), [], `${why}：新臂不該有整臂事件`);
    for (const k of expectKeys) assert(p.includes(k), `${why}：缺事件 ${k}，實際 ${JSON.stringify(p)}`);
    await drainAll(db);
    assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE processed_at IS NULL"), 0, `${why}：事件要消化完`);
    assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE last_error IS NOT NULL"), 0, `${why}：不能有失敗的事件（走了整表版就會爆）`);
    await fixFull();
    await assertConsistent(db, why);
  };
  const n0 = {} as Record<string, number>;
  for (const a of NEWARMS) n0[a] = await gapCount(db, a);
  await step("新北市縣市長近期清查過（roster_cec_gap 少一個單位）", "INSERT INTO roster_checks (election_id, region, election_type, cec_count) VALUES (2022, '新北市', '縣市長', 2)",
    ["roster_cec_gap|unit:2022:新北市:縣市長"]);
  assertEquals(await gapCount(db, "roster_cec_gap"), n0.roster_cec_gap - 1);
  await step("花蓮市村里長近期清查過（roster_villages 少一個單位）", "INSERT INTO roster_checks (election_id, region, election_type, cec_count) VALUES (2026, '花蓮縣花蓮市', '村里長', 1)",
    ["roster_villages|unit:2026:花蓮縣花蓮市:村里長"]);
  assertEquals(await gapCount(db, "roster_villages"), n0.roster_villages - 1);
  await step("臺北市縣市長的對帳單位說有人要派代理（raw 多一個單位）", "UPDATE roster_reconcile_units SET needs_agent = true WHERE county = '臺北市'",
    ["raw:roster_check|unit:2026:台北市:縣市長"]);
  assertEquals(await gapCount(db, "raw:roster_check"), n0["raw:roster_check"] + 1);
  await step("新北市縣市長補上一位參選紀錄（我們的人數變了）", `INSERT INTO politicians (id, name, region) VALUES ('${U(60)}', 'X1', '新北市');
    INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES ('${U(60)}', 2022, '縣市長', 'elected', 4)`,
    ["roster_cec_gap|unit:2022:新北市:縣市長", "raw:roster_check|unit:2022:新北市:縣市長"]);
  await step("臺北市議員第 02 選舉區補上名額", "UPDATE election_districts SET seats = 9 WHERE sub_region = '第02選舉區'", ["district_seats|seats:2026:台北市:縣市議員"]);
  const seats0 = await gapCount(db, "district_seats");
  await step("花蓮縣鄉鎮市民代表的名額已有人交件在等票（排除）", `INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'district_seats',
    '{"election_id": 2026, "election_type": "鄉鎮市民代表", "region": "花蓮縣", "districts": []}')`, ["district_seats|seats:2026:花蓮縣:鄉鎮市民代表"]);
  assertEquals(await gapCount(db, "district_seats"), seats0 - 1);
  await step("花蓮縣的鄉鎮市長選舉區新增（代表名額的縣市清單變）", "INSERT INTO election_districts (election_id, election_type, region, sub_region, seats) VALUES (2026, '鄉鎮市長', '宜蘭縣', '宜蘭市', 1)",
    ["district_seats|seats:2026:宜蘭縣:鄉鎮市民代表"]);
  assertEquals(await gapCount(db, "district_seats"), seats0, "宜蘭縣多一個要補名額的單位、扣掉上一步排除的那個");
  // 整臂事件（清查範圍、候選人名單同步）：整表版還原後走整表
  await db.exec("UPDATE roster_check_scope SET recheck_days = 1");
  assertEquals(S(only(await pending(db), "raw:roster_check").concat(only(await pending(db), "roster_villages"))), ["raw:roster_check|*", "roster_villages|*"]);
  await drainAll(db);
  await assertConsistent(db, "整臂事件消化後");
  // cec-sync 一個單位「先刪後寫」之後呼叫 dispatch_gap_enqueue_cec_units（走按鍵版，不能走整表版）
  await breakFull();
  await db.exec(`DELETE FROM cec_candidates WHERE election_id = 2022 AND election_type = '縣市長' AND region = '新北市';
    INSERT INTO cec_candidates (election_id, election_type, region, name, name_norm, elected, cand_no) VALUES
      (2022, '縣市長', '新北市', 'X3', 'X3', true, 1), (2022, '縣市長', '新北市', 'X4', 'X4', false, 2), (2022, '縣市長', '新北市', 'X5', 'X5', false, 3)`);
  assertEquals(await pending(db), [], "寫 cec_candidates 本身不入列");
  assert(((await one<number>(db, `SELECT dispatch_gap_enqueue_cec_units('[{"election_id": 2022, "election_type": "縣市長", "region": "新北市"}]'::jsonb) AS v`)) as number) > 0);
  assert((await pending(db)).includes("roster_cec_gap|unit:2022:新北市:縣市長"));
  assertEquals((await pending(db)).filter((k) => k.endsWith("|*")), [], "只入單位鍵，沒有整臂");
  await drainAll(db);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE last_error IS NOT NULL"), 0, "走了整表版就會爆");
  await fixFull();
  await assertConsistent(db, "cec-sync 單位入列");
  await db.close();
});

Deno.test("E2 dispatch_gap_enqueue_cec_units：縣市層級一組、村里長與代表再展開該縣市每個鄉鎮（取 cec_candidates 現有與 regions 的聯集）；不重複、非陣列與關閉事件回 0；怪輸入不丟錯", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  await db.exec("INSERT INTO regions VALUES (20, '花蓮縣', '吉安鄉', NULL, NULL), (21, '花蓮縣', '花蓮市第03選舉區', NULL, NULL)");
  await clearEvents(db);
  const call = async (units: string) => (await one<number>(db, `SELECT dispatch_gap_enqueue_cec_units('${units}'::jsonb) AS v`)) as number;
  // 縣市長：只有縣市層級
  assert((await call(`[{"election_id": 2022, "election_type": "縣市長", "region": "臺北市"}]`)) > 0);
  assertEquals(await pending(db), S(["raw:roster_check|unit:2022:台北市:縣市長", "roster_cec_gap|unit:2022:台北市:縣市長", "roster_unit_findings|unit:2022:台北市:縣市長"]));
  // 同一個單位再呼叫：同鍵未處理不重複
  assertEquals(await call(`[{"election_id": 2022, "election_type": "縣市長", "region": "臺北市"}, {"election_id": 2022, "election_type": "縣市長", "region": "臺北市"}]`), 0);
  // 村里長：縣市層級＋花蓮縣的每個鄉鎮（花蓮市來自 cec_candidates，吉安鄉來自 regions；「花蓮市第03選舉區」去掉選舉區後也是花蓮市）
  await clearEvents(db);
  assert((await call(`[{"election_id": 2022, "election_type": "村里長", "region": "花蓮縣"}]`)) > 0);
  const p = await pending(db);
  for (const k of ["raw:roster_check|unit:2022:花蓮縣:村里長", "roster_cec_gap|unit:2022:花蓮縣花蓮市:村里長", "roster_cec_gap|unit:2022:花蓮縣吉安鄉:村里長",
    "roster_villages|unit:2022:花蓮縣花蓮市:村里長", "roster_villages|unit:2022:花蓮縣吉安鄉:村里長", "roster_unit_findings|unit:2022:花蓮縣吉安鄉:村里長",
    "raw:roster_check|unit:2022:花蓮縣吉安鄉:村里長"]) assert(p.includes(k), `缺事件 ${k}：${JSON.stringify(p)}`);
  assertEquals(p.filter((k) => k.endsWith("|*")), []);
  assertEquals(p.filter((k) => k.startsWith("ballot_numbers|") || k.startsWith("roster_gap_units|")), [], "已投票屆的名單同步不入補號次與名單缺口（只看 2026）");
  // 2026 的名冊缺口（只看 2026）會入
  await clearEvents(db);
  await call(`[{"election_id": 2026, "election_type": "縣市長", "region": "臺北市"}]`);
  assert((await pending(db)).includes("roster_gap_units|unit:2026:台北市:縣市長"));
  // 代表：選舉區後綴去掉
  await clearEvents(db);
  await call(`[{"election_id": 2022, "election_type": "鄉鎮市民代表", "region": "花蓮縣"}]`);
  assert((await pending(db)).includes("roster_cec_gap|unit:2022:花蓮縣花蓮市:鄉鎮市民代表"));
  // 怪輸入：不是陣列、缺欄位、空白縣市、關閉事件
  await clearEvents(db);
  assertEquals(await call(`{"election_id": 2022}`), 0);
  assertEquals(await call(`[{"election_type": "縣市長", "region": "臺北市"}, {"election_id": 2022, "region": "臺北市"}, {"election_id": 2022, "election_type": "縣市長", "region": "  "}]`), 0);
  await db.exec("UPDATE dispatch_gap_settings SET events_enabled = false");
  assertEquals(await call(`[{"election_id": 2022, "election_type": "縣市長", "region": "宜蘭縣"}]`), 0);
  assertEquals(await pending(db), []);
  await db.close();
});

// ───────────────────────── F 雙軌與總表輸出 ─────────────────────────
const snapshotArms = async (db: PGlite) => (await rows(db, "SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY t.task_id, t.arm)) AS h, count(*)::int AS n FROM contribution_auto_tasks_arms() t"))[0];

Deno.test("F1 shadow_run：十支臂差異全 0（含 raw:roster_check 整表版對帳）；故意弄髒常駐表會被抓到", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  await drainAll(db);
  assertEquals(await one(db, "SELECT dispatch_gap_shadow_run() AS v"), 10);
  const runs = await rows(db, "SELECT arm, missing, extra, changed, live_count, table_count, error FROM dispatch_gap_reconcile_runs WHERE mode = 'shadow' ORDER BY arm");
  assertEquals(runs.map((r) => r.arm), ALL10);
  for (const r of runs) {
    assertEquals([r.missing, r.extra, r.changed, r.error], [0, 0, 0, null], `${r.arm} 雙軌差異要為 0`);
    assertEquals(r.live_count, r.table_count);
  }
  for (const arm of NEWARMS) {
    await db.exec(`UPDATE dispatch_gaps SET closed_at = now(), closed_reason = 'filled' WHERE arm = '${arm}' AND gap_key IN (SELECT gap_key FROM dispatch_gaps WHERE arm = '${arm}' AND closed_at IS NULL LIMIT 1)`);
  }
  await db.exec("SELECT dispatch_gap_shadow_run()");
  for (const arm of NEWARMS) {
    assertEquals(await one(db, `SELECT missing::int AS v FROM dispatch_gap_reconcile_runs WHERE mode = 'shadow' AND arm = '${arm}' ORDER BY id DESC LIMIT 1`), 1, `${arm} 弄髒後要抓到少一列`);
  }
  await db.close();
});

Deno.test("F2 總表輸出與遷移前逐列相同（md5）、與前一版（_v20261126）雙向 EXCEPT 為 0；drain 前後與常駐表被弄壞，總表輸出都不變（shadow 不讀常駐表）", async () => {
  const db = await freshDb({ dataBeforeMig: true, mig: false });
  const before = await snapshotArms(db);
  assert((before.n as number) > 5, `總表要有輸出 ${before.n}`);
  await db.exec(mig);
  const after = await snapshotArms(db);
  assertEquals(after, before, "遷移前後總表輸出逐列相同");
  const a = await one<number>(db, "SELECT count(*)::int AS v FROM (SELECT * FROM contribution_auto_tasks_arms() EXCEPT SELECT * FROM contribution_auto_tasks_arms_v20261126()) x");
  const b = await one<number>(db, "SELECT count(*)::int AS v FROM (SELECT * FROM contribution_auto_tasks_arms_v20261126() EXCEPT SELECT * FROM contribution_auto_tasks_arms()) x");
  assertEquals([a, b], [0, 0]);
  await drainAll(db);
  assertEquals(await snapshotArms(db), before, "drain 只維護 dispatch_gaps");
  await db.exec("DELETE FROM dispatch_gaps");
  assertEquals(await snapshotArms(db), before, "shadow 不讀常駐表");
  await db.close();
});

Deno.test("F3 四支新臂在總表的原輸出就有資料（不是空對空）：各臂列數", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  for (const arm of ["roster_cec_gap", "roster_villages", "district_seats"]) {
    assert(((await one<number>(db, `SELECT count(*)::int AS v FROM contribution_auto_tasks_arms() WHERE arm = '${arm}'`)) as number) > 0, `${arm} 總表輸出是空的`);
  }
  assert(((await one<number>(db, "SELECT count(*)::int AS v FROM contribution_auto_tasks_arms() WHERE arm = 'raw:roster_check'")) as number) > 0);
  await db.close();
});

// ───────────────────────── G 初始灌入 ─────────────────────────
Deno.test("G1 資料先在、遷移後才掛觸發器：四支新臂常駐表立刻與整表一致、補了四筆整臂事件；模式與登記", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  await assertConsistent(db, "遷移完", NEWARMS);
  for (const arm of NEWARMS) assert((await gapCount(db, arm)) > 0, `${arm} 初始灌入要有資料`);
  assertEquals((await pending(db)).filter((k) => NEWARMS.some((a) => k.startsWith(a + "|"))), S(["district_seats|*", "raw:roster_check|*", "roster_cec_gap|*", "roster_villages|*"]),
    "灌入與掛觸發器之間的空窗由整臂事件補");
  await drainAll(db);
  await assertConsistent(db, "整臂事件消化後");
  assertEquals((await rows(db, "SELECT arm, mode FROM dispatch_gap_arms WHERE mode <> 'off' ORDER BY arm")).map((r) => `${r.arm}:${r.mode}`), ALL10.map((a) => `${a}:shadow`));
  assertEquals(await rows(db, "SELECT arm, recompute_fn, full_fn FROM dispatch_gap_arm_keys WHERE arm IN ('district_seats','raw:roster_check','roster_cec_gap','roster_villages') ORDER BY arm"), [
    { arm: "district_seats", recompute_fn: "dispatch_gap_recompute_district_seats(text[])", full_fn: "contribution_auto_tasks_district_seats()" },
    { arm: "raw:roster_check", recompute_fn: "dispatch_gap_recompute_raw_roster_check(text[])", full_fn: "dispatch_gap_full_raw_roster_check()" },
    { arm: "roster_cec_gap", recompute_fn: "dispatch_gap_recompute_roster_cec_gap(text[])", full_fn: "contribution_auto_tasks_roster_cec_gap()" },
    { arm: "roster_villages", recompute_fn: "dispatch_gap_recompute_roster_villages(text[])", full_fn: "contribution_auto_tasks_roster_villages()" },
  ]);
  // 舊簽名已不在、新簽名在
  assertEquals(await one(db, "SELECT to_regprocedure('cec_roster_diff()') IS NULL AND to_regprocedure('roster_diff_findings()') IS NULL AS v"), true);
  assertEquals(await one(db, "SELECT to_regprocedure('cec_roster_diff(text[])') IS NOT NULL AND to_regprocedure('roster_diff_findings(text[])') IS NOT NULL AS v"), true);
  await db.close();
});

Deno.test("G3 先前四支已切 live（20261127081000 之後的世界）：本期 migration 照常通過自我檢查，四支新臂 shadow、原四支仍 live；多一支別的 live 臂就整支失敗", async () => {
  const db = await freshDb({ dataBeforeMig: true, mig: false });
  for (const arm of ["legacy", "mismatch", "issue_too_broad", "ballot_numbers"]) await db.exec(`SELECT dispatch_gap_set_mode('${arm}', 'live')`);
  await db.exec(mig);
  const modes = await rows(db, "SELECT arm, mode FROM dispatch_gap_arms WHERE mode <> 'off' ORDER BY mode, arm");
  assertEquals(modes.filter((m) => m.mode === "live").map((m) => m.arm), ["ballot_numbers", "issue_too_broad", "legacy", "mismatch"]);
  assertEquals(modes.filter((m) => m.mode === "shadow").map((m) => m.arm), ["district_seats", "raw:roster_check", "roster_cec_gap", "roster_gap_units", "roster_unit_findings", "roster_villages"]);
  await db.close();
  const bad = await freshDb({ dataBeforeMig: true, mig: false });
  await bad.exec("SELECT dispatch_gap_set_mode('roster_unit_findings', 'shadow'); INSERT INTO dispatch_gap_arms (arm, mode) VALUES ('manual_open', 'live') ON CONFLICT (arm) DO UPDATE SET mode = 'live'");
  let msg = "";
  try {
    await bad.exec(mig);
  } catch (e) {
    msg = String((e as Error).message);
  }
  assert(msg.includes("不能有別的 live 臂"), msg);
  await bad.close();
});

Deno.test("G2 切 live：四支新臂可切 live（總表分支）再切回；總表輸出在 live 時與即時算一致（drain 之後）", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  await drainAll(db);
  const before = await snapshotArms(db);
  for (const arm of ["district_seats", "roster_cec_gap", "roster_villages", "raw:roster_check"]) {
    assertEquals(await one(db, `SELECT dispatch_gap_set_mode('${arm}', 'live') AS v`), "live");
  }
  const live = await snapshotArms(db);
  assertEquals(live.n, before.n, "live 時總表列數與即時算相同");
  for (const arm of ["district_seats", "roster_cec_gap", "roster_villages", "raw:roster_check"]) await db.exec(`SELECT dispatch_gap_set_mode('${arm}', 'shadow')`);
  assertEquals(await snapshotArms(db), before);
  await db.close();
});

// ───────────────────────── H 遷移文字守門 ─────────────────────────
Deno.test("H1 觸發器：全部 AFTER；列層級 UPDATE 帶 OF 欄位或 WHEN（低頻設定表例外並列名）；語句層級走 dispatch_gap_on_stmt；本支新掛 13 支＋contributions 重建", () => {
  const stmts = noComments(mig).split(/;\s*\n/).filter((s) => /CREATE TRIGGER/.test(s));
  assertEquals(stmts.length, 13, "十二支新增＋contributions 一支重建");
  const LOW_FREQ = ["roster_check_scope", "verification_sources", "cec_registration_sources"];
  for (const s of stmts) {
    const head = s.replace(/\s+/g, " ");
    assert(/AFTER /.test(head), "只用 AFTER 觸發器（不擋寫入、不改列）");
    if (/FOR EACH STATEMENT/.test(head)) {
      assert(/EXECUTE FUNCTION dispatch_gap_on_stmt\(\)/.test(head), `語句層級要走 dispatch_gap_on_stmt：${head}`);
      continue;
    }
    assert(/FOR EACH ROW/.test(head) && /EXECUTE FUNCTION dispatch_gap_on_change\(\)/.test(head));
    const pre = head.split(" ON ")[0];
    if (/\bUPDATE\b/.test(pre) && !LOW_FREQ.some((t) => new RegExp(`ON ${t}\\b`).test(head))) assert(/UPDATE OF /.test(head), `UPDATE 必須帶 OF 欄位：${head}`);
  }
  const c = stmts.find((s) => /ON contributions\b/.test(s))!.replace(/\s+/g, " ");
  assert(/WHEN \(NEW\.contribution_type IN \('policy', 'policy_subtopics', 'cand_numbers', 'candidacy', 'election_results', 'reassign_candidacy', 'district_seats'\)\)/.test(c));
  const tc = stmts.find((s) => /ON task_checks\b/.test(s))!.replace(/\s+/g, " ");
  assert(/AFTER INSERT ON task_checks FOR EACH ROW WHEN \(NEW\.task_id LIKE 'auto:candidacy_owner_mismatch:%'\)/.test(tc), tc);
  const eh = stmts.find((s) => /ON edit_history\b/.test(s))!.replace(/\s+/g, " ");
  assert(/AFTER INSERT ON edit_history FOR EACH ROW WHEN \(NEW\.table_name = 'politician_elections' AND NEW\.field = '\*'\)/.test(eh), eh);
  // contributions 的 WHEN 是 PR-1 的超集
  const p1 = ph2a.replace(/\s+/g, " ");
  const old = /WHEN \(NEW\.contribution_type IN \(([^)]+)\)\)/.exec(p1.slice(p1.indexOf("CREATE TRIGGER trg_dispatch_gap_contributions")))![1].split(",").map((x) => x.trim());
  for (const t of old) assert(c.includes(t), `contributions 重建後少了 ${t}`);
});

Deno.test("H2 沒動總表、seed、被複製的臂函式本體與 PR-1 的整表函式；DROP 只有 cec_roster_diff()、roster_diff_findings() 兩支舊簽名；註解沒有函式定義字樣；REVOKE／GRANT 齊", () => {
  const code = noComments(mig);
  for (const f of ["seed_auto_task_queue", "contribution_auto_tasks_arms", "contribution_auto_tasks_ballot_numbers", "contribution_auto_tasks_roster_cec_gap",
    "contribution_auto_tasks_roster_villages", "contribution_auto_tasks_district_seats", "contribution_auto_tasks_raw", "roster_unit_findings", "roster_gap_units",
    "cec_roster_replace_unit", "dispatch_gap_drain", "dispatch_gap_reconcile_all", "dispatch_gap_shadow_run", "dispatch_gap_set_mode"]) {
    assert(!new RegExp(`CREATE OR REPLACE FUNCTION ${f}\\(`).test(code), `本支不能重定義 ${f}`);
  }
  assertEquals([...code.matchAll(/DROP FUNCTION[^;]*;/g)].map((m) => m[0]), ["DROP FUNCTION IF EXISTS cec_roster_diff();", "DROP FUNCTION IF EXISTS roster_diff_findings();"]);
  for (const line of mig.split("\n").filter((l) => l.trim().startsWith("--"))) {
    assert(!/CREATE OR REPLACE FUNCTION\s+\w+/.test(line), `註解不能出現函式定義字樣：${line}`);
    assert(!/COMMENT ON FUNCTION\s+\w+/.test(line), `註解不能出現 COMMENT ON FUNCTION：${line}`);
  }
  for (const f of ["dispatch_gap_seats_unit_key(INTEGER, TEXT, TEXT)", "dispatch_gap_seats_scope(TEXT)", "dispatch_gap_seats_keys(INTEGER, TEXT, TEXT)", "dispatch_gap_enqueue_seats(INTEGER, TEXT, TEXT, TEXT)",
    "dispatch_gap_enqueue_roster_arms(INTEGER, TEXT, TEXT, TEXT, TEXT)", "dispatch_gap_enqueue_units(INTEGER, TEXT, TEXT, TEXT, TEXT)", "dispatch_gap_scope_key(TEXT, TEXT)",
    "dispatch_gap_recompute_roster_cec_gap(TEXT[])", "dispatch_gap_recompute_roster_villages(TEXT[])", "dispatch_gap_recompute_district_seats(TEXT[])",
    "dispatch_gap_recompute_raw_roster_check(TEXT[])", "dispatch_gap_full_raw_roster_check()", "dispatch_gap_recompute_roster_unit_findings(TEXT[])",
    "dispatch_gap_recompute_roster_gap_units(TEXT[])", "dispatch_gap_on_change()", "dispatch_gap_on_batch_new()", "dispatch_gap_on_batch_old()", "dispatch_gap_on_stmt()",
    "dispatch_gap_enqueue_cec_units(JSONB)"]) {
    assert(mig.includes(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon, authenticated;`), `缺 REVOKE ${f}`);
  }
  assert(mig.includes("GRANT EXECUTE ON FUNCTION dispatch_gap_enqueue_units(INTEGER, TEXT, TEXT, TEXT, TEXT) TO service_role;"));
  assert(mig.includes("GRANT EXECUTE ON FUNCTION dispatch_gap_enqueue_cec_units(JSONB) TO service_role;"));
  // 時間戳：大於 PR-1 與 main 最新那支
  assert(MIG_NAME > PH2A);
  assert(MIG_NAME > "20261127052000_agy_login_realtime_broadcast.sql");
});

Deno.test("H3 DDL 鎖的順序：contributions 觸發器最後、緊接結尾；DROP／CREATE 函式與自我檢查、補整臂事件都在第一個 CREATE TRIGGER 之前；最後之後只剩計數檢查與 NOTIFY", () => {
  const code = noComments(mig);
  const trig = [...code.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => ({ name: m[1], i: m.index! }));
  assertEquals(trig.length, 13);
  const hot = trig.find((t) => t.name === "trg_dispatch_gap_contributions")!;
  assert(hot.i > Math.max(...trig.filter((t) => t !== hot).map((t) => t.i)), "熱表觸發器要排在所有低頻表之後");
  const first = Math.min(...trig.map((t) => t.i));
  for (const marker of ["DROP FUNCTION IF EXISTS cec_roster_diff()", "DROP FUNCTION IF EXISTS roster_diff_findings()", "本期四支要是 shadow", "四支臂的按鍵版或整表版沒有登記",
    "要只剩帶 p_keys 的新簽名", "SELECT dispatch_gap_enqueue('raw:roster_check', '*', 'migration')", "dispatch_gap_reconcile_all(ARRAY['roster_cec_gap'"]) {
    const i = code.indexOf(marker);
    assert(i >= 0 && i < first, `${marker} 要在第一個 CREATE TRIGGER 之前`);
  }
  assert(code.indexOf("SET LOCAL lock_timeout = '30s'") < first);
  const last = Math.max(...trig.map((t) => t.i));
  const afterLast = code.slice(code.indexOf(";", code.indexOf("EXECUTE FUNCTION", last)) + 1);
  assert(!/\b(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE)\b/.test(afterLast), `最後一個觸發器之後只該有計數檢查與 NOTIFY：${afterLast.slice(0, 200)}`);
  assert(afterLast.includes("預期共掛 31 支觸發器"));
  // cec_candidates 的三支語句層級觸發器在掛新觸發器之前就拿掉（DROP 在第一個 CREATE TRIGGER 之前）
  for (const t of ["ins", "upd", "del"]) {
    const i = code.indexOf(`DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_${t} ON cec_candidates;`);
    assert(i >= 0 && i < first, `cec_candidates_${t} 的 DROP 要在第一個 CREATE TRIGGER 之前`);
  }
});

Deno.test("H5 回滾檔：兩支舊簽名完整定義（本體與遷移裡的新版只差鍵過濾）、本期全部觸發器的 DROP、未處理事件的 DELETE；檔頭指到它", async () => {
  const rb = await Deno.readTextFile(new URL("../../../docs/rollback/20261127082000_dispatch_gaps_phase2b_rollback.sql", import.meta.url));
  const rbn = rb.replace(/\r\n/g, "\n");
  assert(mig.includes("docs/rollback/20261127082000_dispatch_gaps_phase2b_rollback.sql"));
  assert(rbn.includes("DELETE FROM dispatch_gap_events WHERE arm IN ('roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check') AND processed_at IS NULL;"));
  const created = [...noComments(mig).matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1]).filter((n) => n !== "trg_dispatch_gap_contributions");
  assertEquals(created.length, 12);
  for (const t of created) assert(rbn.includes(`DROP TRIGGER IF EXISTS ${t} ON`), `回滾檔缺 ${t} 的 DROP`);
  for (const t of ["ins", "upd", "del"]) assert(rbn.includes(`CREATE TRIGGER trg_dispatch_gap_cec_candidates_${t}`));
  // 舊簽名的定義：整表版每一行（去掉本期鍵過濾行）都在回滾檔裡
  const oldDiff = fnText(rbn, "cec_roster_diff");
  const oldFind = fnText(rbn, "roster_diff_findings");
  const code = (fn: string) => bodyLines(fn).map((l) => l.replace(/\s*--.*$/, "")).filter((l) => l);   // 行尾註解不算
  assertEquals(code(oldDiff).filter((l) => !code(diffSrc).includes(l)), [], "回滾檔的 cec_roster_diff 要等於舊版本體");
  assertEquals(code(diffSrc).filter((l) => !code(oldDiff).includes(l)), []);
  assertEquals(code(oldFind).filter((l) => !code(findingsSrc).includes(l)), []);
  assertEquals(code(findingsSrc).filter((l) => !code(oldFind).includes(l)), []);
  assert(oldDiff.includes("SET enable_nestloop = off"));
});

Deno.test("H4 不改 seed 與總表：本支沒有 UPDATE／DELETE／INSERT task_dispatches、不改表結構、不新增表、不排 cron", () => {
  const code = noComments(mig);
  assert(!/\b(UPDATE|DELETE FROM|INSERT INTO)\s+task_dispatches\b/.test(code));
  assert(!/\bALTER TABLE\b/.test(code), "不改任何表結構");
  assert(!/\bCREATE TABLE\b/.test(code), "不新增表");
  assert(!/cron\.schedule/.test(code), "本支不排程（投票日翻轉已有 PR-1 的排程）");
});

// ───────────────────────── I 觸發器成本 ─────────────────────────
Deno.test("I1 新增觸發器單次成本：被 WHEN 擋掉的列≈0（task_checks、edit_history、contributions 其他型別）；相干的列在毫秒以內（PGlite 計時，數字印出）", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2099-11-28', ARRAY['縣市議員'])");
  await db.exec("INSERT INTO regions VALUES (1, '臺北市', NULL, NULL, NULL)");
  await db.exec(`INSERT INTO politicians (id, name, region) VALUES ('${U(1)}', 'p', '臺北市')`);
  await db.exec(`INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id) VALUES (1, '${U(1)}', 2026, '縣市長', 'filed', 1)`);
  const N = 1000;
  const timeIt = async (sql: string) => {
    const t0 = performance.now();
    await db.exec(sql);
    return performance.now() - t0;
  };
  const measure = async (label: string, table: string, sql: string, reset: string) => {
    await db.exec(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await db.exec(reset);
    const base = await timeIt(sql);
    await db.exec(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await db.exec(reset);
    await db.exec("DELETE FROM dispatch_gap_events");
    const withTrg = await timeIt(sql);
    const perRow = (withTrg - base) / N;
    console.log(`[觸發器成本] ${label}：每列多約 ${perRow.toFixed(3)} ms（無觸發器 ${(base / N).toFixed(3)} ms／列，有觸發器 ${(withTrg / N).toFixed(3)} ms／列）`);
    return perRow;
  };
  const tc1 = await measure("task_checks INSERT（別的任務，WHEN 擋掉）", "task_checks", `INSERT INTO task_checks (task_id, outcome) SELECT 'auto:policy_missing:' || g, 'not_found' FROM generate_series(1, ${N}) g`, "DELETE FROM task_checks");
  const eh1 = await measure("edit_history INSERT（不是參選紀錄建立，WHEN 擋掉）", "edit_history", `INSERT INTO edit_history (table_name, record_id, field) SELECT 'tracking_logs', g::text, 'x' FROM generate_series(1, ${N}) g`, "DELETE FROM edit_history");
  const eh2 = await measure("edit_history INSERT（參選紀錄建立，入單位鍵）", "edit_history", `INSERT INTO edit_history (table_name, record_id, field) SELECT 'politician_elections', '1', '*' FROM generate_series(1, ${N})`, "DELETE FROM edit_history");
  const ds = await measure("contributions INSERT（district_seats，入單位鍵）", "contributions", `INSERT INTO contributions (status, contribution_type, payload) SELECT 'pending', 'district_seats', '{"election_id":2026,"election_type":"縣市議員","region":"臺北市"}' FROM generate_series(1, ${N})`, "DELETE FROM contributions");
  const c1 = await measure("contributions INSERT（其他型別，高頻）", "contributions", `INSERT INTO contributions (status, contribution_type, payload) SELECT 'pending', 'correction', '{"a":1}' FROM generate_series(1, ${N})`, "DELETE FROM contributions");
  for (const [n, v] of Object.entries({ tc1, eh1, eh2, ds, c1 })) assert(v < 2, `${n}：每列多 ${v.toFixed(3)} ms，超過 2ms`);
  assert(tc1 < 0.05 && eh1 < 0.05 && c1 < 0.05, "不相干的列（WHEN 擋掉）每列成本應接近 0");
  await db.close();
});
