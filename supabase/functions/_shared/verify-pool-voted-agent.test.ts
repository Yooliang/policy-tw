/**
 * 驗證池排除「同代號已投過」＋網站請求的「查無」回報驗證排前段（migration 20261011160000）。
 *
 * 10-12 主控台：最近 30 分鐘派出 110 筆全是驗證、任務 0 筆，佇列最前面 14 張網站請求任務都沒派出。原因有兩層：
 *   - 換出口網段的同代號，驗證池（只比網段）把它早就投過的又派回來；投票表有唯一索引（貢獻, 代號），只能 skip 或 409，
 *     而網站請求的驗證列一直留在前段，全部代理繞著同一批打轉
 *   - 查無回報（no_change）的任務編號只在 payload.task_id，contribution_queue_at 看不出它是網站請求，驗證列排在一般段，
 *     它擋著的訪客任務（/next 等查無回報定案）也就一直不派
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";

const PREV = await readMig("20261011020000_verify_pool_exclude_agent.sql");
const SQL = await readMig("20261011160000_verify_pool_voted_agent_front_no_change.sql");
const RATIO = await readMig("20260924000002_queue_ratio.sql");
const FRONT = await readMig("20261010130000_web_request_verify_front.sql");
const BASE = ["queue_slot", "contribution_queue_at", "task_dispatched"].map((n) => fnText(RATIO, n)).join("\n");

function poolOf(sql: string): string {
  const a = sql.indexOf("CREATE OR REPLACE FUNCTION contribution_verify_pool");
  assert(a >= 0, "找不到驗證池定義");
  return sql.slice(a, sql.indexOf("\n$$;", a));
}

Deno.test("SQL：驗證池新定義 = 緊接在前那一版（20261011020000）做一處機械替換，其餘一字不動", () => {
  const from = "      WHERE v.contribution_id = c.id AND (v.verifier_ip_hash = p_ip_hash OR v.verifier_ip_hash = p_legacy_ip_hash)\n    )\n";
  const to = "      WHERE v.contribution_id = c.id AND (v.verifier_ip_hash = p_ip_hash OR v.verifier_ip_hash = p_legacy_ip_hash\n" +
    "        -- 同代號在別的網段投過的也不派（2026-10-13）：投票有唯一索引 contribution_votes_one_per_agent（貢獻, 代號），\n" +
    "        -- 換了出口網段的同代號拿到也只能 409 already_voted 或 skip，而網站請求的驗證列一直留在前段，會被反覆派回來\n" +
    "        OR (p_agent_name IS NOT NULL AND lower(v.agent_name) = lower(p_agent_name)))\n    )\n";
  const prev = poolOf(PREV);
  assertEquals(prev.split(from).length - 1, 1, "前一版應恰好有一處");
  assertEquals(poolOf(SQL), prev.replace(from, () => to));
});

Deno.test("SQL：簽名沒變（不 DROP、不多參數），不碰日本站有抄本的 contribution_queue_at／contribution_queue_row", () => {
  assert(!SQL.includes("DROP FUNCTION"), "簽名沒變，不必 DROP");
  assert(!/CREATE OR REPLACE FUNCTION contribution_queue_at\b/.test(SQL));
  assert(!/CREATE OR REPLACE FUNCTION contribution_queue_row\b/.test(SQL));
});

// ── 驗證池行為（PGlite，依賴函式用最小替身） ──
const C1 = "c0000000-0000-4000-8000-000000000001";
const C2 = "c0000000-0000-4000-8000-000000000002";

async function poolDb(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', source_urls text[], note text,
      task_id text, agent_name text, contributor_ip_hash text, status text, agree_count int DEFAULT 0, disagree_count int DEFAULT 0,
      unsure_count int DEFAULT 0, created_at timestamptz DEFAULT now(), score int DEFAULT 0, target_score int, voter_ips int DEFAULT 0);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz, queue_at timestamptz, dispatch_count int DEFAULT 0, verify_target int);
    CREATE TABLE contribution_votes (contribution_id uuid, agent_name text, verifier_ip_hash text);
    CREATE TABLE verify_dispatches (contribution_id uuid, ip_hash text, dispatched_at timestamptz);
    CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS 'SELECT 3';
    CREATE FUNCTION contribution_needs_two_ips(text, jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    INSERT INTO contributions (id, contribution_type, agent_name, contributor_ip_hash, status, score, target_score) VALUES
      ('${C1}', 'policy', 'a-zhen', 'net-a', 'pending', 2, 3),
      ('${C2}', 'policy', 'a-zhen', 'net-a', 'pending', 0, 3);
    INSERT INTO task_dispatches (task_id, queue_at) VALUES ('verify:${C1}', '1970-01-01 00:00:01'), ('verify:${C2}', '2026-09-24');
    -- 小雯在舊網段 net-old 投過 C1
    INSERT INTO contribution_votes VALUES ('${C1}', '小雯', 'net-old');
  `);
  await d.exec(poolOf(SQL) + "\n$$;");
  return d;
}
const poolIds = async (d: PGlite, ip: string, agent: string | null) =>
  (await d.query<{ id: string }>(`SELECT id FROM contribution_verify_pool($1, NULL, 30, NULL, NULL, $2)`, [ip, agent])).rows.map((r) => r.id);

Deno.test("同代號換了網段：投過的那筆不再派（大小寫不分），沒投過的照派", async () => {
  const d = await poolDb();
  assertEquals(await poolIds(d, "net-new", "小雯"), [C2]);
  await d.query(`UPDATE contribution_votes SET agent_name = 'QiLiang'`);
  assertEquals(await poolIds(d, "net-new", "qiliang"), [C2]);
  await d.close();
});

Deno.test("別的代號、或沒傳代號：行為與前一版相同（只比網段）", async () => {
  const d = await poolDb();
  assertEquals(await poolIds(d, "net-new", "QiLiang"), [C1, C2]);
  assertEquals(await poolIds(d, "net-new", null), [C1, C2]);
  assertEquals(await poolIds(d, "net-old", null), [C2], "同網段投過的照舊排除");
  await d.close();
});

// ── 前段：查無回報（任務編號在 payload.task_id） ──
const WEB_TASK = "11111111-1111-4111-8111-111111111111";
const N_OLD = "b0000000-0000-4000-8000-000000000001"; // 網站請求的查無回報，已在一般段（既有的）
const N_NEW = "b0000000-0000-4000-8000-000000000002"; // 之後新交的查無回報
const N_AUTO = "b0000000-0000-4000-8000-000000000003"; // 自動缺口的查無回報
const P_WEB = "b0000000-0000-4000-8000-000000000004"; // 網站請求的政見交件（task_id 欄有值），在前段
const Y2000 = Date.UTC(2000, 0, 1);
const Y1971 = Date.UTC(1971, 0, 1);

async function frontDb(withMig = true): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, task_id text, payload jsonb DEFAULT '{}', status text, created_at timestamptz);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz, queue_at timestamptz, dispatch_count int DEFAULT 0);
    INSERT INTO contribution_tasks VALUES ('${WEB_TASK}', 'web_request');
    INSERT INTO contributions VALUES
      ('${N_OLD}', 'no_change', NULL, '{"task_id":"${WEB_TASK}"}', 'pending', '2026-10-08'),
      ('${N_AUTO}', 'no_change', NULL, '{"task_id":"auto:policy_missing:x"}', 'pending', '2026-10-08'),
      ('${P_WEB}', 'policy', '${WEB_TASK}', '{}', 'pending', '2026-10-12');
    INSERT INTO task_dispatches VALUES
      ('verify:${P_WEB}', NULL, '1970-01-01 00:00:05', 0),
      ('verify:${N_OLD}', now(), '2026-09-24 07:26:08', 1),
      ('verify:${N_AUTO}', now(), '2026-09-24 07:26:09', 1);
  `);
  await d.exec(BASE);
  await d.exec(FRONT);
  if (withMig) {
    // 驗證池那段的依賴表這裡沒有，只套前段的部分
    await d.exec(SQL.slice(SQL.indexOf("-- 前段判準")));
  }
  return d;
}
const at = async (d: PGlite, id: string) =>
  new Date((await d.query<{ q: string }>(`SELECT queue_at AS q FROM task_dispatches WHERE task_id = $1`, [`verify:${id}`])).rows[0].q).getTime();

Deno.test("既有：網站請求的查無回報拉回前段、排在前段既有驗證列後面；自動缺口的查無回報不動", async () => {
  const d = await frontDb();
  const old = await at(d, N_OLD);
  assert(old < Y1971, "拉回 1970 段");
  assert(old > await at(d, P_WEB), "排在前段既有的後面");
  assert((await at(d, N_AUTO)) > Y2000);
  await d.close();
});

Deno.test("新交的：入列就排前段；派出後留在前段；定案後派出回隊尾", async () => {
  const d = await frontDb();
  await d.exec(`INSERT INTO contributions VALUES ('${N_NEW}', 'no_change', NULL, '{"task_id":"${WEB_TASK}"}', 'pending', now())`);
  await d.exec(`INSERT INTO task_dispatches (task_id, queue_at) VALUES ('verify:${N_NEW}', queue_slot('verify'))`);
  const a = await at(d, N_NEW);
  assert(a < Y1971 && a > await at(d, N_OLD), "入列就排到前段最後面");
  await d.query(`SELECT task_dispatched($1)`, [`verify:${N_NEW}`]);
  assert((await at(d, N_NEW)) < Y1971, "派出後留在前段");
  await d.query(`UPDATE contributions SET status = 'applied' WHERE id = $1`, [N_NEW]);
  await d.query(`SELECT task_dispatched($1)`, [`verify:${N_NEW}`]);
  assert((await at(d, N_NEW)) > Y2000, "定案後回隊尾");
  await d.close();
});

Deno.test("入列觸發器不攔：一般交件、1980 插隊段；後段不是 uuid 也不出錯", async () => {
  const d = await frontDb();
  await d.exec(`INSERT INTO task_dispatches (task_id, queue_at) VALUES ('verify:${N_AUTO}x', now())`);
  assert((await at(d, `${N_AUTO}x`)) > Y2000, "後段不是 uuid 也不出錯、不改");
  await d.exec(`INSERT INTO contributions VALUES ('${N_NEW}', 'policy', 'auto:policy_missing:z', '{}', 'pending', now())`);
  await d.exec(`INSERT INTO task_dispatches (task_id, queue_at) VALUES ('verify:${N_NEW}', now())`);
  assert((await at(d, N_NEW)) > Y2000, "一般交件入列照舊");
  await d.exec(`UPDATE contributions SET payload = '{"task_id":"${WEB_TASK}"}', contribution_type = 'no_change', task_id = NULL WHERE id = '${N_NEW}'`);
  await d.exec(`DELETE FROM task_dispatches WHERE task_id = 'verify:${N_NEW}'`);
  await d.exec(`INSERT INTO task_dispatches (task_id, queue_at) VALUES ('verify:${N_NEW}', '1979-12-31 23:00:00+00')`);
  assertEquals(await at(d, N_NEW), Date.UTC(1979, 11, 31, 23), "1980 插隊段不攔");
  await d.close();
});

Deno.test("還原驗證：沒有這支 migration，查無回報派出一次就回隊尾、既有的留在一般段", async () => {
  const d = await frontDb(false);
  assert((await at(d, N_OLD)) > Y2000);
  await d.query(`SELECT task_dispatched($1)`, [`verify:${N_OLD}`]);
  assert((await at(d, N_OLD)) > Y2000);
  await d.close();
});
