/**
 * 脈絡「一件事的全貌」第二期 2b：三支缺口臂（現況、立場、事件）共用起跑日（policy-tw#675；migration 20261120170000_lineage_arms_start_date.sql）。
 *
 * 維護者 11-20：既有三支臂開著不動；現況臂規則改啟用、新兩支一開始就啟用，輸出由 lineage_settings.dispatch_start_on（預設 2026-11-29）決定，
 * 起跑日之前三支的輸出一律為空（派工列沒有、/next 不派、gap_events 沒有紀錄），到期自動開。
 *
 *   A. 文字層：總表與臂名清單只多兩行／兩個名字、規則只動 lineage_status、不碰既有三支臂、換號清單、上限初值
 *   B. 起跑日（PGlite：總表＋規則＋seed 跑真的，臂本體跑真的 SQL）：遍歷所有掛起跑日的臂起跑日前皆空（START_DATE_ARMS）、
 *      反向（起跑日設成昨天皆非空）、改早三支同時開、既有三支臂輸出前後不變、還原驗證
 *   C. 立場臂條件　D. 事件臂條件　E. 上限與穩定排序
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { buildArmsDb, fnText, type GapRow, migrationNames, mutate, P1_MIG, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261120170000_lineage_arms_start_date.sql";
const MIG = await readMig(MIG_NAME);
const PREV = await readMig("20261105200000_lineage_status.sql");
const ONE = await readMig("20261120120000_lineage_stances_events.sql");
const P1 = await readMig(P1_MIG);
const code = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** 所有宣告掛起跑日的臂：臂名（總表 arm 欄）→ 臂函式名；漏掛一支就會單獨提早開，B1 會抓 */
export const START_DATE_ARMS = [
  { arm: "lineage_status", fn: "contribution_auto_tasks_lineage_status", taskType: "lineage_status_stale" },
  { arm: "lineage_stances", fn: "contribution_auto_tasks_lineage_stances", taskType: "lineage_stance_missing" },
  { arm: "lineage_events", fn: "contribution_auto_tasks_lineage_events", taskType: "lineage_event_missing" },
] as const;

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 總表＝20261105200000 的現行定義只多兩行 UNION；臂名清單只多兩個名字；task_rekey_arms 只多兩個臂", async () => {
  const prev = fnText(PREV, "contribution_auto_tasks_arms");
  const now = fnText(MIG, "contribution_auto_tasks_arms");
  const added = "  UNION ALL SELECT 'lineage_stances' AS arm, t.* FROM contribution_auto_tasks_lineage_stances() t\n  UNION ALL SELECT 'lineage_events' AS arm, t.* FROM contribution_auto_tasks_lineage_events() t\n";
  assertEquals(now.replace(added, "").replace("LANGUAGE sql STABLE SET work_mem = '16MB' AS $$", () => "LANGUAGE sql STABLE AS $$"), prev);
  assertEquals(fnText(MIG, "activity_arm_names").replace("    'lineage_status',\n    'lineage_stances',\n    'lineage_events'\n", "    'lineage_status'\n"), fnText(PREV, "activity_arm_names"));
  const prevRekey = fnText(await readMig("20261019040000_rekey_keeps_queue_position.sql"), "task_rekey_arms");
  assertEquals(fnText(MIG, "task_rekey_arms").replace(", 'lineage_stance_missing', 'lineage_event_missing'", ""), prevRekey);
  // 沒有別的 migration 在這之後重定義總表（抄底的是最後一版）
  const after = [];
  for (const n of await migrationNames()) if (n > "20261105200000_lineage_status.sql" && n !== MIG_NAME && (await readMig(n)).includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms(")) after.push(n);
  assertEquals(after, [], "20261105200000 之後沒有別支重定義總表");
});

Deno.test("A2 規則：只把 lineage_status 改啟用；兩支新臂種成 always＋enabled；不碰既有三支臂（lineage_candidates／links／roles）；沒有別的 UPDATE", () => {
  const c = code(MIG).replace(/'[^']*'/g, "''");
  const updates = [...c.matchAll(/^\s*UPDATE\s+([a-z_]+)\b/gim)].map((m) => m[1]);
  assertEquals(updates, ["activity_rules", "lineage_settings"], "只有這兩處 UPDATE");
  const raw = code(MIG);
  assertStringIncludes(raw, "UPDATE activity_rules SET enabled = true,");
  assertStringIncludes(raw, " WHERE activity = 'lineage_status';");
  assertEquals((raw.match(/UPDATE activity_rules/g) ?? []).length, 1);
  for (const arm of ["lineage_stances", "lineage_events"]) assertStringIncludes(raw, `SELECT '${arm}', 'always', true, '{}'::JSONB,`);
  for (const old of ["lineage_candidates", "lineage_links", "lineage_roles"]) {
    assertFalse(new RegExp(`activity\\s*(=|IN)[^;]*'${old}'`, "i").test(raw.replace(/RAISE EXCEPTION[^;]*;/g, "").replace(/SELECT count\(\*\) FROM activity_rules r WHERE r\.activity IN \([^)]*\)/g, "")), `不碰 ${old} 的規則`);
  }
  assertFalse(/\bDELETE\s+FROM\b|\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b/i.test(raw), "只加不刪");
  assertFalse(raw.includes("FUNCTION seed_auto_task_queue") || raw.includes("FUNCTION contribution_required_agree"), "不碰 seed 與計分");
});

Deno.test("A3 三支臂的函式都讀起跑日與總開關（activity_today() >= dispatch_start_on、enabled），不用 now() 判斷今天", () => {
  for (const { fn } of START_DATE_ARMS) {
    const f = code(fnText(MIG, fn));
    assertStringIncludes(f, "activity_today() >= st.dispatch_start_on");
    assertStringIncludes(f, "st.enabled");
    assertFalse(/\bCURRENT_DATE\b/.test(f), `${fn} 不用 CURRENT_DATE 當今天`);
    assertFalse(/\bnow\(\)\s*[<>]=?\s*st\.dispatch_start_on/.test(f));
  }
  // 起跑日初值與型別來自一期
  assertStringIncludes(ONE, "dispatch_start_on    DATE NOT NULL DEFAULT '2026-11-29'");
});

Deno.test("A4 現況臂：其餘條件一字不改，只多起跑日／總開關／上限（以 20261105200000 為底）", () => {
  const strip = (s: string) => s
    .replace(/\n\s*-- >>> [^\n]*\n[\s\S]*?\n\s*-- <<< [^\n]*\n/g, "\n")
    .replace(/\s+/g, " ");
  const prev = fnText(PREV, "contribution_auto_tasks_lineage_status");
  const now = fnText(MIG, "contribution_auto_tasks_lineage_status");
  for (const must of [
    "c.phase IN ('approved', 'in_progress') AND c.as_of < s.today - s.d_active",
    "c.phase IN ('proposed', 'planning', 'paused') AND c.as_of < s.today - s.d_idle",
    "k.contribution_type = 'lineage_status' AND k.status IN ('pending', 'verified', 'disputed', 'apply_failed')",
    "tc.task_id LIKE 'auto:lineage_status_stale:' || l.id::TEXT || ':%'",
    "'auto:lineage_status_stale:' || d.lineage_id::TEXT || ':' || COALESCE(d.cur_as_of::TEXT, 'none')",
  ]) {
    assertStringIncludes(prev, must);
    assertStringIncludes(now, must);
  }
  assert(strip(now).length > 0);
});

Deno.test("A5 三臂同時開著的上限初值 20（一行 UPDATE），三臂合計最多 60 件", () => {
  assertStringIncludes(MIG, "UPDATE lineage_settings SET open_cap_per_arm = 20,");
  assertStringIncludes(code(fnText(MIG, "contribution_auto_tasks_lineage_status")), "WHERE d.cap IS NULL OR d.rn <= d.cap");
  for (const fn of ["contribution_auto_tasks_lineage_stances", "contribution_auto_tasks_lineage_events"]) assertStringIncludes(code(fnText(MIG, fn)), "WHERE x.cap IS NULL OR x.rn <= x.cap");
});

// ============================================================
// B. 起跑日（PGlite）
// ============================================================
const SETTINGS_COLS = [...ONE.matchAll(/^ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS [^\n]*;$/gm)].map((m) => m[0]);
function tableSqlOf(sql: string, name: string): string {
  const a = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  return sql.slice(a, sql.indexOf("\n);", a) + 3);
}
const LINEAGE_TABLES = `
CREATE TABLE lineages (id uuid PRIMARY KEY, title text, summary text, level text, region text, sub_region text, category text, created_at timestamptz DEFAULT now());
CREATE TABLE politicians (id uuid PRIMARY KEY, name text, merged_into uuid);
CREATE TABLE policies (id uuid PRIMARY KEY, lineage_id uuid, politician_id uuid, election_id integer, removed_at timestamptz);
CREATE TABLE politician_elections (id serial PRIMARY KEY, politician_id uuid, election_id integer, election_type text, candidacy_status text, region_id integer);
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text);
CREATE TABLE lineage_participants (lineage_id uuid, politician_id uuid);
CREATE TABLE lineage_stances (id serial PRIMARY KEY, lineage_id uuid, politician_id uuid, removed_at timestamptz);
CREATE TABLE lineage_events (id serial PRIMARY KEY, lineage_id uuid, occurred_on date, removed_at timestamptz);
CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text, checked_at timestamptz DEFAULT now(), outcome text);
CREATE TABLE _ineligible (id uuid PRIMARY KEY);
CREATE FUNCTION policy_is_elected_term(p uuid, d date DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT NOT EXISTS (SELECT 1 FROM _ineligible WHERE id = p) $$;
${tableSqlOf(PREV, "lineage_settings")}
INSERT INTO lineage_settings (id) VALUES (1);
${SETTINGS_COLS.join("\n")}
${tableSqlOf(PREV, "lineage_statuses")}
`;
const ARM_LINES = START_DATE_ARMS.map((a) => `  UNION ALL SELECT '${a.arm}' AS arm, t.* FROM ${a.fn}() t\n`).join("");
const OWNER_LINE = "  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t\n";
const ruleSection = (): string => {
  const a = MIG.indexOf("UPDATE activity_rules SET enabled = true,");
  return MIG.slice(a, MIG.indexOf("INSERT INTO console_arm_stage_map"));
};
const CTRL: GapRow = { task_id: "auto:dup:control", task_type: "duplicate_politician", target: { name: "對照" }, what_we_need: "對照組", hint_sources: [], reward: 1, region: "台北市" };
const OLD_ARM: GapRow = { task_id: "auto:lineage_roles_missing:x", task_type: "lineage_roles_missing", target: { lineage_id: u(900) }, what_we_need: "既有臂", hint_sources: [], reward: 1, region: "全國" };
const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
const setToday = (db: PGlite, d: string) => db.exec(`SET app.activity_today = '${d}'`);

/** 臂本體可被改壞（還原驗證）；today＝建環境時預設的假「今天」 */
async function world(mutateFn: (name: string, sql: string) => string = (_n, s) => s): Promise<PGlite> {
  const db = await buildArmsDb({
    extraBranches: ["lineage_status", "lineage_stances", "lineage_events"],
    branches: { dup: [CTRL], lineage_roles: [OLD_ARM] },
  });
  await db.exec(mutate(fnText(P1, "contribution_auto_tasks_arms"), OWNER_LINE, OWNER_LINE + ARM_LINES));
  await db.exec(`ALTER TABLE contributions ADD COLUMN payload jsonb`);
  await db.exec(LINEAGE_TABLES);
  // 現況臂的規則照 #872 上線時的樣子（停用），再套這支 migration 的規則段
  await db.exec(`INSERT INTO activity_rules (activity, window_kind, enabled, params, note) VALUES ('lineage_status', 'always', false, '{}'::JSONB, '#872')`);
  await db.exec(ruleSection());
  for (const { fn } of START_DATE_ARMS) await db.exec(mutateFn(fn, fnText(MIG, fn)));
  await db.exec(`UPDATE lineage_settings SET open_cap_per_arm = 20 WHERE id = 1`);
  return db;
}

/** 一條合格的脈絡（有合格政見、沒有現況、沒有事件、持有人當選過）：三支臂在起跑日後都該派 */
async function seedLineage(db: PGlite, n: number, opts: { title?: string } = {}) {
  const A = u(2000 + n);
  await db.query(`INSERT INTO lineages (id, title, summary, level, region, sub_region, category, created_at) VALUES ($1, $2, '摘要', 'county', '高雄市', NULL, '交通建設', now() - ($3 || ' minutes')::interval)`, [u(n), opts.title ?? `脈絡${n}`, String(1000 - n)]);
  await db.query(`INSERT INTO politicians (id, name) VALUES ($1, $2)`, [A, `人物${n}`]);
  await db.query(`INSERT INTO policies (id, lineage_id, politician_id, election_id) VALUES ($1, $2, $3, 2022)`, [u(1000 + n), u(n), A]);
  await db.query(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ($1, 2022, '縣議員', 'elected')`, [A]);
}
const armRows = async (db: PGlite, arm: string) => (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_arms() WHERE arm = '${arm}' ORDER BY 1`)).map((r) => r.task_id);

/** 起跑日前三支臂輸出皆空、其他臂照常（對照組＋既有三支臂的 stub 還在）；回傳是否全過 */
async function beforeStartHolds(mutateFn?: (name: string, sql: string) => string): Promise<boolean> {
  const db = await world(mutateFn);
  await seedLineage(db, 1);
  await setToday(db, "2026-11-28");
  for (const a of START_DATE_ARMS) if ((await armRows(db, a.arm)).length !== 0) return false;
  await db.exec(`SELECT seed_auto_task_queue()`);
  const dispatched = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_type IN ('lineage_status_stale', 'lineage_stance_missing', 'lineage_event_missing')`);
  const events = await rows(db, `SELECT 1 FROM gap_events WHERE task_type IN ('lineage_status_stale', 'lineage_stance_missing', 'lineage_event_missing')`);
  const control = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = 'auto:dup:control'`);
  const oldArm = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = '${OLD_ARM.task_id}'`);
  return dispatched.length === 0 && events.length === 0 && control.length === 1 && oldArm.length === 1;
}

Deno.test("B1 起跑日前：遍歷所有掛起跑日的臂（START_DATE_ARMS）輸出皆空——總表沒有、seed 不寫派工列、gap_events 沒有紀錄；其他臂照常", async () => {
  assert(await beforeStartHolds());
  // START_DATE_ARMS 要涵蓋 migration 裡所有「帶起跑日條件」的臂函式（漏掛一支＝單獨提早開）
  const withGate = [...MIG.matchAll(/CREATE OR REPLACE FUNCTION (contribution_auto_tasks_[a-z_]+)\(\)[\s\S]*?\$\$;/g)]
    .filter((m) => m[0].includes("dispatch_start_on")).map((m) => m[1]).sort();
  assertEquals(withGate, START_DATE_ARMS.map((a) => a.fn).sort());
});

Deno.test("B2 反向：起跑日設成昨天（欄位 NOT NULL，不能設 NULL），同一批資料三支臂輸出皆非空（空表或壞掉的臂不會通過 B1）", async () => {
  const db = await world();
  await seedLineage(db, 1);
  await setToday(db, "2026-11-20");
  for (const a of START_DATE_ARMS) assertEquals((await armRows(db, a.arm)).length, 0, `${a.arm} 起跑日前為空`);
  await db.exec(`UPDATE lineage_settings SET dispatch_start_on = '2026-11-19' WHERE id = 1`);
  for (const a of START_DATE_ARMS) assertEquals((await armRows(db, a.arm)).length, 1, `${a.arm} 起跑日後非空`);
  await db.exec(`SELECT seed_auto_task_queue()`);
  const d = await rows<{ task_type: string; arm: string }>(db, `SELECT task_type, opened_by->>'arm' AS arm FROM task_dispatches WHERE task_type IN ('lineage_status_stale', 'lineage_stance_missing', 'lineage_event_missing') ORDER BY 1`);
  assertEquals(d, [{ task_type: "lineage_event_missing", arm: "lineage_events" }, { task_type: "lineage_stance_missing", arm: "lineage_stances" }, { task_type: "lineage_status_stale", arm: "lineage_status" }]);
});

Deno.test("B3 跨過起跑日同一批資料立刻出現（預設 2026-11-29 ＝ 台北日，11-28 空、11-29 有），不需要另一支 migration 改 enabled；把起跑日改早三支同時開", async () => {
  const db = await world();
  await seedLineage(db, 1);
  await setToday(db, "2026-11-28");
  for (const a of START_DATE_ARMS) assertEquals((await armRows(db, a.arm)).length, 0);
  assertEquals((await rows<{ d: string }>(db, `SELECT dispatch_start_on::text AS d FROM lineage_settings WHERE id = 1`))[0].d, "2026-11-29");
  await setToday(db, "2026-11-29");
  for (const a of START_DATE_ARMS) assertEquals((await armRows(db, a.arm)).length, 1, `${a.arm} 11-29 開`);
  assertEquals(await rows(db, `SELECT 1 FROM activity_rules WHERE activity IN ('lineage_status', 'lineage_stances', 'lineage_events') AND NOT enabled`), [], "三條規則都是啟用的");
  // 提早開只改一格
  await setToday(db, "2026-11-20");
  for (const a of START_DATE_ARMS) assertEquals((await armRows(db, a.arm)).length, 0);
  await db.exec(`UPDATE lineage_settings SET dispatch_start_on = '2026-11-20'`);
  for (const a of START_DATE_ARMS) assertEquals((await armRows(db, a.arm)).length, 1);
  // 改晚了：已派出、現在又不到起跑日的列由 seed 下一輪收回
  await db.exec(`SELECT seed_auto_task_queue()`);
  assert((await rows(db, `SELECT 1 FROM task_dispatches WHERE task_type = 'lineage_stance_missing'`)).length === 1);
  await db.exec(`UPDATE lineage_settings SET dispatch_start_on = '2026-12-31'`);
  await db.exec(`SELECT seed_auto_task_queue()`);
  assertEquals((await rows(db, `SELECT 1 FROM task_dispatches WHERE task_type IN ('lineage_status_stale', 'lineage_stance_missing', 'lineage_event_missing')`)).length, 0);
  assertEquals((await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = 'auto:dup:control'`)).length, 1, "其他臂不受影響");
});

Deno.test("B4 總開關 lineage_settings.enabled=false：起跑日後三支臂仍為空", async () => {
  const db = await world();
  await seedLineage(db, 1);
  await setToday(db, "2026-12-01");
  assertEquals((await armRows(db, "lineage_stances")).length, 1);
  await db.exec(`UPDATE lineage_settings SET enabled = false`);
  for (const a of START_DATE_ARMS) assertEquals((await armRows(db, a.arm)).length, 0);
});

Deno.test("B5 既有三支臂（stub 代表）的輸出前後逐件不變：起跑日前後、規則段套用前後都一樣；它們的規則一列沒動", async () => {
  const db = await world();
  await seedLineage(db, 1);
  const snapshot = async () => ({
    arms: await rows(db, `SELECT arm, task_id, task_type FROM contribution_auto_tasks_arms() WHERE arm IN ('lineage_candidates', 'lineage_links', 'lineage_roles', 'handover_missing', 'dup') ORDER BY 1, 2`),
    rules: await rows(db, `SELECT activity, window_kind, enabled, params::text FROM activity_rules WHERE activity IN ('lineage_candidates', 'lineage_links', 'lineage_roles', 'handover_missing') ORDER BY 1`),
  });
  await setToday(db, "2026-11-20");
  const before = await snapshot();
  await setToday(db, "2026-12-05");
  const after = await snapshot();
  assertEquals(after, before);
  assertEquals(before.rules.length >= 3, true, "既有臂規則還在");
  assert(before.rules.every((r) => (r as { enabled: boolean }).enabled === true), "既有臂維持啟用");
});

Deno.test("B6 還原驗證：把立場臂函式裡的起跑日條件拿掉 → B1 的守門會紅（單獨提早開）；現況臂、事件臂同", async () => {
  for (const { fn } of START_DATE_ARMS) {
    const holds = await beforeStartHolds((name, sql) => name === fn ? mutate(sql, " AND activity_today() >= st.dispatch_start_on", "") : sql);
    assertFalse(holds, `${fn} 拿掉起跑日條件，守門必須紅`);
  }
});

Deno.test("B7 還原驗證：規則種成停用 → B2 反向的『起跑日後非空』會紅（證明規則啟用是必要的）", async () => {
  const db = await world();
  await seedLineage(db, 1);
  await db.exec(`UPDATE activity_rules SET enabled = false WHERE activity = 'lineage_stances'`);
  await setToday(db, "2026-12-01");
  assertEquals((await armRows(db, "lineage_stances")).length, 0, "規則停用時臂函式再有資料也不會出來");
});

// ============================================================
// C. 立場臂
// ============================================================
async function stanceDb(): Promise<PGlite> {
  const db = await world();
  await db.exec(`UPDATE lineage_settings SET dispatch_start_on = '2026-01-01'`);
  await setToday(db, "2026-12-01");
  return db;
}
const stanceRows = async (db: PGlite) => await rows<{ task_id: string; target: { people: Array<{ politician_id: string; why: string[] }> } }>(db, `SELECT task_id, target FROM contribution_auto_tasks_lineage_stances() ORDER BY 1`);

Deno.test("C1 應有立場的人：政見持有人、參與者、首長（縣市長）；沒有合格政見的脈絡不派；已有立場的人扣掉；全部有了就不派", async () => {
  const db = await stanceDb();
  await seedLineage(db, 1);
  await seedLineage(db, 2);
  await db.exec(`INSERT INTO _ineligible VALUES ('${u(1002)}')`); // 脈絡 2 的政見不合格
  // 參與者 B（當選過）、首長 H（2022 縣市長，高雄市）
  await db.exec(`INSERT INTO regions VALUES (1, '高雄市', NULL)`);
  await db.exec(`INSERT INTO politicians VALUES ('${u(51)}', '參與者B', NULL), ('${u(52)}', '首長H', NULL)`);
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES ('${u(51)}', 2022, '縣議員', 'elected', NULL), ('${u(52)}', 2022, '縣市長', 'elected', 1)`);
  await db.exec(`INSERT INTO lineage_participants VALUES ('${u(1)}', '${u(51)}')`);
  const r = await stanceRows(db);
  assertEquals(r.length, 1, "不合格政見的脈絡 2 不派");
  assertEquals(r[0].task_id.startsWith(`auto:lineage_stance_missing:${u(1)}:`), true);
  assertEquals(r[0].task_id.split(":").pop()!.length, 8);
  const byId = Object.fromEntries(r[0].target.people.map((p) => [p.politician_id, p.why]));
  assertEquals(Object.keys(byId).sort(), [u(2001), u(51), u(52)].sort());
  assertEquals(byId[u(2001)], ["政見持有人"]);
  assertEquals(byId[u(51)], ["參與者"]);
  assertEquals(byId[u(52)], ["首長"]);
  // 已有立場（沒下架）的人扣掉；下架的不算
  await db.exec(`INSERT INTO lineage_stances (lineage_id, politician_id) VALUES ('${u(1)}', '${u(51)}')`);
  await db.exec(`INSERT INTO lineage_stances (lineage_id, politician_id, removed_at) VALUES ('${u(1)}', '${u(52)}', now())`);
  const r2 = await stanceRows(db);
  assertEquals(r2[0].target.people.map((p) => p.politician_id).sort(), [u(2001), u(52)].sort());
  assertFalse(r2[0].task_id === r[0].task_id, "名單變了指紋就換");
  await db.exec(`INSERT INTO lineage_stances (lineage_id, politician_id) VALUES ('${u(1)}', '${u(2001)}'), ('${u(1)}', '${u(52)}')`);
  assertEquals((await stanceRows(db)).length, 0, "每個人都有立場就不派");
});

Deno.test("C2 沒當選過的人不在名單（沒有任期就沒有可交的立場）；其他縣市的首長不算", async () => {
  const db = await stanceDb();
  await seedLineage(db, 1);
  await db.exec(`INSERT INTO regions VALUES (1, '台北市', NULL)`);
  await db.exec(`INSERT INTO politicians VALUES ('${u(51)}', '落選參與者', NULL), ('${u(52)}', '台北市長', NULL)`);
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES ('${u(51)}', 2022, '縣議員', 'not_elected', NULL), ('${u(52)}', 2022, '縣市長', 'elected', 1)`);
  await db.exec(`INSERT INTO lineage_participants VALUES ('${u(1)}', '${u(51)}')`);
  const r = await stanceRows(db);
  assertEquals(r[0].target.people.map((p) => p.politician_id), [u(2001)]);
});

Deno.test("C3 在途的 lineage_stance 交件擋掉（applied／rejected 與別條脈絡的不擋）；not_found 冷卻（不比指紋）", async () => {
  const db = await stanceDb();
  await seedLineage(db, 1);
  await seedLineage(db, 2);
  const put = (status: string, lid: number) => db.query(`INSERT INTO contributions (id, contribution_type, status, payload) VALUES (gen_random_uuid(), 'lineage_stance', $1, $2::jsonb)`, [status, JSON.stringify({ lineage_id: u(lid) })]);
  for (const s of ["pending", "verified", "disputed", "apply_failed"]) {
    await put(s, 1);
    assertEquals((await stanceRows(db)).map((x) => x.task_id.split(":")[2]), [u(2)], `${s} 擋住脈絡 1`);
    await db.exec(`DELETE FROM contributions`);
  }
  await put("applied", 1);
  await put("rejected", 1);
  await put("pending", 99);
  assertEquals((await stanceRows(db)).length, 2);
  await db.exec(`DELETE FROM contributions`);
  await db.query(`INSERT INTO task_checks (task_id, outcome, checked_at) VALUES ($1, 'not_found', now() - interval '10 days')`, [`auto:lineage_stance_missing:${u(1)}:deadbeef`]);
  assertEquals((await stanceRows(db)).map((x) => x.task_id.split(":")[2]), [u(2)], "60 天內不比指紋就擋");
  await db.exec(`UPDATE task_checks SET checked_at = now() - interval '61 days'`);
  assertEquals((await stanceRows(db)).length, 2, "過了就再派");
  await db.exec(`UPDATE task_checks SET checked_at = now() - interval '10 days', outcome = 'confirmed'`);
  assertEquals((await stanceRows(db)).length, 2, "結論不是 not_found 的不擋");
});

// ============================================================
// D. 事件臂
// ============================================================
const eventRows = async (db: PGlite) => await rows<{ task_id: string; target: Record<string, unknown> }>(db, `SELECT task_id, target FROM contribution_auto_tasks_lineage_events() ORDER BY 1`);
const day = (back: number) => new Date(Date.UTC(2026, 11, 1) - back * 86400000).toISOString().slice(0, 10);
const addStatus = (db: PGlite, lid: number, phase: string) => db.query(`INSERT INTO lineage_statuses (lineage_id, phase, text, as_of, source_url, source_locator) VALUES ($1, $2, '現況一句話，長度夠。', '2026-01-01', 'https://www.gov.tw/a', '第 1 點')`, [u(lid), phase]);
const addEvent = (db: PGlite, lid: number, back: number, removed = false) => db.query(`INSERT INTO lineage_events (lineage_id, occurred_on, removed_at) VALUES ($1, $2, $3)`, [u(lid), day(back), removed ? "2026-01-01" : null]);

Deno.test("D1 沒有事件 → 派（reason none）；有合格政見才算；下架的事件不算", async () => {
  const db = await stanceDb();
  await seedLineage(db, 1);
  await seedLineage(db, 2);
  await db.exec(`INSERT INTO _ineligible VALUES ('${u(1002)}')`);
  await addEvent(db, 1, 10, true);
  const r = await eventRows(db);
  assertEquals(r.map((x) => x.task_id.split(":")[2]), [u(1)]);
  assertEquals(r[0].target.reason, "none");
});

Deno.test("D2 有事件：進行中階段最近一筆超過 event_recheck_days（180）才派，剛好等於天數不派；結案階段不派；沒有現況不派", async () => {
  const db = await stanceDb();
  for (const n of [1, 2, 3, 4, 5, 6]) await seedLineage(db, n);
  await addStatus(db, 1, "in_progress"); await addEvent(db, 1, 181);
  await addStatus(db, 2, "approved"); await addEvent(db, 2, 180);
  await addStatus(db, 3, "completed"); await addEvent(db, 3, 400);
  await addStatus(db, 4, "cancelled"); await addEvent(db, 4, 400);
  await addStatus(db, 5, "paused"); await addEvent(db, 5, 200);
  await addEvent(db, 6, 400); // 沒有現況
  const r = await eventRows(db);
  assertEquals(r.map((x) => x.task_id.split(":")[2]).sort(), [u(1), u(5)].sort());
  assertEquals(r[0].target.reason, "stale");
  await db.exec(`UPDATE lineage_settings SET event_recheck_days = 100`);
  assertEquals((await eventRows(db)).length, 3, "改設定值生效：脈絡 2（180 天前）也過期了");
});

Deno.test("D3 在途 lineage_event 交件、not_found 冷卻擋掉；指紋＝原因＋最近一筆事件日（有新事件才換號）", async () => {
  const db = await stanceDb();
  await seedLineage(db, 1);
  await seedLineage(db, 2);
  const first = (await eventRows(db)).map((x) => x.task_id);
  await db.query(`INSERT INTO contributions (id, contribution_type, status, payload) VALUES (gen_random_uuid(), 'lineage_event', 'pending', $1::jsonb)`, [JSON.stringify({ lineage_id: u(1) })]);
  assertEquals((await eventRows(db)).map((x) => x.task_id.split(":")[2]), [u(2)]);
  await db.exec(`DELETE FROM contributions`);
  await db.query(`INSERT INTO task_checks (task_id, outcome, checked_at) VALUES ($1, 'not_found', now() - interval '5 days')`, [`auto:lineage_event_missing:${u(2)}:old`]);
  assertEquals((await eventRows(db)).map((x) => x.task_id.split(":")[2]), [u(1)]);
  assertEquals((await eventRows(db)).map((x) => x.task_id)[0], first[0], "同一份資料指紋不變");
  await db.exec(`DELETE FROM task_checks`);
  await addStatus(db, 1, "in_progress"); await addEvent(db, 1, 200);
  const stale1 = (await eventRows(db)).find((x) => x.task_id.includes(u(1)))!.task_id;
  await db.exec(`DELETE FROM lineage_events`); await addEvent(db, 1, 250);
  const stale2 = (await eventRows(db)).find((x) => x.task_id.includes(u(1)))!.task_id;
  assertFalse(stale1 === stale2, "最近一筆事件日變了，指紋換");
});

// ============================================================
// E. 上限與穩定排序、規則與 seed 的連動
// ============================================================
Deno.test("E1 open_cap_per_arm：每臂最多 20 件；已在派工列的先留著，補位依脈絡建立時間；上限空＝不設", async () => {
  const db = await stanceDb();
  for (let n = 1; n <= 25; n++) await seedLineage(db, n);
  assertEquals((await eventRows(db)).length, 20);
  assertEquals((await stanceRows(db)).length, 20);
  assertEquals((await rows(db, `SELECT 1 FROM contribution_auto_tasks_lineage_status()`)).length, 20);
  // 最舊建立的 20 條（n 小的 created_at 較早）
  const first = new Set((await eventRows(db)).map((x) => x.task_id.split(":")[2]));
  assertEquals([...first].sort(), Array.from({ length: 20 }, (_, i) => u(i + 1)).sort());
  // 脈絡 21 已在派工列（先留著）→ 擠掉最後一條
  await db.query(`INSERT INTO task_dispatches (task_id, task_type) VALUES ($1, 'lineage_status_stale')`, [`auto:lineage_status_stale:${u(25)}:none`]);
  const st = (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_lineage_status()`)).map((x) => x.task_id.split(":")[2]);
  assertEquals(st.length, 20);
  assert(st.includes(u(25)) && !st.includes(u(20)));
  await db.exec(`UPDATE lineage_settings SET open_cap_per_arm = NULL`);
  assertEquals((await eventRows(db)).length, 25);
  // 起跑日當天三臂合計上限＝60
  await db.exec(`UPDATE lineage_settings SET open_cap_per_arm = 20`);
  const total = (await eventRows(db)).length + (await stanceRows(db)).length + (await rows(db, `SELECT 1 FROM contribution_auto_tasks_lineage_status()`)).length;
  assertEquals(total, 60);
});

Deno.test("E2 任務完成後補位：一條脈絡有交件在途就從輸出消失，下一條補進來（仍是 20 件）", async () => {
  const db = await stanceDb();
  for (let n = 1; n <= 22; n++) await seedLineage(db, n);
  assertEquals((await eventRows(db)).length, 20);
  await db.query(`INSERT INTO contributions (id, contribution_type, status, payload) VALUES (gen_random_uuid(), 'lineage_event', 'pending', $1::jsonb)`, [JSON.stringify({ lineage_id: u(1) })]);
  const r = (await eventRows(db)).map((x) => x.task_id.split(":")[2]);
  assertEquals(r.length, 20);
  assertFalse(r.includes(u(1)));
  assert(r.includes(u(21)));
});

Deno.test("E3 換號沿用排隊位置：兩支新臂在 task_rekey_arms 裡，工作卡鍵去掉末段指紋（同一條脈絡指紋變了還是同一張卡）", async () => {
  assertStringIncludes(fnText(MIG, "task_rekey_arms"), "'lineage_stance_missing', 'lineage_event_missing'");
  const ids = await migrationNames();
  assert(ids.includes(MIG_NAME));
});
