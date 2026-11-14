/**
 * 代理斷路器＋同一代理重派冷卻（migration 20261114080000_agent_breaker_skip_cooldown.sql）。
 *
 *   A. 文字層：兩支派工函式 ＝ 上一版逐字 ＋ 標記區塊（驗證池另改 15 分鐘排除只看代號）；預設值；回看期有上限（清理守門抽得出來）
 *   B. PGlite 斷路器：任務領走（lease_events）＋驗證票領走（verify_dispatches）合計達門檻且零回報才暫停、交件／投票／skip 任一種算回報、
 *      別的代理不受影響、暫停到期恢復、門檻可由 queue_settings 調
 *   C. PGlite 重派冷卻：只擋同一代理（不看 ip_hash）、別的代理照領、冷卻到期恢復、交件後解除、skip 也涵蓋、秒數可調（0＝關）、驗證票同樣適用
 *   D. /next 入口：暫停回 none＋paused、冷卻中全空回 none＋retry_after_seconds、函式沒上線不擋派工
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";
import { parseBreakerState, pausedFields, redispatchCooldownFields } from "./agent-breaker.ts";
import { loadEntry, type RestCall } from "./entry-harness.ts";

const MIG_NAME = "20261114080000_agent_breaker_skip_cooldown.sql";
const MIG = await readMig(MIG_NAME);

// ---------------- A. 文字層 ----------------
Deno.test("A1 contribution_queue_tasks：新定義 ＝ 上一版逐字 ＋ 一段標記區塊（合格：同代理重派冷卻）", async () => {
  const prev = await latestFn("contribution_queue_tasks", MIG_NAME);
  const neu = fnText(MIG, "contribution_queue_tasks");
  const stripped = neu.replace(/    -- >>> 合格：同代理重派冷卻\n[\s\S]*?    -- <<< 合格：同代理重派冷卻\n/, "");
  assertNotEquals(stripped, neu, "有標記區塊");
  assertEquals(stripped, prev);
  assert(neu.includes("lower(le.agent_name) = lower(p_agent)"), "只比代號，不比 ip_hash");
  assert(!/ip_hash/.test(neu.slice(neu.indexOf("-- >>> 合格：同代理重派冷卻"), neu.indexOf("-- <<< 合格：同代理重派冷卻"))));
});

Deno.test("A2 contribution_verify_pool：新定義 ＝ 上一版逐字 ＋ 冷卻區塊 ＋ 15 分鐘排除改只看代號", async () => {
  const prev = await latestFn("contribution_verify_pool", MIG_NAME);
  const neu = fnText(MIG, "contribution_verify_pool");
  let stripped = neu.replace(/    -- >>> 同代理重派冷卻[^\n]*\n[\s\S]*?    -- <<< 同代理重派冷卻\n/, "");
  assertNotEquals(stripped, neu, "有冷卻區塊");
  const before = stripped;
  stripped = stripped.replace(/      WHERE vd\.contribution_id = c\.id\n        -- >>> 只看代號[^\n]*\n[^\n]*\n        -- <<< 只看代號\n/,
    "      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash\n        AND (p_agent_name IS NULL OR lower(vd.agent_name) = lower(p_agent_name))\n");
  assertNotEquals(stripped, before, "有 15 分鐘排除的改動");
  assertEquals(stripped, prev);
});

Deno.test("A3 預設值：斷路器 開／2 小時／5 件／暫停 1 小時；重派冷卻 4 小時；回看期與暫停都有 86400 上限", () => {
  assert(MIG.includes("breaker_enabled            BOOLEAN NOT NULL DEFAULT true"));
  assert(MIG.includes("breaker_window_seconds     INTEGER NOT NULL DEFAULT 7200"));
  assert(MIG.includes("breaker_min_leases         INTEGER NOT NULL DEFAULT 5"));
  assert(MIG.includes("breaker_pause_seconds      INTEGER NOT NULL DEFAULT 3600"));
  assert(MIG.includes("redispatch_cooldown_seconds INTEGER NOT NULL DEFAULT 14400"));
  assert(MIG.includes("CHECK (redispatch_cooldown_seconds BETWEEN 0 AND 86400)"), "讀 verify_dispatches 的回看期上限＝清理守門抽得出來的 24 小時");
});

Deno.test("A4 不新增表、不動 contribution_task_skips 的結構與驗證票基準繼承", () => {
  assert(!/CREATE TABLE/i.test(MIG));
  assert(!/ALTER TABLE contribution_task_skips/i.test(MIG));
  assert(!/verify_ticket_base|verify_inherited_priority_seconds|task_dispatches_queue_key/.test(MIG));
});

// ---------------- 共用：PGlite 環境 ----------------
async function build(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    SET check_function_bodies = off;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE queue_settings (id integer PRIMARY KEY);
    INSERT INTO queue_settings VALUES (1);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_name text, task_id text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE contribution_votes (id bigserial PRIMARY KEY, contribution_id uuid, agent_name text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE lease_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, task_id text NOT NULL, agent_name text NOT NULL, ip_hash text NOT NULL,
      event text NOT NULL, at timestamptz NOT NULL DEFAULT now(), meta jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE verify_dispatches (contribution_id uuid NOT NULL, ip_hash text NOT NULL, agent_name text, dispatched_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (contribution_id, ip_hash));
  `);
  await db.exec((await readMig("20260915000002_task_skips.sql")).replace(/ALTER TABLE contribution_task_skips ENABLE ROW LEVEL SECURITY;[\s\S]*$/, ""));
  await db.exec(MIG);
  return db;
}
// deno-lint-ignore no-explicit-any
const q = async (db: PGlite, sql: string, params: unknown[] = []): Promise<any[]> => (await db.query(sql, params)).rows;
const ev = (db: PGlite, agent: string, agoSec: number, taskId = `auto:t${Math.random()}`, event = "issued", ip = "ip") =>
  db.query(`INSERT INTO lease_events (task_id, agent_name, ip_hash, event, at) VALUES ($1, $2, $3, $4, now() - make_interval(secs => $5))`, [taskId, agent, ip, event, agoSec]);
const claim = (db: PGlite, agent: string, agoSec: number, ip = "ip", cid = crypto.randomUUID()) =>
  db.query(`INSERT INTO verify_dispatches (contribution_id, ip_hash, agent_name, dispatched_at) VALUES ($1, $2, $3, now() - make_interval(secs => $4))`, [cid, ip, agent, agoSec]).then(() => cid);
const state = async (db: PGlite, agent: string) => (await q(db, `SELECT * FROM agent_breaker_state($1)`, [agent]))[0];

// ---------------- B. 斷路器 ----------------
Deno.test("B1 領走 5 件（任務 3＋驗證票 2 合計）、零回報 → 暫停，retry_after_seconds 約 1 小時扣掉已過去的時間", async () => {
  const db = await build();
  for (const ago of [600, 500, 400]) await ev(db, "gk01", ago);
  for (const ago of [300, 200]) await claim(db, "gk01", ago);
  const s = await state(db, "gk01");
  assertEquals([s.leases, s.reports, s.tripped, s.paused], [5, 0, true, true]);
  assert(s.retry_after_seconds > 3300 && s.retry_after_seconds <= 3400, `retry ${s.retry_after_seconds}`);
});

Deno.test("B2 只領驗證票也算（5 張驗證票、零投票）；領走 4 件不到門檻；別的代理不受影響", async () => {
  const db = await build();
  for (const ago of [600, 500, 400, 300, 200]) await claim(db, "grok", ago, `ip${ago}`);
  assertEquals((await state(db, "grok")).paused, true);
  for (const ago of [600, 500, 400, 300]) await ev(db, "four", ago);
  assertEquals((await state(db, "four")).paused, false);
  for (const ago of [100, 90, 80, 70, 60]) await ev(db, "other", ago);
  await db.query(`INSERT INTO contributions (agent_name) VALUES ('other')`);
  assertEquals((await state(db, "other")).paused, false, "other 有交件");
  assertEquals((await state(db, "nobody")).leases, 0);
});

Deno.test("B3 有回報就不觸發：交件、投票、skip（紀錄表）、skip（釋放認領事件）各一種都算", async () => {
  for (const [name, sql] of [
    ["交件", `INSERT INTO contributions (agent_name) VALUES ('gk01')`],
    ["投票", `INSERT INTO contribution_votes (agent_name) VALUES ('gk01')`],
    ["skip 紀錄", `INSERT INTO contribution_task_skips (task_id, ip_hash, agent_name) VALUES ('auto:x', 'h', 'gk01')`],
    ["skip 釋放認領", `INSERT INTO lease_events (task_id, agent_name, ip_hash, event) VALUES ('auto:y', 'gk01', 'ip', 'released')`],
  ] as const) {
    const db = await build();
    for (const ago of [600, 500, 400, 300, 200, 100]) await ev(db, "gk01", ago);
    assertEquals((await state(db, "gk01")).paused, true, `${name} 前`);
    await db.exec(sql);
    const s = await state(db, "gk01");
    assertEquals([s.reports, s.tripped, s.paused], [1, false, false], name);
  }
});

Deno.test("B4 視窗外的回報與領走不算；暫停期滿後恢復（領走還在視窗內但已過 1 小時）", async () => {
  const db = await build();
  for (const ago of [5000, 4900, 4800, 4700, 4600]) await ev(db, "gk01", ago);
  await db.query(`INSERT INTO contributions (agent_name, created_at) VALUES ('gk01', now() - interval '3 hours')`);
  const s = await state(db, "gk01");
  assertEquals([s.leases, s.reports, s.tripped, s.paused, s.retry_after_seconds], [5, 0, true, false, 0], "暫停已過期");
  for (const ago of [7300, 7400, 7500, 7600, 7700]) await ev(db, "old", ago);
  assertEquals((await state(db, "old")).leases, 0, "視窗外的領走不算");
});

Deno.test("B5 門檻可由 queue_settings 調：min_leases、window、pause、enabled", async () => {
  const db = await build();
  for (const ago of [600, 500, 400]) await ev(db, "a", ago);
  assertEquals((await state(db, "a")).paused, false);
  await db.exec(`UPDATE queue_settings SET breaker_min_leases = 3 WHERE id = 1`);
  assertEquals((await state(db, "a")).paused, true, "門檻 3");
  await db.exec(`UPDATE queue_settings SET breaker_pause_seconds = 100 WHERE id = 1`);
  assertEquals((await state(db, "a")).paused, false, "暫停只有 100 秒、最後一次領走在 400 秒前");
  await db.exec(`UPDATE queue_settings SET breaker_pause_seconds = 3600, breaker_window_seconds = 450 WHERE id = 1`);
  const s = await state(db, "a");
  assertEquals([s.leases, s.paused], [1, false], "視窗縮到 450 秒只剩 400 秒前那 1 件");
  await db.exec(`UPDATE queue_settings SET breaker_window_seconds = 7200, breaker_enabled = false WHERE id = 1`);
  assertEquals((await state(db, "a")).paused, false, "關掉開關");
  let rejected = false;
  try { await db.exec(`UPDATE queue_settings SET breaker_window_seconds = 999999 WHERE id = 1`); } catch { rejected = true; }
  assert(rejected, "視窗上限 86400 由 CHECK 擋");
});

Deno.test("B6 agent_breaker_status 視圖：任務與驗證票的領走都列出", async () => {
  const db = await build();
  for (const ago of [600, 500, 400, 300, 200]) await ev(db, "t-agent", ago);
  for (const ago of [600, 500, 400, 300, 200]) await claim(db, "v-agent", ago, `i${ago}`);
  const st = await q(db, `SELECT agent_name, paused FROM agent_breaker_status ORDER BY agent_name`);
  assertEquals(st.map((r) => [r.agent_name, r.paused]), [["t-agent", true], ["v-agent", true]]);
});

// ---------------- C. 重派冷卻 ----------------
/** 把函式裡的標記區塊取出來，包成 WHERE 條件去濾一張假的候選表，測的是真正寫在 migration 裡的那段 SQL */
function blockOf(fn: string, open: string, close: string): string {
  const text = fnText(MIG, fn);
  const i = text.indexOf(open);
  const j = text.indexOf(close);
  assert(i >= 0 && j > i, `${fn} 找不到標記區塊`);
  return text.slice(i, j);
}
const V = "11111111-1111-4111-8111-111111111111";
async function cooldownDb(): Promise<PGlite> {
  const db = await build();
  const qb = blockOf("contribution_queue_tasks", "-- >>> 合格：同代理重派冷卻", "    -- <<< 合格：同代理重派冷卻");
  const pb = blockOf("contribution_verify_pool", "-- >>> 同代理重派冷卻", "    -- <<< 同代理重派冷卻");
  await db.exec(`
    CREATE TABLE cand (task_id text PRIMARY KEY);
    INSERT INTO cand VALUES ('auto:a'), ('auto:b'), ('verify:${V}');
    CREATE FUNCTION pick_task(p_agent text) RETURNS SETOF text LANGUAGE sql STABLE AS $$ SELECT d.task_id FROM cand d WHERE d.task_id LIKE 'auto:%' ${qb} ORDER BY 1 $$;
    CREATE FUNCTION pick_verify(p_agent_name text) RETURNS SETOF text LANGUAGE sql STABLE AS $$ SELECT c.id::text FROM (SELECT '${V}'::uuid AS id) c WHERE true ${pb} $$;
  `);
  return db;
}
const tasks = async (db: PGlite, agent: string) => (await q(db, `SELECT * FROM pick_task($1)`, [agent])).map((r) => r.pick_task);
const verifies = async (db: PGlite, agent: string) => (await q(db, `SELECT * FROM pick_verify($1)`, [agent])).map((r) => r.pick_verify);

Deno.test("C1 被派過的任務 4 小時內不再派給同一個代理；別的代理照領（同網段也一樣）；只比代號、大小寫不分", async () => {
  const db = await cooldownDb();
  await ev(db, "grok", 60, "auto:a", "issued", "ipX");
  assertEquals(await tasks(db, "grok"), ["auto:b"]);
  assertEquals(await tasks(db, "GROK"), ["auto:b"], "代號大小寫不分");
  assertEquals(await tasks(db, "claude"), ["auto:a", "auto:b"], "別的代理照領");
  await ev(db, "grok", 30, "auto:b", "issued", "ipDifferent"); // 換網段、同代號：仍是同一個代理
  assertEquals(await tasks(db, "grok"), []);
  assertEquals(await tasks(db, "claude"), ["auto:a", "auto:b"]);
});

Deno.test("C2 冷卻到期恢復：派出在 4 小時 1 分鐘前 → 又可派", async () => {
  const db = await cooldownDb();
  await ev(db, "grok", 14400 + 60, "auto:a");
  assertEquals(await tasks(db, "grok"), ["auto:a", "auto:b"]);
  await ev(db, "grok", 14400 - 60, "auto:a");
  assertEquals(await tasks(db, "grok"), ["auto:b"]);
});

Deno.test("C3 交件後解除冷卻（交在派出之後才算）；skip（派出後釋放認領）仍在冷卻", async () => {
  const db = await cooldownDb();
  await ev(db, "grok", 600, "auto:a");
  await db.query(`INSERT INTO contributions (agent_name, task_id, created_at) VALUES ('grok', 'auto:a', now() - interval '100 seconds')`);
  assertEquals(await tasks(db, "grok"), ["auto:a", "auto:b"], "派出後交過件");
  await ev(db, "grok", 600, "auto:b");
  await db.query(`INSERT INTO contributions (agent_name, task_id, created_at) VALUES ('grok', 'auto:b', now() - interval '1 hour')`);
  assertEquals(await tasks(db, "grok"), ["auto:a"], "派出之前的交件不算");
  await ev(db, "grok", 300, "auto:a", "released"); // skip
  assertEquals(await tasks(db, "grok"), ["auto:a"], "skip 之後 issued 還在冷卻內");
  assertEquals(await tasks(db, "claude"), ["auto:a", "auto:b"]);
});

Deno.test("C4 秒數可由 queue_settings 調：縮短、設 0＝關閉、CHECK 擋超過 24 小時", async () => {
  const db = await cooldownDb();
  await ev(db, "grok", 600, "auto:a");
  await claim(db, "grok", 600, "ip", V);
  await db.exec(`UPDATE queue_settings SET redispatch_cooldown_seconds = 300 WHERE id = 1`);
  assertEquals(await tasks(db, "grok"), ["auto:a", "auto:b"], "冷卻縮成 5 分鐘，10 分鐘前的派出已解凍");
  assertEquals(await verifies(db, "grok"), [V]);
  await db.exec(`UPDATE queue_settings SET redispatch_cooldown_seconds = 3600 WHERE id = 1`);
  assertEquals(await tasks(db, "grok"), ["auto:b"]);
  assertEquals(await verifies(db, "grok"), []);
  await db.exec(`UPDATE queue_settings SET redispatch_cooldown_seconds = 0 WHERE id = 1`);
  assertEquals(await tasks(db, "grok"), ["auto:a", "auto:b"], "0＝不冷卻");
  assertEquals(await verifies(db, "grok"), [V]);
  let rejected = false;
  try { await db.exec(`UPDATE queue_settings SET redispatch_cooldown_seconds = 90000 WHERE id = 1`); } catch { rejected = true; }
  assert(rejected);
});

Deno.test("C5 驗證票：被派過就不再派給同一代理（Grok 案：領了不投重打 /next，沒有 skip 紀錄）；別的代理、沒有代號不受影響；換網段同代號也擋", async () => {
  const db = await cooldownDb();
  await claim(db, "grok", 120, "ipX", V);
  assertEquals(await verifies(db, "grok"), []);
  assertEquals(await verifies(db, "Grok"), []);
  assertEquals(await verifies(db, "claude"), [V]);
  assertEquals((await q(db, `SELECT * FROM pick_verify(NULL)`)).length, 1, "沒有代號時不套用");
  await db.query(`DELETE FROM verify_dispatches`);
  await claim(db, "grok", 14400 + 60, "ipX", V);
  assertEquals(await verifies(db, "grok"), [V], "到期恢復");
});

Deno.test("C6 agent_cooldown_thaw_seconds：最早解凍的那一件還要幾秒；沒有冷卻中的回 NULL；投過的驗證票與交過件的任務不算", async () => {
  const db = await cooldownDb();
  const thaw = async (a: string) => (await q(db, `SELECT agent_cooldown_thaw_seconds($1) s`, [a]))[0].s;
  assertEquals(await thaw("grok"), null);
  await ev(db, "grok", 14000, "auto:a");
  await claim(db, "grok", 100, "ip", V);
  const s = await thaw("grok");
  assert(s >= 399 && s <= 401, `thaw ${s}`);
  assertEquals(await thaw("claude"), null);
  await db.query(`INSERT INTO contributions (agent_name, task_id, created_at) VALUES ('grok', 'auto:a', now() - interval '10 seconds')`);
  const s2 = await thaw("grok");
  assert(s2 >= 14299 && s2 <= 14301, `thaw ${s2}`);
  await db.query(`INSERT INTO contribution_votes (contribution_id, agent_name) VALUES ($1, 'grok')`, [V]);
  assertEquals(await thaw("grok"), null);
});

// ---------------- D. TS 純函式與 /next 入口 ----------------
Deno.test("D1 parseBreakerState／pausedFields／redispatchCooldownFields", () => {
  assertEquals(parseBreakerState(null), null);
  assertEquals(parseBreakerState([]), null);
  assertEquals(parseBreakerState([{ nothing: 1 }]), null);
  const s = parseBreakerState([{ paused: true, retry_after_seconds: 3300, paused_until: "2026-11-14T10:00:00Z", leases: 6, reports: 0, window_seconds: 7200, min_leases: 5 }]);
  assert(s?.paused);
  const f = pausedFields(s!);
  assertEquals([f.kind, f.paused, f.retry_after_seconds, f.retry_after_min], ["none", true, 3300, 55]);
  assert(String(f.reason).includes("暫停"));
  assertEquals(redispatchCooldownFields(null), null);
  assertEquals(redispatchCooldownFields(0), null);
  const c = redispatchCooldownFields(1200)!;
  assertEquals([c.kind, c.retry_after_seconds, c.retry_after_min, c.redispatch_cooldown], ["none", 1200, 20, true]);
});

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789", CONTRIBUTION_IP_SALT: "salt" };
const taskRow = { task_id: "auto:profile_gap:abc", task_type: "profile_gap", target: {}, what_we_need: "補基本資料", hint_sources: [], reward: 1, queue_at: "2026-10-01T00:00:00Z" };

async function callNext(router: (c: RestCall) => unknown): Promise<{ status: number; body: Record<string, unknown>; calls: RestCall[] }> {
  const entry = await loadEntry("../next/index.ts", env, router);
  try {
    const res = await entry.call(new Request(`https://x/next?agent_name=gk01&agent_tool=claude-code/claude-sonnet-5`, { headers: { "x-forwarded-for": "10.1.1.5" } }));
    return { status: res.status, body: await res.json(), calls: entry.calls };
  } finally {
    entry.restore();
  }
}

Deno.test("D2 /next 暫停中：回 none＋paused＋retry_after_seconds，不租約、不派出", async () => {
  const r = await callNext((c) => {
    if (c.target === "rpc/agent_breaker_state") return [{ paused: true, retry_after_seconds: 1800, paused_until: "2026-11-14T10:00:00Z", leases: 5, reports: 0, window_seconds: 7200, min_leases: 5 }];
    if (c.target === "rpc/contribution_queue_tasks") return [taskRow];
    return undefined;
  });
  assertEquals(r.status, 200);
  assertEquals([r.body.kind, r.body.paused, r.body.retry_after_seconds, r.body.retry_after_min], ["none", true, 1800, 30]);
  assertEquals(r.body.success, true);
  assert(!r.calls.some((c) => c.target === "contribution_task_leases" && c.method !== "GET"));
  assert(!r.calls.some((c) => c.target === "rpc/task_dispatched"));
});

Deno.test("D3 /next 沒暫停：照常派；函式還沒上線（rpc 錯誤）也照常派", async () => {
  const ok = await callNext((c) => {
    if (c.target === "rpc/agent_breaker_state") return [{ paused: false, retry_after_seconds: 0, leases: 1, reports: 0, window_seconds: 7200, min_leases: 5 }];
    if (c.target === "rpc/contribution_queue_tasks") return [taskRow];
    return undefined;
  });
  assertEquals(ok.body.kind, "task");
  const noFn = await callNext((c) => {
    if (c.target === "rpc/agent_breaker_state") return { code: "PGRST202", message: "function not found", details: "", hint: null };
    if (c.target === "rpc/contribution_queue_tasks") return [taskRow];
    return undefined;
  });
  assertEquals(noFn.body.kind, "task");
});

Deno.test("D4 /next 佇列與驗證池全空、但這個代理有冷卻中的件：回 none＋retry_after_seconds＋redispatch_cooldown", async () => {
  const r = await callNext((c) => (c.target === "rpc/agent_cooldown_thaw_seconds" ? 1500 : undefined));
  assertEquals([r.body.kind, r.body.redispatch_cooldown, r.body.retry_after_seconds, r.body.retry_after_min], ["none", true, 1500, 25]);
  const none = await callNext(() => undefined);
  assertEquals(none.body.kind, "none");
  assertEquals(none.body.redispatch_cooldown, undefined, "沒有冷卻中的件：維持原本的 none");
});

Deno.test("D5 skip 記錄寫法不變（task_id,ip_hash upsert）", async () => {
  const REAL = "auto:profile_gap:abc";
  const entry = await loadEntry("../next/index.ts", env, (c) => {
    if (c.target === "task_dispatches" && c.method === "GET") return [{ task_id: REAL }];
    return undefined;
  });
  try {
    await (await entry.call(new Request(`https://x/next?agent_name=gk01&agent_tool=claude-code/claude-sonnet-5&skip=${encodeURIComponent(REAL)}`, { headers: { "x-forwarded-for": "10.1.1.5" } }))).text();
    const up = entry.calls.find((c) => c.target === "contribution_task_skips" && c.method === "POST");
    assert(up);
    assertEquals(up.url.searchParams.get("on_conflict"), "task_id,ip_hash");
  } finally {
    entry.restore();
  }
});
