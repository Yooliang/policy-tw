/**
 * 驗證票「沒人在做的先派」（2026-11-09，協議 1.124.0，migration 20261109170000）。
 *
 * 起因：同一張驗證票（需 3 票）在 7 分鐘內被派給 4 個代理——它排在佇列第 1，每個 /next 都拿隊頭，前面的人還在查證。
 * 規則：握著＝30 分鐘內派到、還沒投票的別的代號；握著的人數 >= 還缺票數就先不派；零人握著的排前面；沒有別的可派時退回原行為。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { isVerifyFullyHeld, LEASE_MINUTES, orderVerifyByHold, verifyVotesNeeded } from "./dispatch.ts";

const MIG = await Deno.readTextFile(new URL("../../migrations/20261109170000_verify_unheld_first.sql", import.meta.url));
const NEXT = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));

// ── TS：還缺幾票、握滿、排序 ──
Deno.test("verifyVotesNeeded：目標 − 分數，至少 1；沒目標分數退回 effective_required，都沒有當 1", () => {
  assertEquals(verifyVotesNeeded({ score: 0, target_score: 3 }), 3);
  assertEquals(verifyVotesNeeded({ score: 2, target_score: 3 }), 1);
  assertEquals(verifyVotesNeeded({ score: 3, target_score: 3 }), 1);
  assertEquals(verifyVotesNeeded({ score: 1, effective_required: 2 }), 1);
  assertEquals(verifyVotesNeeded({}), 1);
});

Deno.test("4 個代理搶 3 票的票：前 3 個派得到，第 4 個派不到（握著 3 >= 還缺 3）", () => {
  const held = (n: number) => ({ score: 0, target_score: 3, held_count: n });
  const served = [0, 1, 2, 3].map((n) => !isVerifyFullyHeld(held(n)));
  assertEquals(served, [true, true, true, false]);
});

Deno.test("已投了 1 票（還缺 2）：握著 2 人就滿了", () => {
  assertEquals(isVerifyFullyHeld({ score: 1, target_score: 3, held_count: 1 }), false);
  assertEquals(isVerifyFullyHeld({ score: 1, target_score: 3, held_count: 2 }), true);
});

Deno.test("orderVerifyByHold：零人握著 ＞ 部分握著 ＞ 握滿，組內保持原順序", () => {
  const rows = [
    { id: "a", score: 0, target_score: 3, held_count: 1 }, // 部分
    { id: "b", score: 0, target_score: 3, held_count: 3 }, // 握滿
    { id: "c", score: 0, target_score: 3, held_count: 0 }, // 零
    { id: "d", score: 0, target_score: 3, held_count: 2 }, // 部分
    { id: "e", score: 0, target_score: 3 }, // 零（沒帶欄位＝舊池子）
  ];
  assertEquals(orderVerifyByHold(rows).map((r) => r.id), ["c", "e", "a", "d", "b"]);
});

Deno.test("LEASE_MINUTES ＝ 30，跟 SQL 的握著窗口同一個數字", () => {
  assertEquals(LEASE_MINUTES, 30);
  assert(MIG.includes("vd.dispatched_at > now() - interval '30 minutes'"));
});

// ── /next 接線 ──
Deno.test("next：第一次要 p_skip_held=true，沒別的可派時用 false 再要一次（退路）", () => {
  assert(NEXT.includes("p_skip_held: true"));
  assert(NEXT.includes("p_skip_held: false"));
  assert(NEXT.includes("orderVerifyByHold(out)"));
  assertEquals(NEXT.split("refillHeld()").length - 1, 2, "submitFull 與任務給不出來兩處");
});

// ── SQL（PGlite） ──
const poolSql = (() => {
  const a = MIG.indexOf("CREATE OR REPLACE FUNCTION contribution_verify_pool");
  assert(a >= 0);
  return MIG.slice(a, MIG.indexOf("\n$$;", a)) + "\n$$;";
})();

Deno.test("SQL：簽名只多一個有預設值的參數、沒碰日本站", () => {
  assert(MIG.includes("DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT);"));
  assert(MIG.includes("p_skip_held BOOLEAN DEFAULT FALSE"));
  assert(!MIG.includes("policy_jp."), "日本站不動");
});

const T = "c0000000-0000-4000-8000-0000000000";
const id = (n: number) => `${T}${String(n).padStart(2, "0")}`;

async function db(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', source_urls text[], note text,
      task_id text, agent_name text, actor_id text, contributor_ip_hash text, status text, agree_count int DEFAULT 0, disagree_count int DEFAULT 0,
      unsure_count int DEFAULT 0, created_at timestamptz DEFAULT now(), score int DEFAULT 0, target_score int, voter_ips int DEFAULT 0);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, queue_at timestamptz, verify_target int);
    CREATE TABLE contribution_votes (contribution_id uuid, agent_name text, actor_id text);
    CREATE TABLE verify_dispatches (contribution_id uuid, ip_hash text, agent_name text, dispatched_at timestamptz DEFAULT now());
    CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS 'SELECT 3';
    CREATE FUNCTION contribution_overvoted_stop_votes() RETURNS int LANGUAGE sql AS 'SELECT 100';
    CREATE FUNCTION uuid_if_canonical(text) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    INSERT INTO contributions (id, contribution_type, agent_name, contributor_ip_hash, status, score, target_score) VALUES
      ('${id(1)}', 'policy', 'author', 'net-x', 'pending', 0, 3),
      ('${id(2)}', 'policy', 'author', 'net-x', 'pending', 0, 3),
      ('${id(3)}', 'policy', 'author', 'net-x', 'pending', 0, 3);
    INSERT INTO task_dispatches (task_id, queue_at) VALUES
      ('verify:${id(1)}', '2026-09-01'), ('verify:${id(2)}', '2026-09-02'), ('verify:${id(3)}', '2026-09-03');
  `);
  await d.exec(poolSql);
  return d;
}
const hold = (d: PGlite, c: number, agent: string, ip: string, minutesAgo = 1) =>
  d.query(`INSERT INTO verify_dispatches VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`, [id(c), ip, agent, String(minutesAgo)]);
const pool = async (d: PGlite, agent: string, skip: boolean) =>
  (await d.query<{ id: string; held_count: number }>(
    `SELECT id, held_count FROM contribution_verify_pool('net-me', NULL, 30, NULL, NULL, $1, NULL, $2)`,
    [agent, skip],
  )).rows.map((r) => `${r.id.slice(-2)}:${r.held_count}`);

Deno.test("SQL：4 個代理搶 3 票——前 3 人拿得到第 1 張，第 4 人被導去別張", async () => {
  const d = await db();
  const seen: string[] = [];
  for (const [i, agent] of ["mary_mm01", "小雯", "mei_mm02", "sakura_mm01"].entries()) {
    const rows = await pool(d, agent, true);
    seen.push(rows[0].split(":")[0] + "/" + rows.some((r) => r.startsWith("01")));
    // 派給他（模擬 verify_dispatch_claim 寫入；不同網段）
    await hold(d, rows[0].startsWith("01") ? 1 : 2, agent, `net-${i}`);
  }
  assertEquals(seen, ["01/true", "01/true", "01/true", "02/false"]);
  await d.close();
});

Deno.test("SQL：握著只算 30 分鐘內、沒投票、別的代號；自己握著的不算", async () => {
  const d = await db();
  await hold(d, 1, "a", "n1");
  await hold(d, 1, "b", "n2");
  await hold(d, 1, "c", "n3");
  assertEquals((await pool(d, "d", true)).some((r) => r.startsWith("01")), false, "3 人握著、還缺 3 → 擋掉");
  await d.query(`UPDATE verify_dispatches SET dispatched_at = now() - interval '31 minutes' WHERE agent_name = 'a'`);
  assertEquals((await pool(d, "d", true))[0], "01:2", "a 超過 30 分鐘不算 → 握著 2 < 3，回來了");
  await d.query(`INSERT INTO contribution_votes VALUES ('${id(1)}', 'B', NULL)`); // b 已投票（大小寫不分）
  assertEquals((await pool(d, "d", true))[0], "01:1", "b 投過就不再握著");
  assertEquals((await pool(d, "c", true))[0], "01:0", "c 自己握著的不算（扣掉自己）");
  await d.close();
});

Deno.test("SQL：還缺 1 票（已有 2 分）只要 1 人握著就擋", async () => {
  const d = await db();
  await d.query(`UPDATE contributions SET score = 2 WHERE id = '${id(1)}'`);
  await hold(d, 1, "a", "n1");
  assertEquals((await pool(d, "z", true)).some((r) => r.startsWith("01")), false);
  await d.close();
});

Deno.test("SQL：不餓死——p_skip_held=FALSE 維持原行為（握滿的也回，順序照 queue_at），held_count 照實回", async () => {
  const d = await db();
  await hold(d, 1, "a", "n1");
  await hold(d, 1, "b", "n2");
  await hold(d, 1, "c", "n3");
  assertEquals(await pool(d, "d", false), ["01:3", "02:0", "03:0"]);
  assertEquals(await pool(d, "d", true), ["02:0", "03:0"]);
  for (const c of [2, 3]) for (const [i, a] of ["a", "b", "c"].entries()) await hold(d, c, a, `m${c}${i}`);
  assertEquals(await pool(d, "d", true), [], "全部握滿 → skip 版是空的（/next 會退回 FALSE 再要一次）");
  assertEquals((await pool(d, "d", false)).length, 3);
  await d.close();
});

Deno.test("SQL：不傳 p_skip_held（舊呼叫端）＝FALSE＝原行為", async () => {
  const d = await db();
  await hold(d, 1, "a", "n1");
  await hold(d, 1, "b", "n2");
  await hold(d, 1, "c", "n3");
  const r = await d.query<{ id: string }>(`SELECT id FROM contribution_verify_pool(p_ip_hash => 'net-me', p_agent_name => 'd')`);
  assertEquals(r.rows.length, 3);
  await d.close();
});
