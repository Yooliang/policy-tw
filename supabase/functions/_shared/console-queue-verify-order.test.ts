/**
 * /queue 與主控台隊列預覽照 /next 的實際順序（2026-11-20，#989；migration 20261120180000）。
 *   - head：驗證票一律先於任務；驗證票內 verify_rank → queue_at → task_id，與 contribution_verify_pool 同一組排序鍵；任務其後 queue_at → task_id
 *   - head 每列多 verify_rank（任務列 null）；其他欄位不變
 *   - 逐案比對：console_queue_state().head 的驗證順序 ＝ contribution_verify_pool 的順序
 * 做法：先裝 20261017020100 的 console_queue_state 定義（後續幾次機械式替換與本題無關），再跑本 migration 的替換，池子用 20261119100000 的真函式。
 * 還原驗證：把 head 排序改回只看 queue_at（migration 的排序那行換回原樣）→ 「驗證先於任務」「順序＝池子」兩條紅。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";

const BASE = await readMig("20261017020100_overvoted_votes.sql");
const MIG = await readMig("20261120180000_console_queue_verify_order.sql");
const POOL_MIG = await readMig("20261119100000_verify_first_rank.sql");
const ORDER_BY = "ORDER BY d.verify_rank ASC NULLS LAST, d.queue_at ASC, d.task_id";
const HEAD_ORDER = "OVER (ORDER BY m.tie, m.verify_rank ASC NULLS LAST, m.queue_at, m.task_id)::INTEGER AS pos";

const cid = (n: number) => `c0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

async function db(mig = MIG): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE queue_settings (id int PRIMARY KEY, overvoted_flag_multiplier numeric DEFAULT 2, overvoted_stop_multiplier numeric DEFAULT 3, redispatch_cooldown_seconds int DEFAULT 14400);
    INSERT INTO queue_settings VALUES (1);
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text, task_type text, target jsonb);
    CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count int);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text);
    CREATE TABLE policies (id uuid PRIMARY KEY, title text);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb DEFAULT '{}', source_urls text[], note text,
      task_id text, agent_name text DEFAULT 'author', actor_id text, contributor_ip_hash text DEFAULT 'net-x', status text DEFAULT 'pending',
      agree_count int DEFAULT 0, disagree_count int DEFAULT 0, unsure_count int DEFAULT 0, created_at timestamptz DEFAULT now(),
      score int DEFAULT 0, target_score int DEFAULT 3, voter_ips int DEFAULT 0, needs_identity_pick boolean DEFAULT false);
    CREATE TABLE contribution_votes (contribution_id uuid, agent_name text, actor_id text, verdict text, note text, created_at timestamptz DEFAULT now());
    CREATE TABLE verify_dispatches (contribution_id uuid, ip_hash text, agent_name text, dispatched_at timestamptz DEFAULT now());
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, work_key text, task_type text, target jsonb, queue_at timestamptz,
      dispatch_count int DEFAULT 0, last_dispatched_at timestamptz, blocked boolean DEFAULT false, cooling boolean DEFAULT false,
      verify_target int, verify_rank smallint);
    CREATE FUNCTION uuid_or_null(t text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $f$ BEGIN RETURN t::uuid; EXCEPTION WHEN others THEN RETURN NULL; END $f$;
    CREATE FUNCTION election_id_or_null(t text) RETURNS int LANGUAGE sql IMMUTABLE AS $f$ SELECT CASE WHEN t ~ '^[0-9]+$' THEN t::int END $f$;
    CREATE FUNCTION uuid_if_canonical(text) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE FUNCTION contribution_subject_politician(p jsonb) RETURNS uuid LANGUAGE sql AS $f$ SELECT NULL::uuid $f$;
    CREATE FUNCTION question_answer_cap() RETURNS int LANGUAGE sql AS $f$ SELECT 3 $f$;
    CREATE FUNCTION contribution_effective_agree(uuid) RETURNS int LANGUAGE sql AS 'SELECT 3';
    CREATE FUNCTION contribution_needs_two_ips(t text, p jsonb) RETURNS boolean LANGUAGE sql AS $f$ SELECT false $f$;
    CREATE FUNCTION contribution_overvoted_flag_votes() RETURNS numeric LANGUAGE sql AS 'SELECT 100::numeric';
    CREATE FUNCTION contribution_overvoted_stop_votes() RETURNS numeric LANGUAGE sql AS 'SELECT 100::numeric';
    CREATE FUNCTION contribution_vote_baseline() RETURNS numeric LANGUAGE sql AS 'SELECT 1::numeric';
  `);
  await d.exec(fnText(BASE, "console_queue_state"));
  await d.exec(fnText(POOL_MIG, "contribution_verify_pool"));
  await d.exec(mig);
  return d;
}

// 六張待驗證票，故意讓 queue_at 順序與 verify_rank 順序不同；加兩個任務列（queue_at 比所有驗證票都早）
const TICKETS: Array<[number, number, string]> = [
  // [編號, verify_rank, queue_at]
  [1, 5, "2026-01-01"], // 沒票・村里・最早
  [2, 3, "2026-06-01"], // 沒票・縣市
  [3, 1, "2026-10-01"], // 有票・鄉鎮・最晚
  [4, 2, "2026-02-01"], // 有票・村里
  [5, 1, "2026-09-01"], // 有票・鄉鎮・比 3 早
  [6, 0, "2026-11-01"], // 有票・縣市
];
async function seed(d: PGlite) {
  for (const [n, rank, at] of TICKETS) {
    await d.query(`INSERT INTO contributions (id, contribution_type, status, score, target_score) VALUES ($1, 'policy', 'pending', 0, 3)`, [cid(n)]);
    await d.query(`INSERT INTO task_dispatches (task_id, queue_at, verify_rank) VALUES ($1, $2, $3)`, [`verify:${cid(n)}`, at, rank]);
  }
  await d.query(`INSERT INTO task_dispatches (task_id, task_type, target, queue_at) VALUES
    ('auto:early', 'profile_gap', '{"name":"早"}', '2025-01-01'), ('auto:late', 'profile_gap', '{"name":"晚"}', '2025-06-01')`);
}
const head = async (d: PGlite) => (await d.query<{ j: any }>(`SELECT console_queue_state() AS j`)).rows[0]!.j.head as any[];
const pool = async (d: PGlite) =>
  (await d.query<{ id: string }>(`SELECT id FROM contribution_verify_pool('net-me', NULL, 30, NULL, NULL, 'bot', NULL, false)`)).rows.map((r) => Number(r.id.slice(-2)));
// head 沒有回 task_id，用 (verify_rank, queue_at) 對回票號
const ticketNo = (x: any) => TICKETS.find(([, r, at]) => r === x.verify_rank && String(x.queue_at).startsWith(at))![0];
const headVerifyNos = (h: any[]) => h.filter((x) => x.kind === "verify").map(ticketNo);

Deno.test("head：驗證票全部先於任務（任務 queue_at 再早也排後面）；任務之間照 queue_at", async () => {
  const d = await db();
  await seed(d);
  const h = await head(d);
  assertEquals(h.map((x) => x.kind), ["verify", "verify", "verify", "verify", "verify", "verify", "task", "task"]);
  assertEquals(h.map((x) => x.pos), [1, 2, 3, 4, 5, 6, 7, 8]);
  assertEquals(h.slice(6).map((x) => x.subject), ["早", "晚"]);
  await d.close();
});

Deno.test("head：驗證列的順序 ＝ contribution_verify_pool 的順序（逐案比對）；帶 verify_rank，任務列為 null", async () => {
  const d = await db();
  await seed(d);
  const h = await head(d);
  assertEquals(await pool(d), [6, 5, 3, 4, 2, 1]);
  assertEquals(headVerifyNos(h), await pool(d));
  assertEquals(h.filter((x) => x.kind === "verify").map((x) => x.verify_rank), [0, 1, 1, 2, 3, 5]);
  assertEquals(h.filter((x) => x.kind === "task").map((x) => x.verify_rank), [null, null]);
  await d.close();
});

Deno.test("head：同階同 queue_at 時 task_id 定勝負，兩邊一致", async () => {
  const d = await db();
  for (const n of [9, 7, 8]) {
    await d.query(`INSERT INTO contributions (id, contribution_type, status, score, target_score) VALUES ($1, 'policy', 'pending', 0, 3)`, [cid(n)]);
    await d.query(`INSERT INTO task_dispatches (task_id, queue_at, verify_rank, dispatch_count) VALUES ($1, '2026-05-05', 2, $2)`, [`verify:${cid(n)}`, n]);
  }
  assertEquals(await pool(d), [7, 8, 9]);
  // head 的 dispatch_count 帶了票號，借它對回
  assertEquals((await head(d)).map((x) => x.dispatch_count), [7, 8, 9]);
  await d.close();
});

Deno.test("可派條件不變：分數已到目標的驗證票不進 head；舊欄位都在、只多 verify_rank", async () => {
  const d = await db();
  await seed(d);
  await d.query(`UPDATE contributions SET score = 5 WHERE id = $1`, [cid(6)]);
  const h = await head(d);
  assertEquals(h.filter((x) => x.kind === "verify").length, 5);
  for (const k of ["pos", "kind", "task_type", "source", "status", "subject", "queue_at", "dispatch_count", "last_dispatched_at", "verify_rank"]) assert(k in h[0], k);
  await d.close();
});

Deno.test("migration：可重跑（第二次不動）、替換前提變了就明確報錯、池子與 head 的排序鍵相同", async () => {
  const d = await db();
  await d.exec(MIG); // 第二次：已替換過，直接返回
  await d.close();
  const broken = new PGlite();
  let err = "";
  try {
    await broken.exec(`CREATE ROLE anon; CREATE FUNCTION console_queue_state() RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;`);
    await broken.exec(MIG);
  } catch (e) {
    err = String(e);
  }
  assertStringIncludes(err, "現行定義變了");
  assertStringIncludes(POOL_MIG, ORDER_BY); // 池子的排序鍵
  assertStringIncludes(MIG, HEAD_ORDER); // head：驗證先於任務（tie），其後同一組鍵
  const code = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!code.includes("policy_jp."), "日本站不跟");
});

Deno.test("還原驗證：head 排序改回只看 queue_at，驗證先於任務與順序＝池子都紅", async () => {
  const old = MIG.replace(HEAD_ORDER, "OVER (ORDER BY m.queue_at, m.tie, m.task_id)::INTEGER AS pos");
  assert(old !== MIG);
  const d = await db(old);
  await seed(d);
  const h = await head(d);
  assertEquals(h[0].kind, "task", "只看 queue_at：最早的任務排在驗證票前面");
  assert(JSON.stringify(headVerifyNos(h)) !== JSON.stringify(await pool(d)), "只看 queue_at：驗證順序跟池子對不上");
  await d.close();
});
