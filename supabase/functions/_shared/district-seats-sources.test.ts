/**
 * 應選名額任務補不上的修法（#344，migration 20261009090000_district_seats_official_sources.sql，協議 1.83.0）的守門。
 *
 * 10-08 唯讀查正式庫：議員 2022 年 160 區、2026 年 150 區的名額全空；派工臂 district_seats_missing 10-06 派 78 件，
 * 領走一輪後 34 件交件（0 票）、12 筆回 not_found、33 件沒回報。原因是「來源沒附、提示誤導、提示鼓勵交不完整」，不是冷卻。
 * 修法只加來源與提示：不寫任何名額、不新增投票路徑、不改計分（要代理交件＋同儕驗證，「資料走流程」）。
 *
 *   A. 文字層（只要 --allow-read）
 *      1. 這支是臂本體的最後一版、緊接 20261005004900；只重定義這一支臂；不寫任何正式資料（INSERT 只進 verification_sources）
 *      2. 臂的新定義＝前一版加三處機械替換（條件、task_id、target、reward、region 一字不動）
 *      3. 來源列：2026 年議員 22 縣市、鄉鎮市民代表 13 縣、原住民區 4 直轄市都有；2022 年議員一列；provides 只有 seats（不被名冊類任務撿走）；
 *         網址是 web.cec.gov.tw 的 PDF 或頁面；election_ids 標得出屆別
 *      4. TS 端三處（SOURCE_TASK_TYPES、驗證項的來源查詢、屆別比對）；協議 1.83.0 與 skill.md 說明；任務提示不再說「公報寫著應選名額」
 *   B. PGlite 行為層：舊定義與新定義在同一份合成資料上逐件比；跑完整支 migration 後來源怎麼被篩出來（含 2022 與 2026 不混）
 *   C. 每條守門都做還原驗證：把 migration／TS 改壞一處（精確改一處，改不到就失敗），對應的守門必須紅
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, mutate, readMig } from "./arms-pglite.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { fetchTaskContext, shapeTaskCurrent, SOURCE_TASK_TYPES } from "./task-context.ts";
import { TASK_GUIDANCE } from "./task-guidance.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import {
  needsForTask,
  resetVerificationSourcesCache,
  sourceMatches,
  sourcesForTask,
  verifySourceQuery,
  type VerificationSource,
} from "./verification-sources.ts";

const MIG = "20261009090000_district_seats_official_sources.sql";
const PREV = "20261005004900_district_seats.sql";
const TABLE_MIG = "20260928000001_verification_sources.sql";
const FN = "contribution_auto_tasks_district_seats";
const MIG_SQL = await readMig(MIG);
const PREV_SQL = await readMig(PREV);
const OLD_FN = fnText(PREV_SQL, FN);
const NEW_FN = fnText(MIG_SQL, FN);

/** 機械式替換（migration 與守門各寫一遍：守門把「前一版」套同樣的替換，必須等於 migration 的新定義） */
const R1_FROM = "           || '請找這一屆的選舉公告（應選名額表；已投票的屆別，選舉公報每個選舉區的開頭也寫著應選名額），'\n";
const R2_FROM = "           || '原住民選舉區加 kind（indigenous_plain 或 indigenous_mountain）。名額只能照公告抄，不要用候選人數或當選人數推。'\n";
const R3_FROM = "         CASE WHEN w.election_date < CURRENT_DATE\n              THEN ARRAY['https://eebulletin.cec.gov.tw/ ← ";
const mechanical = (old: string): string => {
  let s = mutate(old, R1_FROM,
    "           || '請找這一屆的選舉公告（附各選舉區應選名額表的 PDF；網址在 current.verification_sources 與 hint_sources，先看那幾個。'\n" +
    "           || '選舉公報不一定印應選名額，鄉鎮市民代表的公報大多沒有，別在公報裡找半天），'\n");
  s = mutate(s, R2_FROM, R2_FROM +
    "           || '公告上這個縣市有幾個選舉區就交幾個（含原住民選舉區），不要只填 target.known_districts——那只是我們目前知道的，常比公告少；'\n" +
    "           || '交件前把你列的名額加總，對一下公告上這個縣市的名額總額。'\n");
  // hint_sources 整塊（從 CASE 到 END,）換成新的
  const a = s.indexOf("         CASE WHEN w.election_date < CURRENT_DATE\n");
  assert(a >= 0 && s.indexOf(R3_FROM) === a, "hint_sources 區塊要在原位");
  const b = s.indexOf("         END,\n", a) + "         END,\n".length;
  return s.slice(0, a) + HINT_BLOCK + s.slice(b);
};
const HINT_BLOCK = `         CASE WHEN w.election_date < CURRENT_DATE
              THEN ARRAY['current.verification_sources ← 這一屆這個縣市的選舉公告網址已經附在任務裡，先看那幾個（PDF 在 web.cec.gov.tw/api/file/<編號>.pdf）',
                         'https://web.cec.gov.tw/central/article/list/145 ← 中選會最新消息：標題「公告…選舉之選舉種類、名額、選舉區之劃分、投票日期…」的那一則就是選舉公告，附件 PDF 有各選舉區應選名額表',
                         'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：看得到有哪些選舉區（含原住民選舉區），但當選人數不是名額']
              ELSE ARRAY['current.verification_sources ← 這一屆這個縣市的選舉公告網址已經附在任務裡，先看那幾個（PDF 在 web.cec.gov.tw/api/file/<編號>.pdf）',
                         'https://web.cec.gov.tw/central/article/list/145 ← 中選會最新消息：議員的選舉公告由中選會發布；鄉鎮市民代表、區民代表的由各縣市選委會發布，中選會同一天有一則索引（標題「…鄉(鎮、市)民代表…之選舉公告」），點進你的縣市',
                         '該縣市選舉委員會官網的「選舉公告」（附各選舉區應選名額表；列表頁常回 500，從中選會那則索引進去比較穩）']
         END,
`;

const codeOf = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const COUNCIL_COUNTIES = ["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市", "基隆市", "新竹市", "嘉義市", "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "台東縣", "澎湖縣", "金門縣", "連江縣"];
const REP_COUNTIES = ["新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "台東縣", "澎湖縣", "金門縣", "連江縣"];
const IND_COUNTIES = ["新北市", "桃園市", "台中市", "高雄市"];

// ============================================================
// A. 文字層（每條守門寫成「吃 migration 文字」的函式，C 組拿改壞的文字餵進去）
// ============================================================
const SEATS_GUARDS: Record<string, (sql: string) => void> = {
  /** 只重定義這一支臂；不碰別的函式、不刪不改別人的東西、不寫任何正式資料（INSERT 只進 verification_sources） */
  scope(sql) {
    const code = codeOf(sql).replace(/'(?:[^']|'')*'/g, "''");
    const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?([a-z_]+)\(/g)].map((m) => m[1]);
    assertEquals(defined, [FN], "這支只重定義 district_seats 臂");
    assert(!/DROP FUNCTION|DROP COLUMN|DROP TABLE|DROP VIEW|TRUNCATE|DELETE FROM/i.test(code), "只加不刪");
    const writes = [...code.matchAll(/(?:INSERT INTO|UPDATE|ALTER TABLE)\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
    assertEquals([...new Set(writes)], ["verification_sources"], "只動查證來源這張表（來源清單與 election_ids 欄）");
    assert(!/election_districts\s+SET|INSERT INTO election_districts/i.test(code), "不用 migration 寫名額（資料走流程）");
  },
  /** 新定義＝前一版＋三處機械替換 */
  mechanical(sql) {
    assertEquals(fnText(sql, FN), mechanical(OLD_FN));
  },
  /** 條件與輸出欄位沒動：want／have／queued、task_id、target、reward、region 逐字還在 */
  untouched(sql) {
    const fn = fnText(sql, FN);
    for (const must of [
      "'auto:district_seats_missing:' || w.election_id || ':' || w.county || ':' || w.election_type",
      "WHERE (h.districts IS NULL OR h.with_seats < h.districts)",
      "c.contribution_type = 'district_seats' AND c.status IN ('pending', 'verified')",
      "'known_districts', COALESCE(h.known, '[]'::jsonb)",
      "         2, w.county\n",
      "不要用候選人數或當選人數推",
    ]) assertStringIncludes(fn, must);
  },
  /** 提示：不再說公報寫著應選名額、指到 verification_sources、要求交完整 */
  wording(sql) {
    const fn = fnText(sql, FN);
    assert(!fn.includes("選舉公報每個選舉區的開頭也寫著應選名額"), "不能再說公報開頭寫著應選名額");
    assert(!fn.includes("https://eebulletin.cec.gov.tw/ ← 中選會選舉公報"), "hint_sources 不再把公報當第一來源");
    assertStringIncludes(fn, "current.verification_sources");
    assertStringIncludes(fn, "不要只填 target.known_districts");
    assertStringIncludes(fn, "名額加總");
  },
  /** 來源列：每個地方都有、provides 只有 seats、election_ids 標屆別、網址在 web.cec.gov.tw */
  rows(sql) {
    const rows = parseSourceRows(sql);
    assert(rows.length >= 20, `來源列太少：${rows.length}`);
    const names = rows.map((r) => r.name);
    assertEquals(new Set(names).size, names.length, "名稱 UNIQUE");
    for (const r of rows) {
      assertEquals(r.provides, ["seats"], `${r.name}：provides 只能是 seats（名冊類任務與預設那組不能撿到）`);
      assert(r.election_ids.length === 1 && [2022, 2026].includes(r.election_ids[0]), `${r.name}：election_ids 要標屆別`);
      assert(/^https:\/\/web\.cec\.gov\.tw\/(api\/file\/[0-9a-f-]{36}\.pdf|central\/article\/\d+)$/.test(r.list_url), `${r.name}：網址要是 web.cec.gov.tw 的檔案或中選會文章頁：${r.list_url}`);
      assert(["pdf", "html"].includes(r.access), r.name);
      assertEquals(r.kind, "cec");
    }
    const regionsOf = (year: number, type: string) => new Set(rows.filter((r) => r.election_ids[0] === year && r.election_types.includes(type)).flatMap((r) => r.regions));
    assertEquals(regionsOf(2026, "縣市議員"), new Set(COUNCIL_COUNTIES), "2026 年議員 22 縣市都要有來源");
    assertEquals(regionsOf(2022, "縣市議員"), new Set(COUNCIL_COUNTIES), "2022 年議員 22 縣市都要有來源");
    assertEquals(regionsOf(2026, "鄉鎮市民代表"), new Set(REP_COUNTIES), "2026 年鄉鎮市民代表 13 縣都要有來源");
    assertEquals(regionsOf(2026, "直轄市山地原住民區民代表"), new Set(IND_COUNTIES), "2026 年原住民區民代表 4 直轄市都要有來源");
    // 每個縣自己的公告 PDF：13 縣＋4 直轄市各恰好一列（索引頁另算）
    for (const c of REP_COUNTIES) assertEquals(rows.filter((r) => r.election_types.includes("鄉鎮市民代表") && r.regions.length === 1 && r.regions[0] === c && r.access === "pdf").length, 1, `${c}：鄉鎮市民代表的公告 PDF 恰好一列`);
    for (const c of IND_COUNTIES) assertEquals(rows.filter((r) => r.election_types.includes("直轄市山地原住民區民代表") && r.regions.length === 1 && r.regions[0] === c && r.access === "pdf").length, 1, `${c}：區民代表的公告 PDF 恰好一列`);
    // 彙總表兩份加起來剛好是議員全部縣市（六都＋其餘 16），不重疊
    const summaries = rows.filter((r) => r.name.includes("登記情形彙總表"));
    assertEquals(summaries.length, 2);
    assertEquals(new Set(summaries.flatMap((r) => r.regions)).size, 22);
    assertEquals(summaries.flatMap((r) => r.regions).length, 22);
  },
};

type SrcRow = { name: string; kind: string; regions: string[]; election_types: string[]; election_ids: number[]; provides: string[]; list_url: string; access: string };
/** 從 migration 的 INSERT 解出每一列（欄位順序：name, kind, party, regions, election_types, election_ids, provides, list_url, detail_url_pattern, access, …） */
function parseSourceRows(sql: string): SrcRow[] {
  const a = sql.indexOf("INSERT INTO verification_sources");
  const b = sql.indexOf("ON CONFLICT (name) DO NOTHING", a);
  assert(a >= 0 && b > a, "找不到來源的 INSERT");
  const body = sql.slice(a, b);
  const arr = (s: string) => [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const out: SrcRow[] = [];
  const re = /\n  \(\n    '((?:[^']|'')*)', '([a-z]+)', NULL,\n    ARRAY\[([^\]]*)\],\n    ARRAY\[([^\]]*)\],\n    ARRAY\[([^\]]*)\],\n    ARRAY\[([^\]]*)\],\n    '([^']*)', NULL, '([a-z]+)',/g;
  for (const m of body.matchAll(re)) {
    out.push({ name: m[1], kind: m[2], regions: arr(m[3]), election_types: arr(m[4]), election_ids: m[5].split(",").map((x) => Number(x.trim())), provides: arr(m[6]), list_url: m[7], access: m[8] });
  }
  const opens = (body.match(/\n  \(\n    '/g) ?? []).length;
  assertEquals(out.length, opens, "每一列都要解得出來（欄位順序變了守門會報）");
  return out;
}

Deno.test("A1 範圍：只重定義 district_seats 臂、只動查證來源這張表；是這支臂的最後一版，緊接 20261005004900", async () => {
  SEATS_GUARDS.scope(MIG_SQL);
  const definers: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${FN}(`)) definers.push(n);
  const i = definers.indexOf(MIG);
  assert(i > 0, "這支要在重新定義臂的清單裡");
  assertEquals(definers[i - 1], PREV, "前一版應該是 20261005004900；有人在中間改了，要以那一版為底重做機械替換");
  assertEquals(definers.slice(i + 1), [], "這支之後又有人重新定義臂：要以最新那版為底重做");
});

Deno.test("A2 臂的新定義＝前一版的現行定義＋三處機械替換；條件與輸出欄位一字不動", () => {
  SEATS_GUARDS.mechanical(MIG_SQL);
  SEATS_GUARDS.untouched(MIG_SQL);
});

Deno.test("A3 任務提示：不再說公報寫著應選名額、指向 current.verification_sources、要求公告有幾區交幾區", () => {
  SEATS_GUARDS.wording(MIG_SQL);
  // TS 的任務說明（給代理看的 hint）與驗證項的 hint 同一個方向
  assertStringIncludes(TASK_GUIDANCE.district_seats_missing, "current.verification_sources");
  assertStringIncludes(TASK_GUIDANCE.district_seats_missing, "不要只填 known_districts");
  assert(!TASK_GUIDANCE.district_seats_missing.includes("選舉公報每個選舉區的開頭也寫著應選名額"));
  assertStringIncludes(TASK_GUIDANCE.district_seats_missing, "不要用候選人數或當選人數推");
});

Deno.test("A4 來源列：2026 議員 22 縣市、鄉鎮市民代表 13 縣、區民代表 4 直轄市、2022 議員 22 縣市；provides 只有 seats；election_ids 標屆別", () => {
  SEATS_GUARDS.rows(MIG_SQL);
});

Deno.test("A5 TS 端：任務型別在 SOURCE_TASK_TYPES、需求是 seats、驗證項的來源查詢、屆別比對、標籤與 /sources 頁", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url)).then((t) => t.replace(/\r\n/g, "\n"));
  const ctx = await read("./task-context.ts");
  const vs = await read("./verification-sources.ts");
  assert(SOURCE_TASK_TYPES.has("district_seats_missing"));
  assertStringIncludes(ctx.slice(ctx.indexOf("export const SOURCE_TASK_TYPES")), '"district_seats_missing"');
  assertStringIncludes(ctx, "sourcesForTask(all, { party, region, electionType, electionId, need: needsForTask(taskType) })");
  assertEquals(needsForTask("district_seats_missing"), ["seats"]);
  assertStringIncludes(vs, "&& electionIdMatches(source.election_ids, q.electionId)");
  assertStringIncludes(vs, 'if (contributionType === "district_seats")');
  const page = await read("../../../pages/Sources.vue");
  assertStringIncludes(page, "seats: '應選名額'");
  const endpoint = await read("../sources/index.ts");
  assertStringIncludes(endpoint, 'url.searchParams.get("election_id")');
});

Deno.test("A6 協議：1.83.0（#489 的 1.82.0 先合併）、skill.md 檔頭檔尾與程式一致、說明公告網址已附在任務裡與驗證要核對選舉區數量", async () => {
  assertEquals(PROTOCOL_VERSION, "1.83.0");
  const skill = (await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url))).replace(/\r\n/g, "\n");
  assertStringIncludes(skill, "**版本**：1.83.0");
  assertStringIncludes(skill, "*協議版本 1.83.0");
  const i = skill.indexOf("### 補應選名額");
  const sec = skill.slice(i, skill.indexOf("### 整批補選舉結果"));
  for (const must of ["current.verification_sources", "web.cec.gov.tw", "article 63645", "known_districts` 常比公告少", "選舉區數量與名額加總也要對", "兩區的名額對調"]) assertStringIncludes(sec, must);
  assert(!sec.includes("選舉公報每個選舉區的開頭也寫著應選名額"));
});

// ============================================================
// B. PGlite 行為層
// ============================================================
const BASE_DDL = (tableDdl: string) => `
CREATE TABLE elections (id integer PRIMARY KEY, election_date date, election_types text[]);
CREATE TABLE admin_divisions (level text, county text);
CREATE TABLE election_districts (id serial PRIMARY KEY, election_id integer, election_type text, region text, sub_region text, district_kind text, seats integer);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb);
${tableDdl}
`;
const ALL_TYPES = ["縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長"];
const SEED = `
INSERT INTO elections VALUES (2022, '2022-11-26', ARRAY[${ALL_TYPES.map((t) => `'${t}'`).join(",")}]), (2026, '2099-11-28', ARRAY[${ALL_TYPES.map((t) => `'${t}'`).join(",")}]);
INSERT INTO admin_divisions VALUES ('county', '臺北市'), ('county', '屏東縣'), ('county', '臺東縣'), ('county', '新北市'), ('county', '台中市'), ('city', '某市');
-- 鄉鎮市長選舉區（鄉鎮市民代表的「縣」從這裡來）、原住民區長選舉區
INSERT INTO election_districts (election_id, election_type, region, sub_region, district_kind, seats) VALUES
  (2022, '鄉鎮市長', '屏東縣', '屏東市', 'at_large', 1), (2026, '鄉鎮市長', '屏東縣', '屏東市', 'at_large', 1),
  (2022, '鄉鎮市長', '台東縣', '台東市', 'at_large', 1), (2026, '鄉鎮市長', '台東縣', '台東市', 'at_large', 1),
  (2022, '直轄市山地原住民區長', '新北市', '烏來區', 'at_large', 1), (2026, '直轄市山地原住民區長', '新北市', '烏來區', 'at_large', 1),
  -- 議員：台北市 2026 有兩區沒名額、台中市 2026 已經有名額（不派）、屏東縣 2026 一個選舉區列都沒有（派）
  (2026, '縣市議員', '台北市', '第01選舉區', 'district', NULL), (2026, '縣市議員', '台北市', '第02選舉區', 'district', NULL),
  (2026, '縣市議員', '台中市', '第01選舉區', 'district', 5),
  (2022, '縣市議員', '台北市', '第01選舉區', 'district', NULL);
-- 台東縣 2026 鄉鎮市民代表已經有人交了、還在等票：不再派
INSERT INTO contributions (contribution_type, status, payload) VALUES
  ('district_seats', 'pending', '{"election_id": 2026, "election_type": "鄉鎮市民代表", "region": "台東縣"}'),
  ('district_seats', 'rejected', '{"election_id": 2026, "election_type": "鄉鎮市民代表", "region": "屏東縣"}');
`;

type Out = { task_id: string; task_type: string; target: unknown; reward: number; region: string; what_we_need: string; hint_sources: string[] };
const readOut = async (db: PGlite): Promise<Out[]> => (await db.query<Out>(`SELECT task_id, task_type, target, reward, region, what_we_need, hint_sources FROM ${FN}() ORDER BY task_id COLLATE "C"`)).rows;

async function buildDb(migSql: string = MIG_SQL): Promise<{ db: PGlite; before: Out[]; after: Out[] }> {
  const tableMig = await readMig(TABLE_MIG);
  const ddl = tableMig.slice(tableMig.indexOf("CREATE TABLE IF NOT EXISTS verification_sources"), tableMig.indexOf("COMMENT ON TABLE verification_sources"));
  const db = new PGlite();
  await db.exec(BASE_DDL(ddl));
  await db.exec(SEED);
  await db.exec(OLD_FN);
  const before = await readOut(db);
  await db.exec(migSql);
  const after = await readOut(db);
  return { db, before, after };
}

/** 舊定義與新定義逐件比：任務本體一件不差、說明與提示要換字、條件行為不變（還原驗證 C14 拿「又換回舊定義」餵進來，必須紅） */
function parityCheck(before: Out[], after: Out[]): void {
  // 預期的任務：議員 2 屆×5 縣市（台中 2026 已有名額不派）9 件、鄉鎮市民代表 3 件（台東縣 2026 有人交了在等票不派）、區民代表 2 件
  assertEquals(before.length, 14);
  assertEquals(after.map((r) => r.task_id), before.map((r) => r.task_id));
  for (let i = 0; i < before.length; i++) {
    const [b, a] = [before[i], after[i]];
    assertEquals([a.task_type, a.target, a.reward, a.region], [b.task_type, b.target, b.reward, b.region], `${a.task_id}：任務本體不能變`);
    assert(a.what_we_need !== b.what_we_need && a.hint_sources.join("|") !== b.hint_sources.join("|"), `${a.task_id}：說明與提示要換字`);
  }
  const ids = new Set(after.map((r) => r.task_id));
  assert(!ids.has("auto:district_seats_missing:2026:台中市:縣市議員"));
  assert(!ids.has("auto:district_seats_missing:2026:台東縣:鄉鎮市民代表"));
  assert(ids.has("auto:district_seats_missing:2026:屏東縣:鄉鎮市民代表"));
  assert(ids.has("auto:district_seats_missing:2022:台東縣:鄉鎮市民代表"));
}

Deno.test("B1 行為層：同一份資料上舊定義與新定義逐件比——任務、target、reward、region 一件不差，只有 what_we_need 與 hint_sources 換字", async () => {
  const { before, after } = await buildDb();
  parityCheck(before, after);
});

Deno.test("B2 行為層：新提示的文字——沒有「公報寫著應選名額」、有 current.verification_sources、要求公告有幾區交幾區；已投票與未投票的屆別提示不同", async () => {
  const { after } = await buildDb();
  for (const r of after) {
    assertStringIncludes(r.what_we_need, "current.verification_sources");
    assertStringIncludes(r.what_we_need, "不要只填 target.known_districts");
    assertStringIncludes(r.what_we_need, "不要用候選人數或當選人數推");
    assert(!r.what_we_need.includes("選舉公報每個選舉區的開頭也寫著應選名額"));
    assertEquals(r.hint_sources.length, 3);
    assertStringIncludes(r.hint_sources[0], "current.verification_sources");
    assertStringIncludes(r.hint_sources[1], "https://web.cec.gov.tw/central/article/list/145");
  }
  const past = after.find((r) => r.task_id === "auto:district_seats_missing:2022:台北市:縣市議員")!;
  const upcoming = after.find((r) => r.task_id === "auto:district_seats_missing:2026:台北市:縣市議員")!;
  assertStringIncludes(past.hint_sources[2], "db.cec.gov.tw");
  assertStringIncludes(upcoming.hint_sources[2], "選舉委員會官網");
});

async function sourceRows(db: PGlite): Promise<VerificationSource[]> {
  return (await db.query<VerificationSource>(`SELECT id, name, kind, party, regions, election_types, election_ids, provides, list_url, detail_url_pattern, access, quality_note, how_to, last_checked::text AS last_checked, status, sort FROM verification_sources ORDER BY sort, id`)).rows;
}

/** 跑完 migration 後各任務拿到的來源（還原驗證 C13 拿改壞的 migration 餵進來，必須紅） */
async function selectionCheck(db: PGlite): Promise<void> {
  const all = await sourceRows(db);
  const q = (region: string, electionType: string, electionId: number, need: readonly string[] = ["seats"]) => sourcesForTask(all, { region, electionType, electionId, need });
  const names = (hs: { name: string }[]) => hs.map((h) => h.name);
  // 2026 年台北市議員：選舉公告＋直轄市議員彙總表（不是縣市議員那份）
  const tp = names(q("台北市", "縣市議員", 2026));
  assertEquals(tp.length, 2);
  assert(tp[0].includes("2026 直轄市議員、縣市議員選舉公告") && tp[1].includes("直轄市議員政黨推薦候選人登記情形彙總表"), tp.join("、"));
  // 2026 年屏東縣議員：選舉公告＋縣市議員彙總表
  const pt = names(q("屏東縣", "縣市議員", 2026));
  assert(pt.some((n) => n.includes("縣市議員政黨推薦候選人登記情形彙總表")) && !pt.some((n) => n.includes("直轄市議員政黨")));
  // 2022 年台北市議員：只有 2022 的公告，不附 2026 的任何一份
  const tp22 = names(q("台北市", "縣市議員", 2022));
  assertEquals(tp22, ["中選會 2022 直轄市議員、縣市議員選舉公告（應選名額表）"]);
  // 2026 年屏東縣鄉鎮市民代表：屏東縣自己的公告＋中選會索引頁；別縣的不附
  const rep = names(q("屏東縣", "鄉鎮市民代表", 2026));
  assertEquals(rep.length, 2);
  assert(rep[0].startsWith("中選會 2026 鄉鎮市長、鄉鎮市民代表、村里長選舉公告索引") || rep[0].startsWith("屏東縣選委會"), rep.join("、"));
  assert(rep.some((n) => n.startsWith("屏東縣選委會")) && rep.some((n) => n.includes("索引")));
  // 2022 年的鄉鎮市民代表：沒登錄就沒有（不拿 2026 的充數）
  assertEquals(q("屏東縣", "鄉鎮市民代表", 2022), []);
  // 原住民區民代表：新北市烏來區
  const ind = names(q("新北市", "直轄市山地原住民區民代表", 2026));
  assert(ind.some((n) => n.startsWith("新北市選委會")) && ind.some((n) => n.includes("山地原住民區長、區民代表選舉公告索引")), ind.join("、"));
  // 沒給屆別時（例如舊的呼叫端）不篩屆別，但 provides＝seats 仍擋住名冊類任務
  for (const need of [["candidacy", "district", "roster"], ["candidacy", "district"], ["photo", "education", "experience", "district", "policy"], ["birth_year", "candidacy"]]) {
    assertEquals(sourcesForTask(all, { region: "屏東縣", electionType: "縣市議員", electionId: 2026, need }).filter((s) => s.provides.includes("seats")), [], `need=${need}`);
  }
  assert(sourcesForTask(all, { region: "屏東縣", electionType: "鄉鎮市民代表", need: ["seats"] }).length >= 2, "沒給屆別＝不篩屆別");
  // 驗證項：district_seats 交件帶 election_id（整數），查詢與任務同一組條件
  const vq = verifySourceQuery("district_seats", { election_id: 2022, election_type: "縣市議員", region: "台北市" })!;
  assertEquals(names(sourcesForTask(all, vq)), tp22);
  assertEquals(verifySourceQuery("district_seats", { election_id: "2022", election_type: "縣市議員", region: "台北市" })!.electionId, null, "election_id 不是整數就不篩屆別");
  // 重跑 migration 不重複（ON CONFLICT (name)）
  const n = all.length;
  await db.exec(MIG_SQL);
  assertEquals((await sourceRows(db)).length, n);
}

Deno.test("B3 行為層：跑完 migration 後，各任務拿到的來源——屆別不混、縣市對得上、名冊類任務不被撿到", async () => {
  const { db } = await buildDb();
  await selectionCheck(db);
});

Deno.test("B4 端到端：fetchTaskContext 對 district_seats_missing 附上來源、shapeTaskCurrent 帶進 current；2022 與 2026 的任務拿到不同的來源", async () => {
  const { db } = await buildDb();
  const rows = await sourceRows(db);
  const run = async (target: Record<string, unknown>) => {
    resetVerificationSourcesCache();
    const { client } = createFakeSupabase({ verification_sources: rows as unknown as Record<string, unknown>[] });
    const data = await fetchTaskContext(client, "district_seats_missing", target);
    return { data, current: shapeTaskCurrent("district_seats_missing", data) as Record<string, unknown> };
  };
  const t26 = await run({ election_id: 2026, election_type: "縣市議員", region: "台北市" });
  assertEquals((t26.current.verification_sources as Array<{ name: string }>).map((s) => s.name).length, 2);
  const t22 = await run({ election_id: 2022, election_type: "縣市議員", region: "台北市" });
  assertEquals((t22.current.verification_sources as Array<{ name: string; url: string }>).map((s) => s.url), ["https://web.cec.gov.tw/api/file/72529fa8-25c6-4260-bcbc-7de268017766.pdf"]);
  const rep = await run({ election_id: 2026, election_type: "鄉鎮市民代表", region: "台東縣" });
  assert((rep.current.verification_sources as Array<{ name: string }>).some((s) => s.name.startsWith("台東縣選委會")));
  // 屆別是字串（舊的呼叫端、手寫 target）：不篩屆別，不會炸
  const loose = await run({ election_id: "2026", election_type: "縣市議員", region: "台北市" });
  assert((loose.current.verification_sources as unknown[]).length >= 2);
});

Deno.test("B5 sourceMatches 屆別：來源沒填 election_ids＝每一屆；有填要包含；query 沒給屆別不篩", () => {
  const base: VerificationSource = { id: 1, name: "x", kind: "cec", party: null, regions: null, election_types: null, provides: ["seats"], list_url: null, detail_url_pattern: null, access: "pdf", quality_note: null, how_to: null, last_checked: null, status: "ok", sort: 1 };
  assert(sourceMatches(base, { electionId: 2026 }));
  assert(sourceMatches({ ...base, election_ids: null }, { electionId: 2026 }));
  assert(sourceMatches({ ...base, election_ids: [] }, { electionId: 2026 }));
  assert(sourceMatches({ ...base, election_ids: [2026] }, { electionId: 2026 }));
  assert(!sourceMatches({ ...base, election_ids: [2026] }, { electionId: 2022 }));
  assert(sourceMatches({ ...base, election_ids: [2026] }, {}));
  assert(sourceMatches({ ...base, election_ids: [2026] }, { electionId: null }));
});

// ============================================================
// C. 還原驗證：把 migration／TS 改壞一處，對應的守門必須紅
// ============================================================
const throws = (fn: () => void): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const MIG_MUTATIONS: Array<{ why: string; guard: keyof typeof SEATS_GUARDS; mutate: (s: string) => string }> = [
  { why: "把「公報也寫著應選名額」那句放回去（提示誤導），wording 與 mechanical 要紅", guard: "wording", mutate: (s) => mutate(s, "選舉公報不一定印應選名額，鄉鎮市民代表的公報大多沒有，別在公報裡找半天），", "選舉公報每個選舉區的開頭也寫著應選名額），") },
  { why: "拿掉「別只填 known_districts」那句，wording 要紅", guard: "wording", mutate: (s) => mutate(s, "不要只填 target.known_districts——那只是我們目前知道的，常比公告少；", "") },
  { why: "派工條件被順手改了（< 改成 <=），untouched 與 mechanical 都要紅", guard: "untouched", mutate: (s) => mutate(s, "WHERE (h.districts IS NULL OR h.with_seats < h.districts)", "WHERE (h.districts IS NULL OR h.with_seats <= h.districts)") },
  { why: "派工條件被順手改了，mechanical 要紅", guard: "mechanical", mutate: (s) => mutate(s, "WHERE (h.districts IS NULL OR h.with_seats < h.districts)", "WHERE (h.districts IS NULL OR h.with_seats <= h.districts)") },
  { why: "task_id 的組法被改了，untouched 要紅", guard: "untouched", mutate: (s) => mutate(s, "'auto:district_seats_missing:' || w.election_id || ':' || w.county", "'auto:district_seats_missing:' || w.county || ':' || w.election_id") },
  { why: "順手把 reward 改成 3，mechanical 要紅", guard: "mechanical", mutate: (s) => mutate(s, "         2, w.county\n", "         3, w.county\n") },
  { why: "順手用 migration 寫名額（UPDATE election_districts），scope 要紅", guard: "scope", mutate: (s) => s.replace("NOTIFY pgrst", () => "UPDATE election_districts SET seats = 1 WHERE seats IS NULL;\nNOTIFY pgrst") },
  { why: "順手重定義別的臂，scope 要紅", guard: "scope", mutate: (s) => s.replace("NOTIFY pgrst", () => "CREATE OR REPLACE FUNCTION contribution_auto_tasks_region_gap() RETURNS TABLE(x int) LANGUAGE sql AS $$ SELECT 1 $$;\nNOTIFY pgrst") },
  { why: "有一列來源 provides 多了 district（會被名冊類與預設任務撿走），rows 要紅", guard: "rows", mutate: (s) => mutate(s, "    ARRAY[2022],\n    ARRAY['seats'],", "    ARRAY[2022],\n    ARRAY['seats', 'district'],") },
  { why: "2022 的那列忘了標屆別（election_ids 寫成 2026），rows 要紅（2022 的議員縣市沒有來源）", guard: "rows", mutate: (s) => mutate(s, "    ARRAY[2022],\n    ARRAY['seats'],", "    ARRAY[2026],\n    ARRAY['seats'],") },
  { why: "宜蘭縣的鄉鎮市民代表公告被刪掉，rows 要紅", guard: "rows", mutate: (s) => mutate(s, "ARRAY['宜蘭縣'],\n    ARRAY['鄉鎮市民代表'],", "ARRAY['宜蘭縣'],\n    ARRAY['村里長'],") },
  { why: "網址換成別的網站，rows 要紅", guard: "rows", mutate: (s) => mutate(s, "https://web.cec.gov.tw/api/file/715772a7-6820-4bdb-8a57-36e5e6fd13a3.pdf", "https://example.com/715772a7-6820-4bdb-8a57-36e5e6fd13a3.pdf") },
];
MIG_MUTATIONS.forEach((m, i) => {
  Deno.test(`C${i + 1} 還原驗證（migration）：${m.why}`, () => {
    SEATS_GUARDS[m.guard](MIG_SQL); // 沒改壞的先過
    const bad = m.mutate(MIG_SQL);
    assert(bad !== MIG_SQL, "要真的改到");
    assert(throws(() => SEATS_GUARDS[m.guard](bad)), `改壞之後 ${m.guard} 守門必須紅`);
  });
});

Deno.test("C13 還原驗證（行為層）：2022 那列的 election_ids 寫成 2026，B3 的來源篩選要紅（先確認沒改壞時是綠的）", async () => {
  const good = await buildDb();
  await selectionCheck(good.db);
  const bad = mutate(MIG_SQL, "    ARRAY[2022],\n    ARRAY['seats'],", "    ARRAY[2026],\n    ARRAY['seats'],");
  const { db } = await buildDb(bad);
  let red = false;
  try {
    await selectionCheck(db);
  } catch {
    red = true;
  }
  assert(red, "改壞之後 B3 必須紅");
});

Deno.test("C14 還原驗證（行為層）：臂換回舊定義（等於沒改提示），B1 的比對要紅", async () => {
  const good = await buildDb();
  parityCheck(good.before, good.after);
  const oldFnInMig = MIG_SQL.replace(NEW_FN, () => OLD_FN);
  assert(oldFnInMig !== MIG_SQL);
  const bad = await buildDb(oldFnInMig);
  assert(throws(() => parityCheck(bad.before, bad.after)), "舊定義放回去，輸出跟改前一樣，B1 必須紅");
});

const TS_MUTATIONS: Array<{ why: string; file: string; mutate: (s: string) => string; check: (s: string) => void }> = [
  {
    why: "SOURCE_TASK_TYPES 拿掉 district_seats_missing（任務又附不到來源）",
    file: "./task-context.ts",
    mutate: (s) => mutate(s, '  // 應選名額（#344，2026-10-09）：沒有人物對象，用 target 的縣市／選舉別／屆別附選舉公告與登記彙總表\n  "district_seats_missing",\n', ""),
    check: (s) => assertStringIncludes(s.slice(s.indexOf("export const SOURCE_TASK_TYPES")), '"district_seats_missing"'),
  },
  {
    why: "任務附來源時不帶屆別（2022 與 2026 的公告混在一起）",
    file: "./task-context.ts",
    mutate: (s) => mutate(s, "sourcesForTask(all, { party, region, electionType, electionId, need: needsForTask(taskType) })", "sourcesForTask(all, { party, region, electionType, need: needsForTask(taskType) })"),
    check: (s) => assertStringIncludes(s, "sourcesForTask(all, { party, region, electionType, electionId, need: needsForTask(taskType) })"),
  },
  {
    why: "sourceMatches 不比屆別",
    file: "./verification-sources.ts",
    mutate: (s) => mutate(s, "    && electionIdMatches(source.election_ids, q.electionId)\n", ""),
    check: (s) => assertStringIncludes(s, "&& electionIdMatches(source.election_ids, q.electionId)"),
  },
  {
    why: "驗證項的來源查詢又回 null（驗證者又什麼來源都看不到）",
    file: "./verification-sources.ts",
    mutate: (s) => mutate(s, 'if (contributionType === "district_seats") {', 'if (contributionType === "district_seats_disabled") {'),
    check: (s) => assertStringIncludes(s, 'if (contributionType === "district_seats") {'),
  },
  {
    why: "任務型別的需求拿掉（又走預設那組，附一堆人物頁來源）",
    file: "./verification-sources.ts",
    mutate: (s) => mutate(s, '  district_seats_missing: ["seats"],\n', ""),
    check: (s) => assertStringIncludes(s, 'district_seats_missing: ["seats"]'),
  },
];
TS_MUTATIONS.forEach((m, i) => {
  Deno.test(`C${MIG_MUTATIONS.length + 3 + i} 還原驗證（TS）：${m.why}`, async () => {
    const src = (await Deno.readTextFile(new URL(m.file, import.meta.url))).replace(/\r\n/g, "\n");
    m.check(src);
    const bad = m.mutate(src);
    assert(bad !== src);
    assert(throws(() => m.check(bad)), "改壞之後守門必須紅");
  });
});
