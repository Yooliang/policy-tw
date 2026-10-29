/**
 * 主控台 VM 頁的額度用量 console_quota_now()（migration 20261029060000）。
 *   - SQL quota_window_start 與 TS quotaWindowStart 逐案相同（含跨日界 23:59→00:00、每個時段邊界前後一秒）
 *   - SQL quota_limits 的四個數字等於 handler 的常數（走樣就紅）
 *   - 只數本時段（created_at ≥ 起點）；per_agent 提交／票分開數；per_network 用順序代號、不外洩完整雜湊、列出網段上的代理
 *   - 權限：anon 可呼叫、SECURITY DEFINER、REVOKE ALL FROM PUBLIC
 *   還原驗證：把 created_at 條件拿掉，舊時段的列就會混進來；把 quota_limits 的 80 改 81，常數比對會紅
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { readMig } from "./arms-pglite.ts";
import { quotaWindowEnd, quotaWindowStart } from "./quota-window.ts";
import { CONTRIBUTE_DAILY_LIMIT_PER_DITRUST, CONTRIBUTE_DAILY_LIMIT_PER_IP } from "./contribute-handler.ts";
import { VERIFY_DAILY_LIMIT_PER_DITRUST, VERIFY_DAILY_LIMIT_PER_IP } from "./verify-handler.ts";

const SQL = await readMig("20261029060000_console_quota_now.sql");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function db(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE contributions (id serial PRIMARY KEY, agent_name text, contributor_ip_hash text, created_at timestamptz);
    CREATE TABLE contribution_votes (id serial PRIMARY KEY, agent_name text, verifier_ip_hash text, created_at timestamptz);
  `);
  await d.exec(SQL);
  return d;
}

Deno.test("quota_window_start 與 TS quotaWindowStart 逐案相同（跨日界、時段邊界前後）", async () => {
  const d = await db();
  const cases = [
    "2026-10-28T15:59:59Z", // 台北 23:59:59
    "2026-10-28T16:00:00Z", // 台北 00:00:00（跨日）
    "2026-10-28T16:00:01Z",
    "2026-10-29T03:59:59Z", "2026-10-29T04:00:00Z",
    "2026-10-29T07:59:59Z", "2026-10-29T08:00:00Z",
    "2026-10-29T11:59:59Z", "2026-10-29T12:00:00Z",
    "2026-10-29T15:59:59Z", "2026-10-29T16:00:00Z",
    "2026-12-31T16:00:00Z", "2027-01-01T00:00:00Z", "2026-02-28T23:59:59Z",
  ];
  for (const c of cases) {
    const r = await d.query<{ s: string }>(
      `SELECT to_char(quota_window_start('${c}'::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS s`,
    );
    assertEquals(r.rows[0].s, quotaWindowStart(new Date(c)).toISOString().replace(".000Z", "Z"), c);
  }
  assertEquals(quotaWindowEnd(new Date("2026-10-28T16:00:00Z")).toISOString(), "2026-10-28T20:00:00.000Z");
});

Deno.test("quota_limits 等於 handler 常數", async () => {
  const d = await db();
  const j = (await d.query<{ j: Record<string, number> }>(`SELECT quota_limits() AS j`)).rows[0].j;
  assertEquals(j.per_ip_submit_limit, CONTRIBUTE_DAILY_LIMIT_PER_IP);
  assertEquals(j.per_ip_verify_limit, VERIFY_DAILY_LIMIT_PER_IP);
  assertEquals(j.per_ditrust_submit_limit, CONTRIBUTE_DAILY_LIMIT_PER_DITRUST);
  assertEquals(j.per_ditrust_verify_limit, VERIFY_DAILY_LIMIT_PER_DITRUST);
});

Deno.test("只數本時段；代理與網段聚合；網段只給代號", async () => {
  const d = await db();
  await d.exec(`
    INSERT INTO contributions (agent_name, contributor_ip_hash, created_at) VALUES
      ('alpha', '${HASH_A}', now()), ('alpha', '${HASH_A}', now()), ('beta', '${HASH_A}', now()),
      ('gamma', '${HASH_B}', now()), ('old', '${HASH_B}', now() - interval '5 hours');
    INSERT INTO contribution_votes (agent_name, verifier_ip_hash, created_at) VALUES
      ('alpha', '${HASH_A}', now()), ('gamma', '${HASH_B}', now()), ('gamma', '${HASH_B}', now()),
      ('old', '${HASH_B}', now() - interval '5 hours');
  `);
  const j = (await d.query<{ j: any }>(`SELECT console_quota_now() AS j`)).rows[0].j;
  assertEquals(new Date(j.window_start).getTime(), quotaWindowStart(new Date()).getTime());
  assertEquals(new Date(j.window_resets_at).getTime() - new Date(j.window_start).getTime(), 4 * 3600_000);
  const by = Object.fromEntries(j.per_agent.map((a: any) => [a.agent_name, [a.submits, a.votes]]));
  assertEquals(by, { alpha: [2, 1], beta: [1, 0], gamma: [1, 2] });
  // A 網段用量 4（3 提交 + 1 票）、B 網段 3（1 提交 + 2 票）：依用量排序
  assertEquals(
    j.per_network.map((n: any) => [n.network, n.submits, n.votes, n.agents]),
    [["A", 3, 1, ["alpha", "beta"]], ["B", 1, 2, ["gamma"]]],
  );
  const text = JSON.stringify(j);
  assert(!text.includes(HASH_A) && !text.includes(HASH_B) && !text.includes("aaaaaa"), "不得外洩雜湊");
});

Deno.test("沒有資料時回空陣列；權限比照 console_queue_state", async () => {
  const d = await db();
  const j = (await d.query<{ j: any }>(`SELECT console_quota_now() AS j`)).rows[0].j;
  assertEquals([j.per_agent, j.per_network], [[], []]);
  assertStringIncludes(SQL, "SECURITY DEFINER");
  assertStringIncludes(SQL, "REVOKE ALL ON FUNCTION console_quota_now() FROM PUBLIC");
  assertStringIncludes(SQL, "GRANT EXECUTE ON FUNCTION console_quota_now() TO anon, authenticated, service_role");
});
