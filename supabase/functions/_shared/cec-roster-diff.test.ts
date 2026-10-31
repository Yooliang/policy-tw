/**
 * 官方名冊鏡像與對帳（2026-10-31，migration 20261031160000；不新增任務型別）的守門。
 *
 * 守住：
 *   1. 比對：多出（extra）、缺少（missing）、同號兩筆（dup）；造字代碼當萬用字元、異體字、同號僅差一字都視為同人；退選的不算我們有效的人；沒抓到的單位不算差異
 *   2. 單位換檔：404 不當錯誤、之前有資料而這次空／404 保留舊資料
 *   3. roster_registration_gap（roster_check 的 target.registration）：有鏡像資料的單位用 JSON 名冊（造字、異體字也比得上），沒有才退回登記彙總表
 *   4. 解析與抓取、協議版號
 * 還原驗證：拿掉造字萬用字元、拿掉鏡像優先，對應測試會紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, mutate, readMig } from "./arms-pglite.ts";
import { parseRosterJson, runRosterMirror } from "./cec-roster-mirror.ts";

const M = await readMig("20261031160000_cec_roster_2026.sql");
const HINT = await readMig("20261031140000_cand_no_cec_json_hint.sql");
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
`;

async function buildDb(mutateMig: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(await latestFn("cec_name_norm"));
  await db.exec(await latestFn("cec_name_key"));
  await db.exec(await latestFn("roster_name_fold"));
  await db.exec(await latestFn("roster_name_key"));
  await db.exec(await latestFn("ballot_number_unit"));
  const fnStart = HINT.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()");
  await db.exec(HINT.slice(0, fnStart));
  const mig = mutateMig(M);
  // 登記彙總表的資料表與 candidacy_is_listed（roster_registration_gap 退回用）
  const REG = await readMig("20261008130000_cec_registrations.sql");
  await db.exec(REG.slice(0, REG.indexOf("CREATE OR REPLACE FUNCTION roster_registration_gap(")));
  for (const s of ["tables", "match", "mirror", "reconcile", "source", "gap"]) await db.exec(strip(section(mig, s)));
  return db;
}

let nreg = 0;
async function region(db: PGlite, r: string, sub: string | null): Promise<number> {
  const k = `${r}|${sub ?? ""}`;
  void nreg;
  const ex = await db.query<{ id: number }>(`SELECT id FROM regions WHERE region = $1 AND sub_region IS NOT DISTINCT FROM $2`, [r, sub]);
  if (ex.rows[0]) return ex.rows[0].id;
  void k;
  return (await db.query<{ id: number }>(`INSERT INTO regions (region, sub_region) VALUES ($1, $2) RETURNING id`, [r, sub])).rows[0].id;
}
async function ours(db: PGlite, name: string, no: number | null, o: { type?: string; county?: string; sub?: string | null; status?: string } = {}): Promise<number> {
  const county = o.county ?? "台北市";
  const type = o.type ?? "縣市議員";
  const pid = (await db.query<{ id: string }>(`INSERT INTO politicians (name, region) VALUES ($1, $2) RETURNING id`, [name, county])).rows[0].id;
  const rid = await region(db, county, o.sub === undefined ? "第07選舉區" : o.sub);
  return (await db.query<{ id: number }>(
    `INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status, cand_no) VALUES (2026, $1, $2, $3, $4, $5) RETURNING id`,
    [type, pid, rid, o.status ?? "filed", no],
  )).rows[0].id;
}
const T_URL = "https://info.cec.gov.tw/vote2026/static/json/cand/T/63000.json";
async function loadCouncil(db: PGlite, rows: { name: string; no: number; area?: string }[]) {
  await db.query(`SELECT cec_roster_seed_units()`);
  const res = await db.query<{ r: string }>(`SELECT cec_roster_replace_unit($1, 200, $2::jsonb) AS r`, [
    T_URL, JSON.stringify(rows.map((r) => ({ name: r.name, cand_no: r.no, party: "無", birth: "0600101", home: "", district: "臺北市第7選舉區", area_code: r.area ?? "07", dept_code: "", li_code: "" }))),
  ]);
  assertEquals(res.rows[0].r, "ok");
}
const diff = async (db: PGlite) =>
  (await db.query<{ kind: string; our_name: string | null; roster_name: string | null; partner_name: string | null }>(
    `SELECT kind, our_name, roster_name, partner_name FROM cec_roster_diff() ORDER BY kind, our_name, roster_name`)).rows;

async function scenario(db: PGlite) {
  await ours(db, "王小明", 1);
  await ours(db, "李大華", 2);
  await ours(db, "陳天明", 3);          // 官方「陳@2F97F@明」造字
  await ours(db, "張啟楷", 5);          // 官方「張啓楷」異體字
  await ours(db, "趙一二四", 6);        // 官方「趙一二三」同號僅差一字
  await ours(db, "洪英雄", 8);          // 同號兩筆：漢名與族名
  await ours(db, "Icyang", 8);
  await ours(db, "林某某", 9);          // 官方沒有 → extra
  await ours(db, "退選甲", 10, { status: "withdrawn" });   // 退選不算
  await ours(db, "高雄人", 1, { county: "高雄市", sub: "第01選舉區" }); // 單位沒抓到，不算
  await loadCouncil(db, [
    { name: "王小明", no: 1 }, { name: "李大華", no: 2 }, { name: "陳@2F97F@明", no: 3 }, { name: "張啓楷", no: 5 },
    { name: "趙一二三", no: 6 }, { name: "吳九", no: 7 }, { name: "洪英雄Icyang", no: 8 },
  ]);
}

Deno.test("比對：多出、缺少、同號兩筆；造字、異體字、一字差視為同人；退選與沒抓到的單位不算", async () => {
  const db = await buildDb();
  await scenario(db);
  const d = await diff(db);
  assertEquals(d.filter((x) => x.kind === "extra").map((x) => x.our_name), ["林某某"]);
  assertEquals(d.filter((x) => x.kind === "missing").map((x) => x.roster_name), ["吳九"]);
  const dup = d.filter((x) => x.kind === "dup");
  assertEquals(dup.length, 1);
  assertEquals([dup[0].our_name, dup[0].partner_name].sort(), ["Icyang", "洪英雄"]);
});

Deno.test("還原驗證：拿掉造字萬用字元，「陳天明」就變成多出一筆＋缺少一筆", async () => {
  const db = await buildDb((s) => mutate(s, "IF b ~ tok THEN", "IF false AND b ~ tok THEN"));
  await scenario(db);
  const d = await diff(db);
  assert(d.some((x) => x.kind === "extra" && x.our_name === "陳天明"));
});

Deno.test("單位換檔：404 當官方沒有；之前有資料而這次空或 404 保留舊資料", async () => {
  const db = await buildDb();
  await db.query(`SELECT cec_roster_seed_units()`);
  const D2 = "https://info.cec.gov.tw/vote2026/static/json/cand/D2/63000.json";
  assertEquals((await db.query<{ r: string }>(`SELECT cec_roster_replace_unit($1, 404) r`, [D2])).rows[0].r, "absent");
  await loadCouncil(db, [{ name: "王小明", no: 1 }]);
  assertEquals((await db.query<{ r: string }>(`SELECT cec_roster_replace_unit($1, 200, '[]'::jsonb) r`, [T_URL])).rows[0].r, "error");
  assertEquals((await db.query<{ r: string }>(`SELECT cec_roster_replace_unit($1, 404) r`, [T_URL])).rows[0].r, "error");
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int n FROM cec_roster_2026 WHERE unit_url = $1`, [T_URL])).rows[0].n, 1);
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int n FROM cec_roster_units`)).rows[0].n > 400, true);
});

// ── 解析與抓取 ─────────────────────────────────────────────────
Deno.test("解析：平的陣列、議員依選區、代表依鄉鎮再依選區；缺陣列丟錯", () => {
  const c = { name: "甲", candNo: 3, party: "無", birth: "0600101", home: "臺北市", liCode: "002", deptCode: "110" };
  assertEquals(parseRosterJson("C1", { C1: [c] })[0].cand_no, 3);
  assertEquals(parseRosterJson("V1", { V1: [c] })[0].li_code, "002");
  const t = parseRosterJson("T", { T: [{ areaCode: "07", areaName: "臺北市第7選舉區", cands: [c] }] })[0];
  assertEquals([t.district, t.area_code], ["臺北市第7選舉區", "07"]);
  const r = parseRosterJson("R", { R: [{ deptCode: "010", areas: [{ areaCode: "02", areaName: "第2選舉區", cands: [c] }] }] })[0];
  assertEquals([r.dept_code, r.area_code], ["010", "02"]);
  let threw = false;
  try { parseRosterJson("T", {}); } catch { threw = true; }
  assert(threw);
});

Deno.test("抓取：只 GET、一般 UA、404 不當錯誤、失敗重試、抓完才對帳", async () => {
  const calls: { url: string; ua: string; method: string }[] = [];
  const rpcs: string[] = [];
  const supabase = {
    rpc(name: string, args?: Record<string, unknown>) {
      rpcs.push(name);
      if (name === "cec_roster_next_units") return Promise.resolve({ data: [{ url: "u1", kind: "C1" }, { url: "u2", kind: "D2" }, { url: "u3", kind: "C1" }], error: null });
      if (name === "cec_roster_replace_unit") return Promise.resolve({ data: args!.p_error ? "error" : args!.p_http === 404 ? "absent" : "ok", error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  let u1tries = 0;
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, ua: String((init.headers as Record<string, string>)["User-Agent"]), method: String(init.method) });
    if (url === "u2") return Promise.resolve(new Response("nf", { status: 404 }));
    if (url === "u1" && ++u1tries < 3) return Promise.resolve(new Response("x", { status: 503 }));
    return Promise.resolve(new Response(JSON.stringify({ C1: [{ name: "甲", candNo: 1 }] }), { status: 200 }));
  }) as unknown as typeof fetch;
  const s = await runRosterMirror(supabase, { fetchImpl, sleep: () => Promise.resolve() });
  assertEquals([s.ok, s.absent, s.error], [2, 1, 0]);
  assert(calls.every((c) => c.method === "GET" && c.ua.startsWith("Mozilla/5.0")));
  assertEquals(calls.filter((c) => c.url === "u1").length, 3);
  assertEquals(rpcs[rpcs.length - 1], "cec_roster_reconcile_if_due");
});


// ── roster_check 的 registration 以鏡像為來源 ───────────────────
const gap = async (db: PGlite, county: string, type = "縣市議員") =>
  (await db.query<{ g: Record<string, unknown> | null }>(`SELECT roster_registration_gap(2026, $1, $2) AS g`, [type, county])).rows[0].g;

Deno.test("roster_registration_gap：有鏡像資料的單位以 JSON 名冊為來源，造字與異體字比得上，缺的列出", async () => {
  const db = await buildDb();
  await scenario(db);
  const g = (await gap(db, "台北市"))!;
  assertEquals(g.source_urls, [T_URL]);
  assertEquals([g.registered, g.matched, g.missing_count], [7, 5, 2]);   // 吳九、趙一二三 缺；陳@2F97F@明、張啓楷、洪英雄Icyang 比得上
  assertEquals((g.missing as { name: string }[]).map((m) => m.name).sort(), ["吳九", "趙一二三"]);
});

Deno.test("還原驗證：拿掉造字萬用字元，registration 把「陳@2F97F@明」當缺；拿掉鏡像優先，source_urls 不是 JSON", async () => {
  const noGlyph = await buildDb((s) => mutate(s, "(reg.glyph AND cec_name_fuzzy_eq(o.nn, reg.name_key, NULL, NULL))", "false"));
  await scenario(noGlyph);
  assertEquals((await gap(noGlyph, "台北市"))!.missing_count, 3);
  const noMirror = await buildDb((s) => mutate(s, "SELECT p_election_id = 2026 AND EXISTS (", "SELECT false AND EXISTS ("));
  await scenario(noMirror);
  assertEquals(await gap(noMirror, "台北市"), null);   // 沒有登記彙總表資料＝NULL（退回舊來源）
});

Deno.test("沒有鏡像資料的單位退回登記彙總表", async () => {
  const db = await buildDb();
  await scenario(db);
  const url = "https://example.test/高雄議員.pdf";
  await db.query(`INSERT INTO cec_registration_sources (source_url, election_id, election_type, label, row_count, parsed_at) VALUES ($1, 2026, '縣市議員', 't', 1, now())`, [url]);
  await db.query(`INSERT INTO cec_registrations (election_id, election_type, region, place, sub_region, village, district, name, party, row_no, source_url, flags, parsed_at)
                  VALUES (2026, '縣市議員', '高雄市', NULL, NULL, NULL, '第01選舉區', '高雄人', '無', 1, $1, '{}', now())`, [url]);
  const g = (await gap(db, "高雄市"))!;
  assertEquals(g.source_urls, [url]);
  assertEquals(g.matched, 1);
});

Deno.test("接線：協議不低於 1.108.2", async () => {
  const { PROTOCOL_VERSION } = await import("./protocol.ts");
  const [a, b, c] = PROTOCOL_VERSION.split(".").map(Number);
  assert(a > 1 || b > 108 || (b === 108 && c >= 2));
});
