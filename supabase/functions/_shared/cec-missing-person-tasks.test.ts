/**
 * 「中選會名單有、本站沒有」→ 單人補參選紀錄任務（migration 20261102210000，policy-ops#175 補充）的守門。
 *
 * 守住：
 *   1. 只有「名單有、我們沒有，且該單位的名單清查已結案（佇列沒有那一列，或在冷卻）」的人各開一張 candidacy_source_missing（kind=roster_missing）手動任務；
 *      清查還開著的單位、我們已有的人都不開
 *   2. 任務 target 帶姓名、號次、政黨、出生年（民國→西元）、村里（村里長用 li_code 對 regions.admin_code 末三碼）、官方網址、同名人物清單；說明寫明做法
 *   3. 冪等：重跑不重複；已有 open 的跳過；7 天內關閉的跳過；超過 7 天關閉的會再開
 *   4. 不改任何參選資料
 * 還原驗證：拿掉「清查已結案」條件，開著清查的單位也會被開；拿掉冪等條件，重跑會重複建。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, mutate, readMig } from "./arms-pglite.ts";

const M = await readMig("20261031160000_cec_roster_2026.sql");
const HINT = await readMig("20261031140000_cand_no_cec_json_hint.sql");
const X = await readMig("20261102210000_cec_missing_person_tasks.sql");
const section = (sql: string, name: string) => {
  const a = sql.indexOf(`-- ▼▼ SECTION: ${name} ▼▼`);
  const b = sql.indexOf(`-- ▲▲ SECTION: ${name} ▲▲`);
  assert(a >= 0 && b > a, `找不到段落 ${name}`);
  return sql.slice(a, b);
};
const strip = (s: string) => s.replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");

const SCHEMA = `
CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, party text, region text, sub_region text, merged_into uuid, birth_year integer);
CREATE TABLE regions (id serial PRIMARY KEY, region text, sub_region text, village text, admin_code text);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, cooling boolean NOT NULL DEFAULT false);
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
  const body = strip(mutateX(X)).replace(/^SELECT cec_missing_person_tasks_create\('cec-missing-sweep'\);\s*$/m, "");
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
const V_URL = "https://info.cec.gov.tw/vote2026/static/json/cand/V/10015010.json";
async function loadVillage(db: PGlite, rows: { name: string; no: number; li: string; birth?: string }[]) {
  await db.query(`SELECT cec_roster_seed_units()`);
  const u = await db.query<{ url: string }>(`SELECT url FROM cec_roster_units WHERE election_type = '村里長' AND county = '花蓮縣' AND town = '花蓮市'`);
  const url = u.rows[0]?.url ?? V_URL;
  const res = await db.query<{ r: string }>(`SELECT cec_roster_replace_unit($1, 200, $2::jsonb) AS r`, [
    url, JSON.stringify(rows.map((r) => ({ name: r.name, cand_no: r.no, party: "新生黨", birth: r.birth ?? "0650306", home: "", district: "", area_code: "", dept_code: "", li_code: r.li }))),
  ]);
  assertEquals(res.rows[0].r, "ok");
  return url;
}
async function scenario(db: PGlite) {
  // 花蓮市：國盛里 043、民立里 001 兩個里的名單
  await db.exec(`INSERT INTO regions (region, sub_region, village, admin_code) VALUES
    ('花蓮縣', '花蓮市', NULL, '10015010'), ('花蓮縣', '花蓮市', '國盛里', '10015010043'), ('花蓮縣', '花蓮市', '民立里', '10015010001'), ('花蓮縣', '花蓮市', '主信里', '10015010004')`);
  await db.exec(`INSERT INTO politicians (name, party, region, birth_year) VALUES ('周玉梅', '制度救世島', '花蓮縣', 1976)`);
  const rid = (await db.query<{ id: number }>(`SELECT id FROM regions WHERE village = '民立里'`)).rows[0].id;
  const pid = (await db.query<{ id: string }>(`INSERT INTO politicians (name, region) VALUES ('王大有', '花蓮縣') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status, cand_no) VALUES (2026, '村里長', $1, $2, 'filed', 2)`, [pid, rid]);
  const url = await loadVillage(db, [
    { name: "周玉梅", no: 1, li: "043" }, // 名單有、我們沒有 → 開
    { name: "王大有", no: 2, li: "001" }, // 我們有 → 不開
    { name: "李清查", no: 3, li: "004" }, // 名單有、我們沒有；但清查還開著（測試中切換）
  ]);
  return url;
}
const TID = "auto:roster_check:2026:花蓮縣花蓮市:村里長";
const create = async (db: PGlite) => (await db.query<{ n: number }>(`SELECT cec_missing_person_tasks_create('cec-missing-sweep') AS n`)).rows[0].n;
const tasks = async (db: PGlite) => (await db.query<Record<string, any>>(`SELECT * FROM contribution_tasks ORDER BY created_at, title`)).rows;

Deno.test("清查已結案（佇列沒有那一列）：名單有我們沒有的人各開一張，欄位與說明照範本", async () => {
  const db = await buildDb();
  const url = await scenario(db);
  assertEquals(await create(db), 2);
  const t = (await tasks(db)).find((r) => r.target.name === "周玉梅")!;
  assertEquals(t.title, "補「周玉梅」2026 參選紀錄（中選會名單有、本站沒有）");
  assertEquals(t.task_type, "candidacy_source_missing");
  assertEquals([t.source, t.created_by, t.status], ["manual", "cec-missing-sweep", "open"]);
  assertEquals([t.target.kind, t.target.origin, t.target.election_id], ["roster_missing", "cec_roster_missing", 2026]);
  assertEquals([t.target.election_type, t.target.region, t.target.sub_region, t.target.village], ["村里長", "花蓮縣", "花蓮市", "國盛里"]);
  assertEquals([t.target.cand_no, t.target.party, t.target.birth_roc, t.target.birth_year], [1, "新生黨", "0650306", 1976]);
  assertEquals(t.target.source_url, url);
  assertEquals(t.target.same_name_politicians.length, 1);
  assertEquals(t.target.same_name_politicians[0].birth_year, 1976);
  for (const w of ["周玉梅", "國盛里", "號次 1", "新生黨", "0650306", "西元 1976", url, "candidacy", "politician_id", "cand_no"]) {
    assert(t.description.includes(w), `說明缺 ${w}`);
  }
  assert(t.hint_sources.includes(url));
});

Deno.test("清查還開著的單位不開；冷卻中算已結案", async () => {
  const db = await buildDb();
  await scenario(db);
  await db.exec(`INSERT INTO task_dispatches (task_id) VALUES ('${TID}')`);
  assertEquals(await create(db), 0);
  await db.exec(`UPDATE task_dispatches SET cooling = true`);
  assertEquals(await create(db), 2);
});

Deno.test("不改任何參選資料", async () => {
  const db = await buildDb();
  await scenario(db);
  const snap = async () => JSON.stringify([(await db.query(`SELECT * FROM politician_elections ORDER BY id`)).rows, (await db.query(`SELECT * FROM politicians ORDER BY id`)).rows]);
  const before = await snap();
  await create(db);
  assertEquals(await snap(), before);
});

Deno.test("冪等：重跑不重複；open 的跳過；7 天內關閉的跳過；超過 7 天關閉的再開", async () => {
  const db = await buildDb();
  await scenario(db);
  assertEquals(await create(db), 2);
  assertEquals(await create(db), 0);
  await db.exec(`UPDATE contribution_tasks SET status = 'closed', closed_at = now() - interval '3 days'`);
  assertEquals(await create(db), 0);
  await db.exec(`UPDATE contribution_tasks SET closed_at = now() - interval '8 days'`);
  assertEquals(await create(db), 2);
  assertEquals((await tasks(db)).length, 4);
});

Deno.test("還原驗證：拿掉「清查已結案」條件，清查開著的單位也會被開", async () => {
  const db = await buildDb((s) => mutate(s, "AND NOT EXISTS (SELECT 1 FROM q WHERE q.tid = 'auto:roster_check:2026:' || d.county || d.town || ':' || d.election_type)", ""));
  await scenario(db);
  await db.exec(`INSERT INTO task_dispatches (task_id) VALUES ('${TID}')`);
  assertEquals(await create(db), 2); // 守門失效 → 本該是 0
});

Deno.test("還原驗證：拿掉冪等條件，重跑會重複建", async () => {
  const db = await buildDb((s) => mutate(s, "AND (t.status = 'open' OR t.closed_at > now() - INTERVAL '7 days'))", "AND false)"));
  await scenario(db);
  assertEquals(await create(db), 2);
  assertEquals(await create(db), 2);
  assertEquals((await tasks(db)).length, 4);
});
