/**
 * 查核階梯狀態的集合版（migration 20261118100000_ladder_state_aggregate.sql，#981）——PGlite 並排跑「舊版逐卡函式」與「新版集合函式」，要求結果逐卡相同：
 *
 *   1. work_key_ladder_states() 與逐卡呼叫 work_key_ladder_state(work_key) 的六個欄位完全一致（造 60 張卡、各種階梯狀態：結案、冷卻中、例外任務、unreachable、同卡多任務代號）
 *   2. 視圖 task_ladder_closed 與舊視圖（逐卡 LATERAL）列列相同
 *   3. 新版 refresh_dispatch_blocked 與舊版對同一份派工列算出相同的 blocked／cool_until／cooling（含飽和、no_change 的 b 區塊與 LEFT JOIN b）
 *   4. 單卡函式 work_key_ladder_state 沒被動到（新 migration 不重新定義它）
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const OLD_NAME = "20261111100000_work_key.sql";
const NEW_NAME = "20261118100000_ladder_state_aggregate.sql";
const OLD = await readMig(OLD_NAME);
const NEW = await readMig(NEW_NAME);

const VIEW_HEAD = "CREATE OR REPLACE VIEW task_ladder_closed AS";
const viewText = (sql: string) => sql.slice(sql.indexOf(VIEW_HEAD), sql.indexOf(";", sql.indexOf(VIEW_HEAD)) + 1);

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  const before = (n: string) => latestFn(n, OLD_NAME);
  const oldRefresh = fnText(OLD, "refresh_dispatch_blocked")
    .replace("refresh_dispatch_blocked()", "refresh_dispatch_blocked_old()").replaceAll("task_ladder_closed", "task_ladder_closed_old");
  await db.exec(`
    CREATE TABLE task_check_ladder_settings (outcome text PRIMARY KEY, days integer[] NOT NULL);
    INSERT INTO task_check_ladder_settings VALUES ('not_found', ARRAY[5, 10, 20]), ('confirmed', ARRAY[5, 10]);
    CREATE TABLE task_cooldown_settings (id smallint PRIMARY KEY, enabled boolean NOT NULL DEFAULT true, not_found_first_days integer NOT NULL DEFAULT 14,
      not_found_repeat_days integer NOT NULL DEFAULT 30, task_types text[] NOT NULL DEFAULT ARRAY['progress_stale', 'deadline_due']);
    INSERT INTO task_cooldown_settings (id) VALUES (1);
    ${await before("task_check_cooldown_days")}
    ${await before("task_unreachable_cooldown_days")}
    ${await before("task_not_found_cooldown_days")}
    ${await before("task_check_ladder_days")}
    ${await before("task_check_ladder_exempt")}
    ${await before("task_cooldown_max_days")}
    ${await before("task_queue_key")}
    CREATE TABLE queue_settings (id smallint PRIMARY KEY, dispatch_horizon_seconds integer NOT NULL DEFAULT 86400);
    INSERT INTO queue_settings (id) VALUES (1);
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text, target jsonb, status text NOT NULL DEFAULT 'open', closed_at timestamptz);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, target jsonb NOT NULL DEFAULT '{}'::jsonb, work_key text, blocked boolean NOT NULL DEFAULT false,
      cooling boolean NOT NULL DEFAULT false, cool_until timestamptz, last_dispatched_at timestamptz NOT NULL DEFAULT now(), priority_seconds integer NOT NULL DEFAULT 0,
      boost_seconds bigint NOT NULL DEFAULT 0);
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text NOT NULL, outcome text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), work_key text);
    CREATE FUNCTION roster_group_person_status() RETURNS TABLE (cid text, closed boolean, cool_until timestamptz) LANGUAGE sql AS $$ SELECT NULL::text, NULL::boolean, NULL::timestamptz WHERE false $$;
    CREATE FUNCTION roster_group_check_task_id(a text, b text, c text) RETURNS text LANGUAGE sql AS $$ SELECT 'x:' || a $$;
    CREATE FUNCTION task_work_key(a text, b jsonb) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$; -- 只在 id 查不到時的後備，這裡每筆查核都有 work_key
    -- 舊版（20261111100000）：單卡函式、逐卡視圖（改名 _old 並排比）、逐卡 refresh（改名 _old）
    ${fnText(OLD, "task_check_cooldown_days_for")}
    ${fnText(OLD, "work_key_ladder_state")}
    ${viewText(OLD).replace("task_ladder_closed", "task_ladder_closed_old")}
    ${oldRefresh}
    -- 新版
    ${fnText(NEW, "work_key_ladder_states")}
    ${viewText(NEW)}
    ${fnText(NEW, "refresh_dispatch_blocked")}
  `);
  return db;
}

// 決定性的偽亂數（同一組資料每次跑都一樣）
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

async function seed(db: PGlite): Promise<void> {
  const rnd = lcg(981);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const templates = (c: string) => [
    `auto:policy_missing:${c}`, `auto:term_policy_missing:${c}:2026`, `auto:profile_gap:${c}`,
    `auto:progress_stale:${c}`, `auto:roster_check:${c}`, `auto:not_running_recheck:${c}`, `auto:candidacy_source_missing:cand_no:${c}`,
    `0000000${Math.floor(rnd() * 9)}-1111-4111-8111-11111111111${Math.floor(rnd() * 9)}`,
  ];
  const outcomes = ["not_found", "not_found", "not_found", "confirmed", "confirmed", "unreachable", "other"];
  for (let i = 0; i < 60; i++) {
    const c = `card${i}`;
    const tasks = templates(c);
    const n = Math.floor(rnd() * 8); // 0～7 筆查核；0 筆的卡只有派工列
    const ids: string[] = [];
    for (let k = 0; k < n; k++) {
      const t = pick(tasks);
      ids.push(t);
      // 日期：多半近期（冷卻中），也有 30 天以上的舊紀錄
      const daysAgo = rnd() < 0.3 ? 31 + Math.floor(rnd() * 40) : Math.floor(rnd() * 28);
      await db.query("INSERT INTO task_checks (task_id, outcome, checked_at, work_key) VALUES ($1, $2, now() - ($3 || ' days')::interval, $4)",
        [t, pick(outcomes), String(daysAgo), c]);
    }
    for (const t of new Set([...ids, pick(tasks)])) {
      await db.query("INSERT INTO task_dispatches (task_id, work_key) VALUES ($1, $2) ON CONFLICT DO NOTHING", [t, c]);
    }
  }
  // 沒有 work_key 的派工列（走 'task:' || task_id 的後備）、verify 列、飽和與 no_change 的 b 區塊
  await db.query("INSERT INTO task_dispatches (task_id, work_key) VALUES ('auto:orphan:1', NULL), ('verify:abc', NULL)");
  for (let k = 0; k < 5; k++) await db.query("INSERT INTO contributions (task_id, contribution_type, status) VALUES ('auto:profile_gap:card3', 'x', 'pending')");
  await db.query(`INSERT INTO contributions (contribution_type, status, payload) VALUES
    ('no_change', 'pending', '{"task_id":"auto:profile_gap:card3"}'), ('no_change', 'verified', '{"task_id":"auto:policy_missing:card7"}')`);
}

Deno.test("1 work_key_ladder_states 與逐卡 work_key_ladder_state 逐欄相同", async () => {
  const db = await buildDb();
  await seed(db);
  const cols = "checks, closed, closed_at, last_checked_at, cool_until, check_cool_until";
  const oldSql = `SELECT k.work_key, s.* FROM (SELECT DISTINCT work_key FROM task_checks WHERE work_key IS NOT NULL) k CROSS JOIN LATERAL work_key_ladder_state(k.work_key) s`;
  const newSql = `SELECT work_key, ${cols} FROM work_key_ladder_states()`;
  assertEquals((await db.query(`${oldSql} EXCEPT ${newSql}`)).rows, [], "舊有、新沒有或不同的卡");
  assertEquals((await db.query(`${newSql} EXCEPT ${oldSql}`)).rows, [], "新有、舊沒有或不同的卡");
  const n = (await db.query<{ cards: number; closed: number; cool: number }>(
    `SELECT count(*)::int AS cards, count(*) FILTER (WHERE closed)::int AS closed, count(*) FILTER (WHERE cool_until IS NOT NULL)::int AS cool FROM work_key_ladder_states()`)).rows[0];
  assert(n.cards >= 40, `卡數 ${n.cards}`);
  assert(n.closed >= 3, `結案的卡太少（${n.closed}），資料沒有覆蓋到階梯結案`);
  assert(n.cool >= 10, `冷卻中的卡太少（${n.cool}）`);
});

Deno.test("2 視圖 task_ladder_closed 與舊視圖列列相同", async () => {
  const db = await buildDb();
  await seed(db);
  assertEquals((await db.query("SELECT * FROM task_ladder_closed EXCEPT SELECT * FROM task_ladder_closed_old")).rows, []);
  assertEquals((await db.query("SELECT * FROM task_ladder_closed_old EXCEPT SELECT * FROM task_ladder_closed")).rows, []);
  assert((await db.query("SELECT 1 FROM task_ladder_closed")).rows.length >= 3, "資料沒有覆蓋到結案");
});

Deno.test("3 新版 refresh_dispatch_blocked 與舊版算出相同的 blocked／cool_until／cooling", async () => {
  const db = await buildDb();
  await seed(db);
  const snap = async () => (await db.query("SELECT task_id, blocked, cool_until, cooling FROM task_dispatches ORDER BY task_id")).rows;
  await db.query("SELECT refresh_dispatch_blocked_old()");
  const old = await snap();
  await db.query("UPDATE task_dispatches SET blocked = false, cool_until = NULL, cooling = false");
  await db.query("SELECT refresh_dispatch_blocked()");
  assertEquals(await snap(), old);
  assert(old.some((r) => (r as { blocked: boolean }).blocked), "資料沒有覆蓋到 blocked");
  assert(old.some((r) => (r as { cool_until: unknown }).cool_until !== null), "資料沒有覆蓋到冷卻");
  // 再跑一輪不該有變動（冪等）
  assertEquals((await db.query<{ n: number }>("SELECT refresh_dispatch_blocked() AS n")).rows[0].n, 0);
});

Deno.test("4 新 migration 不重新定義單卡函式（/next、task_in_check_cooldown 等照舊）", () => {
  assert(!NEW.includes("CREATE OR REPLACE FUNCTION work_key_ladder_state("));
  assert(!NEW.includes("CREATE OR REPLACE FUNCTION task_check_cooldown_days_for("));
  assert(!NEW.includes("CREATE OR REPLACE FUNCTION task_in_check_cooldown("));
});
