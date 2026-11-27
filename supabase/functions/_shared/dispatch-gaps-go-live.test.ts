/**
 * 派工臂事件驅動化：legacy／mismatch／issue_too_broad／ballot_numbers 切 live
 * （migration 20261127081000_dispatch_gaps_go_live_phase1.sql）守門。
 *
 * 環境與 dispatch-gaps-phase0b.test.ts 同一套：臂函式是「回放 fake_rows」的假函式，常駐表、對帳、模式表、
 * 總表二段式（20261126180000）與 diff_sample 版對帳（20261127044115）跑真的。
 *   A 切完四支都是 live、其餘臂不動、ballot_numbers 的臂名是總表真分支
 *   B live 等價（最重要）：先全 off 跑總表當基準，跑遷移（對帳套用＋切 live），兩邊雙向 EXCEPT 為 0，且四支臂都有輸出
 *   C 切之前常駐表是過期的（缺列、多列、內容變了），遷移的對帳把它補齊，切完仍與基準雙向 EXCEPT 為 0
 *   D 真的在讀常駐表：某臂常駐表少一列，live 輸出就少那一列（即時算來源沒動）
 *   E 回滾：四支切回 shadow 後輸出回到即時算
 *   F 文字層：遷移檔名最新、四支都 live、先對帳再切、沒動函式；ballot_numbers 在 activity_arm_names 與登記表
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const PR1 = "20261126170000_dispatch_gaps_phase0.sql";
const PR2 = "20261126180000_dispatch_gaps_phase0b.sql";
const SAMPLE = "20261127044115_dispatch_gap_compare_diff_sample.sql";
const MIG_NAME = "20261127081000_dispatch_gaps_go_live_phase1.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const pr1 = await read(PR1);
const pr2 = await read(PR2);
const sample = await read(SAMPLE);
const mig = await read(MIG_NAME);
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const FOUR = ["legacy", "mismatch", "issue_too_broad", "ballot_numbers"];

// ── 假環境（同 dispatch-gaps-phase0b.test.ts）──
const ARM_FNS = [
  "dup", "legacy", "mismatch", "policy_dup", "not_running", "mayor_policies", "term_policies", "roster_villages", "township_gap",
  "region_gap", "elected_missing", "roster_cec_gap", "district_seats", "policy_elements", "lineage_candidates", "handover_missing",
  "lineage_roles", "lineage_links", "career_sources", "withdrawn_filing", "party_gap", "party_roster", "party_info",
  "placeholder_politicians", "election_results", "owner_mismatch", "ballot_numbers", "regional_stats_missing", "issue_too_broad",
  "lineage_status", "lineage_stances", "lineage_events",
];
const ARM_NAMES = [
  "raw:policy_missing", "raw:profile_gap", "raw:policy_validity", "raw:progress_stale", "raw:candidacy_source_missing", "raw:roster_check",
  "raw:policy_election_missing", "raw:candidate_status_stale", ...ARM_FNS.slice(0, 14), "deadline_due", ...ARM_FNS.slice(14),
  "manual_visitor", "manual_open", "traffic:progress_stale", "traffic:deadline_due", "traffic:term_policies",
];
const RET = "RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT) LANGUAGE sql STABLE";
const SEL = "SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows";

const ENV = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE fake_rows (src TEXT, task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT);
${ARM_FNS.map((n) => `CREATE FUNCTION contribution_auto_tasks_${n}() ${RET} AS $f$ ${SEL} WHERE src = '${n}' $f$;`).join("\n")}
CREATE FUNCTION contribution_auto_tasks_raw() ${RET} AS $f$ ${SEL} WHERE src = 'raw' $f$;
CREATE FUNCTION contribution_auto_tasks_deadline_due() ${RET} AS $f$ ${SEL} WHERE src = 'deadline_due' $f$;
CREATE FUNCTION contribution_auto_tasks_manual(p_visitor BOOLEAN) ${RET} AS $f$ ${SEL} WHERE src = CASE WHEN p_visitor THEN 'manual_visitor' ELSE 'manual_open' END $f$;
CREATE FUNCTION activity_arm_names() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $f$ SELECT ARRAY[${ARM_NAMES.map((n) => `'${n}'`).join(",")}]::TEXT[] $f$;
CREATE TABLE roster_flag (on_ BOOLEAN NOT NULL);
INSERT INTO roster_flag VALUES (false);
CREATE FUNCTION roster_unify_on() RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT on_ FROM roster_flag $f$;
CREATE FUNCTION roster_unit_findings() RETURNS TABLE (task_id TEXT, arm TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], county TEXT, voted BOOLEAN, items JSONB, items_count INTEGER, kinds JSONB)
  LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::TEXT[], NULL::TEXT, NULL::BOOLEAN, NULL::JSONB, NULL::INTEGER, NULL::JSONB WHERE false $f$;
CREATE FUNCTION roster_gap_units() RETURNS TABLE (task_id TEXT, arm TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], county TEXT, items JSONB, items_count INTEGER, kinds JSONB)
  LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::TEXT[], NULL::TEXT, NULL::JSONB, NULL::INTEGER, NULL::JSONB WHERE false $f$;
CREATE FUNCTION roster_gap_fresh_units() RETURNS SETOF TEXT LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT WHERE false $f$;
CREATE FUNCTION roster_scope_covers(TEXT, TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION roster_unify_text(INTEGER, BOOLEAN) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT 'u' $f$;
CREATE FUNCTION roster_unify_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT '{}'::JSONB $f$;
CREATE FUNCTION roster_gap_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT '{}'::JSONB $f$;
CREATE FUNCTION roster_gap_text() RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT 'g' $f$;
CREATE FUNCTION roster_gap_tid(TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT $1 $f$;
CREATE TABLE politicians (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, birth_year INTEGER, status TEXT);
CREATE TABLE politician_elections (id SERIAL PRIMARY KEY, politician_id UUID, election_id INTEGER, election_type TEXT, candidacy_status TEXT);
CREATE TABLE policies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), politician_id UUID, title TEXT);
CREATE TABLE contributions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id TEXT, status TEXT, payload JSONB);
CREATE TABLE tracking_logs (id SERIAL PRIMARY KEY, policy_id UUID);
CREATE FUNCTION politician_name_is_placeholder(TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT false $f$;
CREATE TABLE activity_rules (activity TEXT, enabled BOOLEAN, except_election_types TEXT[], election_types TEXT[]);
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
`;

// 真庫裡 ballot_numbers 由 20261127044503 登記進 dispatch_gap_arm_keys；測試環境沒載那支（牽涉名冊鏡像一大串表），照它的登記列補一筆
const REGISTER_BALLOT = `
INSERT INTO dispatch_gap_arm_keys (arm, full_fn, key_expr_desc, key_example)
VALUES ('ballot_numbers', 'contribution_auto_tasks_ballot_numbers()', 'test', 'auto:candidacy_source_missing:cand_no:2026:村里長:花蓮縣:花蓮市:p2')
ON CONFLICT (arm) DO NOTHING;`;

const L = (n: number) => `auto:legacy_audit:6f1c0000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const M = (n: number) => `auto:policy_election_mismatch:6f1c0000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const I = (k: string) => `auto:issue_too_broad:2026:臺北市:${k}`;
const B = (k: string) => `auto:candidacy_source_missing:cand_no:2026:村里長:花蓮縣:${k}`;

/** 四支臂各 2～3 列（含空陣列、NULL、中文地區）＋其他臂與 raw、手動，涵蓋總表各種形狀 */
const DATA = `
INSERT INTO fake_rows VALUES
 ('legacy', '${L(1)}', 'legacy_audit', '{"id":"a"}', 'need l1', ARRAY['x'], 1, '臺北市'),
 ('legacy', '${L(2)}', 'legacy_audit', '{"id":"b"}', 'need l2', NULL, 1, NULL),
 ('legacy', '${L(3)}', 'legacy_audit', '{"id":"c"}', 'need l3', ARRAY[]::TEXT[], 2, '新北市'),
 ('mismatch', '${M(1)}', 'policy_election_mismatch', '{"signals":["by_date"]}', 'need m1', ARRAY[]::TEXT[], 1, NULL),
 ('mismatch', '${M(2)}', 'policy_election_mismatch', '{"signals":["by_future","by_no_candidacy"]}', 'need m2', ARRAY['h1','h2'], 1, '高雄市'),
 ('issue_too_broad', '${I("交通")}', 'issue_too_broad', '{"election_id":2026,"region":"臺北市"}', 'need i1', ARRAY['h'], 2, '臺北市'),
 ('issue_too_broad', '${I("住宅")}', 'issue_too_broad', '{"election_id":2026,"region":"臺北市"}', 'need i2', NULL, 2, '臺北市'),
 ('ballot_numbers', '${B("花蓮市")}', 'candidacy_source_missing', '{"kind":"cand_no","units":[{"dup":[1]}]}', 'need b1', ARRAY['bulletin'], 1, '花蓮縣'),
 ('ballot_numbers', '${B("吉安鄉")}:p2', 'candidacy_source_missing', '{"kind":"cand_no","units":[]}', 'need b2', NULL, 1, NULL),
 ('raw', 'auto:policy_missing:p1', 'policy_missing', '{"election_id":2026}', 'need a', ARRAY['u1','u2'], 3, '臺北市'),
 ('raw', 'auto:progress_stale:s2', 'progress_stale', '{"policy_id":"pol-2"}', 'need b2', ARRAY[]::TEXT[], 2, '新北市'),
 ('deadline_due', 'auto:deadline_due:d1', 'deadline_due', '{"policy_id":"pol-1"}', 'need d', ARRAY['u4'], 2, NULL),
 ('township_gap', 'auto:township_gap:t1', 'township_gap', '{"election_id":2026}', 'need t', NULL, 1, '花蓮縣'),
 ('dup', 'auto:dup:z1', 'dup', '{"politician_id":"22222222-2222-2222-2222-222222222222"}', 'need z', ARRAY['y'], 1, NULL),
 ('manual_visitor', '33333333-3333-3333-3333-333333333333', 'question', '{}', 'q', NULL, 5, NULL),
 ('manual_open', '44444444-4444-4444-4444-444444444444', 'manual', '{}', 'm', ARRAY['k'], 5, NULL);
`;

const one = async <T = unknown>(db: PGlite, sql: string) => (await db.query<{ v: T }>(sql)).rows[0]?.v;
const n = async (db: PGlite, sql: string) => Number(await one(db, sql));
const armCount = (db: PGlite, arm: string) => n(db, `SELECT count(*) AS v FROM contribution_auto_tasks_arms() WHERE arm = '${arm}'`);
const fakeCount = (db: PGlite, arm: string) => n(db, `SELECT count(*) AS v FROM fake_rows WHERE src = '${arm}'`);

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV);
  await db.exec(pr1);
  await db.exec(pr2);
  await db.exec(sample);
  await db.exec(REGISTER_BALLOT);
  await db.exec(DATA);
  return db;
}

/** 基準：全 off 的總表輸出（即時算）存成 base 表 */
async function takeBase(db: PGlite): Promise<number> {
  await db.exec("CREATE TABLE base AS SELECT * FROM contribution_auto_tasks_arms()");
  return n(db, "SELECT count(*) AS v FROM base");
}
const exceptBoth = async (db: PGlite): Promise<[number, number]> => [
  await n(db, "SELECT count(*) AS v FROM (SELECT * FROM contribution_auto_tasks_arms() EXCEPT SELECT * FROM base) x"),
  await n(db, "SELECT count(*) AS v FROM (SELECT * FROM base EXCEPT SELECT * FROM contribution_auto_tasks_arms()) x"),
];

// ───────────────────────── A 模式 ─────────────────────────
Deno.test("A1 遷移前四支都不是 live；跑完四支 live、其餘臂模式不動；ballot_numbers 用本名（總表真分支）", async () => {
  const db = await freshDb();
  for (const a of FOUR) assert((await one(db, `SELECT gap_arm_mode('${a}') AS v`)) !== "live", `${a} 遷移前不該是 live`);
  const before = await n(db, "SELECT count(*) AS v FROM dispatch_gap_arms WHERE mode <> 'off'");
  await db.exec(mig);
  for (const a of FOUR) assertEquals(await one(db, `SELECT mode AS v FROM dispatch_gap_arms WHERE arm = '${a}'`), "live");
  assertEquals(await n(db, "SELECT count(*) AS v FROM dispatch_gap_arms WHERE mode = 'live'"), 4);
  assertEquals(await n(db, "SELECT count(*) AS v FROM dispatch_gap_arms WHERE mode <> 'off'"), before + 4);
  assertEquals(await one(db, "SELECT 'ballot_numbers' = ANY (activity_arm_names()) AS v"), true);
  assert(String(await one(db, "SELECT note AS v FROM dispatch_gap_arms WHERE arm = 'legacy'")).includes("直接切"));
});

// ───────────────────────── B live 等價 ─────────────────────────
Deno.test("B1 live 等價：先全 off 取基準，遷移（對帳套用＋切 live）後總表輸出與基準雙向 EXCEPT 為 0，四支臂都有輸出", async () => {
  const db = await freshDb();
  const total = await takeBase(db);
  assert(total >= 14, `基準應有輸出，實際 ${total}`);
  for (const a of FOUR) assert((await armCount(db, a)) >= 2, `${a} 基準至少 2 列`);
  await db.exec(mig);
  assertEquals(await exceptBoth(db), [0, 0]);
  assertEquals(await n(db, "SELECT count(*) AS v FROM contribution_auto_tasks_arms()"), total);
  for (const a of FOUR) {
    assertEquals(await armCount(db, a), await fakeCount(db, a), `${a} live 輸出列數＝即時來源`);
    assertEquals(await n(db, `SELECT count(*) AS v FROM dispatch_gaps WHERE arm = '${a}' AND closed_at IS NULL`), await fakeCount(db, a));
  }
});

// ───────────────────────── C 切之前常駐表是過期的 ─────────────────────────
Deno.test("C1 切之前常駐表過期（缺列、多列、內容變了）：遷移的對帳先補齊，切完仍等價", async () => {
  const db = await freshDb();
  // 先在 shadow 把常駐表對齊一次，再讓即時來源動起來，製造 missing／extra／changed
  for (const a of FOUR) await db.query(`SELECT dispatch_gap_set_mode('${a}', 'shadow')`);
  await db.query("SELECT * FROM dispatch_gap_reconcile_all(ARRAY['legacy','mismatch','issue_too_broad','ballot_numbers'])");
  await db.exec(`DELETE FROM fake_rows WHERE task_id = '${L(1)}'`);                                     // legacy：常駐表多一列（extra）
  await db.exec(`INSERT INTO fake_rows VALUES ('mismatch', '${M(9)}', 'policy_election_mismatch', '{}', 'new m', NULL, 1, NULL)`);  // missing
  await db.exec(`UPDATE fake_rows SET what_we_need = 'changed!' WHERE task_id = '${I("交通")}'`);        // changed
  await db.exec(`INSERT INTO fake_rows VALUES ('ballot_numbers', '${B("壽豐鄉")}', 'candidacy_source_missing', '{"kind":"cand_no"}', 'b3', NULL, 1, NULL)`);
  await db.exec("DELETE FROM dispatch_gap_reconcile_runs");
  // 基準：此刻即時算（模式是 shadow，總表照舊即時算）
  await takeBase(db);
  await db.exec(mig);
  assertEquals(await exceptBoth(db), [0, 0]);
  // 遷移裡的對帳有記錄，且套用過（四支各一列 mode＝reconcile）
  assertEquals(await n(db, "SELECT count(*) AS v FROM dispatch_gap_reconcile_runs WHERE mode = 'reconcile'"), 4);
  assertEquals(await n(db, "SELECT count(*) AS v FROM dispatch_gap_reconcile_runs WHERE mode = 'reconcile' AND applied"), 4);   // 四支各有一種差異，全部套用
});

// ───────────────────────── D 真的在讀常駐表 ─────────────────────────
Deno.test("D1 四支臂各自：常駐表少一列，live 輸出就少那一列；即時來源沒動", async () => {
  const db = await freshDb();
  await db.exec(mig);
  for (const a of FOUR) {
    const before = await armCount(db, a);
    const key = await one<string>(db, `SELECT gap_key AS v FROM dispatch_gaps WHERE arm = '${a}' AND closed_at IS NULL ORDER BY gap_key LIMIT 1`);
    await db.exec(`UPDATE dispatch_gaps SET closed_at = now(), closed_reason = 'filled' WHERE arm = '${a}' AND gap_key = '${key}'`);
    assertEquals(await armCount(db, a), before - 1, `${a}：關掉常駐表一列，輸出少一列`);
    assertEquals(await n(db, `SELECT count(*) AS v FROM contribution_auto_tasks_arms() WHERE task_id = '${key}'`), 0);
    assertEquals(await fakeCount(db, a), before, `${a}：即時來源沒動，證明總表在讀常駐表`);
  }
  // 其他臂照舊即時算
  await db.exec("DELETE FROM fake_rows WHERE src = 'township_gap'");
  assertEquals(await armCount(db, "township_gap"), 0);
});

// ───────────────────────── E 回滾 ─────────────────────────
Deno.test("E1 回滾：四支切回 shadow 後輸出回到即時算，常駐表被改的也不影響；再切回 off 同樣", async () => {
  const db = await freshDb();
  const total = await takeBase(db);
  await db.exec(mig);
  await db.exec(`UPDATE dispatch_gaps SET closed_at = now(), closed_reason = 'filled' WHERE arm = 'legacy'`);
  assert((await n(db, "SELECT count(*) AS v FROM contribution_auto_tasks_arms()")) < total, "live 下常駐表被關，輸出變少");
  for (const a of FOUR) await db.query(`SELECT dispatch_gap_set_mode('${a}', 'shadow', '回滾')`);
  assertEquals(await exceptBoth(db), [0, 0]);
  for (const a of FOUR) await db.query(`SELECT dispatch_gap_set_mode('${a}', 'off', '回滾')`);
  assertEquals(await exceptBoth(db), [0, 0]);
});

// ───────────────────────── F 文字層 ─────────────────────────
Deno.test("F1 遷移檔名唯一、時間戳大於 main 上最後一支（agy 廣播）與 phase2a", async () => {
  const names = [...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).filter((x) => x.startsWith("20261127081000"));
  assertEquals(names, [MIG_NAME]);
  assert(MIG_NAME > "20261127073000_history_bundle_rpc.sql");
  assert(MIG_NAME > "20261127061500_dispatch_gap_hourly_apply_live.sql");
  assert(MIG_NAME > "20261127052000_agy_login_realtime_broadcast.sql");
  assert(MIG_NAME > "20261127044503_dispatch_gaps_phase2a.sql");
});

Deno.test("F2 遷移：四支臂都先 reconcile（apply）再 set_mode live；沒有建立或取代任何函式、沒有排程與觸發器", () => {
  const code = noComments(mig);
  assert(/SET LOCAL work_mem = '16MB'/.test(code), "要放寬 work_mem");
  // 四支臂各自一個 DO 段，每段先對帳（apply）再切 live
  const blocks = code.split(/^DO \$\$/m).slice(1).filter((b) => b.includes("dispatch_gap_reconcile_arm"));
  assertEquals(blocks.length, 4, "四支臂各一段");
  assertEquals(blocks.map((b) => /v_arm\s+CONSTANT TEXT := '(\w+)'/.exec(b)?.[1]), FOUR);
  for (const b of blocks) {
    const rec = b.indexOf("dispatch_gap_reconcile_arm(v_arm, true, 'reconcile', '0 seconds')");
    const set = b.indexOf("dispatch_gap_set_mode(v_arm, 'live'");
    assert(rec > 0 && set > rec, "每段要先對帳再切 live");
  }
  assert(!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(code), "只切模式，不動函式");
  assert(!/CREATE\s+TRIGGER|cron\.schedule|net\.http/i.test(code));
  assert(/statement_timeout/.test(code));
  // 回滾說明四行都在檔頭
  for (const a of FOUR) assert(mig.includes(`dispatch_gap_set_mode('${a}'`) && mig.includes(`'shadow', '回滾'`), `${a} 回滾行`);
});

Deno.test("F3 ballot_numbers 是總表真分支：在 activity_arm_names() 與 dispatch_gap_arm_keys 登記（set_mode 的 live 守門才放行）", async () => {
  const names = await read("20261008165000_manual_tasks_as_arm.sql");
  assert(/CREATE OR REPLACE FUNCTION activity_arm_names\(\)[\s\S]*?'ballot_numbers'/.test(names));
  const p2a = await read("20261127044503_dispatch_gaps_phase2a.sql");
  assert(p2a.includes("('ballot_numbers', 'contribution_auto_tasks_ballot_numbers()'"), "phase2a 登記 ballot_numbers");
  assert(/IF p_mode = 'live' AND NOT \(p_arm = ANY \(activity_arm_names\(\)\)\)/.test(p2a), "set_mode 的 live 守門條件");
  for (const a of ["legacy", "mismatch", "issue_too_broad"]) assert(pr1.includes(`'${a}'`), `${a} 在第 0 期登記`);
});
