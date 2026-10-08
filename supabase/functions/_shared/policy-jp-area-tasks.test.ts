/**
 * 日本站「地區任務」（area，pre 階段）的行為測試：migration 20261009210400_policy_jp_area_tasks.sql
 * （設計：policy-jp docs/PLAN-area-tasks.md，一個団体 × 一個選舉週期 × 一個階段 = 一件任務）。
 *
 * 只要 --allow-read。PGlite 上套日本站整條 migration（到 210300）再加這支。
 *   a. 規則：area 開、舊三支（election_discovery、local_government_missing、regional_stats_missing）停用；seed 後只有 area 的派工列
 *   b. 切件：任務集合＝用總務省 3,571 列在 JS 獨立重算（窗口同 election_discovery；首長與議會満了日相差不到 30 天併成一件、日期取早的）
 *   c. 項目：缺什麼列什麼（團體＝所屬都道府県先、再這個團體；統計 4 項；各職位的選舉），補上的、在途的就不列；全補齊 → 任務收回（gap_events filled）
 *   d. 查無只冷卻那一項：<task_id>:election 的 no_change 等票中／冷卻中 → 只拿掉選舉這一項，其他照派；過了冷卻回來；舊 election_discovery 的查無也算
 *   e. 權限、自我檢查（還原驗證）、文字守門（總表＝210100 的版本多一行）
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { lgPrefCode } from "./jp/lg-code.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const CHAIN = [
  "20261008195000_policy_jp_schema.sql", "20261009000000_policy_jp_tables.sql", "20261009130000_policy_jp_dispatch.sql",
  "20261009130100_policy_jp_election_discovery.sql", "20261009130200_policy_jp_term_expirations_r08.sql", "20261009150100_policy_jp_rebalance_anchor.sql",
  "20261009200000_policy_jp_public_stats.sql", "20261009210000_policy_jp_apply.sql", "20261009210100_policy_jp_gap_arms.sql",
  "20261009210200_policy_jp_lg_registry.sql", "20261009210300_policy_jp_lg_registry_data.sql",
];
const CHAIN_SQL = await Promise.all(CHAIN.map(read));
const AREA_FILE = "20261009210400_policy_jp_area_tasks.sql";
const AREA_SQL = await read(AREA_FILE);
const ARMS_210100 = CHAIN_SQL[8];
const TERM_SQL = CHAIN_SQL[4];
const TODAY = "2026-10-09";

const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;
async function freshDb(area = AREA_SQL): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  for (const sql of CHAIN_SQL) await db.exec(sql);
  await db.exec(area);
  await db.exec(`SET app.activity_today = '${TODAY}'`);
  return db;
}
const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
  return sql.replace(from, () => to);
}
function fnText(sql: string, name: string): string {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(i >= 0, `${name} 不在檔案裡`);
  const open = sql.indexOf("$$", i);
  const close = sql.indexOf("$$", open + 2);
  return sql.slice(i, close + 2);
}

type Office = { office_kind: string; election_type: string; term_end: string };
type Target = {
  stage: string; lg_code: string; lg_name: string; pref_code: string; term_end: string; offices: Office[];
  items: { election?: Office[]; local_governments?: string[]; regional_stats?: Array<{ stat_key: string; min_year: number; unit: string }> };
  item_task_ids: Record<string, string>;
};
type AreaRow = { task_id: string; target: Target; what_we_need: string };
const area = async (db: PGlite) => await rows<AreaRow>(db, `SELECT task_id, target, what_we_need FROM policy_jp.contribution_auto_tasks_area() ORDER BY task_id`);
const setCap = (db: PGlite, cap: number) => db.query(`UPDATE policy_jp.activity_rules SET params = params || jsonb_build_object('cap', $1::INT) WHERE activity = 'area'`, [cap]);

// 總務省 3,571 列（跟 policy-jp-apply.test.ts 同一套解析）
type Term = { lg: string; kind: string; etype: string; end: string };
const ROW_RE = /^\s+\('(\d{6})', '([^']+)', '([^']+)', '(head|assembly)', '(\w+)', '(\d{4}-\d{2}-\d{2})', (NULL|'[^']*')\),?$/;
const TERMS: Term[] = TERM_SQL.split("\n").flatMap((line) => {
  const m = ROW_RE.exec(line);
  return m ? [{ lg: m[1], kind: m[4], etype: m[5], end: m[6] }] : [];
});
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
/** JS 獨立重算：窗口內的職位 → 同一團體満了日相差不到 30 天的併件（日期取早的）→ task_id 集合 */
function expectedIds(today: string): string[] {
  const win = TERMS.filter((t) => addDays(t.end, -1) >= "2027-01-01" && addDays(t.end, -180) <= today && addDays(t.end, 60) >= today);
  const ids = new Set<string>();
  for (const t of win) {
    const other = win.find((o) => o.lg === t.lg && o.kind !== t.kind && daysBetween(o.end, t.end) < 30);
    const date = other && other.end < t.end ? other.end : t.end;
    ids.add(`auto:area:${t.lg}:${date}:pre`);
  }
  return [...ids].sort();
}

const shared = await freshDb();

// =============================================================================================
// a. 規則
// =============================================================================================
Deno.test("規則：area 開；舊三支用覆寫 closed 停掉（規則不動）；seed 後派工列只有 area（上限 50），舊三支一列都沒有；健康檢查是空的", async () => {
  const rules = await rows<{ activity: string; enabled: boolean }>(shared,
    `SELECT activity, enabled FROM policy_jp.activity_rules WHERE priority IS NULL AND activity IN ('area', 'election_discovery', 'local_government_missing', 'regional_stats_missing') ORDER BY activity`);
  assertEquals(rules.map((r) => r.enabled), [true, true, true, true]);
  assertEquals(await rows(shared, `SELECT activity, "force", expires_at FROM policy_jp.activity_overrides ORDER BY activity`), [
    { activity: "election_discovery", force: "closed", expires_at: null },
    { activity: "local_government_missing", force: "closed", expires_at: null },
    { activity: "regional_stats_missing", force: "closed", expires_at: null },
  ]);
  const db = await freshDb();
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  assertEquals(await rows(db, `SELECT task_type, count(*)::INT AS n FROM policy_jp.task_dispatches GROUP BY 1`), [{ task_type: "area", n: 50 }]);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.contribution_auto_tasks_arms() WHERE arm <> 'area'`)).n, 0);
  // 健康檢查沒有新的抱怨（臂都有規則）
  assertEquals(await rows(db, `SELECT check_name, subject FROM policy_jp.activity_health WHERE check_name NOT IN ('clock_overridden', 'queue_clock_overridden')`), []);
  await db.close();
});

// =============================================================================================
// b. 切件
// =============================================================================================
Deno.test("切件：任務集合＝JS 獨立重算（窗口、30 天內併件、日期取早的）；滿額時取満了日早的前 50 件", async () => {
  const db = await freshDb();
  await setCap(db, 100_000);
  const got = (await area(db)).map((r) => r.task_id);
  const want = expectedIds(TODAY);
  assert(want.length > 50, `窗口內 ${want.length} 件`);
  assertEquals(got, want);
  // 併件確實發生，而且併件的任務有兩個職位
  const all = await area(db);
  const merged = all.filter((r) => r.target.offices.length === 2);
  assert(merged.length > 0, "至少有一件首長＋議會併在一起");
  for (const r of merged) {
    const [a, b] = r.target.offices;
    assert(daysBetween(a.term_end, b.term_end) < 30);
    assertEquals(r.target.term_end, a.term_end < b.term_end ? a.term_end : b.term_end);
  }
  // 預設上限 50：満了日最早的 50 件（同日依團體碼）
  await setCap(db, 50);
  const capped = await area(db);
  assertEquals(capped.length, 50);
  const byDate = [...all].sort((x, y) => (x.target.term_end + x.target.lg_code < y.target.term_end + y.target.lg_code ? -1 : 1)).slice(0, 50).map((r) => r.task_id).sort();
  assertEquals(capped.map((r) => r.task_id), byDate);
  await db.close();
});

// =============================================================================================
// c. 項目
// =============================================================================================
async function pickMunicipal(db: PGlite): Promise<AreaRow> {
  const r = (await area(db)).find((x) => x.target.lg_code !== x.target.pref_code);
  assert(r, "要有市区町村的任務");
  return r;
}
let seq = 0;
async function submit(db: PGlite, type: string, payload: Record<string, unknown>, status = "pending"): Promise<string> {
  const n = ++seq;
  const id = (await one<{ id: string }>(db,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash)
     VALUES ($1, $2::JSONB, ARRAY['https://www.soumu.go.jp/denshijiti/code.html'], $3, $4, $5) RETURNING id`,
    [type, JSON.stringify(payload), `a-${n}`, `ip-${n}`, `h-${n}`])).id;
  if (status !== "pending") await db.query(`UPDATE policy_jp.contributions SET status = $2 WHERE id = $1`, [id, status]);
  return id;
}

Deno.test("項目：一開始三項都缺（團體＝都道府県先再市、統計 4 項、各職位的選舉）；描述講到每一項與項目的查無 id", async () => {
  const r = await pickMunicipal(shared);
  const t = r.target;
  assertEquals(t.stage, "pre");
  assertEquals(t.pref_code, lgPrefCode(t.lg_code));
  assertEquals(t.items.local_governments, [t.pref_code, t.lg_code]);
  assertEquals(t.items.regional_stats!.map((s) => [s.stat_key, s.min_year, s.unit]),
    [["aging_rate", 2020, "%"], ["area_km2", 2020, "km2"], ["budget_expenditure", 2023, "千円"], ["population", 2020, "人"]]);
  assertEquals(t.items.election!.map((o) => o.election_type).sort(), t.offices.map((o) => o.election_type).sort());
  assertEquals(t.item_task_ids, { election: `${r.task_id}:election`, local_government: `${r.task_id}:local_government`, regional_stats: `${r.task_id}:regional_stats` });
  for (const word of ["【選挙の日程】", "【地方公共団体】", "【地域の統計】", `${r.task_id}:election`, "contribution_type=election", "contribution_type=local_government", "contribution_type=regional_stat"]) {
    assert(r.what_we_need.includes(word), `描述沒有「${word}」`);
  }
});

Deno.test("項目：補上的、在途的就不列；三項都補齊 → 任務收回（gap_events closed／filled）", async () => {
  const db = await freshDb();
  await setCap(db, 100_000);
  const r = await pickMunicipal(db);
  const { lg_code: lg, pref_code: pref } = r.target;
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  const now = async () => (await area(db)).find((x) => x.task_id === r.task_id)?.target;

  const lgPayload = async (code: string) => (await one<{ p: Record<string, unknown> }>(db,
    `SELECT jsonb_build_object('lg_code', lg_code, 'kind', kind, 'pref_code', pref_code, 'name', name, 'kana', kana) AS p FROM policy_jp.lg_code_registry WHERE lg_code = $1`, [code])).p;
  // 都道府県的 local_government 在途 → 只剩這個市
  await submit(db, "local_government", await lgPayload(pref));
  assertEquals((await now())!.items.local_governments, [lg]);
  // 市的也進庫（用機器核對走一趟）→ 團體這一項消失
  await db.query(`SELECT policy_jp.lg_registry_verify_pending()`);
  await submit(db, "local_government", await lgPayload(lg));
  await db.query(`SELECT policy_jp.lg_registry_verify_pending()`);
  await db.query(`SELECT policy_jp.apply_verified_pending(20, 0)`);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.local_governments WHERE lg_code IN ($1, $2)`, [lg, pref])).n, 2);
  assertEquals((await now())!.items.local_governments, undefined);

  // 統計：population 在途、area_km2 已上線但年份太舊（2015 < 2020）→ 兩項裡只有 population 不列
  await submit(db, "regional_stat", { lg_code: lg, stat_key: "population", year: 2025, value: 1, unit: "人" });
  const src = (await one<{ id: number }>(db, `INSERT INTO policy_jp.sources (url, origin) VALUES ('https://www.e-stat.go.jp/x', 'test') RETURNING id::INT AS id`)).id;
  await db.query(`INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, source_id, review_status) VALUES ($1, 'area_km2', 2015, 10, 'km2', $2, 'published')`, [lg, src]);
  assertEquals((await now())!.items.regional_stats!.map((s) => s.stat_key), ["aging_rate", "area_km2", "budget_expenditure"]);
  // 其餘三項已上線（夠新）→ 統計這一項消失（population 在途也算）
  for (const [k, y, v, u] of [["area_km2", 2025, 12.3, "km2"], ["aging_rate", 2025, 30.1, "%"], ["budget_expenditure", 2023, 1000, "千円"]] as const) {
    await db.query(`INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, source_id, review_status) VALUES ($1, $2, $3, $4, $5, $6, 'published')`, [lg, k, y, v, u, src]);
  }
  assertEquals((await now())!.items.regional_stats, undefined);

  // 選舉：每個職位補一場（已上線）→ 選舉這一項消失 → 三項齊了，任務算不出來
  assert((await now())!.items.election);
  for (const o of r.target.offices) {
    await db.query(`INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, lg_code, review_status)
                    VALUES ($1, $2, $3::DATE - 14, $4, 'regular', policy_jp.election_level($4), $5, 'published')`,
      [`${o.term_end}_${o.election_type}_${lg}`, `x${o.election_type}`, o.term_end, o.election_type, lg]);
  }
  assertEquals(await now(), undefined);
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches WHERE task_id = $1`, [r.task_id])).n, 0);
  assertEquals((await one<{ event: string; reason: string }>(db,
    `SELECT event, reason FROM policy_jp.gap_events WHERE task_id = $1 ORDER BY id DESC LIMIT 1`, [r.task_id])), { event: "closed", reason: "filled" });
  await db.close();
});

// =============================================================================================
// d. 查無只冷卻那一項
// =============================================================================================
Deno.test("查無只冷卻那一項：<task_id>:election 的 no_change 等票中、通過後冷卻 14 天 → 只拿掉選舉，團體與統計照派；15 天後回來；舊 election_discovery 的冷卻也算", async () => {
  const db = await freshDb();
  await setCap(db, 100_000);
  const r = await pickMunicipal(db);
  const now = async () => (await area(db)).find((x) => x.task_id === r.task_id)?.target;
  const ncPayload = { task_id: `${r.task_id}:election`, outcome: "not_found", checked_urls: ["https://example.lg.jp/senkyo/"], finding: "まだ告示されていない" };
  const nc = await submit(db, "no_change", ncPayload);
  let t = (await now())!;
  assertEquals(t.items.election, undefined, "等票中：選舉這一項先不問");
  assert(t.items.local_governments && t.items.regional_stats, "其他兩項照派");
  // 通過 → 落庫記 task_checks（冷卻）
  await db.query(`UPDATE policy_jp.contributions SET status = 'verified' WHERE id = $1`, [nc]);
  assertEquals((await one<{ r: { status: string } }>(db, `SELECT policy_jp.apply_contribution($1) AS r`, [nc])).r.status, "applied");
  assertEquals((await one<{ task_id: string }>(db, `SELECT task_id FROM policy_jp.task_checks ORDER BY id DESC LIMIT 1`)).task_id, `${r.task_id}:election`);
  assertEquals((await now())!.items.election, undefined, "冷卻中");
  // 冷卻過了（把查核時間挪到 15 天前）→ 選舉回來
  await db.query(`UPDATE policy_jp.task_checks SET checked_at = now() - interval '15 days'`);
  assert((await now())!.items.election, "冷卻過了，選舉回來");
  // 任務本身沒被擋：派工列不是 blocked
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  // 舊 election_discovery 任務的冷卻也算（銜接：之前回報過查無的不重問）
  const o = r.target.offices[0];
  await db.query(`INSERT INTO policy_jp.task_checks (task_id, agent_name, outcome) VALUES ($1, 'legacy', 'not_found')`,
    [`auto:election_discovery:${o.term_end}:${r.target.lg_code}:${o.office_kind}`]);
  assertEquals((await now())!.items.election, undefined);
  await db.close();
});

// =============================================================================================
// e. 權限、自我檢查、文字守門
// =============================================================================================
Deno.test("權限：area 臂與項目判斷只給 service_role", async () => {
  for (const fn of ["policy_jp.contribution_auto_tasks_area()", "policy_jp.area_item_dead_end(text[])"]) {
    assertEquals((await one<{ ok: boolean }>(shared, `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') AS ok`)).ok, false, fn);
    assertEquals((await one<{ ok: boolean }>(shared, `SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE') AS ok`)).ok, true, fn);
  }
});

Deno.test("自我檢查（還原驗證）：舊三支少一筆 closed 覆寫、area 規則缺 stat_min_year，套用都會失敗", async () => {
  const noClose = mutate(AREA_SQL, "SELECT a, 'closed', '10-09 併進地區任務 area", "SELECT a, 'window', '10-09 併進地區任務 area");
  await assertRejects(() => freshDb(noClose), Error);
  const noOverride = mutate(AREA_SQL, "  FROM unnest(ARRAY['election_discovery', 'local_government_missing', 'regional_stats_missing']) AS a\n WHERE NOT EXISTS",
    "  FROM unnest(ARRAY['election_discovery', 'local_government_missing']) AS a\n WHERE NOT EXISTS");
  await assertRejects(() => freshDb(noOverride), Error, "regional_stats_missing");
  const noStats = mutate(AREA_SQL, `|| '{"merge_days":30,"stat_min_year":{"population":2020,"area_km2":2020,"aging_rate":2020,"budget_expenditure":2023}}'::JSONB`, `|| '{"merge_days":30}'::JSONB`);
  await assertRejects(() => freshDb(noStats), Error, "stat_min_year");
});

Deno.test("文字守門：總表＝210100 的版本多一行 area 分支、臂名多一個 area，其餘一字不改；不碰 public、不寫正式表", () => {
  const total = (sql: string) => fnText(sql, "policy_jp.contribution_auto_tasks_arms");
  assertEquals(total(AREA_SQL), mutate(total(ARMS_210100),
    "  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_regional_stats_missing() t\n",
    "  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_regional_stats_missing() t\n  UNION ALL SELECT 'area' AS arm, t.* FROM policy_jp.contribution_auto_tasks_area() t\n"));
  const names = (sql: string) => fnText(sql, "policy_jp.activity_arm_names");
  assertEquals(names(AREA_SQL), mutate(names(ARMS_210100), "    'regional_stats_missing'\n", "    'regional_stats_missing',\n    'area'\n"));
  const code = AREA_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(code));
  for (const t of ["elections", "local_governments", "regional_stats", "contributions"]) {
    assert(!new RegExp(`(INSERT\\s+INTO|UPDATE)\\s+policy_jp\\.${t}\\b`, "i").test(code), `不寫 ${t}`);
  }
});
