/**
 * 手動任務的「冷卻中不拉」改看查核階梯（migration 20261109180000，接 1.123.0）。
 *   A. task_in_check_cooldown：not_found 第 1 次 5 天內＝冷卻（舊的 2 天會放出來）、5 天後不是；confirmed 一樣；階梯結案的永遠是
 *   B. manual_front_pull：冷卻中（含第 3～5 天）不拉，其餘照拉；出生觸發器同理；舊資料清理只動自動給的值
 * 還原驗證：把 task_in_check_cooldown 換回 2 天，A 的「3 天前 not_found」必須紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const read = async (prefix: string) => {
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) {
    if (e.name.startsWith(prefix)) return (await Deno.readTextFile(new URL(`../../migrations/${e.name}`, import.meta.url))).replace(/\r\n/g, "\n");
  }
  throw new Error(prefix);
};
const LADDER = await read("20261109150000");
const SQL = await read("20261109180000");
const fn = (sql: string, sig: string) => {
  const at = sql.indexOf(`CREATE OR REPLACE FUNCTION ${sig}`);
  assert(at >= 0, sig);
  const b = sql.slice(at);
  return b.slice(0, b.indexOf("$$;", b.indexOf("$$") + 2) + 3);
};
const section = (a: string, b: string) => SQL.slice(SQL.indexOf(a), SQL.indexOf(b));

const T1 = "00000000-0000-0000-0000-000000000001"; // 3 天前 not_found（階梯第 1 格 5 天＝仍冷卻）
const T2 = "00000000-0000-0000-0000-000000000002"; // 6 天前 not_found（冷卻已過）
const T3 = "00000000-0000-0000-0000-000000000003"; // 沒查核
const T4 = "00000000-0000-0000-0000-000000000004"; // 3 天前 confirmed（仍冷卻）
const T5 = "00000000-0000-0000-0000-000000000005"; // 已被階梯結案（confirmed 第 3 次）

async function env(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE queue_settings (id int PRIMARY KEY, visitor_front_seconds bigint, manual_front_seconds bigint);
    INSERT INTO queue_settings VALUES (1, 315360000, 157680000);
    CREATE TABLE task_cooldown_settings (id integer PRIMARY KEY, enabled boolean, task_types text[], not_found_first_days integer, not_found_repeat_days integer);
    INSERT INTO task_cooldown_settings VALUES (1, true, ARRAY['progress_stale','deadline_due'], 14, 30);
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text, outcome text, checked_at timestamptz DEFAULT now());
    CREATE TABLE task_check_ladder_settings (outcome text PRIMARY KEY, days integer[] NOT NULL);
    INSERT INTO task_check_ladder_settings VALUES ('not_found', ARRAY[5,10,20]), ('confirmed', ARRAY[5,10]);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, boost_seconds bigint NOT NULL DEFAULT 0, dispatch_count int NOT NULL DEFAULT 0,
      last_dispatched_at timestamptz, cooling boolean NOT NULL DEFAULT false);
    CREATE FUNCTION task_unreachable_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$;
    CREATE FUNCTION task_check_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT 14 $$;
    CREATE FUNCTION task_not_found_cooldown_days() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$;
    ${fn(LADDER, "task_check_ladder_days(")}
    ${fn(LADDER, "task_check_ladder_exempt(")}
    ${fn(LADDER, "task_check_cooldown_days_for(")}
    ${fn(LADDER, "task_cooldown_max_days(")}
    ${LADDER.slice(LADDER.indexOf("CREATE OR REPLACE VIEW task_ladder_closed"), LADDER.indexOf(";\n", LADDER.indexOf("CREATE OR REPLACE VIEW task_ladder_closed")) + 1)}
    CREATE FUNCTION visitor_front_slot_start() RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() - interval '5 minutes' $$;
    CREATE FUNCTION contribution_auto_tasks_manual(p_visitor boolean) RETURNS TABLE (task_id text) LANGUAGE sql AS $$
      SELECT t.task_id FROM task_dispatches t WHERE t.task_id ~ '^0000' $$;
    INSERT INTO task_checks (task_id, outcome, checked_at) VALUES
      ('${T1}', 'not_found', now() - interval '3 days'),
      ('${T2}', 'not_found', now() - interval '6 days'),
      ('${T4}', 'confirmed', now() - interval '3 days'),
      ('${T5}', 'confirmed', now() - interval '30 days'),
      ('${T5}', 'confirmed', now() - interval '20 days'),
      ('${T5}', 'confirmed', now() - interval '10 days');
    ${fn(SQL, "task_in_check_cooldown(")}
    ${section("CREATE OR REPLACE FUNCTION manual_front_pull", "COMMENT ON FUNCTION manual_front_pull")}
    ${fn(SQL, "task_dispatches_nf_cooling_no_boost(")}
    CREATE TRIGGER trg_task_dispatches_nf_cooling_no_boost BEFORE INSERT ON task_dispatches
      FOR EACH ROW WHEN (NEW.task_id NOT LIKE 'verify:%' AND NEW.task_id NOT LIKE 'auto:%') EXECUTE FUNCTION task_dispatches_nf_cooling_no_boost();
  `);
  return db;
}
const boost = async (db: PGlite, id: string) =>
  Number((await db.query<{ b: string }>(`SELECT boost_seconds::text b FROM task_dispatches WHERE task_id = $1`, [id])).rows[0].b);

Deno.test("A task_in_check_cooldown：階梯天數內＝冷卻（not_found 3 天前仍是、6 天前不是）；confirmed 同；結案永遠是", async () => {
  const db = await env();
  const q = async (id: string) => (await db.query<{ c: boolean }>(`SELECT task_in_check_cooldown($1) c`, [id])).rows[0].c;
  assertEquals(await q(T1), true, "not_found 3 天前：舊的 2 天會放出來，階梯第 1 格 5 天要擋");
  assertEquals(await q(T2), false);
  assertEquals(await q(T3), false);
  assertEquals(await q(T4), true);
  assertEquals(await q(T5), true, "confirmed 第 3 次＝結案");
});

Deno.test("B manual_front_pull 與出生觸發器：冷卻中不拉／不給插隊，其餘照舊", async () => {
  const db = await env();
  for (const id of [T1, T2, T3, T4, T5]) await db.query(`INSERT INTO task_dispatches (task_id, dispatch_count, last_dispatched_at) VALUES ($1, 1, now() - interval '1 day')`, [id]);
  assertEquals((await db.query<{ n: number }>(`SELECT manual_front_pull() n`)).rows[0].n, 2);
  assertEquals(await boost(db, T1), 0);
  assertEquals(await boost(db, T4), 0);
  assertEquals(await boost(db, T5), 0);
  assertEquals(await boost(db, T2), 315360000);
  assertEquals(await boost(db, T3), 315360000);
  // 出生：冷卻中的出生插隊歸零
  const db2 = await env();
  const ins = (id: string, b: number) => db2.query(`INSERT INTO task_dispatches (task_id, boost_seconds) VALUES ($1, $2)`, [id, b]);
  await ins(T1, 315360000);
  await ins(T2, 315360000);
  assertEquals(await boost(db2, T1), 0);
  assertEquals(await boost(db2, T2), 315360000);
});

Deno.test("C 舊資料清理：只動自動給的插隊值、且在階梯冷卻中的手動列；可重跑", async () => {
  const db = await env();
  const mk = async (id: string, b: number) => {
    await db.query(`INSERT INTO task_dispatches (task_id) VALUES ($1)`, [id]);
    await db.query(`UPDATE task_dispatches SET boost_seconds = $2, cooling = false WHERE task_id = $1`, [id, b]);
  };
  await mk(T1, 315360000);
  await mk(T4, 12345);
  await mk(T2, 315360000);
  const cleanup = SQL.slice(SQL.indexOf("UPDATE task_dispatches d\n   SET boost_seconds = 0, cooling = true"), SQL.indexOf("NOTIFY pgrst"));
  assert(cleanup.length > 50);
  await db.exec(cleanup);
  await db.exec(cleanup);
  assertEquals(await boost(db, T1), 0);
  assertEquals(await boost(db, T4), 12345);
  assertEquals(await boost(db, T2), 315360000);
});

Deno.test("D 原始碼：不再寫死 task_not_found_cooldown_days，cand_no_front_pull 不動", () => {
  const code = SQL.replace(/--[^\n]*/g, "");
  assert(!code.includes("task_not_found_cooldown_days"));
  assert(!code.includes("FUNCTION cand_no_front_pull"));
});
