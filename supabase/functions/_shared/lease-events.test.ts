/**
 * 認領事件表 lease_events（migration 20261111120000_lease_events.sql）。
 * 只要 --allow-read。PGlite 跑真的觸發器與視圖；contributions／settings 用最小 stub。
 *   A. 觸發器：issued／reported／released／expired 與 meta.by
 *   B. 過期清理函式 contribution_task_leases_purge 帶明確原因
 *   C. 清理 dispatch_records_purge 多清 lease_events（保留天數、分批上限）
 *   D. 視圖 lease_outcomes_7d：7 天時限、不交率
 *   E. 文字層：回看期 7 天、保留天數與 CHECK 下限 ＞ 7 天 ＋ 邊際（lease_events 不在 dispatch-records-purge 守門的 TABLES 裡，這裡自己守）
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIG_NAME = "20261111120000_lease_events.sql";
const MIG = await Deno.readTextFile(new URL(`../../migrations/${MIG_NAME}`, import.meta.url));
const MIG2_NAME = "20261111190000_lease_release_reason.sql";
const MIG2 = await Deno.readTextFile(new URL(`../../migrations/${MIG2_NAME}`, import.meta.url));
const MARGIN_HOURS = 24;

// 最小 stub：只放觸發器與清理函式會碰到的欄位
const STUB = `
CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
CREATE TABLE contribution_task_leases (
  task_id TEXT PRIMARY KEY, target_key TEXT NOT NULL, agent_name TEXT NOT NULL, ip_hash TEXT NOT NULL,
  leased_until TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE contributions (id SERIAL PRIMARY KEY, task_id TEXT, contribution_type TEXT, payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE contribution_tasks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_type TEXT NOT NULL, target JSONB NOT NULL DEFAULT '{}');
CREATE TABLE verify_dispatches (contribution_id TEXT, ip_hash TEXT, agent_name TEXT, dispatched_at TIMESTAMPTZ);
CREATE TABLE contribution_task_skips (task_id TEXT, ip_hash TEXT, agent_name TEXT, skipped_at TIMESTAMPTZ);
CREATE TABLE dispatch_records_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1), enabled BOOLEAN NOT NULL DEFAULT true,
  verify_dispatches_days INTEGER NOT NULL DEFAULT 14, task_skips_days INTEGER NOT NULL DEFAULT 7,
  batch_size INTEGER NOT NULL DEFAULT 5000, max_batches INTEGER NOT NULL DEFAULT 20);
INSERT INTO dispatch_records_settings (id) VALUES (1);
`;

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIG);
  await db.exec(MIG2);
  return db;
}
const events = async (db: PGlite, task: string) =>
  (await db.query<{ event: string; by: string | null; agent_name: string }>(
    `SELECT event, meta->>'by' AS by, agent_name FROM lease_events WHERE task_id = $1 ORDER BY id`, [task])).rows;
const lease = (db: PGlite, task: string, agent = "A", until = "now() + interval '30 minutes'", created = "now()") =>
  db.exec(`INSERT INTO contribution_task_leases (task_id, target_key, agent_name, ip_hash, leased_until, created_at) VALUES ('${task}', 'k', '${agent}', 'h', ${until}, ${created})`);

Deno.test("A1 建立租約寫 issued（只存雜湊）；同一代理重領（UPDATE）不再寫", async () => {
  const db = await fresh();
  await lease(db, "t1");
  await db.exec(`UPDATE contribution_task_leases SET leased_until = now() + interval '1 hour' WHERE task_id = 't1'`);
  assertEquals((await events(db, "t1")).map((e) => e.event), ["issued"]);
  const row = (await db.query<{ ip_hash: string }>(`SELECT ip_hash FROM lease_events`)).rows[0];
  assertEquals(row.ip_hash, "h");
});

Deno.test("A2 租約建立後有人交件、再刪除＝reported", async () => {
  const db = await fresh();
  await lease(db, "t2");
  await db.exec(`INSERT INTO contributions (task_id) VALUES ('t2')`);
  await db.exec(`DELETE FROM contribution_task_leases WHERE task_id = 't2'`);
  const ev = await events(db, "t2");
  assertEquals(ev.map((e) => e.event), ["issued", "reported"]);
  assertEquals(ev[1].by, "contribution_after_lease");
});

Deno.test("A2b 交件只帶 payload.task_id（no_change）也算 reported；其他型別只帶 payload 不算（索引限制）", async () => {
  const db = await fresh();
  await lease(db, "t2b");
  await db.exec(`INSERT INTO contributions (task_id, contribution_type, payload) VALUES (NULL, 'no_change', '{"task_id":"t2b"}')`);
  await db.exec(`DELETE FROM contribution_task_leases WHERE task_id = 't2b'`);
  assertEquals((await events(db, "t2b")).map((e) => e.event), ["issued", "reported"]);
  await lease(db, "t2c");
  await db.exec(`INSERT INTO contributions (task_id, contribution_type, payload) VALUES (NULL, 'candidacy', '{"task_id":"t2c"}')`);
  await db.exec(`DELETE FROM contribution_task_leases WHERE task_id = 't2c'`);
  assertEquals((await events(db, "t2c")).map((e) => e.event), ["issued", "released"]);
});

Deno.test("A3沒交件、沒過期就刪（skip 主動釋放）＝released", async () => {
  const db = await fresh();
  await lease(db, "t3");
  await db.exec(`DELETE FROM contribution_task_leases WHERE task_id = 't3'`);
  const ev = await events(db, "t3");
  assertEquals(ev.map((e) => e.event), ["issued", "released"]);
  assertEquals(ev[1].by, "default");
});

Deno.test("A4 租約建立之前就有的舊貢獻不算交件（同 task_id 上一輪交過、這一輪沒交）", async () => {
  const db = await fresh();
  await db.exec(`INSERT INTO contributions (task_id, created_at) VALUES ('t4', now() - interval '2 days')`);
  await lease(db, "t4");
  await db.exec(`DELETE FROM contribution_task_leases WHERE task_id = 't4'`);
  assertEquals((await events(db, "t4")).map((e) => e.event), ["issued", "released"]);
});

Deno.test("A5 已過期、沒交件，直接 DELETE＝expired（推斷）", async () => {
  const db = await fresh();
  await lease(db, "t5", "A", "now() - interval '1 minute'", "now() - interval '31 minutes'");
  await db.exec(`DELETE FROM contribution_task_leases WHERE task_id = 't5'`);
  const ev = await events(db, "t5");
  assertEquals(ev[1].event, "expired");
  assertEquals(ev[1].by, "leased_until_passed");
});

Deno.test("A6 session 設定 app.lease_release_reason 優先於推斷", async () => {
  const db = await fresh();
  await lease(db, "t6");
  await db.exec(`BEGIN; SELECT set_config('app.lease_release_reason', 'reported', true); DELETE FROM contribution_task_leases WHERE task_id = 't6'; COMMIT;`);
  const ev = await events(db, "t6");
  assertEquals(ev[1].event, "reported");
  assertEquals(ev[1].by, "setting");
});

Deno.test("B 過期清理函式：只清過期的、事件是 expired（by=setting）、設定不外洩到同交易之後", async () => {
  const db = await fresh();
  await lease(db, "old", "A", "now() - interval '1 minute'", "now() - interval '31 minutes'");
  await lease(db, "live", "B");
  const n = (await db.query<{ contribution_task_leases_purge: number }>(`SELECT contribution_task_leases_purge()`)).rows[0].contribution_task_leases_purge;
  assertEquals(n, 1);
  const ev = await events(db, "old");
  assertEquals(ev.map((e) => e.event), ["issued", "expired"]);
  assertEquals(ev[1].by, "setting");
  assertEquals((await events(db, "live")).map((e) => e.event), ["issued"]);
  assertEquals((await db.query<{ v: string }>(`SELECT current_setting('app.lease_release_reason', true) AS v`)).rows[0].v, "");
});

Deno.test("C 清理：超過 lease_events_days 的刪、沒超過的留；分批上限生效", async () => {
  const db = await fresh();
  await db.exec(`INSERT INTO lease_events (task_id, agent_name, ip_hash, event, at) VALUES
    ('o1','A','h','issued', now() - interval '15 days'), ('o2','A','h','issued', now() - interval '15 days'),
    ('o3','A','h','issued', now() - interval '15 days'), ('n1','A','h','issued', now() - interval '13 days')`);
  const r = (await db.query<{ dispatch_records_purge: { lease_events: number; enabled: boolean } }>(`SELECT dispatch_records_purge()`)).rows[0].dispatch_records_purge;
  assertEquals(r.lease_events, 3);
  assertEquals((await db.query(`SELECT 1 FROM lease_events`)).rows.length, 1);
  // 批量上限：batch_size 下限 100 的 CHECK 在 stub 沒有，直接設 1 批 × 1 筆
  await db.exec(`INSERT INTO lease_events (task_id, agent_name, ip_hash, event, at) VALUES ('p1','A','h','issued', now() - interval '20 days'), ('p2','A','h','issued', now() - interval '20 days')`);
  await db.exec(`UPDATE dispatch_records_settings SET batch_size = 1, max_batches = 1`);
  const r2 = (await db.query<{ dispatch_records_purge: { lease_events: number } }>(`SELECT dispatch_records_purge()`)).rows[0].dispatch_records_purge;
  assertEquals(r2.lease_events, 1);
  await db.exec(`UPDATE dispatch_records_settings SET enabled = false`);
  const r3 = (await db.query<{ dispatch_records_purge: { enabled: boolean; lease_events: number } }>(`SELECT dispatch_records_purge()`)).rows[0].dispatch_records_purge;
  assertEquals(r3.enabled, false);
});

Deno.test("D 視圖 lease_outcomes_7d：只算 7 天內、依代理統計、不交率＝expired／(reported＋expired)", async () => {
  const db = await fresh();
  const ins = (agent: string, ev: string, ago: string) =>
    db.exec(`INSERT INTO lease_events (task_id, agent_name, ip_hash, event, at) VALUES ('x','${agent}','h','${ev}', now() - interval '${ago}')`);
  for (const e of ["issued", "issued", "issued", "issued"]) await ins("A", e, "1 day");
  await ins("A", "reported", "1 day"); await ins("A", "expired", "1 day"); await ins("A", "expired", "1 day"); await ins("A", "released", "1 day");
  await ins("A", "expired", "8 days"); // 超過 7 天：不算
  await ins("B", "issued", "2 days");
  const rows = (await db.query<{ agent_name: string; issued: string; reported: string; expired: string; released: string; no_show_rate: string | null }>(
    `SELECT * FROM lease_outcomes_7d ORDER BY agent_name`)).rows;
  assertEquals(rows.length, 2);
  assertEquals([rows[0].issued, rows[0].reported, rows[0].expired, rows[0].released].map(Number), [4, 1, 2, 1]);
  assertEquals(Number(rows[0].no_show_rate), 0.667);
  assertEquals(rows[1].no_show_rate, null); // 沒有結案的：不是 0
});

Deno.test("E 文字層：視圖有 7 天時限、保留天數預設與 CHECK 下限 ＞ 回看期 ＋ 邊際", () => {
  const view = /CREATE OR REPLACE VIEW lease_outcomes_7d[\s\S]*?;\r?\n/.exec(MIG)?.[0] ?? "";
  const m = /\bat\s*>=\s*now\(\)\s*-\s*interval\s*'(\d+)\s*days'/i.exec(view);
  assert(m, "lease_outcomes_7d 沒有 at >= now() - interval 'N days' 時限");
  const lookbackHours = Number(m[1]) * 24;
  const def = /ADD COLUMN IF NOT EXISTS lease_events_days INTEGER NOT NULL DEFAULT (\d+)/.exec(MIG);
  const chk = /CHECK \(lease_events_days BETWEEN (\d+) AND \d+\)/.exec(MIG);
  assert(def && chk, "抽不出 lease_events_days 的預設值或 CHECK");
  assert(Number(def[1]) * 24 >= lookbackHours + MARGIN_HOURS, "預設保留天數不夠");
  assert(Number(chk[1]) * 24 >= lookbackHours + MARGIN_HOURS, "CHECK 下限不夠，資料庫攔不住有人改小");
  // 還原驗證：拿掉時限就該抓得到
  assertEquals(/\bat\s*>=\s*now\(\)/i.test(view.replace(/at >= now\(\) - interval '7 days'/, "")), false);
});

/**
 * 登記的讀者：只有這些 migration 可以讀 lease_events，而且每一處讀取都要有 `at >= … interval 'N days'` 時限，
 * N 天 ＋ 邊際 ≤ 保留天數預設（lease_events_days）。要新增讀者就在這裡登記並說明回看期。
 *   20261111140000_trace_events.sql、20261111160000_trace_events_system_vote.sql：/trace 重播頁的 trace_events()，回看 13 天
 */
const REGISTERED_READERS = ["20261111140000_trace_events.sql", "20261111160000_trace_events_system_vote.sql"];

/** 登記讀者的每一處 FROM lease_events 的問題清單（空＝合格） */
function leaseReaderProblems(name: string, sql: string, retentionDays: number): string[] {
  const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const out: string[] = [];
  const reads = [...code.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?lease_events\s+(\w+)([\s\S]*?)(?=\n\s*(?:ORDER BY|UNION ALL|\)))/gi)];
  if (reads.length === 0) out.push(`${name}：登記為讀者卻抽不到 FROM lease_events`);
  for (const r of reads) {
    const alias = r[1];
    const m = new RegExp(`\\b${alias}\\.at\\s*>=\\s*GREATEST\\(\\s*\\w+\\s*,\\s*now\\(\\)\\s*-\\s*interval\\s*'(\\d+)\\s*days'\\s*\\)`, "i").exec(r[2]);
    if (!m) out.push(`${name}：讀 lease_events（別名 ${alias}）沒有 at >= … interval 'N days' 時限`);
    else if (Number(m[1]) * 24 + MARGIN_HOURS > retentionDays * 24) out.push(`${name}：回看 ${m[1]} 天 ＋ 邊際超過保留 ${retentionDays} 天`);
  }
  return out;
}

Deno.test("E2 其他 migration 不得讀 lease_events 而沒有時限（只有視圖、清理函式，以及登記的讀者且每處有時限）", async () => {
  const retention = Number(/ADD COLUMN IF NOT EXISTS lease_events_days INTEGER NOT NULL DEFAULT (\d+)/.exec(MIG)?.[1]);
  assert(Number.isFinite(retention), "抽不出 lease_events_days 預設值");
  const seen: string[] = [];
  for await (const f of Deno.readDir(new URL("../../migrations/", import.meta.url))) {
    if (f.name === MIG_NAME || f.name === MIG2_NAME) continue;
    const sql = await Deno.readTextFile(new URL(`../../migrations/${f.name}`, import.meta.url));
    if (!/\b(FROM|JOIN)\s+(public\.)?lease_events\b/i.test(sql)) continue;
    seen.push(f.name);
    assert(REGISTERED_READERS.includes(f.name), `${f.name} 讀 lease_events：請加時限並更新守門`);
    assertEquals(leaseReaderProblems(f.name, sql, retention), []);
  }
  assertEquals(seen.sort(), [...REGISTERED_READERS].sort(), "登記的讀者都應該真的存在");
});

Deno.test("E2b 還原驗證：登記的讀者拿掉時限、回看放大到超過保留、換別名拿掉 → 都要抓得到", async () => {
  const f = REGISTERED_READERS[0];
  const sql = (await Deno.readTextFile(new URL(`../../migrations/${f}`, import.meta.url))).replace(/\r\n/g, "\n");
  assertEquals(leaseReaderProblems(f, sql, 14), []);
  const noBound = sql.replace(/l\.at >= GREATEST\(v_since, now\(\) - interval '13 days'\) AND /, "");
  assert(noBound !== sql && leaseReaderProblems(f, noBound, 14).some((p) => p.includes("沒有")), "拿掉時限要紅");
  const big = sql.replace("l.at >= GREATEST(v_since, now() - interval '13 days')", "l.at >= GREATEST(v_since, now() - interval '14 days')");
  assert(big !== sql && leaseReaderProblems(f, big, 14).some((p) => p.includes("邊際")), "回看等於保留天數（沒邊際）要紅");
});

Deno.test("E3 程式端（supabase/functions/**/*.ts，不含測試）不得讀 lease_events／lease_outcomes_7d", async () => {
  const root = new URL("../", import.meta.url);
  const bad: string[] = [];
  async function walk(dir: URL): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) { await walk(u); continue; }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      const text = await Deno.readTextFile(u);
      if (/from\(\s*["'`](lease_events|lease_outcomes_7d)["'`]/.test(text) || /\b(FROM|JOIN)\s+(lease_events|lease_outcomes_7d)\b/i.test(text)) bad.push(u.pathname);
    }
  }
  await walk(root);
  assertEquals(bad, [], "程式端讀 lease_events 必須有 at 時限，並更新這支守門與 dispatch-records-purge 的回看期");
});

const ADJ_TASK = "11111111-1111-1111-1111-111111111111";
const adjSetup = async (db: PGlite) => {
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, target) VALUES ('${ADJ_TASK}', 'adjudicate', '{"contribution_id":"c-orig","requires_tier":"strong"}')`);
  await lease(db, ADJ_TASK, "opus_judge40");
};

Deno.test("F1 強模型專線：裁決交件（task_id、payload.task_id 都空，只帶 payload.contribution_id）→ 租約被刪＝reported（推斷）", async () => {
  const db = await fresh();
  await adjSetup(db);
  await db.exec(`INSERT INTO contributions (task_id, contribution_type, payload) VALUES (NULL, 'adjudication', '{"contribution_id":"c-orig","verdict":"uphold"}')`);
  await db.exec(`DELETE FROM contribution_task_leases WHERE task_id = '${ADJ_TASK}'`);
  const ev = await events(db, ADJ_TASK);
  assertEquals(ev.map((e) => e.event), ["issued", "reported"]);
  assertEquals(ev[1].by, "contribution_after_lease");
});

Deno.test("F2 裁決的推斷只認同一件原貢獻：別件的裁決、或租約之前的裁決不算", async () => {
  const db = await fresh();
  await db.exec(`INSERT INTO contributions (task_id, contribution_type, payload, created_at) VALUES (NULL, 'adjudication', '{"contribution_id":"c-orig"}', now() - interval '2 days')`);
  await adjSetup(db);
  await db.exec(`INSERT INTO contributions (task_id, contribution_type, payload) VALUES (NULL, 'adjudication', '{"contribution_id":"c-other"}')`);
  await db.exec(`DELETE FROM contribution_task_leases WHERE task_id = '${ADJ_TASK}'`);
  assertEquals((await events(db, ADJ_TASK)).map((e) => e.event), ["issued", "released"]);
});

Deno.test("F3 lease_release 明講 reported：即使推斷不出來也記 reported（by=setting）、設定不外洩、reason 要合法", async () => {
  const db = await fresh();
  await lease(db, "f3");
  const n = (await db.query<{ lease_release: number }>(`SELECT lease_release(ARRAY['f3','nope'], 'reported')`)).rows[0].lease_release;
  assertEquals(n, 1);
  const ev = await events(db, "f3");
  assertEquals(ev.map((e) => e.event), ["issued", "reported"]);
  assertEquals(ev[1].by, "setting");
  assertEquals((await db.query<{ v: string }>(`SELECT current_setting('app.lease_release_reason', true) AS v`)).rows[0].v, "");
  let threw = false;
  try { await db.exec(`SELECT lease_release(ARRAY['x'], 'bogus')`); } catch { threw = true; }
  assert(threw);
});

Deno.test("F4 文字層：交件釋放租約走 lease_release(reported)，裁決的任務從 target.contribution_id 找回來", async () => {
  const src = await Deno.readTextFile(new URL("./contribute-handler.ts", import.meta.url));
  assert(/rpc\("lease_release",\s*\{[^}]*p_reason:\s*"reported"/.test(src));
  assert(/eq\("target->>contribution_id", cid\)/.test(src));
  assert(/GRANT EXECUTE ON FUNCTION lease_release\(TEXT\[\], TEXT\) TO service_role/.test(MIG2));
});
