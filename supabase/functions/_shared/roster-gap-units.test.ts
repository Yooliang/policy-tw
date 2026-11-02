/**
 * 2026 名單清查只派「有缺口的單位」（migration 20261103010000，policy-ops#180）的守門；取代 #840 單人任務的測試。
 *
 * A. 文字層：總表＝現行定義（issue_subtopics）套兩處機械替換；#840 的排程停掉、函式刪掉、open 的單人任務收掉。
 * B. PGlite：roster_gap_units()（缺人／缺號次逐位列出、已對齊單位不出現、村里對 li_code）、roster_gap_attach()。
 * C. PGlite：總表新加的 tagged_g 段（直接抽 migration 裡的區塊跑）：有缺口併 items、沒清查列的缺口單位新開、
 *    鏡像新鮮且無缺口無別種差異的 2026 清查收回、鏡像不新鮮的照舊、別種差異留著、開關關著不動。
 * 還原驗證：拿掉「只派有缺口」「對齊收回」「缺號次」條件，對應斷言要紅。
 * 退過的人再派：派工只看「現在有沒有缺口」，不讀 contributions／task_checks，交件被退不會讓缺口消失（B5 守著函式本體不引用這兩張表）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261103010000_roster_gap_units.sql";
const X = await readMig(MIG_NAME);
const M = await readMig("20261031160000_cec_roster_2026.sql");
const HINT = await readMig("20261031140000_cand_no_cec_json_hint.sql");
const UNIFY = await readMig("20261101020000_roster_check_unify.sql");
const SUB = await readMig("20261102010000_issue_subtopics.sql");
const section = (sql: string, name: string) => {
  const a = sql.indexOf(`-- ▼▼ SECTION: ${name} ▼▼`);
  const b = sql.indexOf(`-- ▲▲ SECTION: ${name} ▲▲`);
  assert(a >= 0 && b > a, `找不到段落 ${name}`);
  return sql.slice(a, b);
};
const strip = (s: string) => s.replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");

// ============================================================
// A. 文字層
// ============================================================
const BLOCK_A = "       -- >>> 名單缺口只派有缺口的單位";
export function mechanicalGapArms(prev: string): string {
  const s = mutate(prev, "    FROM tagged g\n", "    FROM tagged_g g\n");
  const blk = X.slice(X.indexOf(BLOCK_A, X.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()")), X.indexOf("       -- <<< 名單缺口\n") + "       -- <<< 名單缺口\n".length);
  return mutate(s, "       -- 每一列的選舉與職位", blk + "       -- 每一列的選舉與職位");
}
Deno.test("A1 總表＝現行定義（issue_subtopics）套兩處機械替換", () => {
  assertEquals(fnText(X, "contribution_auto_tasks_arms"), mechanicalGapArms(fnText(SUB, "contribution_auto_tasks_arms")));
});

Deno.test("A2 取代 #840：排程停掉、函式刪掉、open 的單人任務收掉，且不寫任何參選資料；不再有人呼叫舊函式", async () => {
  assert(X.includes("j.jobname = 'cec-missing-person-tasks-daily'") && X.includes("cron.unschedule"));
  assert(X.includes("DROP FUNCTION IF EXISTS cec_missing_person_tasks_create(TEXT)"));
  assert(!/cron\.schedule\(\s*'cec-missing-person/.test(X));
  const code = X.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/(INSERT INTO|UPDATE|DELETE FROM)\s+(politicians|politician_elections|contributions)\b/.test(code), "不得寫參選資料");
  for await (const f of Deno.readDir(new URL("../", import.meta.url))) {
    if (!f.isDirectory) continue;
    for await (const g of Deno.readDir(new URL(`../${f.name}/`, import.meta.url))) {
      if (!g.name.endsWith(".ts") || g.name === "roster-gap-units.test.ts") continue;
      const t = await Deno.readTextFile(new URL(`../${f.name}/${g.name}`, import.meta.url));
      assert(!/cec_missing_person_tasks_create\(/.test(t.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), `${f.name}/${g.name} 還在呼叫已刪的函式`);
    }
  }
});

Deno.test("A3 協議文件講了缺口單位與逐位交法", async () => {
  const md = await Deno.readTextFile(new URL("../../../public/skill-types.md", import.meta.url));
  assert(md.includes("roster_gap") && md.includes("缺號次"));
});

// ============================================================
// B. roster_gap_units()
// ============================================================
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
CREATE TABLE roster_unify_settings (id smallint PRIMARY KEY DEFAULT 1, enabled boolean NOT NULL DEFAULT true, max_items integer NOT NULL DEFAULT 120);
INSERT INTO roster_unify_settings (id) VALUES (1);
CREATE FUNCTION roster_unify_on() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT s.enabled FROM roster_unify_settings s WHERE s.id = 1), false) $$;
`;

async function buildDb(mutateGap: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const f of ["cec_name_norm", "cec_name_key", "roster_name_fold", "roster_name_key", "ballot_number_unit", "roster_unify_extra", "roster_unify_kinds_text"]) await db.exec(await latestFn(f));
  const fnStart = HINT.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()");
  await db.exec(HINT.slice(0, fnStart));
  const REG = await readMig("20261008130000_cec_registrations.sql");
  await db.exec(REG.slice(0, REG.indexOf("CREATE OR REPLACE FUNCTION roster_registration_gap(")));
  for (const s of ["tables", "match", "mirror", "reconcile", "source", "gap"]) await db.exec(strip(section(M, s)));
  await db.exec(strip(mutateGap(section(X, "gap"))));
  return db;
}
const q = async <T = Record<string, any>>(db: PGlite, sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;

async function region(db: PGlite, r: string, sub: string | null, village: string | null = null, code: string | null = null): Promise<number> {
  const ex = await q<{ id: number }>(db, `SELECT id FROM regions WHERE region = $1 AND sub_region IS NOT DISTINCT FROM $2 AND village IS NOT DISTINCT FROM $3`, [r, sub, village]);
  if (ex[0]) return ex[0].id;
  return (await q<{ id: number }>(db, `INSERT INTO regions (region, sub_region, village, admin_code) VALUES ($1, $2, $3, $4) RETURNING id`, [r, sub, village, code]))[0].id;
}
async function person(db: PGlite, name: string, type: string, rid: number, no: number | null, county: string, status = "filed") {
  const pid = (await q<{ id: string }>(db, `INSERT INTO politicians (name, region) VALUES ($1, $2) RETURNING id`, [name, county]))[0].id;
  await q(db, `INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status, cand_no) VALUES (2026, $1, $2, $3, $4, $5)`, [type, pid, rid, status, no]);
}
async function load(db: PGlite, type: string, county: string, town: string, rows: Record<string, unknown>[]) {
  await db.query(`SELECT cec_roster_seed_units()`);
  const u = await q<{ url: string }>(db, `SELECT url FROM cec_roster_units WHERE election_type = $1 AND county = $2 AND town = $3`, [type, county, town]);
  assert(u[0], `沒有單位 ${type} ${county} ${town}`);
  const r = await q<{ r: string }>(db, `SELECT cec_roster_replace_unit($1, 200, $2::jsonb) AS r`, [u[0].url, JSON.stringify(rows.map((x) => ({ party: "新生黨", birth: "0650306", home: "", district: "", area_code: "", dept_code: "", li_code: "", ...x })))]);
  assertEquals(r[0].r, "ok");
  return u[0].url;
}
const HUALIEN = "auto:roster_check:2026:花蓮縣花蓮市:村里長";
const COUNCIL = "auto:roster_check:2026:台北市:縣市議員";

/** 花蓮市村里長：周玉梅（缺人）、王大有（有）；台北市議員第07選舉區：李有號（有、官方有號次、我們號次空）、陳齊全（有、號次對）；另一單位新北市完全對齊 */
async function scenario(db: PGlite) {
  await db.exec(`INSERT INTO regions (region, sub_region, village, admin_code) VALUES
    ('花蓮縣', '花蓮市', NULL, '10015010'), ('花蓮縣', '花蓮市', '國盛里', '10015010043'), ('花蓮縣', '花蓮市', '民立里', '10015010001')`);
  await db.exec(`INSERT INTO politicians (name, party, region, birth_year) VALUES ('周玉梅', '制度救世島', '花蓮縣', 1976)`);
  const minli = (await q<{ id: number }>(db, `SELECT id FROM regions WHERE village = '民立里'`))[0].id;
  await person(db, "王大有", "村里長", minli, 2, "花蓮縣");
  const hurl = await load(db, "村里長", "花蓮縣", "花蓮市", [
    { name: "周玉梅", cand_no: 1, li_code: "043" },
    { name: "王大有", cand_no: 2, li_code: "001" },
  ]);
  const r7 = await region(db, "台北市", "第07選舉區");
  await person(db, "李有號", "縣市議員", r7, null, "台北市");
  await person(db, "陳齊全", "縣市議員", r7, 2, "台北市");
  const curl = await load(db, "縣市議員", "台北市", "", [
    { name: "李有號", cand_no: 1, district: "07", area_code: "07" },
    { name: "陳齊全", cand_no: 2, district: "07", area_code: "07" },
  ]);
  const r1 = await region(db, "新北市", "第01選舉區");
  await person(db, "全對甲", "縣市議員", r1, 1, "新北市");
  await load(db, "縣市議員", "新北市", "", [{ name: "全對甲", cand_no: 1, district: "01", area_code: "01" }]);
  return { hurl, curl };
}
const gaps = (db: PGlite) => q<{ task_id: string; arm: string; items: any[]; items_count: number; kinds: any; target: any; what_we_need: string }>(db, `SELECT * FROM roster_gap_units() ORDER BY task_id`);

Deno.test("B1 只列有缺口的單位：缺人逐位帶姓名、村里、號次、政黨、出生年、官方網址；已對齊的單位不出現", async () => {
  const db = await buildDb();
  const { hurl } = await scenario(db);
  const g = await gaps(db);
  assertEquals(g.map((x) => x.task_id), [COUNCIL, HUALIEN].sort());
  const h = g.find((x) => x.task_id === HUALIEN)!;
  assertEquals([h.arm, h.items_count, h.kinds, h.target.findings_only, h.target.region, h.target.township, h.target.election_id], ["roster_villages", 1, { 缺人: 1 }, true, "花蓮縣花蓮市", "花蓮市", 2026]);
  const it = h.items[0];
  assertEquals([it.kind, it.name, it.official.village, it.official.cand_no, it.official.party, it.official.birth_roc, it.official.birth_year, it.source_url],
    ["缺人", "周玉梅", "國盛里", 1, "新生黨", "0650306", 1976, hurl]);
  for (const w of ["候選", "candidacy", "cand_no", "roster_check", "缺號次"]) assert(h.what_we_need.includes(w) || w === "候選", `說明缺 ${w}`);
  assert(!g.some((x) => x.task_id.includes("新北市")), "已對齊的新北市不得出現");
  await db.close();
});

Deno.test("B2 缺號次：本站已有此人、官方有號次、我們號次空 → 列在該單位；號次已有的不列", async () => {
  const db = await buildDb();
  const { curl } = await scenario(db);
  const c = (await gaps(db)).find((x) => x.task_id === COUNCIL)!;
  assertEquals([c.arm, c.items_count, c.kinds], ["raw:roster_check", 1, { 缺號次: 1 }]);
  assertEquals([c.items[0].kind, c.items[0].name, c.items[0].official.cand_no, c.items[0].source_url], ["缺號次", "李有號", 1, curl]);
  assert(typeof c.items[0].politician_id === "string" && Number.isInteger(c.items[0].politician_election_id));
  await db.close();
});

Deno.test("B3 補齊後單位自動消失（缺人補上、缺號次補上）；退件不影響（缺口還在就還在）", async () => {
  const db = await buildDb();
  await scenario(db);
  assertEquals((await gaps(db)).length, 2);
  // 交件被退：沒有任何資料變動 → 缺口原樣
  assertEquals((await gaps(db)).length, 2);
  const pid = (await q<{ id: string }>(db, `SELECT id FROM politicians WHERE name = '周玉梅'`))[0].id;
  const rid = (await q<{ id: number }>(db, `SELECT id FROM regions WHERE village = '國盛里'`))[0].id;
  await q(db, `INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status, cand_no) VALUES (2026, '村里長', $1, $2, 'filed', 1)`, [pid, rid]);
  await db.exec(`UPDATE politician_elections SET cand_no = 1 WHERE politician_id IN (SELECT id FROM politicians WHERE name = '李有號')`);
  assertEquals((await gaps(db)).length, 0);
  await db.close();
});

Deno.test("B4 鏡像不新鮮的單位不算（不用過期名冊派工）；fresh 單位清單", async () => {
  const db = await buildDb();
  await scenario(db);
  await db.exec(`UPDATE cec_roster_units SET fetched_at = now() - interval '9 days' WHERE election_type = '村里長'`);
  assertEquals((await gaps(db)).map((x) => x.task_id), [COUNCIL]);
  const f = await q<{ roster_gap_fresh_units: string }>(db, `SELECT * FROM roster_gap_fresh_units() ORDER BY 1`);
  assertEquals(f.map((x) => x.roster_gap_fresh_units), [COUNCIL, "auto:roster_check:2026:新北市:縣市議員"].sort());
  await db.close();
});

Deno.test("B5 派工只看現況：函式本體不讀 contributions／task_checks／task_dispatches（退過的人下一輪仍在）", () => {
  const body = fnText(X, "roster_gap_units");
  for (const t of ["contributions", "task_checks", "task_dispatches", "contribution_tasks"]) assert(!body.includes(t), `roster_gap_units 不應引用 ${t}`);
});

Deno.test("B6 attach：缺口項取代舊的缺人項，別種差異項留著，count 與 kinds 合計", async () => {
  const db = await buildDb();
  const t = { items: [{ kind: "缺人", name: "舊" }, { kind: "政黨", name: "甲" }], items_kinds: { 缺人: 1, 政黨: 1 } };
  const r = (await q<{ a: any }>(db, `SELECT roster_gap_attach($1::jsonb, $2::jsonb, 2, $3::jsonb) AS a`, [JSON.stringify(t), JSON.stringify([{ kind: "缺人", name: "新" }, { kind: "缺號次", name: "乙" }]), JSON.stringify({ 缺人: 1, 缺號次: 1 })]))[0].a;
  assertEquals(r.items.map((i: any) => i.name), ["新", "乙", "甲"]);
  assertEquals([r.items_count, r.items_kinds, r.roster_gap], [3, { 缺人: 1, 缺號次: 1, 政黨: 1 }, true]);
  await db.close();
});

Deno.test("還原驗證：拿掉缺號次那一段，B2 會紅", async () => {
  const db = await buildDb((s) => mutate(s, "AND r.cand_no IS NOT NULL\n", "AND false\n"));
  await scenario(db);
  assert(!(await gaps(db)).some((x) => x.task_id === COUNCIL), "缺號次條件被拿掉：議員單位不再出現（守門有效則 B2 會紅）");
  await db.close();
});

// ============================================================
// C. 總表新加的 tagged_g 段
// ============================================================
const BLOCK = X.slice(X.indexOf(BLOCK_A, X.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()")), X.indexOf("       -- <<< 名單缺口\n")).replace(/,\s*$/, "");

async function buildArmsLike(mutateBlock: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = await buildDb();
  await scenario(db);
  // tagged 的替身：現有的 2026 清查列（含舊 items）
  await db.exec(`CREATE TABLE stub_tagged (arm text, task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)`);
  const row = (id: string, target: Record<string, unknown>, arm = "raw:roster_check") =>
    db.query(`INSERT INTO stub_tagged VALUES ($1, $2, 'roster_check', $3::jsonb, '原說明', ARRAY['h'], 2, '台北市')`, [arm, id, JSON.stringify(target)]);
  await row(COUNCIL, { items: [{ kind: "缺人", name: "舊缺人" }], items_kinds: { 缺人: 1 } }); // 有缺口 → 併
  await row("auto:roster_check:2026:新北市:縣市議員", { items: [{ kind: "缺人", name: "過期" }], items_kinds: { 缺人: 1 } }); // 新鮮、無缺口、只有缺人項 → 收回
  await row("auto:roster_check:2026:高雄市:縣市議員", { items: [{ kind: "政黨", name: "乙" }], items_kinds: { 政黨: 1 } }); // 新鮮、無缺口、別種差異 → 但高雄沒有鏡像 → 照舊
  await row("auto:roster_check:2022:台北市:縣市長", {}); // 非 2026 → 不動
  return db;
}
const tagged = async (db: PGlite, onOff = true, mb: (s: string) => string = (s) => s) => {
  if (!onOff) await db.exec(`UPDATE roster_unify_settings SET enabled = false`);
  const sql = `WITH tagged AS (SELECT * FROM stub_tagged),\n${mb(BLOCK)}\n       -- <<<\n SELECT task_id, arm, target, what_we_need FROM tagged_g ORDER BY task_id`;
  return await q<{ task_id: string; arm: string; target: any; what_we_need: string }>(db, sql);
};

Deno.test("C1 有缺口併 items、說明加逐位段；沒清查列的缺口單位新開；對齊且鏡像新鮮的收回；鏡像不新鮮／非 2026 照舊", async () => {
  const db = await buildArmsLike();
  const r = await tagged(db);
  const ids = r.map((x) => x.task_id);
  assert(!ids.includes("auto:roster_check:2026:新北市:縣市議員"), "對齊且鏡像新鮮的 2026 清查要收回");
  assert(ids.includes("auto:roster_check:2026:高雄市:縣市議員"), "鏡像不新鮮／沒有鏡像的單位照舊");
  assert(ids.includes("auto:roster_check:2022:台北市:縣市長"), "非 2026 不動");
  const c = r.find((x) => x.task_id === COUNCIL)!;
  assertEquals(c.target.items.map((i: any) => i.name), ["李有號"], "缺口項取代舊缺人項");
  assertEquals(c.target.roster_gap, true);
  assert(c.what_we_need.startsWith("原說明") && c.what_we_need.includes("逐位補缺口"));
  const h = r.find((x) => x.task_id === HUALIEN)!;
  assertEquals([h.arm, h.target.items[0].name, h.target.findings_only], ["roster_villages", "周玉梅", true], "沒有清查列但有缺口的單位要新開（花蓮市）");
  assertEquals(ids.filter((i) => i === COUNCIL).length, 1, "同一單位只有一張");
  await db.close();
});

Deno.test("C2 對齊但還有別種差異（政黨等）的單位不收回；開關關著整段不動", async () => {
  const db = await buildArmsLike();
  await db.exec(`UPDATE stub_tagged SET target = '{"items":[{"kind":"政黨","name":"乙"}],"items_kinds":{"政黨":1}}'::jsonb WHERE task_id LIKE '%新北市%'`);
  assert((await tagged(db)).some((x) => x.task_id.includes("新北市")), "別種差異還在：不收回");
  const db2 = await buildArmsLike();
  const off = await tagged(db2, false);
  assertEquals(off.map((x) => x.task_id).sort(), ["auto:roster_check:2022:台北市:縣市長", "auto:roster_check:2026:新北市:縣市議員", "auto:roster_check:2026:高雄市:縣市議員", COUNCIL].sort());
  assert(!off.some((x) => x.task_id === HUALIEN) && !("roster_gap" in off.find((x) => x.task_id === COUNCIL)!.target));
  await db.close();
  await db2.close();
});

Deno.test("還原驗證：拿掉「對齊收回」條件，C1 的新北市會留著", async () => {
  const db = await buildArmsLike();
  const r = await tagged(db, true, (s) => mutate(s, "AND roster_gap_tid(t.task_id) IN (SELECT f.tid FROM gapfresh f)", "AND false"));
  assert(r.some((x) => x.task_id.includes("新北市")), "守門失效 → 本該被收回的單位留著");
  await db.close();
});

Deno.test("還原驗證：拿掉「缺口單位新開」那段，花蓮市（沒有清查列）派不出來", async () => {
  const db = await buildArmsLike();
  const r = await tagged(db, true, (s) => mutate(s, "FROM gapu gu\n   WHERE NOT EXISTS", "FROM gapu gu\n   WHERE false AND NOT EXISTS"));
  assert(!r.some((x) => x.task_id === HUALIEN));
  await db.close();
});

Deno.test("還原驗證：拿掉「只派有缺口」的併入，說明與 items 不會帶缺口", async () => {
  const db = await buildArmsLike();
  const r = await tagged(db, true, (s) => mutate(s, "CASE WHEN gu.task_id IS NULL THEN t.target ELSE t.target || roster_gap_attach(t.target, gu.items, gu.items_count, gu.kinds) END", "t.target"));
  assert(!("roster_gap" in r.find((x) => x.task_id === COUNCIL)!.target));
  await db.close();
});

// ============================================================
// D. 取代 #840：已開的單人任務收掉
// ============================================================
Deno.test("D1 open 的 roster_missing 單人任務收成 closed、其他任務不動、不碰參選資料", async () => {
  const db = await buildDb();
  await scenario(db);
  const mk = (kind: string, status: string, type = "candidacy_source_missing") =>
    db.query(`INSERT INTO contribution_tasks (title, task_type, target, status, source) VALUES ('t', $1, $2::jsonb, $3, 'manual')`, [type, JSON.stringify({ kind }), status]);
  await mk("roster_missing", "open"); await mk("roster_missing", "open"); await mk("roster_missing", "closed"); await mk("cand_no", "open"); await mk("roster_missing", "open", "other");
  const snap = async () => JSON.stringify([await q(db, `SELECT * FROM politician_elections ORDER BY id`), await q(db, `SELECT * FROM politicians ORDER BY id`)]);
  const before = await snap();
  const a = X.indexOf("UPDATE contribution_tasks");
  await db.exec(X.slice(a, X.indexOf(";", a) + 1));
  const st = await q<{ s: string; n: number }>(db, `SELECT status || '/' || task_type || '/' || (target->>'kind') AS s, count(*)::int AS n FROM contribution_tasks GROUP BY 1 ORDER BY 1`);
  assertEquals(st, [
    { s: "closed/candidacy_source_missing/roster_missing", n: 3 },
    { s: "open/candidacy_source_missing/cand_no", n: 1 },
    { s: "open/other/roster_missing", n: 1 },
  ]);
  assertEquals((await q(db, `SELECT 1 FROM contribution_tasks WHERE status = 'closed' AND closed_at IS NULL AND task_type = 'candidacy_source_missing' AND target->>'kind'='roster_missing' AND created_at > now() - interval '1 minute' AND false`)).length, 0);
  assertEquals(await snap(), before);
  await db.close();
});
