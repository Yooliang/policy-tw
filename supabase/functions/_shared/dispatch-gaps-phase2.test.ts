/**
 * 派工臂事件驅動化 第 2 期 PR-1（migration 20261127044503_dispatch_gaps_phase2a.sql）守門。
 * 設計：docs/dispatch-arms-event-driven-plan.md 第 5 節「第 2 期」與附錄 A.1／A.3。
 *
 * 用 PGlite 真的把第 0 期兩支遷移、第 1 期與本支跑一遍；roster_unit_findings、roster_gap_units、補號次臂用「現行真定義」
 * （從各自最新的遷移檔原文抽出來），它們依賴的名冊差異函式與官方名冊表用假資料。驗：
 *   A 三支函式的最新定義沒被後來的遷移蓋掉；按鍵版與整表版本體只差鍵過濾（文字層，逐行）
 *   B 按鍵重算與整表函式限定同鍵的結果雙向 EXCEPT 為 0（三支；各種缺口形狀；補號次的分件 pN、重查）
 *   C 鍵的組法：task_id → scope_key 與資料欄位 → 鍵兩邊對得上（臺／台、分件、有無鄉鎮）
 *   D 觸發器：各來源表變動入列正確的單位鍵；不相關的更新不入列；舊三支臂的入列行為不變；批次表只入一筆
 *   E drain：變動後常駐表與整表結果一致，且證明走的是按鍵版
 *   F 雙軌比對：六支 shadow、差異為 0；總表輸出與前一版雙向 EXCEPT 為 0，drain 前後不變
 *   G 初始灌入：資料先在、遷移後才掛觸發器
 *   H 遷移文字守門
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText } from "./arms-pglite.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const PR1 = "20261126170000_dispatch_gaps_phase0.sql";
const PR2 = "20261126180000_dispatch_gaps_phase0b.sql";
const PH1A = "20261126193000_dispatch_gaps_phase1a.sql";
const MIG_NAME = "20261127044503_dispatch_gaps_phase2a.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const pr1 = await read(PR1);
const pr2 = await read(PR2);
const ph1a = await read(PH1A);
const mig = await read(MIG_NAME);
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ── 三支函式的最新定義（抽原文）──
const UNIFY_FILE = "20261101020000_roster_check_unify.sql";
const GAP_FILE = "20261103010000_roster_gap_units.sql";
const BALLOT_FILE = "20261109190000_cand_no_ladder_and_off_roster.sql";
const unifySql = await read(UNIFY_FILE);
const gapSql = await read(GAP_FILE);
const ballotSql = await read(BALLOT_FILE);
const findingsSrc = fnText(unifySql, "roster_unit_findings");
const gapUnitsSrc = fnText(gapSql, "roster_gap_units");
const ballotSrc = fnText(ballotSql, "contribution_auto_tasks_ballot_numbers");
const viewFile = await read("20261009070000_rep_district_ballot_unit.sql");
const unitsView = viewFile.slice(viewFile.indexOf("CREATE OR REPLACE VIEW ballot_number_units AS"), viewFile.indexOf("COMMENT ON VIEW ballot_number_units"));
assert(unitsView.length > 100, "抽不到 ballot_number_units 視圖");

// ── 假環境 ──
const ARM_FNS = [
  "dup", "legacy", "mismatch", "policy_dup", "not_running", "mayor_policies", "term_policies", "roster_villages", "township_gap",
  "region_gap", "elected_missing", "roster_cec_gap", "district_seats", "policy_elements", "lineage_candidates", "handover_missing",
  "lineage_roles", "lineage_links", "career_sources", "withdrawn_filing", "party_gap", "party_roster", "party_info",
  "placeholder_politicians", "election_results", "owner_mismatch", "regional_stats_missing", "issue_too_broad",
  "lineage_status", "lineage_stances", "lineage_events",
];
const ARM_NAMES = [
  "raw:policy_missing", "raw:profile_gap", "raw:policy_validity", "raw:progress_stale", "raw:candidacy_source_missing", "raw:roster_check",
  "raw:policy_election_missing", "raw:candidate_status_stale", ...ARM_FNS.slice(0, 14), "deadline_due", ...ARM_FNS.slice(14), "ballot_numbers",
  "manual_visitor", "manual_open", "traffic:progress_stale", "traffic:deadline_due", "traffic:term_policies",
];
const RET = "RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT) LANGUAGE sql STABLE";
const fakeSel = (src: string) => `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = '${src}'`;

const ENV_BASE = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE fake_rows (src TEXT, task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT);
${ARM_FNS.map((n) => `CREATE FUNCTION contribution_auto_tasks_${n}() ${RET} AS $f$ ${fakeSel(n)} $f$;`).join("\n")}
CREATE FUNCTION contribution_auto_tasks_raw() ${RET} AS $f$ ${fakeSel("raw")} $f$;
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
CREATE TABLE elections (id INTEGER PRIMARY KEY, election_date DATE NOT NULL);
CREATE TABLE regions (id INTEGER PRIMARY KEY, region TEXT, sub_region TEXT, village TEXT, admin_code TEXT);
CREATE TABLE politicians (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, birth_year INTEGER, status TEXT, region TEXT, merged_into UUID, party TEXT);
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
CREATE TABLE cec_candidates (id SERIAL PRIMARY KEY, name TEXT, synced_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE cec_registrations (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE cec_roster_units (url TEXT PRIMARY KEY, election_type TEXT NOT NULL, county TEXT NOT NULL, town TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  row_count INTEGER NOT NULL DEFAULT 0, fetched_at TIMESTAMPTZ);
CREATE TABLE cec_roster_2026 (id BIGSERIAL PRIMARY KEY, election_type TEXT, county TEXT, town TEXT NOT NULL DEFAULT '', district TEXT NOT NULL DEFAULT '', li_code TEXT NOT NULL DEFAULT '',
  name TEXT, name_key TEXT, cand_no INTEGER, party TEXT, birth TEXT, unit_key TEXT, unit_url TEXT);

-- 名冊差異（跨七支臂函式的合併）與官方名冊差異：換成「回放表」，兩邊（整表版、按鍵版）讀同一份
CREATE TABLE _findings (election_id INTEGER, election_type TEXT, county TEXT, town TEXT, voted BOOLEAN, kind TEXT, politician_id UUID, politician_election_id INTEGER,
  name TEXT, current_value JSONB, official_value JSONB, source_url TEXT, origin_task_id TEXT);
-- 回放表（直接灌的差異）加上「從參選紀錄長出來的差異」：party_basis = 'gap' 的參選紀錄就是一筆政黨差異，單位照真實的切法（roster_unify_town）。
-- 這樣測試能從參選紀錄的變動出發，驗事件→按鍵重算→常駐表，而不是拿差異資料自己的欄位組鍵再跟自己比
CREATE FUNCTION roster_diff_findings() RETURNS TABLE (election_id INTEGER, election_type TEXT, county TEXT, town TEXT, voted BOOLEAN, kind TEXT,
  politician_id UUID, politician_election_id INTEGER, name TEXT, current_value JSONB, official_value JSONB, source_url TEXT, origin_task_id TEXT)
  LANGUAGE plpgsql STABLE AS $f$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
    SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.politician_id, f.politician_election_id, f.name, f.current_value, f.official_value, f.source_url, f.origin_task_id FROM _findings f
    UNION ALL
    SELECT pe.election_id, pe.election_type, replace(COALESCE(rg.region, p.region), '臺', '台'),
           roster_unify_town(e.election_date < CURRENT_DATE, pe.election_type, rg.sub_region), (e.election_date < CURRENT_DATE),
           '政黨'::TEXT, p.id, pe.id, p.name, '{}'::JSONB, '{}'::JSONB, 'http://g'::TEXT, NULL::TEXT
      FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id JOIN elections e ON e.id = pe.election_id
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.party_basis = 'gap';
  END $f$;
CREATE TABLE _roster_diff (kind TEXT, election_type TEXT, county TEXT, town TEXT, unit TEXT, cand_no INTEGER, roster_name TEXT, roster_party TEXT,
  roster_birth TEXT, roster_url TEXT, roster_li_code TEXT, roster_id BIGINT);
CREATE FUNCTION cec_roster_diff() RETURNS TABLE (kind TEXT, election_type TEXT, county TEXT, town TEXT, unit TEXT, cand_no INTEGER, roster_name TEXT, roster_party TEXT,
  roster_birth TEXT, roster_url TEXT, roster_li_code TEXT, roster_id BIGINT)
  LANGUAGE sql STABLE AS $f$ SELECT * FROM _roster_diff $f$;

-- 補號次臂與名冊臂用到的小函式（各有自己的測試，這裡取最簡單的等價物）
CREATE FUNCTION roster_name_key(TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $f$ SELECT replace(replace($1, '臺', '台'), ' ', '') $f$;
CREATE FUNCTION cec_name_fuzzy_eq(TEXT, TEXT, TEXT, TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $f$ SELECT $1 = $2 $f$;
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
${unitsView}

-- 真定義：名冊差異彙總用的小函式、三支現行函式（從遷移原文抽出）
${fnText(unifySql, "roster_unify_town")}
${fnText(unifySql, "roster_unify_extra")}
${fnText(unifySql, "roster_unify_kinds_text")}
${fnText(unifySql, "roster_unify_text")}
${fnText(gapSql, "roster_gap_text")}
${findingsSrc}
${gapUnitsSrc}
${ballotSrc}
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
  if (o.dataBeforeMig) await db.exec(DATASET);
  if (o.mig !== false) await db.exec(mig);
  return db;
}

const one = async <T = unknown>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0]?.v;
const rows = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/**
 * 假資料（今天＝2026-11-26，2026 年選舉 11-28）。涵蓋：
 *  補號次：縣市議員（台北市兩個選舉區共 120 人、分件、有重複號次 → 重查）、縣市長（有人不在官方名冊 → 排除）、村里長（花蓮市兩個村里、有人不在名冊、重複號次）
 *  名冊差異：四個單位（含一個寫「臺」的已投票單位）
 *  名單缺口：台北市縣市長（缺人＋缺號次）、花蓮市村里長（缺人＋缺號次）
 */
const DATASET = `
INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2026-11-28');
INSERT INTO regions VALUES (1, '臺北市', NULL, NULL, NULL), (2, '臺北市', '第01選舉區', NULL, NULL), (3, '臺北市', '第02選舉區', NULL, NULL),
  (4, '花蓮縣', '花蓮市', '國盛里', 'A001'), (5, '花蓮縣', '花蓮市', '國光里', 'A002'), (6, '新北市', NULL, NULL, NULL);
INSERT INTO politicians (id, name, region)
  SELECT ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, '議員' || lpad(g::text, 3, '0'), '臺北市' FROM generate_series(1, 120) g;
INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id, cand_no)
  SELECT ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 2026, '縣市議員', 'filed', CASE WHEN g <= 60 THEN 2 ELSE 3 END,
         CASE WHEN g IN (1, 2, 61) THEN 1 WHEN g = 3 THEN 2 END FROM generate_series(1, 120) g;
INSERT INTO politicians (id, name, region) VALUES ('${U(11)}', '市長甲', '臺北市'), ('${U(12)}', '市長乙', '臺北市'), ('${U(13)}', '市長丙', '臺北市'), ('${U(14)}', '新北甲', '新北市');
INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id, cand_no) VALUES
  (1001, '${U(11)}', 2026, '縣市長', 'filed', 1, NULL), (1002, '${U(12)}', 2026, '縣市長', 'filed', 1, NULL),
  (1003, '${U(13)}', 2026, '縣市長', 'filed', 1, NULL), (1004, '${U(14)}', 2026, '縣市長', 'filed', 6, NULL);
INSERT INTO politicians (id, name, region)
  SELECT ('00000000-0000-0000-0002-' || lpad(g::text, 12, '0'))::uuid, '里長' || g, '花蓮縣' FROM generate_series(1, 8) g;
INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id, cand_no)
  SELECT ('00000000-0000-0000-0002-' || lpad(g::text, 12, '0'))::uuid, 2026, '村里長', 'filed', CASE WHEN g <= 4 THEN 4 ELSE 5 END,
         CASE WHEN g IN (1, 2) THEN 1 END FROM generate_series(1, 8) g;
-- 官方名冊鏡像：縣市長（市長丙不在名單上）、花蓮市村里長（只有里長1、2、5、6）
INSERT INTO cec_roster_units (url, election_type, county, town, status, row_count, fetched_at) VALUES
  ('u1', '縣市長', '臺北市', '', 'ok', 2, now()), ('u2', '村里長', '花蓮縣', '花蓮市', 'ok', 4, now());
INSERT INTO cec_roster_2026 (election_type, county, town, li_code, name, name_key, cand_no, unit_key, unit_url) VALUES
  ('縣市長', '臺北市', '', '', '市長甲', '市長甲', 1, '台北市', 'u1'), ('縣市長', '臺北市', '', '', '市長乙', '市長乙', 2, '台北市', 'u1'),
  ('村里長', '花蓮縣', '花蓮市', '001', '里長1', '里長1', 1, '花蓮縣|花蓮市', 'u2'), ('村里長', '花蓮縣', '花蓮市', '001', '里長2', '里長2', 2, '花蓮縣|花蓮市', 'u2'),
  ('村里長', '花蓮縣', '花蓮市', '002', '里長5', '里長5', 1, '花蓮縣|花蓮市', 'u2'), ('村里長', '花蓮縣', '花蓮市', '002', '里長6', '里長6', 2, '花蓮縣|花蓮市', 'u2');
INSERT INTO _roster_diff VALUES
  ('missing', '縣市長', '台北市', '', '台北市', 3, '市長丁', '甲黨', '0700101', 'http://j', NULL, NULL),
  ('missing', '村里長', '花蓮縣', '花蓮市', '花蓮縣花蓮市', 5, '里長九', '乙黨', '0650202', 'http://k', '001', NULL);
INSERT INTO _findings VALUES
  (2026, '縣市長', '台北市', '', false, '政黨', '${U(11)}', 1001, '市長甲', '{"party":null}', '{"party":"甲黨"}', 'http://a', NULL),
  (2026, '縣市長', '台北市', '', false, '缺人', NULL, NULL, '市長丁', '{"record":null}', '{"cand_no":3}', 'http://b', 'auto:x:1'),
  (2026, '村里長', '花蓮縣', '花蓮市', false, '鄉鎮', '${U(11)}', 1002, '里長1', '{}', '{}', 'http://c', NULL),
  (2026, '縣市議員', '新北市', '', false, '縣市', '${U(14)}', 1004, '新北甲', '{}', '{}', 'http://d', NULL),
  (2022, '縣市長', '臺北市', '', true, '結果', '${U(11)}', 1001, '市長甲', '{}', '{}', 'http://e', NULL),
  (2026, '鄉鎮市長', '花蓮縣', '', false, '鄉鎮', '${U(11)}', 1002, '市長候選1', '{}', '{}', 'http://f', NULL),
  (2022, '鄉鎮市民代表', '花蓮縣', '花蓮市', true, '結果', '${U(11)}', 1002, '代表1', '{}', '{}', 'http://h', NULL);
-- 鄉鎮市長（只到縣市；有重複號次 → 補號次的重查件）與鄉鎮市民代表（選舉區後綴「花蓮市第01選舉區」；有重複號次）
INSERT INTO regions VALUES (7, '花蓮縣', '花蓮市', NULL, NULL), (8, '花蓮縣', '花蓮市第01選舉區', NULL, NULL);
INSERT INTO politicians (id, name, region)
  SELECT ('00000000-0000-0000-0003-' || lpad(g::text, 12, '0'))::uuid, '市長候選' || g, '花蓮縣' FROM generate_series(1, 3) g;
INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id, cand_no)
  SELECT ('00000000-0000-0000-0003-' || lpad(g::text, 12, '0'))::uuid, 2026, '鄉鎮市長', 'filed', 7, CASE WHEN g IN (1, 2) THEN 1 END FROM generate_series(1, 3) g;
INSERT INTO politicians (id, name, region)
  SELECT ('00000000-0000-0000-0004-' || lpad(g::text, 12, '0'))::uuid, '代表' || g, '花蓮縣' FROM generate_series(1, 3) g;
INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id, cand_no)
  SELECT ('00000000-0000-0000-0004-' || lpad(g::text, 12, '0'))::uuid, 2026, '鄉鎮市民代表', 'filed', 8, CASE WHEN g IN (1, 2) THEN 1 END FROM generate_series(1, 3) g;
INSERT INTO cec_roster_units (url, election_type, county, town, status, row_count, fetched_at) VALUES
  ('u3', '鄉鎮市長', '花蓮縣', '', 'ok', 1, now()), ('u4', '鄉鎮市民代表', '花蓮縣', '', 'ok', 1, now());
INSERT INTO cec_roster_2026 (election_type, county, town, li_code, name, name_key, cand_no, unit_key, unit_url) VALUES
  ('鄉鎮市長', '花蓮縣', '', '', '市長候選3', '市長候選3', 3, '花蓮縣|花蓮市', 'u3'),
  ('鄉鎮市民代表', '花蓮縣', '', '', '代表3', '代表3', 3, '花蓮縣|花蓮市第01選舉區', 'u4');
INSERT INTO _roster_diff VALUES ('missing', '鄉鎮市長', '花蓮縣', '', '花蓮縣', 4, '某候選', '丙黨', '0700303', 'http://l', NULL, NULL);
`;

const ARMS3 = ["roster_unit_findings", "roster_gap_units", "ballot_numbers"] as const;
const FULL_FN: Record<string, string> = {
  roster_unit_findings: "roster_unit_findings()",
  roster_gap_units: "roster_gap_units()",
  ballot_numbers: "contribution_auto_tasks_ballot_numbers()",
};
const gapDiff = async (db: PGlite, arm: string): Promise<[number, number]> => {
  const full = `SELECT t.task_id AS gap_key, to_jsonb(t) - 'task_id' - 'arm' - 'opened_by' AS payload FROM ${FULL_FN[arm]} t`;
  const tab = `SELECT g.gap_key, g.payload FROM dispatch_gaps g WHERE g.arm = '${arm}' AND g.closed_at IS NULL`;
  const a = await one<number>(db, `SELECT count(*)::int AS v FROM (${full} EXCEPT ${tab}) x`);
  const b = await one<number>(db, `SELECT count(*)::int AS v FROM (${tab} EXCEPT ${full}) x`);
  return [a as number, b as number];
};
async function drainAll(db: PGlite) {
  for (let i = 0; i < 6; i++) {
    await db.exec("SELECT dispatch_gap_drain(500)");
    if ((await one<number>(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE processed_at IS NULL AND attempts < 5")) === 0) return;
  }
}
async function assertConsistent(db: PGlite, why: string) {
  for (const arm of ARMS3) assertEquals(await gapDiff(db, arm), [0, 0], `${why}：${arm} 常駐表與整臂結果對不上`);
}
const pending = async (db: PGlite) =>
  (await rows(db, "SELECT arm || '|' || scope_key AS k FROM dispatch_gap_events WHERE processed_at IS NULL ORDER BY 1")).map((r) => r.k as string);
const clearEvents = (db: PGlite) => db.exec("DELETE FROM dispatch_gap_events");
const gapCount = async (db: PGlite, arm: string) => await one<number>(db, `SELECT count(*)::int AS v FROM dispatch_gaps WHERE arm = '${arm}' AND closed_at IS NULL`);
const only = (xs: string[], arm: string) => xs.filter((x) => x.startsWith(arm + "|"));
/** pending() 是資料庫排序（碼位順序），期望值也先排序，免得寫的人要記字的先後 */
const S = (xs: string[]) => [...xs].sort();

// ───────────────────────── A 最新定義與文字層 ─────────────────────────
Deno.test("A1 三支函式的最新定義就是抽出來的那三支（後面沒有遷移再改它們）", async () => {
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  const latest = async (re: RegExp) => {
    let last = "";
    for (const f of files) {
      if (f >= MIG_NAME) continue;
      if (re.test(await read(f))) last = f;
    }
    return last;
  };
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION roster_unit_findings\(\)/), UNIFY_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION roster_gap_units\(\)/), GAP_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers\(\)/), BALLOT_FILE);
  assertEquals(await latest(/CREATE OR REPLACE VIEW ballot_number_units AS/), "20261009070000_rep_district_ballot_unit.sql");
  // 它們依賴、但本支沒有按鍵版的函式沒被改過（改了要回頭看鍵過濾還成不成立）
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION roster_diff_findings\(\)/), "20261101040000_roster_result_findings_voted_only.sql");
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION cec_roster_diff\(\)/), "20261031160000_cec_roster_2026.sql");
});

Deno.test("A2 按鍵版本體與整表版只差鍵過濾（逐行比對：整表版每一行都在按鍵版裡，按鍵版多出的行都跟鍵有關）", () => {
  const bodyLines = (fn: string) =>
    fn.split("\n").slice(1).map((l) => l.trim().replace(/^WITH /, "")).filter((l) => l && !l.startsWith("--") && !/^(AS \$|LANGUAGE|STABLE|RETURNS|\$\$|\$fn\$|\$function\$)/.test(l));
  const keyed = (name: string) => fnText(mig, name);
  const cases: Array<[string, string, string, number]> = [
    ["roster_unit_findings", findingsSrc, keyed("dispatch_gap_recompute_roster_unit_findings"), 1],
    ["roster_gap_units", gapUnitsSrc, keyed("dispatch_gap_recompute_roster_gap_units"), 1],
    ["ballot_numbers", ballotSrc, keyed("dispatch_gap_recompute_ballot_numbers"), 2],
  ];
  for (const [arm, full, key, nExtra] of cases) {
    const fl = bodyLines(full).filter((l) => !l.startsWith("CREATE OR REPLACE"));
    const kl = bodyLines(key).filter((l) => !l.startsWith("CREATE OR REPLACE"));
    const kset = new Set(kl);
    const fset = new Set(fl);
    assertEquals(fl.filter((l) => !kset.has(l)), [], `${arm}：整表版有、按鍵版沒有的行（不能少任何邏輯）`);
    const extra = kl.filter((l) => !fset.has(l));
    for (const l of extra) assert(/p_keys/.test(l) && /dispatch_gap_(roster|ballot)_unit_key/.test(l), `${arm}：按鍵版多出來的行必須是單位鍵過濾：${l}`);
    assertEquals(extra.length, nExtra, `${arm}：多出的鍵過濾行數`);
  }
});

// ───────────────────────── B 按鍵重算 = 整表限定同鍵 ─────────────────────────
Deno.test("B1 三支按鍵重算與整表函式限定同鍵的結果雙向 EXCEPT 為 0（各種缺口形狀；補號次分件與重查）", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  const counts: Record<string, number> = {};
  for (const arm of ARMS3) {
    const keysOf = (await rows(db, `SELECT DISTINCT dispatch_gap_scope_key('${arm}', task_id) AS k FROM ${FULL_FN[arm]} ORDER BY 1`)).map((r) => r.k as string);
    assert(keysOf.length >= 2, `${arm} 的假資料至少要有兩個單位，實際 ${keysOf.length}`);
    counts[arm] = keysOf.length;
    const fnName = `dispatch_gap_recompute_${arm}`;
    const ghost = arm === "ballot_numbers" ? "ballot:2026:縣市長:台北市:不存在" : "unit:2026:不存在市:縣市長";
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
  // 名冊差異：六個單位（含鄉鎮市長、已投票的鄉鎮市民代表）；名單缺口：台北市縣市長、花蓮市村里長、花蓮縣鄉鎮市長（缺人＋缺號次）、花蓮縣鄉鎮市民代表（缺號次）
  assertEquals(counts.roster_unit_findings, 6);
  assertEquals(counts.roster_gap_units, 4);
  await db.close();
});

Deno.test("B2 補號次：縣市議員 120 人拆三件（pN）同一個鍵、重查（重複號次）與缺口同單位同鍵；不在名冊的人被排除；按鍵版整單位算", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  const council = "ballot:2026:縣市議員:台北市:";
  const tasks = await rows(db, `SELECT task_id FROM contribution_auto_tasks_ballot_numbers() WHERE dispatch_gap_scope_key('ballot_numbers', task_id) = '${council}' ORDER BY 1`);
  const ids = tasks.map((r) => r.task_id as string);
  assert(ids.filter((i) => i.includes(":cand_no:")).length >= 3, `縣市議員要拆成三件以上，實際 ${JSON.stringify(ids)}`);
  assert(ids.some((i) => i.includes(":cand_no_recheck:")), "重複號次要出重查件");
  assert(ids.some((i) => i.endsWith(":p2")), "要有 p2 分件");
  // 縣市長：市長丙不在官方名冊 → 不在缺口 items；市長乙、甲在
  const mayor = await one<string>(db, `SELECT target::text AS v FROM contribution_auto_tasks_ballot_numbers() WHERE task_id LIKE 'auto:candidacy_source_missing:cand_no:2026:縣市長:台北市%'`);
  assert(mayor && mayor.includes("市長甲") && mayor.includes("市長乙") && !mayor.includes("市長丙"), `名冊排除：${mayor}`);
  // 單人不能算：只給單位鍵，整個單位的件數一樣
  const viaKey = await one<number>(db, `SELECT count(*)::int AS v FROM dispatch_gap_recompute_ballot_numbers(ARRAY['${council}'])`);
  assertEquals(viaKey, ids.length);
  // 村里長：兩個村里同一個鄉鎮 → 同一個鍵（派工單位是鄉鎮）
  assertEquals(await one(db, `SELECT count(DISTINCT dispatch_gap_scope_key('ballot_numbers', task_id))::int AS v FROM contribution_auto_tasks_ballot_numbers() WHERE task_id LIKE '%:村里長:%'`), 1);
  await db.close();
});

// ───────────────────────── C 鍵的組法 ─────────────────────────
Deno.test("C1 scope_key：task_id → 鍵與資料欄位 → 鍵兩邊對得上（臺／台、分件、有無鄉鎮）；三支舊臂的鍵規則沒變", async () => {
  const db = await freshDb();
  const sk = async (arm: string, tid: string) => await one<string>(db, "SELECT dispatch_gap_scope_key($1, $2) AS v", [arm, tid]);
  assertEquals(await sk("roster_unit_findings", "auto:roster_check:2026:臺北市:縣市長"), "unit:2026:台北市:縣市長");
  assertEquals(await sk("roster_gap_units", "auto:roster_check:2026:花蓮縣花蓮市:村里長"), "unit:2026:花蓮縣花蓮市:村里長");
  assertEquals(await sk("ballot_numbers", "auto:candidacy_source_missing:cand_no:2026:縣市議員:臺北市"), "ballot:2026:縣市議員:台北市:");
  assertEquals(await sk("ballot_numbers", "auto:candidacy_source_missing:cand_no:2026:縣市議員:臺北市:p3"), "ballot:2026:縣市議員:台北市:");
  assertEquals(await sk("ballot_numbers", "auto:candidacy_source_missing:cand_no_recheck:2026:村里長:花蓮縣:花蓮市:p2"), "ballot:2026:村里長:花蓮縣:花蓮市");
  assertEquals(await sk("ballot_numbers", "auto:candidacy_source_missing:cand_no:2026:村里長:花蓮縣:花蓮市"), "ballot:2026:村里長:花蓮縣:花蓮市");
  assertEquals(await sk("legacy", "auto:legacy_audit:abc"), "policy:abc");
  assertEquals(await sk("issue_too_broad", "auto:issue_too_broad:2026:台北市:交通"), "issue:2026:台北市:交通");
  assertEquals(await sk("district_seats", "auto:x:y"), "auto:x:y");
  // 欄位 → 鍵
  assertEquals(await one(db, "SELECT dispatch_gap_roster_unit_key(2026, '臺北市', '縣市長') AS v"), "unit:2026:台北市:縣市長");
  assertEquals(await one(db, "SELECT dispatch_gap_ballot_unit_key(2026, '縣市議員', '臺北市', NULL) AS v"), "ballot:2026:縣市議員:台北市:");
  // 一個單位會產生的所有可能鍵（已投票／未投票／村里長的鄉鎮）
  assertEquals(await one(db, "SELECT dispatch_gap_roster_keys(2026, '村里長', '臺北市', '文山區') AS v"), ["unit:2026:台北市文山區:村里長"], "村里長一律到鄉鎮");
  assertEquals(await one(db, "SELECT dispatch_gap_roster_keys(2026, '縣市長', '臺北市', NULL) AS v"), ["unit:2026:台北市:縣市長"]);
  assertEquals(await one(db, "SELECT dispatch_gap_roster_keys(2022, '鄉鎮市民代表', '花蓮縣', '花蓮市第01選舉區') AS v"), ["unit:2022:花蓮縣:鄉鎮市民代表", "unit:2022:花蓮縣花蓮市:鄉鎮市民代表"]);
  assertEquals(await one(db, "SELECT dispatch_gap_ballot_keys(2026, '鄉鎮市民代表', '花蓮縣', '花蓮市第01選舉區') AS v"),
    ["ballot:2026:鄉鎮市民代表:花蓮縣:", "ballot:2026:鄉鎮市民代表:花蓮縣:花蓮市", "ballot:2026:鄉鎮市民代表:花蓮縣:花蓮市第01選舉區"]);
  await db.close();
});

Deno.test("C2 每個實際產生的 task_id 的鍵，都落在「該單位的資料欄位可能組出的鍵」之內（事件不會漏）", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  // 補號次：用每個參選紀錄所在單位算出的可能鍵，涵蓋實際缺口的鍵
  const gapKeys = (await rows(db, "SELECT DISTINCT dispatch_gap_scope_key('ballot_numbers', task_id) AS k FROM contribution_auto_tasks_ballot_numbers()")).map((r) => r.k as string);
  const possible = new Set<string>();
  for (const r of await rows(db, `SELECT pe.election_id, pe.election_type, COALESCE(rg.region, p.region) AS county, rg.sub_region AS sub
                                    FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id LEFT JOIN regions rg ON rg.id = pe.region_id`)) {
    const ks = await one<string[]>(db, "SELECT dispatch_gap_ballot_keys($1, $2, $3, $4) AS v", [r.election_id, r.election_type, r.county, r.sub]);
    for (const k of ks!) possible.add(k);
  }
  for (const k of gapKeys) assert(possible.has(k), `補號次缺口的鍵 ${k} 不在任何參選紀錄單位的可能鍵裡（事件會漏）`);
  await db.close();
});

Deno.test("C3 名冊族從參選紀錄的變動出發：觸發器入列 → drain（整表函式弄壞，只能走按鍵版）→ 常駐表與整表輸出雙向 EXCEPT 為 0（含鄉鎮市長、鄉鎮市民代表選舉區後綴、村里長）", async () => {
  const db = await freshDb();
  await db.exec(DATASET);
  // 只留「從參選紀錄長出來」的差異與名冊缺口：把直接灌的回放資料清掉，這樣常駐表的每一個變化都必須由參選紀錄／人物／名冊單位的事件驅動
  await db.exec("DELETE FROM _findings; DELETE FROM _roster_diff;");
  await db.exec("SELECT dispatch_gap_enqueue('roster_unit_findings', '*', 'manual'), dispatch_gap_enqueue('roster_gap_units', '*', 'manual'), dispatch_gap_enqueue('ballot_numbers', '*', 'manual')");
  await drainAll(db);
  await assertConsistent(db, "基準（整臂）");
  await db.exec("CREATE FUNCTION boom() RETURNS TABLE (task_id TEXT) LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '整表版不該被呼叫'; END $$");
  const step = async (why: string, sql: string, expectKeys: string[]) => {
    await db.exec("UPDATE dispatch_gap_arm_keys SET full_fn = 'boom()' WHERE arm IN ('roster_unit_findings', 'roster_gap_units', 'ballot_numbers')");
    await db.exec(sql);
    const p = await pending(db);
    assertEquals(p.filter((k) => k.endsWith("|*")), [], `${why}：不該有整臂事件`);
    for (const k of expectKeys) assert(p.includes(k), `${why}：缺事件 ${k}，實際 ${JSON.stringify(p)}`);
    await drainAll(db);
    assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE last_error IS NOT NULL"), 0, `${why}：走了整表版`);
    for (const a of ARMS3) await db.exec(`UPDATE dispatch_gap_arm_keys SET full_fn = '${FULL_FN[a]}' WHERE arm = '${a}'`);
    await assertConsistent(db, why);
  };
  const before = async (arm: string) => (await gapCount(db, arm)) as number;
  // 縣市長、鄉鎮市長（沒有鄉鎮）、鄉鎮市民代表（未投票：單位到縣市）、村里長（單位到鄉鎮）各長出一筆政黨差異
  const n0 = await before("roster_unit_findings");
  await step("縣市長長出差異", `UPDATE politician_elections SET party_basis = 'gap' WHERE id = 1001`, ["roster_unit_findings|unit:2026:台北市:縣市長"]);
  await step("鄉鎮市長長出差異", `UPDATE politician_elections SET party_basis = 'gap' WHERE politician_id = '00000000-0000-0000-0003-000000000001'`, ["roster_unit_findings|unit:2026:花蓮縣:鄉鎮市長"]);
  await step("鄉鎮市民代表（選舉區後綴）長出差異", `UPDATE politician_elections SET party_basis = 'gap' WHERE politician_id = '00000000-0000-0000-0004-000000000001'`, ["roster_unit_findings|unit:2026:花蓮縣:鄉鎮市民代表"]);
  await step("村里長長出差異", `UPDATE politician_elections SET party_basis = 'gap' WHERE politician_id = '00000000-0000-0000-0002-000000000001'`, ["roster_unit_findings|unit:2026:花蓮縣花蓮市:村里長"]);
  assertEquals((await before("roster_unit_findings")) - n0, 4, "四個單位各多一個");
  // 已投票屆：2022 的鄉鎮市民代表（單位到縣市＋鄉鎮）
  await step("已投票的鄉鎮市民代表", `INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id, party_basis)
    VALUES ('00000000-0000-0000-0004-000000000002', 2022, '鄉鎮市民代表', 'elected', 8, 'gap')`, ["roster_unit_findings|unit:2022:花蓮縣花蓮市:鄉鎮市民代表"]);
  // 改地區：舊單位關、新單位開（新舊兩個單位都要入列）
  await step("縣市長改掛別的縣市", `UPDATE politician_elections SET region_id = 6 WHERE id = 1001`,
    ["roster_unit_findings|unit:2026:台北市:縣市長", "roster_unit_findings|unit:2026:新北市:縣市長"]);
  await step("人物改縣市（參選紀錄沒指地區時取人物縣市）", `UPDATE politician_elections SET region_id = NULL WHERE id = 1001; UPDATE politicians SET region = '宜蘭縣' WHERE id = '${U(11)}'`,
    ["roster_unit_findings|unit:2026:宜蘭縣:縣市長"]);
  await step("刪掉參選紀錄", `DELETE FROM politician_elections WHERE party_basis = 'gap' AND election_type = '鄉鎮市長'`, ["roster_unit_findings|unit:2026:花蓮縣:鄉鎮市長"]);
  // 名單缺口：缺號次（本站有人、名冊有號次）→ 補上號次後關
  const g0 = await before("roster_gap_units");
  assert(g0 >= 2, `名單缺口基準至少有縣市長與鄉鎮市民代表的缺號次，實際 ${g0}`);
  await step("市長乙補上號次（名單缺口少一個缺號次項）", `UPDATE politician_elections SET cand_no = 2 WHERE id = 1002`, ["roster_gap_units|unit:2026:台北市:縣市長"]);
  await step("代表 3 補上號次（單位的缺口全關）", `UPDATE politician_elections SET cand_no = 3 WHERE politician_id = '00000000-0000-0000-0004-000000000003'`,
    ["roster_gap_units|unit:2026:花蓮縣:鄉鎮市民代表"]);
  assert((await before("roster_gap_units")) < g0);
  // 補號次：鄉鎮市長與代表的重複號次修正（重查件關）、退選（單位內位移）
  await step("鄉鎮市長的重複號次修正", `UPDATE politician_elections SET cand_no = 2 WHERE politician_id = '00000000-0000-0000-0003-000000000002'`, ["ballot_numbers|ballot:2026:鄉鎮市長:花蓮縣:花蓮市"]);
  await step("代表退選", `UPDATE politician_elections SET candidacy_status = 'withdrawn' WHERE politician_id = '00000000-0000-0000-0004-000000000003'`,
    ["ballot_numbers|ballot:2026:鄉鎮市民代表:花蓮縣:花蓮市"]);
  // 名冊鏡像單位同步完成
  await db.exec("UPDATE dispatch_gap_arm_keys SET full_fn = 'boom()' WHERE arm = 'ballot_numbers'");
  await db.exec("UPDATE cec_roster_2026 SET name = '市長候選9', name_key = '市長候選9' WHERE election_type = '鄉鎮市長'");
  await db.exec("UPDATE cec_roster_units SET fetched_at = now() WHERE url = 'u3'");
  assert((await pending(db)).includes("ballot_numbers|*"), "名冊鏡像同步補號次整臂");
  assert((await pending(db)).includes("roster_gap_units|unit:2026:花蓮縣:鄉鎮市長"));
  await db.exec(`UPDATE dispatch_gap_arm_keys SET full_fn = '${FULL_FN.ballot_numbers}' WHERE arm = 'ballot_numbers'`);
  await drainAll(db);
  await assertConsistent(db, "名冊鏡像同步");
  await db.close();
});

Deno.test("C4 鄉鎮市民代表的名冊鏡像單位（town 是空的）：事件入名冊差異與名單缺口整臂，不用對不上的單位鍵", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2026-11-28')");
  await clearEvents(db);
  await db.exec("INSERT INTO cec_roster_units (url, election_type, county) VALUES ('u', '鄉鎮市民代表', '花蓮縣'), ('v', '直轄市山地原住民區民代表', '花蓮縣')");
  assertEquals(await pending(db), ["ballot_numbers|*", "roster_gap_units|*", "roster_unit_findings|*"]);
  await clearEvents(db);
  await db.exec("INSERT INTO cec_roster_units (url, election_type, county) VALUES ('w', '縣市長', '花蓮縣')");
  assertEquals(await pending(db), S(["ballot_numbers|*", "roster_gap_units|unit:2026:花蓮縣:縣市長", "roster_unit_findings|unit:2026:花蓮縣:縣市長"]));
  await db.close();
});

Deno.test("C5 set_mode：不是總表 UNION 分支的輔助函式臂不能切 live（說明原因）；shadow 與 off 照舊；總表分支臂可切 live 再切回", async () => {
  const db = await freshDb();
  for (const arm of ["roster_unit_findings", "roster_gap_units"]) {
    let msg = "";
    try {
      await db.exec(`SELECT dispatch_gap_set_mode('${arm}', 'live', 'x')`);
    } catch (e) {
      msg = String((e as Error).message);
    }
    assert(msg.includes("不是派工總表的 UNION 分支") && msg.includes("shadow 或 off"), `${arm} 切 live 要被擋並說明原因：${msg}`);
    assertEquals(await one(db, `SELECT dispatch_gap_set_mode('${arm}', 'shadow') AS v`), "shadow");
    assertEquals(await one(db, `SELECT dispatch_gap_set_mode('${arm}', 'off') AS v`), "off");
    assertEquals(await one(db, `SELECT dispatch_gap_set_mode('${arm}', 'shadow') AS v`), "shadow");
  }
  assertEquals(await one(db, "SELECT dispatch_gap_set_mode('ballot_numbers', 'live') AS v"), "live");
  assertEquals(await one(db, "SELECT dispatch_gap_set_mode('ballot_numbers', 'shadow') AS v"), "shadow");
  // 沒登記的臂仍照舊被擋
  let msg2 = "";
  try {
    await db.exec("SELECT dispatch_gap_set_mode('district_seats', 'shadow')");
  } catch (e) {
    msg2 = String((e as Error).message);
  }
  assert(msg2.includes("還沒登記"));
  await db.close();
});

Deno.test("C6 payload 的怪值不讓交件寫入失敗：超大 election_id、非數字、型別不對都只丟 WARNING；位數剛好 9 位以內才組鍵", async () => {
  const db = await freshDb();
  await clearEvents(db);
  for (const payload of [
    `{"election_id": 99999999999, "election_type": "縣市長", "region": "臺北市"}`,
    `{"election_id": "abc", "election_type": "縣市長", "region": "臺北市"}`,
    `{"election_id": 2026, "election_type": ["x"], "region": {"a": 1}}`,
    `{"election_id": 1234567890123456789012, "election_type": "縣市長", "region": "臺北市"}`,
  ]) {
    await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'candidacy', '${payload}'::jsonb)`);
  }
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM contributions"), 4, "四筆都寫進去了");
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'candidacy', '{"election_id": 999999999, "election_type": "縣市長", "region": "臺北市", "cand_no": 1}')`);
  assert((await pending(db)).includes("roster_unit_findings|unit:999999999:台北市:縣市長"));
  await db.close();
});

// ───────────────────────── D 觸發器 ─────────────────────────
Deno.test("D1 參選紀錄：新增、改號次、改縣市／職位（新舊單位都入）、刪除各入列正確的單位鍵；舊三支臂的入列行為沒變；不相關的欄位不入列", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2026-11-28')");
  await db.exec(`INSERT INTO regions VALUES (1, '臺北市', NULL, NULL, NULL), (2, '花蓮縣', '花蓮市', '國盛里', 'A001'), (3, '臺北市', '第01選舉區', NULL, NULL)`);
  await db.exec(`INSERT INTO politicians (id, name, region) VALUES ('${U(1)}', '甲', '臺北市'), ('${U(2)}', '乙', '花蓮縣')`);
  await clearEvents(db);

  await db.exec(`INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id) VALUES (1, '${U(1)}', 2026, '縣市長', 'filed', 1)`);
  assertEquals(await pending(db), [
    "ballot_numbers|ballot:2026:縣市長:台北市:", "roster_gap_units|unit:2026:台北市:縣市長", "roster_unit_findings|unit:2026:台北市:縣市長",
  ]);
  // 改號次：舊三支臂不入（欄位清單沒有 cand_no），名單族入
  await clearEvents(db);
  await db.exec("UPDATE politician_elections SET cand_no = 3 WHERE id = 1");
  assertEquals(await pending(db), [
    "ballot_numbers|ballot:2026:縣市長:台北市:", "roster_gap_units|unit:2026:台北市:縣市長", "roster_unit_findings|unit:2026:台北市:縣市長",
  ]);
  assertEquals(only(await pending(db), "mismatch").length + only(await pending(db), "issue_too_broad").length, 0);
  // 不在任何清單的欄位、值沒變
  await clearEvents(db);
  await db.exec("UPDATE politician_elections SET cand_no = 3 WHERE id = 1");
  assertEquals(await pending(db), [], "OF 欄位被 SET 但值沒變");
  // 改縣市（regions 1 → 3：臺北市縣市層級 → 臺北市選舉區）新舊兩個單位都入；改職位同理
  await db.exec(`UPDATE politician_elections SET election_type = '縣市議員', region_id = 3 WHERE id = 1`);
  assertEquals(await pending(db), S([
    "ballot_numbers|ballot:2026:縣市長:台北市:", "ballot_numbers|ballot:2026:縣市議員:台北市:", "ballot_numbers|ballot:2026:縣市議員:台北市:第01選舉區",
    "roster_gap_units|unit:2026:台北市:縣市長", "roster_gap_units|unit:2026:台北市:縣市議員", "roster_unit_findings|unit:2026:台北市:縣市長",
    "roster_unit_findings|unit:2026:台北市:縣市議員",
  ]));
  // 村里長：鄉鎮進鍵（村里長的名冊單位一律到鄉鎮；補號次的鄉鎮有「空／鄉鎮」兩種寫法）
  await clearEvents(db);
  await db.exec(`INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id) VALUES (2, '${U(2)}', 2026, '村里長', 'filed', 2)`);
  assertEquals(await pending(db), S([
    "ballot_numbers|ballot:2026:村里長:花蓮縣:", "ballot_numbers|ballot:2026:村里長:花蓮縣:花蓮市",
    "roster_gap_units|unit:2026:花蓮縣花蓮市:村里長", "roster_unit_findings|unit:2026:花蓮縣花蓮市:村里長",
  ]));
  // 刪除：用舊列
  await clearEvents(db);
  await db.exec("DELETE FROM politician_elections WHERE id = 2");
  assertEquals((await pending(db)).length, 4);
  // 2022（已投票）：名冊差異有鍵、沒有名單缺口（只有 2026）
  await clearEvents(db);
  await db.exec(`INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id) VALUES (3, '${U(1)}', 2022, '縣市長', 'elected', 1)`);
  assertEquals(only(await pending(db), "roster_gap_units"), []);
  assert(only(await pending(db), "roster_unit_findings").length >= 1);
  // 舊三支臂：改 candidacy_status 仍照舊入（沒有政見＝只有 issue 不入、mismatch 沒政見也不入；至少不會炸）
  await clearEvents(db);
  await db.exec(`INSERT INTO policies (id, politician_id, title, status, election_id) VALUES ('${U(101)}', '${U(1)}', 'a', 'Campaign Pledge', 2026)`);
  await clearEvents(db);
  await db.exec("UPDATE politician_elections SET candidacy_status = 'elected' WHERE id = 1");
  assert(await pending(db).then((x) => x.includes(`mismatch|policy:${U(101)}`) && x.includes("issue_too_broad|*")), "舊三支臂的入列行為不變");
  await db.close();
});

Deno.test("D2 人物：改名／縣市（新舊縣市都入）／出生年／政黨入名下每筆參選紀錄的單位；不相關欄位不入；值沒變不入", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2026-11-28')");
  await db.exec("INSERT INTO regions VALUES (1, '臺北市', NULL, NULL, NULL), (2, '新北市', NULL, NULL, NULL)");
  await db.exec(`INSERT INTO politicians (id, name, region) VALUES ('${U(1)}', '甲', '臺北市')`);
  await db.exec(`INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id) VALUES (1, '${U(1)}', 2026, '縣市長', 'filed', 1)`);
  await clearEvents(db);
  await db.exec(`UPDATE politicians SET status = 'x' WHERE id = '${U(1)}'`);
  assertEquals(await pending(db), [], "status 不在欄位清單");
  await db.exec(`UPDATE politicians SET name = name, birth_year = birth_year WHERE id = '${U(1)}'`);
  assertEquals(await pending(db), [], "值沒變");
  await db.exec(`UPDATE politicians SET birth_year = 1970 WHERE id = '${U(1)}'`);
  assertEquals(await pending(db), [
    "ballot_numbers|ballot:2026:縣市長:台北市:", "roster_gap_units|unit:2026:台北市:縣市長", "roster_unit_findings|unit:2026:台北市:縣市長",
  ]);
  await clearEvents(db);
  await db.exec(`UPDATE politicians SET party = '甲黨' WHERE id = '${U(1)}'`);
  assertEquals((await pending(db)).length, 3);
  // 改人物縣市：參選紀錄指到 regions（臺北市）→ 該單位入；新舊人物縣市（新北市）也各入（沒有 regions 時的縣市取自人物）
  await clearEvents(db);
  await db.exec(`UPDATE politicians SET region = '新北市' WHERE id = '${U(1)}'`);
  assertEquals(await pending(db), [
    "ballot_numbers|ballot:2026:縣市長:台北市:", "ballot_numbers|ballot:2026:縣市長:新北市:",
    "roster_gap_units|unit:2026:台北市:縣市長", "roster_gap_units|unit:2026:新北市:縣市長",
    "roster_unit_findings|unit:2026:台北市:縣市長", "roster_unit_findings|unit:2026:新北市:縣市長",
  ]);
  await db.close();
});

Deno.test("D3 交件：cand_numbers／candidacy／election_results／reassign_candidacy 從 payload 組單位，組不出就整臂；其他型別與 payload 改動不入列", async () => {
  const db = await freshDb();
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'correction', '{}'), ('pending', 'no_change', '{}')`);
  assertEquals(await pending(db), [], "其他型別不入列");
  await db.exec(`INSERT INTO contributions (id, status, contribution_type, payload) VALUES ('${U(901)}', 'pending', 'cand_numbers',
    '{"election_id": 2026, "election_type": "縣市議員", "region": "臺北市", "items": []}')`);
  assertEquals(await pending(db), [
    "ballot_numbers|ballot:2026:縣市議員:台北市:", "roster_gap_units|unit:2026:台北市:縣市議員", "roster_unit_findings|unit:2026:台北市:縣市議員",
  ]);
  await clearEvents(db);
  await db.exec(`UPDATE contributions SET payload = '{}'::jsonb WHERE id = '${U(901)}'`);
  assertEquals(await pending(db), [], "payload 不在欄位清單");
  await db.exec(`UPDATE contributions SET status = 'verified' WHERE id = '${U(901)}'`);
  assertEquals((await pending(db)).length, 3 + 0, "狀態變：payload 已被清空 → 組不出單位 → 名單族整臂（三支）");
  assertEquals(await pending(db), ["ballot_numbers|*", "roster_gap_units|*", "roster_unit_findings|*"]);
  // 鄉鎮層級的職位沒帶 sub_region：補號次整臂
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'candidacy',
    '{"election_id": 2026, "election_type": "鄉鎮市長", "region": "花蓮縣", "cand_no": 2}')`);
  assert((await pending(db)).includes("ballot_numbers|*"));
  assert((await pending(db)).includes("ballot_numbers|ballot:2026:鄉鎮市長:花蓮縣:"));
  // 縣市議員沒帶 sub_region 是正常的：不入整臂
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'candidacy',
    '{"election_id": 2026, "election_type": "縣市長", "region": "花蓮縣", "cand_no": 2}')`);
  assert(!(await pending(db)).includes("ballot_numbers|*"));
  // election_results 沒有單位 payload：名單族整臂
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'election_results', '{"items": [{"politician_election_id": 1}]}')`);
  assertEquals(await pending(db), ["ballot_numbers|*", "roster_gap_units|*", "roster_unit_findings|*"]);
  // 第 1 期的型別行為不變：policy_subtopics 仍只入 issue_too_broad
  await clearEvents(db);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'policy_subtopics', '{"election_id": 2026, "region": "臺北市", "issue": "長照 服務"}')`);
  assertEquals(await pending(db), ["issue_too_broad|issue:2026:台北市:長照_服務"]);
  await db.close();
});

Deno.test("D4 批次與設定表：名冊鏡像單位一列入該單位＋補號次整臂；cec_candidates／cec_registrations 一個語句最多一筆、沒影響列不入；其他設定表各入各的", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2026-11-28')");
  await clearEvents(db);
  // cec_roster_units：INSERT 也入；只改 attempted 這類不在欄位清單的欄位不入
  await db.exec("INSERT INTO cec_roster_units (url, election_type, county, town) VALUES ('u1', '村里長', '臺北市', '文山區'), ('u2', '縣市長', '花蓮縣', '')");
  assertEquals(await pending(db), S([
    "ballot_numbers|*", "roster_gap_units|unit:2026:台北市文山區:村里長", "roster_gap_units|unit:2026:花蓮縣:縣市長",
    "roster_unit_findings|unit:2026:台北市文山區:村里長", "roster_unit_findings|unit:2026:花蓮縣:縣市長",
  ]));
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now()");
  await db.exec("UPDATE cec_roster_units SET url = url WHERE url = 'u1'");
  assertEquals(await pending(db), [], "沒有改 OF 欄位");
  await db.exec("UPDATE cec_roster_units SET status = 'ok', row_count = 5, fetched_at = now() WHERE url = 'u1'");
  assertEquals((await pending(db)).length, 3);
  // 語句層級：cec_candidates 一次插 3 列＝一筆；插 0 列＝不入；更新／刪除同理
  await clearEvents(db);
  await db.exec("INSERT INTO cec_candidates (name) SELECT 'n' || g FROM generate_series(1, 3) g");
  assertEquals(await pending(db), ["roster_unit_findings|*"]);
  await clearEvents(db);
  await db.exec("INSERT INTO cec_candidates (name) SELECT 'x' FROM generate_series(1, 0)");
  await db.exec("UPDATE cec_candidates SET name = 'z' WHERE false");
  await db.exec("DELETE FROM cec_candidates WHERE false");
  assertEquals(await pending(db), [], "沒有影響到任何列");
  await db.exec("UPDATE cec_candidates SET synced_at = now()");
  assertEquals(await pending(db), ["roster_unit_findings|*"]);
  await clearEvents(db);
  await db.exec("DELETE FROM cec_candidates");
  assertEquals(await pending(db), ["roster_unit_findings|*"]);
  await clearEvents(db);
  await db.exec("INSERT INTO cec_registrations (name) SELECT 'r' || g FROM generate_series(1, 500) g");
  assertEquals(await pending(db), ["roster_unit_findings|*"], "500 列一個語句只入一筆");
  // 抽籤、名單公告日
  await clearEvents(db);
  await db.exec("INSERT INTO election_milestones (election_id, kind, on_date) VALUES (2026, 'draw', '2026-10-22')");
  assertEquals(await pending(db), ["ballot_numbers|*", "roster_gap_units|*", "roster_unit_findings|*"]);
  // 投票日變更：舊臂 mismatch 照舊，名單族加 roster_unit_findings 與 ballot_numbers（名單缺口只看 2026 官方名冊，不依投票日）
  await clearEvents(db);
  await db.exec("UPDATE elections SET election_date = '2026-11-29' WHERE id = 2026");
  assertEquals(await pending(db), ["ballot_numbers|*", "mismatch|*", "roster_unit_findings|*"]);
  // 參選狀態查證任務：只有 candidate_status_stale 才入
  await clearEvents(db);
  await db.exec(`INSERT INTO contribution_tasks (task_type, status, target) VALUES ('other', 'open', '{}'), ('candidate_status_stale', 'open', '{"origin": "cec_roster_extra"}')`);
  assertEquals(await pending(db), ["ballot_numbers|*"]);
  await clearEvents(db);
  await db.exec("UPDATE contribution_tasks SET status = 'closed' WHERE task_type = 'other'");
  assertEquals(await pending(db), [], "別的任務型別不入");
  await db.exec("UPDATE contribution_tasks SET status = 'closed' WHERE task_type = 'candidate_status_stale'");
  assertEquals(await pending(db), ["ballot_numbers|*"]);
  // 名單清查開關與項數上限
  await clearEvents(db);
  await db.exec("UPDATE roster_unify_settings SET max_items = 60");
  assertEquals(await pending(db), ["roster_gap_units|*", "roster_unit_findings|*"]);
  await db.close();
});

Deno.test("D5 events_enabled=false：新增的觸發器都不入列；打開後恢復；公開入列函式也尊重開關", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2026-11-28')");
  await db.exec("INSERT INTO regions VALUES (1, '臺北市', NULL, NULL, NULL)");
  await db.exec(`INSERT INTO politicians (id, name, region) VALUES ('${U(1)}', '甲', '臺北市')`);
  await clearEvents(db);
  await db.exec("UPDATE dispatch_gap_settings SET events_enabled = false");
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES ('${U(1)}', 2026, '縣市長', 'filed', 1)`);
  await db.exec(`UPDATE politicians SET birth_year = 1970`);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'cand_numbers', '{}')`);
  await db.exec("INSERT INTO cec_candidates (name) VALUES ('a')");
  await db.exec("INSERT INTO cec_roster_units (url, election_type, county) VALUES ('u', '縣市長', '臺北市')");
  await db.exec("INSERT INTO election_milestones (election_id, kind) VALUES (2026, 'draw')");
  await db.exec("UPDATE roster_unify_settings SET max_items = 70");
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue_units(2026, '縣市長', '臺北市', NULL, 'manual') AS v"), 0);
  assertEquals(await pending(db), []);
  await db.exec("UPDATE dispatch_gap_settings SET events_enabled = true");
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue_units(2026, '縣市長', '臺北市', NULL, 'manual') AS v"), 3);
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue_units(2026, '縣市長', '臺北市', NULL, 'manual') AS v"), 0, "同鍵未處理不重複");
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue_units(NULL, '縣市長', '臺北市') AS v"), 0, "參數不全不入列");
  await db.close();
});

Deno.test("D6 時間翻轉：投票日前後才入名冊差異與補號次整臂事件", async () => {
  const db = await freshDb();
  // roster 的 voted 用資料庫的 CURRENT_DATE（UTC），補號次窗口用台北日期（activity_today）：測試把兩者設成同一天，投票日用相對日期
  await db.exec("SET app.activity_today = ''");
  const today = await one<string>(db, "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS v");
  await db.exec(`SET app.activity_today = '${today}'`);
  await db.exec("INSERT INTO elections VALUES (2026, CURRENT_DATE + 10)");
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip_roster() AS v"), 0, "離投票日 10 天，什麼都不做");
  await db.exec("UPDATE elections SET election_date = CURRENT_DATE + 1");
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip_roster() AS v"), 1, "投票日前 1 天開始");
  assertEquals(await pending(db), ["ballot_numbers|*", "roster_unit_findings|*"]);
  await db.exec("UPDATE elections SET election_date = CURRENT_DATE - 3");
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip_roster() AS v"), 1, "投票日後 3 天內還要補（voted、窗口翻面）");
  await db.exec("UPDATE elections SET election_date = CURRENT_DATE - 4");
  await clearEvents(db);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip_roster() AS v"), 0);
  assertEquals(await pending(db), []);
  await db.close();
});

// ───────────────────────── E drain ─────────────────────────
Deno.test("E1 drain：資料變動後常駐表與整表結果一致（開、關、更新、分件位移），走的是按鍵版", async () => {
  const db = await freshDb();
  await db.exec(DATASET);   // 觸發器在，資料進來就入列
  await drainAll(db);
  await assertConsistent(db, "初次");
  assert((await gapCount(db, "ballot_numbers")) as number >= 5);
  // 假的差異資料表沒有觸發器（真環境由來源表的觸發器入列），手動整臂入列後 drain
  await db.exec("SELECT dispatch_gap_enqueue('roster_unit_findings', '*', 'manual'), dispatch_gap_enqueue('roster_gap_units', '*', 'manual')");
  await drainAll(db);
  await assertConsistent(db, "整臂事件");
  assertEquals(await gapCount(db, "roster_unit_findings"), 6);
  assertEquals(await gapCount(db, "roster_gap_units"), 4);

  // 整表函式弄壞：之後只有鍵事件才可以消化
  await db.exec("CREATE FUNCTION boom() RETURNS TABLE (task_id TEXT) LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '整表版不該被呼叫'; END $$");
  const breakFull = () => db.exec("UPDATE dispatch_gap_arm_keys SET full_fn = 'boom()' WHERE arm IN ('roster_unit_findings', 'roster_gap_units', 'ballot_numbers')");
  const fixFull = async () => {
    for (const a of ARMS3) await db.exec(`UPDATE dispatch_gap_arm_keys SET full_fn = '${FULL_FN[a]}' WHERE arm = '${a}'`);
  };
  const step = async (why: string, sql: string, expectNoStar = true) => {
    await breakFull();
    await db.exec(sql);
    if (expectNoStar) {
      assertEquals((await pending(db)).filter((k) => k.endsWith("|*")), [], `${why}：不該有整臂事件`);
    }
    await drainAll(db);
    assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE processed_at IS NULL"), 0, `${why}：事件要消化完`);
    assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE last_error IS NOT NULL"), 0, `${why}：不能有失敗的事件（走了整表版就會爆）`);
    await fixFull();
    await assertConsistent(db, why);
  };
  await step("議員 3 號補上號次（缺口少一人）", "UPDATE politician_elections SET cand_no = 9 WHERE politician_id = '00000000-0000-0000-0001-000000000004'");
  await step("議員退選（單位內人數變，後面的件整批位移）", "UPDATE politician_elections SET candidacy_status = 'withdrawn' WHERE politician_id = '00000000-0000-0000-0001-000000000010'");
  await step("議員新增一位（分件變多）", `INSERT INTO politicians (id, name, region) VALUES ('${U(77)}', '議員新', '臺北市');
    INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES ('${U(77)}', 2026, '縣市議員', 'filed', 2)`);
  await step("重複號次修正（重查件關）", "UPDATE politician_elections SET cand_no = 5 WHERE politician_id = '00000000-0000-0000-0001-000000000002'");
  await step("市長丙補上號次", "UPDATE politician_elections SET cand_no = 7 WHERE id = 1003");
  await step("里長 3 改名（人物改名影響內容）", "UPDATE politicians SET name = '里長三' WHERE id = '00000000-0000-0000-0002-000000000003'");
  await step("在途整批交件涵蓋一位（補號次先不派）", `INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'cand_numbers',
    '{"election_id": 2026, "election_type": "縣市議員", "region": "臺北市", "items": [{"politician_election_id": 20}, {"politician_election_id": 21}]}')`);
  // 名冊類：差異資料表直接改、再用公開入列函式入列該單位（同步函式結束處的用法）
  await step("名冊差異：新增一個單位的差異", `INSERT INTO _findings VALUES (2026, '縣市長', '宜蘭縣', '', false, '缺人', NULL, NULL, '某人', '{}', '{}', 'http://z', NULL);
    SELECT dispatch_gap_enqueue_units(2026, '縣市長', '宜蘭縣')`);
  assertEquals(await gapCount(db, "roster_unit_findings"), 7);
  await step("名冊差異：台北市縣市長的缺人補上（該單位只剩政黨）", `DELETE FROM _findings WHERE name = '市長丁';
    SELECT dispatch_gap_enqueue_units(2026, '縣市長', '臺北市')`);
  await step("名冊差異：花蓮市單位全部補完（缺口關閉）", `DELETE FROM _findings WHERE county = '花蓮縣' AND election_type = '村里長';
    DELETE FROM _roster_diff WHERE county = '花蓮縣' AND election_type = '村里長';
    SELECT dispatch_gap_enqueue_units(2026, '村里長', '花蓮縣', '花蓮市')`);
  // 名冊鏡像單位同步完（cec_roster_replace_unit 的最後一步）：名冊單位鍵＋補號次整臂（這一種事件只能走整臂，所以先把整表函式還原）
  await db.exec("DELETE FROM cec_roster_2026 WHERE name IN ('里長5', '里長6')");
  await db.exec("UPDATE cec_roster_units SET fetched_at = now() WHERE url = 'u2'");
  assert((await pending(db)).includes("ballot_numbers|*") && (await pending(db)).includes("roster_unit_findings|unit:2026:花蓮縣花蓮市:村里長"));
  await drainAll(db);
  await assertConsistent(db, "名冊鏡像同步（五、六號里長被排除在名冊外）");
  await db.close();
});

// ───────────────────────── F 雙軌與總表輸出 ─────────────────────────
const EXCEPT_BOTH = async (db: PGlite) => {
  const a = await one<number>(db, "SELECT count(*)::int AS v FROM (SELECT * FROM contribution_auto_tasks_arms() EXCEPT SELECT * FROM contribution_auto_tasks_arms_v20261126()) x");
  const b = await one<number>(db, "SELECT count(*)::int AS v FROM (SELECT * FROM contribution_auto_tasks_arms_v20261126() EXCEPT SELECT * FROM contribution_auto_tasks_arms()) x");
  return [a, b];
};

Deno.test("F1 shadow_run：六支臂（第 1 期三支＋本期三支）差異全 0；故意弄髒常駐表會被抓到", async () => {
  const db = await freshDb();
  await db.exec(DATASET);
  await db.exec("SELECT dispatch_gap_enqueue('roster_unit_findings', '*', 'manual'), dispatch_gap_enqueue('roster_gap_units', '*', 'manual')");
  await drainAll(db);
  assertEquals(await one(db, "SELECT dispatch_gap_shadow_run() AS v"), 6);
  const runs = await rows(db, "SELECT arm, missing, extra, changed, live_count, table_count, error FROM dispatch_gap_reconcile_runs WHERE mode = 'shadow' ORDER BY arm");
  assertEquals(runs.map((r) => r.arm), ["ballot_numbers", "issue_too_broad", "legacy", "mismatch", "roster_gap_units", "roster_unit_findings"]);
  for (const r of runs) {
    assertEquals([r.missing, r.extra, r.changed, r.error], [0, 0, 0, null], `${r.arm} 雙軌差異要為 0`);
    assertEquals(r.live_count, r.table_count);
  }
  await db.exec("UPDATE dispatch_gaps SET closed_at = now(), closed_reason = 'filled' WHERE arm = 'ballot_numbers' AND gap_key IN (SELECT gap_key FROM dispatch_gaps WHERE arm = 'ballot_numbers' AND closed_at IS NULL LIMIT 1)");
  await db.exec("SELECT dispatch_gap_shadow_run()");
  assertEquals(await one(db, "SELECT missing::int AS v FROM dispatch_gap_reconcile_runs WHERE mode = 'shadow' AND arm = 'ballot_numbers' ORDER BY id DESC LIMIT 1"), 1);
  await db.close();
});

Deno.test("F2 總表輸出與前一版（_v20261126）雙向 EXCEPT 為 0，補號次的真輸出在總表裡；drain 前後與常駐表被弄壞，總表輸出都不變", async () => {
  const db = await freshDb();
  await db.exec(DATASET);
  const ballotN = await one<number>(db, "SELECT count(*)::int AS v FROM contribution_auto_tasks_arms() WHERE arm = 'ballot_numbers'");
  assert((ballotN as number) >= 5, `總表要有補號次輸出，實際 ${ballotN}`);
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
  const snapshot = async () => (await rows(db, "SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY t.task_id)) AS h FROM contribution_auto_tasks_arms() t"))[0].h;
  const before = await snapshot();
  await drainAll(db);
  assert((await gapCount(db, "ballot_numbers")) as number >= 5, "drain 之後常駐表有資料");
  assertEquals(await snapshot(), before, "drain 只維護 dispatch_gaps，總表輸出不變");
  await db.exec("DELETE FROM dispatch_gaps");
  assertEquals(await snapshot(), before, "shadow 不讀常駐表");
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
  await db.close();
});

// ───────────────────────── G 初始灌入 ─────────────────────────
Deno.test("G1 資料先在、遷移後才掛觸發器：常駐表立刻與整表一致，補了三筆整臂事件；模式與登記", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  await assertConsistent(db, "遷移完");
  assert(((await gapCount(db, "ballot_numbers")) as number) >= 5);
  assertEquals(await gapCount(db, "roster_unit_findings"), 6);
  assertEquals(await gapCount(db, "roster_gap_units"), 4);
  assertEquals((await pending(db)).filter((k) => /^(ballot_numbers|roster_gap_units|roster_unit_findings)\|/.test(k)),
    ["ballot_numbers|*", "roster_gap_units|*", "roster_unit_findings|*"], "灌入與掛觸發器之間的空窗由整臂事件補");
  await drainAll(db);
  await assertConsistent(db, "整臂事件消化後");
  assertEquals(await rows(db, "SELECT arm, mode FROM dispatch_gap_arms WHERE mode <> 'off' ORDER BY arm"), [
    { arm: "ballot_numbers", mode: "shadow" }, { arm: "issue_too_broad", mode: "shadow" }, { arm: "legacy", mode: "shadow" },
    { arm: "mismatch", mode: "shadow" }, { arm: "roster_gap_units", mode: "shadow" }, { arm: "roster_unit_findings", mode: "shadow" },
  ]);
  assertEquals(await rows(db, "SELECT arm, recompute_fn FROM dispatch_gap_arm_keys WHERE arm IN ('ballot_numbers','roster_gap_units','roster_unit_findings') ORDER BY arm"), [
    { arm: "ballot_numbers", recompute_fn: "dispatch_gap_recompute_ballot_numbers(text[])" },
    { arm: "roster_gap_units", recompute_fn: "dispatch_gap_recompute_roster_gap_units(text[])" },
    { arm: "roster_unit_findings", recompute_fn: "dispatch_gap_recompute_roster_unit_findings(text[])" },
  ]);
  await db.close();
});

// ───────────────────────── H 遷移文字守門 ─────────────────────────
Deno.test("H1 觸發器：UPDATE 一律 OF 欄位或 WHEN；高頻表 contributions 有 WHEN；語句層級用轉換表；本支新掛 10 支（三支重建不計）", () => {
  const stmts = noComments(mig).split(/;\s*\n/).filter((s) => /CREATE TRIGGER/.test(s));
  assertEquals(stmts.length, 13, "三支重建＋十支新增");
  for (const s of stmts) {
    const head = s.replace(/\s+/g, " ");
    assert(/AFTER /.test(head), "只用 AFTER 觸發器（不擋寫入、不改列）");
    if (/FOR EACH STATEMENT/.test(head)) {
      assert(/REFERENCING (NEW|OLD) TABLE AS (new_rows|old_rows)/.test(head), `語句層級要用轉換表，沒有影響列就不入：${head}`);
      continue;
    }
    assert(/FOR EACH ROW/.test(head) && /EXECUTE FUNCTION dispatch_gap_on_change\(\)/.test(head));
    const pre = head.split(" ON ")[0];
    if (/\bUPDATE\b/.test(pre) && !/ON election_milestones\b|ON roster_unify_settings\b/.test(head)) assert(/UPDATE OF /.test(head), `UPDATE 必須帶 OF 欄位：${head}`);
  }
  const c = stmts.find((s) => /ON contributions\b/.test(s))!.replace(/\s+/g, " ");
  assert(/WHEN \(NEW\.contribution_type IN \('policy', 'policy_subtopics', 'cand_numbers', 'candidacy', 'election_results', 'reassign_candidacy'\)\)/.test(c));
  const t = stmts.find((s) => /ON contribution_tasks\b/.test(s))!.replace(/\s+/g, " ");
  assert(/WHEN \(NEW\.task_type = 'candidate_status_stale'\)/.test(t));
  // 重建的三支欄位清單是第 1 期的超集
  const p1 = ph1a.replace(/\s+/g, " ");
  for (const [tbl, cols] of [["politician_elections", ["candidacy_status", "election_id", "politician_id", "region_id", "election_type"]], ["politicians", ["name", "region", "merged_into"]]] as const) {
    const old = new RegExp(`UPDATE OF ([a-z_, ]+?)(?: OR DELETE)? ON ${tbl}\\b`).exec(p1)![1].split(",").map((x) => x.trim());
    const now = new RegExp(`UPDATE OF ([a-z_, ]+?)(?: OR DELETE)? ON ${tbl}\\b`).exec(stmts.find((s) => new RegExp(`ON ${tbl}\\b`).test(s))!.replace(/\s+/g, " "))![1].split(",").map((x) => x.trim());
    for (const col of old) assert(now.includes(col), `${tbl} 重建後少了第 1 期的欄位 ${col}`);
    for (const col of cols) assert(now.includes(col));
  }
});

Deno.test("H2 沒動總表、seed、三支被按鍵版複製的函式本體與 roster_diff_findings；註解裡沒有函式定義字樣；REVOKE／GRANT 齊", () => {
  const code = noComments(mig);
  for (const f of ["seed_auto_task_queue", "contribution_auto_tasks_arms", "contribution_auto_tasks_ballot_numbers", "roster_unit_findings", "roster_gap_units",
    "roster_diff_findings", "cec_roster_diff", "cec_roster_replace_unit", "dispatch_gap_drain", "dispatch_gap_reconcile_all", "dispatch_gap_shadow_run"]) {
    assert(!new RegExp(`CREATE OR REPLACE FUNCTION ${f}\\(`).test(code), `本支不能重定義 ${f}`);
  }
  for (const line of mig.split("\n").filter((l) => l.trim().startsWith("--"))) {
    assert(!/CREATE OR REPLACE FUNCTION\s+\w+/.test(line), `註解不能出現函式定義字樣：${line}`);
    assert(!/COMMENT ON FUNCTION\s+\w+/.test(line), `註解不能出現 COMMENT ON FUNCTION：${line}`);
  }
  for (const f of ["dispatch_gap_recompute_roster_unit_findings(TEXT[])", "dispatch_gap_recompute_roster_gap_units(TEXT[])", "dispatch_gap_recompute_ballot_numbers(TEXT[])",
    "dispatch_gap_on_change()", "dispatch_gap_on_batch_new()", "dispatch_gap_on_batch_old()", "dispatch_gap_date_flip_roster()", "dispatch_gap_scope_key(TEXT, TEXT)",
    "dispatch_gap_enqueue_units(INTEGER, TEXT, TEXT, TEXT, TEXT)", "dispatch_gap_enqueue_roster_units(INTEGER, TEXT, TEXT, TEXT, TEXT)"]) {
    assert(mig.includes(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon, authenticated;`), `缺 REVOKE ${f}`);
  }
  assert(mig.includes("GRANT EXECUTE ON FUNCTION dispatch_gap_enqueue_units(INTEGER, TEXT, TEXT, TEXT, TEXT) TO service_role;"));
  // 時間戳：大於第 1 期那支
  assert(MIG_NAME > PH1A);
});

Deno.test("H5 DDL 鎖的順序：三張熱表的觸發器最後一組、緊接結尾；觸發器計數以外的自我檢查、補整臂事件、排程都在第一個 CREATE TRIGGER 之前", () => {
  const code = noComments(mig);
  const trig = [...code.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => ({ name: m[1], i: m.index! }));
  assertEquals(trig.length, 13);
  const HOT = ["trg_dispatch_gap_politician_elections", "trg_dispatch_gap_politicians", "trg_dispatch_gap_contributions"];
  const hot = trig.filter((t) => HOT.includes(t.name));
  const others = trig.filter((t) => !HOT.includes(t.name));
  assertEquals(hot.length, 3);
  assert(Math.min(...hot.map((t) => t.i)) > Math.max(...others.map((t) => t.i)), "熱表觸發器要排在所有低頻表之後");
  const first = Math.min(...trig.map((t) => t.i));
  for (const marker of ["只有第 1 期三支加", "三支名單族臂的按鍵版沒有登記", "事件與 seed drain 兩個開關都要是開",
    "SELECT dispatch_gap_enqueue('ballot_numbers', '*', 'migration')", "cron.schedule('dispatch-gap-date-flip-roster'", "reconcile_all(ARRAY['roster_unit_findings'"]) {
    const i = code.indexOf(marker);
    assert(i >= 0 && i < first, `${marker} 要在第一個 CREATE TRIGGER 之前`);
  }
  // 最後一個觸發器之後只剩計數檢查與 NOTIFY
  const last = Math.max(...trig.map((t) => t.i));
  const afterLast = code.slice(code.indexOf(";", code.indexOf("EXECUTE FUNCTION", last)) + 1);
  assert(!/\b(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE)\b/.test(afterLast), `最後一個觸發器之後只該有計數檢查與 NOTIFY：${afterLast.slice(0, 200)}`);
  assert(afterLast.includes("預期共掛 22 支觸發器"));
});

Deno.test("H3 cron：date_flip_roster 排在 UTC 00:06 與 16:06，分鐘避開整十、:29、:35 與奇數分鐘", () => {
  const m = noComments(mig).match(/cron\.schedule\('dispatch-gap-date-flip-roster', '(\d+) ([0-9,]+) \* \* \*'/);
  assert(m, "找不到 cron.schedule");
  const min = Number(m![1]);
  assert(min % 10 !== 0 && min !== 29 && min !== 35 && min % 2 === 0, `分鐘 ${min} 不合規`);
  assertEquals(m![2], "0,16");
});

Deno.test("H4 按鍵版不改 seed 與總表：派工輸出不變的證據——本支沒有寫任何 UPDATE／DELETE 到 task_dispatches、dispatch 相關正式表", () => {
  const code = noComments(mig);
  assert(!/\b(UPDATE|DELETE FROM|INSERT INTO)\s+task_dispatches\b/.test(code));
  assert(!/\bALTER TABLE\b/.test(code), "不改任何表結構");
  assert(!/\bCREATE TABLE\b/.test(code), "不新增表");
});

// ───────────────────────── I 觸發器成本 ─────────────────────────
Deno.test("I1 觸發器單次成本：不相干的列≈0、參選紀錄相干的列在毫秒以內（PGlite 計時，數字印出）", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2026-11-28')");
  await db.exec("INSERT INTO regions VALUES (1, '臺北市', NULL, NULL, NULL)");
  await db.exec(`INSERT INTO politicians (id, name, region) SELECT gen_random_uuid(), 'p' || g, '臺北市' FROM generate_series(1, 50) g`);
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
  const c1 = await measure("contributions INSERT（其他型別，高頻）", "contributions",
    `INSERT INTO contributions (status, contribution_type, payload) SELECT 'pending', 'correction', '{"a":1}' FROM generate_series(1, ${N})`, "DELETE FROM contributions");
  const c2 = await measure("contributions INSERT（candidacy，入單位鍵）", "contributions",
    `INSERT INTO contributions (status, contribution_type, payload) SELECT 'pending', 'candidacy', '{"election_id":2026,"election_type":"縣市長","region":"臺北市","cand_no":1}' FROM generate_series(1, ${N})`, "DELETE FROM contributions");
  const pe1 = await measure("politician_elections INSERT（入名單族 3 支臂的單位鍵）", "politician_elections",
    `INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) SELECT (SELECT id FROM politicians LIMIT 1), 2026, '縣市長', 'filed', 1 FROM generate_series(1, ${N})`, "DELETE FROM politician_elections");
  const pe2 = await measure("politician_elections UPDATE 不在欄位清單的欄位", "politician_elections",
    `UPDATE politician_elections SET election_id = election_id`, `DELETE FROM politician_elections; INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) SELECT (SELECT id FROM politicians LIMIT 1), 2026, '縣市長', 'filed', 1 FROM generate_series(1, ${N})`);
  const pp = await measure("politicians UPDATE 不在欄位清單的欄位", "politicians", "UPDATE politicians SET status = 'x'", "UPDATE politicians SET status = NULL");
  for (const [n, v] of Object.entries({ c1, c2, pe1, pe2, pp })) assert(v < 2, `${n}：每列多 ${v.toFixed(3)} ms，超過 2ms`);
  assert(c1 < 0.05 && pp < 0.05, "不相干的列（WHEN 或 OF 擋掉）每列成本應接近 0");
  await db.close();
});
