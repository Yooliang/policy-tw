/**
 * 主控台「派工隊列」頁的資料 console_queue_state()（migration 20261017000201）。
 *   - 非驗證列依序只落進一個狀態：blocked → cooling → dead_end → saturated → question_full → ready（先符合先贏）
 *   - 冷卻只看 queue_at >= 2000（比 2000 早的是插隊列，照常算）
 *   - 隊頭不含 blocked／cooling，pos 是 (queue_at, task_id) 的名次；first_ready_pos 是第一個 ready 的名次
 *   - 24 小時實際派出一定要 dispatch_count > 0（seed 也會動 last_dispatched_at）
 *   還原驗證：把 dispatch_count > 0 拿掉，沒派過的列就會算進 24 小時
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { readMig } from "./arms-pglite.ts";

const SQL = await readMig("20261017000201_console_queue_state.sql");
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const QID = "33333333-3333-4333-8333-333333333333";

async function db(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, task_type text, target jsonb, queue_at timestamptz,
      dispatch_count int DEFAULT 0, last_dispatched_at timestamptz, blocked boolean DEFAULT false, cooling boolean DEFAULT false);
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text, task_type text, target jsonb);
    CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count int);
    CREATE TABLE contributions (id int PRIMARY KEY, contribution_type text, task_id text, status text, payload jsonb DEFAULT '{}',
      score numeric DEFAULT 0, target_score numeric, voter_ips int DEFAULT 0);
    CREATE FUNCTION question_answer_cap() RETURNS int LANGUAGE sql AS $f$ SELECT 3 $f$;
    CREATE FUNCTION contribution_effective_agree(i int) RETURNS numeric LANGUAGE sql AS $f$ SELECT 2::numeric $f$;
    CREATE FUNCTION contribution_needs_two_ips(t text, p jsonb) RETURNS boolean LANGUAGE sql AS $f$ SELECT false $f$;
    INSERT INTO contribution_tasks VALUES ('${U1}', 'web_request', 'policy_missing', '{}'), ('${U2}', 'manual', 'question', '{"question_id":"${QID}"}');
    INSERT INTO citizen_questions VALUES ('${QID}', 3);
    INSERT INTO task_dispatches (task_id, task_type, target, queue_at, dispatch_count, last_dispatched_at, blocked, cooling) VALUES
      ('auto:a:blocked', 'profile_gap', '{"name":"甲"}', '2026-01-01', 0, NULL, true, true),
      ('auto:a:cool',    'profile_gap', '{"name":"乙"}', '2026-10-30', 0, NULL, false, true),
      ('auto:a:cool_front', 'profile_gap', '{"name":"丙"}', '1970-01-01', 0, NULL, false, true),
      ('auto:a:dead',    'profile_gap', '{"name":"丁"}', '2026-01-02', 0, NULL, false, false),
      ('auto:a:sat',     'profile_gap', '{"name":"戊"}', '2026-01-03', 0, NULL, false, false),
      ('${U2}',          'question',    '{"title":"題","question_id":"${QID}"}', '2026-01-04', 0, NULL, false, false),
      ('auto:a:ready',   'profile_gap', '{"name":"己"}', '2026-01-05', 2, now() - interval '30 minutes', false, false),
      ('${U1}',          'policy_missing', '{"title":"庚"}', '2026-01-06', 0, now(), false, false),
      ('verify:1', NULL, NULL, '2026-01-01', 1, now(), false, false),
      ('verify:2', NULL, NULL, '2026-01-01', 0, now(), false, false);
    INSERT INTO contributions (id, contribution_type, task_id, status, payload, score, target_score) VALUES
      (1, 'policy', 'x', 'pending', '{}', 0, 2), (2, 'policy', 'x', 'pending', '{}', 5, 2),
      (10, 'no_change', 'auto:a:dead', 'pending', '{"task_id":"auto:a:dead"}', 0, 2),
      (20, 'policy', 'auto:a:sat', 'pending', '{}', 0, 2), (21, 'policy', 'auto:a:sat', 'verified', '{}', 0, 2),
      (22, 'policy', 'auto:a:sat', 'disputed', '{}', 0, 2), (23, 'policy', 'auto:a:sat', 'pending', '{}', 0, 2),
      (24, 'policy', 'auto:a:sat', 'verified', '{}', 0, 2);
  `);
  await d.exec(SQL);
  return d;
}
const run = async (d: PGlite) => (await d.query<{ j: any }>(`SELECT console_queue_state() AS j`)).rows[0].j;

Deno.test("狀態先符合先贏，來源分自動與手動", async () => {
  const d = await db();
  const j = await run(d);
  const st = Object.fromEntries(j.by_type.map((r: any) => [`${r.source}/${r.task_type}/${r.status}`, r.n]));
  assertEquals(st, {
    "auto/profile_gap/blocked": 1, "auto/profile_gap/cooling": 1, "auto/profile_gap/ready": 2, // 己，加上 1970 的插隊列（冷卻不算）
    "auto/profile_gap/dead_end": 1, "auto/profile_gap/saturated": 1,
    "manual/question/question_full": 1, "web_request/policy_missing/ready": 1,
  } as any);
  await d.close();
});

Deno.test("隊頭：不含 blocked／冷卻，名次連續；first_ready_pos；實際派出要 dispatch_count > 0", async () => {
  const d = await db();
  const j = await run(d);
  // 插隊列的冷卻（1970）算 ready，排第一；其餘依 queue_at：dead、sat、question_full、ready、policy_missing
  assertEquals(j.head.map((h: any) => [h.pos, h.status]), [[1, "ready"], [2, "dead_end"], [3, "saturated"], [4, "question_full"], [5, "ready"], [6, "ready"]]);
  assertEquals(j.first_ready_pos, 1);
  assertEquals(j.head[0].subject, "丙");
  assertEquals(j.dispatched_24h, [{ n: 1, kind: "auto", task_type: "profile_gap" }, { n: 1, kind: "verify", task_type: "verify" }]);
  await d.close();
});

Deno.test("驗證佇列與可派數；年齡分桶只算 ready", async () => {
  const d = await db();
  const j = await run(d);
  assertEquals(j.verify, { total: 2, eligible: 1, by_type: [{ contribution_type: "policy", n: 2, eligible: 1 }] });
  assertEquals(j.age_buckets, { never: 2, lt_1h: 1, h1_6: 0, h6_24: 0, d1_3: 0, gt_3d: 0 });
  await d.close();
});

Deno.test("權限：SECURITY DEFINER、不給 PUBLIC", () => {
  assertStringIncludes(SQL, "SECURITY DEFINER");
  assertStringIncludes(SQL, "REVOKE ALL ON FUNCTION console_queue_state() FROM PUBLIC");
  assertStringIncludes(SQL, "GRANT EXECUTE ON FUNCTION console_queue_state() TO anon, authenticated, service_role");
});
