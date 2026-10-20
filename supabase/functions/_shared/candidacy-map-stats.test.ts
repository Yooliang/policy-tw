/**
 * 參選地圖統計表（migration 20261020080000_candidacy_map_stats.sql；#680）：candidacy_map() 改讀預先算好的表。
 *
 *   A. 文字層：簽名不變、排程每 10 分鐘第 9 分、重算是單一函式（單一交易）、只給 service_role、不寫人物或參選紀錄、
 *      即時版（candidacy_map_live）本體就是 20261019090000 的定義（只改名、一個字不動）
 *      表的形狀：全國 1 列、縣市 22 列（children＝鄉鎮）、鄉鎮 368 列（children＝村里，一個鄉鎮一列）
 *   B. PGlite（admin_divisions、參選紀錄、登記名冊、選舉區都是合成資料；即時函式與新 migration 都跑真的）：
 *      B1 重算之後 candidacy_map() 讀表的結果，跟即時函式逐列一致（三層 × 有無上一層代碼，含無對得上登記、無名額、
 *         撤回、同一人重複、臺／台、「第NN選舉區」、被新版取代的舊名冊）
 *      B1b 表的形狀（全國 1、縣市、鄉鎮各一列，children 是 [名稱, 收錄, 登記, 席次]，上一層的合計等於下一層加總的對得上）
 *      B2 表空的時候（或沒排程的屆別）退回即時計算，結果一樣
 *      B3 資料變了之後：重算前讀到的是上一次的整份（快取），重算後是新的整份；重算冪等、computed_at 更新、一個屆別不影響另一個屆別
 *      B4 排程入口只重算近 120 天內投票的選舉
 *   C. 還原驗證：重算少一層、沒先刪舊列，各自對應的劇本要翻面（逐列一致的檢查真的抓得到）
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, mutate, readMig } from "./arms-pglite.ts";

const STATS_NAME = "20261020080000_candidacy_map_stats.sql";
const LIVE_NAME = "20261019090000_candidacy_map.sql";
const STATS = await readMig(STATS_NAME);
const LIVE = await readMig(LIVE_NAME);
const ADMIN = await readMig("20261005000480_admin_divisions.sql");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

/** 新 migration 只跑到「第一次填表」之前（cron 不在 PGlite 裡）；排程那兩行另外用文字檢查 */
const statsBody = (sql: string) => sql.slice(0, sql.indexOf("-- 第一次填表，之後交給排程"));

const SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
${fnText(ADMIN, "admin_name_key")}
${fnText(ADMIN, "admin_match_key")}
CREATE TABLE admin_divisions (
  code text PRIMARY KEY, level text NOT NULL, parent_code text, county text NOT NULL, town text, village text,
  match_key text GENERATED ALWAYS AS (admin_match_key(county, town, village)) STORED
);
CREATE UNIQUE INDEX admin_divisions_match_key ON admin_divisions (match_key);
CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text, admin_code text);
CREATE TABLE politician_elections (id serial PRIMARY KEY, election_id integer, politician_id text, region_id integer, candidacy_status text);
CREATE TABLE cec_registrations (id serial PRIMARY KEY, election_id integer, region text, sub_region text, village text, source_url text);
CREATE TABLE cec_registration_sources (source_url text PRIMARY KEY, superseded_by text);
CREATE TABLE election_districts (id serial PRIMARY KEY, election_id integer, region text, sub_region text, village text, seats integer);

INSERT INTO admin_divisions (code, level, parent_code, county, town, village) VALUES
  ('10001', 'county', NULL, '臺北市', NULL, NULL),
  ('10001010', 'town', '10001', '臺北市', '甲區', NULL),
  ('10001020', 'town', '10001', '臺北市', '乙區', NULL),
  ('10001010001', 'village', '10001010', '臺北市', '甲區', '一里'),
  ('10001010002', 'village', '10001010', '臺北市', '甲區', '二里'),
  ('10001010003', 'village', '10001010', '臺北市', '甲區', '三里'),
  ('10001020001', 'village', '10001020', '臺北市', '乙區', '四里'),
  ('10001020002', 'village', '10001020', '臺北市', '乙區', '五里'),
  ('10002', 'county', NULL, '新北市', NULL, NULL),
  ('10002010', 'town', '10002', '新北市', '丙鄉', NULL),
  ('10002010001', 'village', '10002010', '新北市', '丙鄉', '六村'),
  ('10002010002', 'village', '10002010', '新北市', '丙鄉', '七村');

INSERT INTO elections (id, election_date) VALUES (2026, '2099-11-28'), (2022, '2022-11-26'), (1990, '1990-01-01');

INSERT INTO regions (id, region, sub_region, village, admin_code) VALUES
  (1, '台北市', NULL, NULL, '10001'),
  (2, '臺北市', '第01選舉區', NULL, NULL),
  (3, '台北市', '甲區', NULL, '10001010'),
  (4, '台北市', '甲區第02選舉區', NULL, NULL),
  (5, '台北市', '甲區', '一里', '10001010001'),
  (6, '台北市', '乙區', '四里', NULL),
  (7, '新北市', '丙鄉', '六村', '10002010001'),
  (8, '新北市', NULL, NULL, '10002'),
  (9, '台北市', '乙區', '五里', '10001020002');

INSERT INTO politician_elections (election_id, politician_id, region_id, candidacy_status) VALUES
  (2026, 'p1', 1, 'filed'), (2026, 'p2', 1, 'declared'), (2026, 'p3', 1, 'withdrawn'),
  (2026, 'p4', 2, 'filed'), (2026, 'p5', 2, 'filed'), (2026, 'p4', 2, 'filed'),
  (2026, 'p6', 3, 'filed'),
  (2026, 'p7', 4, 'filed'),
  (2026, 'p8', 5, 'filed'), (2026, 'p9', 5, 'filed'), (2026, 'p8', 5, NULL),
  (2026, 'p10', 6, 'filed'),
  (2026, 'p11', 7, 'filed'),
  (2026, 'p12', 8, 'filed'),
  (2026, 'p13', NULL, 'filed'),
  (2026, 'p14', 9, 'withdrawn'),
  (2022, 'q1', 1, 'filed'), (2022, 'q2', 5, 'filed');

INSERT INTO cec_registration_sources (source_url, superseded_by) VALUES ('old', 'new'), ('new', NULL);
INSERT INTO cec_registrations (election_id, region, sub_region, village, source_url) VALUES
  (2026, '台北市', NULL, NULL, 'new'), (2026, '台北市', NULL, NULL, 'new'), (2026, '台北市', NULL, NULL, 'old'),
  (2026, '台北市', '甲區', NULL, 'new'), (2026, '台北市', '甲區', '一里', 'new'), (2026, '台北市', '甲區', '一里', 'new'),
  (2026, '台北市', '乙區', '四里', 'new'), (2026, '臺北市', '乙區', NULL, 'new'),
  (2026, '新北市', '丙鄉', '六村', 'new'), (2026, '新北市', NULL, NULL, 'new'),
  (2026, '台北市', '不存在的區', NULL, 'new'),
  (2022, '台北市', NULL, NULL, 'new');

INSERT INTO election_districts (election_id, region, sub_region, village, seats) VALUES
  (2026, '台北市', NULL, NULL, 1), (2026, '台北市', '第01選舉區', NULL, 7), (2026, '台北市', '第02選舉區', NULL, NULL),
  (2026, '台北市', '甲區', NULL, 1), (2026, '台北市', '甲區第02選舉區', NULL, 5),
  (2026, '新北市', '丙鄉', NULL, 1),
  (2022, '台北市', NULL, NULL, 1);
`;

async function buildDb(statsSql: string = STATS): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(LIVE);
  await db.exec(statsBody(statsSql));
  return db;
}

type Row = { code: string; name: string; parent_code: string | null; candidates: number; registered: number | null; seats: number | null };
const rows = async (db: PGlite, fn: "candidacy_map" | "candidacy_map_live", election: number, level: string, parent: string | null): Promise<Row[]> =>
  (await db.query<Row>(`SELECT * FROM ${fn}($1, $2, $3)`, [election, level, parent])).rows;

const COMBOS: Array<[string, string | null]> = [
  ["county", null], ["town", null], ["town", "10001"], ["town", "10002"], ["village", null], ["village", "10001010"], ["village", "10001020"], ["village", "10001"], ["village", "10002010"],
];
async function diffs(db: PGlite, election = 2026): Promise<string[]> {
  const out: string[] = [];
  for (const [level, parent] of COMBOS) {
    const a = JSON.stringify(await rows(db, "candidacy_map", election, level, parent));
    const b = JSON.stringify(await rows(db, "candidacy_map_live", election, level, parent));
    if (a !== b) out.push(`${level}/${parent}`);
  }
  return out;
}

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 即時版本體＝20261019090000 的 candidacy_map 本體一個字不動，只是改名；candidacy_map() 簽名與回傳欄位不變", () => {
  assert(STATS.includes("ALTER FUNCTION candidacy_map(integer, text, text) RENAME TO candidacy_map_live;"));
  const liveBody = fnText(LIVE, "candidacy_map");
  // 新 migration 沒有重寫即時版（沒有第二份 WITH units AS 本體）
  assertEquals(code(STATS).split("WITH units AS").length - 1, 0);
  assert(liveBody.includes("WITH units AS"));
  const neu = fnText(STATS, "candidacy_map");
  assert(neu.startsWith("CREATE OR REPLACE FUNCTION candidacy_map(p_election_id integer, p_level text, p_parent text DEFAULT NULL)"));
  assert(neu.includes("RETURNS TABLE (code text, name text, parent_code text, candidates integer, registered integer, seats integer)"));
  assert(neu.includes("candidacy_map_live(p_election_id, p_level, p_parent)"), "表空的時候退回即時計算");
});

Deno.test("A2 排程每 10 分鐘第 9 分（roster-reconcile 之後兩分鐘）、重算是單一函式、先刪再寫在同一個函式裡", () => {
  assert(STATS.includes("SELECT cron.schedule('candidacy-map-stats-10min', '9,19,29,39,49,59 * * * *', $$SELECT candidacy_map_refresh_all();$$);"));
  assert(STATS.includes("SELECT cron.unschedule('candidacy-map-stats-10min')"));
  const refresh = fnText(STATS, "candidacy_map_refresh");
  const del = refresh.indexOf("DELETE FROM candidacy_map_stats WHERE election_id = p_election_id;");
  const ins = refresh.indexOf("INSERT INTO candidacy_map_stats");
  assert(del >= 0 && ins > del, "同一個函式（＝同一個交易）先刪該屆舊列再寫新列");
  for (const level of ["'county'", "'town'", "'village'"]) assert(refresh.includes(`candidacy_map_live(p_election_id, ${level}, NULL)`), `重算少了 ${level} 那一層`);
});

Deno.test("A3 權限：重算只給 service_role；統計表公開唯讀；migration 不寫任何人物或參選紀錄", () => {
  const c = code(STATS);
  assert(c.includes("REVOKE ALL ON FUNCTION candidacy_map_refresh(integer) FROM PUBLIC, anon, authenticated;"));
  assert(c.includes("GRANT EXECUTE ON FUNCTION candidacy_map_refresh(integer) TO service_role;"));
  assert(c.includes("GRANT EXECUTE ON FUNCTION candidacy_map_refresh_all() TO service_role;"));
  assert(c.includes("GRANT SELECT ON candidacy_map_stats TO anon, authenticated;"));
  assert(c.includes("ALTER TABLE candidacy_map_stats ENABLE ROW LEVEL SECURITY;"));
  for (const t of ["politicians", "politician_elections", "regions", "cec_registrations", "election_districts"]) {
    assert(!new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${t}\\b`).test(c), `不准寫 ${t}`);
  }
});

// ============================================================
// B. PGlite
// ============================================================
Deno.test("B1 重算之後 candidacy_map() 讀表，跟即時函式逐列一致（三層、有無上一層代碼）", async () => {
  const db = await buildDb();
  const n = (await db.query<{ n: number }>("SELECT candidacy_map_refresh(2026) AS n")).rows[0]!.n;
  assertEquals(n, 1 + 2 + 3, "全國 1、縣市 2、鄉鎮 3（村里在鄉鎮那一列的 children 裡）");
  assertEquals(await diffs(db), []);
  // 不是空對空：有人數、有登記、有名額、也有對不上的 NULL
  const towns = await rows(db, "candidacy_map", 2026, "town", null);
  assertEquals(towns.map((r) => r.code), ["10001010", "10001020", "10002010"]);
  const counties = await rows(db, "candidacy_map", 2026, "county", null);
  assert(counties.some((r) => r.candidates > 0) && counties.some((r) => r.registered !== null) && counties.some((r) => r.seats !== null));
  const villages = await rows(db, "candidacy_map", 2026, "village", null);
  assert(villages.some((r) => r.registered === null) && villages.some((r) => r.seats === null));
  assertEquals(counties[0]!.name, "台北市", "縣市名稱「臺」寫「台」");
  // 被新版取代的舊名冊不算：台北市（縣市層，只看 region）登記＝new 的 8 列（縣市 2＋甲區 1＋甲區一里 2＋乙區 2＋不存在的區 1），舊版那 1 列不算
  assertEquals(counties.find((r) => r.code === "10001")!.registered, 8);
  await db.close();
});

Deno.test("B1b 表的形狀：全國 1 列、縣市每縣市 1 列、鄉鎮每鄉鎮 1 列；children 是下一層 { 代碼: [名稱, 收錄, 登記, 席次] }，一個鄉鎮一列裝著全部村里", async () => {
  const db = await buildDb();
  await db.query("SELECT candidacy_map_refresh(2026)");
  type S = { scope: string; code: string; name: string; candidates: number; registered: number | null; seats: number | null; children: Record<string, [string, number, number | null, number | null]> };
  const all = (await db.query<S>("SELECT scope, code, name, candidates, registered, seats, children FROM candidacy_map_stats WHERE election_id = 2026 ORDER BY scope, code")).rows;
  assertEquals(all.map((r) => r.scope + ":" + r.code), ["county:10001", "county:10002", "nation:", "town:10001010", "town:10001020", "town:10002010"]);
  const by = (scope: string, code: string) => all.find((r) => r.scope === scope && r.code === code)!;
  assertEquals(Object.keys(by("nation", "").children), ["10001", "10002"], "全國那一列含各縣市");
  assertEquals(Object.keys(by("county", "10001").children).sort(), ["10001010", "10001020"], "縣市那一列含底下各鄉鎮");
  assertEquals(Object.keys(by("town", "10001010").children).sort(), ["10001010001", "10001010002", "10001010003"], "鄉鎮那一列含底下全部村里");
  const kid = by("town", "10001010").children["10001010001"]!;
  assertEquals(kid[0], "一里");
  assertEquals(kid.length, 4);
  // 子列的數字跟那一區自己那一列一致（縣市 children 的鄉鎮數字＝鄉鎮列自己的數字）
  const t = by("town", "10001010");
  assertEquals(by("county", "10001").children["10001010"], [t.name, t.candidates, t.registered, t.seats]);
  const nat = by("nation", "");
  assertEquals(nat.candidates, all.filter((r) => r.scope === "county").reduce((n, r) => n + r.candidates, 0), "全國收錄＝各縣市加總");
  assertEquals(nat.name, "全國");
  // null 保留成 JSON null（沒對得上登記／沒查證名額），不是 0
  assert(Object.values(by("town", "10001010").children).some((k) => k[2] === null || k[3] === null));
  await db.close();
});

Deno.test("B2 表空的時候（或沒排程的屆別）退回即時計算，結果一樣", async () => {
  const db = await buildDb();
  assertEquals((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM candidacy_map_stats")).rows[0]!.n, 0);
  assertEquals(await diffs(db), [], "表空：candidacy_map 走即時計算");
  assert((await rows(db, "candidacy_map", 2026, "county", null)).length === 2);
  await db.query("SELECT candidacy_map_refresh(2026)");
  assertEquals(await diffs(db, 2022), [], "2022 沒有重算過：這一屆仍走即時計算");
  assertEquals((await rows(db, "candidacy_map", 2022, "county", null)).find((r) => r.code === "10001")!.candidates, 2, "2022：q1（縣市）＋q2（村里，歸到縣市）");
  assertEquals((await rows(db, "candidacy_map", 2026, "county", null)).find((r) => r.code === "10001")!.candidates > 1, true);
  await db.close();
});

Deno.test("B3 資料變了：重算前讀到上一次的整份，重算後是新的整份；重算冪等、computed_at 更新、不影響別屆", async () => {
  const db = await buildDb();
  await db.query("SELECT candidacy_map_refresh(2026)");
  await db.query("SELECT candidacy_map_refresh(2022)");
  const stamp = async (e: number) => (await db.query<{ t: string }>("SELECT max(computed_at)::text AS t FROM candidacy_map_stats WHERE election_id = $1", [e])).rows[0]!.t;
  const t2026 = await stamp(2026);
  const t2022 = await stamp(2022);
  const before = (await rows(db, "candidacy_map", 2026, "county", null)).find((r) => r.code === "10001")!.candidates;

  await db.query("INSERT INTO politician_elections (election_id, politician_id, region_id, candidacy_status) VALUES (2026, 'new-person', 1, 'filed')");
  assertEquals((await rows(db, "candidacy_map", 2026, "county", null)).find((r) => r.code === "10001")!.candidates, before, "重算之前讀到的是上一次的整份");
  assertEquals((await rows(db, "candidacy_map_live", 2026, "county", null)).find((r) => r.code === "10001")!.candidates, before + 1);

  await new Promise((r) => setTimeout(r, 5));
  await db.query("SELECT candidacy_map_refresh(2026)");
  assertEquals((await rows(db, "candidacy_map", 2026, "county", null)).find((r) => r.code === "10001")!.candidates, before + 1);
  assertEquals(await diffs(db), []);
  assert((await stamp(2026)) > t2026, "computed_at 更新");
  assertEquals(await stamp(2022), t2022, "別屆沒被動到");
  assertEquals((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM candidacy_map_stats WHERE election_id = 2026")).rows[0]!.n, 6, "重算不會重複寫");
  await db.close();
});

Deno.test("B4 排程入口只重算近 120 天內投票（或還沒投票）的選舉，更早的屆別留給即時計算", async () => {
  const db = await buildDb();
  const total = (await db.query<{ n: number }>("SELECT candidacy_map_refresh_all() AS n")).rows[0]!.n;
  assertEquals(total, 6, "只有 2026（日期在未來）被重算：2022、1990 太舊");
  const els = (await db.query<{ e: number }>("SELECT DISTINCT election_id AS e FROM candidacy_map_stats ORDER BY 1")).rows.map((r) => r.e);
  assertEquals(els, [2026]);
  await db.close();
});

// ============================================================
// C. 還原驗證：逐列一致的檢查真的抓得到
// ============================================================
Deno.test("C1 還原驗證：重算時村里沒寫進鄉鎮那一列的 children，B1 的逐列比對要翻面", async () => {
  const bad = mutate(STATS, "FROM v GROUP BY v.parent_code", "FROM v WHERE false GROUP BY v.parent_code");
  const db = await buildDb(bad);
  await db.query("SELECT candidacy_map_refresh(2026)");
  const d = await diffs(db);
  assert(d.some((x) => x.startsWith("village")), `少寫的村里層沒被抓到：${d.join(",")}`);
  await db.close();
});

Deno.test("C2 還原驗證：重算沒先刪舊列，第二次重算會撞主鍵（B3 的冪等要翻面）", async () => {
  const bad = mutate(STATS, "  DELETE FROM candidacy_map_stats WHERE election_id = p_election_id;\n", "");
  const db = await buildDb(bad);
  await db.query("SELECT candidacy_map_refresh(2026)");
  await assertRejects(() => db.query("SELECT candidacy_map_refresh(2026)"));
  await db.close();
});

Deno.test("C3 還原驗證：鄉鎮層讀表時沒有過濾 scope，結果跟即時版不一樣（B1 翻面）", async () => {
  const bad = mutate(STATS, "s.scope = 'town' AND (p_parent IS NULL OR s.code LIKE p_parent || '%')", "(p_parent IS NULL OR s.code LIKE p_parent || '%')");
  const db = await buildDb(bad);
  await db.query("SELECT candidacy_map_refresh(2026)");
  assert((await diffs(db)).length > 0);
  await db.close();
});
