/**
 * gap_drain 逐臂計時（migration 20261127120000_gap_drain_batch.sql）守門。
 *
 * 起因：2026-11-27 8 支臂切 live 後，seed 的 stage:gap_drain 每輪從 5～12 秒升到 17～37 秒。
 * 讀碼結論：dispatch_gap_drain 本來就依臂聚合（每臂一次 sync）、同 (arm, scope_key) 靠部分唯一索引去重，
 * 所以這支不改 drain 的取事件與重算邏輯，只加逐臂計時，讓下一步（另案）有數字可依。
 *
 *   A. 文字層：時間戳大於 #1075（110000）；只重新定義 dispatch_gap_drain 與 seed_auto_task_queue；開頭註解齊全
 *   B. seed 本體：拿掉 gap_drain 段那一句 set_config 之後，與前一版（#1075）逐字相同
 *   C. PGlite 行為：同鍵多次入列只留一筆；一臂 5 個鍵只呼叫一次重算；不同臂各一次；全部事件標 processed_at
 *   D. 逐臂計時：有批次就每臂寫一筆（成功 ok、失敗 not ok 且 attempts＋1），沒批次不寫
 *   E. 還原驗證
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { migrationNames, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261127120000_gap_drain_batch.sql";
const PREV_NAME = "20261127110000_seed_priority_skip_locked.sql";
const P0_NAME = "20261126170000_dispatch_gaps_phase0.sql";
const MIG = await readMig(MIG_NAME);
const PREV = await readMig(PREV_NAME);
const P0 = await readMig(P0_NAME);

function seedBody(src: string): string {
  const start = src.lastIndexOf("FUNCTION seed_auto_task_queue()");
  assert(start >= 0, "找不到 seed_auto_task_queue 定義");
  const open = src.indexOf("$$", start);
  const close = src.indexOf("$$", open + 2);
  return src.slice(open + 2, close);
}
const squash = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join(" ").replace(/\s+/g, " ").trim();

/** 取 dispatch_gap_drain 的完整定義（CREATE 到第一個 $$;） */
function drainDef(src: string): string {
  const start = src.indexOf("CREATE OR REPLACE FUNCTION dispatch_gap_drain(");
  assert(start >= 0, "找不到 dispatch_gap_drain 定義");
  const open = src.indexOf("$$", start);
  const close = src.indexOf("$$;", open + 2);
  return src.slice(start, close + 3);
}

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 時間戳大於 #1075（110000），且是現有 migration", async () => {
  assert(MIG_NAME > PREV_NAME);
  assert((await migrationNames()).includes(MIG_NAME));
});

Deno.test("A2 只重新定義 dispatch_gap_drain 與 seed_auto_task_queue，前一版 seed 是 #1075", async () => {
  const defs = [...MIG.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]);
  assertEquals(defs, ["dispatch_gap_drain", "seed_auto_task_queue"]);
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue(")) defining.push(n);
  assertEquals(defining[defining.indexOf(MIG_NAME) - 1], PREV_NAME, "前一版變了：要以最新的為底重做");
  // 之後沒有人再改 drain
  const drains: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION dispatch_gap_drain(")) drains.push(n);
  assertEquals(drains, [P0_NAME, MIG_NAME]);
});

Deno.test("A3 兩個函式層級 SET 還在，函式定義帶 REVOKE", () => {
  const head = MIG.slice(MIG.lastIndexOf("FUNCTION seed_auto_task_queue()"));
  const pre = head.slice(0, head.indexOf("$$"));
  assert(/SET statement_timeout = '280s'/.test(pre));
  assert(/SET work_mem = '16MB'/.test(pre));
  assert(/REVOKE ALL ON FUNCTION dispatch_gap_drain\(INTEGER\) FROM PUBLIC, anon, authenticated;/.test(MIG));
});

Deno.test("A4 開頭註解寫了為什麼、讀碼結論、改了什麼、回滾檔名", () => {
  const head = MIG.slice(0, MIG.indexOf("CREATE OR REPLACE FUNCTION"));
  for (const must of ["gap_drain", "已經依臂聚合", "pending_uidx", "roster_diff_findings", PREV_NAME, P0_NAME, "回滾"]) {
    assert(head.includes(must), `註解缺「${must}」`);
  }
});

// ============================================================
// B. seed 本體與 #1075 只差一句 set_config
// ============================================================
Deno.test("B1 拿掉 gap_drain 段的 set_config 後，seed 本體與 #1075 逐字相同", () => {
  const newS = squash(seedBody(MIG));
  const oldS = squash(seedBody(PREV));
  const setCfg = "PERFORM set_config('dispatch_gap.run_id', v_run::TEXT, true);";
  assert(newS.includes(setCfg), "新版要有 set_config");
  assertEquals(newS.replace(setCfg + " ", ""), oldS);
  // 而且 set_config 在 PERFORM dispatch_gap_drain() 之前
  assert(newS.indexOf(setCfg) < newS.indexOf("PERFORM dispatch_gap_drain();"));
});

// ============================================================
// C／D. PGlite 行為
// ============================================================
const FAKES = `
CREATE TABLE seed_arm_timings (id SERIAL PRIMARY KEY, run_started_at TIMESTAMPTZ, arm TEXT, elapsed_ms INTEGER, row_count INTEGER, ok BOOLEAN, error TEXT);
CREATE FUNCTION seed_arm_timing_log(p_run TIMESTAMPTZ, p_arm TEXT, p_started TIMESTAMPTZ, p_rows INTEGER DEFAULT NULL, p_ok BOOLEAN DEFAULT true, p_error TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO seed_arm_timings (run_started_at, arm, elapsed_ms, row_count, ok, error) VALUES (p_run, p_arm, 0, p_rows, p_ok, p_error);
END $$;
CREATE TABLE legacy_src (task_id TEXT PRIMARY KEY);
CREATE TABLE mismatch_src (task_id TEXT PRIMARY KEY);
CREATE TABLE keyed_calls (n SERIAL, arm TEXT, keys TEXT[]);
CREATE FUNCTION fake_legacy() RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  LANGUAGE sql STABLE AS $$ SELECT s.task_id, 'legacy_audit', '{}'::JSONB, 'w', ARRAY[]::TEXT[], 1, NULL FROM legacy_src s $$;
CREATE FUNCTION fake_mismatch() RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  LANGUAGE sql STABLE AS $$ SELECT s.task_id, 'policy_election_mismatch', '{}'::JSONB, 'w', ARRAY[]::TEXT[], 1, NULL FROM mismatch_src s $$;
CREATE FUNCTION fake_boom() RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '假臂故意失敗'; END $$;
-- 按鍵版：記錄被呼叫，只回那批鍵的缺口
CREATE FUNCTION fake_legacy_keyed(p_keys TEXT[]) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  LANGUAGE plpgsql AS $$ BEGIN INSERT INTO keyed_calls (arm, keys) VALUES ('legacy', p_keys);
  RETURN QUERY SELECT * FROM fake_legacy() f WHERE dispatch_gap_scope_key('legacy', f.task_id) = ANY (p_keys); END $$;
CREATE FUNCTION fake_mismatch_keyed(p_keys TEXT[]) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
  LANGUAGE plpgsql AS $$ BEGIN INSERT INTO keyed_calls (arm, keys) VALUES ('mismatch', p_keys);
  RETURN QUERY SELECT * FROM fake_mismatch() f WHERE dispatch_gap_scope_key('mismatch', f.task_id) = ANY (p_keys); END $$;
UPDATE dispatch_gap_arm_keys SET full_fn = 'fake_legacy()', recompute_fn = 'fake_legacy_keyed(text[])' WHERE arm = 'legacy';
UPDATE dispatch_gap_arm_keys SET full_fn = 'fake_mismatch()', recompute_fn = 'fake_mismatch_keyed(text[])' WHERE arm = 'mismatch';
DELETE FROM dispatch_gap_arm_keys WHERE arm = 'issue_too_broad';
INSERT INTO dispatch_gap_arm_keys (arm, full_fn, key_expr_desc) VALUES ('boom', 'fake_boom()', 'test');
`;

async function freshDb(drainSql: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
  await db.exec(P0);
  await db.exec(FAKES);
  await db.exec(drainSql);
  return db;
}
const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string) => (await db.query<T>(sql)).rows;
const scalar = async (db: PGlite, sql: string) => Object.values((await db.query<Record<string, unknown>>(sql)).rows[0])[0];
const enqueue = (db: PGlite, arm: string, key: string) => db.exec(`SELECT dispatch_gap_enqueue('${arm}', '${key}', 'update')`);

Deno.test("C1 同 (arm, scope_key) 連續入列 5 次只留一筆未處理事件，消化後重算只呼叫 1 次、事件標 processed_at", async () => {
  const db = await freshDb(drainDef(MIG));
  await db.exec("INSERT INTO legacy_src VALUES ('auto:legacy_audit:p1')");
  for (let i = 0; i < 5; i++) await enqueue(db, "legacy", "policy:p1");
  assertEquals(await scalar(db, "SELECT count(*)::int FROM dispatch_gap_events WHERE processed_at IS NULL"), 1);
  assertEquals(await scalar(db, "SELECT dispatch_gap_drain()"), 1);
  assertEquals(await scalar(db, "SELECT count(*)::int FROM keyed_calls"), 1);
  assertEquals(await scalar(db, "SELECT count(*)::int FROM dispatch_gap_events WHERE processed_at IS NULL"), 0);
});

Deno.test("C2 同一臂 5 個不同鍵：重算只被叫 1 次（一次傳 5 個鍵），5 筆事件都標 processed_at", async () => {
  const db = await freshDb(drainDef(MIG));
  for (let i = 1; i <= 5; i++) {
    await db.exec(`INSERT INTO legacy_src VALUES ('auto:legacy_audit:p${i}')`);
    await enqueue(db, "legacy", `policy:p${i}`);
  }
  assertEquals(await scalar(db, "SELECT dispatch_gap_drain()"), 5);
  const calls = await rows<{ arm: string; keys: string[] }>(db, "SELECT arm, keys FROM keyed_calls");
  assertEquals(calls.length, 1);
  assertEquals([...calls[0].keys].sort(), ["policy:p1", "policy:p2", "policy:p3", "policy:p4", "policy:p5"]);
  assertEquals(await scalar(db, "SELECT count(*)::int FROM dispatch_gap_events WHERE processed_at IS NOT NULL"), 5);
  assertEquals(await scalar(db, "SELECT count(*)::int FROM dispatch_gaps WHERE arm = 'legacy' AND closed_at IS NULL"), 5);
});

Deno.test("C3 不同臂各自一次呼叫", async () => {
  const db = await freshDb(drainDef(MIG));
  await db.exec("INSERT INTO legacy_src VALUES ('auto:legacy_audit:a'), ('auto:legacy_audit:b')");
  await db.exec("INSERT INTO mismatch_src VALUES ('auto:policy_election_mismatch:a')");
  await enqueue(db, "legacy", "policy:a");
  await enqueue(db, "legacy", "policy:b");
  await enqueue(db, "mismatch", "policy:a");
  assertEquals(await scalar(db, "SELECT dispatch_gap_drain()"), 3);
  const calls = await rows<{ arm: string }>(db, "SELECT arm FROM keyed_calls ORDER BY n");
  assertEquals(calls.map((c) => c.arm).sort(), ["legacy", "mismatch"]);
});

Deno.test("C4 新舊 drain 對同一批事件結果相同（常駐表、事件狀態）", async () => {
  const run = async (sql: string) => {
    const db = await freshDb(sql);
    await db.exec("INSERT INTO legacy_src VALUES ('auto:legacy_audit:a'), ('auto:legacy_audit:b')");
    await db.exec("INSERT INTO mismatch_src VALUES ('auto:policy_election_mismatch:a')");
    for (const [arm, k] of [["legacy", "policy:a"], ["legacy", "policy:b"], ["mismatch", "policy:a"], ["boom", "x"]]) await enqueue(db, arm, k);
    const done = await scalar(db, "SELECT dispatch_gap_drain()");
    const gaps = await rows(db, "SELECT arm, gap_key, scope_key, payload FROM dispatch_gaps ORDER BY arm, gap_key");
    const evs = await rows(db, "SELECT arm, scope_key, (processed_at IS NOT NULL) AS done, attempts, last_error FROM dispatch_gap_events ORDER BY id");
    return { done, gaps, evs };
  };
  assertEquals(await run(drainDef(MIG)), await run(drainDef(P0)));
});

Deno.test("D1 有批次：每臂寫一筆 gap_drain:<臂>，成功 ok、失敗 not ok 且 attempts＋1；沒批次不寫", async () => {
  const db = await freshDb(drainDef(MIG));
  await db.exec("INSERT INTO legacy_src VALUES ('auto:legacy_audit:a'), ('auto:legacy_audit:b')");
  await enqueue(db, "legacy", "policy:a");
  await enqueue(db, "legacy", "policy:b");
  await enqueue(db, "boom", "x");
  // 沒批次（手動呼叫）：不寫計時
  await db.exec("SELECT set_config('dispatch_gap.run_id', '', false)");
  await db.exec("SELECT dispatch_gap_drain()");
  assertEquals(await scalar(db, "SELECT count(*)::int FROM seed_arm_timings"), 0);
  // boom 失敗留著 attempts＋1，下一輪再取；legacy 已處理
  await enqueue(db, "legacy", "policy:a");
  await db.exec("SELECT set_config('dispatch_gap.run_id', '2026-11-27 12:00:00+00', false)");
  await db.exec("SELECT dispatch_gap_drain()");
  const t = await rows<{ arm: string; row_count: number; ok: boolean; error: string | null }>(db, "SELECT arm, row_count, ok, error FROM seed_arm_timings ORDER BY arm");
  assertEquals(t.map((r) => [r.arm, r.row_count, r.ok]), [["gap_drain:boom", 1, false], ["gap_drain:legacy", 1, true]]);
  assert((t[0].error ?? "").includes("假臂故意失敗"));
  assertEquals(await scalar(db, "SELECT attempts FROM dispatch_gap_events WHERE arm = 'boom'"), 2);
});

// ============================================================
// E. 還原驗證
// ============================================================
Deno.test("E1 把逐臂計時拿掉，D1 的判斷會紅", async () => {
  const broken = drainDef(MIG).replace(/PERFORM seed_arm_timing_log\([^;]*;/g, "NULL;");
  const db = await freshDb(broken);
  await db.exec("INSERT INTO legacy_src VALUES ('auto:legacy_audit:a')");
  await enqueue(db, "legacy", "policy:a");
  await db.exec("SELECT set_config('dispatch_gap.run_id', '2026-11-27 12:00:00+00', false)");
  await db.exec("SELECT dispatch_gap_drain()");
  assertEquals(await scalar(db, "SELECT count(*)::int FROM seed_arm_timings"), 0, "還原後應該量不到逐臂計時");
});
