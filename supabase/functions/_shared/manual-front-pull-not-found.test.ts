/**
 * 查無冷卻中的手動任務不被插隊秒數放出來（migration 20261107010000，PR #875 的漏網）。
 *   A. manual_front_pull：2 天內有 not_found 的不拉；沒有 / 超過 2 天的照拉（其餘行為不變）
 *   B. 出生觸發器：手動任務（uuid）出生時 2 天內有 not_found → 插隊秒數歸零；沒有查核、auto:、verify: 不動；UPDATE（維護者 /boost）不管
 *   C. 舊資料清理只動自動給的插隊值
 * 還原驗證：拿掉 manual_front_pull 的 NOT EXISTS、或 DROP 觸發器，A／B 必須紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const NAME = "20261107010000_manual_front_pull_skips_not_found_cooling.sql";
const SQL = (await Deno.readTextFile(new URL(`../../migrations/${NAME}`, import.meta.url))).replace(/\r\n/g, "\n");
const section = (a: string, b: string) => SQL.slice(SQL.indexOf(a), SQL.indexOf(b));

const T1 = "00000000-0000-0000-0000-000000000001"; // 2 天內查無
const T2 = "00000000-0000-0000-0000-000000000002"; // 3 天前查無（冷卻已過）
const T3 = "00000000-0000-0000-0000-000000000003"; // 沒查核

async function env(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE queue_settings (id int PRIMARY KEY, visitor_front_seconds bigint, manual_front_seconds bigint);
    INSERT INTO queue_settings VALUES (1, 315360000, 157680000);
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text, outcome text, checked_at timestamptz);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, boost_seconds bigint NOT NULL DEFAULT 0, dispatch_count int NOT NULL DEFAULT 0,
      last_dispatched_at timestamptz, cooling boolean NOT NULL DEFAULT false);
    CREATE FUNCTION task_not_found_cooldown_days() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;
    CREATE FUNCTION visitor_front_slot_start() RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() - interval '5 minutes' $$;
    CREATE FUNCTION contribution_auto_tasks_manual(p_visitor boolean) RETURNS TABLE (task_id text) LANGUAGE sql AS $$
      SELECT t.task_id FROM task_dispatches t WHERE t.task_id ~ '^0000' $$;
    INSERT INTO task_checks (task_id, outcome, checked_at) VALUES
      ('${T1}', 'not_found', now() - interval '1 hour'),
      ('${T2}', 'not_found', now() - interval '3 days');
    ${section("CREATE OR REPLACE FUNCTION manual_front_pull", "COMMENT ON FUNCTION manual_front_pull")}
    ${section("CREATE OR REPLACE FUNCTION task_dispatches_nf_cooling_no_boost", "COMMENT ON FUNCTION task_dispatches_nf_cooling_no_boost")}
    ${section("DROP TRIGGER IF EXISTS", "-- 3. 舊資料")}
  `);
  return db;
}
const boost = async (db: PGlite, id: string) =>
  Number((await db.query<{ b: string }>(`SELECT boost_seconds::text b FROM task_dispatches WHERE task_id = $1`, [id])).rows[0].b);

Deno.test("A manual_front_pull：查無冷卻中的不拉，其餘照拉", async () => {
  const db = await env();
  // 先以 0 秒入列（模擬已派出過、本時段之前）
  for (const id of [T1, T2, T3]) await db.query(`INSERT INTO task_dispatches (task_id, dispatch_count, last_dispatched_at) VALUES ($1, 1, now() - interval '1 day')`, [id]);
  const n = (await db.query<{ n: number }>(`SELECT manual_front_pull() n`)).rows[0].n;
  assertEquals(n, 2);
  assertEquals(await boost(db, T1), 0, "2 天內查無：不拉");
  assertEquals(await boost(db, T2), 315360000, "冷卻已過：照拉");
  assertEquals(await boost(db, T3), 315360000, "沒查核：照拉");
});

Deno.test("B 出生觸發器：冷卻中的手動任務出生插隊歸零；其餘不動；UPDATE 不管", async () => {
  const db = await env();
  const ins = (id: string, b: number) => db.query(`INSERT INTO task_dispatches (task_id, boost_seconds) VALUES ($1, $2)`, [id, b]);
  await ins(T1, 315360000);
  await ins(T2, 315360000);
  await ins(T3, 157680000);
  assertEquals(await boost(db, T1), 0);
  assertEquals(await boost(db, T2), 315360000);
  assertEquals(await boost(db, T3), 157680000);
  // auto:／verify: 列不套（即使有同名 task_checks）
  await db.query(`INSERT INTO task_checks (task_id, outcome, checked_at) VALUES ('auto:x', 'not_found', now()), ('verify:00000000-0000-0000-0000-0000000000aa', 'not_found', now())`);
  await ins("auto:x", 5);
  await ins("verify:00000000-0000-0000-0000-0000000000aa", 5);
  assertEquals(await boost(db, "auto:x"), 5);
  assertEquals(await boost(db, "verify:00000000-0000-0000-0000-0000000000aa"), 5);
  // 維護者明確插隊（UPDATE）照舊
  await db.query(`UPDATE task_dispatches SET boost_seconds = 157680000 WHERE task_id = $1`, [T1]);
  assertEquals(await boost(db, T1), 157680000);
});

Deno.test("C 舊資料清理：只動自動給的插隊值且 2 天內查無的手動列；可重跑", async () => {
  const db = await env();
  // 繞過出生觸發器：先 INSERT 0 再 UPDATE
  const mk = async (id: string, b: number) => {
    await db.query(`INSERT INTO task_dispatches (task_id) VALUES ($1)`, [id]);
    await db.query(`UPDATE task_dispatches SET boost_seconds = $2, cooling = false WHERE task_id = $1`, [id, b]);
  };
  const T4 = "00000000-0000-0000-0000-000000000004";
  await db.query(`INSERT INTO task_checks (task_id, outcome, checked_at) VALUES ('${T4}', 'not_found', now())`);
  await mk(T1, 315360000); // 自動值＋冷卻 → 歸零
  await mk(T4, 12345); // 維護者別的值 → 不動
  await mk(T2, 315360000); // 冷卻已過 → 不動
  const cleanup = SQL.slice(SQL.indexOf("UPDATE task_dispatches d\n   SET boost_seconds = 0, cooling = true"), SQL.indexOf("NOTIFY pgrst"));
  assert(cleanup.length > 50);
  await db.exec(cleanup);
  await db.exec(cleanup);
  assertEquals(await boost(db, T1), 0);
  assertEquals(await boost(db, T4), 12345);
  assertEquals(await boost(db, T2), 315360000);
  const c = (await db.query<{ cooling: boolean }>(`SELECT cooling FROM task_dispatches WHERE task_id = $1`, [T1])).rows[0].cooling;
  assertEquals(c, true);
});
