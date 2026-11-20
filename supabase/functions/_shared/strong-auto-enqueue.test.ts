// 強模型任務自動排入作業（20261120110000）守門：
//  A 規則與 enqueue_all 對照（常數同一份）；B SQL 行為（PGlite 真跑）：排入／busy／returned／retry_cap／最舊先與上限／開關／唯一索引；
//  C migration 結構（排程、權限、與手動排入同形狀的列）。
// 還原驗證：拿掉函式裡的 returned 條件、retry_cap 條件、或 busy 條件，對應項會紅。
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { readMig } from "./arms-pglite.ts";
import { ENQUEUE_ALL_MAX_JOBS_PER_TASK, RECENT_WINDOW_MIN } from "./strong-adjudicate.ts";

const MIG = "20261120110000_strong_adjudications_auto_enqueue.sql";
const CID = (n: number) => `00000000-0000-4000-8000-0000000000c${n}`;

async function mkDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE contributions (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'pending');
    CREATE TABLE strong_lane_settings (id smallint PRIMARY KEY CHECK (id = 1), enabled boolean NOT NULL DEFAULT true, stale_dispute_days int NOT NULL DEFAULT 3, note text);
    INSERT INTO strong_lane_settings (id) VALUES (1);
    CREATE TABLE strong_adjudications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text NOT NULL, contribution_id text,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','previewed','finalizing','finalized','finalize_failed','returned','failed')),
      requested_by text NOT NULL, claimed_by text, claimed_at timestamptz, completed_at timestamptz, last_error text, claim_failures int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX strong_adjudications_one_active_per_task ON strong_adjudications (task_id) WHERE status IN ('queued','running');`);
  const sql = await readMig(MIG);
  const alter = sql.split("\n").filter((l) => l.startsWith("ALTER TABLE strong_lane_settings")).join("\n");
  assertEquals(alter.split("ALTER TABLE").length - 1, 2);
  await db.exec(alter);
  const i = sql.indexOf("-- >>> BEGIN auto_enqueue");
  const j = sql.indexOf("-- <<< END auto_enqueue");
  assert(i > 0 && j > i);
  await db.exec(sql.slice(i, j));
  return db;
}

/** 開一件強模型任務；ageMin＝開出幾分鐘前（越大越舊） */
async function task(db: PGlite, n: number, ageMin = 0): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO contribution_tasks (task_type, target, created_at) VALUES ('adjudicate', $1::jsonb, now() - ($2 || ' minutes')::interval) RETURNING id`,
    [JSON.stringify({ contribution_id: CID(n), requires_tier: "strong" }), String(ageMin)]);
  return r.rows[0].id;
}
const job = (db: PGlite, taskId: string, status: string, completedAgoMin: number | null = null, createdAgoMin = 600) => db.query(
  `INSERT INTO strong_adjudications (task_id, status, requested_by, completed_at, created_at) VALUES ($1, $2, 'someone@example.com', CASE WHEN $3::int IS NULL THEN NULL ELSE now() - ($3 || ' minutes')::interval END, now() - ($4 || ' minutes')::interval)`,
  [taskId, status, completedAgoMin, String(createdAgoMin)]);
const run = async (db: PGlite, lim?: number) => (await db.query<{ n: number }>(`SELECT strong_adjudications_auto_enqueue(${lim === undefined ? "" : lim}) AS n`)).rows[0].n;
const queuedIds = async (db: PGlite) => (await db.query<{ task_id: string }>(`SELECT task_id FROM strong_adjudications WHERE requested_by = 'auto-enqueue' ORDER BY created_at, task_id`)).rows.map((r) => r.task_id);

Deno.test("A 規則常數與 enqueue_all 同一份（30 分鐘剛出爐窗、每件最多 2 筆）", async () => {
  const sql = await readMig(MIG);
  assertEquals(RECENT_WINDOW_MIN, 30);
  assertEquals(ENQUEUE_ALL_MAX_JOBS_PER_TASK, 2);
  assertStringIncludes(sql, `interval '${RECENT_WINDOW_MIN} minutes'`);
  assertStringIncludes(sql, `< ${ENQUEUE_ALL_MAX_JOBS_PER_TASK}\n`);
  for (const s of ["'queued', 'running'", "'previewed', 'finalizing'", "COALESCE(a.completed_at, a.created_at)", "<> 'returned'", "ORDER BY t.created_at"]) assertStringIncludes(sql, s);
});

Deno.test("B1 排入沒有作業的任務：列形狀與手動排入一致（queued、只填 task_id／contribution_id／requested_by）", async () => {
  const db = await mkDb();
  const t1 = await task(db, 1);
  assertEquals(await run(db), 1);
  const r = (await db.query<Record<string, unknown>>(`SELECT * FROM strong_adjudications WHERE task_id = $1`, [t1])).rows[0];
  assertEquals([r.status, r.contribution_id, r.requested_by], ["queued", CID(1), "auto-enqueue"]);
  for (const k of ["claimed_by", "claimed_at", "completed_at", "last_error"]) assertEquals(r[k], null, k);
  assertEquals(r.claim_failures, 0);
  assertEquals(await run(db), 0, "重跑不重複排（已有 queued）");
});

Deno.test("B2 busy／returned／retry_cap 跳過；舊的失敗可再排一次；非強模型與已結案任務不碰", async () => {
  const db = await mkDb();
  const busyQ = await task(db, 1); await job(db, busyQ, "running", null, 5);
  const busyP = await task(db, 2); await job(db, busyP, "previewed", 10); // 10 分鐘前出爐：busy
  const oldP = await task(db, 3); await job(db, oldP, "previewed", 120); // 兩小時前出爐：可再排
  const ret = await task(db, 4); await job(db, ret, "failed", null, 300); await job(db, ret, "returned", 5, 10); // 最新是 returned
  const cap = await task(db, 5); await job(db, cap, "failed", null, 300); await job(db, cap, "finalize_failed", 100, 200); // 已 2 筆
  const retry1 = await task(db, 6); await job(db, retry1, "finalize_failed", 100, 200); // 1 筆失敗：可再排
  const olderRet = await task(db, 7); await job(db, olderRet, "returned", 200, 400); await job(db, olderRet, "failed", null, 10); // 最舊是 returned、最新是 failed：未被 returned 擋，但累計 2 筆被 retry_cap 擋
  await db.query(`INSERT INTO contribution_tasks (task_type, target) VALUES ('adjudicate', '{"contribution_id":"x"}')`); // 沒標 strong
  await db.query(`INSERT INTO contribution_tasks (task_type, target, status) VALUES ('adjudicate', '{"contribution_id":"y","requires_tier":"strong"}', 'closed')`);
  assertEquals(await run(db), 2);
  assertEquals((await queuedIds(db)).sort(), [oldP, retry1].sort());
  assert(!(await queuedIds(db)).includes(olderRet));
  assertEquals(await run(db), 0);
});

Deno.test("B3 最舊先、每輪上限；p_limit 非法拒絕", async () => {
  const db = await mkDb();
  const ids: string[] = [];
  for (let n = 1; n <= 5; n++) ids.push(await task(db, n, n * 10)); // n 越大越舊
  assertEquals(await run(db, 2), 2);
  // 選中的是最舊的兩件（PGlite 的 clock_timestamp 是毫秒級，同批列的先後不在此斷言，只比集合）
  assertEquals((await queuedIds(db)).sort(), [ids[4], ids[3]].sort());
  assertEquals(await run(db), 3, "預設上限 20：剩下全排");
  assertEquals((await queuedIds(db)).length, 5);
  for (const bad of [0, 201, -1]) {
    let msg = "";
    try { await run(db, bad); } catch (e) { msg = String(e); }
    assertStringIncludes(msg, "1～200", String(bad));
  }
});

Deno.test("B4 設定：auto_enqueue_limit 生效；auto_enqueue_enabled=false 或總開關 enabled=false 回 0", async () => {
  const db = await mkDb();
  for (let n = 1; n <= 4; n++) await task(db, n, n);
  await db.exec(`UPDATE strong_lane_settings SET auto_enqueue_limit = 3`);
  assertEquals(await run(db), 3);
  await db.exec(`UPDATE strong_lane_settings SET auto_enqueue_enabled = false`);
  assertEquals(await run(db), 0);
  await db.exec(`UPDATE strong_lane_settings SET auto_enqueue_enabled = true, enabled = false`);
  assertEquals(await run(db), 0);
  await db.exec(`UPDATE strong_lane_settings SET enabled = true`);
  assertEquals(await run(db), 1);
  let rejected = false;
  try { await db.exec(`UPDATE strong_lane_settings SET auto_enqueue_limit = 0`); } catch { rejected = true; }
  assert(rejected, "limit 下限 1 的 CHECK");
});

Deno.test("C migration 結構：排程每 10 分鐘、帶逾時、只給 service_role、SECURITY DEFINER", async () => {
  const sql = await readMig(MIG);
  assertStringIncludes(sql, "cron.schedule('strong-adjudications-auto-enqueue-10min', '6-59/10 * * * *'");
  assertStringIncludes(sql, "SET statement_timeout TO ''60s''; SELECT strong_adjudications_auto_enqueue();");
  assertStringIncludes(sql, "SECURITY DEFINER SET search_path = public, pg_temp");
  assertStringIncludes(sql, "REVOKE ALL ON FUNCTION strong_adjudications_auto_enqueue(INTEGER) FROM PUBLIC, anon, authenticated");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION strong_adjudications_auto_enqueue(INTEGER) TO service_role");
  assertStringIncludes(sql, "auto_enqueue_enabled BOOLEAN NOT NULL DEFAULT true");
  assertStringIncludes(sql, "auto_enqueue_limit INTEGER NOT NULL DEFAULT 20");
});
