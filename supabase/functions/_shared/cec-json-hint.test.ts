/**
 * 補號次任務帶上中選會選舉專區候選人 JSON（含 candNo）（2026-10-31，維護者批准「作 A」；migration 20261031140000）。
 *
 * 守住：
 *   1. 網址組得對：7 種選舉別各一例（縣市長 C1、縣市議員 T、鄉鎮市長 D1、區長 D2、鄉鎮市民代表 R、區民代表 R3 各一檔涵蓋整縣市；村里長 V1 每鄉鎮一檔），臺／台寫法都認，對不到回 NULL
 *   2. 對照表跟 dist/prvCityDept.json 一樣大（22 縣市、368 個鄉鎮市區）
 *   3. 補號次臂：2026 屆的缺口任務 target.cec_json_url、hint_sources 第一個、what_we_need 都帶；別屆不帶；cand_no_recheck 也帶
 *   4. 驗證端：cand_numbers／帶號次 candidacy 的驗證項附同一個網址；SOURCE_HINTS 認得 info.cec.gov.tw
 *   5. 協議版號不低於 1.108.1
 * 還原驗證：拿掉 target／hint_sources／網址路徑任何一處，對應的測試會紅。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig, BALLOT_MIG } from "./arms-pglite.ts";
import { cecJsonVerifyHint, cecNoChangeVerifyHint, fetchVerifyContext, parseCandNoTaskId, shapeVerifyCurrent, sourceHintsFor } from "./task-context.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const M = await readMig("20261031140000_cand_no_cec_json_hint.sql");
const N = await readMig("20261009070000_rep_district_ballot_unit.sql");
const B = await readMig(BALLOT_MIG);
const FN_START = M.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()");
assert(FN_START > 0);
/** migration 前半（對照表、INSERT、網址函式）；整支函式留給 armDb 另外裝 */
const CODES_SQL = M.slice(0, FN_START);
const PRE = "https://info.cec.gov.tw/vote2026/static/json/cand/";

async function codesDb(mutateSql?: (s: string) => string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mutateSql ? mutateSql(CODES_SQL) : CODES_SQL);
  return db;
}
const url = async (db: PGlite, type: string, county: string, town: string | null) =>
  (await db.query<{ u: string | null }>(`SELECT cec_vote2026_cand_url($1, $2, $3) AS u`, [type, county, town])).rows[0].u;

// ── 1. 網址 ───────────────────────────────────────────────────────
Deno.test("網址：七種選舉別各一例（縣市長、議員、鄉鎮市長、區長、代表、區代表整縣市一檔；村里長每鄉鎮一檔）", async () => {
  const db = await codesDb();
  assertEquals(await url(db, "縣市長", "苗栗縣", null), `${PRE}C1/10005.json`);
  assertEquals(await url(db, "縣市議員", "高雄市", null), `${PRE}T/64000.json`);
  assertEquals(await url(db, "鄉鎮市長", "屏東縣", "三地門鄉"), `${PRE}D1/10013.json`);
  assertEquals(await url(db, "直轄市山地原住民區長", "新北市", "烏來區"), `${PRE}D2/65000.json`);
  assertEquals(await url(db, "鄉鎮市民代表", "苗栗縣", "苗栗市"), `${PRE}R/10005.json`);
  assertEquals(await url(db, "直轄市山地原住民區民代表", "新北市", "烏來區"), `${PRE}R3/65000.json`);
  // 村里長：檔名是 <縣市碼><鄉鎮碼>（苗栗市 010、台北市士林區 110；2026-10-31 實測這兩檔 200）
  assertEquals(await url(db, "村里長", "苗栗縣", "苗栗市"), `${PRE}V1/10005/10005010.json`);
  assertEquals(await url(db, "村里長", "台北市", "士林區"), `${PRE}V1/63000/63000110.json`);
  await db.close();
});

Deno.test("網址：臺／台兩種寫法都認；縣市或鄉鎮對不到、村里長沒鄉鎮、不認得的選舉別都回 NULL", async () => {
  const db = await codesDb();
  assertEquals(await url(db, "縣市長", "臺北市", null), `${PRE}C1/63000.json`);
  assertEquals(await url(db, "村里長", "臺中市", "豐原區") === await url(db, "村里長", "台中市", "豐原區"), true);
  assertEquals(await url(db, "村里長", "苗栗縣", "不存在鄉"), null);
  assertEquals(await url(db, "村里長", "苗栗縣", null), null, "村里長每鄉鎮一檔，沒鄉鎮組不出");
  assertEquals(await url(db, "縣市長", "火星市", null), null);
  assertEquals(await url(db, "立法委員", "苗栗縣", null), null);
  await db.close();
});

Deno.test("網址：路徑還原驗證——把議員的 T 改掉，議員那一例會紅", async () => {
  const db = await codesDb((s) => mutate(s, "WHEN '縣市議員' THEN 'T'", "WHEN '縣市議員' THEN 'X'"));
  assert((await url(db, "縣市議員", "高雄市", null)) !== `${PRE}T/64000.json`);
  await db.close();
});

// ── 2. 對照表 ──────────────────────────────────────────────────────
Deno.test("對照表：22 縣市、368 個鄉鎮市區（跟 dist/prvCityDept.json 一樣大），名稱不含臺", async () => {
  const db = await codesDb();
  const r = await db.query<{ c: number; t: number; bad: number }>(
    `SELECT count(*) FILTER (WHERE town = '')::int AS c, count(*) FILTER (WHERE town <> '')::int AS t, count(*) FILTER (WHERE county LIKE '%臺%' OR town LIKE '%臺%')::int AS bad FROM cec_vote2026_codes`);
  assertEquals(r.rows[0], { c: 22, t: 368, bad: 0 });
  await db.close();
});

// ── 3. 補號次臂 ────────────────────────────────────────────────────
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function armDb(mutateFn?: (s: string) => string): Promise<PGlite> {
  const db = new PGlite();
  const dupViews = (sql: string, name: string) => {
    const a = sql.indexOf(`CREATE OR REPLACE VIEW ${name} AS`);
    assert(a >= 0, `找不到視圖 ${name}`);
    return sql.slice(a, sql.indexOf(";\nCOMMENT ON VIEW", a) + 1);
  };
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text, region text, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, election_id integer, politician_id uuid, election_type text, region_id integer, candidacy_status text, cand_no integer);
    CREATE TABLE contributions (id serial PRIMARY KEY, contribution_type text, status text, payload jsonb);
    CREATE TABLE election_milestones_all (election_id integer, kind text, election_type text, on_date date, status text);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT date '2026-10-23' $$;
    CREATE FUNCTION candidacy_list_published(p_election_id integer, p_election_type text, p_on date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    ${await latestFn("candidacy_protocol_status")}
    ${fnText(N, "ballot_number_unit")}
    ${fnText(B, "ballot_number_dups")}
    ${fnText(B, "ballot_number_missing")}
    ${dupViews(N, "ballot_number_units")}
    ${dupViews(B, "ballot_number_anomalies")}
    ${CODES_SQL}
    ${fnText(mutateFn ? mutateFn(M) : M, "contribution_auto_tasks_ballot_numbers")}`);
  await db.exec(`INSERT INTO elections VALUES (2026, '2026-11-28'), (2027, '2027-11-27')`);
  await db.exec(`INSERT INTO election_milestones_all VALUES (2026, 'draw', NULL, '2026-10-23', 'announced'), (2027, 'draw', NULL, '2026-10-23', 'announced')`);
  await db.exec(`INSERT INTO regions VALUES (1, '苗栗縣', '苗栗市', '為公里'), (2, '台北市', NULL, NULL)`);
  const rows: Array<[number, number, string, number]> = [
    [1, 2026, "縣市長", 2], [2, 2026, "村里長", 1], [3, 2027, "縣市長", 2],
  ];
  for (const [id, eid, type, rid] of rows) {
    await db.query(`INSERT INTO politicians VALUES ($1, $2, '台北市', NULL)`, [U(id), `人${id}`]);
    await db.query(`INSERT INTO politician_elections VALUES ($1, $2, $3, $4, $5, 'filed', NULL)`, [id, eid, U(id), type, rid]);
  }
  return db;
}
type Task = { task_id: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[] };
const tasks = async (db: PGlite) => (await db.query<Task>(`SELECT task_id, target, what_we_need, hint_sources FROM contribution_auto_tasks_ballot_numbers() WHERE target->>'kind' = 'cand_no'`)).rows;
const byEid = (ts: Task[], eid: number, type: string) => ts.find((t) => t.target.election_id === eid && t.target.election_type === type)!;

Deno.test("補號次臂：2026 屆任務 target.cec_json_url、hint_sources 第一個、what_we_need 都帶；村里長用鄉鎮檔；別屆不帶", async () => {
  const db = await armDb();
  const ts = await tasks(db);
  assertEquals(ts.length, 3);
  const mayor = byEid(ts, 2026, "縣市長");
  assertEquals(mayor.target.cec_json_url, `${PRE}C1/63000.json`);
  assert(mayor.hint_sources[0].startsWith(`${PRE}C1/63000.json`), "第一順位");
  assertStringIncludes(mayor.what_we_need, "候選人 JSON 已含號次（candNo），請以姓名對應");
  assertStringIncludes(mayor.what_we_need, `${PRE}C1/63000.json`);
  assertStringIncludes(mayor.what_we_need, "整個縣市");
  const village = byEid(ts, 2026, "村里長");
  assertEquals(village.target.cec_json_url, `${PRE}V1/10005/10005010.json`);
  assert(village.hint_sources[0].startsWith(`${PRE}V1/10005/10005010.json`));
  assertStringIncludes(village.what_we_need, "liCode");
  const other = byEid(ts, 2027, "縣市長");
  assertEquals(other.target.cec_json_url, undefined, "非 2026 屆不帶（static/json 是 vote2026）");
  assert(!other.hint_sources[0].startsWith("https://info.cec.gov.tw"), "非 2026 屆 hint 照舊");
  assertEquals(other.hint_sources.length, byEid(ts, 2026, "縣市長").hint_sources.length - 1, "只多了第一個");
  await db.close();
});

Deno.test("補號次臂：既有的 4 條 hint 與整批交件說明沒被動到（只多不少）", async () => {
  const db = await armDb();
  const mayor = byEid(await tasks(db), 2026, "縣市長");
  assertEquals(mayor.hint_sources.length, 5);
  assertStringIncludes(mayor.hint_sources[1], "web.cec.gov.tw/<縣市選委會代碼>ec/");
  assertStringIncludes(mayor.what_we_need, "一份** cand_numbers");
  await db.close();
});

Deno.test("補號次臂還原驗證：拿掉 target、hint_sources 第一順位任一處，對應的斷言會紅", async () => {
  const noTarget = await armDb((s) => mutate(s, "'candidate_status', u.candidate_status, 'cec_json_url', u.cec_url,", "'candidate_status', u.candidate_status,"));
  assertEquals(byEid(await tasks(noTarget), 2026, "縣市長").target.cec_json_url, undefined);
  await noTarget.close();
  const noHint = await armDb((s) => mutate(s, "CASE WHEN u.cec_url IS NOT NULL THEN ARRAY[u.cec_url ||", "CASE WHEN false THEN ARRAY[u.cec_url ||"));
  assert(!byEid(await tasks(noHint), 2026, "縣市長").hint_sources[0].startsWith(PRE));
  await noHint.close();
});

Deno.test("重查任務（cand_no_recheck）也帶：target.cec_json_url、hint_sources 第一個", async () => {
  const db = await armDb();
  // 同單位兩位同號 → recheck
  await db.exec(`INSERT INTO regions VALUES (3, '台北市', '第01選舉區', NULL)`);
  await db.exec(`INSERT INTO politicians VALUES ('${U(21)}', '甲', '台北市', NULL), ('${U(22)}', '乙', '台北市', NULL)`);
  await db.exec(`INSERT INTO politician_elections VALUES (21, 2026, '${U(21)}', '縣市議員', 3, 'filed', 1), (22, 2026, '${U(22)}', '縣市議員', 3, 'filed', 1)`);
  const r = await db.query<Task>(`SELECT task_id, target, what_we_need, hint_sources FROM contribution_auto_tasks_ballot_numbers() WHERE target->>'kind' = 'cand_no_recheck'`);
  assert(r.rows.length >= 1, "有重查任務");
  assertEquals(r.rows[0].target.cec_json_url, `${PRE}T/63000.json`);
  assert(r.rows[0].hint_sources[0].startsWith(`${PRE}T/63000.json`));
  assertStringIncludes(r.rows[0].what_we_need, "candNo");
  await db.close();
});

// ── 4. 驗證端 ──────────────────────────────────────────────────────
const CJ = `${PRE}C1/63000.json`;
const PAYLOAD = { election_id: 2026, election_type: "縣市長", region: "台北市", items: [{ politician_election_id: 101, cand_no: 1 }] };

Deno.test("驗證項：cand_numbers 附 cec_json_url 與一句 hint；沒有網址時照舊", () => {
  const cur = shapeVerifyCurrent("cand_numbers", PAYLOAD, { cand_rows: [], cand_conflicts: [], cec_json_url: CJ } as never);
  assertEquals(cur.cec_json_url, CJ);
  assertStringIncludes(String(cur.hint), CJ);
  assertStringIncludes(String(cur.hint), "candNo");
  assertStringIncludes(String(cur.hint), "bad_items", "原本教 bad_items 的說明還在");
  const none = shapeVerifyCurrent("cand_numbers", PAYLOAD, { cand_rows: [], cand_conflicts: [] } as never);
  assertEquals("cec_json_url" in none, false);
  assert(!String(none.hint).includes("candNo"));
});

Deno.test("驗證項：帶號次的 candidacy 也附同一份；不帶號次的 candidacy 不附", () => {
  const withNo = shapeVerifyCurrent("candidacy", { ...PAYLOAD, name: "甲", cand_no: 3 }, { cec_json_url: CJ } as never);
  assertEquals(withNo.cec_json_url, CJ);
  assertStringIncludes(String(withNo.hint), CJ);
  const withoutNo = shapeVerifyCurrent("candidacy", { ...PAYLOAD, name: "甲" }, {} as never);
  assert(!String(withoutNo.hint).includes("candNo"));
  assertStringIncludes(cecJsonVerifyHint(CJ), CJ);
});

Deno.test("驗證 context：2026 屆 cand_numbers 向 SQL 要網址（rpc cec_vote2026_cand_url）；別屆不問", async () => {
  const calls: unknown[] = [];
  const rpc = { cand_no_batch_conflicts: () => [], cec_vote2026_cand_url: (a: unknown) => { calls.push(a); return CJ; } };
  const fake = createFakeSupabase({ politician_elections: [] }, rpc);
  const d = await fetchVerifyContext(fake.client, "cand_numbers", PAYLOAD, "c-1");
  assertEquals(d.cec_json_url, CJ);
  assertEquals(calls[0], { p_election_type: "縣市長", p_county: "台北市", p_town: "" });
  const fake2 = createFakeSupabase({ politician_elections: [] }, rpc);
  const d2 = await fetchVerifyContext(fake2.client, "cand_numbers", { ...PAYLOAD, election_id: 2022 }, "c-1");
  assertEquals(d2.cec_json_url, undefined);
});

Deno.test("SOURCE_HINTS：info.cec.gov.tw 的網址會帶查證提示", () => {
  const h = sourceHintsFor([CJ]);
  assertEquals(h.length, 1);
  assertStringIncludes(h[0].hint, "candNo");
});

// ── 4b. 補號次缺口的 no_change 驗證票：附 JSON、插隊 ─────────────────────
Deno.test("parseCandNoTaskId：縣市／鄉鎮／拆件後綴；不是補號次任務回 null", () => {
  assertEquals(parseCandNoTaskId("auto:candidacy_source_missing:cand_no:2026:縣市長:苗栗縣"), { election_id: 2026, election_type: "縣市長", county: "苗栗縣", town: null });
  assertEquals(parseCandNoTaskId("auto:candidacy_source_missing:cand_no:2026:村里長:苗栗縣:苗栗市:p2"), { election_id: 2026, election_type: "村里長", county: "苗栗縣", town: "苗栗市" });
  assertEquals(parseCandNoTaskId("auto:candidacy_source_missing:cand_no:2026:縣市議員:台中市:p1")?.town, null);
  assertEquals(parseCandNoTaskId("auto:candidacy_source_missing:cand_no_recheck:2026:縣市長:苗栗縣"), null);
  assertEquals(parseCandNoTaskId("auto:policy_missing:abc"), null);
  assertEquals(parseCandNoTaskId(undefined), null);
});

Deno.test("no_change 驗證項：補號次缺口附 JSON 與『JSON 已有 candNo 則不成立、投 disagree』；沒網址時照舊", () => {
  const cur = shapeVerifyCurrent("no_change", { task_id: "auto:candidacy_source_missing:cand_no:2026:縣市長:台北市" }, { cec_json_url: CJ } as never);
  assertEquals(cur.cec_json_url, CJ);
  assertStringIncludes(String(cur.hint), CJ);
  assertStringIncludes(String(cur.hint), "不成立");
  assertStringIncludes(String(cur.hint), "disagree");
  assertStringIncludes(String(cur.hint), "evidence_url");
  assertStringIncludes(String(cur.hint), "14 天不再派", "原本的說明還在");
  const none = shapeVerifyCurrent("no_change", {}, {} as never);
  assert(!String(none.hint).includes("candNo"));
  assertStringIncludes(cecNoChangeVerifyHint(CJ), CJ);
});

Deno.test("驗證 context：補號次缺口的 no_change 由 task_id 組出單位向 SQL 要網址；其他 no_change 不問", async () => {
  const calls: unknown[] = [];
  const rpc = { cec_vote2026_cand_url: (a: unknown) => { calls.push(a); return CJ; } };
  const d = await fetchVerifyContext(createFakeSupabase({}, rpc).client, "no_change", { task_id: "auto:candidacy_source_missing:cand_no:2026:村里長:苗栗縣:苗栗市:p1" }, "c-1");
  assertEquals(d.cec_json_url, CJ);
  assertEquals(calls[0], { p_election_type: "村里長", p_county: "苗栗縣", p_town: "苗栗市" });
  const n0 = calls.length;
  const d2 = await fetchVerifyContext(createFakeSupabase({}, rpc).client, "no_change", { task_id: "auto:policy_missing:x" }, "c-2");
  assertEquals(d2.cec_json_url, undefined);
  assertEquals(calls.length, n0);
});

async function frontPull(mutateSql?: (s: string) => string) {
  const db = new PGlite();
  const tail = M.slice(M.lastIndexOf("CREATE OR REPLACE FUNCTION cand_no_front_pull()"));
  const fn = tail.slice(0, tail.indexOf("$$;", tail.indexOf("$$") + 2) + 3);
  await db.exec(`
    CREATE TABLE queue_settings (id integer PRIMARY KEY, visitor_front_seconds bigint);
    INSERT INTO queue_settings VALUES (1, 100);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, target jsonb, boost_seconds bigint NOT NULL DEFAULT 0, cooling boolean NOT NULL DEFAULT true);
    CREATE TABLE contributions (id integer PRIMARY KEY, status text, contribution_type text, payload jsonb);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql AS $$ SELECT date '2026-10-31' $$;
    ${mutateSql ? mutateSql(fn) : fn}`);
  const rows: Array<[number, string, string, string]> = [
    [1, "pending", "no_change", "auto:candidacy_source_missing:cand_no:2026:村里長:苗栗縣:苗栗市"],
    [2, "pending", "no_change", "auto:policy_missing:abc"],
    [3, "pending", "no_change", "auto:candidacy_source_missing:cand_no_recheck:2026:村里長:苗栗縣"],
    [4, "applied", "no_change", "auto:candidacy_source_missing:cand_no:2026:村里長:苗栗縣:三義鄉"],
  ];
  for (const [id, st, type, tid] of rows) {
    await db.query(`INSERT INTO contributions VALUES ($1, $2, $3, $4::jsonb)`, [id, st, type, JSON.stringify({ task_id: tid, outcome: "not_found" })]);
    await db.query(`INSERT INTO task_dispatches (task_id, target) VALUES ($1, '{"kind":"verify"}'::jsonb)`, [`verify:${id}`]);
  }
  await db.exec("SELECT cand_no_front_pull()");
  const r = await db.query<{ task_id: string; b: number }>(`SELECT task_id, boost_seconds::int AS b FROM task_dispatches`);
  await db.close();
  return Object.fromEntries(r.rows.map((x) => [x.task_id, x.b]));
}

Deno.test("cand_no_front_pull：補號次缺口的 no_change 驗證票拉到 3 ×；別的 no_change、重查任務的、已結案的不動", async () => {
  const b = await frontPull();
  assertEquals(b["verify:1"], 300);
  assertEquals(b["verify:2"], 0);
  assertEquals(b["verify:3"], 0);
  assertEquals(b["verify:4"], 0);
});

Deno.test("cand_no_front_pull 還原驗證：拿掉 no_change 條件，補號次缺口的 no_change 驗證票就不插隊", async () => {
  const b = await frontPull((s) => mutate(s, "OR (c.contribution_type = 'no_change' AND c.payload->>'task_id' LIKE 'auto:candidacy_source_missing:cand_no:%')", "OR false"));
  assertEquals(b["verify:1"], 0);
});

// ── 5. 協議 ───────────────────────────────────────────────────────
Deno.test("協議版號不低於 1.108.1，skill.md 檔頭同版", async () => {
  const [a, b, c] = PROTOCOL_VERSION.split(".").map(Number);
  assert(a > 1 || (a === 1 && (b > 108 || (b === 108 && c >= 1))), PROTOCOL_VERSION);
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assertStringIncludes(skill, `**版本**：${PROTOCOL_VERSION}`);
  const types = await Deno.readTextFile(new URL("../../../public/skill-types.md", import.meta.url));
  assertStringIncludes(types, "target.cec_json_url");
});
