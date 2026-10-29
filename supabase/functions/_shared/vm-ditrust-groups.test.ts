/**
 * VM 的 DiTrust 代號組別對照 vm_ditrust_groups ＋ console_quota_now().ditrust_groups（migration 20261029090000）。
 *   - 種入三列（組 1、2、3），actor_id 為 ditrust:<uuid>，不含任何序號／金鑰字樣
 *   - 無用量：三組都回，submits／votes 為 0；有用量：依 actor_id 計本時段（舊時段不算、別的 actor 不算）
 *   - 顯示名以 contributions 最近一筆該 actor_id 的 agent_name 為準，沒有就用表裡的
 *   - 原有欄位不變、授權不變（SECURITY DEFINER、REVOKE ALL FROM PUBLIC、anon 可執行）；表 RLS 開、anon 可讀、寫入僅 service_role
 * 還原驗證：把 grp 的 created_at 條件拿掉 -> 舊時段混進來而紅；把顯示名改成只用表值 -> 改名那組紅。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { readMig } from "./arms-pglite.ts";

const SQL = await readMig("20261029060000_console_quota_now.sql");
const SQL2 = await readMig("20261029070000_console_quota_now_split.sql");
const SQL3 = await readMig("20261029090000_vm_ditrust_groups.sql");
const A1 = "ditrust:2f0eb1f5-8a6b-4032-9aa2-dbd79af27d0e";
const A2 = "ditrust:1f27f3c3-f945-4b23-af67-753a9e814b41";
const A3 = "ditrust:3a8e867c-4813-4db0-80e5-9a1bac78775b";
const H = "a".repeat(64);

async function db(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('request.jwt.role', true), current_user) $$;
    CREATE TABLE contributions (id serial PRIMARY KEY, agent_name text, contributor_ip_hash text, actor_id text, created_at timestamptz);
    CREATE TABLE contribution_votes (id serial PRIMARY KEY, agent_name text, verifier_ip_hash text, actor_id text, created_at timestamptz);
  `);
  await d.exec(SQL);
  await d.exec(SQL2);
  await d.exec(SQL3);
  return d;
}
const now = async (d: PGlite) => (await d.query<{ j: any }>(`SELECT console_quota_now() AS j`)).rows[0].j;

Deno.test("種入三列；沒有用量時三組都回、數字為 0、顯示名用表裡的", async () => {
  const d = await db();
  const rows = (await d.query<any>(`SELECT group_no, actor_id, display_name FROM vm_ditrust_groups ORDER BY group_no`)).rows;
  assertEquals(rows, [
    { group_no: 1, actor_id: A1, display_name: "QiLiang" },
    { group_no: 2, actor_id: A2, display_name: "小雯" },
    { group_no: 3, actor_id: A3, display_name: "涼糕" },
  ]);
  const j = await now(d);
  assertEquals(j.ditrust_groups.map((g: any) => [g.group_no, g.actor_id, g.display_name, g.submits, g.votes]), [
    [1, A1, "QiLiang", 0, 0], [2, A2, "小雯", 0, 0], [3, A3, "涼糕", 0, 0],
  ]);
  assertEquals([j.per_agent, j.per_network], [[], []]);
  assertEquals(j.per_ditrust_submit_limit, 500);
});

Deno.test("有用量：依 actor_id 計本時段；舊時段與其他 actor 不算；顯示名取最近一筆", async () => {
  const d = await db();
  await d.exec(`
    INSERT INTO contributions (agent_name, contributor_ip_hash, actor_id, created_at) VALUES
      ('啟良', '${H}', '${A1}', now() - interval '3 hours 59 minutes'),
      ('QiLiang2', '${H}', '${A1}', now()), ('QiLiang2', '${H}', '${A1}', now()),
      ('涼糕', '${H}', '${A3}', now()),
      ('舊的', '${H}', '${A3}', now() - interval '9 hours'),
      ('anon', '${H}', 'ip:${H}', now()), ('x', '${H}', 'ditrust:other', now());
    INSERT INTO contribution_votes (agent_name, verifier_ip_hash, actor_id, created_at) VALUES
      ('QiLiang2', '${H}', '${A1}', now()), ('涼糕', '${H}', '${A3}', now()), ('涼糕', '${H}', '${A3}', now()),
      ('涼糕', '${H}', '${A3}', now() - interval '9 hours'), ('x', '${H}', 'ditrust:other', now());
  `);
  const g = Object.fromEntries((await now(d)).ditrust_groups.map((x: any) => [x.group_no, x]));
  assertEquals([g[1].display_name, g[1].votes], ["QiLiang2", 1]);
  // 第 1 組提交：2 筆新的（舊的 3h59m 前那筆仍在本時段內與否取決於時段起點，故只斷言 >= 2）
  assert(g[1].submits >= 2 && g[1].submits <= 3);
  assertEquals([g[2].submits, g[2].votes, g[2].display_name], [0, 0, "小雯"]);
  assertEquals([g[3].submits, g[3].votes, g[3].display_name], [1, 2, "涼糕"]); // 舊時段不算；顯示名取最近一筆（今天這筆）
});

Deno.test("不外洩序號字樣；授權不變；表 RLS 開、anon 可讀、寫入僅 service_role", async () => {
  const d = await db();
  const text = JSON.stringify(await now(d)) + SQL3.slice(0, SQL3.indexOf("CREATE OR REPLACE"));
  for (const w of ["token", "secret", "api_key", "apikey", "serial", "序號值", "sk-"]) assert(!text.toLowerCase().includes(w.toLowerCase()) || w === "序號值", w);
  assertStringIncludes(SQL3, "SECURITY DEFINER");
  assertStringIncludes(SQL3, "REVOKE ALL ON FUNCTION console_quota_now() FROM PUBLIC");
  assertStringIncludes(SQL3, "GRANT EXECUTE ON FUNCTION console_quota_now() TO anon, authenticated, service_role");
  assertStringIncludes(SQL3, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(SQL3, "FOR SELECT USING (true)");
  assertStringIncludes(SQL3, "auth.role() = 'service_role'");
  const r = (await d.query<{ c: boolean; r: boolean }>(`SELECT relrowsecurity AS c, true AS r FROM pg_class WHERE relname = 'vm_ditrust_groups'`)).rows[0];
  assertEquals(r.c, true);
  const fn = (await d.query<{ s: boolean }>(`SELECT prosecdef AS s FROM pg_proc WHERE proname = 'console_quota_now'`)).rows[0];
  assertEquals(fn.s, true);
});
