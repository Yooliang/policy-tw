/**
 * 主控台「派工隊列」頁的資料 console_queue_state()（migration 20261017000201；2026-10-17 第二步改成 20261017010100：隊頭任務與驗證票合成一條、另列停放中）。
 *   - 非驗證列依序只落進一個狀態：blocked → cooling → parked → dead_end → saturated → question_full → ready（先符合先贏）
 *   - parked＝有在途交件（task_id 欄或 payload.task_id）且不是三個不停放的型別（question、adjudicate、roster_check）；停放中的列不進隊頭、另列 parked
 *   - 冷卻只看 queue_at >= 2000（比 2000 早的是插隊列，照常算）
 *   - 隊頭＝任務（不含 blocked／cooling／parked）與可派的驗證票照 /next 順序合成：queue_at，同一刻驗證票先；每列 kind；pos 是合成後的名次；first_ready_pos 是第一個 ready
 *   - 24 小時實際派出一定要 dispatch_count > 0（seed 也會動 last_dispatched_at）
 *   - 舊欄位（by_type、verify、dispatched_24h、age_buckets、head 的原有欄位）形狀不變，新欄位只加不減
 *   還原驗證：把 dispatch_count > 0 拿掉，沒派過的列就會算進 24 小時；把停放那一條拿掉，停放中的任務又回到隊頭；驗證票不合進隊頭
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, mutate, readMig } from "./arms-pglite.ts";

const SQL = await readMig("20261017010100_console_queue_state_merged.sql");
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const QID = "33333333-3333-4333-8333-333333333333";

async function db(sql = SQL): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, task_type text, target jsonb, queue_at timestamptz,
      dispatch_count int DEFAULT 0, last_dispatched_at timestamptz, blocked boolean DEFAULT false, cooling boolean DEFAULT false, verify_target int);
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, source text, task_type text, target jsonb);
    CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count int);
    CREATE TABLE contributions (id int PRIMARY KEY, contribution_type text, task_id text, status text, payload jsonb DEFAULT '{}',
      score numeric DEFAULT 0, target_score numeric, voter_ips int DEFAULT 0);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text);
    CREATE TABLE policies (id uuid PRIMARY KEY, title text);
    ${await latestFn("uuid_or_null")}
    CREATE FUNCTION contribution_subject_politician(p jsonb) RETURNS uuid LANGUAGE sql AS $f$ SELECT NULL::uuid $f$;
    CREATE FUNCTION question_answer_cap() RETURNS int LANGUAGE sql AS $f$ SELECT 3 $f$;
    CREATE FUNCTION contribution_effective_agree(i int) RETURNS numeric LANGUAGE sql AS $f$ SELECT 2::numeric $f$;
    CREATE FUNCTION contribution_needs_two_ips(t text, p jsonb) RETURNS boolean LANGUAGE sql AS $f$ SELECT false $f$;
    INSERT INTO contribution_tasks VALUES ('${U1}', 'web_request', 'policy_missing', '{}'), ('${U2}', 'manual', 'question', '{"question_id":"${QID}"}');
    INSERT INTO citizen_questions VALUES ('${QID}', 3);
    INSERT INTO task_dispatches (task_id, task_type, target, queue_at, dispatch_count, last_dispatched_at, blocked, cooling) VALUES
      ('auto:a:blocked', 'profile_gap', '{"name":"甲"}', '2026-01-01', 0, NULL, true, true),
      ('auto:a:cool',    'profile_gap', '{"name":"乙"}', '2026-10-30', 0, NULL, false, true),
      ('auto:a:cool_front', 'profile_gap', '{"name":"丙"}', '1970-01-01', 0, NULL, false, true),
      ('auto:a:dead',    'roster_check', '{"name":"丁"}', '2026-01-02', 0, NULL, false, false),
      ('auto:a:sat',     'roster_check', '{"name":"戊"}', '2026-01-03', 0, NULL, false, false),
      ('${U2}',          'question',    '{"title":"題","question_id":"${QID}"}', '2026-01-04', 0, NULL, false, false),
      ('auto:a:ready',   'profile_gap', '{"name":"己"}', '2026-01-05', 2, now() - interval '30 minutes', false, false),
      ('${U1}',          'policy_missing', '{"title":"庚"}', '2026-01-06', 0, now(), false, false),
      ('auto:a:park',    'profile_gap', '{"name":"辛"}', '2026-01-02', 1, now() - interval '2 days', false, false),
      ('auto:a:parkpay', 'profile_gap', '{"name":"壬"}', '2026-01-03', 1, now() - interval '2 days', false, false),
      ('verify:1', NULL, NULL, '2026-01-01', 1, now(), false, false),
      ('verify:2', NULL, NULL, '2026-01-01', 0, now(), false, false),
      ('verify:3', NULL, NULL, '2026-01-05', 0, now(), false, false);
    INSERT INTO contributions (id, contribution_type, task_id, status, payload, score, target_score) VALUES
      (1, 'policy', 'x', 'pending', '{}', 0, 2), (2, 'policy', 'x', 'pending', '{}', 5, 2),
      (3, 'correction', 'x', 'pending', '{"name":"某人"}', 0, 2),
      (10, 'no_change', 'auto:a:dead', 'pending', '{"task_id":"auto:a:dead"}', 0, 2),
      (20, 'policy', 'auto:a:sat', 'pending', '{}', 0, 2), (21, 'policy', 'auto:a:sat', 'verified', '{}', 0, 2),
      (22, 'policy', 'auto:a:sat', 'disputed', '{}', 0, 2), (23, 'policy', 'auto:a:sat', 'pending', '{}', 0, 2),
      (24, 'policy', 'auto:a:sat', 'verified', '{}', 0, 2),
      (30, 'policy', 'auto:a:park', 'pending', '{}', 0, 2), (31, 'policy', 'auto:a:park', 'verified', '{}', 0, 2),
      (32, 'policy', 'auto:a:park', 'rejected', '{}', 0, 2),
      (40, 'correction', NULL, 'pending', '{"task_id":"auto:a:parkpay"}', 0, 2);
  `);
  await d.exec(sql);
  return d;
}
const run = async (d: PGlite) => (await d.query<{ j: any }>(`SELECT console_queue_state() AS j`)).rows[0].j;

Deno.test("狀態先符合先贏：停放中排在查無等票與額滿前面；三型不停放所以還看得到 dead_end／saturated；來源分自動與手動", async () => {
  const d = await db();
  const j = await run(d);
  const st = Object.fromEntries(j.by_type.map((r: any) => [`${r.source}/${r.task_type}/${r.status}`, r.n]));
  assertEquals(st, {
    "auto/profile_gap/blocked": 1, "auto/profile_gap/cooling": 1, "auto/profile_gap/ready": 2, // 己，加上 1970 的插隊列（冷卻不算）
    "auto/profile_gap/parked": 2, // 辛（task_id 欄有在途）、壬（任務編號只在 payload）
    "auto/roster_check/dead_end": 1, "auto/roster_check/saturated": 1,
    "manual/question/question_full": 1, "web_request/policy_missing/ready": 1,
  } as any);
  await d.close();
});

Deno.test("隊頭：任務與可派的驗證票合成一條，同一刻驗證票先；停放中、blocked、冷卻的不進；first_ready_pos 算在合成順序上", async () => {
  const d = await db();
  const j = await run(d);
  assertEquals(j.head.map((h: any) => [h.pos, h.kind, h.status]), [
    [1, "task", "ready"],          // 丙：插隊列（冷卻不算）
    [2, "verify", "ready"],        // verify:1（01-01，可派）
    [3, "task", "dead_end"],       // 丁
    [4, "task", "saturated"],      // 戊
    [5, "task", "question_full"],
    [6, "verify", "ready"],        // verify:3（01-05）與 己 同一刻：驗證票先
    [7, "task", "ready"],          // 己
    [8, "task", "ready"],          // 庚
  ]);
  assertEquals(j.first_ready_pos, 1);
  assertEquals(j.head[0].subject, "丙");
  // 驗證票那一列：型別是交件型別、source＝verify、subject 取 payload.name；verify:2（分數已到）不是可派的，不進隊頭
  assertEquals([j.head[1].task_type, j.head[1].source, j.head[1].subject], ["policy", "verify", ""]);
  assertEquals([j.head[5].task_type, j.head[5].source, j.head[5].subject], ["correction", "verify", "某人"]);
  assertEquals(j.head.filter((h: any) => h.kind === "verify").length, 2);
  assertEquals(j.dispatched_24h, [{ n: 1, kind: "auto", task_type: "profile_gap" }, { n: 1, kind: "verify", task_type: "verify" }]);
  await d.close();
});

Deno.test("first_ready_pos：隊頭前面都不是 ready 時，是第一個 ready 的名次（驗證票也算 ready）", async () => {
  const d = await db();
  await d.exec(`UPDATE task_dispatches SET queue_at = '2026-02-01' WHERE task_id = 'auto:a:cool_front'`); // 插隊列退到後面
  const j = await run(d);
  assertEquals(j.head[0].kind, "verify");
  assertEquals(j.first_ready_pos, 1, "驗證票排第一而且可派");
  await d.exec(`UPDATE contributions SET score = 5 WHERE id IN (1, 3)`); // 兩張可派的驗證票都到分了
  const k = await run(d);
  assertEquals(k.head.map((h: any) => h.kind), ["task", "task", "task", "task", "task"]); // 丁、戊、題、己、庚（丙退到後面變成「冷卻」，不進隊頭）
  assertEquals(k.first_ready_pos, 4, "丁、戊、題是被擋的，第一個 ready 是己（第 4 名）");
  await d.close();
});

Deno.test("停放中：另列 parked（任務、型別、對象、在途交件數、等幾張驗證票），parked_total 是全部筆數；rejected 不算在途", async () => {
  const d = await db();
  const j = await run(d);
  assertEquals(j.parked_total, 2);
  assertEquals(j.parked.map((p: any) => [p.task_id, p.task_type, p.source, p.subject, p.inflight, p.verify_waiting]), [
    ["auto:a:park", "profile_gap", "auto", "辛", 2, 1],      // pending＋verified 在途；rejected 不算；等票的只有 pending 那一份
    ["auto:a:parkpay", "profile_gap", "auto", "壬", 1, 1],   // 任務編號只在 payload.task_id
  ]);
  assertEquals(j.head.some((h: any) => h.pos && h.task_type === "profile_gap" && ["辛", "壬"].includes(h.subject)), false, "停放中的不進隊頭");
  await d.close();
});

Deno.test("舊欄位形狀不變（只加不減）：by_type、verify、dispatched_24h、age_buckets、head 的原有欄位都還在", async () => {
  const d = await db();
  const j = await run(d);
  for (const k of ["generated_at", "by_type", "verify", "head", "first_ready_pos", "dispatched_24h", "age_buckets"]) assertEquals(k in j, true, k);
  assertEquals(["parked", "parked_total"].every((k) => k in j), true);
  for (const k of ["pos", "task_type", "source", "status", "subject", "queue_at", "dispatch_count", "last_dispatched_at"]) assertEquals(k in j.head[0], true, k);
  assertEquals(j.verify, { total: 3, eligible: 2, by_type: [{ contribution_type: "policy", n: 2, eligible: 1 }, { contribution_type: "correction", n: 1, eligible: 1 }] });
  assertEquals(j.age_buckets, { never: 2, lt_1h: 1, h1_6: 0, h6_24: 0, d1_3: 0, gt_3d: 0 });
  await d.close();
});

Deno.test("還原驗證：拿掉停放那一條，停放中的任務就回到隊頭；驗證票不合進隊頭就少了 verify 列；拿掉 dispatch_count > 0，沒派過的列算進 24 小時", async () => {
  const noPark = await db(mutate(SQL, "             WHEN COALESCE(pk.n, 0) > 0 AND d.task_type NOT IN ('question', 'adjudicate', 'roster_check') THEN 'parked'\n", ""));
  const a = await run(noPark);
  assertEquals(a.parked_total, 0);
  assertEquals(a.head.some((h: any) => h.subject === "辛"), true, "沒有停放的條件：辛回到隊頭");
  await noPark.close();
  const noVerify = await db(mutate(SQL, "              FROM vt v WHERE v.ok) m", "              FROM vt v WHERE false) m"));
  assertEquals((await run(noVerify)).head.filter((h: any) => h.kind === "verify").length, 0);
  await noVerify.close();
  const noCount = await db(mutate(SQL, "     WHERE d.dispatch_count > 0 AND d.last_dispatched_at > now() - INTERVAL '24 hours'", "     WHERE d.last_dispatched_at > now() - INTERVAL '24 hours'"));
  const total = (await run(noCount)).dispatched_24h.reduce((s: number, r: any) => s + r.n, 0);
  assertEquals(total > 2, true, "沒派過但有 last_dispatched_at 的列被算進去了");
  await noCount.close();
});

Deno.test("權限：SECURITY DEFINER、不給 PUBLIC", () => {
  assertStringIncludes(SQL, "SECURITY DEFINER");
  assertStringIncludes(SQL, "REVOKE ALL ON FUNCTION console_queue_state() FROM PUBLIC");
  assertStringIncludes(SQL, "GRANT EXECUTE ON FUNCTION console_queue_state() TO anon, authenticated, service_role");
});

Deno.test("停放條件與派工 SQL 同一份：console 的 parked 條件＝contribution_queue_tasks 的「合格：任務停放」（三型例外、在途三種狀態）", async () => {
  const queue = await latestFn("contribution_queue_tasks");
  for (const frag of ["'question', 'adjudicate', 'roster_check'", "'pending', 'verified', 'disputed'"]) {
    assertStringIncludes(SQL, frag);
    assertStringIncludes(queue, frag);
  }
  assertStringIncludes(SQL, "COALESCE(c.task_id, c.payload->>'task_id')");
});
