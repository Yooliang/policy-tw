/**
 * 工作卡鍵的階梯、冷卻與 blocked（migration 20261111100000_work_key.sql）——PGlite 真的執行「新版」函式：
 * work_key_ladder_state、task_check_cooldown_days_for、視圖 task_ladder_closed、task_in_check_cooldown、refresh_dispatch_blocked。
 *
 *   1. 同卡兩個 task_id（policy_missing／term_policy_missing 同人同屆）的查核合併計數：第 2 次查核吃階梯第 2 格
 *   2. 換號（指紋變）後階梯延續：舊指紋累計 3 次，新指紋的第 4 次就結案；新任務代號一出生就在結案卡上
 *   3. 結案後同卡的 auto: 列一起 blocked，別的卡不受影響
 *   4. 手動任務：同卡結案時留 open；只有它自己的查核超過階梯格數才關
 *   5. cool_until：同卡每一列（含手動任務的列、不同任務代號）取最晚的一筆查核
 *   6. task_in_check_cooldown（插隊拉回與手動任務出生觸發器用）按卡判
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261111100000_work_key.sql";
const MIG = await readMig(MIG_NAME);
const P1 = "0000b296-7ae8-4184-b704-c69d44cb696a";
const P2 = "ffd273b3-1d4c-45d5-bf61-b5b418f87233";
const P3 = "01c8a200-2fb6-4ff0-afdd-175e9a4643a9";
const M_OPEN = "11111111-1111-4111-8111-111111111111"; // 網站請求（P2 缺政見），沒有自己的查核
const M_OWN = "22222222-2222-4222-8222-222222222222"; // 網站請求（P3 缺政見），自己有 4 次查核
const M_OWN_DISPATCH = M_OWN;

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  const before = (n: string) => latestFn(n, MIG_NAME);
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date, election_reason text);
    INSERT INTO elections VALUES (2026, '2026-11-28', 'regular');
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-11-11' $$;
    CREATE TABLE task_check_ladder_settings (outcome text PRIMARY KEY, days integer[] NOT NULL);
    INSERT INTO task_check_ladder_settings VALUES ('not_found', ARRAY[5, 10, 20]), ('confirmed', ARRAY[5, 10]);
    CREATE TABLE task_cooldown_settings (id smallint PRIMARY KEY, enabled boolean NOT NULL DEFAULT true, not_found_first_days integer NOT NULL DEFAULT 14,
      not_found_repeat_days integer NOT NULL DEFAULT 30, task_types text[] NOT NULL DEFAULT ARRAY['progress_stale', 'deadline_due']);
    INSERT INTO task_cooldown_settings (id) VALUES (1);
    ${await before("uuid_or_null")}
    ${await before("election_id_or_null")}
    ${await before("campaign_election_id")}
    ${await before("task_rekey_arms")}
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
    CREATE TABLE contribution_task_leases (task_id text PRIMARY KEY, target_key text, work_key text);
    CREATE FUNCTION roster_group_person_status() RETURNS TABLE (cid text, closed boolean, cool_until timestamptz) LANGUAGE sql AS $$ SELECT NULL::text, NULL::boolean, NULL::timestamptz WHERE false $$;
    CREATE FUNCTION roster_group_check_task_id(a text, b text, c text) RETURNS text LANGUAGE sql AS $$ SELECT 'x:' || a $$;
    ${fnText(MIG, "task_work_key_fp_arms")}
    ${fnText(MIG, "task_work_key")}
    ${fnText(MIG, "work_key_fill")}
    CREATE TRIGGER trg_task_dispatches_work_key BEFORE INSERT OR UPDATE OF task_id, target ON task_dispatches FOR EACH ROW EXECUTE FUNCTION work_key_fill();
    CREATE TRIGGER trg_task_checks_work_key BEFORE INSERT OR UPDATE OF task_id ON task_checks FOR EACH ROW EXECUTE FUNCTION work_key_fill();
    ${fnText(MIG, "task_check_cooldown_days_for")}
    ${fnText(MIG, "work_key_ladder_state")}
    ${MIG.slice(MIG.indexOf("CREATE OR REPLACE VIEW task_ladder_closed AS"), MIG.indexOf("COMMENT ON VIEW task_ladder_closed"))}
    ${fnText(MIG, "task_in_check_cooldown")}
    ${fnText(MIG, "refresh_dispatch_blocked")}
    INSERT INTO contribution_tasks (id, task_type, target) VALUES
      ('${M_OPEN}', 'policy_missing', '{"politician_id":"${P2}"}'),
      ('${M_OWN}', 'policy_missing', '{"politician_id":"${P3}"}');
  `);
  return db;
}

const check = (db: PGlite, taskId: string, outcome: string, daysAgo: number) =>
  db.query("INSERT INTO task_checks (task_id, outcome, checked_at) VALUES ($1, $2, now() - ($3 || ' days')::interval)", [taskId, outcome, String(daysAgo)]);
const days = async (db: PGlite, checkId: number): Promise<number> =>
  (await db.query<{ d: number }>("SELECT task_check_cooldown_days_for(task_id, outcome, checked_at, id) AS d FROM task_checks WHERE id = $1", [checkId])).rows[0].d;
const blocked = async (db: PGlite): Promise<Record<string, boolean>> =>
  Object.fromEntries((await db.query<{ task_id: string; blocked: boolean }>("SELECT task_id, blocked FROM task_dispatches")).rows.map((r) => [r.task_id, r.blocked]));

Deno.test("1 同卡兩個任務代號的查核合併計數：第 2 次查核吃階梯第 2 格（按 task_id 各算各的會是第 1 格）", async () => {
  const db = await buildDb();
  await check(db, `auto:policy_missing:${P1}`, "not_found", 30);
  await check(db, `auto:term_policy_missing:${P1}:2026`, "not_found", 20);
  await check(db, `auto:policy_missing:${P1}`, "confirmed", 5);
  assertEquals(await days(db, 1), 5, "第 1 次 not_found＝格 1");
  assertEquals(await days(db, 2), 10, "term_policy_missing 的查核是這張卡的第 2 次＝格 2（not_found 10 天）");
  assertEquals(await days(db, 3), 10, "第 3 次是 confirmed：confirmed 的格 3 超過 {5,10}＝回最後一格 10");
  // 不同屆不是同一張卡：2024 的 term_policy_missing 自己從第 1 格開始
  await check(db, `auto:term_policy_missing:${P1}:2024`, "not_found", 1);
  assertEquals(await days(db, 4), 5);
  const s = (await db.query<{ checks: number; closed: boolean }>(`SELECT checks::int AS checks, closed FROM work_key_ladder_state('politician:${P1}:policies:2026')`)).rows[0];
  assertEquals([s.checks, s.closed], [3, true], "第 3 次是 confirmed，格數只有 {5,10}＝結案（兩種合計累計）");
});

Deno.test("2 換號後階梯延續：舊指紋累計 3 次，新指紋的第 4 次就結案；新任務代號一出生就在結案卡上", async () => {
  const db = await buildDb();
  const old = "auto:lineage_candidate:abc123def456:aaaaaaaa";
  const neu = "auto:lineage_candidate:abc123def456:bbbbbbbb";
  for (const d of [40, 30, 20]) await check(db, old, "not_found", d);
  assertEquals((await db.query("SELECT 1 FROM task_ladder_closed")).rows.length, 0, "3 次還在階梯內");
  await check(db, neu, "not_found", 1);
  assertEquals(await days(db, 4), 20, "新指紋的第 1 次查核＝這張卡的第 4 次：超過格數回最後一格（結案由視圖與 blocked 處理）");
  const closed = (await db.query<{ task_id: string }>("SELECT task_id FROM task_ladder_closed ORDER BY task_id")).rows.map((r) => r.task_id);
  assertEquals(closed, [old, neu]);
  // 結案後又換一次指紋：新代號一出生（派工列、還沒有任何查核）就在結案卡上，task_in_check_cooldown 為真
  await db.query("INSERT INTO task_dispatches (task_id) VALUES ('auto:lineage_candidate:abc123def456:cccccccc')");
  assert((await db.query<{ t: boolean }>("SELECT task_in_check_cooldown('auto:lineage_candidate:abc123def456:cccccccc') AS t")).rows[0].t);
  assert((await db.query("SELECT 1 FROM task_ladder_closed WHERE task_id = 'auto:lineage_candidate:abc123def456:cccccccc'")).rows.length === 1);
  // 別的格不受影響
  assert(!(await db.query<{ t: boolean }>("SELECT task_in_check_cooldown('auto:lineage_candidate:zzzzzzzzzzzz:aaaaaaaa') AS t")).rows[0].t);
});

Deno.test("3 結案後同卡的 auto: 列一起 blocked，別的卡（同一人的補基本資料）不受影響", async () => {
  const db = await buildDb();
  await db.query(`INSERT INTO task_dispatches (task_id, target) VALUES ('auto:policy_missing:${P2}', '{}'), ('auto:term_policy_missing:${P2}:2026', '{}'), ('auto:profile_gap:${P2}', '{}')`);
  for (const d of [40, 30, 20]) await check(db, `auto:policy_missing:${P2}`, "not_found", d);
  await db.query("SELECT refresh_dispatch_blocked()");
  const b0 = await blocked(db);
  assertEquals(b0[`auto:policy_missing:${P2}`] || b0[`auto:term_policy_missing:${P2}:2026`], false, "3 次還沒結案");
  await check(db, `auto:term_policy_missing:${P2}:2026`, "not_found", 10); // 這張卡的第 4 次
  await db.query("SELECT refresh_dispatch_blocked()");
  const b = await blocked(db);
  assertEquals(b[`auto:policy_missing:${P2}`], true);
  assertEquals(b[`auto:term_policy_missing:${P2}:2026`], true);
  assertEquals(b[`auto:profile_gap:${P2}`], false);
});

Deno.test("4 手動任務：同卡結案時留 open；只有它自己的查核超過階梯格數才關", async () => {
  const db = await buildDb();
  // P2 的卡被 auto: 的查核結案；網站請求 M_OPEN 同卡、沒有自己的查核
  await db.query(`INSERT INTO task_dispatches (task_id, target) VALUES ('auto:policy_missing:${P2}', '{}'), ('${M_OPEN}', '{}')`);
  for (const d of [40, 30, 20, 10]) await check(db, `auto:policy_missing:${P2}`, "not_found", d);
  // P3 的網站請求自己查了 4 次
  for (const d of [40, 30, 20, 10]) await check(db, M_OWN, "not_found", d);
  await db.query(`INSERT INTO task_dispatches (task_id, target) VALUES ('${M_OWN_DISPATCH}', '{}')`);
  await db.query("SELECT refresh_dispatch_blocked()");
  const st = Object.fromEntries((await db.query<{ id: string; status: string }>("SELECT id::text AS id, status FROM contribution_tasks")).rows.map((r) => [r.id, r.status]));
  assertEquals(st[M_OPEN], "open", "同卡被 auto: 的查核結案，手動任務留 open");
  assertEquals(st[M_OWN], "closed", "自己的查核超過階梯格數才關");
  const b = await blocked(db);
  assertEquals(b[`auto:policy_missing:${P2}`], true);
  assertEquals(b[M_OPEN], false, "手動任務的列不因同卡結案 blocked（#912 讓請求跟著缺口走）");
});

Deno.test("5 cool_until：同卡每一列（不同任務代號、含手動任務的列）取最晚的一筆查核；別的卡不受影響", async () => {
  const db = await buildDb();
  await db.query(`INSERT INTO task_dispatches (task_id, target) VALUES
    ('auto:policy_missing:${P1}', '{}'), ('auto:term_policy_missing:${P1}:2026', '{}'), ('auto:profile_gap:${P1}', '{}')`);
  await check(db, `auto:policy_missing:${P1}`, "not_found", 1); // 第 1 格 5 天 → 還有 4 天
  await db.query("SELECT refresh_dispatch_blocked()");
  const r = (await db.query<{ task_id: string; cool_until: string | null; secs: number | null }>(
    "SELECT task_id, cool_until, extract(epoch FROM (cool_until - now()))::int AS secs FROM task_dispatches ORDER BY task_id")).rows;
  const m = Object.fromEntries(r.map((x) => [x.task_id, x.secs]));
  assert(m[`auto:policy_missing:${P1}`]! > 3 * 86400 && m[`auto:policy_missing:${P1}`]! <= 4 * 86400, `cool_until＝${m[`auto:policy_missing:${P1}`]}`);
  assertEquals(m[`auto:term_policy_missing:${P1}:2026`], m[`auto:policy_missing:${P1}`], "同卡的另一個任務代號同一個 cool_until");
  assertEquals(m[`auto:profile_gap:${P1}`], null, "別張卡沒有");
  // 冷卻過了就清掉
  await db.query("UPDATE task_checks SET checked_at = now() - interval '10 days'");
  await db.query("SELECT refresh_dispatch_blocked()");
  assertEquals((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM task_dispatches WHERE cool_until IS NOT NULL")).rows[0].n, 0);
});

Deno.test("6 task_in_check_cooldown 按卡判：同卡別的任務代號的查核也讓它在冷卻中；work_key_ladder_state 只讀這個鍵", async () => {
  const db = await buildDb();
  await check(db, `auto:policy_missing:${P1}`, "not_found", 1);
  assert((await db.query<{ t: boolean }>(`SELECT task_in_check_cooldown('auto:term_policy_missing:${P1}:2026') AS t`)).rows[0].t);
  assert(!(await db.query<{ t: boolean }>(`SELECT task_in_check_cooldown('auto:term_policy_missing:${P1}:2024') AS t`)).rows[0].t);
  assert(!(await db.query<{ t: boolean }>(`SELECT task_in_check_cooldown('auto:profile_gap:${P1}') AS t`)).rows[0].t);
  // 手動任務出生（派工列還不存在）也能用它的 uuid 查到卡
  assert((await db.query<{ t: boolean }>(`SELECT task_in_check_cooldown('${M_OPEN}') AS t`)).rows[0].t === false);
  await check(db, `auto:policy_missing:${P2}`, "not_found", 1);
  assert((await db.query<{ t: boolean }>(`SELECT task_in_check_cooldown('${M_OPEN}') AS t`)).rows[0].t, "網站請求（P2）跟自動缺口同一張卡");
  // 查核過期（超過冷卻）就不在冷卻中
  await db.query("UPDATE task_checks SET checked_at = now() - interval '30 days'");
  assert(!(await db.query<{ t: boolean }>(`SELECT task_in_check_cooldown('auto:policy_missing:${P1}') AS t`)).rows[0].t);
});

Deno.test("7 work_key_recompute：只動鍵變了的列；UPDATE OF task_id 直接重算", async () => {
  const db = await buildDb();
  await db.exec(fnText(MIG, "work_key_recompute"));
  await db.query(`INSERT INTO task_dispatches (task_id) VALUES ('auto:policy_missing:${P1}')`);
  await db.query(`INSERT INTO task_checks (task_id, outcome) VALUES ('auto:policy_missing:${P1}', 'not_found')`);
  await db.exec(`UPDATE task_dispatches SET work_key = 'stale'; UPDATE task_checks SET work_key = 'stale'`);
  const r = (await db.query<{ tbl: string; changed: number }>("SELECT tbl, changed FROM work_key_recompute()")).rows;
  assertEquals(r.map((x) => [x.tbl, x.changed]), [["task_dispatches", 1], ["task_checks", 1], ["contribution_task_leases", 0]]);
  assertEquals((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM work_key_recompute() WHERE changed > 0")).rows[0].n, 0, "重跑不再動");
  await db.query(`UPDATE task_checks SET task_id = 'auto:profile_gap:${P1}'`);
  assertEquals((await db.query<{ work_key: string }>("SELECT work_key FROM task_checks")).rows[0].work_key, `politician:${P1}:profile`);
});
