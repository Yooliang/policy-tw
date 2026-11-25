// 強模型待辦 list／sweep／auto_enqueue 對「原貢獻還活著」對齊（20261125020000）守門：
//  A 共用判斷：pending／disputed／查不到→true，其餘→false；
//  B strong_lane_list：已結案不列、有作業在等的照列、stalled_reason 與 job 欄位；
//  C strong_lane_sweep：收殭屍（記 closed_reason）、有作業在等的不收、冪等；
//  D strong_adjudications_auto_enqueue：改用共用判斷後，行為與 20261120110000 版一致（已結案不排、其餘照排）；
//  E 結構：auto_enqueue 本體只比 20261120110000 版多換一處子查詢；sweep 說明帶更正規則；list 的公開權限不變。
// 還原驗證：把 sweep 的收殭屍段拿掉、或 list 的 live 條件拿掉，B／C 對應項會紅。
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { readMig } from "./arms-pglite.ts";

const MIG = "20261125020000_strong_lane_align.sql";
const OLD_ENQ = "20261120110000_strong_adjudications_auto_enqueue.sql";
const id = (c: string) => `00000000-0000-4000-8000-00000000000${c}`;
const tid = (c: string) => `10000000-0000-4000-8000-00000000000${c}`;

async function mkDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
    CREATE TABLE policies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, payload jsonb NOT NULL DEFAULT '{}', source_urls text[], agent_name text, status text,
      review_notes text, agree_count int NOT NULL DEFAULT 0, disagree_count int NOT NULL DEFAULT 0, unsure_count int NOT NULL DEFAULT 0,
      needs_identity_pick boolean NOT NULL DEFAULT false, needs_identity_pick_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE contribution_votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_id uuid, verdict text, agent_name text, agent_tool text, note text, evidence_url text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, description text, task_type text, target jsonb, priority int, reward int,
      status text, source text, created_by text, hint_sources text[], closed_at timestamptz, closed_reason text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE queue_settings (id int PRIMARY KEY, identity_pick_timeout_days int);
    CREATE TABLE strong_adjudications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text NOT NULL, contribution_id text, status text NOT NULL DEFAULT 'queued',
      requested_by text NOT NULL DEFAULT 'x', report_response jsonb, error text, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX strong_adjudications_one_active_per_task ON strong_adjudications (task_id) WHERE status IN ('queued','running');
    CREATE TABLE strong_lane_settings (id smallint PRIMARY KEY CHECK (id = 1), enabled boolean NOT NULL DEFAULT true, stale_dispute_days int NOT NULL DEFAULT 3, note text,
      auto_enqueue_enabled boolean NOT NULL DEFAULT true, auto_enqueue_limit int NOT NULL DEFAULT 20);
    INSERT INTO strong_lane_settings (id) VALUES (1);
    CREATE FUNCTION contribution_overvoted_flag_votes() RETURNS numeric LANGUAGE sql AS $$ SELECT 5::numeric $$;
    CREATE FUNCTION contribution_overvoted_stop_votes() RETURNS numeric LANGUAGE sql AS $$ SELECT 9::numeric $$;
    CREATE FUNCTION contribution_subject_politician(p jsonb) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION uuid_or_null(t text) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`);
  await db.exec(await readMig(MIG));
  return db;
}

/** 開一件強模型任務；cStatus＝原貢獻狀態（null＝不建原貢獻，模擬查不到） */
async function mk(db: PGlite, c: string, cStatus: string | null) {
  if (cStatus) await db.query(`INSERT INTO contributions (id, contribution_type, status, payload) VALUES ($1, 'policy', $2, $3::jsonb)`, [id(c), cStatus, JSON.stringify({ title: `T${c}` })]);
  await db.query(`INSERT INTO contribution_tasks (id, task_type, status, target) VALUES ($1, 'adjudicate', 'open', $2::jsonb)`,
    [tid(c), JSON.stringify({ contribution_id: id(c), requires_tier: "strong" })]);
}
const job = (db: PGlite, c: string, status: string, agoMin = 60, err: string | null = null) => db.query(
  `INSERT INTO strong_adjudications (task_id, status, report_response, created_at) VALUES ($1, $2, $3::jsonb, now() - ($4 || ' minutes')::interval)`,
  [tid(c), status, err ? JSON.stringify({ error: err }) : null, String(agoMin)]);
type Item = { task_id: string; stalled_reason: string | null; job_count: number; last_job_status: string | null; last_job_error: string | null };
const list = async (db: PGlite) => (await db.query<{ l: { total: number; items: Item[] } }>(`SELECT strong_lane_list() AS l`)).rows[0].l;
const byTask = (l: { items: Item[] }) => Object.fromEntries(l.items.map((i) => [i.task_id.slice(-1), i]));

Deno.test("A 共用判斷：pending／disputed／查不到→true，已結案→false", async () => {
  const db = await mkDb();
  for (const [c, s] of [["1", "pending"], ["2", "disputed"], ["3", "applied"], ["4", "rejected"]]) await db.query(`INSERT INTO contributions (id, status) VALUES ($1, $2)`, [id(c), s]);
  const live = async (c: string) => (await db.query<{ v: boolean }>(`SELECT strong_lane_contribution_live($1) AS v`, [id(c)])).rows[0].v;
  assertEquals([await live("1"), await live("2"), await live("3"), await live("4"), await live("9")], [true, true, false, false, true]);
  assertEquals((await db.query<{ v: boolean }>(`SELECT strong_lane_contribution_live(NULL) AS v`)).rows[0].v, true);
});

Deno.test("B list：已結案不列（total 同步）、有作業在等的照列、卡住原因與作業欄位", async () => {
  const db = await mkDb();
  await mk(db, "a", "applied");                                   // 殭屍：不列
  await mk(db, "b", "pending");                                   // 兩筆 finalize_failed：卡住
  await job(db, "b", "finalize_failed", 120, "correction_invalid"); await job(db, "b", "finalize_failed", 60, "correction_invalid");
  await mk(db, "c", "pending");                                   // 沒作業：正常
  await mk(db, "d", "applied"); await job(db, "d", "previewed", 5); // 已結案但作業在等定案：照列
  await mk(db, "e", "pending"); await job(db, "e", "failed", 120); // 一筆失敗：還能再排，不算卡住
  await mk(db, "f", "pending"); await job(db, "f", "returned", 5); // 退回人工
  await mk(db, "1", "pending"); await job(db, "1", "failed", 120); await job(db, "1", "failed", 60); // 失敗 2 次
  await mk(db, "2", null);                                        // 查不到原貢獻
  const l = await list(db);
  const m = byTask(l);
  assertEquals(l.total, 7);
  assertEquals(Object.keys(m).sort(), ["1", "2", "b", "c", "d", "e", "f"]);
  assertEquals(m.a, undefined);
  assertEquals([m.b.stalled_reason, m.b.job_count, m.b.last_job_status, m.b.last_job_error], ["retry_cap_finalize_failed", 2, "finalize_failed", "correction_invalid"]);
  assertEquals(m.c.stalled_reason, null);
  assertEquals(m.d.stalled_reason, null);
  assertEquals(m.e.stalled_reason, null);
  assertEquals(m.f.stalled_reason, "returned_to_human");
  assertEquals(m["1"].stalled_reason, "retry_cap_failed");
  assertEquals(m["2"].stalled_reason, "contribution_missing");
});

Deno.test("C sweep 收殭屍：已結案且沒作業在等的關掉並記原因；有作業在等的不動；冪等", async () => {
  const db = await mkDb();
  await mk(db, "a", "applied"); await mk(db, "b", "rejected"); await mk(db, "c", "pending");
  await mk(db, "d", "applied"); await job(db, "d", "previewed", 5);
  await db.query(`SELECT strong_lane_sweep()`);
  const rows = (await db.query<{ k: string; status: string; closed_reason: string | null; closed: boolean }>(
    `SELECT right(id::text, 1) AS k, status, closed_reason, closed_at IS NOT NULL AS closed FROM contribution_tasks ORDER BY id`)).rows;
  const m = Object.fromEntries(rows.map((r) => [r.k, r]));
  assertEquals([m.a.status, m.a.closed_reason, m.a.closed], ["closed", "contribution_resolved:applied", true]);
  assertEquals([m.b.status, m.b.closed_reason], ["closed", "contribution_resolved:rejected"]);
  assertEquals([m.c.status, m.c.closed_reason], ["open", null]);
  assertEquals([m.d.status, m.d.closed_reason], ["open", null]);
  const before = (await db.query<{ at: string }>(`SELECT closed_at::text AS at FROM contribution_tasks WHERE id = $1`, [tid("a")])).rows[0].at;
  await db.query(`SELECT strong_lane_sweep()`);
  assertEquals((await db.query<{ at: string }>(`SELECT closed_at::text AS at FROM contribution_tasks WHERE id = $1`, [tid("a")])).rows[0].at, before, "重跑不重關");
  assertEquals((await list(db)).total, 2);
});

Deno.test("C2 sweep 開出的新任務說明帶更正規則（④）", async () => {
  const db = await mkDb();
  await db.query(`INSERT INTO contributions (id, contribution_type, status, payload, agree_count) VALUES ($1, 'policy', 'pending', '{"title":"X"}', 20)`, [id("3")]);
  const n = (await db.query<{ n: number }>(`SELECT strong_lane_sweep() AS n`)).rows[0].n;
  assertEquals(n, 1);
  const d = (await db.query<{ description: string }>(`SELECT description FROM contribution_tasks WHERE target->>'requires_tier' = 'strong'`)).rows[0].description;
  assertStringIncludes(d, "④corrected_fields");
  assertStringIncludes(d, "至少 20 字");
});

Deno.test("D auto_enqueue：已結案不排、其餘照排（查不到原貢獻也排）；重跑不重複", async () => {
  const db = await mkDb();
  await mk(db, "a", "applied"); await mk(db, "b", "pending"); await mk(db, "c", "disputed"); await mk(db, "2", null);
  assertEquals((await db.query<{ n: number }>(`SELECT strong_adjudications_auto_enqueue() AS n`)).rows[0].n, 3);
  const ids = (await db.query<{ k: string }>(`SELECT right(task_id, 1) AS k FROM strong_adjudications ORDER BY task_id`)).rows.map((r) => r.k);
  assertEquals(ids, ["2", "b", "c"]);
  assertEquals((await db.query<{ n: number }>(`SELECT strong_adjudications_auto_enqueue() AS n`)).rows[0].n, 0);
});

Deno.test("E 結構：auto_enqueue 本體只比 20261120110000 版多換一處；list 公開、auto_enqueue／sweep 不公開", async () => {
  const mig = await readMig(MIG);
  const old = await readMig(OLD_ENQ);
  const body = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to));
  const oldFn = body(old, "DECLARE", "END;\n$$;").trim();
  const newFn = body(mig, "DECLARE", "END;\n$fn$;").trim();
  const strip = (s: string) => s.split("\n").filter((l) => !/原貢獻已被一般驗證結案|strong_lane_contribution_live|c\.status NOT IN \('pending', 'disputed'\)/.test(l)).join("\n");
  assertEquals(strip(newFn), strip(oldFn), "除了「原貢獻已結案」那一條，其餘邏輯逐行相同");
  assertStringIncludes(newFn, "AND strong_lane_contribution_live(t.target->>'contribution_id')");
  assertStringIncludes(mig, "GRANT EXECUTE ON FUNCTION strong_lane_list() TO anon, authenticated, service_role;");
  assertStringIncludes(mig, "GRANT EXECUTE ON FUNCTION strong_adjudications_auto_enqueue(INTEGER) TO service_role;");
  assert(!/GRANT EXECUTE ON FUNCTION strong_adjudications_auto_enqueue[^;]*anon/.test(mig));
});
