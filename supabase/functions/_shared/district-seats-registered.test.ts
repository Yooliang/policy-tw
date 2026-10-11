/**
 * 應選名額任務以「中選會登記名冊上有人登記的選舉區數」當下限（migration 20261011080000_district_seats_registered_floor.sql，policy-ops#23）的守門。
 *
 * 10-09 人工核對：官方 2026 縣市議員 221 區、正式庫 150 區，漏的 71 區（新竹縣整縣、各縣市原住民區）派工臂永遠派不出來——
 * 臂只看「已有的選舉區裡還有沒有缺名額」，部分交件通過後就不再派。修法只加一個下限條件，不寫任何名額。
 *
 *   A. 文字層
 *      1. 只重定義這支臂、不寫正式資料；緊接 20261009090000，之後沒有人再定義
 *      2. 新定義＝前一版＋四處機械替換（task_id、target、hint_sources、reward、region 的寫法一字不動）
 *      3. 下限算法跟 migration 裡的登記名冊資料對得上：2026 縣市議員 221 區、22 縣市逐縣市等於核對報告的官方區數
 *   B. PGlite 行為層：同一份合成資料上舊定義與新定義比——舊的每一件新的都有、本體一字不差；
 *      多出來的只有「選舉區比登記名冊少」的；舊版名冊（superseded_by）與 2022 不算；說明多一句差幾區
 *   C. 還原驗證：把條件拿掉、或下限不連鄉鎮算、或不排除舊版名冊，B 必須紅
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG = "20261011080000_district_seats_registered_floor.sql";
const PREV = "20261009090000_district_seats_official_sources.sql";
const FN = "contribution_auto_tasks_district_seats";
const MIG_SQL = await readMig(MIG);
const OLD_FN = fnText(await readMig(PREV), FN);
const NEW_FN = fnText(MIG_SQL, FN);

/** 機械式替換（migration 與守門各寫一遍）：加 reg CTE、說明多一句、FROM 加 LEFT JOIN、WHERE 多一個 OR */
const REPLACEMENTS: Array<[string, string]> = [
  ["  -- 已經有人交了、還在等票的縣市不再派",
   "  -- 中選會登記名冊上有人登記的選舉區（議員、代表才有 district；代表的選舉區編號每個鄉鎮各自從第01起，要連鄉鎮一起算）：\n  -- 我們的選舉區比它少＝漏了區（常是原住民選舉區），既有的名額都補齊了也要再派（2026-10-11，policy-ops#23）\n  reg AS (\n    SELECT g.election_id, g.election_type, g.region, count(DISTINCT COALESCE(g.sub_region, '') || '|' || g.district) AS districts\n      FROM cec_registrations g\n      JOIN cec_registration_sources src ON src.source_url = g.source_url AND src.superseded_by IS NULL\n     WHERE g.district IS NOT NULL AND g.district <> ''\n       AND g.election_type IN ('縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表')\n     GROUP BY g.election_id, g.election_type, g.region\n  ),\n  -- 已經有人交了、還在等票的縣市不再派"],
  ["                   ELSE '我們知道 ' || h.districts || ' 個選舉區、其中 ' || (h.districts - h.with_seats) || ' 個還沒有名額（target.known_districts）。' END\n",
   "                   ELSE '我們知道 ' || h.districts || ' 個選舉區、其中 ' || (h.districts - h.with_seats) || ' 個還沒有名額（target.known_districts）。' END\n           || CASE WHEN h.districts < g.districts\n                   THEN '中選會登記名冊上這個縣市有 ' || g.districts || ' 個選舉區有人登記，比我們知道的多 ' || (g.districts - h.districts)\n                     || ' 個（常是原住民選舉區）：缺的那幾區要連名額一起補上。'\n                   ELSE '' END\n"],
  ["    LEFT JOIN have h ON h.election_id = w.election_id AND h.election_type = w.election_type AND h.region = w.county\n",
   "    LEFT JOIN have h ON h.election_id = w.election_id AND h.election_type = w.election_type AND h.region = w.county\n    LEFT JOIN reg g ON g.election_id = w.election_id AND g.election_type = w.election_type AND g.region = w.county\n"],
  ["   WHERE (h.districts IS NULL OR h.with_seats < h.districts)\n",
   "   WHERE (h.districts IS NULL OR h.with_seats < h.districts OR h.districts < g.districts)\n"],
];
const mechanical = (old: string): string => REPLACEMENTS.reduce((s, [from, to]) => mutate(s, from, to), old);
const codeOf = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const throws = (f: () => unknown): boolean => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 範圍：只重定義 district_seats 臂、不寫任何正式資料；緊接 20261009090000，之後沒有人再定義", async () => {
  const code = codeOf(MIG_SQL).replace(/'(?:[^']|'')*'/g, "''");
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?([a-z_]+)\(/g)].map((m) => m[1]);
  assertEquals(defined, [FN]);
  assert(!/INSERT INTO|UPDATE\s+[a-z_]+\s+SET|DELETE FROM|ALTER TABLE|DROP |TRUNCATE/i.test(code), "不寫資料、不改結構");
  const definers: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${FN}(`)) definers.push(n);
  const i = definers.indexOf(MIG);
  assertEquals(definers[i - 1], PREV, "前一版應該是 20261009090000；有人在中間改了，要以那一版為底重做機械替換");
  assertEquals(definers.slice(i + 1), [], "這支之後又有人重新定義臂：要以最新那版為底重做");
});

Deno.test("A2 新定義＝前一版的現行定義＋四處機械替換", () => {
  assertEquals(NEW_FN, mechanical(OLD_FN));
});

/** 核對報告（policy-ops docs/handoff/2026-10-09-縣市議員選區名額核對.md）的官方區數 */
const OFFICIAL_COUNCIL: Record<string, number> = {
  台北市: 8, 新北市: 13, 桃園市: 14, 台中市: 17, 台南市: 13, 高雄市: 15, 新竹縣: 14, 苗栗縣: 8, 彰化縣: 10, 南投縣: 8, 雲林縣: 8,
  嘉義縣: 7, 屏東縣: 16, 宜蘭縣: 13, 花蓮縣: 10, 台東縣: 16, 澎湖縣: 6, 金門縣: 3, 連江縣: 4, 基隆市: 9, 新竹市: 7, 嘉義市: 2,
};

Deno.test("A3 下限跟登記名冊資料對得上：2026 縣市議員 221 區、逐縣市等於官方公告的區數（不含舊版名冊 729644ff）", async () => {
  const data = await readMig("20261008130100_cec_registrations_data.sql");
  const blocks = data.split("\nSELECT 2026, '").slice(1);
  const byCounty = new Map<string, Set<string>>();
  for (const b of blocks) {
    if (!b.startsWith("縣市議員'") || b.includes("729644ff-")) continue;
    for (const m of b.matchAll(/\('([^']*)',(?:NULL|'[^']*'),(NULL|'[^']*'),(?:NULL|'[^']*'),'([^']*)',/g)) {
      const s = byCounty.get(m[1]) ?? new Set<string>();
      s.add(`${m[2]}|${m[3]}`);
      byCounty.set(m[1], s);
    }
  }
  const got = Object.fromEntries([...byCounty].map(([k, v]) => [k, v.size]));
  assertEquals(got, OFFICIAL_COUNCIL);
  assertEquals(Object.values(got).reduce((a, n) => a + n, 0), 221);
});

// ============================================================
// B. PGlite 行為層
// ============================================================
const OLD_URL = "https://web.cec.gov.tw/api/file/old.pdf";
const NEW_URL = "https://web.cec.gov.tw/api/file/new.pdf";
const DDL = `
CREATE TABLE elections (id integer PRIMARY KEY, election_date date, election_types text[]);
CREATE TABLE admin_divisions (level text, county text);
CREATE TABLE election_districts (id serial PRIMARY KEY, election_id integer, election_type text, region text, sub_region text, district_kind text, seats integer);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb);
CREATE TABLE verification_sources (id serial PRIMARY KEY, provides text[], election_types text[], regions text[], election_ids integer[]);
CREATE TABLE cec_registration_sources (source_url text PRIMARY KEY, superseded_by text);
CREATE TABLE cec_registrations (id serial PRIMARY KEY, election_id integer, election_type text, region text, sub_region text, district text, source_url text);
`;
const TYPES = ["縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表"];
const SEED = `
INSERT INTO elections VALUES (2022, '2022-11-26', ARRAY[${TYPES.map((t) => `'${t}'`).join(",")}]), (2026, '2099-11-28', ARRAY[${TYPES.map((t) => `'${t}'`).join(",")}]);
INSERT INTO admin_divisions VALUES ('county', '臺北市'), ('county', '屏東縣'), ('county', '新竹縣'), ('county', '嘉義市');
INSERT INTO verification_sources (provides, election_types, regions, election_ids) VALUES (ARRAY['seats'], ARRAY['縣市議員'], NULL, ARRAY[2026]);
INSERT INTO cec_registration_sources VALUES ('${NEW_URL}', NULL), ('${OLD_URL}', '${NEW_URL}');
INSERT INTO election_districts (election_id, election_type, region, sub_region, district_kind, seats) VALUES
  -- 台北市 2026：兩個區域區都有名額，但名冊上有三區（第03＝原住民區，我們漏了）→ 新定義才派
  (2026, '縣市議員', '台北市', '第01選舉區', 'district', 12), (2026, '縣市議員', '台北市', '第02選舉區', 'district', 9),
  -- 嘉義市 2026：兩區都有名額、名冊也兩區 → 都不派
  (2026, '縣市議員', '嘉義市', '第01選舉區', 'district', 10), (2026, '縣市議員', '嘉義市', '第02選舉區', 'district', 13),
  -- 屏東縣 2026：一區沒名額（舊定義就派）
  (2026, '縣市議員', '屏東縣', '第01選舉區', 'district', NULL),
  -- 2022 台北市：有名額，沒有名冊資料 → 兩個定義都不派
  (2022, '縣市議員', '台北市', '第01選舉區', 'district', 12),
  -- 鄉鎮市民代表 2026 屏東縣：兩個鄉鎮各一區都有名額；名冊上屏東市第01、東港鎮第01、第02（連鄉鎮算＝3 區，漏了東港鎮第02；只看編號會算成 2 區）
  (2026, '鄉鎮市長', '屏東縣', '屏東市', 'at_large', 1), (2026, '鄉鎮市長', '屏東縣', '東港鎮', 'at_large', 1),
  (2026, '鄉鎮市民代表', '屏東縣', '屏東市第01選舉區', 'district', 5), (2026, '鄉鎮市民代表', '屏東縣', '東港鎮第01選舉區', 'district', 3);
INSERT INTO cec_registrations (election_id, election_type, region, sub_region, district, source_url) VALUES
  (2026, '縣市議員', '台北市', NULL, '第01選舉區', '${NEW_URL}'), (2026, '縣市議員', '台北市', NULL, '第01選舉區', '${NEW_URL}'),
  (2026, '縣市議員', '台北市', NULL, '第02選舉區', '${NEW_URL}'), (2026, '縣市議員', '台北市', NULL, '第03選舉區', '${NEW_URL}'),
  (2026, '縣市議員', '嘉義市', NULL, '第01選舉區', '${NEW_URL}'), (2026, '縣市議員', '嘉義市', NULL, '第02選舉區', '${NEW_URL}'),
  -- 舊版名冊多一區：不能算（算了嘉義市會被誤派）
  (2026, '縣市議員', '嘉義市', NULL, '第09選舉區', '${OLD_URL}'),
  (2026, '鄉鎮市民代表', '屏東縣', '屏東市', '第01選舉區', '${NEW_URL}'), (2026, '鄉鎮市民代表', '屏東縣', '東港鎮', '第01選舉區', '${NEW_URL}'),
  (2026, '鄉鎮市民代表', '屏東縣', '東港鎮', '第02選舉區', '${NEW_URL}'),
  -- 新竹縣 2026：我們一區都沒有、名冊有兩區（舊定義也派，h.districts IS NULL）
  (2026, '縣市議員', '新竹縣', NULL, '第01選舉區', '${NEW_URL}'), (2026, '縣市議員', '新竹縣', NULL, '第02選舉區', '${NEW_URL}');
`;

type Out = { task_id: string; task_type: string; target: unknown; reward: number; region: string; what_we_need: string; hint_sources: string[] };
const readOut = async (db: PGlite): Promise<Out[]> =>
  (await db.query<Out>(`SELECT task_id, task_type, target, reward, region, what_we_need, hint_sources FROM ${FN}() ORDER BY task_id COLLATE "C"`)).rows;

async function run(fnSql: string): Promise<Out[]> {
  const db = new PGlite();
  await db.exec(DDL);
  await db.exec(SEED);
  await db.exec(fnSql);
  return await readOut(db);
}

const ADDED = "auto:district_seats_missing:2026:台北市:縣市議員";
const ADDED_REP = "auto:district_seats_missing:2026:屏東縣:鄉鎮市民代表";
/** 舊的每一件新的都有、本體與說明一字不差；多出來的只有台北市 2026 議員與屏東縣 2026 代表；說明多一句差幾區（還原驗證餵改壞的定義進來，必須紅） */
function check(before: Out[], after: Out[]): void {
  const a = new Map(after.map((r) => [r.task_id, r]));
  for (const b of before) {
    const n = a.get(b.task_id);
    assert(n, `${b.task_id}：舊定義派的新定義也要派`);
    assertEquals(n, b, `${b.task_id}：本體與說明一字不差（沒有少區的不加句子）`);
  }
  const extra = after.filter((r) => !before.some((b) => b.task_id === r.task_id)).map((r) => r.task_id);
  assertEquals(extra, [ADDED, ADDED_REP], "多出來的只有選舉區比登記名冊少的台北市 2026 議員、屏東縣 2026 代表");
  assertStringIncludes(a.get(ADDED_REP)!.what_we_need, "有 3 個選舉區有人登記，比我們知道的多 1 個");
  const t = a.get(ADDED)!;
  assertStringIncludes(t.what_we_need, "我們知道 2 個選舉區、其中 0 個還沒有名額");
  assertStringIncludes(t.what_we_need, "中選會登記名冊上這個縣市有 3 個選舉區有人登記，比我們知道的多 1 個");
  assertEquals((t.target as { known_count: number }).known_count, 2);
  for (const id of ["auto:district_seats_missing:2026:嘉義市:縣市議員", "auto:district_seats_missing:2022:台北市:縣市議員"]) {
    assert(!a.has(id), `${id} 不該派`);
  }
}

Deno.test("B1 行為層：舊定義的每一件照舊、本體一字不差；只多派選舉區比登記名冊少的；舊版名冊、2022、代表連鄉鎮算", async () => {
  const before = await run(OLD_FN);
  // 2022 年的嘉義市、屏東縣、新竹縣一區都沒有（舊定義本來就派）；2026 屏東縣議員缺名額、新竹縣一區都沒有
  assertEquals(before.map((r) => r.task_id), [
    "auto:district_seats_missing:2022:嘉義市:縣市議員",
    "auto:district_seats_missing:2022:屏東縣:縣市議員",
    "auto:district_seats_missing:2022:新竹縣:縣市議員",
    "auto:district_seats_missing:2026:屏東縣:縣市議員",
    "auto:district_seats_missing:2026:新竹縣:縣市議員",
  ]);
  check(before, await run(NEW_FN));
});

// ============================================================
// C. 還原驗證
// ============================================================
const MUTATIONS: Array<{ why: string; from: string; to: string }> = [
  { why: "WHERE 不加下限（等於沒修）", from: " OR h.districts < g.districts)\n", to: ")\n" },
  { why: "代表的選舉區不連鄉鎮算（屏東市、東港鎮的第01選舉區算成一區，漏的東港鎮第02看不出來）", from: "count(DISTINCT COALESCE(g.sub_region, '') || '|' || g.district)", to: "count(DISTINCT g.district)" },
  { why: "不排除舊版名冊（嘉義市被舊版多出的一區誤派）", from: " AND src.superseded_by IS NULL\n", to: "\n" },
];
for (const m of MUTATIONS) {
  Deno.test(`C 還原驗證：${m.why}，B1 要紅`, async () => {
    const before = await run(OLD_FN);
    check(before, await run(NEW_FN));
    const bad = mutate(NEW_FN, m.from, m.to);
    const after = await run(bad);
    assert(throws(() => check(before, after)), "改壞之後 B1 必須紅");
  });
}
