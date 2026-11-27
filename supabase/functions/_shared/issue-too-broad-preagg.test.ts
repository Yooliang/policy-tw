/**
 * issue_too_broad 整表函式預先聚合（20261127160000_itb_preaggregate.sql）。
 *
 * 起因：正式庫 EXPLAIN ANALYZE 整句 7.35 秒，物化 CTE sc（約 4.6 萬列）被 87 個輸出列的相關子查詢各掃一次（loops=87）。
 * 新版把承諾清單先依縣市×議題聚合一次，輸出結果必須與舊版逐列相同。
 *
 * 守住：
 *   A. 新舊結果集逐列相等（PGlite 裝舊版本體成 _legacy 與新版同庫對跑）：多縣市（含臺／台寫法）、多議題、
 *      一筆承諾多議題、已有細項的承諾被排除、被撤下／非競選承諾被排除、等票中的縣市×議題不派、
 *      日期空值與同日期的排序、門檻邊界（> 不是 >=）逐一掃過、空集合
 *   B. 單一群組超過 200 筆：只留前 200 筆，total 仍是全部
 *   C. 同一筆承諾在同縣市有兩個層級（同一人兩筆參選紀錄）：舊版取哪列未定義，新版固定取較高層級；清單成員與 total 仍相同
 *   D. 效能守門（不寫秒數斷言）：EXPLAIN (ANALYZE, FORMAT JSON) 裡對 sc 的掃描，舊版 loops 超過 5（證明守門抓得到），新版不超過
 *   E. 還原驗證：把新版的 pol 聚合換回舊版的相關子查詢，D 必須紅
 *
 * 量測（非斷言）：ITB_BENCH=1 deno test --allow-read --allow-env 時印出舊新耗時；沒開就跳過。
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, mutate } from "./arms-pglite.ts";

const readMig = async (n: string) => (await Deno.readTextFile(new URL(`../../migrations/${n}`, import.meta.url))).replace(/\r\n/g, "\n");
const ISSUES_MIG = await readMig("20261031130000_issues_summary_page.sql");
const OLD_MIG = await readMig("20261102010000_issue_subtopics.sql");
const NEW_MIG = await readMig("20261127160000_itb_preaggregate.sql");
const FN = "contribution_auto_tasks_issue_too_broad";

const TABLE_SQL = (() => {
  const a = OLD_MIG.indexOf("CREATE TABLE IF NOT EXISTS policy_subtopics");
  return OLD_MIG.slice(a, OLD_MIG.indexOf(");", a) + 2);
})();
const helperSql = (f: string) => fnText(OLD_MIG, f);
const LEGACY_SQL = mutate(fnText(OLD_MIG, FN), `FUNCTION ${FN}()`, `FUNCTION ${FN}_legacy()`);
const NEW_SQL = fnText(NEW_MIG, FN);

const SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated;
CREATE FUNCTION uu(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politicians (id uuid PRIMARY KEY, name text, avatar_url text, party text);
CREATE TABLE parties (id bigint PRIMARY KEY, name text, short_name text);
CREATE TABLE politician_elections (politician_id uuid, election_id integer, election_type text, position text, cand_no integer, region_id integer, party_id bigint, PRIMARY KEY (politician_id, election_id, election_type, region_id));
CREATE TABLE policies (id uuid PRIMARY KEY, politician_id uuid, election_id integer, title text, category text, status text, proposed_date date, tags text[], lineage_id uuid, removed_at timestamptz);
CREATE TABLE activity_rules (id serial PRIMARY KEY, activity text, params jsonb, enabled boolean DEFAULT true);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb);
`;

// 高雄(1,2)／臺北(3)／台中(4,5)／連江(6)；縣市長 3 位、縣市議員 20 位，每人 3 筆承諾，分四個議題
const SEED = `
INSERT INTO regions VALUES (1,'高雄市',NULL,NULL),(2,'高雄市','第01選舉區',NULL),(3,'臺北市',NULL,NULL),(4,'台中市',NULL,NULL),(5,'台中市','第01選舉區',NULL),(6,'連江縣',NULL,NULL);
INSERT INTO politicians SELECT uu(n), 'P' || n, NULL, NULL FROM generate_series(1, 23) n;
INSERT INTO politician_elections
SELECT uu(n), 2026,
       CASE WHEN n <= 3 THEN '縣市長' ELSE '縣市議員' END,
       CASE WHEN n <= 3 THEN '市長' ELSE '議員' END,
       n,
       CASE WHEN n = 1 THEN 1 WHEN n = 2 THEN 3 WHEN n = 3 THEN 4 WHEN n <= 9 THEN 2 WHEN n <= 15 THEN 3 WHEN n <= 21 THEN 5 ELSE 6 END,
       NULL
  FROM generate_series(1, 23) n;
INSERT INTO policies (id, politician_id, election_id, title, category, status, proposed_date, tags, lineage_id, removed_at)
SELECT uu(n * 10 + k), uu(n), 2026, 'T' || n || '-' || k,
       (ARRAY['社會福利','交通建設','環境保護','教育文化'])[1 + (n + k) % 4],
       CASE WHEN (n + k) % 11 = 0 THEN 'Proposed' ELSE 'Campaign Pledge' END,
       CASE WHEN k = 1 THEN NULL WHEN k = 2 THEN DATE '2026-05-01' ELSE DATE '2026-01-01' + n END,
       CASE WHEN k = 3 AND n % 2 = 0 THEN ARRAY[(ARRAY['社會福利','交通建設','環境保護','教育文化'])[1 + (n + k) % 4], '教育文化'] ELSE NULL END,
       NULL,
       CASE WHEN n % 13 = 0 AND k = 1 THEN now() ELSE NULL END
  FROM generate_series(1, 23) n, generate_series(1, 3) k;
-- 已有細項的承諾（不再算）
INSERT INTO policy_subtopics (policy_id, issue, subtopic)
SELECT id, category, '細項甲' FROM policies WHERE title ~ '^T(4|5|10|16)-';
-- 等票中的縣市×議題不派；rejected 的不算等票
INSERT INTO contributions (contribution_type, status, payload) VALUES
 ('policy_subtopics', 'pending',  '{"region":"台中市","issue":"交通建設"}'),
 ('policy_subtopics', 'rejected', '{"region":"高雄市","issue":"社會福利"}'),
 ('policy_subtopics', 'verified', '{"region":"臺北市","issue":"環境保護"}');
`;

async function build(seed: string = SEED, newSql: string = NEW_SQL): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(ISSUES_MIG);
  await db.exec(TABLE_SQL);
  await db.exec(helperSql("issue_too_broad_threshold"));
  await db.exec(helperSql("issue_too_broad_election"));
  await db.exec(LEGACY_SQL);
  await db.exec(newSql);
  await db.exec(seed);
  return db;
}
type Row = Record<string, unknown>;
const q = async (db: PGlite, sql: string) => (await db.query<Row>(sql)).rows;
const setThreshold = async (db: PGlite, n: number) => {
  await db.exec(`DELETE FROM activity_rules; INSERT INTO activity_rules (activity, params) VALUES ('issue_too_broad', '{"threshold":${n},"election_id":2026}'::jsonb)`);
};
const run = (db: PGlite, fn: string) => q(db, `SELECT * FROM ${fn}() ORDER BY task_id`);

// ── EXPLAIN：收集對 CTE sc 的掃描節點 ──
interface PlanNode { [k: string]: unknown; Plans?: PlanNode[] }
function scScans(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  if (node["Node Type"] === "CTE Scan" && node["CTE Name"] === "sc") out.push(node);
  for (const c of node.Plans ?? []) scScans(c, out);
  return out;
}
async function scLoops(db: PGlite, fn: string): Promise<number[]> {
  const [r] = await q(db, `EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM ${fn}()`);
  const raw = r["QUERY PLAN"];
  const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];
  return scScans(plan[0].Plan).map((n) => Number(n["Actual Loops"]));
}

// ============================================================
// A. 新舊結果集逐列相等
// ============================================================
Deno.test("A1 門檻 2～8 逐一掃過：新舊結果集逐列相等，且有足夠多列、有被排除的列", async () => {
  const db = await build();
  let sawBoundary = false;
  for (const th of [2, 3, 4, 5, 6, 8]) {
    await setThreshold(db, th);
    const oldRows = await run(db, `${FN}_legacy`);
    const newRows = await run(db, FN);
    assertEquals(newRows, oldRows, `門檻 ${th}`);
    if (th === 3) {
      assert(newRows.length >= 6, `門檻 3 至少要有 6 組（超過 5 才測得到 loops 差異），實際 ${newRows.length}`);
      assert(newRows.some((r) => ((r.target as Row).policies as unknown[]).length > 1));
      sawBoundary = true;
    }
  }
  assert(sawBoundary);
});

Deno.test("A2 被排除的列真的沒出現：等票中的縣市×議題、已有細項的承諾、撤下與非競選承諾", async () => {
  const db = await build();
  await setThreshold(db, 3);
  const rows = await run(db, FN);
  const ids = rows.map((r) => r.task_id as string);
  assert(!ids.includes("auto:issue_too_broad:2026:台中市:交通建設"), "pending 等票中的不派");
  const allPolicyIds = new Set(rows.flatMap((r) => ((r.target as Row).policies as Row[]).map((p) => p.policy_id as string)));
  const withSub = await q(db, "SELECT policy_id::text AS id FROM policy_subtopics");
  assert(withSub.length > 0);
  // 已有細項的承諾在「該議題」不出現；同一承諾在別的議題（多標籤）仍可出現，所以只檢查同議題
  for (const s of await q(db, "SELECT s.policy_id::text AS id, s.issue FROM policy_subtopics s")) {
    for (const r of rows.filter((x) => (x.target as Row).issue === s.issue)) {
      assert(!((r.target as Row).policies as Row[]).some((p) => p.policy_id === s.id), `${s.id} 已有細項不應再列`);
    }
  }
  const removed = await q(db, "SELECT id::text AS id FROM policies WHERE removed_at IS NOT NULL OR status <> 'Campaign Pledge'");
  for (const x of removed) assert(!allPolicyIds.has(x.id as string), `${x.id} 已撤下或非競選承諾`);
  // 臺／台寫法：臺北市的任務 region 是「台北市」
  assert(rows.every((r) => !(r.region as string).includes("臺")));
});

Deno.test("A3 空集合：門檻很高時新舊都是 0 列；沒有任何規則列時走預設 150 也是 0 列", async () => {
  const db = await build();
  await setThreshold(db, 1000);
  assertEquals((await run(db, FN)).length, 0);
  assertEquals((await run(db, `${FN}_legacy`)).length, 0);
  await db.exec("DELETE FROM activity_rules");
  assertEquals(await run(db, FN), await run(db, `${FN}_legacy`));
  await db.exec("DELETE FROM policies");
  await setThreshold(db, 1);
  assertEquals(await run(db, FN), []);
});

Deno.test("A4 排序規則：層級 → 日期新到舊（空的最後）→ policy_id，與舊版相同", async () => {
  const db = await build();
  await setThreshold(db, 3);
  const rows = await run(db, FN);
  const withTie = rows.find((r) => {
    const pol = (r.target as Row).policies as Row[];
    return pol.length >= 4;
  });
  assert(withTie, "要有一組夠大的清單才看得出排序");
  const rank = (l: unknown) => ({ "縣市長": 1, "議員": 2 } as Record<string, number>)[String(l)] ?? 9;
  const pol = (withTie.target as Row).policies as Row[];
  for (let i = 1; i < pol.length; i++) assert(rank(pol[i - 1].level) <= rank(pol[i].level), "層級由高到低");
  assertEquals(await run(db, FN), await run(db, `${FN}_legacy`));
});

// ============================================================
// B. 超過 200 筆
// ============================================================
Deno.test("B1 單一群組 205 筆：只留前 200 筆，total 仍是 205，與舊版逐列相同（含同日期以 policy_id 決勝、日期空值排最後）", async () => {
  const db = await build(`
INSERT INTO regions VALUES (2,'高雄市','第01選舉區',NULL);
INSERT INTO politicians VALUES (uu(1),'P1',NULL,NULL);
INSERT INTO politician_elections VALUES (uu(1),2026,'縣市議員','議員',1,2,NULL);
INSERT INTO policies (id, politician_id, election_id, title, category, status, proposed_date, tags, lineage_id, removed_at)
SELECT uu(1000 + i), uu(1), 2026, 'T' || i, '交通建設', 'Campaign Pledge',
       CASE WHEN i % 7 = 0 THEN NULL ELSE DATE '2026-01-01' + (i % 20) END, NULL, NULL, NULL
  FROM generate_series(1, 205) i;
`);
  await setThreshold(db, 3);
  const oldRows = await run(db, `${FN}_legacy`);
  const newRows = await run(db, FN);
  assertEquals(newRows, oldRows);
  assertEquals(newRows.length, 1);
  const t = newRows[0].target as Row;
  assertEquals(t.total, 205);
  assertEquals((t.policies as unknown[]).length, 200);
  assertEquals(t.list_cap, 200);
});

// ============================================================
// C. 同一筆承諾有兩個層級
// ============================================================
Deno.test("C1 同一人在同縣市有兩筆參選紀錄：舊版取哪列未定義；新版固定取較高層級，成員與 total 仍相同", async () => {
  const db = await build();
  await setThreshold(db, 3);
  // 第 3 位（台中市縣市長）同時登記台中市縣市議員 → 他的承諾在 sc 出現兩次（縣市長／議員）
  await db.exec("INSERT INTO politician_elections VALUES (uu(3),2026,'縣市議員','議員',99,5,NULL)");
  const oldRows = await run(db, `${FN}_legacy`);
  const newRows = await run(db, FN);
  assertEquals(newRows.map((r) => r.task_id), oldRows.map((r) => r.task_id));
  let sawDup = false;
  for (let i = 0; i < newRows.length; i++) {
    const nt = newRows[i].target as Row, ot = oldRows[i].target as Row;
    assertEquals(nt.total, ot.total);
    const ids = (t: Row) => ((t.policies as Row[]).map((p) => p.policy_id as string)).sort();
    assertEquals(ids(nt), ids(ot));
    for (const p of nt.policies as Row[]) {
      if (["000000000031", "000000000032", "000000000033"].some((s) => p.policy_id === `00000000-0000-0000-0000-${s}`)) {
        assertEquals(p.level, "縣市長", "同一承諾兩個層級時取較高層級");
        sawDup = true;
      }
    }
  }
  assert(sawDup, "fixture 要真的讓第 3 位的承諾進到任務清單");
});

// ============================================================
// D / E. 效能守門
// ============================================================
Deno.test("D1 EXPLAIN：舊版對 sc 有 loops>5 的掃描（守門抓得到），新版每個對 sc 的掃描 loops 都 <=5 且至少有一個", async () => {
  const db = await build();
  await setThreshold(db, 3);
  const oldLoops = await scLoops(db, `${FN}_legacy`);
  const newLoops = await scLoops(db, FN);
  assert(Math.max(0, ...oldLoops) > 5, `舊版應有輸出列數次的 sc 掃描，實際 ${JSON.stringify(oldLoops)}`);
  assert(newLoops.length >= 1, `守門不能空轉：新版要看得到對 sc 的掃描，實際 ${JSON.stringify(newLoops)}`);
  assert(Math.max(...newLoops) <= 5, `新版對 sc 的掃描不該隨輸出列數放大，實際 ${JSON.stringify(newLoops)}`);
});

Deno.test("E1 還原驗證：把 pol 聚合換回每個輸出列各掃 sc 的相關子查詢，D 的條件必須不成立", async () => {
  const reverted = mutate(
    NEW_SQL,
    "'policies', COALESCE(pl.policies, '[]'::JSONB),",
    `'policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object('policy_id', x.policy_id, 'title', x.title, 'level', x.level) ORDER BY x.level_rank, x.proposed_date DESC NULLS LAST, x.policy_id), '[]'::JSONB)
                          FROM (SELECT d.* FROM (SELECT DISTINCT ON (s.policy_id) s.policy_id, s.title, s.level, s.level_rank, s.proposed_date FROM sc s WHERE s.county = g.county AND s.issue = g.issue ORDER BY s.policy_id) d
                                 ORDER BY d.level_rank, d.proposed_date DESC NULLS LAST, d.policy_id LIMIT 200) x),`,
  );
  const db = await build(SEED, reverted);
  await setThreshold(db, 3);
  const loops = await scLoops(db, FN);
  assert(Math.max(0, ...loops) > 5, `還原後應重新出現多次掃描，實際 ${JSON.stringify(loops)}`);
});

Deno.test("E2 還原驗證：新版若漏掉去重（DISTINCT ON），同一承諾兩個層級時 total 與清單長度會對不上", async () => {
  const noDistinct = mutate(NEW_SQL, "SELECT DISTINCT ON (s.county, s.issue, s.policy_id)\n                   s.county,", "SELECT s.county,");
  assertNotEquals(noDistinct, NEW_SQL);
  const db = await build(SEED, noDistinct);
  await setThreshold(db, 3);
  await db.exec("INSERT INTO politician_elections VALUES (uu(3),2026,'縣市議員','議員',99,5,NULL)");
  const rows = await run(db, FN);
  const bad = rows.some((r) => {
    const t = r.target as Row;
    return (t.policies as unknown[]).length !== Number(t.total);
  });
  assert(bad, "拿掉去重後清單長度應與 total 不一致，否則這個守門沒有在守");
});

// ============================================================
// 量測（非斷言）
// ============================================================
const bench = (() => { try { return Deno.env.get("ITB_BENCH") === "1"; } catch { return false; } })();
Deno.test({
  name: "量測 ITB_BENCH=1：較大資料量下舊新耗時與結果相同（不斷言秒數）",
  ignore: !bench,
  fn: async () => {
    const db = await build(`
INSERT INTO regions SELECT c, 'C' || lpad(c::text, 2, '0') || '縣', NULL, NULL FROM generate_series(1, 10) c;
INSERT INTO politicians SELECT uu(n), 'Q' || n, NULL, NULL FROM generate_series(1, 1000) n;
INSERT INTO politician_elections SELECT uu(n), 2026, '縣市議員', '議員', n, 1 + (n % 10), NULL FROM generate_series(1, 1000) n;
INSERT INTO policies (id, politician_id, election_id, title, category, status, proposed_date, tags, lineage_id, removed_at)
SELECT uu(n * 10 + k), uu(n), 2026, 'T' || n || '-' || k, '議題' || lpad(((n + k) % 12)::text, 2, '0'), 'Campaign Pledge',
       DATE '2026-01-01' + (n % 90), NULL, NULL, NULL
  FROM generate_series(1, 1000) n, generate_series(1, 8) k;
`);
    await setThreshold(db, 50);
    const t0 = performance.now();
    const oldRows = await run(db, `${FN}_legacy`);
    const t1 = performance.now();
    const newRows = await run(db, FN);
    const t2 = performance.now();
    assertEquals(newRows, oldRows);
    console.info(`[itb bench] 列數=${newRows.length} 舊=${(t1 - t0).toFixed(0)}ms 新=${(t2 - t1).toFixed(0)}ms sc loops 舊=${JSON.stringify(await scLoops(db, `${FN}_legacy`))} 新=${JSON.stringify(await scLoops(db, FN))}`);
  },
});
