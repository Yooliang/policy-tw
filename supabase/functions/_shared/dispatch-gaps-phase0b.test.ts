/**
 * 派工臂事件驅動化 第 0 期 PR-2（migration 20261126180000_dispatch_gaps_phase0b.sql）守門。
 * 設計：docs/dispatch-arms-event-driven-plan.md 第 2.5～2.8 節、第 5 節第 0 期。
 *
 *   A 臂模式表：全部登記成 off、查不到＝off、set_mode 的檢查
 *   B 總表二段式：全 off 時新舊兩版輸出雙向 EXCEPT 為 0（PGlite、同一組假資料）；切 live 後讀常駐表、切回後相等
 *   C 前一版總表逐字保留、新版只多二段式的標記（文字層，抓抄錯）
 *   D seed 開頭 drain：預設關、拿掉標記區塊後與前一版逐行相同
 *   E 對帳：mode＝off 只記差異不改表；shadow／live 照補；shadow_run 只比非 off 的臂
 *   F cron：四支都在、分鐘避開整十／29／35／奇數、台北時間換算
 *   G 暫存量測：temp_bytes 欄位、程序每支臂一列
 *   H 觸發器函式補齊：politician_elections／politicians／contributions／tracking_logs 入列正確
 *   I 守門：沒掛觸發器到正式表
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const PR1 = "20261126170000_dispatch_gaps_phase0.sql";
const MIG_NAME = "20261126180000_dispatch_gaps_phase0b.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const pr1 = await read(PR1);
const mig = await read(MIG_NAME);
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ── 假環境：只放總表與本支遷移會碰到的東西，語意盡量簡單 ──
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

const ENV = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE fake_rows (src TEXT, task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT);
${ARM_FNS.map((n) => `CREATE FUNCTION contribution_auto_tasks_${n}() ${RET} AS $f$ SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = '${n}' $f$;`).join("\n")}
CREATE FUNCTION contribution_auto_tasks_raw() ${RET} AS $f$ SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = 'raw' $f$;
CREATE FUNCTION contribution_auto_tasks_deadline_due() ${RET} AS $f$ SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = 'deadline_due' $f$;
CREATE FUNCTION contribution_auto_tasks_manual(p_visitor BOOLEAN) ${RET} AS $f$ SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = CASE WHEN p_visitor THEN 'manual_visitor' ELSE 'manual_open' END $f$;
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

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV);
  await db.exec(pr1);
  await db.exec(mig);
  return db;
}

const one = async <T = unknown>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0]?.v;
const rows = async (db: PGlite, sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;

/** 一組涵蓋各種形狀的假資料：raw 的各型別（含 roster_check、progress_stale 與 deadline_due 同政見互斥）、各臂、手動、null 欄位 */
const SEED_ROWS = `
INSERT INTO fake_rows VALUES
 ('raw', 'auto:policy_missing:p1', 'policy_missing', '{"politician_id":"11111111-1111-1111-1111-111111111111","election_id":2026}', 'need a', ARRAY['u1','u2'], 3, '臺北市'),
 ('raw', 'auto:progress_stale:s1', 'progress_stale', '{"policy_id":"pol-1"}', 'need b', ARRAY['u3'], 2, NULL),
 ('raw', 'auto:progress_stale:s2', 'progress_stale', '{"policy_id":"pol-2"}', 'need b2', ARRAY[]::TEXT[], 2, '新北市'),
 ('raw', 'auto:roster_check:2026:x', 'roster_check', '{"election_type":"鄉鎮市長","election_id":2026}', 'need r', NULL, 1, '宜蘭縣'),
 ('deadline_due', 'auto:deadline_due:d1', 'deadline_due', '{"policy_id":"pol-1"}', 'need d', ARRAY['u4'], 2, NULL),
 ('legacy', 'auto:legacy_audit:6f1c0000-0000-0000-0000-000000000001', 'legacy_audit', '{"id":"a"}', 'need l1', ARRAY['x'], 1, '臺北市'),
 ('legacy', 'auto:legacy_audit:6f1c0000-0000-0000-0000-000000000002', 'legacy_audit', '{"id":"b"}', 'need l2', NULL, 1, NULL),
 ('mismatch', 'auto:policy_election_mismatch:6f1c0000-0000-0000-0000-000000000003', 'policy_election_mismatch', '{}', 'need m', ARRAY[]::TEXT[], 1, NULL),
 ('issue_too_broad', 'auto:issue_too_broad:2026:臺北市:交通', 'issue_too_broad', '{"election_id":2026,"region":"臺北市"}', 'need i', ARRAY['h'], 2, '臺北市'),
 ('township_gap', 'auto:township_gap:t1', 'township_gap', '{"election_id":2026}', 'need t', NULL, 1, '花蓮縣'),
 ('party_roster', 'auto:party_roster:q1', 'party_roster', '{}', 'need q', NULL, 1, NULL),
 ('dup', 'auto:dup:z1', 'dup', '{"politician_id":"22222222-2222-2222-2222-222222222222"}', 'need z', ARRAY['y'], 1, NULL),
 ('manual_visitor', '33333333-3333-3333-3333-333333333333', 'question', '{}', 'q', NULL, 5, NULL),
 ('manual_open', '44444444-4444-4444-4444-444444444444', 'manual', '{}', 'm', ARRAY['k'], 5, NULL),
 ('lineage_events', 'auto:lineage_event_missing:l:ab12cd34', 'lineage_event_missing', '{"lineage_id":"x"}', 'ev', NULL, 1, NULL);
`;

const EXCEPT_BOTH = async (db: PGlite) => {
  const a = await ints(db, `SELECT count(*)::int AS n FROM (SELECT * FROM contribution_auto_tasks_arms() EXCEPT SELECT * FROM contribution_auto_tasks_arms_v20261126()) x`);
  const b = await ints(db, `SELECT count(*)::int AS n FROM (SELECT * FROM contribution_auto_tasks_arms_v20261126() EXCEPT SELECT * FROM contribution_auto_tasks_arms()) x`);
  return [a, b];
};
const ints = async (db: PGlite, sql: string) => (await one<number>(db, sql.replace(/\bAS n\b/, "AS v"))) as number;

// ───────────────────────── A 臂模式表 ─────────────────────────
Deno.test("A1 臂模式表：總表所有臂（含 raw 八型與停用七支）都登記、全是 off；traffic:* 不登記", async () => {
  const db = await freshDb();
  const arms = (await rows(db, "SELECT arm, mode FROM dispatch_gap_arms ORDER BY arm")) as Array<{ arm: string; mode: string }>;
  const expected = ARM_NAMES.filter((n) => !n.startsWith("traffic:")).sort();
  assertEquals(arms.map((r) => r.arm), expected);
  assert(arms.every((r) => r.mode === "off"));
  assertEquals(arms.filter((r) => r.arm.startsWith("raw:")).length, 8);
  for (const t of ["township_gap", "region_gap", "elected_missing", "party_gap", "party_roster", "election_results", "owner_mismatch"]) {
    assert(arms.some((r) => r.arm === t), `缺停用臂 ${t}`);
  }
  assertEquals(await one(db, "SELECT relrowsecurity AS v FROM pg_class WHERE relname = 'dispatch_gap_arms'"), true);
  for (const role of ["anon", "authenticated"]) {
    assertEquals(await one(db, `SELECT has_table_privilege('${role}', 'dispatch_gap_arms', 'SELECT') AS v`), false);
  }
});

Deno.test("A2 gap_arm_mode：查不到＝off；set_mode 要求已登記的臂才能 shadow／live，壞值被擋", async () => {
  const db = await freshDb();
  assertEquals(await one(db, "SELECT gap_arm_mode('不存在的臂') AS v"), "off");
  assertEquals(await one(db, "SELECT gap_arm_mode('legacy') AS v"), "off");
  assertEquals(await one(db, "SELECT dispatch_gap_set_mode('legacy', 'shadow', 'x') AS v"), "shadow");
  assertEquals(await one(db, "SELECT gap_arm_mode('legacy') AS v"), "shadow");
  let threw = 0;
  for (const sql of ["SELECT dispatch_gap_set_mode('dup', 'live')", "SELECT dispatch_gap_set_mode('legacy', 'oops')"]) {
    try { await db.query(sql); } catch { threw++; }
  }
  assertEquals(threw, 2, "未登記 dispatch_gap_arm_keys 的臂不能切 live；壞模式要被擋");
  await db.query("SELECT dispatch_gap_set_mode('dup', 'off')");  // off 永遠可以
  let bad = false;
  try { await db.exec("UPDATE dispatch_gap_arms SET mode = 'bogus' WHERE arm = 'dup'"); } catch { bad = true; }
  assert(bad, "mode 欄有 CHECK");
});

// ───────────────────────── B 總表二段式 ─────────────────────────
Deno.test("B1 全部 off：新舊總表輸出雙向 EXCEPT 為 0，且資料不是空的", async () => {
  const db = await freshDb();
  await db.exec(SEED_ROWS);
  const n = await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms()");
  assert(n >= 12, `假資料應該有輸出，實際 ${n}`);
  assertEquals(n, await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms_v20261126()"));
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
  // 假資料裡 progress_stale s1 與 deadline_due 同一政見：兩版都要把它排掉
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE task_id = 'auto:progress_stale:s1'"), 0);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE task_id = 'auto:progress_stale:s2'"), 1);
});

Deno.test("B2 全部 off：旗標 gap.arms_all 開著、名單清查收斂開關開著，兩版也相同", async () => {
  const db = await freshDb();
  await db.exec(SEED_ROWS);
  await db.exec("SELECT set_config('gap.arms_all', 'on', false)");
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
  await db.exec("SELECT set_config('gap.arms_all', '', false)");
  await db.exec("UPDATE roster_flag SET on_ = true");
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
  // 開關開著時七支停用臂（township_gap、party_roster…）不出列
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE arm IN ('township_gap','party_roster')"), 0);
});

Deno.test("B3 模式只有 shadow 時總表輸出仍與前一版相同（shadow 不改派工來源）", async () => {
  const db = await freshDb();
  await db.exec(SEED_ROWS);
  await db.query("SELECT dispatch_gap_set_mode('legacy', 'shadow')");
  await db.query("SELECT dispatch_gap_set_mode('mismatch', 'shadow')");
  await db.query("SELECT * FROM dispatch_gap_reconcile_all()");
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
});

Deno.test("B4 live：legacy 改讀常駐表（內容原樣還原）、其他臂不動；切回 off 立刻退回即時算", async () => {
  const db = await freshDb();
  await db.exec(SEED_ROWS);
  await db.query("SELECT dispatch_gap_set_mode('legacy', 'shadow')");
  await db.query("SELECT * FROM dispatch_gap_sync('legacy', NULL, 'filled')");
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gaps WHERE arm = 'legacy' AND closed_at IS NULL"), 2);
  await db.query("SELECT dispatch_gap_set_mode('legacy', 'live')");
  // 常駐表的內容原樣還原成臂函式輸出的形狀（含空陣列、NULL、reward、region）：live 與即時算逐列相同
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
  // 即時算的來源變了，live 仍讀常駐表（證明真的改讀它）
  await db.exec("DELETE FROM fake_rows WHERE src = 'legacy' AND task_id LIKE '%0001'");
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE arm = 'legacy'"), 2);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms_v20261126() WHERE arm = 'legacy'"), 1);
  // 其他臂不受影響
  assertEquals(
    await ints(db, "SELECT count(*)::int AS n FROM (SELECT * FROM contribution_auto_tasks_arms() WHERE arm <> 'legacy' EXCEPT SELECT * FROM contribution_auto_tasks_arms_v20261126() WHERE arm <> 'legacy') x"),
    0,
  );
  // 關著的缺口（closed_at 有值）不出列
  await db.exec("UPDATE dispatch_gaps SET closed_at = now(), closed_reason = 'filled' WHERE arm = 'legacy' AND gap_key LIKE '%0002'");
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE arm = 'legacy'"), 1);
  // 切回 off：退回即時算
  await db.query("SELECT dispatch_gap_set_mode('legacy', 'off')");
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
});

Deno.test("B5 raw 與 deadline_due 的 live：各自的 CTE 二選一，progress_stale 與 deadline_due 同政見互斥仍成立", async () => {
  const db = await freshDb();
  await db.exec(SEED_ROWS);
  // 直接放常駐表的列（模擬事件驅動算好的）
  await db.exec(`
    INSERT INTO dispatch_gaps (arm, gap_key, scope_key, payload) VALUES
     ('raw:progress_stale', 'auto:progress_stale:live1', 'policy:live1', '{"task_type":"progress_stale","target":{"policy_id":"pol-9"},"what_we_need":"L","hint_sources":["a"],"reward":2,"region":null}'),
     ('deadline_due', 'auto:deadline_due:live9', 'policy:live9', '{"task_type":"deadline_due","target":{"policy_id":"pol-9"},"what_we_need":"D","hint_sources":null,"reward":2,"region":null}');
    UPDATE dispatch_gap_arms SET mode = 'live' WHERE arm IN ('raw:progress_stale', 'deadline_due');
  `);
  const ids = (await rows(db, "SELECT task_id FROM contribution_auto_tasks_arms() WHERE task_type IN ('progress_stale','deadline_due') ORDER BY 1")).map((r) => r.task_id);
  // 即時算的 progress_stale／deadline_due 都被常駐表取代；常駐表的 progress_stale（pol-9）與 deadline_due（pol-9）同政見 → progress_stale 被排掉
  assertEquals(ids, ["auto:deadline_due:live9"]);
  // 其他 raw 型別（policy_missing、roster_check）不受影響，仍即時算
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE task_id = 'auto:policy_missing:p1'"), 1);
});

// ───────────────────────── C 文字層：前一版逐字保留 ─────────────────────────
const fnBody = (src: string, name: string) => {
  const re = new RegExp(`^CREATE OR REPLACE FUNCTION ${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`, "m");
  const m = src.match(re);
  assert(m, `找不到 ${name}`);
  return m![0];
};

Deno.test("C1 前一版總表＝20261120170000 的定義逐字保留（只改函式名）", async () => {
  const prev = await read("20261120170000_lineage_arms_start_date.sql");
  const oldDef = fnBody(prev, "contribution_auto_tasks_arms");
  const kept = fnBody(mig, "contribution_auto_tasks_arms_v20261126");
  assertEquals(kept.replace("contribution_auto_tasks_arms_v20261126()", "contribution_auto_tasks_arms()"), oldDef);
});

Deno.test("C2 新版總表拿掉二段式標記後與前一版逐字相同（只多二段式，沒改別的）", async () => {
  const prev = await read("20261120170000_lineage_arms_start_date.sql");
  const oldDef = fnBody(prev, "contribution_auto_tasks_arms");
  let nw = fnBody(mig, "contribution_auto_tasks_arms");
  // ① 開頭的 live_arms CTE 與兩個 CTE 的二選一
  nw = nw.replace(/WITH -- >>> 缺口二段式[^\n]*\n[\s\S]*?-- <<< 缺口二段式\n       raw AS \(SELECT r0\.\*[\s\S]*?WHERE g\.arm = 'deadline_due' AND EXISTS \(SELECT 1 FROM live_arms l WHERE l\.arm = 'deadline_due'\)\),\n/,
    "WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),\n       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),\n");
  // ② 各臂分支的「沒被切成 live」條件
  nw = nw.replace(/ AND NOT EXISTS \(SELECT 1 FROM live_arms l WHERE l\.arm = '[a-z_]+'\)/g, "");
  nw = nw.replace(/ WHERE NOT EXISTS \(SELECT 1 FROM live_arms l WHERE l\.arm = '[a-z_]+'\)/g, "");
  // ③ 共用的 live 分支
  nw = nw.replace(/  -- >>> 缺口二段式：模式是 live 的臂[\s\S]*?  -- <<< 缺口二段式\n/, "");
  assertEquals(nw, oldDef.replace(/COMMENT[\s\S]*$/, ""));
});

Deno.test("C3 新版總表每支登記的臂分支都有二段式條件（不漏）", async () => {
  const nw = fnBody(mig, "contribution_auto_tasks_arms");
  for (const n of ARM_FNS) {
    assert(new RegExp(`'${n}' AS arm, t\\.\\* FROM contribution_auto_tasks_${n}\\(\\) t WHERE [^\\n]*l\\.arm = '${n}'`).test(nw), `${n} 分支缺二段式條件`);
  }
  for (const n of ["manual_visitor", "manual_open"]) assert(new RegExp(`'${n}' AS arm[^\\n]*l\\.arm = '${n}'`).test(nw), `${n} 缺條件`);
  assert(nw.includes("SET work_mem = '16MB'"), "總表要帶 SET work_mem");
});

// ───────────────────────── D seed 開頭 drain ─────────────────────────
Deno.test("D1 seed：拿掉標記區塊後與 20261126150000 的定義逐字相同；兩個 SET 帶著走", async () => {
  const prev = await read("20261126150000_seed_arm_timings.sql");
  const oldSeed = fnBody(prev, "seed_auto_task_queue");
  const nw = fnBody(mig, "seed_auto_task_queue");
  assert(nw.includes("SET statement_timeout = '280s'") && nw.includes("SET work_mem = '16MB'"), "seed 要帶兩個 SET");
  const stripped = nw.replace(/  -- >>> 缺口表 drain[\s\S]*?  -- <<< 缺口表 drain\n/, "");
  assertEquals(stripped, oldSeed);
  assert(/IF dispatch_gap_seed_drain_enabled\(\) THEN/.test(nw), "drain 要受總開關控制");
  assert(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'dispatch_gap_drain/.test(nw), "drain 失敗只丟 WARNING");
  // drain 在整個 seed 最前面（BEGIN 之後第一件事）
  const body = nw.slice(nw.indexOf("BEGIN\n"));
  assert(body.indexOf("dispatch_gap_drain()") < body.indexOf("DROP TABLE IF EXISTS _gaps"), "drain 要在算總表之前");
});

Deno.test("D2 總開關預設關；打開後函式回 true；設定表缺列也當關", async () => {
  const db = await freshDb();
  assertEquals(await one(db, "SELECT dispatch_gap_seed_drain_enabled() AS v"), false);
  assertEquals(await one(db, "SELECT seed_drain_enabled AS v FROM dispatch_gap_settings WHERE id = 1"), false);
  await db.exec("UPDATE dispatch_gap_settings SET seed_drain_enabled = true WHERE id = 1");
  assertEquals(await one(db, "SELECT dispatch_gap_seed_drain_enabled() AS v"), true);
  await db.exec("DELETE FROM dispatch_gap_settings");
  assertEquals(await one(db, "SELECT dispatch_gap_seed_drain_enabled() AS v"), false);
});

// ───────────────────────── E 對帳與雙軌 ─────────────────────────
Deno.test("E1 mode＝off 的臂對帳只記差異、不改常駐表；shadow 的臂照補", async () => {
  const db = await freshDb();
  await db.exec(SEED_ROWS);
  // 全 off：對帳會記 missing（臂有、表沒有），但表仍是空的
  const r1 = await rows(db, "SELECT arm, missing, applied FROM dispatch_gap_reconcile_all() ORDER BY arm");
  const legacy = r1.find((r) => r.arm === "legacy")!;
  assertEquals(Number(legacy.missing), 2);
  assertEquals(legacy.applied, false);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gaps"), 0);
  // 切成 shadow 後對帳才補開
  await db.query("SELECT dispatch_gap_set_mode('legacy', 'shadow')");
  const r2 = await rows(db, "SELECT arm, missing, applied FROM dispatch_gap_reconcile_all(ARRAY['legacy','mismatch']) ORDER BY arm");
  assertEquals(r2.find((r) => r.arm === "legacy")!.applied, true);
  assertEquals(r2.find((r) => r.arm === "mismatch")!.applied, false, "mismatch 還是 off，只記差異");
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gaps WHERE arm = 'legacy' AND closed_at IS NULL"), 2);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gaps WHERE arm = 'mismatch'"), 0);
  // 再對一次：legacy 已一致
  const r3 = await rows(db, "SELECT arm, missing, extra, changed FROM dispatch_gap_reconcile_all(ARRAY['legacy'])");
  assertEquals([Number(r3[0].missing), Number(r3[0].extra), Number(r3[0].changed)], [0, 0, 0]);
});

Deno.test("E2 shadow_run（雙軌 cron 入口）：全 off 什麼都不做、不寫 reconcile_runs；有 shadow 臂才比", async () => {
  const db = await freshDb();
  await db.exec(SEED_ROWS);
  assertEquals(await one(db, "SELECT dispatch_gap_shadow_run() AS v"), 0);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gap_reconcile_runs"), 0);
  await db.query("SELECT dispatch_gap_set_mode('legacy', 'shadow')");
  assertEquals(await one(db, "SELECT dispatch_gap_shadow_run() AS v"), 1);
  const r = await rows(db, "SELECT arm, mode, missing, applied FROM dispatch_gap_reconcile_runs");
  assertEquals(r.length, 1);
  assertEquals([r[0].arm, r[0].mode, r[0].applied], ["legacy", "shadow", false]);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gaps"), 0, "雙軌比對不改常駐表");
});

Deno.test("E3 保留清理：events 處理完 >7 天、reconcile_runs >30 天；未處理與新的都留", async () => {
  const db = await freshDb();
  await db.exec(`
    INSERT INTO dispatch_gap_events (arm, scope_key, kind, enqueued_at, processed_at) VALUES
      ('legacy', 'policy:a', 'insert', now() - interval '9 days', now() - interval '8 days'),
      ('legacy', 'policy:b', 'insert', now() - interval '3 days', now() - interval '2 days'),
      ('legacy', 'policy:c', 'insert', now() - interval '20 days', NULL);
    INSERT INTO dispatch_gap_reconcile_runs (arm, mode, run_at) VALUES ('legacy', 'shadow', now() - interval '31 days'), ('legacy', 'shadow', now() - interval '29 days');
  `);
  assertEquals(await one(db, "SELECT dispatch_gap_retention() AS v"), 2);
  assertEquals((await rows(db, "SELECT scope_key FROM dispatch_gap_events ORDER BY 1")).map((r) => r.scope_key), ["policy:b", "policy:c"]);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gap_reconcile_runs"), 1);
});

// ───────────────────────── F cron ─────────────────────────
function cronJobs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of noComments(mig).matchAll(/cron\.schedule\('([^']+)', '([^']+)'/g)) out.set(m[1], m[2]);
  return out;
}

Deno.test("F1 四支 cron 都在，分鐘避開整十／:29／:35／奇數分鐘，台北時間換算正確", () => {
  const jobs = cronJobs();
  assertEquals([...jobs.keys()].sort(), ["dispatch-gap-reconcile-daily", "dispatch-gap-retention-daily", "dispatch-gap-shadow-compare-hourly", "seed-arm-temp-probe-daily"]);
  for (const [name, sched] of jobs) {
    const f = sched.split(" ");
    const minute = Number(f[0]);
    assert(Number.isInteger(minute), `${name} 分鐘欄要是單一數字`);
    assert(minute % 10 !== 0 && minute % 2 === 0 && minute !== 29 && minute !== 35, `${name} 的分鐘 :${minute} 會撞 seed／件數刷新／其他排程`);
  }
  assertEquals(jobs.get("dispatch-gap-shadow-compare-hourly"), "48 * * * *");
  // UTC 19:32 ＝ 台北 03:32；UTC 20:26 ＝ 台北 04:26；UTC 20:44 ＝ 台北 04:44（pg_cron 用 UTC）
  assertEquals(jobs.get("dispatch-gap-reconcile-daily"), "32 19 * * *");
  assertEquals(jobs.get("dispatch-gap-retention-daily"), "26 20 * * *");
  assertEquals(jobs.get("seed-arm-temp-probe-daily"), "44 20 * * *");
  assert(/UTC 19:32 ＝ 台北 03:32/.test(mig), "要寫明時區換算");
});

Deno.test("F2 cron 呼叫的函式存在；雙軌比對走 shadow_run（全 off 空轉）、對帳走 reconcile_all", () => {
  const code = noComments(mig);
  assert(/cron\.schedule\('dispatch-gap-shadow-compare-hourly'[^$]*?SELECT dispatch_gap_shadow_run\(\)/.test(code));
  assert(/cron\.schedule\('dispatch-gap-reconcile-daily'[^$]*?dispatch_gap_reconcile_all\(\)/.test(code));
  assert(/cron\.schedule\('dispatch-gap-retention-daily'[^$]*?dispatch_gap_retention\(\)/.test(code));
  assert(/cron\.schedule\('seed-arm-temp-probe-daily'[^$]*?CALL seed_arm_temp_probe\(\)/.test(code));
  // 每支 schedule 前有對應的 unschedule（重跑 migration 不重複）
  for (const n of cronJobs().keys()) assert(code.includes(`cron.unschedule('${n}')`), `${n} 缺 unschedule`);
});

// ───────────────────────── G 暫存量測 ─────────────────────────
Deno.test("G1 seed_arm_timings 多 temp_bytes 欄；程序每支臂與整張總表各寫一列 temp:<臂>", async () => {
  const db = await freshDb();
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM information_schema.columns WHERE table_name = 'seed_arm_timings' AND column_name = 'temp_bytes'"), 1);
  await db.exec(SEED_ROWS);
  await db.exec("CALL seed_arm_temp_probe()");
  const r = (await rows(db, "SELECT arm, ok, row_count, temp_bytes FROM seed_arm_timings ORDER BY arm")) as Array<{ arm: string; ok: boolean; row_count: number | null; temp_bytes: unknown }>;
  assert(r.every((x) => x.arm.startsWith("temp:")), "程序寫的列 arm 都以 temp: 開頭");
  assert(r.some((x) => x.arm === "temp:arms_all"), "要有整張總表");
  assertEquals(r.length, 37, "清單共 40 項（含 arms_all）；名單清查收斂開關關著時，三支 gate=on 的輔助函式略過");
  assert(r.every((x) => x.ok), "假環境下每支都應成功：" + JSON.stringify(r.filter((x) => !x.ok)));
  assertEquals(r.find((x) => x.arm === "temp:legacy")!.row_count, 2);
  assertEquals(r.find((x) => x.arm === "temp:arms_all")!.row_count, await ints(db, "SELECT count(*)::int AS n FROM contribution_auto_tasks_arms()"));
  const tb = r.find((x) => x.arm === "temp:legacy")!.temp_bytes;
  assert(tb === null || Number(tb) >= 0, "temp_bytes 要是 NULL 或非負整數");
});

Deno.test("G2 程序文字層：每段之間 COMMIT、不帶 SET 子句（會擋 COMMIT）、用 pg_stat_database 前後差", () => {
  const body = mig.slice(mig.indexOf("CREATE OR REPLACE PROCEDURE seed_arm_temp_probe()"), mig.indexOf("REVOKE ALL ON PROCEDURE seed_arm_temp_probe()"));
  assert(/\bCOMMIT;/.test(body));
  assert(!/^\s*SET (statement_timeout|work_mem)/m.test(body), "程序不能帶 SET 子句");
  assert(body.includes("temp_bytes") && body.includes("pg_stat_database"));
  assert(body.includes("'temp:' || r.arm"));
});

Deno.test("G3 程序臂清單與 seed_arm_timing_probe（20261126150000）同一份，只多整張總表", async () => {
  const prev = await read("20261126150000_seed_arm_timings.sql");
  const pick = (s: string) => [...s.matchAll(/\('([a-z_]+)', '([^']+)', (null|'off'|'on')\)/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`);
  const a = pick(prev.slice(prev.indexOf("seed_arm_timing_probe()"), prev.indexOf("REVOKE ALL ON FUNCTION seed_arm_timing_probe()")));
  const b = pick(mig.slice(mig.indexOf("CREATE OR REPLACE PROCEDURE seed_arm_temp_probe()")));
  assertEquals(b.slice(0, -1), a);
  assertEquals(b[b.length - 1], "arms_all|contribution_auto_tasks_arms()|null");
});

// ───────────────────────── H 觸發器函式覆蓋補齊 ─────────────────────────
async function withTriggers(): Promise<PGlite> {
  const db = await freshDb();
  for (const t of ["politician_elections", "politicians", "contributions", "tracking_logs", "policies"]) {
    await db.exec(`CREATE TRIGGER t_gap AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();`);
  }
  return db;
}
const events = async (db: PGlite) =>
  (await rows(db, "SELECT arm, scope_key FROM dispatch_gap_events WHERE processed_at IS NULL ORDER BY arm, scope_key")).map((r) => `${r.arm}|${r.scope_key}`);

Deno.test("H1 politician_elections：改關鍵欄入列 mismatch／issue_too_broad 整臂；沒影響的欄位不入列；沒登記的臂略過", async () => {
  const db = await withTriggers();
  const pid = "11111111-1111-1111-1111-111111111111";
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ('${pid}', 2026, '縣市長', 'declared')`);
  assertEquals(await events(db), ["issue_too_broad|*", "mismatch|*"]);
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now()");
  // 沒在關鍵欄清單裡的欄位變動：不入列
  await db.exec("ALTER TABLE politician_elections ADD COLUMN memo TEXT");
  await db.exec("UPDATE politician_elections SET memo = 'x'");
  assertEquals(await events(db), []);
  await db.exec("UPDATE politician_elections SET candidacy_status = 'filed'");
  assertEquals(await events(db), ["issue_too_broad|*", "mismatch|*"]);
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now()");
  await db.exec("DELETE FROM politician_elections");
  assertEquals(await events(db), ["issue_too_broad|*", "mismatch|*"]);
  // 沒有 WARNING 略過（這四張表現在都認得）
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE arm LIKE 'raw:%' OR arm = 'term_policies'"), 0, "沒登記的臂不入列");
  // 登記之後 profile_gap／term_policies 就會入列
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now()");
  await db.exec("INSERT INTO dispatch_gap_arm_keys (arm, full_fn, key_expr_desc) VALUES ('term_policies', 'contribution_auto_tasks_term_policies()', 'test')");
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ('${pid}', 2026, '縣市長', 'declared')`);
  assert((await events(db)).includes(`term_policies|politician:${pid}`));
});

Deno.test("H2 politicians：改名入列該人名下每條政見的 mismatch 單位；改不相關欄位不入列", async () => {
  const db = await withTriggers();
  const pid = "22222222-2222-2222-2222-222222222222";
  await db.exec(`INSERT INTO policies (id, politician_id, title) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '${pid}', 'a'), ('aaaaaaaa-0000-0000-0000-000000000002', '${pid}', 'b')`);
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now()");
  await db.exec(`INSERT INTO politicians (id, name) VALUES ('${pid}', '甲')`);
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now()");
  await db.exec(`UPDATE politicians SET name = '乙' WHERE id = '${pid}'`);
  assertEquals(await events(db), ["mismatch|policy:aaaaaaaa-0000-0000-0000-000000000001", "mismatch|policy:aaaaaaaa-0000-0000-0000-000000000002"]);
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now()");
  await db.exec("ALTER TABLE politicians ADD COLUMN memo TEXT");
  await db.exec(`UPDATE politicians SET memo = 'x' WHERE id = '${pid}'`);
  assertEquals(await events(db), []);
});

Deno.test("H3 contributions：只依 task_id 反推缺口；狀態沒變不入列；反推不出的不入列", async () => {
  const db = await withTriggers();
  const L = "auto:legacy_audit:6f1c0000-0000-0000-0000-000000000001";
  const M = "auto:policy_election_mismatch:6f1c0000-0000-0000-0000-000000000003";
  const I = "auto:issue_too_broad:2026:臺北市:交通";
  await db.exec(`INSERT INTO contributions (task_id, status) VALUES ('${L}', 'pending')`);
  await db.exec(`INSERT INTO contributions (task_id, status) VALUES (NULL, 'pending')`);   // 沒有 task_id
  await db.exec(`INSERT INTO contributions (task_id, status, payload) VALUES (NULL, 'pending', '{"task_id":"${M}"}')`);   // payload.task_id
  await db.exec(`INSERT INTO contributions (task_id, status) VALUES ('${I}', 'pending')`);
  await db.exec(`INSERT INTO contributions (task_id, status) VALUES ('auto:dup:z', 'pending')`);   // 沒登記的臂
  assertEquals(await events(db), [
    "issue_too_broad|issue:2026:臺北市:交通",
    "legacy|policy:6f1c0000-0000-0000-0000-000000000001",
    "mismatch|policy:6f1c0000-0000-0000-0000-000000000003",
  ]);
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now()");
  await db.exec("ALTER TABLE contributions ADD COLUMN memo TEXT");
  await db.exec("UPDATE contributions SET memo = 'x'");   // 狀態沒變
  assertEquals(await events(db), []);
  await db.exec(`UPDATE contributions SET status = 'applied' WHERE task_id = '${L}'`);
  assertEquals(await events(db), ["legacy|policy:6f1c0000-0000-0000-0000-000000000001"]);
});

Deno.test("H4 tracking_logs：只對已登記的進度類臂入列；沒登記時什麼都不做、也不報錯", async () => {
  const db = await withTriggers();
  const polId = "bbbbbbbb-0000-0000-0000-000000000001";
  await db.exec(`INSERT INTO tracking_logs (policy_id) VALUES ('${polId}')`);
  assertEquals(await events(db), []);
  await db.exec("INSERT INTO dispatch_gap_arm_keys (arm, full_fn, key_expr_desc) VALUES ('deadline_due', 'contribution_auto_tasks_deadline_due()', 'test')");
  await db.exec(`INSERT INTO tracking_logs (policy_id) VALUES ('${polId}')`);
  assertEquals(await events(db), [`deadline_due|policy:${polId}`]);
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now()");
  await db.exec("DELETE FROM tracking_logs");
  assertEquals(await events(db), [`deadline_due|policy:${polId}`]);
});

Deno.test("H5 原本的分支（policies、edit_history…）行為不變：policies 變動仍入列三支臂", async () => {
  const db = await withTriggers();
  await db.exec("INSERT INTO policies (id, politician_id, title) VALUES ('cccccccc-0000-0000-0000-000000000001', NULL, 't')");
  assertEquals(await events(db), ["issue_too_broad|*", "legacy|policy:cccccccc-0000-0000-0000-000000000001", "mismatch|policy:cccccccc-0000-0000-0000-000000000001"]);
});

// ───────────────────────── I 守門 ─────────────────────────
Deno.test("I1 這支遷移沒有把觸發器掛到任何正式表，也沒有其他 cron、沒開任何臂的模式", () => {
  const code = noComments(mig);
  assert(!/CREATE\s+(OR REPLACE\s+)?TRIGGER/i.test(code), "第 0 期不掛觸發器");
  assert(!/UPDATE dispatch_gap_arms SET mode/i.test(code) && !/SELECT dispatch_gap_set_mode\(/.test(code), "不在遷移裡切模式");
  assert(!/seed_drain_enabled\s*=\s*true/i.test(code), "總開關預設關");
});

Deno.test("I2 時間戳大於 PR-1 且 migration 檔名唯一", async () => {
  const names = [...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).filter((n) => n.startsWith("20261126180000"));
  assertEquals(names, [MIG_NAME]);
  assert(MIG_NAME > PR1);
});

// ───────────────────────── J diff_sample（20261127044115）─────────────────────────
const SAMPLE_MIG = "20261127044115_dispatch_gap_compare_diff_sample.sql";
const sampleMig = await read(SAMPLE_MIG);
const LEGACY_1 = "auto:legacy_audit:6f1c0000-0000-0000-0000-000000000001";
const LEGACY_2 = "auto:legacy_audit:6f1c0000-0000-0000-0000-000000000002";

async function shadowDb(): Promise<PGlite> {
  const db = await freshDb();
  await db.exec(sampleMig);
  await db.exec(SEED_ROWS);
  await db.query("SELECT dispatch_gap_set_mode('legacy', 'shadow')");
  await db.query("SELECT * FROM dispatch_gap_reconcile_all(ARRAY['legacy'])"); // 先把常駐表補成與即時輸出一致
  await db.exec("DELETE FROM dispatch_gap_reconcile_runs");
  return db;
}
const shadowRun = async (db: PGlite) => (await rows(db, "SELECT * FROM dispatch_gap_shadow_compare(ARRAY['legacy'], '0 seconds')"))[0];

Deno.test("J1 changed：樣本存鍵與有差異的欄位（table／live），沒變的欄位不存", async () => {
  const db = await shadowDb();
  await db.exec(`UPDATE fake_rows SET what_we_need = 'changed!' WHERE task_id = '${LEGACY_1}'`);
  const run = await shadowRun(db);
  assertEquals([Number(run.missing), Number(run.extra), Number(run.changed)], [0, 0, 1]);
  assertEquals(await one(db, "SELECT diff_sample->'changed'->0->>'key' AS v FROM dispatch_gap_reconcile_runs"), LEGACY_1);
  assertEquals(await one(db, "SELECT diff_sample->'changed'->0->'table' AS v FROM dispatch_gap_reconcile_runs"), { what_we_need: "need l1" });
  assertEquals(await one(db, "SELECT diff_sample->'changed'->0->'live' AS v FROM dispatch_gap_reconcile_runs"), { what_we_need: "changed!" });
  assertEquals(await one(db, "SELECT jsonb_array_length(diff_sample->'missing') AS v FROM dispatch_gap_reconcile_runs"), 0);
  assertEquals(await one(db, "SELECT jsonb_array_length(diff_sample->'extra') AS v FROM dispatch_gap_reconcile_runs"), 0);
});

Deno.test("J2 missing 與 extra 各一筆：鍵有被列出；shadow 仍不改常駐表", async () => {
  const db = await shadowDb();
  const NEW = "auto:legacy_audit:6f1c0000-0000-0000-0000-000000000009";
  await db.exec(`DELETE FROM fake_rows WHERE task_id = '${LEGACY_2}'`);
  await db.exec(`INSERT INTO fake_rows VALUES ('legacy', '${NEW}', 'legacy_audit', '{"id":"n"}', 'need n', NULL, 1, NULL)`);
  const run = await shadowRun(db);
  assertEquals([Number(run.missing), Number(run.extra), Number(run.changed)], [1, 1, 0]);
  assertEquals(await one(db, "SELECT diff_sample->'missing' AS v FROM dispatch_gap_reconcile_runs"), [NEW]);
  assertEquals(await one(db, "SELECT diff_sample->'extra' AS v FROM dispatch_gap_reconcile_runs"), [LEGACY_2]);
  assertEquals(await one(db, "SELECT jsonb_array_length(diff_sample->'changed') AS v FROM dispatch_gap_reconcile_runs"), 0);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gaps WHERE arm = 'legacy' AND closed_at IS NULL"), 2, "雙軌比對不改常駐表");
});

Deno.test("J3 每類超過 20 筆只存 20 筆，計數仍是全部", async () => {
  const db = await shadowDb();
  await db.exec(`INSERT INTO fake_rows SELECT 'legacy', format('auto:legacy_audit:6f1c0000-0000-0000-0000-%s', lpad(i::text, 12, '0')), 'legacy_audit', '{}', 'n', NULL, 1, NULL FROM generate_series(100, 124) i`);
  await db.exec(`UPDATE fake_rows SET what_we_need = 'x'`); // 兩筆舊的也都變了：changed 2，missing 25
  const run = await shadowRun(db);
  assertEquals(Number(run.missing), 25);
  assertEquals(await one(db, "SELECT jsonb_array_length(diff_sample->'missing') AS v FROM dispatch_gap_reconcile_runs"), 20);
  assertEquals(await one(db, "SELECT jsonb_array_length(diff_sample->'changed') AS v FROM dispatch_gap_reconcile_runs"), 2);
});

Deno.test("J4 三類都是 0 時 diff_sample 為 NULL；對帳（reconcile）模式同樣帶樣本；apply 之後樣本仍在", async () => {
  const db = await shadowDb();
  await shadowRun(db);
  assertEquals(await one(db, "SELECT diff_sample IS NULL AS v FROM dispatch_gap_reconcile_runs"), true);
  await db.exec(`UPDATE fake_rows SET what_we_need = 'changed!' WHERE task_id = '${LEGACY_1}'`);
  const r = (await rows(db, "SELECT * FROM dispatch_gap_reconcile_all(ARRAY['legacy'])"))[0];
  assertEquals([r.applied, Number(r.changed)], [true, 1]);
  assertEquals(await one(db, `SELECT diff_sample->'changed'->0->>'key' AS v FROM dispatch_gap_reconcile_runs WHERE mode = 'reconcile'`), LEGACY_1);
});

Deno.test("J5 遷移檔：新增欄位可 NULL、檔頭有回滾、時間戳大於 phase1a 且檔名唯一", () => {
  assert(/ADD COLUMN IF NOT EXISTS diff_sample JSONB;/.test(sampleMig));
  assert(/回滾/.test(sampleMig));
  assert(SAMPLE_MIG > "20261126193000_dispatch_gaps_phase1a.sql");
  assertEquals([...Deno.readDirSync(MIGRATIONS)].filter((e) => e.name.startsWith("20261127044115")).length, 1);
});

// ───────────────────────── K 每小時比對對 live 臂比對並修正（20261127061500）─────────────────────────
const HOURLY_MIG = "20261127061500_dispatch_gap_hourly_apply_live.sql";
const hourlyMig = await read(HOURLY_MIG);

async function hourlyDb(): Promise<PGlite> {
  const db = await freshDb();
  await db.exec(sampleMig);
  await db.exec(hourlyMig);
  await db.exec(SEED_ROWS);
  await db.query("SELECT dispatch_gap_set_mode('legacy', 'shadow')");
  await db.query("SELECT dispatch_gap_set_mode('mismatch', 'shadow')");
  await db.query("SELECT * FROM dispatch_gap_reconcile_all(ARRAY['legacy','mismatch'])"); // 常駐表補成與即時輸出一致
  await db.query("SELECT dispatch_gap_set_mode('legacy', 'live')");
  await db.exec("DELETE FROM dispatch_gap_reconcile_runs");
  return db;
}

Deno.test("K1 live 臂每小時比對補開漏列（mode＝hourly、applied）；shadow 臂只記錄不補（mode＝shadow）", async () => {
  const db = await hourlyDb();
  await db.exec(`DELETE FROM dispatch_gaps WHERE gap_key = '${LEGACY_1}'`); // live 臂少一列
  await db.exec(`DELETE FROM dispatch_gaps WHERE arm = 'mismatch'`);          // shadow 臂少一列
  const before = await ints(db, "SELECT count(*)::int AS n FROM task_dispatches").catch(() => 0);
  const rs = await rows(db, "SELECT * FROM dispatch_gap_shadow_compare(ARRAY['legacy','mismatch'], '0 seconds') ORDER BY arm");
  const legacy = rs.find((r) => r.arm === "legacy")!;
  const mismatch = rs.find((r) => r.arm === "mismatch")!;
  assertEquals([legacy.mode, legacy.applied, Number(legacy.missing)], ["hourly", true, 1]);
  assertEquals([mismatch.mode, mismatch.applied, Number(mismatch.missing)], ["shadow", false, 1]);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gaps WHERE arm = 'legacy' AND closed_at IS NULL"), 2, "live 臂已補回");
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM dispatch_gaps WHERE arm = 'mismatch'"), 0, "shadow 臂不補");
  assertEquals((await rows(db, "SELECT mode, applied FROM dispatch_gap_reconcile_runs ORDER BY arm")).map((r) => [r.mode, r.applied]), [["hourly", true], ["shadow", false]]);
  // 再比一次：live 臂已一致，不再 apply
  const again = (await rows(db, "SELECT * FROM dispatch_gap_shadow_compare(ARRAY['legacy'], '0 seconds')"))[0];
  assertEquals([again.mode, again.applied, Number(again.missing)], ["hourly", false, 0]);
  assertEquals(await ints(db, "SELECT count(*)::int AS n FROM task_dispatches").catch(() => 0), before, "不碰派工佇列");
});

Deno.test("K2 live 臂漏關也修正（extra）", async () => {
  const db = await hourlyDb();
  await db.exec(`DELETE FROM fake_rows WHERE task_id = '${LEGACY_2}'`); // 即時輸出少一列＝常駐表多一列
  const run = (await rows(db, "SELECT * FROM dispatch_gap_shadow_compare(ARRAY['legacy'], '0 seconds')"))[0];
  assertEquals([Number(run.extra), run.applied], [1, true]);
  assertEquals(await ints(db, `SELECT count(*)::int AS n FROM dispatch_gaps WHERE gap_key = '${LEGACY_2}' AND closed_at IS NULL`), 0);
});

Deno.test("K3 文字層：最新 shadow_compare 定義含 = 'live'，mode 約束收 hourly，檔頭有理由與回滾，檔名唯一且時間戳最新", async () => {
  const names = [...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
  let latest = "";
  for (const n of names) {
    if (/FUNCTION\s+dispatch_gap_shadow_compare\s*\(/i.test(noComments(await read(n)))) latest = n;
  }
  assertEquals(latest, HOURLY_MIG, "最新的 shadow_compare 定義要是這支");
  const code = noComments(hourlyMig);
  assert(/gap_arm_mode\(v_arm\)\s*=\s*'live'/.test(code));
  assert(/'hourly'/.test(code) && /CHECK \(mode IN \('reconcile', 'shadow', 'hourly'\)\)/.test(code));
  assert(/回滾/.test(hourlyMig) && /漏事件/.test(hourlyMig));
  assert(HOURLY_MIG > "20261127052000_agy_login_realtime_broadcast.sql");
  assertEquals(names.filter((n) => n.startsWith("20261127061500")).length, 1);
});
