/**
 * 「站上有、中選會名單沒有」→ 查參選狀態任務（migration 20261101030000）的守門。
 *
 * 守住：
 *   1. 只為「2026、filed、名單查無此人」的人各開一張 candidate_status_stale 手動任務（source=manual、created_by=cec-extra-sweep），
 *      對得上名單的、退選的、考慮中的（非 filed）、單位沒抓到的都不開
 *   2. 任務 target 帶 politician_id、politician_election_id、election_id=2026、source_url；標題與說明照範本
 *   3. 冪等：重跑不重複；已有 open 的跳過；7 天內關閉的跳過；超過 7 天關閉的會再開
 *   4. 不改任何參選資料
 * 還原驗證：拿掉冪等條件，重跑會重複建；拿掉 filed 條件，考慮中的人也會被開（見最後兩個測試）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, mutate, readMig } from "./arms-pglite.ts";

const M = await readMig("20261031160000_cec_roster_2026.sql");
const HINT = await readMig("20261031140000_cand_no_cec_json_hint.sql");
const X = await readMig("20261101030000_cec_extra_status_tasks.sql");
const section = (sql: string, name: string) => {
  const a = sql.indexOf(`-- ▼▼ SECTION: ${name} ▼▼`);
  const b = sql.indexOf(`-- ▲▲ SECTION: ${name} ▲▲`);
  assert(a >= 0 && b > a, `找不到段落 ${name}`);
  return sql.slice(a, b);
};
const strip = (s: string) => s.replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");

const SCHEMA = `
CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, party text, region text, sub_region text, merged_into uuid);
CREATE TABLE regions (id serial PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politician_elections (id serial PRIMARY KEY, election_id integer NOT NULL, election_type text, politician_id uuid NOT NULL,
  region_id integer, candidacy_status text, cand_no integer);
CREATE TABLE contribution_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text, task_type text NOT NULL,
  target jsonb NOT NULL DEFAULT '{}', region text, priority integer NOT NULL DEFAULT 1, reward integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open', created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  source text, suggested_by text, hint_sources text[] DEFAULT '{}', requester_ip_hash text, closed_at timestamptz);
`;

async function buildDb(mutateX: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(await latestFn("cec_name_norm"));
  await db.exec(await latestFn("cec_name_key"));
  await db.exec(await latestFn("roster_name_fold"));
  await db.exec(await latestFn("roster_name_key"));
  await db.exec(await latestFn("ballot_number_unit"));
  const fnStart = HINT.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()");
  await db.exec(HINT.slice(0, fnStart));
  const REG = await readMig("20261008130000_cec_registrations.sql");
  await db.exec(REG.slice(0, REG.indexOf("CREATE OR REPLACE FUNCTION roster_registration_gap(")));
  for (const s of ["tables", "match", "mirror", "reconcile", "source", "gap"]) await db.exec(strip(section(M, s)));
  // 只跑函式本體，不跑結尾那句 SELECT（測試自己呼叫）
  const body = strip(mutateX(X)).replace(/^SELECT cec_extra_status_tasks_create\('cec-extra-sweep'\);\s*$/m, "");
  await db.exec(body);
  return db;
}

async function region(db: PGlite, r: string, sub: string | null): Promise<number> {
  const ex = await db.query<{ id: number }>(`SELECT id FROM regions WHERE region = $1 AND sub_region IS NOT DISTINCT FROM $2`, [r, sub]);
  if (ex.rows[0]) return ex.rows[0].id;
  return (await db.query<{ id: number }>(`INSERT INTO regions (region, sub_region) VALUES ($1, $2) RETURNING id`, [r, sub])).rows[0].id;
}
async function ours(db: PGlite, name: string, no: number | null, o: { county?: string; sub?: string | null; status?: string } = {}): Promise<number> {
  const county = o.county ?? "台北市";
  const pid = (await db.query<{ id: string }>(`INSERT INTO politicians (name, region) VALUES ($1, $2) RETURNING id`, [name, county])).rows[0].id;
  const rid = await region(db, county, o.sub === undefined ? "第07選舉區" : o.sub);
  return (await db.query<{ id: number }>(
    `INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status, cand_no) VALUES (2026, '縣市議員', $1, $2, $3, $4) RETURNING id`,
    [pid, rid, o.status ?? "filed", no],
  )).rows[0].id;
}
const T_URL = "https://info.cec.gov.tw/vote2026/static/json/cand/T/63000.json";
async function loadCouncil(db: PGlite, rows: { name: string; no: number }[]) {
  await db.query(`SELECT cec_roster_seed_units()`);
  const res = await db.query<{ r: string }>(`SELECT cec_roster_replace_unit($1, 200, $2::jsonb) AS r`, [
    T_URL, JSON.stringify(rows.map((r) => ({ name: r.name, cand_no: r.no, party: "無", birth: "0600101", home: "", district: "臺北市第7選舉區", area_code: "07", dept_code: "", li_code: "" }))),
  ]);
  assertEquals(res.rows[0].r, "ok");
}
async function scenario(db: PGlite) {
  const pe = {
    ok: await ours(db, "王小明", 1),
    extra: await ours(db, "林某某", 9), // 名單查無此人、filed → 開
    considering: await ours(db, "考慮乙", 10, { status: "considering" }), // 不是 filed → 不開
    withdrawn: await ours(db, "退選甲", 11, { status: "withdrawn" }), // 退選 → 不開
    other: await ours(db, "高雄人", 1, { county: "高雄市", sub: "第01選舉區" }), // 單位沒抓到 → 不開
  };
  await loadCouncil(db, [{ name: "王小明", no: 1 }]);
  return pe;
}
const create = async (db: PGlite) => (await db.query<{ n: number }>(`SELECT cec_extra_status_tasks_create('cec-extra-sweep') AS n`)).rows[0].n;
const tasks = async (db: PGlite) => (await db.query<Record<string, any>>(`SELECT * FROM contribution_tasks ORDER BY created_at, title`)).rows;

Deno.test("只為 filed 且名單查無此人的人各開一張任務，欄位與文字照範本", async () => {
  const db = await buildDb();
  const pe = await scenario(db);
  assertEquals(await create(db), 1);
  const t = await tasks(db);
  assertEquals(t.length, 1);
  assertEquals(t[0].title, "查「林某某」2026 參選狀態（中選會名單查無此人）");
  assertEquals(t[0].task_type, "candidate_status_stale");
  assertEquals([t[0].source, t[0].created_by, t[0].status], ["manual", "cec-extra-sweep", "open"]);
  assertEquals(t[0].target.politician_election_id, pe.extra);
  assertEquals(t[0].target.election_id, 2026);
  assert(typeof t[0].target.politician_id === "string");
  assertEquals(t[0].target.source_url, T_URL);
  assert(t[0].description.includes("查無「林某某」") && t[0].description.includes("退選、資格不符、或只是姓名寫法不同") && t[0].description.includes(T_URL));
  assert(t[0].hint_sources.includes(T_URL));
});

Deno.test("不改任何參選資料", async () => {
  const db = await buildDb();
  await scenario(db);
  const before = JSON.stringify((await db.query(`SELECT * FROM politician_elections ORDER BY id`)).rows);
  await create(db);
  assertEquals(JSON.stringify((await db.query(`SELECT * FROM politician_elections ORDER BY id`)).rows), before);
});

Deno.test("冪等：重跑不重複；open 的跳過；7 天內關閉的跳過；超過 7 天關閉的再開", async () => {
  const db = await buildDb();
  await scenario(db);
  assertEquals(await create(db), 1);
  assertEquals(await create(db), 0);
  await db.exec(`UPDATE contribution_tasks SET status = 'closed', closed_at = now() - interval '3 days'`);
  assertEquals(await create(db), 0);
  await db.exec(`UPDATE contribution_tasks SET closed_at = now() - interval '8 days'`);
  assertEquals(await create(db), 1);
  assertEquals((await tasks(db)).length, 2);
});

Deno.test("還原驗證：拿掉冪等條件，重跑會重複建", async () => {
  const db = await buildDb((s) => mutate(s, "AND (t.status = 'open' OR t.closed_at > now() - INTERVAL '7 days'))", "AND false)"));
  await scenario(db);
  assertEquals(await create(db), 1);
  assertEquals(await create(db), 1); // 冪等失效 → 重複
  assertEquals((await tasks(db)).length, 2);
});

Deno.test("還原驗證：拿掉 filed 條件，考慮中的人也會被開任務", async () => {
  const db = await buildDb((s) => mutate(s, "AND d.our_status = 'filed' ", ""));
  await scenario(db);
  assertEquals(await create(db), 2);
});
