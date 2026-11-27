/**
 * 議題標籤判定加速守門（migration 20261127170000_issue_tags_fast.sql）。
 *
 * 正式庫 2026-11-27：issue_too_broad 整表函式 7.35 秒，其中 issues_scoped 對約 5 萬筆承諾逐列呼叫 issue_tags_of
 * （約 87 微秒一次）。新版 issues_scoped 先把標籤去重、每個 distinct 標籤只判一次 issue_tag_is_junk，輸出必須逐列不變。
 *
 * 把 20261031130000 的舊本體以 _legacy 名稱裝進同一個 PGlite，再載入新 migration：
 *   A issue_tags_of：邊界 fixture 逐列新舊相同（姓名命中、各條正規表示式、全形半形、空標籤、重複標籤、NULL、多標籤排序、category 退回）
 *   B issue_tag_is_junk：同一批標籤×姓名組合新舊相同（含 p_names 內有 NULL 的三值邏輯）
 *   C issues_scoped：小 fixture 與大量產生的 fixture，新舊結果集逐列相同（雙向 EXCEPT 為空、筆數相同）
 *   D contribution_auto_tasks_issue_too_broad()：整體結果集新舊相同（舊版用 issues_scoped_legacy 的複本）
 *   E 結構守門：issue_tag_is_junk 呼叫次數＝distinct 標籤數（舊版＝逐筆承諾×標籤）；新 issues_scoped 不再逐列呼叫 issue_tags_of
 *   F 遷移文字守門：時間戳、回滾段、每日呼叫量、行為變更、簽名與權限不變
 * 秒數只在 ITB_BENCH=1 時印（本機 PGlite，不當斷言）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText } from "./arms-pglite.ts";

const readMig = async (n: string) => (await Deno.readTextFile(new URL(`../../migrations/${n}`, import.meta.url))).replace(/\r\n/g, "\n");
const ISSUES_MIG = await readMig("20261031130000_issues_summary_page.sql");
const SUBTOPICS_MIG = await readMig("20261102010000_issue_subtopics.sql");
const ITB_PREAGG_MIG = await readMig("20261127160000_itb_preaggregate.sql");
const MIG_NAME ="20261127170000_issue_tags_fast.sql";
const MIG = await readMig(MIG_NAME);
const BENCH = Deno.env.get("ITB_BENCH") === "1";

const SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated;
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politicians (id uuid PRIMARY KEY, name text, avatar_url text, party text);
CREATE TABLE parties (id bigint PRIMARY KEY, name text, short_name text);
CREATE TABLE politician_elections (politician_id uuid, election_id integer, election_type text, position text, cand_no integer, region_id integer, party_id bigint, PRIMARY KEY (politician_id, election_id, election_type, region_id));
CREATE TABLE policies (id uuid PRIMARY KEY, politician_id uuid, election_id integer, title text, category text, status text, proposed_date date, tags text[], lineage_id uuid, removed_at timestamptz);
CREATE TABLE activity_rules (id serial PRIMARY KEY, activity text, params jsonb, enabled boolean DEFAULT true);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb);
`;

const LEGACY_FNS = ["issue_tag_is_junk", "issue_tags_of", "issues_scoped"];
const toLegacy = (sql: string) => sql.replace(/\b(issue_tag_is_junk|issue_tags_of|issues_scoped)\b/g, "$1_legacy");
const LEGACY_SQL = LEGACY_FNS.map((f) => toLegacy(fnText(ISSUES_MIG, f))).join("\n");

/** 議題過廣臂（20261102010000）：新版照原文，_legacy 版改呼叫 issues_scoped_legacy */
const itbText = () => {
  const tblStart = SUBTOPICS_MIG.indexOf("CREATE TABLE IF NOT EXISTS policy_subtopics");
  const tbl = SUBTOPICS_MIG.slice(tblStart, SUBTOPICS_MIG.indexOf(");", tblStart) + 2);
  const fns = ["issue_too_broad_threshold", "issue_too_broad_election", "policy_subtopic_scope", "contribution_auto_tasks_issue_too_broad"]
    .map((f) => fnText(SUBTOPICS_MIG, f));
  return { tbl, base: fns.slice(0, 3), arm: fns[3] };
};
const ITB = itbText();
// 臂函式以 20261127160000（itb_preaggregate，#1079）的版本為底：新版呼叫新 issues_scoped，_legacy 版呼叫 issues_scoped_legacy
ITB.arm = fnText(ITB_PREAGG_MIG, "contribution_auto_tasks_issue_too_broad");
const ITB_LEGACY = ITB.arm
  .replace(/contribution_auto_tasks_issue_too_broad\b/, "contribution_auto_tasks_issue_too_broad_legacy")
  .replace(/\bissues_scoped\b/g, "issues_scoped_legacy");

const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const lit = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

// 邊界 fixture：名字（王小明、李大華）、鄉鎮區名（鳳山區→鳳山）、各條正規表示式、全形空白、空標籤、重複、NULL、排序
const TAG_CASES: Array<{ tags: string[] | null; category: string | null }> = [
  { tags: null, category: "交通建設" },
  { tags: null, category: "其他" },
  { tags: null, category: null },
  { tags: null, category: "　　" },
  { tags: [], category: "社會福利" },
  { tags: ["交通", "交通", "　交通　", " 交通"], category: "其他" },
  { tags: ["長照", "托育", "交通", "環保", "Zebra", "apple"], category: "其他" },
  { tags: ["王小明", "李大華", "鳳山", "鳳山區"], category: "社會福利" },
  { tags: ["王小明", "托育"], category: "社會福利" },
  { tags: ["", " ", "　", "\t", "a"], category: "教育" },
  { tags: ["", null as unknown as string, "交通"], category: "教育" },
  { tags: ["2026", "2024", "20269", "2026市長選舉", "2026 議員"], category: "環保" },
  { tags: ["高雄市長", "高雄市長候選人", "市長選舉", "議員選戰", "立委", "總統候選人"], category: "經濟" },
  { tags: ["RSS 新聞", "中央社", "媒體報導", "官網", "臉書專頁", "Facebook", "粉專", "rss"], category: "其他" },
  { tags: ["高雄", "高雄市", "臺北", "台北市", "臺北市", "新北", "新北市", "桃園縣", "連江", "金門縣"], category: "治安" },
  { tags: ["高雄好棒", "新聞台", "選舉", "政見", "競選承諾", "其他", "未分類", "無", "待補", "民生優先"], category: "其他" },
  { tags: ["Ａ議題", "ＡＢ", "全形　空白", "半形 空白", "交通　"], category: "其他" },
  { tags: ["住宅", "住宅 ", "住宅\n", "住宅\r\n"], category: "房價" },
  { tags: ["b", "a", "c", "B", "A", "ab", "AB", "ａｂ"], category: "其他" },
];
const NAME_SETS: Array<string[] | null> = [null, [], ["王小明", "李大華"], ["王小明", "鳳山", "交通"], ["交通", null as unknown as string]];

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(ISSUES_MIG);
  await db.exec(LEGACY_SQL);
  await db.exec([ITB.tbl, ...ITB.base, ITB.arm, ITB_LEGACY].join("\n"));
  await db.exec(MIG); // 新版覆蓋同名函式
  return db;
}

const arrLit = (a: Array<string | null> | null) => (a === null ? "NULL::text[]" : `ARRAY[${a.map(lit).join(",")}]::text[]`);

type Row = Record<string, unknown>;
const q = async (db: PGlite, sql: string) => (await db.query<Row>(sql)).rows;

// 小 fixture：高雄市 2026（縣市長 1、議員 2、村里長 1、總統不在範圍）＋台北 1 筆；其中一位候選人有兩筆參選紀錄
function seedSmall(): string {
  const pol = TAG_CASES.map((c, i) =>
    `('${u(1000 + i)}','${u(1 + (i % 4))}',2026,'T${i}',${lit(c.category)},'Campaign Pledge','2026-0${1 + (i % 9)}-01',${arrLit(c.tags)},NULL,NULL)`).join(",\n");
  return `
INSERT INTO regions VALUES (1,'高雄市',NULL,NULL),(5,'高雄市','第01選舉區',NULL),(6,'高雄市','鳳山區',NULL),(4,'臺北市',NULL,NULL);
INSERT INTO politicians VALUES ('${u(1)}','王小明',NULL,NULL),('${u(2)}','李大華',NULL,NULL),('${u(3)}','陳村長',NULL,NULL),('${u(4)}','總統人',NULL,NULL),('${u(9)}','北市長',NULL,NULL);
INSERT INTO politician_elections VALUES
 ('${u(1)}',2026,'縣市長','市長',3,1,NULL),
 ('${u(1)}',2026,'縣市議員','議員',9,5,NULL),
 ('${u(2)}',2026,'縣市議員','議員',7,5,NULL),
 ('${u(3)}',2026,'村里長','村里長',1,6,NULL),
 ('${u(4)}',2026,'總統','總統',1,1,NULL),
 ('${u(9)}',2026,'縣市長','市長',1,4,NULL);
INSERT INTO policies (id, politician_id, election_id, title, category, status, proposed_date, tags, lineage_id, removed_at) VALUES
${pol},
 ('${u(2001)}','${u(1)}',2026,'已移除','交通','Campaign Pledge','2026-01-01',ARRAY['交通'],NULL,now()),
 ('${u(2002)}','${u(1)}',2026,'非承諾','交通','Other','2026-01-01',ARRAY['交通'],NULL,NULL),
 ('${u(2003)}','${u(1)}',2025,'別屆','交通','Campaign Pledge','2026-01-01',ARRAY['交通'],NULL,NULL),
 ('${u(2004)}','${u(9)}',2026,'台北','社會福利','Campaign Pledge','2026-06-03',ARRAY['托育','北市長'],NULL,NULL);
`;
}

// 大量 fixture：n 筆承諾，標籤取自 40 種混合池（好標籤、姓名、年份、新聞、縣市、全形空白、空字串）
function seedBulk(n: number, nPol: number): string {
  return `
INSERT INTO regions VALUES (1,'高雄市',NULL,NULL),(5,'高雄市','第01選舉區',NULL),(6,'高雄市','鳳山區',NULL);
INSERT INTO politicians SELECT ('00000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid, 'P' || i, NULL, NULL FROM generate_series(1, ${nPol}) i;
INSERT INTO politician_elections SELECT ('00000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid, 2026,
  (ARRAY['縣市長','縣市議員','村里長','總統'])[1 + (i % 4)], 'x', i, (ARRAY[1,5,6])[1 + (i % 3)], NULL FROM generate_series(1, ${nPol}) i;
INSERT INTO policies (id, politician_id, election_id, title, category, status, proposed_date, tags)
SELECT ('00000000-0000-0000-0002-' || lpad(n::text, 12, '0'))::uuid,
       ('00000000-0000-0000-0001-' || lpad((1 + (n % ${nPol}))::text, 12, '0'))::uuid, 2026, 'T' || n,
       (ARRAY['交通建設','其他','社會福利',NULL,'　'])[1 + (n % 5)], 'Campaign Pledge', DATE '2026-01-01' + (n % 300),
       CASE WHEN n % 17 = 0 THEN NULL ELSE ARRAY(
         SELECT (ARRAY['交通','長照','托育','環保','教育','住宅','治安','P1','P2','P' || (1 + (n % ${nPol})),'2026','2024','高雄市','台北','新聞台','RSS 新聞',
                       '市長選舉','議員','　交通　',' 長照','','a','政見','其他','鳳山','鳳山區','經濟發展','青年就業','老人照顧','水資源','空氣品質','食安','農業',
                       '文化','觀光','體育','公園','停車'])[1 + ((n * 7 + j * 13) % 40)]
           FROM generate_series(1, 1 + (n % 7)) j) END
  FROM generate_series(1, ${n}) n;
`;
}

const ROW_COLS = "policy_id, politician_id, issue, level, level_rank, lineage_id, proposed_date, title, category";
async function assertSameScoped(db: PGlite, region: string) {
  const a = await q(db, `SELECT ${ROW_COLS} FROM issues_scoped(2026, '${region}') ORDER BY policy_id, issue, level_rank`);
  const b = await q(db, `SELECT ${ROW_COLS} FROM issues_scoped_legacy(2026, '${region}') ORDER BY policy_id, issue, level_rank`);
  assertEquals(a.length, b.length, `${region} 筆數相同`);
  assertEquals(JSON.stringify(a), JSON.stringify(b), `${region} 逐列相同`);
  const d1 = await q(db, `SELECT count(*)::int AS n FROM (SELECT ${ROW_COLS} FROM issues_scoped(2026,'${region}') EXCEPT ALL SELECT ${ROW_COLS} FROM issues_scoped_legacy(2026,'${region}')) x`);
  const d2 = await q(db, `SELECT count(*)::int AS n FROM (SELECT ${ROW_COLS} FROM issues_scoped_legacy(2026,'${region}') EXCEPT ALL SELECT ${ROW_COLS} FROM issues_scoped(2026,'${region}')) x`);
  assertEquals([d1[0].n, d2[0].n], [0, 0]);
  return a.length;
}

Deno.test("A issue_tags_of：邊界 fixture 新舊逐列相同", async () => {
  const db = await fresh();
  let compared = 0;
  for (const c of TAG_CASES) {
    for (const names of NAME_SETS) {
      const args = `${arrLit(c.tags)}, ${lit(c.category)}, ${arrLit(names)}`;
      const r = await q(db, `SELECT issue_tags_of(${args})::text AS n, issue_tags_of_legacy(${args})::text AS o`);
      assertEquals(r[0].n, r[0].o, `tags=${JSON.stringify(c.tags)} cat=${c.category} names=${JSON.stringify(names)}`);
      compared++;
    }
  }
  assert(compared >= 90);
  // 抽樣確認 fixture 真的涵蓋「有結果」與「被雜訊吃光」兩種：不是兩邊都空的假綠
  const s = await q(db, `SELECT issue_tags_of(${arrLit(TAG_CASES[6].tags)}, '其他', NULL)::text AS v, issue_tags_of(${arrLit(TAG_CASES[13].tags)}, '其他', NULL)::text AS e`);
  assertEquals(s[0].v, "{Zebra,環保,apple,長照,交通,托育}", "多標籤去重後的排序（資料庫定序）");
  assertEquals(s[0].e, "{}", "全是雜訊且 category 是「其他」→ 空");
});

Deno.test("B issue_tag_is_junk：標籤×姓名組合新舊相同（含 p_names 內有 NULL）", async () => {
  const db = await fresh();
  const tags = new Set<string | null>([null, "", " ", "　", "a", "交通", "　交通　", "高雄", "新聞台", "2026", "王小明", "李大華", "高雄市長候選人", "RSS 新聞", "Ａ議題"]);
  for (const c of TAG_CASES) for (const t of c.tags ?? []) tags.add(t);
  let n = 0;
  for (const t of tags) {
    for (const names of NAME_SETS) {
      const args = `${lit(t)}, ${arrLit(names)}`;
      const r = await q(db, `SELECT issue_tag_is_junk(${args}) AS n, issue_tag_is_junk_legacy(${args}) AS o`);
      assertEquals(r[0].n, r[0].o, `tag=${t} names=${JSON.stringify(names)}（NULL 也要相同）`);
      n++;
    }
  }
  assert(n > 150);
});

Deno.test("C issues_scoped：小 fixture 新舊逐列相同，且不是空集合", async () => {
  const db = await fresh();
  await db.exec(seedSmall());
  const kaohsiung = await assertSameScoped(db, "高雄市");
  const taipei = await assertSameScoped(db, "臺北市");
  const taipei2 = await assertSameScoped(db, "台北市"); // 臺／台不分
  const none = await assertSameScoped(db, "不存在市");
  assert(kaohsiung > 25, `高雄市要有足夠多列才有意義：${kaohsiung}`);
  assertEquals([taipei, taipei2, none], [1, 1, 0]);
  // 同一位候選人兩筆參選紀錄（縣市長、議員）→ 他的承諾在範圍內各出現兩次
  const dup = await q(db, `SELECT count(*)::int AS n FROM issues_scoped(2026, '高雄市') WHERE policy_id = '${u(1000)}'`);
  assert((dup[0].n as number) >= 1);
});

Deno.test("C2 issues_scoped：大量 fixture（3000 筆承諾）新舊逐列相同", async () => {
  const db = await fresh();
  await db.exec(seedBulk(3000, 300));
  const n = await assertSameScoped(db, "高雄市");
  assert(n > 3000, `大量 fixture 展開後要有數千列：${n}`);
});

Deno.test("D contribution_auto_tasks_issue_too_broad()：整體結果集新舊相同", async () => {
  const db = await fresh();
  await db.exec(seedBulk(3000, 300));
  await db.exec(`INSERT INTO activity_rules (activity, params) VALUES ('issue_too_broad', '{"threshold":20,"election_id":2026}'::jsonb)`);
  const cols = "task_id, task_type, target::text AS target, what_we_need, hint_sources, reward, region";
  const a = await q(db, `SELECT ${cols} FROM contribution_auto_tasks_issue_too_broad() ORDER BY task_id`);
  const b = await q(db, `SELECT ${cols} FROM contribution_auto_tasks_issue_too_broad_legacy() ORDER BY task_id`);
  assert(a.length >= 3, `要真的開出多張任務：${a.length}`);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  // 已有細項的承諾不再算：兩邊同步縮減
  await db.exec(`INSERT INTO policy_subtopics (policy_id, issue, subtopic)
    SELECT policy_id, issue, '子題' FROM issues_scoped_legacy(2026, '高雄市') WHERE issue = '交通' AND level_rank <= 2`);
  const a2 = await q(db, `SELECT ${cols} FROM contribution_auto_tasks_issue_too_broad() ORDER BY task_id`);
  const b2 = await q(db, `SELECT ${cols} FROM contribution_auto_tasks_issue_too_broad_legacy() ORDER BY task_id`);
  assertEquals(JSON.stringify(a2), JSON.stringify(b2));
  assert(JSON.stringify(a2) !== JSON.stringify(a), "細項寫入後結果要有變");
});

Deno.test("E 結構守門：issue_tag_is_junk 呼叫次數＝distinct 標籤數，新版不再逐列呼叫 issue_tags_of", async () => {
  const db = await fresh();
  await db.exec(seedBulk(2000, 200));
  // 把兩個版本的判斷函式換成會計數的版本（行為相同，另外記一筆）
  await db.exec(`
    CREATE TABLE junk_calls (fn text, n bigint);
    INSERT INTO junk_calls VALUES ('new', 0), ('old', 0);
    ALTER FUNCTION issue_tag_is_junk(text, text[]) RENAME TO issue_tag_is_junk_real;
    ALTER FUNCTION issue_tag_is_junk_legacy(text, text[]) RENAME TO issue_tag_is_junk_legacy_real;
    CREATE FUNCTION issue_tag_is_junk(p text, nm text[]) RETURNS boolean LANGUAGE plpgsql VOLATILE AS
      $f$ BEGIN UPDATE junk_calls SET n = n + 1 WHERE fn = 'new'; RETURN issue_tag_is_junk_real(p, nm); END $f$;
    CREATE FUNCTION issue_tag_is_junk_legacy(p text, nm text[]) RETURNS boolean LANGUAGE plpgsql VOLATILE AS
      $f$ BEGIN UPDATE junk_calls SET n = n + 1 WHERE fn = 'old'; RETURN issue_tag_is_junk_legacy_real(p, nm); END $f$;
  `);
  // 舊版 issue_tags_of_legacy 內部呼叫的是 issue_tag_is_junk_legacy（已換成計數版）
  await db.exec(`SELECT count(*) FROM issues_scoped(2026, '高雄市')`);
  await db.exec(`SELECT count(*) FROM issues_scoped_legacy(2026, '高雄市')`);
  const c = await q(db, "SELECT fn, n::int AS n FROM junk_calls ORDER BY fn");
  const nNew = c.find((r) => r.fn === "new")!.n as number;
  const nOld = c.find((r) => r.fn === "old")!.n as number;
  const distinct = (await q(db, `SELECT count(DISTINCT btrim(x, E' \t\r\n　'))::int AS n
      FROM policies p JOIN politician_elections pe ON pe.politician_id = p.politician_id AND pe.election_id = 2026
      JOIN regions r ON r.id = pe.region_id AND r.region = '高雄市'
      CROSS JOIN LATERAL unnest(COALESCE(p.tags, '{}')) x
     WHERE p.status = 'Campaign Pledge' AND p.removed_at IS NULL AND issue_level_of(pe.election_type) IS NOT NULL
       AND btrim(x, E' \t\r\n　') <> ''`))[0].n as number;
  assertEquals(nNew, distinct, "新版：每個 distinct 標籤只判一次");
  assert(nOld > nNew * 10, `舊版逐列判斷次數要遠多於新版：old=${nOld} new=${nNew}`);
  // 新 issues_scoped 本體不再呼叫 issue_tags_of
  assert(!/issue_tags_of\s*\(/.test(fnText(MIG, "issues_scoped")), "新 issues_scoped 不呼叫 issue_tags_of");
  assert(/issue_tags_of\s*\(/.test(fnText(ISSUES_MIG, "issues_scoped")), "舊版確實逐列呼叫（守門本身有效）");
});

Deno.test("F 遷移文字守門", async () => {
  const ts = MIG_NAME.slice(0, 14);
  assert(ts > "20261127140000", `時間戳要晚於 main 最新的 20261127140000：${ts}`);
  assert(/回滾/.test(MIG) && /20261031130000_issues_summary_page\.sql/.test(MIG), "要寫回滾與前一版定義檔名");
  assert(/每日呼叫量變化/.test(MIG) && /行為變更：無/.test(MIG), "要寫每日呼叫量與行為變更");
  const fns = [...MIG.matchAll(/CREATE OR REPLACE FUNCTION (\w+)/g)].map((m) => m[1]);
  assertEquals(fns, ["issue_tag_is_junk", "issue_tags_of", "issues_scoped"]);
  // issue_tags_of 本體除了 PARALLEL SAFE 之外與舊版逐字相同
  assertEquals(fnText(MIG, "issue_tags_of").replace("IMMUTABLE\nPARALLEL SAFE", "IMMUTABLE"), fnText(ISSUES_MIG, "issue_tags_of"));
  // 簽名與回傳型別不變
  const db = await fresh();
  const sig = async (p: string) => (await q(db, `SELECT pg_get_function_identity_arguments(oid) AS a, pg_get_function_result(oid) AS r, provolatile AS v FROM pg_proc WHERE proname = '${p}'`))[0];
  for (const f of LEGACY_FNS) {
    const n = await sig(f);
    const o = await sig(`${f}_legacy`);
    assertEquals(n, o, `${f} 簽名、回傳型別、volatility 不變`);
  }
});

Deno.test({
  name: "G 本機量測（ITB_BENCH=1 才跑，只印不斷言）",
  ignore: !BENCH,
  fn: async () => {
    const db = await fresh();
    const N = Number(Deno.env.get("ITB_BENCH_N") ?? 20000);
    await db.exec(seedBulk(N, 1000));
    const time = async (label: string, sql: string) => {
      const t = performance.now();
      const r = await q(db, sql);
      const ms = Math.round(performance.now() - t);
      console.log(`[bench] ${label}: ${ms} ms（${r[0] ? JSON.stringify(r[0]) : ""}）`);
      return ms;
    };
    const rowsN = (await q(db, `SELECT count(*)::int AS n FROM issues_scoped(2026,'高雄市')`))[0].n;
    console.log(`[bench] fixture：${N} 筆承諾、1000 位候選人，issues_scoped 展開 ${rowsN} 列`);
    for (let i = 0; i < 2; i++) {
      await time("issues_scoped_legacy", "SELECT count(*)::int AS n FROM issues_scoped_legacy(2026,'高雄市')");
      await time("issues_scoped       ", "SELECT count(*)::int AS n FROM issues_scoped(2026,'高雄市')");
    }
    await db.exec(`INSERT INTO activity_rules (activity, params) VALUES ('issue_too_broad', '{"threshold":20,"election_id":2026}'::jsonb)`);
    await time("itb_legacy", "SELECT count(*)::int AS n FROM contribution_auto_tasks_issue_too_broad_legacy()");
    await time("itb_new   ", "SELECT count(*)::int AS n FROM contribution_auto_tasks_issue_too_broad()");
    // issue_tags_of 單次成本：1000 名姓名陣列、6 個標籤（每列不同，避免 IMMUTABLE 常數折疊），呼叫 20000 次
    const names = `(SELECT array_agg(name) AS a FROM politicians)`;
    const tags = `ARRAY['交通' || (g % 50), '長照', '托育' || (g % 7), '環保', '2026', '新聞台']`;
    await time("issue_tags_of_legacy ×20000", `SELECT count(*)::int AS n FROM generate_series(1,20000) g, ${names} nm WHERE issue_tags_of_legacy(${tags}, '其他', nm.a) IS NOT NULL`);
    await time("issue_tags_of        ×20000", `SELECT count(*)::int AS n FROM generate_series(1,20000) g, ${names} nm WHERE issue_tags_of(${tags}, '其他', nm.a) IS NOT NULL`);
  },
});
