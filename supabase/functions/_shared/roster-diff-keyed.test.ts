/**
 * 派工臂事件驅動化 第 2 期 PR-3（migration 20261128060000_roster_diff_keyed.sql）守門：
 * roster_diff_findings(p_keys) 底下七支臂函式接單位鍵，真的只算指定單位，輸出不變。
 *
 * A 文字層：七支帶鍵孿生函式與一支訊號函式的本體＝原臂「最新定義」倒回去（逐處替換），一字不差；
 *   roster_diff_findings 與 PR-2 版只差七處呼叫；原臂函式與 PR-2 的函式沒被後面的遷移蓋掉
 * B PGlite（原臂用真定義，不是 stub）：以 PR-2 版當 oracle（_legacy）
 *   B1 NULL 全量雙向差集 0，且七種 kind 都有（沒有空對空）
 *   B2 每一個單位鍵、全部鍵、一半鍵、含不存在單位的鍵、同縣市不同職位的鍵＝oracle 同條件的結果（雙向差集 0）
 *   B3 孿生函式本身有修剪：給不存在的單位鍵回 0 列，給單一單位少於整表（成本證據）
 * C 還原驗證：拿掉輸入端鍵過濾，B3 的修剪斷言必紅
 * D 遷移文字：檔頭寫明原因、接鍵與整表的判斷、回滾；沒有新增排程或觸發器
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261128060000_roster_diff_keyed.sql";
const mig = await readMig(MIG_NAME);
const phase2b = await readMig("20261127093000_dispatch_gaps_phase2b.sql");
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const KF = "AND (p_keys IS NULL OR pe.id IN (SELECT k.id FROM roster_diff_keyed_pe_ids(p_keys) k))";
const KR = "AND (p_keys IS NULL OR pe.id IN (SELECT k.id FROM roster_diff_result_pe_ids(p_keys) k))";
const H = (name: string) => [`CREATE OR REPLACE FUNCTION ${name}()`, `CREATE OR REPLACE FUNCTION ${name}_keyed(p_keys TEXT[] DEFAULT NULL)`] as const;
const RET7 = "RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)";

type Edit = readonly [string, string];
const ARMS: { name: string; edits: Edit[] }[] = [
  { name: "contribution_auto_tasks_party_roster", edits: [
    ["     WHERE pe.party_basis IS NULL AND pe.candidacy_status = 'filed'\n", `     WHERE pe.party_basis IS NULL AND pe.candidacy_status = 'filed'\n       ${KF}\n`],
  ] },
  { name: "contribution_auto_tasks_party_gap", edits: [
    ["     WHERE pe.party_basis IS NULL\n", `     WHERE pe.party_basis IS NULL\n       ${KF}\n`],
  ] },
  { name: "contribution_auto_tasks_township_gap", edits: [
    ["    AND p.merged_into IS NULL\n$$;", `    AND p.merged_into IS NULL\n    ${KF}\n$$;`],
  ] },
  { name: "contribution_auto_tasks_region_gap", edits: [
    ["     WHERE pe.election_type IN ('縣市長', '縣市議員', '立法委員')\n  ),", `     WHERE pe.election_type IN ('縣市長', '縣市議員', '立法委員')\n       ${KF}\n  ),`],
    ["       AND candidacy_is_listed(pe.candidacy_status) AND reg.n > 0\n  ),", `       AND candidacy_is_listed(pe.candidacy_status) AND reg.n > 0\n       ${KF}\n  ),`],
  ] },
  { name: "candidacy_owner_mismatch_signals", edits: [
    ["  WITH pe AS (\n    SELECT pe.id, pe.politician_id", "  WITH kp AS MATERIALIZED (SELECT k.id FROM roster_diff_keyed_pe_ids(p_keys) k),\n  pe AS (\n    SELECT pe.id, pe.politician_id"],
    ["         WHERE p.birth_year IS NOT NULL\n      ) x", "         WHERE p.birth_year IS NOT NULL\n           AND (p_keys IS NULL OR pe.id IN (SELECT id FROM kp))\n      ) x"],
    ["     AND left(replace(c.payload->>'region', '臺', '台'), 3) <> left(x.county, 3)\n", "     AND left(replace(c.payload->>'region', '臺', '台'), 3) <> left(x.county, 3)\n     AND (p_keys IS NULL OR x.id IN (SELECT id FROM kp))\n"],
    ["     AND b.election_date - a.election_date < 1700\n", "     AND b.election_date - a.election_date < 1700\n     AND (p_keys IS NULL OR b.id IN (SELECT id FROM kp))\n"],
    ["     AND COALESCE(c.payload->>'finding', '') || ' ' || COALESCE(c.note, '') !~ '(不是|非|並非)同名不同人'\n", "     AND COALESCE(c.payload->>'finding', '') || ' ' || COALESCE(c.note, '') !~ '(不是|非|並非)同名不同人'\n     AND (p_keys IS NULL OR x.id IN (SELECT id FROM kp))\n"],
    ["     AND EXISTS (SELECT 1 FROM politician_elections o WHERE o.politician_id = x.politician_id AND o.id <> x.id)\n$$;", "     AND EXISTS (SELECT 1 FROM politician_elections o WHERE o.politician_id = x.politician_id AND o.id <> x.id)\n     AND (p_keys IS NULL OR x.id IN (SELECT id FROM kp))\n$$;"],
  ] },
  { name: "contribution_auto_tasks_owner_mismatch", edits: [
    ["      FROM candidacy_owner_mismatch_signals() g", "      FROM candidacy_owner_mismatch_signals_keyed(p_keys) g"],
  ] },
  { name: "contribution_auto_tasks_elected_missing", edits: [
    ["     WHERE pe.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')\n  ),",
      "     WHERE pe.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')\n       AND (p_keys IS NULL OR (pe.election_id, pe.election_type) IN (SELECT sc.election_id, sc.election_type FROM roster_key_scopes(p_keys) sc))\n  ),"],
    ["       AND c.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')\n",
      "       AND c.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')\n       AND (p_keys IS NULL OR dispatch_gap_roster_unit_key(c.election_id, c.region, c.election_type) = ANY (p_keys))\n"],
    ["     WHERE p.merged_into IS NULL\n       AND cec_name_key(p.name) IN (SELECT m.name_norm FROM missing m)", "     WHERE p.merged_into IS NULL\n       AND EXISTS (SELECT 1 FROM missing)\n       AND cec_name_key(p.name) IN (SELECT m.name_norm FROM missing m)"],
  ] },
  { name: "contribution_auto_tasks_election_results", edits: [
    ["     WHERE COALESCE(pe.candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')\n  ),", `     WHERE COALESCE(pe.candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')\n       ${KR}\n  ),`],
    ["   WHERE x.mismatch\n$$;", `   WHERE x.mismatch\n     AND (p_keys IS NULL OR x.politician_election_id IN (SELECT k.id FROM roster_diff_result_pe_ids(p_keys) k))\n$$;`],
  ] },
];
const twinName = (n: string) => n + "_keyed";
const migBefore = async (name: string) => await latestFn(name, MIG_NAME);

// ── A 文字層 ──
Deno.test("A1 七支臂與訊號函式的孿生本體＝原臂最新定義倒回去，一字不差", async () => {
  for (const a of ARMS) {
    const orig = await migBefore(a.name);
    const [from, to] = H(a.name);
    let expect = mutate(orig, from, to);
    if (a.name === "candidacy_owner_mismatch_signals") {
      assert(expect.includes("RETURNS TABLE (politician_election_id INTEGER, signal TEXT, detail TEXT)"), "訊號函式回傳欄位");
    } else {
      assert(expect.includes(RET7) || expect.includes("RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)"), `${a.name} 回傳欄位`);
    }
    for (const [f, t] of a.edits) expect = mutate(expect, f, t);
    const actual = fnText(mig, twinName(a.name));
    assertEquals(actual.split("\n"), expect.split("\n"), `${a.name} 的孿生函式與原臂最新定義＋鍵過濾不一致`);
  }
});

Deno.test("A2 roster_diff_findings 與 PR-2 版只差七處臂函式呼叫", async () => {
  const old = fnText(phase2b, "roster_diff_findings");
  let expect = old;
  for (const arm of ["party_roster", "party_gap", "township_gap", "region_gap", "owner_mismatch"]) {
    expect = mutate(expect, `contribution_auto_tasks_${arm}() t`, `contribution_auto_tasks_${arm}_keyed(p_keys) t`);
  }
  expect = mutate(expect, "FROM contribution_auto_tasks_elected_missing() t", "FROM contribution_auto_tasks_elected_missing_keyed(p_keys) t");
  expect = mutate(expect, "SELECT t.* FROM contribution_auto_tasks_election_results() t", "SELECT t.* FROM contribution_auto_tasks_election_results_keyed(p_keys) t");
  assertEquals(fnText(mig, "roster_diff_findings").split("\n"), expect.split("\n"));
});

Deno.test("A3 沒被後面的遷移蓋掉；原臂函式一個字沒動（本支不重定義它們）", async () => {
  for (const n of await migrationNames()) {
    if (n <= MIG_NAME) continue;
    const sql = await readMig(n);
    for (const a of ARMS) assert(!sql.includes(`CREATE OR REPLACE FUNCTION ${a.name}(`) && !sql.includes(`CREATE OR REPLACE FUNCTION ${twinName(a.name)}(`), `${n} 重定義了 ${a.name}，孿生函式要同步`);
    assert(!sql.includes("CREATE OR REPLACE FUNCTION roster_diff_findings("), `${n} 重定義了 roster_diff_findings`);
  }
  for (const a of ARMS) {
    assert(!mig.includes(`CREATE OR REPLACE FUNCTION ${a.name}(`), `本支不該重定義 ${a.name}`);
    assert(!mig.includes(`DROP FUNCTION IF EXISTS ${a.name}`), "不 DROP 原臂");
  }
});

// ── B PGlite ──
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const FIXTURE = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE elections (id int PRIMARY KEY, election_date date);
CREATE TABLE regions (id int PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politicians (id uuid PRIMARY KEY, name text, party text, region text, sub_region text, village text, birth_year int, merged_into uuid);
CREATE TABLE politician_elections (id int PRIMARY KEY, politician_id uuid, election_id int, election_type text, region_id int, candidacy_status text, party_basis text, position text);
CREATE TABLE cec_candidates (id serial PRIMARY KEY, election_id int, election_type text, region text, sub_region text, village text, name text, name_norm text, party text, cand_no int, elected boolean, cec_cand_id int, cec_theme_id text, birth_year int);
CREATE TABLE cec_registrations (election_id int, election_type text, region text, sub_region text, district text, party text, source_url text, name_key text);
CREATE TABLE cec_registration_sources (election_id int, source_url text, superseded_by text);
CREATE TABLE verification_sources (id serial, kind text, status text, list_url text, provides text[], election_types text[], regions text[], sort int);
CREATE TABLE contributions (id uuid DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb, task_id text, applied_politician_id uuid, note text);
CREATE TABLE contribution_votes (contribution_id uuid, note text);
CREATE TABLE edit_history (table_name text, record_id text, field text, contribution_id uuid, applied_at timestamptz DEFAULT now());
CREATE TABLE task_checks (task_id text, outcome text);
CREATE TABLE party_aliases (alias_key text, party_id int, kind text);
CREATE TABLE parties (id int, name text);
CREATE TABLE plan_rows (politician_election_id int, write_result boolean, write_party boolean, mismatch boolean, politician_id uuid, name text, county text, town text, village text,
  election_id int, election_type text, cur_status text, cec_elected boolean, cec_sub_region text, cec_village text, cec_birth_year int, cec_cand_id int, cec_theme_id text, unit_seats int, unit_elected int);
CREATE FUNCTION cec_name_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT regexp_replace(replace($1, '臺', '台'), '\\s', '', 'g') $f$;
CREATE FUNCTION party_alias_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT lower($1) $f$;
CREATE FUNCTION candidacy_protocol_status(s text, b boolean) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT CASE WHEN s = 'filed' THEN 'registered' ELSE s END $f$;
CREATE FUNCTION candidacy_list_published(i int, t text, d date) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$ SELECT true $f$;
CREATE FUNCTION campaign_election_id() RETURNS int LANGUAGE sql IMMUTABLE AS $f$ SELECT 2026 $f$;
CREATE FUNCTION region_is_electoral_district(t text, r text, s text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$ SELECT s IS NOT NULL AND s ~ '選舉區$' $f$;
CREATE FUNCTION candidacy_is_listed(s text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$ SELECT s IN ('filed', 'qualified', 'elected', 'not_elected') $f$;
CREATE FUNCTION election_year_text(i int) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT i::text $f$;
CREATE FUNCTION politician_name_is_placeholder(t text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$ SELECT false $f$;
CREATE FUNCTION cec_results_auto_plan() RETURNS SETOF plan_rows LANGUAGE sql STABLE AS $f$ SELECT * FROM plan_rows $f$;
CREATE FUNCTION roster_region_mismatch_findings() RETURNS TABLE (election_id int, official_county text, politician_id uuid, politician_election_id int, name text, cur_county text, current_region_id int, proposed_region_id int, source_url text)
  LANGUAGE sql STABLE AS $f$ SELECT NULL::int, NULL::text, NULL::uuid, NULL::int, NULL::text, NULL::text, NULL::int, NULL::int, NULL::text WHERE false $f$;
`;
const DATA = `
INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2099-11-28');
INSERT INTO regions VALUES (1, '台北市', NULL, NULL), (2, '台北市', '中山區', '大直里'), (3, '台北市', '中山區', '中山里'), (4, '台中市', NULL, NULL),
  (5, '新北市', NULL, NULL), (6, '雲林縣', '麥寮鄉', NULL), (7, '雲林縣', '麥寮鄉第01選舉區', NULL), (9, '高雄市', NULL, NULL);
INSERT INTO politicians (id, name, party, region, birth_year) VALUES
  ('${U(1)}', '甲一', '無', '台北市', 1960), ('${U(2)}', '甲二', '無', '新北市', 1962), ('${U(3)}', '甲三', '無', '台北市', 1963), ('${U(4)}', '甲四', '無', '台北市', 1964),
  ('${U(5)}', '甲五', '無', '雲林縣', 1965), ('${U(6)}', '甲六', '無', '台中市', 1966), ('${U(7)}', '甲七', '無', '台北市', 1967), ('${U(8)}', '甲八', '無', '台中市', 1968),
  ('${U(9)}', '甲九', '無', '台北市', 1969), ('${U(10)}', '甲十', '無', '雲林縣', 1970), ('${U(11)}', '甲十一', '無', '高雄市', 1971), ('${U(12)}', '甲十二', '無', '台北市', 1972),
  ('${U(13)}', '甲十三', '無', '台中市', 1970);
INSERT INTO politician_elections (id, politician_id, election_id, election_type, region_id, candidacy_status, party_basis) VALUES
  (101, '${U(1)}', 2022, '縣市長', 1, NULL, 'x'), (102, '${U(2)}', 2022, '縣市長', 5, NULL, 'x'), (103, '${U(3)}', 2022, '村里長', 2, NULL, 'x'),
  (104, '${U(4)}', 2022, '村里長', 3, NULL, 'x'), (105, '${U(5)}', 2022, '鄉鎮市民代表', 7, NULL, 'x'), (106, '${U(6)}', 2022, '縣市長', 4, 'elected', 'x'),
  (107, '${U(7)}', 2022, '縣市長', 1, NULL, NULL), (108, '${U(12)}', 2022, '縣市議員', 1, NULL, 'x'), (109, '${U(13)}', 2022, '縣市長', 4, 'elected', 'x'),
  (201, '${U(8)}', 2026, '縣市議員', 4, 'filed', NULL), (202, '${U(9)}', 2026, '村里長', NULL, NULL, 'x'), (203, '${U(10)}', 2026, '鄉鎮市民代表', 6, 'filed', NULL),
  (204, '${U(11)}', 2026, '縣市長', 9, 'filed', NULL), (205, '${U(12)}', 2026, '縣市議員', 4, 'filed', 'x');
INSERT INTO cec_candidates (election_id, election_type, region, sub_region, village, name, name_norm, party, cand_no, elected, cec_cand_id, cec_theme_id, birth_year) VALUES
  (2022, '縣市長', '台北市', NULL, NULL, '甲一', '甲一', '乙黨', 1, true, 1, 't1', 1960),
  (2022, '縣市長', '台北市', NULL, NULL, '甲七', '甲七', '甲黨', 2, false, 2, 't1', 1967),
  (2022, '村里長', '台北市', '中山區', '大直里', '甲三', '甲三', '甲黨', 3, true, 3, 't2', 1963),
  (2022, '鄉鎮市民代表', '雲林縣', '麥寮鄉第01選舉區', NULL, '甲五', '甲五', '甲黨', 4, true, 4, 't3', 1965),
  (2022, '縣市長', '新北市', NULL, NULL, '缺人甲', '缺人甲', '甲黨', 5, true, 5, 't4', 1950),
  (2022, '縣市長', '台中市', NULL, NULL, '甲十三', '甲十三', '甲黨', 6, true, 6, 't5', 1971);
INSERT INTO cec_registration_sources VALUES (2026, 'http://reg', NULL);
INSERT INTO cec_registrations VALUES (2026, '鄉鎮市民代表', '雲林縣', '麥寮鄉', '第01選舉區', '甲黨', 'http://reg', '甲十');
INSERT INTO verification_sources (kind, status, list_url, provides, election_types, regions, sort)
  VALUES ('cec', 'ok', 'http://roster', ARRAY['roster'], ARRAY['縣市議員','鄉鎮市民代表','縣市長'], ARRAY['台中市','雲林縣','高雄市'], 1);
INSERT INTO party_aliases VALUES ('甲黨', 1, 'party'); INSERT INTO parties VALUES (1, '甲黨');
INSERT INTO contributions (contribution_type, status, payload, applied_politician_id) VALUES
  ('candidacy', 'applied', '{"election_id": "2026", "region": "台北市"}', '${U(11)}');
INSERT INTO plan_rows VALUES (106, false, false, true, '${U(6)}', '甲六', '台中市', NULL, NULL, 2022, '縣市長', 'elected', false, NULL, NULL, 1966, 9, 't9', 1, 0);
`;

const REAL = [
  "roster_unify_town", "dispatch_gap_roster_unit_key", "dispatch_gap_roster_keys", "election_result_cec_matches", "candidacy_owner_mismatch_signals",
  ...ARMS.filter((a) => a.name !== "candidacy_owner_mismatch_signals").map((a) => a.name),
];

async function buildDb(migrationSql: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(FIXTURE);
  for (const f of REAL) await db.exec(await migBefore(f));
  const legacy = mutate(fnText(phase2b, "roster_diff_findings"), "CREATE OR REPLACE FUNCTION roster_diff_findings(", "CREATE OR REPLACE FUNCTION roster_diff_findings_legacy(");
  await db.exec(legacy);
  await db.exec(DATA);
  await db.exec(migrationSql);
  return db;
}
const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const arr = (keys: string[] | null) => (keys === null ? null : "{" + keys.map((k) => `"${k}"`).join(",") + "}");
const count = async (db: PGlite, sql: string, keys: string[] | null) => Number((await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM ${sql}`, [arr(keys)]))[0].n);

async function sameAsOracle(db: PGlite, keys: string[] | null, label: string) {
  const p = [arr(keys)];
  const a = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM (SELECT * FROM roster_diff_findings($1::text[]) EXCEPT SELECT * FROM roster_diff_findings_legacy($1::text[])) x`, p);
  const b = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM (SELECT * FROM roster_diff_findings_legacy($1::text[]) EXCEPT SELECT * FROM roster_diff_findings($1::text[])) x`, p);
  assertEquals([Number(a[0].n), Number(b[0].n)], [0, 0], `${label}：新舊差集不為 0`);
}

const db = await buildDb(mig);
const full = await rows<{ election_id: number; county: string; town: string; election_type: string; kind: string }>(db,
  `SELECT election_id, county, town, election_type, kind FROM roster_diff_findings_legacy(NULL)`);
const unitKeys = [...new Set(full.map((r) => `unit:${r.election_id}:${r.county}${r.town}:${r.election_type}`))].sort();

Deno.test("B1 NULL 全量與 PR-2 版逐列相同，七種 kind 都有（不是空對空）", async () => {
  await sameAsOracle(db, null, "NULL");
  const kinds = new Set(full.map((r) => r.kind));
  for (const k of ["政黨", "鄉鎮", "縣市", "掛錯人", "缺人", "結果"]) assert(kinds.has(k), `fixture 沒有 ${k} 這一種 finding`);
  assert(unitKeys.length >= 8, `fixture 單位太少：${unitKeys.length}`);
  const n = Number((await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM roster_diff_findings(NULL)`))[0].n);
  assertEquals(n, full.length);
});

Deno.test("B2 任一鍵集合＝PR-2 版同條件的結果（單一、全部、一半、含不存在、同縣市不同職位、非 unit 鍵）", async () => {
  for (const k of unitKeys) await sameAsOracle(db, [k], k);
  await sameAsOracle(db, unitKeys, "全部鍵");
  await sameAsOracle(db, unitKeys.filter((_, i) => i % 2 === 0), "一半鍵");
  await sameAsOracle(db, [unitKeys[0], "unit:2099:不存在市:縣市長", "unit:2026:台中市:縣市議員"], "含不存在單位");
  await sameAsOracle(db, ["unit:2022:台北市:縣市長", "unit:2022:台北市:縣市議員", "unit:2026:台北市:村里長"], "同縣市不同職位");
  await sameAsOracle(db, ["seats:2026:台中市:縣市議員", "*"], "非 unit 鍵");
  await sameAsOracle(db, [], "空陣列");
});

const TWINS = ARMS.filter((a) => a.name !== "candidacy_owner_mismatch_signals").map((a) => twinName(a.name));
async function pruneProof(d: PGlite): Promise<string[]> {
  const bad: string[] = [];
  for (const t of TWINS) {
    const all = await count(d, `${t}($1::text[])`, null);
    const none = await count(d, `${t}($1::text[])`, ["unit:2099:不存在市:縣市長"]);
    if (!(all > 0 && none === 0)) bad.push(`${t}: 整表 ${all} 列、不存在單位 ${none} 列`);
  }
  return bad;
}

Deno.test("B3 孿生函式本身有修剪：不存在單位 0 列、單一單位少於整表、整表版與原臂逐列相同", async () => {
  assertEquals(await pruneProof(db), []);
  for (const t of TWINS) {
    const orig = t.replace(/_keyed$/, "");
    const diff = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM (SELECT * FROM ${t}(NULL) EXCEPT SELECT * FROM ${orig}()) x`);
    const diff2 = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM (SELECT * FROM ${orig}() EXCEPT SELECT * FROM ${t}(NULL)) x`);
    assertEquals([Number(diff[0].n), Number(diff2[0].n)], [0, 0], `${t}(NULL) 與原臂不同`);
  }
  // 單一單位：每支臂都不超過整表，並且合起來至少有一支真的變少
  let shrunk = 0;
  for (const t of TWINS) {
    const all = await count(db, `${t}($1::text[])`, null);
    const one = await count(db, `${t}($1::text[])`, ["unit:2026:台中市:縣市議員"]);
    assert(one <= all);
    if (one < all) shrunk++;
  }
  assert(shrunk >= 5, `單一單位只有 ${shrunk} 支比整表少`);
  // 結果類：整個單位的人一起進來，分件編號與整表版相同
  const k = "unit:2022:台北市:縣市長";
  const part = await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_election_results_keyed($1::text[]) WHERE task_id LIKE 'auto:election_results_missing:%'`, [arr([k])]);
  const whole = await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_election_results() WHERE task_id LIKE 'auto:election_results_missing:2022:縣市長:台北市%'`);
  assertEquals(part.map((r) => r.task_id), whole.map((r) => r.task_id));
  assert(part.length >= 1);
});

Deno.test("C 還原驗證：拿掉輸入端鍵過濾，修剪斷言必紅", async () => {
  let broken = mig;
  for (const f of [KF, KR]) broken = broken.split(f).join("AND true");
  broken = broken.split("AND (p_keys IS NULL OR (pe.election_id, pe.election_type) IN (SELECT sc.election_id, sc.election_type FROM roster_key_scopes(p_keys) sc))").join("AND true");
  broken = broken.split("AND (p_keys IS NULL OR dispatch_gap_roster_unit_key(c.election_id, c.region, c.election_type) = ANY (p_keys))").join("AND true");
  broken = broken.split("AND (p_keys IS NULL OR x.politician_election_id IN (SELECT k.id FROM roster_diff_result_pe_ids(p_keys) k))").join("AND true");
  broken = broken.split("AND (p_keys IS NULL OR pe.id IN (SELECT id FROM kp))").join("AND true");
  assert(broken !== mig);
  const d = await buildDb(broken);
  try {
    const bad = await pruneProof(d);
    assert(bad.length >= 5, `拿掉過濾後只有 ${bad.length} 支修剪斷言變紅：${bad.join("；")}`);
    // 輸出仍相同（最外層過濾還在）：證明單看輸出看不出少了輸入端過濾，修剪斷言才是守門
    await sameAsOracle(d, [unitKeys[0]], "還原後輸出");
  } finally {
    await d.close();
  }
});

// ── D 遷移文字 ──
Deno.test("D 檔頭寫明原因、七支判斷、回滾；沒有新增排程或觸發器；原臂與總表函式不在本支重定義", () => {
  const head = mig.slice(0, mig.indexOf("CREATE OR REPLACE FUNCTION roster_key_scopes"));
  for (const must of ["7～9 秒", "party_roster", "party_gap", "township_gap", "region_gap", "owner_mismatch", "elected_missing", "election_results", "刻意維持整表", "回滾", "每日呼叫量變化：0"]) {
    assert(head.includes(must), `檔頭缺「${must}」`);
  }
  const body = noComments(mig);
  assert(!/cron\.schedule|CREATE TRIGGER|net\.http_/i.test(body), "不新增排程、觸發器、對外呼叫");
  for (const protectedFn of ["contribution_auto_tasks_arms", "contribution_auto_tasks_arms_tail", "seed_auto_task_queue", "contribution_auto_tasks_arms_v20261126"]) {
    assert(!body.includes(`FUNCTION ${protectedFn}(`), `不該動 ${protectedFn}`);
  }
});
