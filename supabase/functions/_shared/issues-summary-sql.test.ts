/**
 * 議題串聯的 SQL 函式（20261031130000_issues_summary_page.sql）守門，跑在 PGlite（真的 migration，最小的表）。
 *
 *   1. issue_tags_of 與 lib/issue-tags.ts 的 issueTagsOf 逐案相同（案例表與 lib/issue-tags.test.ts 的 SQL_PARITY_CASES 是同一張，改規則兩邊一起改）
 *   2. issues_summary：範圍（本屆、本縣市、競選承諾、沒移除、層級內）、不是議題的名字被濾掉、一筆政見多議題各算一次、各層級小計、代表標題
 *   3. issues_page：層級順序、同脈絡排在一起、時間新到舊、分頁、層級篩選、總筆數、作者欄位
 *   4. 只新增唯讀函式與索引：不寫資料、不改既有物件
 *   5. 還原驗證：把 migration 改壞一處，對應的測試必須紅
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { mutate } from "./arms-pglite.ts";

const MIG = (await Deno.readTextFile(new URL("../../migrations/20261031130000_issues_summary_page.sql", import.meta.url))).replace(/\r\n/g, "\n");

const SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated;
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politicians (id uuid PRIMARY KEY, name text, avatar_url text, party text);
CREATE TABLE parties (id bigint PRIMARY KEY, name text, short_name text);
CREATE TABLE politician_elections (politician_id uuid, election_id integer, election_type text, position text, cand_no integer, region_id integer, party_id bigint, PRIMARY KEY (politician_id, election_id));
CREATE TABLE policies (id uuid PRIMARY KEY, politician_id uuid, election_id integer, title text, category text, status text, proposed_date date, tags text[], lineage_id uuid, removed_at timestamptz);
`;

const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const L1 = u(901), L2 = u(902);

// 人物：1 縣市長 王小明（高雄）、2 議員 李大華、3 議員 林二、4 里長 陳里長（鳳山區）、5 鄉鎮市長 張區長（鳳山區）、6 台北市長、7 立委（不在串聯）
const SEED = `
INSERT INTO regions VALUES (1,'高雄市',NULL,NULL),(2,'高雄市','鳳山區',NULL),(3,'高雄市','鳳山區','五甲里'),(4,'臺北市',NULL,NULL),(5,'高雄市','第01選舉區',NULL);
INSERT INTO parties VALUES (1,'中國國民黨','國民黨');
INSERT INTO politicians VALUES
 ('${u(1)}','王小明','http://a/1.jpg','x'),('${u(2)}','李大華',NULL,'無黨籍'),('${u(3)}','林二',NULL,NULL),
 ('${u(4)}','陳里長',NULL,NULL),('${u(5)}','張區長',NULL,NULL),('${u(6)}','北市長',NULL,NULL),('${u(7)}','立委甲',NULL,NULL);
INSERT INTO politician_elections VALUES
 ('${u(1)}',2026,'縣市長','市長',3,1,1),('${u(2)}',2026,'縣市議員','議員',7,5,NULL),('${u(3)}',2026,'縣市議員','議員',8,5,NULL),
 ('${u(4)}',2026,'村里長','里長',1,3,NULL),('${u(5)}',2026,'鄉鎮市長','區長',2,2,NULL),('${u(6)}',2026,'縣市長','市長',1,4,NULL),
 ('${u(7)}',2026,'立法委員','立委',1,1,NULL);
INSERT INTO policies (id, politician_id, election_id, title, category, status, proposed_date, tags, lineage_id, removed_at) VALUES
 ('${u(101)}','${u(1)}',2026,'市長交通','其他','Campaign Pledge','2026-06-01',ARRAY['交通','2026高雄市長'],NULL,NULL),
 ('${u(102)}','${u(2)}',2026,'議員甲 脈絡舊','x','Campaign Pledge','2026-01-01',ARRAY['交通'],'${L1}',NULL),
 ('${u(103)}','${u(2)}',2026,'議員甲 無脈絡','交通','Campaign Pledge','2026-03-01',NULL,NULL,NULL),
 ('${u(104)}','${u(3)}',2026,'議員乙 脈絡新','x','Campaign Pledge','2026-05-01',ARRAY['交通'],'${L1}',NULL),
 ('${u(105)}','${u(3)}',2026,'議員乙 無脈絡','交通','Campaign Pledge','2026-02-01',NULL,NULL,NULL),
 ('${u(106)}','${u(4)}',2026,'里長教育','教育文化','Campaign Pledge','2026-04-01',ARRAY['鳳山','陳里長'],NULL,NULL),
 ('${u(107)}','${u(5)}',2026,'區長兩議題','其他','Campaign Pledge','2026-04-02',ARRAY['交通','長照'],NULL,NULL),
 ('${u(108)}','${u(1)}',2026,'已移除','交通','Campaign Pledge','2026-06-02',NULL,NULL,now()),
 ('${u(109)}','${u(1)}',2026,'不是競選承諾','交通','In Progress','2026-06-03',NULL,NULL,NULL),
 ('${u(110)}','${u(1)}',2022,'別屆','交通','Campaign Pledge','2022-06-03',NULL,NULL,NULL),
 ('${u(111)}','${u(6)}',2026,'台北的','交通','Campaign Pledge','2026-06-03',NULL,NULL,NULL),
 ('${u(112)}','${u(7)}',2026,'立委的','交通','Campaign Pledge','2026-06-03',NULL,NULL,NULL),
 ('${u(113)}','${u(1)}',2026,'只剩垃圾標籤','其他','Campaign Pledge','2026-06-04',ARRAY['務實施政'],NULL,NULL);
`;

async function build(migration: string = MIG): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(migration);
  return db;
}

type Row = Record<string, unknown>;
const q = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Row>(sql, params)).rows;
const summary = async (db: PGlite, region = "高雄市") => await q(db, "SELECT issue, total::int, by_level, samples FROM issues_summary(2026, $1)", [region]);
const page = async (db: PGlite, issue: string, level: string | null, off = 0, lim = 30, region = "高雄市") =>
  await q(db, "SELECT policy_id::text, level, name, total::int FROM issues_page(2026, $1, $2, $3, $4, $5)", [region, issue, level, off, lim]);
const idsOf = (rows: Row[]) => rows.map((r) => Number(String(r.policy_id).slice(-3)));

// ---- 1. 與 TS 版逐案相同（案例表同 lib/issue-tags.test.ts 的 SQL_PARITY_CASES） ----
const NAMES = ["王小明", "鳳山", "鳳山區"];
const CASES: Array<[string[] | null, string | null, string[]]> = [
  [["交通", "2026高雄市長"], "其他", ["交通"]],
  [null, "交通", ["交通"]],
  [["鳳山", "王小明"], "教育文化", ["教育文化"]],
  [["交通", "長照", "交通"], "x", ["交通", "長照"]],
  [[" 長照 "], null, ["長照"]],
  [["中央社RSS", "務實施政"], "其他", []],
  [["高雄市"], "經濟", ["經濟"]],
  [["2026"], "環境", ["環境"]],
  [["A"], "環境", ["環境"]],
  [[], "", []],
  [["高雄市長候選人"], "醫療衛生", ["醫療衛生"]],
  [["臺南"], null, []],
  [["臉書粉專貼文"], "社會福利", ["社會福利"]],
  [["預算 公共"], "  ", ["預算 公共"]],
];

Deno.test("issue_tags_of：與 lib/issue-tags.ts 的案例表逐案相同", async () => {
  const db = await build();
  for (const [tags, cat, want] of CASES) {
    const [r] = await q(db, "SELECT issue_tags_of($1::text[], $2, $3::text[]) AS t", [tags, cat, NAMES]);
    assertEquals([...(r.t as string[])].sort(), [...want].sort(), JSON.stringify([tags, cat]));
  }
});

// ---- 2. issues_summary ----
Deno.test("issues_summary：範圍、議題分組、各層級小計、代表標題", async () => {
  const db = await build();
  const rows = await summary(db);
  const by = Object.fromEntries(rows.map((r) => [r.issue as string, r]));
  assertEquals(Object.keys(by).sort(), ["交通", "教育文化", "長照"], "移除、非競選承諾、別屆、別縣市、立委都不算；垃圾標籤＋類別其他的政見不產生議題");
  assertEquals(by["交通"].total, 6);
  assertEquals(by["交通"].by_level, { "縣市長": 1, "議員": 4, "鄉鎮市區長": 1 });
  assertEquals(by["長照"].total, 1);
  assertEquals(by["教育文化"].by_level, { "村里長": 1 }, "鳳山（鄉鎮名）與陳里長（候選人名）被濾掉，退回類別");
  assertEquals(by["交通"].samples, ["市長交通", "議員乙 脈絡新", "議員乙 無脈絡"].slice(0, 1).concat(["議員乙 脈絡新", "議員甲 無脈絡"]), "代表標題：層級優先、同層新到舊");
  assertEquals(rows[0].issue, "交通", "照總數由多到少");
});

Deno.test("issues_summary：臺／台不分；別的縣市只看到自己的；沒資料回空", async () => {
  const db = await build();
  assertEquals((await summary(db, "臺北市")).map((r) => r.issue), ["交通"]);
  assertEquals((await summary(db, "台北市")).map((r) => r.total), [1]);
  assertEquals((await summary(db, "新竹縣")).length, 0);
});

// ---- 3. issues_page ----
Deno.test("issues_page：層級 → 脈絡串在一起 → 時間新到舊", async () => {
  const db = await build();
  const rows = await page(db, "交通", null);
  // 縣市長 101；議員：脈絡 L1（104、102，群內新到舊，群的位置看群內最新 05-01）→ 103（03-01）→ 105（02-01）；區長 107
  assertEquals(idsOf(rows), [101, 104, 102, 103, 105, 107]);
  assertEquals(rows.map((r) => r.level), ["縣市長", "議員", "議員", "議員", "議員", "鄉鎮市區長"]);
  assert(rows.every((r) => r.total === 6));
});

Deno.test("issues_page：分頁不重不漏、層級篩選、limit 上限", async () => {
  const db = await build();
  const all = idsOf(await page(db, "交通", null));
  const p1 = idsOf(await page(db, "交通", null, 0, 2));
  const p2 = idsOf(await page(db, "交通", null, 2, 2));
  const p3 = idsOf(await page(db, "交通", null, 4, 2));
  assertEquals([...p1, ...p2, ...p3], all);
  assertEquals(idsOf(await page(db, "交通", null, 6, 2)), []);
  const council = await page(db, "交通", "議員");
  assertEquals(idsOf(council), [104, 102, 103, 105]);
  assert(council.every((r) => r.total === 4), "total 是篩選後的總數，前端靠它判斷還有沒有下一頁");
  assertEquals((await page(db, "不存在", null)).length, 0);
});

Deno.test("issues_page：作者精簡欄位（姓名、職位、號次、頭像、黨籍）", async () => {
  const db = await build();
  const [r] = await q(db, "SELECT name, position_title, cand_no, avatar_url, party, category, proposed_date::text AS d FROM issues_page(2026,'高雄市','交通','縣市長',0,30)");
  assertEquals(r, { name: "王小明", position_title: "市長", cand_no: 3, avatar_url: "http://a/1.jpg", party: "國民黨", category: "其他", d: "2026-06-01" });
  const [m] = await q(db, "SELECT party FROM issues_page(2026,'高雄市','交通','議員',0,30) WHERE name = '李大華' LIMIT 1");
  assertEquals(m.party, "無黨籍", "沒有 party_id 退回人物的黨籍文字");
});

// ---- 4. 只新增唯讀函式與索引 ----
Deno.test("migration 只新增函式與索引：不寫資料、不改表", () => {
  const code = MIG.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  assertFalse(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s|ALTER\s+TABLE)\b/i.test(code));
  assertFalse(/SECURITY\s+DEFINER/i.test(code), "照 repo 慣例用 SECURITY INVOKER（預設）");
  assertEquals((code.match(/CREATE INDEX/g) ?? []).length, (code.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length, "索引一律 IF NOT EXISTS");
  for (const fn of ["issues_summary", "issues_page"]) {
    const body = code.slice(code.indexOf(`FUNCTION ${fn}(`));
    const head = body.slice(0, body.indexOf("$$;"));
    assert(/STABLE/.test(head) && /SET statement_timeout = '5s'/.test(head), `${fn} 要 STABLE 且內建 5 秒逾時`);
  }
  assert(/GRANT EXECUTE ON FUNCTION issues_summary\(integer, text\) TO anon/.test(code));
  assert(/GRANT EXECUTE ON FUNCTION issues_page\(integer, text, text, text, integer, integer\) TO anon/.test(code));
});

Deno.test("migration 可重跑（CREATE OR REPLACE／IF NOT EXISTS）", async () => {
  const db = await build();
  await db.exec(MIG);
  assertEquals((await summary(db)).length, 3);
});

// ---- 5. 還原驗證：改壞一處，對應守門必須紅 ----
Deno.test("還原驗證：拿掉 removed_at 過濾 → 範圍測試紅", async () => {
  const db = await build(mutate(MIG, "     AND p.removed_at IS NULL\n", "\n"));
  const by = Object.fromEntries((await summary(db)).map((r) => [r.issue as string, r.total]));
  assert(by["交通"] !== 6, "移除的政見混進來，總數應不再是 6");
});

Deno.test("還原驗證：拿掉競選承諾過濾 → 範圍測試紅", async () => {
  const db = await build(mutate(MIG, "     AND p.status = 'Campaign Pledge'\n", "\n"));
  const by = Object.fromEntries((await summary(db)).map((r) => [r.issue as string, r.total]));
  assert(by["交通"] !== 6);
});

Deno.test("還原驗證：脈絡不再串在一起（排序只看時間）→ 順序測試紅", async () => {
  const db = await build(mutate(MIG, "COALESCE(s.lineage_id, s.policy_id)) AS cluster_date", "s.policy_id) AS cluster_date"));
  assert(JSON.stringify(idsOf(await page(db, "交通", null))) !== JSON.stringify([101, 104, 102, 103, 105, 107]));
});

Deno.test("還原驗證：層級順序顛倒 → 順序測試紅", async () => {
  const db = await build(mutate(MIG, "ORDER BY level_rank, cluster_date DESC NULLS LAST, cluster_key, proposed_date DESC NULLS LAST, policy_id\n     OFFSET", "ORDER BY level_rank DESC, cluster_date DESC NULLS LAST, cluster_key, proposed_date DESC NULLS LAST, policy_id\n     OFFSET"));
  assert(JSON.stringify(idsOf(await page(db, "交通", null, 0, 2))) !== JSON.stringify([101, 104]), "第一頁應從縣市長開始");
});

Deno.test("還原驗證：不濾候選人名／鄉鎮名 → 教育文化那筆會冒出垃圾議題", async () => {
  const db = await build(mutate(MIG, "      OR t.v = ANY (COALESCE(p_names, '{}'::text[]))\n", "\n"));
  const issues = (await summary(db)).map((r) => r.issue as string);
  assert(issues.includes("鳳山") || issues.includes("陳里長"));
});
