/**
 * 派工臂事件驅動化 第 0 期 PR-1（migration 20261126170000_dispatch_gaps_phase0.sql）守門。
 * 設計：docs/dispatch-arms-event-driven-plan.md 第 5 節「第 0 期」與附錄 A。
 *
 * 用 PGlite 真的把這支遷移跑一遍（臂函式用假的，回放測試表資料），驗：
 *   ① 表與函式存在、RLS 開、anon／authenticated 沒權限、三支第 1 期臂已登記
 *   ② 缺口鍵規則 dispatch_gap_scope_key
 *   ③ enqueue 去重與緊急開關
 *   ④ drain：開、更新、關、按鍵只動該單位、按鍵版函式優先、失敗隔離、advisory lock
 *   ⑤ reconcile：漏開、漏關、漏更新都補、寫 reconcile_runs
 *   ⑥ shadow_compare：只多 reconcile_runs，其他永久表一字不動
 *   ⑦ 觸發器函式掛到測試表後入列正確的鍵
 *   ⑧ 守門：本支沒改 seed_auto_task_queue／contribution_auto_tasks_arms，也沒掛觸發器、沒排 cron
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG_NAME = "20261126170000_dispatch_gaps_phase0.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const mig = await read(MIG_NAME);
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

/** 假臂函式的輸出形狀與真臂函式一致：task_id, task_type, target, what_we_need, hint_sources, reward, region */
const FAKES = `
CREATE TABLE legacy_src (task_id TEXT PRIMARY KEY, what TEXT NOT NULL DEFAULT 'w', reward INTEGER NOT NULL DEFAULT 1);
CREATE TABLE mismatch_src (task_id TEXT PRIMARY KEY, what TEXT NOT NULL DEFAULT 'w');
CREATE FUNCTION fake_legacy() RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  LANGUAGE sql STABLE AS $$ SELECT s.task_id, 'legacy_audit', jsonb_build_object('id', s.task_id), s.what, ARRAY['x']::TEXT[], s.reward, '臺北市' FROM legacy_src s $$;
CREATE FUNCTION fake_mismatch() RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  LANGUAGE sql STABLE AS $$ SELECT s.task_id, 'policy_election_mismatch', '{}'::JSONB, s.what, ARRAY[]::TEXT[], 1, NULL FROM mismatch_src s $$;
CREATE FUNCTION fake_boom() RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '假臂故意失敗'; END $$;
-- 按鍵版：記錄被呼叫（證明 drain 優先走它），回傳只含那批鍵的缺口
CREATE TABLE keyed_calls (n SERIAL, keys TEXT[]);
CREATE FUNCTION fake_legacy_keyed(p_keys TEXT[]) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  LANGUAGE plpgsql AS $$ BEGIN INSERT INTO keyed_calls (keys) VALUES (p_keys);
  RETURN QUERY SELECT * FROM fake_legacy() f WHERE dispatch_gap_scope_key('legacy', f.task_id) = ANY (p_keys); END $$;
UPDATE dispatch_gap_arm_keys SET full_fn = 'fake_legacy()' WHERE arm = 'legacy';
UPDATE dispatch_gap_arm_keys SET full_fn = 'fake_mismatch()' WHERE arm = 'mismatch';
DELETE FROM dispatch_gap_arm_keys WHERE arm = 'issue_too_broad';
INSERT INTO dispatch_gap_arm_keys (arm, full_fn, key_expr_desc) VALUES ('boom', 'fake_boom()', 'test');
`;

async function freshDb(withFakes = true): Promise<PGlite> {
  const db = new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
  await db.exec(mig);
  if (withFakes) await db.exec(FAKES);
  return db;
}

const ints = async (db: PGlite, sql: string) => (await db.query<Record<string, number>>(sql)).rows[0];
const one = async <T = unknown>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0]?.v;
const L = (id: string) => `auto:legacy_audit:${id}`;

Deno.test("① 遷移跑得動：表、函式、RLS、權限、登記", async () => {
  const db = await freshDb(false);
  for (const t of ["dispatch_gaps", "dispatch_gap_events", "dispatch_gap_reconcile_runs", "dispatch_gap_arm_keys", "dispatch_gap_settings"]) {
    assertEquals(await one(db, `SELECT relrowsecurity AS v FROM pg_class WHERE relname = '${t}'`), true, `${t} 要開 RLS`);
    for (const role of ["anon", "authenticated"]) {
      assertEquals(await one(db, `SELECT has_table_privilege('${role}', '${t}', 'SELECT') AS v`), false, `${role} 不能讀 ${t}`);
      assertEquals(await one(db, `SELECT has_table_privilege('${role}', '${t}', 'INSERT') AS v`), false, `${role} 不能寫 ${t}`);
    }
  }
  for (const f of ["dispatch_gap_enqueue", "dispatch_gap_drain", "dispatch_gap_reconcile_all", "dispatch_gap_shadow_compare", "dispatch_gap_on_change"]) {
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM pg_proc WHERE proname = '${f}'`), 1, `缺函式 ${f}`);
    assertEquals(await one(db, `SELECT has_function_privilege('anon', (SELECT oid FROM pg_proc WHERE proname = '${f}'), 'EXECUTE') AS v`), false, `${f} anon 不能執行`);
  }
  // 部分索引
  const idx = (await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename IN ('dispatch_gaps','dispatch_gap_events')")).rows.map((r) => r.indexdef).join("\n");
  assert(/ON public\.dispatch_gaps USING btree \(arm, scope_key\) WHERE \(closed_at IS NULL\)/.test(idx), "缺 closed_at IS NULL 部分索引");
  assert(/UNIQUE INDEX dispatch_gap_events_pending_uidx[\s\S]*\(arm, scope_key\) WHERE \(processed_at IS NULL\)/.test(idx), "缺未處理事件的唯一部分索引");
  // 第 1 期三支臂的鍵規則已登記
  const arms = (await db.query<{ arm: string }>("SELECT arm FROM dispatch_gap_arm_keys ORDER BY arm")).rows.map((r) => r.arm);
  assertEquals(arms, ["issue_too_broad", "legacy", "mismatch"]);
  // closed_at 與 closed_reason 要一起有或一起沒有
  let threw = false;
  try { await db.exec("INSERT INTO dispatch_gaps (arm, gap_key, scope_key, payload, closed_at) VALUES ('a','k','s','{}', now())"); } catch { threw = true; }
  assert(threw, "closed_at 有值卻沒有 closed_reason 應被擋");
  await db.close();
});

Deno.test("② 缺口鍵規則", async () => {
  const db = await freshDb(false);
  const k = (arm: string, id: string) => one<string>(db, "SELECT dispatch_gap_scope_key($1, $2) AS v", [arm, id]);
  assertEquals(await k("legacy", "auto:legacy_audit:abc-1"), "policy:abc-1");
  assertEquals(await k("mismatch", "auto:policy_election_mismatch:abc-1"), "policy:abc-1");
  assertEquals(await k("issue_too_broad", "auto:issue_too_broad:2026:臺北市:交通_運輸"), "issue:2026:臺北市:交通_運輸");
  assertEquals(await k("anything_else", "auto:x:1"), "auto:x:1");
  await db.close();
});

Deno.test("③ enqueue：去重、處理後可再入列、緊急開關", async () => {
  const db = await freshDb();
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue('legacy', 'policy:p1', 'insert') AS v"), true);
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue('legacy', 'policy:p1', 'update') AS v"), false, "同 arm＋鍵未處理不重複");
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue('mismatch', 'policy:p1', 'update') AS v"), true, "不同 arm 各一筆");
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue('legacy', 'policy:p2', 'update') AS v"), true);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events"), 3);
  await db.exec("UPDATE dispatch_gap_events SET processed_at = now() WHERE arm = 'legacy' AND scope_key = 'policy:p1'");
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue('legacy', 'policy:p1', 'update') AS v"), true, "處理完後同鍵可再入列");
  // enqueue 不重算：常駐表仍空
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gaps"), 0);
  await db.exec("UPDATE dispatch_gap_settings SET events_enabled = false");
  assertEquals(await one(db, "SELECT dispatch_gap_enqueue('legacy', 'policy:p9', 'insert') AS v"), false, "關閉時不入列");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE scope_key = 'policy:p9'"), 0);
  await db.close();
});

Deno.test("④ drain：開、更新、關、只動該單位、按鍵版優先、失敗隔離", async () => {
  const db = await freshDb();
  await db.exec(`INSERT INTO legacy_src (task_id) VALUES ('${L("p1")}'), ('${L("p2")}')`);
  // 沒有按鍵版：保底實作＝整支跑、只留落在這批鍵上的缺口
  await db.exec("SELECT dispatch_gap_enqueue('legacy', 'policy:p1', 'insert')");
  assertEquals(await one(db, "SELECT dispatch_gap_drain() AS v"), 1);
  assertEquals((await db.query("SELECT gap_key FROM dispatch_gaps WHERE closed_at IS NULL")).rows.length, 1, "只開 p1，p2 沒入列不動");
  const g1 = (await db.query<{ scope_key: string; payload: Record<string, unknown>; source_version: number }>("SELECT scope_key, payload, source_version FROM dispatch_gaps WHERE gap_key = $1", [L("p1")])).rows[0];
  assertEquals(g1.scope_key, "policy:p1");
  assertEquals(g1.payload.task_type, "legacy_audit");
  assertEquals(g1.payload.reward, 1);
  assert(!("task_id" in g1.payload), "payload 不含 task_id");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE processed_at IS NULL"), 0);

  // 內容沒變：不寫（source_version 不動）
  await db.exec("SELECT dispatch_gap_enqueue('legacy', 'policy:p1', 'update')");
  await db.exec("SELECT dispatch_gap_drain()");
  assertEquals(await one(db, "SELECT source_version::int AS v FROM dispatch_gaps WHERE gap_key = $1", [L("p1")]), 1);

  // 內容變了：更新並 source_version＋1
  await db.exec(`UPDATE legacy_src SET reward = 5 WHERE task_id = '${L("p1")}'`);
  await db.exec("SELECT dispatch_gap_enqueue('legacy', 'policy:p1', 'update')");
  await db.exec("SELECT dispatch_gap_drain()");
  assertEquals(await one(db, "SELECT (payload->>'reward')::int AS v FROM dispatch_gaps WHERE gap_key = $1", [L("p1")]), 5);
  assertEquals(await one(db, "SELECT source_version::int AS v FROM dispatch_gaps WHERE gap_key = $1", [L("p1")]), 2);

  // 缺口補上：關閉 filled；p2 沒被事件指到所以不受影響（常駐表本來就沒有 p2）
  await db.exec(`DELETE FROM legacy_src WHERE task_id = '${L("p1")}'`);
  await db.exec("SELECT dispatch_gap_enqueue('legacy', 'policy:p1', 'update')");
  await db.exec("SELECT dispatch_gap_drain()");
  const closed = (await db.query<{ closed_reason: string; closed_at: string | null }>("SELECT closed_reason, closed_at FROM dispatch_gaps WHERE gap_key = $1", [L("p1")])).rows[0];
  assertEquals(closed.closed_reason, "filled");
  assert(closed.closed_at !== null);

  // 重新出現：同一列重開（opened_at 更新、closed 清掉）
  await db.exec(`INSERT INTO legacy_src (task_id) VALUES ('${L("p1")}')`);
  await db.exec("SELECT dispatch_gap_enqueue('legacy', 'policy:p1', 'insert')");
  await db.exec("SELECT dispatch_gap_drain()");
  assertEquals(await one(db, "SELECT (closed_at IS NULL) AS v FROM dispatch_gaps WHERE gap_key = $1", [L("p1")]), true);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gaps WHERE arm = 'legacy'"), 1, "同一缺口只留一列");

  // 兩個臂在同一批：分別處理；整臂 '*'
  await db.exec("INSERT INTO mismatch_src (task_id) VALUES ('auto:policy_election_mismatch:p1')");
  await db.exec("SELECT dispatch_gap_enqueue('mismatch', '*', 'config'), dispatch_gap_enqueue('legacy', 'policy:p2', 'insert')");
  assertEquals(await one(db, "SELECT dispatch_gap_drain() AS v"), 2);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gaps WHERE closed_at IS NULL"), 3);

  // 有按鍵版：drain 走它，且只收到這批鍵
  await db.exec("UPDATE dispatch_gap_arm_keys SET recompute_fn = 'fake_legacy_keyed(text[])' WHERE arm = 'legacy'");
  await db.exec(`UPDATE legacy_src SET reward = 9 WHERE task_id = '${L("p2")}'`);
  await db.exec("SELECT dispatch_gap_enqueue('legacy', 'policy:p2', 'update')");
  await db.exec("SELECT dispatch_gap_drain()");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM keyed_calls"), 1);
  assertEquals(await one<string[]>(db, "SELECT keys AS v FROM keyed_calls"), ["policy:p2"]);
  assertEquals(await one(db, "SELECT (payload->>'reward')::int AS v FROM dispatch_gaps WHERE gap_key = $1", [L("p2")]), 9);
  // 整臂 '*' 時不走按鍵版（走整表函式）
  await db.exec("SELECT dispatch_gap_enqueue('legacy', '*', 'config')");
  await db.exec("SELECT dispatch_gap_drain()");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM keyed_calls"), 1);

  // 失敗隔離：boom 臂丟錯只影響自己的事件；其他臂照處理；attempts 累計，超過上限就不再取
  await db.exec("INSERT INTO legacy_src (task_id) VALUES ('" + L("p3") + "')");
  await db.exec("SELECT dispatch_gap_enqueue('boom', 'x', 'insert'), dispatch_gap_enqueue('legacy', 'policy:p3', 'insert')");
  assertEquals(await one(db, "SELECT dispatch_gap_drain() AS v"), 1, "legacy 那筆成功、boom 失敗");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gaps WHERE gap_key = $1 AND closed_at IS NULL", [L("p3")]), 1);
  const bad = (await db.query<{ attempts: number; last_error: string; processed_at: string | null }>("SELECT attempts, last_error, processed_at FROM dispatch_gap_events WHERE arm = 'boom'")).rows[0];
  assertEquals(bad.attempts, 1);
  assert(bad.last_error.includes("假臂故意失敗"));
  assertEquals(bad.processed_at, null);
  for (let i = 0; i < 6; i++) await db.exec("SELECT dispatch_gap_drain()");
  assertEquals(await one(db, "SELECT attempts::int AS v FROM dispatch_gap_events WHERE arm = 'boom'"), 5, "超過 max_attempts 不再自動取");

  // 沒登記的臂：記錯誤、不影響其他事件
  await db.exec("SELECT dispatch_gap_enqueue('nope', 'k', 'insert')");
  await db.exec("SELECT dispatch_gap_drain()");
  assert((await one<string>(db, "SELECT last_error AS v FROM dispatch_gap_events WHERE arm = 'nope'"))!.includes("沒有登記"));
  await db.close();
});

Deno.test("④b drain 取 advisory lock（交易內持有、交易結束釋放）；上限 p_limit 生效", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO legacy_src (task_id) VALUES ('" + L("a") + "'), ('" + L("b") + "'), ('" + L("c") + "')");
  await db.exec("SELECT dispatch_gap_enqueue('legacy','policy:a','i'), dispatch_gap_enqueue('legacy','policy:b','i'), dispatch_gap_enqueue('legacy','policy:c','i')");
  let held = -1;
  await db.transaction(async (tx) => {
    await tx.query("SELECT dispatch_gap_drain(2)");
    held = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()")).rows[0].n;
  });
  assertEquals(held, 1, "drain 應在交易內持有一個 advisory lock");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM pg_locks WHERE locktype = 'advisory'"), 0, "交易結束後釋放");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE processed_at IS NULL"), 1, "一批只取 2 個鍵");
  await db.close();
});

Deno.test("⑤ reconcile：漏開、漏關、漏更新都補，寫 reconcile_runs", async () => {
  const db = await freshDb();
  // 整表函式認定有 p1、p2、p3；常駐表手工造成：p1 內容過期（漏更新）、p2 缺（漏開）、p9 多（漏關）
  await db.exec(`INSERT INTO legacy_src (task_id, reward) VALUES ('${L("p1")}', 7), ('${L("p2")}', 1), ('${L("p3")}', 1)`);
  await db.exec(`INSERT INTO dispatch_gaps (arm, gap_key, scope_key, payload) VALUES
    ('legacy', '${L("p1")}', 'policy:p1', '{"task_type":"legacy_audit","target":{"id":"${L("p1")}"},"what_we_need":"w","hint_sources":["x"],"reward":1,"region":"臺北市"}'),
    ('legacy', '${L("p3")}', 'policy:p3', (SELECT to_jsonb(t) - 'task_id' FROM fake_legacy() t WHERE t.task_id = '${L("p3")}')),
    ('legacy', '${L("p9")}', 'policy:p9', '{"task_type":"legacy_audit"}')`);
  const run = (await db.query<Record<string, unknown>>("SELECT * FROM dispatch_gap_reconcile_all(ARRAY['legacy'])")).rows;
  assertEquals(run.length, 1);
  assertEquals([run[0].live_count, run[0].table_count, run[0].missing, run[0].extra, run[0].changed], [3, 3, 1, 1, 1]);
  assertEquals(run[0].applied, true);
  assertEquals(run[0].mode, "reconcile");
  assertEquals(run[0].error, null);
  assertEquals(await one(db, "SELECT (payload->>'reward')::int AS v FROM dispatch_gaps WHERE gap_key = $1", [L("p1")]), 7);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gaps WHERE gap_key = $1 AND closed_at IS NULL", [L("p2")]), 1);
  assertEquals(await one(db, "SELECT closed_reason AS v FROM dispatch_gaps WHERE gap_key = $1", [L("p9")]), "reconcile");
  // 再跑一次：零差異、不再 applied
  const again = (await db.query<Record<string, unknown>>("SELECT * FROM dispatch_gap_reconcile_all(ARRAY['legacy'])")).rows[0];
  assertEquals([again.missing, again.extra, again.changed, again.applied], [0, 0, 0, false]);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_reconcile_runs WHERE arm = 'legacy'"), 2);
  assert(typeof again.duration_ms === "number");
  await db.close();
});

Deno.test("⑤b reconcile_all：一臂失敗只記錯誤列，其他臂照做", async () => {
  const db = await freshDb();
  await db.exec(`INSERT INTO legacy_src (task_id) VALUES ('${L("p1")}')`);
  const rows = (await db.query<{ arm: string; error: string | null; missing: number | null }>("SELECT arm, error, missing FROM dispatch_gap_reconcile_all()")).rows;
  const by = Object.fromEntries(rows.map((r) => [r.arm, r]));
  assertEquals(Object.keys(by).sort(), ["boom", "legacy", "mismatch"]);
  assert(by.boom.error!.includes("假臂故意失敗"));
  assertEquals(by.boom.missing, null);
  assertEquals(by.legacy.missing, 1);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gaps WHERE closed_at IS NULL"), 1, "legacy 那一筆已補開");
  await db.close();
});

Deno.test("⑥ shadow_compare：只寫 reconcile_runs，其他永久表不動；grace 排除剛重算的", async () => {
  const db = await freshDb();
  await db.exec(`INSERT INTO legacy_src (task_id) VALUES ('${L("p1")}'), ('${L("p2")}')`);
  await db.exec("SELECT dispatch_gap_enqueue('legacy', 'policy:p1', 'insert')");
  await db.exec("SELECT dispatch_gap_drain()");
  await db.exec(`INSERT INTO dispatch_gaps (arm, gap_key, scope_key, payload) VALUES ('legacy', '${L("p9")}', 'policy:p9', '{}')`);
  const snap = async () => JSON.stringify([
    (await db.query("SELECT * FROM dispatch_gaps ORDER BY arm, gap_key")).rows,
    (await db.query("SELECT * FROM dispatch_gap_events ORDER BY id")).rows,
    (await db.query("SELECT * FROM dispatch_gap_arm_keys ORDER BY arm")).rows,
  ]);
  const before = await snap();
  const rows = (await db.query<Record<string, unknown>>("SELECT * FROM dispatch_gap_shadow_compare(ARRAY['legacy'], '0 seconds')")).rows;
  assertEquals(await snap(), before, "shadow 不能改任何其他永久表");
  assertEquals(rows.length, 1);
  assertEquals([rows[0].live_count, rows[0].table_count, rows[0].missing, rows[0].extra, rows[0].changed, rows[0].applied, rows[0].mode],
    [2, 2, 1, 1, 0, false, "shadow"]);
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_reconcile_runs"), 1);
  // 預設 grace 2 分鐘：剛重算過的 p9（手工插入 recomputed_at＝now）不計入 extra
  const graced = (await db.query<Record<string, unknown>>("SELECT * FROM dispatch_gap_shadow_compare(ARRAY['legacy'])")).rows[0];
  assertEquals(graced.extra, 0);
  assertEquals(graced.missing, 1);
  await db.close();
});

Deno.test("⑦ 觸發器函式：掛到測試表後 INSERT／UPDATE／DELETE 入列正確的鍵", async () => {
  const db = await freshDb();
  await db.exec(`
    CREATE TABLE policies (id TEXT PRIMARY KEY, title TEXT, description TEXT, category TEXT, status TEXT, proposed_date DATE, last_updated TIMESTAMPTZ, progress TEXT,
                           election_id INTEGER, politician_id TEXT, removed_at TIMESTAMPTZ, lineage_id TEXT, views INTEGER DEFAULT 0);
    CREATE TABLE jev_decisions (id SERIAL PRIMARY KEY, subject_type TEXT, subject_id TEXT, question TEXT, choice TEXT);
    CREATE TABLE edit_history (id SERIAL PRIMARY KEY, table_name TEXT, record_id TEXT, field TEXT);
    CREATE TABLE source_refs (target_table TEXT, target_id TEXT, source_id INT);
    CREATE TABLE activity_rules (id SERIAL PRIMARY KEY, activity TEXT);
    CREATE TABLE politicians (id TEXT PRIMARY KEY);
    CREATE TRIGGER t1 AFTER INSERT OR UPDATE OR DELETE ON policies FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();
    CREATE TRIGGER t2 AFTER INSERT OR UPDATE OR DELETE ON jev_decisions FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();
    CREATE TRIGGER t3 AFTER INSERT OR UPDATE OR DELETE ON edit_history FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();
    CREATE TRIGGER t4 AFTER INSERT OR UPDATE OR DELETE ON source_refs FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();
    CREATE TRIGGER t5 AFTER INSERT OR UPDATE OR DELETE ON activity_rules FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();
    CREATE TRIGGER t6 AFTER INSERT OR UPDATE OR DELETE ON politicians FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();
  `);
  const events = async () => (await db.query<{ arm: string; scope_key: string }>("SELECT arm, scope_key FROM dispatch_gap_events WHERE processed_at IS NULL ORDER BY arm, scope_key")).rows.map((r) => `${r.arm}|${r.scope_key}`);
  const clear = () => db.exec("UPDATE dispatch_gap_events SET processed_at = now()");

  await db.exec("INSERT INTO policies (id, title) VALUES ('p1', 't')");
  assertEquals(await events(), ["issue_too_broad|*", "legacy|policy:p1", "mismatch|policy:p1"]);
  await clear();
  // 不相干欄位（views）變動：不入列
  await db.exec("UPDATE policies SET views = 5 WHERE id = 'p1'");
  assertEquals(await events(), []);
  // 相關欄位變動：入列
  await db.exec("UPDATE policies SET status = 'done' WHERE id = 'p1'");
  assertEquals(await events(), ["issue_too_broad|*", "legacy|policy:p1", "mismatch|policy:p1"]);
  await clear();
  await db.exec("DELETE FROM policies WHERE id = 'p1'");
  assertEquals(await events(), ["issue_too_broad|*", "legacy|policy:p1", "mismatch|policy:p1"]);
  await clear();

  // jev_decisions：只有政見×屆別題的 INSERT
  await db.exec("INSERT INTO jev_decisions (subject_type, subject_id, question) VALUES ('policy', 'p2', 'is_policy'), ('identity_review', 'p3', 'election'), ('policy', 'p4', 'election')");
  assertEquals(await events(), ["mismatch|policy:p4"]);
  await clear();
  // edit_history：政見的 audit 或 * 欄位才入列
  await db.exec("INSERT INTO edit_history (table_name, record_id, field) VALUES ('policies', 'p5', 'audit'), ('policies', 'p6', 'title'), ('politicians', 'p7', 'audit'), ('policies', 'p8', '*')");
  assertEquals(await events(), ["legacy|policy:p5", "legacy|policy:p8"]);
  await clear();
  // source_refs：只看政見
  await db.exec("INSERT INTO source_refs (target_table, target_id, source_id) VALUES ('policies', 'p9', 1), ('tracking_logs', 'x', 1)");
  assertEquals(await events(), ["legacy|policy:p9"]);
  await clear();
  // 規則表：登記的每一臂整臂入列
  await db.exec("INSERT INTO activity_rules (activity) VALUES ('legacy')");
  assertEquals(await events(), ["boom|*", "legacy|*", "mismatch|*"], "測試環境登記的是 boom、legacy、mismatch");
  await clear();
  // 不認得的表：WARNING 略過、不擋寫入
  await db.exec("INSERT INTO politicians (id) VALUES ('x')");
  assertEquals(await events(), []);
  // 緊急開關
  await db.exec("UPDATE dispatch_gap_settings SET events_enabled = false");
  await db.exec("INSERT INTO policies (id, title) VALUES ('p10', 't')");
  assertEquals(await events(), []);
  await db.close();
});

Deno.test("⑧ 守門：本支沒改現行派工函式、沒掛觸發器、沒排 cron、沒碰 seed", async () => {
  const names = [...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
  const lastDefiner = async (fn: string) => {
    let last = "";
    for (const n of names) if ((await read(n)).includes(`FUNCTION ${fn}(`)) last = n;
    return last;
  };
  for (const fn of ["seed_auto_task_queue", "contribution_auto_tasks_arms"]) {
    // 第 0 期 PR-2（20261126180000，守門在 dispatch-gaps-phase0b.test.ts）起總表與 seed 才換新定義；PR-1 自己不准動
    const defs = [];
    for (const n of names) if ((await read(n)).includes(`FUNCTION ${fn}(`) && n !== MIG_NAME) defs.push(n);
    const last = defs.filter((n) => n < MIG_NAME).pop() ?? "";
    assert(last !== "", `${fn} 在本支之前沒有定義`);
    assert(defs.every((n) => n < MIG_NAME || n === "20261126180000_dispatch_gaps_phase0b.sql" || n === "20261128040000_arms_tail_function.sql" || n === "20261127110000_seed_priority_skip_locked.sql" || n === "20261127120000_gap_drain_batch.sql" || n === "20261128020000_seed_priority_cache.sql" /* seed 兩句 UPDATE 改 SKIP LOCKED，守門在 seed-priority-skip-locked.test.ts */), `${fn} 在本支之後只允許 PR-2 重新定義（現在有 ${defs.join("、")}）`);
    assert(!mig.includes(`FUNCTION ${fn}(`), `本支不准定義 ${fn}`);
    assert(!noComments(mig).includes(fn), `本支的 SQL 不准引用 ${fn}`);
  }
  // 臂函式也不准在本支定義
  assert(!/CREATE (OR REPLACE )?FUNCTION contribution_auto_tasks_/.test(mig), "本支不准定義任何臂函式");
  const sql = noComments(mig);
  assert(!/CREATE\s+(CONSTRAINT\s+)?TRIGGER/i.test(sql), "本支不掛任何觸發器");
  assert(!/cron\.schedule/i.test(sql), "本支不排 cron");
  assert(!/\bALTER (TABLE|FUNCTION)\b(?![^;]*dispatch_gap)/i.test(sql.replace(/ALTER TABLE (dispatch_gap\w*) ENABLE ROW LEVEL SECURITY/g, "")), "本支不改既有物件");
  // 本支之後不能有人把總表換掉而不更新守門清單：本支必須是遷移目錄裡這個前綴之前的最後一支（或之後的人要自己改這條）
  assert(names.includes(MIG_NAME));
});
