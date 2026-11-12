/**
 * 工作卡③：請求／提議／指定任務建立前先用 work_key 查重併卡，並接上需求訊號
 * （migration 20261112080000_work_card_attach.sql、_shared/create-or-attach-task.ts，docs/PLAN-workcard-123.md 項目③）。
 *
 *   A. task_work_key 的 uuid 分支抽成 task_work_key_for_manual 後，輸出對舊定義逐案不變；新函式不給 anon／authenticated
 *   B. PGlite：work_card_resolve（自動缺口優先、policy_missing 與 term_policy_missing 同卡、scope 例外）、work_card_attach（冪等、無卡、插隊只一次、冷卻不插）、
 *      work_card_view_signals_sync（只算達標頁、被暫停的頁不算、冪等）
 *   C. TS createOrAttachTask：有卡不新開、無卡新開、force_new、保險絲、失敗退回舊行為；request-task 入口（term_policy_missing 併得上）、apply create_task 的 force_new；#912 兜底仍在
 *   D. 還原驗證：拿掉 work_key 比對、scope 條件、冪等的新增判斷，對應情境要翻面
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";
import { loadEntry, type RestCall } from "./jp/entry-harness.ts";
import { createOrAttachTask, workCardOf } from "./create-or-attach-task.ts";
import { decideRequest } from "./request-task.ts";

const MIG_NAME = "20261112080000_work_card_attach.sql";
const MIG = await readMig(MIG_NAME);
const DEMAND = await readMig("20261112070000_work_card_demand.sql");
const OLD_WK = await readMig("20261111100000_work_key.sql");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const P1 = "0000b296-7ae8-4184-b704-c69d44cb696a";
const P2 = "ffd273b3-1d4c-45d5-bf61-b5b418f87233";
const POL = "01c8a200-2fb6-4ff0-afdd-175e9a4643a9";
const T = (n: number) => { const h = (n % 16).toString(16); return `${h.repeat(8)}-${h.repeat(4)}-4${h.repeat(3)}-8${h.repeat(3)}-${h.repeat(12)}`; };
const KEY_P1 = `politician:${P1}:policies:2026`;

// ============================================================
// A. 文字層與逐案不變
// ============================================================
Deno.test("A1 新函式與權限：REVOKE PUBLIC／anon／authenticated、只給 service_role；不碰日本站；只加不刪", () => {
  const c = code(MIG);
  for (const f of ["task_work_key_for_manual(TEXT, JSONB)", "work_card_resolve(TEXT, TEXT)", "work_card_attach(TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT)", "work_card_view_signals_sync()"]) {
    assert(c.includes(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon, authenticated;`), `REVOKE ${f}`);
  }
  assert(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role;/.test(c));
  assert(!/policy_jp\./.test(c));
  assert(!/DROP\s+(FUNCTION|COLUMN|VIEW|TABLE)\b/i.test(c));
  assert(!/id::text\s*=\s*\S+\.id::text/.test(c));
});

const SAMPLES: Array<[string, string]> = [
  ["policy_missing", `{"politician_id":"${P1}","region":"新北市"}`],
  ["term_policy_missing", `{"politician_id":"${P1}","election_id":2024}`],
  ["policy_missing", `{"politician_id":"${P1}","election_id":2022}`],
  ["profile_gap", `{"politician_id":"${P2}"}`],
  ["profile_detail_gap", `{"politician_id":"${P2}"}`],
  ["progress_stale", `{"politician_id":"${P1}","policy_id":"${POL}"}`],
  ["policy_validity", `{"policy_id":"${POL}"}`],
  ["legacy_audit", `{"policy_id":"${POL}"}`],
  ["question", `{"question_id":"${POL}"}`],
  ["audit", `{"source_url":"https://x"}`],
  ["policy_missing", `{}`],
  ["other", `{"politician_id":"${P1}"}`],
];

async function baseDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date, election_reason text);
    INSERT INTO elections VALUES (2022, '2022-11-26', 'regular'), (2024, '2024-01-13', 'regular'), (2026, '2026-11-28', 'regular');
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-11-11' $$;
    ${await latestFn("uuid_or_null")}
    ${await latestFn("election_id_or_null")}
    ${await latestFn("campaign_election_id")}
    ${await latestFn("task_rekey_arms")}
    CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text, target jsonb, status text NOT NULL DEFAULT 'open');
    CREATE TABLE contributions (id uuid PRIMARY KEY, task_id text, payload jsonb);
    ${fnText(OLD_WK, "task_work_key_fp_arms")}
  `);
  return db;
}

Deno.test("A2 task_work_key：uuid 分支改呼叫 task_work_key_for_manual 後，對舊定義逐案輸出不變（含找不到的 uuid、auto:、verify:）", async () => {
  const db = await baseDb();
  await db.exec(fnText(OLD_WK, "task_work_key").replace("FUNCTION task_work_key(", "FUNCTION task_work_key_old("));
  // 舊定義的 verify 分支遞迴呼叫 task_work_key；先放一份舊定義當「task_work_key」跑舊值，再換新定義跑新值
  await db.exec(fnText(OLD_WK, "task_work_key"));
  const rows: Array<[string, string, string]> = SAMPLES.map(([ty, tg], i) => [T(i + 1), ty, tg]);
  for (const [id, ty, tg] of rows) await db.exec(`INSERT INTO contribution_tasks (id, task_type, target) VALUES ('${id}', '${ty}', '${tg}')`);
  await db.exec(`INSERT INTO contributions VALUES ('${T(9)}', '${T(1)}', '{}')`);
  const ids = [...rows.map((r) => r[0]), T(8), `auto:policy_missing:${P1}`, `auto:term_policy_missing:${P1}:2024`, `auto:profile_gap:sources:${P2}`,
    `auto:lineage_candidate:x:0123456789abcdef`, `verify:${T(9)}`, "verify:zzz", "plain", `auto:progress_stale:${POL}`];
  const run = async () => (await db.query<{ id: string; k: string | null }>(
    `SELECT i AS id, task_work_key(i, NULL) AS k FROM unnest(ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::text[]) AS i`)).rows.map((r) => r.k);
  const before = await run();
  await db.exec(fnText(MIG, "task_work_key_for_manual"));
  await db.exec(fnText(MIG, "task_work_key"));
  const after = await run();
  assertEquals(after, before);
  assert(before.some((k) => k === KEY_P1), "樣本有涵蓋 policy_missing 的卡鍵");
  assert(before.some((k) => k?.startsWith("task:")), "樣本有涵蓋 task:<uuid>");
  await db.close();
});

// ============================================================
// B. PGlite：resolve／attach／view sync
// ============================================================
const cols = /ALTER TABLE queue_settings[\s\S]*?;\n/.exec(DEMAND)![0];
const tables = /CREATE TABLE IF NOT EXISTS work_card_signals[\s\S]*?\n\);\nCREATE INDEX[^\n]*\n/.exec(DEMAND)![0];

async function env(mig = MIG): Promise<PGlite> {
  const db = await baseDb();
  await db.exec(`
    CREATE TABLE queue_settings (id smallint PRIMARY KEY, visitor_front_seconds bigint NOT NULL DEFAULT 315360000);
    INSERT INTO queue_settings (id) VALUES (1);
    ${cols}
    ${tables}
    ${fnText(DEMAND, "work_card_signal_add")}
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, target jsonb, work_key text, boost_seconds bigint NOT NULL DEFAULT 0, cool_until timestamptz, blocked boolean NOT NULL DEFAULT false);
    CREATE TABLE _ladder (work_key text PRIMARY KEY, closed boolean NOT NULL DEFAULT false, check_cool_until timestamptz, last_checked_at timestamptz);
    CREATE FUNCTION work_key_ladder_state(p_work_key TEXT)
    RETURNS TABLE (checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
    LANGUAGE sql STABLE AS $f$
      SELECT 0::bigint, COALESCE((SELECT l.closed FROM _ladder l WHERE l.work_key = p_work_key), false), NULL::timestamptz,
             (SELECT l.last_checked_at FROM _ladder l WHERE l.work_key = p_work_key), NULL::timestamptz, (SELECT l.check_cool_until FROM _ladder l WHERE l.work_key = p_work_key)
    $f$;
    ${/CREATE TABLE IF NOT EXISTS work_card_notes[\s\S]*?\n\);\n/.exec(MIG)![0]}
    CREATE TABLE _cooling (task_id text PRIMARY KEY);
    CREATE FUNCTION task_in_check_cooldown(p_task_id text) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT EXISTS (SELECT 1 FROM _cooling WHERE task_id = p_task_id) $f$;
    CREATE TABLE page_traffic_hot (kind text, target_id text, users integer);
    CREATE TABLE page_traffic_boosts (kind text, target_id text, paused_until timestamptz);
    ${fnText(OLD_WK, "task_work_key")}
    ${fnText(mig, "task_work_key_for_manual")}
    ${fnText(mig, "task_work_key")}
    ${fnText(mig, "work_card_resolve")}
    ${fnText(mig, "work_card_attach")}
    ${fnText(mig, "work_card_view_signals_sync")}
  `);
  return db;
}
const q = async <T>(db: PGlite, sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
const one = async (db: PGlite, sql: string): Promise<unknown> => (await q<{ v: unknown }>(db, `SELECT (${sql}) AS v`))[0]!.v;
const gap = (db: PGlite, id: string) => db.exec(`INSERT INTO task_dispatches (task_id, target, work_key) VALUES ('${id}', '{}', task_work_key('${id}', NULL))`);

Deno.test("B1 resolve：自動缺口與手動任務（policy_missing／term_policy_missing 同人同屆同卡）；自動缺口優先；沒有卡回 NULL", async () => {
  const db = await env();
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), null, "沒有任何任務");
  // 還沒入列的 open 手動任務（seed 約 10 分鐘一輪）：靠 contribution_tasks 找
  await db.exec(`INSERT INTO contribution_tasks VALUES ('${T(1)}', 'policy_missing', '{"politician_id":"${P1}"}', 'open')`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), T(1));
  // 關閉的手動任務不算
  await db.exec(`UPDATE contribution_tasks SET status = 'closed'`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), null);
  // 自動缺口（term_policy_missing，同屆同鍵）：已在隊的優先
  await db.exec(`UPDATE contribution_tasks SET status = 'open'`);
  await gap(db, `auto:term_policy_missing:${P1}:2026`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), `auto:term_policy_missing:${P1}:2026`);
  // 別屆、別人、驗證票不是這張卡
  assertEquals(await one(db, `work_card_resolve('politician:${P1}:policies:2024')`), null);
  assertEquals(await one(db, `work_card_resolve('politician:${P2}:policies:2026')`), null);
  await db.exec(`INSERT INTO task_dispatches (task_id, target, work_key) VALUES ('verify:${T(5)}', '{}', '${KEY_P1}')`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), `auto:term_policy_missing:${P1}:2026`);
  assertEquals(await one(db, `work_card_resolve(NULL)`), null);
  await db.close();
});

Deno.test("B2 resolve：不是卡的形狀（question／audit／other）算不出鍵；scope 例外（tenure 不併到自動缺口）", async () => {
  const db = await env();
  for (const [ty, tg] of SAMPLES.filter(([t]) => ["question", "audit", "other"].includes(t))) {
    assertEquals(await one(db, `task_work_key_for_manual('${ty}', '${tg}'::jsonb)`), null, ty);
  }
  await gap(db, `auto:policy_missing:${P1}`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}', NULL)`), `auto:policy_missing:${P1}`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}', 'pledge')`), `auto:policy_missing:${P1}`, "自動缺口視同 pledge");
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}', 'tenure')`), null, "tenure 請求不併到自動缺口，照舊新開");
  await db.exec(`INSERT INTO contribution_tasks VALUES ('${T(2)}', 'policy_missing', '{"politician_id":"${P1}","scope":"tenure"}', 'open')`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}', 'tenure')`), T(2), "只併到 scope 相同的手動任務");
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}', 'pledge')`), `auto:policy_missing:${P1}`);
  await db.close();
});

Deno.test("B3 attach：有卡寫訊號且冪等；無卡／task: 鍵 attached:false；kind NULL 只查不寫；訊號與①的 work_card_signals 同一張", async () => {
  const db = await env();
  const none = (await one(db, `work_card_attach('${KEY_P1}', 'request', 'ip1')`)) as Record<string, unknown>;
  assertEquals(none.attached, false);
  assertEquals(await one(db, `(SELECT count(*) FROM work_card_signals)`), 0, "無卡不寫訊號");
  assertEquals(((await one(db, `work_card_attach('task:abc', 'request', 'ip1')`)) as Record<string, unknown>).attached, false);
  await gap(db, `auto:policy_missing:${P1}`);
  const r1 = (await one(db, `work_card_attach('${KEY_P1}', 'request', 'ip1')`)) as Record<string, unknown>;
  assertEquals([r1.attached, r1.task_id, r1.work_key, r1.signal_added], [true, `auto:policy_missing:${P1}`, KEY_P1, true]);
  const r2 = (await one(db, `work_card_attach('${KEY_P1}', 'request', 'ip1')`)) as Record<string, unknown>;
  assertEquals([r2.attached, r2.signal_added], [true, false], "同一人重複按：仍回已併卡，但訊號不重複");
  await one(db, `work_card_attach('${KEY_P1}', 'suggest', 'agentA')`);
  assertEquals(await one(db, `(SELECT count(*) FROM work_card_signals WHERE work_key = '${KEY_P1}')`), 2);
  const m = (await one(db, `work_card_attach('${KEY_P1}', NULL, '')`)) as Record<string, unknown>;
  assertEquals([m.attached, m.signal_added], [true, false], "維護者指定：回報命中、不寫訊號");
  assertEquals(await one(db, `(SELECT count(*) FROM work_card_signals)`), 2);
  await db.close();
});

Deno.test("B4 attach 插隊：只在新增訊號時插一次（GREATEST 不疊加）、查核冷卻中不插、驗證票不動", async () => {
  const db = await env();
  await gap(db, `auto:policy_missing:${P1}`);
  await db.exec(`INSERT INTO task_dispatches (task_id, target, work_key) VALUES ('verify:${T(5)}', '{}', '${KEY_P1}')`);
  await one(db, `work_card_attach('${KEY_P1}', 'request', 'ip1', true)`);
  assertEquals(String(await one(db, `(SELECT boost_seconds FROM task_dispatches WHERE task_id = 'auto:policy_missing:${P1}')`)), "315360000");
  assertEquals(String(await one(db, `(SELECT boost_seconds FROM task_dispatches WHERE task_id LIKE 'verify:%')`)), "0");
  await db.exec(`UPDATE task_dispatches SET boost_seconds = 0`);
  await one(db, `work_card_attach('${KEY_P1}', 'request', 'ip1', true)`);
  assertEquals(String(await one(db, `(SELECT boost_seconds FROM task_dispatches WHERE task_id = 'auto:policy_missing:${P1}')`)), "0", "同一人重複按：訊號沒新增，不再插隊");
  await db.exec(`INSERT INTO _cooling VALUES ('auto:policy_missing:${P1}')`);
  await one(db, `work_card_attach('${KEY_P1}', 'request', 'ip2', true)`);
  assertEquals(String(await one(db, `(SELECT boost_seconds FROM task_dispatches WHERE task_id = 'auto:policy_missing:${P1}')`)), "0", "查核冷卻中不插");
  await db.close();
});

Deno.test("B5 view 訊號：只算達標頁名下現有的卡；人數封頂；冪等；被流量提層暫停的頁不寫", async () => {
  const db = await env();
  await gap(db, `auto:policy_missing:${P1}`);
  await db.exec(`INSERT INTO task_dispatches (task_id, target, work_key) VALUES ('x1', '{}', '${KEY_P1}'), ('auto:progress_stale:${POL}', '{}', 'policy:${POL}:progress_stale')`);
  await db.exec(`INSERT INTO page_traffic_hot VALUES ('politician', '${P1}', 12), ('policy', '${POL}', 3), ('politician', '${P2}', 50)`);
  const n = Number(await one(db, `work_card_view_signals_sync()`));
  assert(n > 0);
  assertEquals(Number(await one(db, `(SELECT count(*) FROM work_card_signals WHERE work_key = '${KEY_P1}' AND kind = 'view')`)), 12, "人數＝訊號數");
  assertEquals(Number(await one(db, `(SELECT count(*) FROM work_card_signals WHERE work_key LIKE 'policy:%')`)), 3);
  assertEquals(Number(await one(db, `(SELECT count(*) FROM work_card_signals WHERE work_key LIKE 'politician:${P2}%')`)), 0, "這個人名下沒有卡");
  assertEquals(Number(await one(db, `work_card_view_signals_sync()`)), 0, "冪等：第二輪不新增");
  // 封頂：每單位 5 人 × (14 天 ÷ 2 天 ＋ 1) ＝ 40
  await db.exec(`UPDATE page_traffic_hot SET users = 9999 WHERE target_id = '${P1}'`);
  await one(db, `work_card_view_signals_sync()`);
  assertEquals(Number(await one(db, `(SELECT count(*) FROM work_card_signals WHERE work_key = '${KEY_P1}')`)), 40);
  // 暫停
  await db.exec(`DELETE FROM work_card_signals; INSERT INTO page_traffic_boosts VALUES ('politician', '${P1}', now() + interval '3 days')`);
  await one(db, `work_card_view_signals_sync()`);
  assertEquals(Number(await one(db, `(SELECT count(*) FROM work_card_signals WHERE work_key = '${KEY_P1}')`)), 0);
  await db.close();
});

Deno.test("B6 resolve 只併到還會被派的卡：blocked 的列、階梯已結案的卡、blocked 的手動任務都不併", async () => {
  const db = await env();
  await gap(db, `auto:policy_missing:${P1}`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), `auto:policy_missing:${P1}`);
  await db.exec(`UPDATE task_dispatches SET blocked = true`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), null, "blocked 的缺口列不併");
  await db.exec(`UPDATE task_dispatches SET blocked = false; INSERT INTO _ladder (work_key, closed) VALUES ('${KEY_P1}', true)`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), null, "階梯已結案（查無第 4 次）的卡不併");
  await db.exec(`DELETE FROM _ladder; DELETE FROM task_dispatches; INSERT INTO contribution_tasks VALUES ('${T(3)}', 'policy_missing', '{"politician_id":"${P1}"}', 'open')`);
  await db.exec(`INSERT INTO task_dispatches (task_id, target, work_key, blocked) VALUES ('${T(3)}', '{}', '${KEY_P1}', true)`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), null, "blocked 的手動任務不併");
  await db.exec(`UPDATE contribution_tasks SET status = 'closed'`);
  assertEquals(await one(db, `work_card_resolve('${KEY_P1}')`), null, "已結案的手動任務不併");
  await db.close();
});

Deno.test("B7 attach 命中冷卻中的卡：訊號照寫、不插隊、回 cooling＋last_checked_at；冷卻結束後不再回 cooling；備註存進 work_card_notes（不算需求）", async () => {
  const db = await env();
  await gap(db, `auto:policy_missing:${P1}`);
  await db.exec(`INSERT INTO _ladder VALUES ('${KEY_P1}', false, now() + interval '5 days', now() - interval '2 days')`);
  const r = (await one(db, `work_card_attach('${KEY_P1}', 'request', 'ip1', true)`)) as Record<string, unknown>;
  assertEquals([r.attached, r.cooling, r.signal_added, r.boosted], [true, true, true, 0]);
  assert(typeof r.last_checked_at === "string");
  assertEquals(Number(await one(db, `(SELECT count(*) FROM work_card_signals WHERE work_key = '${KEY_P1}')`)), 1, "冷卻中仍寫訊號（冷卻結束後 ① 的需求疊加會把它帶回前面）");
  assertEquals(String(await one(db, `(SELECT boost_seconds FROM task_dispatches LIMIT 1)`)), "0");
  await db.exec(`UPDATE _ladder SET check_cool_until = now() - interval '1 day'`);
  assertEquals(((await one(db, `work_card_attach('${KEY_P1}', 'request', 'ip2', false)`)) as Record<string, unknown>).cooling, false);
  const n = (await one(db, `work_card_attach('${KEY_P1}', NULL, 'boss', false, NULL, '補某人政見：請查 X 網站', 'manual')`)) as Record<string, unknown>;
  assertEquals(n.attached, true);
  assertEquals(await one(db, `(SELECT note FROM work_card_notes WHERE work_key = '${KEY_P1}')`), "補某人政見：請查 X 網站");
  assertEquals(Number(await one(db, `(SELECT count(*) FROM work_card_signals)`)), 2, "備註不算需求訊號");
  await db.close();
});

// ============================================================
// C. TS：createOrAttachTask、入口
// ============================================================
interface Fake { supabase: unknown; inserted: unknown[]; rpcs: Array<{ name: string; args: Record<string, unknown> }> }
function fake(opts: { key?: string | null; taskId?: string | null; fail?: boolean } = {}): Fake {
  const inserted: unknown[] = [];
  const rpcs: Fake["rpcs"] = [];
  const supabase = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      if (opts.fail) return Promise.resolve({ data: null, error: { message: "boom" } });
      if (name === "task_work_key_for_manual") return Promise.resolve({ data: opts.key ?? null, error: null });
      if (name === "work_card_resolve") return Promise.resolve({ data: opts.taskId ?? null, error: null });
      if (name === "work_card_attach") return Promise.resolve({ data: opts.taskId ? { attached: true, task_id: opts.taskId, work_key: opts.key, signal_added: true } : { attached: false }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: () => ({ insert: (row: unknown) => { inserted.push(row); return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "new-task", ...(row as object) }, error: null }) }) }; } }),
  };
  return { supabase, inserted, rpcs };
}
const input = { title: "t", task_type: "policy_missing", target_politician_id: P1 };

Deno.test("C1 有卡：不新開任務，回 attached＋task_id＋work_key，寫一次訊號（kind 依來源）", async () => {
  const f = fake({ key: KEY_P1, taskId: "auto:policy_missing:x" });
  const r = await createOrAttachTask(f.supabase, input, { source: "web_request", requester_ip_hash: "iph", boost: true });
  assertEquals(r.attached, true);
  if (r.attached) assertEquals([r.task_id, r.work_key], ["auto:policy_missing:x", KEY_P1]);
  assertEquals(f.inserted.length, 0);
  const a = f.rpcs.find((x) => x.name === "work_card_attach")!.args;
  assertEquals([a.p_kind, a.p_actor, a.p_boost], ["request", "iph", true]);
  const f2 = fake({ key: KEY_P1, taskId: "auto:x" });
  await createOrAttachTask(f2.supabase, input, { source: "suggested", suggested_by: "agentA" });
  const a2 = f2.rpcs.find((x) => x.name === "work_card_attach")!.args;
  assertEquals([a2.p_kind, a2.p_actor], ["suggest", "agentA"]);
  const f3 = fake({ key: KEY_P1, taskId: "auto:x" });
  await createOrAttachTask(f3.supabase, input, { source: "manual", created_by: "boss" });
  assertEquals(f3.rpcs.find((x) => x.name === "work_card_attach")!.args.p_kind, null, "維護者指定：不算需求");
});

Deno.test("C2 無卡新開（並回 work_key）；卡存在但任務型別不是卡（鍵為 null）照開；force_new 不查直接開", async () => {
  const f = fake({ key: KEY_P1, taskId: null });
  const r = await createOrAttachTask(f.supabase, input, { source: "web_request" });
  assertEquals([r.attached, f.inserted.length], [false, 1]);
  if (!r.attached) assertEquals(r.work_key, KEY_P1);
  const f2 = fake({ key: null });
  assertEquals((await createOrAttachTask(f2.supabase, { title: "q", task_type: "question" }, { source: "suggested" })).attached, false);
  assertEquals(f2.inserted.length, 1);
  const f3 = fake({ key: KEY_P1, taskId: "auto:x" });
  const r3 = await createOrAttachTask(f3.supabase, input, { source: "manual", force_new: true });
  assertEquals([r3.attached, f3.inserted.length, f3.rpcs.length], [false, 1, 0], "force_new 連查都不查");
});

Deno.test("C3 保險絲 WORK_CARD_ATTACH=off 與資料庫失敗：退回舊的 createTask", async () => {
  Deno.env.set("WORK_CARD_ATTACH", "off");
  try {
    const f = fake({ key: KEY_P1, taskId: "auto:x" });
    assertEquals((await createOrAttachTask(f.supabase, input, { source: "web_request" })).attached, false);
    assertEquals([f.inserted.length, f.rpcs.length], [1, 0]);
    assertEquals(await workCardOf(f.supabase, input), null);
  } finally { Deno.env.delete("WORK_CARD_ATTACH"); }
  const f2 = fake({ fail: true });
  const r = await createOrAttachTask(f2.supabase, input, { source: "web_request" });
  assertEquals([r.attached, f2.inserted.length], [false, 1], "rpc 失敗不擋請求");
});

Deno.test("C4 decideRequest：工作卡在 open 任務、自動缺口都沒中時才看；新 reason work_card；舊順序不變", () => {
  assertEquals(decideRequest({ usedToday: 0, existingOpenTask: null, autoGapTaskId: null, workCardTaskId: "c1" }), { action: "already_queued", task_id: "c1", reason: "work_card" });
  assertEquals(decideRequest({ usedToday: 0, existingOpenTask: { id: "m" }, autoGapTaskId: null, workCardTaskId: "c1" }), { action: "already_queued", task_id: "m", reason: "open_task" });
  assertEquals(decideRequest({ usedToday: 0, existingOpenTask: null, autoGapTaskId: "g", workCardTaskId: "c1" }), { action: "already_queued", task_id: "g", reason: "auto_gap" });
  assertEquals(decideRequest({ usedToday: 99, existingOpenTask: null, autoGapTaskId: null, workCardTaskId: "c1" }), { action: "rate_limited" });
  assertEquals(decideRequest({ usedToday: 0, existingOpenTask: null, autoGapTaskId: null }), { action: "create" });
});

const env2 = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789", CONTRIBUTION_IP_SALT: "salt", AI_IMPORT_API_KEY: "k" } as Record<string, string>;
function router(opts: { taskId?: string | null }) {
  return (c: RestCall): unknown => {
    if (c.target === "rpc/task_work_key_for_manual") return KEY_P1;
    if (c.target === "rpc/work_card_resolve") return opts.taskId ?? null;
    if (c.target === "rpc/work_card_attach") return opts.taskId ? { attached: true, task_id: opts.taskId, work_key: KEY_P1, signal_added: true } : { attached: false };
    if (c.target === "politicians") return [{ id: P1, name: "某人", region: "新北市" }];
    if (c.target === "contribution_tasks" && c.method === "POST") return [{ id: "new-id" }];
    return undefined;
  };
}
async function post(path: string, body: unknown, r: (c: RestCall) => unknown, extraEnv: Record<string, string> = {}) {
  const entry = await loadEntry(path, { ...env2, ...extraEnv }, r);
  try {
    const res = await entry.call(new Request("https://x/f", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify(body) }));
    return { status: res.status, json: JSON.parse(await res.text()) as Record<string, unknown>, calls: entry.calls };
  } finally { entry.restore(); }
}

Deno.test("C5 request-task：卡（含 term_policy_missing 這種 endsWith 比不到的）已在隊 → already_queued＋attached＋work_key、寫訊號、不建 contribution_tasks；全量撈缺口的呼叫已拿掉", async () => {
  const r = await post("../../request-task/index.ts", { kind: "policy", politician_id: P1 }, router({ taskId: `auto:term_policy_missing:${P1}:2026` }));
  assertEquals(r.status, 200);
  assertEquals([r.json.status, r.json.reason, r.json.attached, r.json.work_key, r.json.task_id], ["already_queued", "work_card", true, KEY_P1, `auto:term_policy_missing:${P1}:2026`]);
  assert(!r.calls.some((c) => c.target === "contribution_tasks" && c.method === "POST"), "不新開任務");
  assert(!r.calls.some((c) => c.target === "rpc/contribution_auto_tasks"), "不再全量撈自動缺口");
  const att = r.calls.find((c) => c.target === "rpc/work_card_attach")!.body as Record<string, unknown>;
  assertEquals([att.p_kind, att.p_work_key, att.p_boost], ["request", KEY_P1, true]);
  assert(typeof att.p_actor === "string" && att.p_actor !== "" && !String(att.p_actor).includes("203.0.113"), "actor 是 IP 雜湊、不是原始 IP");
});

Deno.test("C6 request-task：沒有卡 → 照舊新開（201 queued）", async () => {
  const r = await post("../../request-task/index.ts", { kind: "policy", politician_id: P1 }, router({ taskId: null }));
  assertEquals([r.status, r.json.status], [201, "queued"]);
  assert(r.calls.some((c) => c.target === "contribution_tasks" && c.method === "POST"));
});

Deno.test("C7 apply create_task：預設併卡（回 attached:true、不開）；force_new:true 照開", async () => {
  const task = { title: "補某人政見", task_type: "policy_missing", target_politician_id: P1 };
  const a = await post("../../apply/index.ts", { api_key: "k", action: "create_task", task }, router({ taskId: "auto:x" }));
  assertEquals([a.status, a.json.attached, a.json.task_id], [200, true, "auto:x"]);
  assert(!a.calls.some((c) => c.target === "contribution_tasks" && c.method === "POST"));
  const b = await post("../../apply/index.ts", { api_key: "k", action: "create_task", task, force_new: true }, router({ taskId: "auto:x" }));
  assertEquals(b.status, 201);
  assert(b.calls.some((c) => c.target === "contribution_tasks" && c.method === "POST"));
});

Deno.test("C8 接線：提議通過／Jev 追問走 createOrAttachTask；#912 的事後併入（web_request_gap_boost、coverage）留著；console-fetch 流量後寫頁面訊號", async () => {
  const rd = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
  assert((await rd("./apply-contribution.ts")).includes("createOrAttachTask(supabase, validated.input"));
  const so = await rd("../system-one/index.ts");
  assertEquals((so.match(/createOrAttachTask\(/g) ?? []).length, 3);
  assert(so.includes("createTask(supabase, newsTaskOf"), "新聞任務不併");
  assert(!(await rd("../request-task/index.ts")).includes("endsWith"), "endsWith 比對已移除");
  const d912 = await readMig("20261111010000_web_request_gap_cover.sql").catch(() => "");
  if (d912) assert(d912.includes("web_request_gap_boost"));
  assert((await rd("../console-fetch/index.ts")).includes("work_card_view_signals_sync"));
  assert((await rd("./page-traffic.ts")).includes("syncViewSignals"));
});

Deno.test("C9 request-task：併卡的請求也計入每日 20 次（數 request 訊號）", async () => {
  const base = router({ taskId: "auto:x" });
  const r = await post("../../request-task/index.ts", { kind: "policy", politician_id: P1 }, (c) => {
    if (c.target === "work_card_signals") return { __count: 20 };
    return base(c);
  });
  assertEquals([r.status, r.json.error], [429, "rate_limited"]);
  assert(!r.calls.some((c) => c.target === "rpc/work_card_attach"), "超額不寫訊號");
  const sig = r.calls.find((c) => c.target === "work_card_signals")!;
  assert(sig.url.search.includes("kind=eq.request") && sig.url.search.includes("actor=eq."), "只數這個來源的 request 訊號");
});

Deno.test("C10 request-task：併到冷卻中的卡 → 仍寫訊號、回 recently_checked；寫訊號失敗 → 不宣稱 attached:true", async () => {
  const cool = (c: RestCall): unknown => c.target === "rpc/work_card_attach"
    ? { attached: true, task_id: "auto:x", work_key: KEY_P1, signal_added: true, cooling: true, last_checked_at: "2026-11-10T00:00:00Z" } : router({ taskId: "auto:x" })(c);
  const r = await post("../../request-task/index.ts", { kind: "policy", politician_id: P1 }, cool);
  assertEquals([r.status, r.json.status, r.json.checked_at], [200, "recently_checked", "2026-11-10T00:00:00Z"]);
  assert(r.calls.some((c) => c.target === "rpc/work_card_attach"));
  const f = await post("../../request-task/index.ts", { kind: "policy", politician_id: P1 }, (c) => c.target === "rpc/work_card_attach" ? null : router({ taskId: "auto:x" })(c));
  assertEquals(f.json.status, "already_queued");
  assertEquals(f.json.attached, false);
});

Deno.test("C11 保險絲 off：request-task 退回舊行為（撈自動缺口、對上就 already_queued auto_gap），不用 work_card 的 rpc；無缺口照舊新開", async () => {
  {
    const OFF = { WORK_CARD_ATTACH: "off" };
    const gaps = [{ task_id: `auto:term_policy_missing:${P1}:2026` }];
    const r = await post("../../request-task/index.ts", { kind: "policy", politician_id: P1 }, (c) => c.target === "rpc/contribution_auto_tasks" ? gaps : router({ taskId: null })(c), OFF);
    assertEquals([r.json.status, r.json.reason], ["already_queued", "auto_gap"]);
    assert(!r.calls.some((c) => c.target.startsWith("rpc/work_card") || c.target === "rpc/task_work_key_for_manual" || c.target === "work_card_signals"));
    const r2 = await post("../../request-task/index.ts", { kind: "policy", politician_id: P1 }, (c) => c.target === "rpc/contribution_auto_tasks" ? [] : router({ taskId: null })(c), OFF);
    assertEquals(r2.status, 201);
  }
});

Deno.test("C12 維護者指定併卡：說明與來源存成備註（不寫需求訊號）；系統掃描（no_signal）不寫需求訊號", async () => {
  const f = fake({ key: KEY_P1, taskId: "auto:x" });
  await createOrAttachTask(f.supabase, { ...input, title: "補某人政見", description: "請查官網", source_url: "https://x.example" }, { source: "manual", created_by: "boss" });
  const a = f.rpcs.find((x) => x.name === "work_card_attach")!.args;
  assertEquals([a.p_kind, a.p_source], [null, "manual"]);
  assertEquals(a.p_note, "補某人政見｜請查官網｜https://x.example");
  const f2 = fake({ key: KEY_P1, taskId: "auto:x" });
  const r2 = await createOrAttachTask(f2.supabase, input, { source: "suggested", suggested_by: "jev-bio", no_signal: true });
  assertEquals(r2.attached, true);
  assertEquals(f2.rpcs.find((x) => x.name === "work_card_attach")!.args.p_kind, null);
  const so = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assertEquals((so.match(/no_signal: true/g) ?? []).length, 3, "system-one 三處都不寫需求訊號");
});

// ============================================================
// D. 還原驗證
// ============================================================
Deno.test("D 還原驗證：拿掉 resolve 的 work_key 比對、scope 條件、attach 的新增判斷，對應情境翻面", async () => {
  // 拿掉 work_key 比對 → 別人的卡也被併
  const noKey = mutate(MIG, "WHERE p_work_key IS NOT NULL AND d.work_key = p_work_key AND", "WHERE p_work_key IS NOT NULL AND");
  assertNotEquals(noKey, MIG);
  const db1 = await env(noKey);
  await gap(db1, `auto:policy_missing:${P1}`);
  assertEquals(await one(db1, `work_card_resolve('politician:${P2}:policies:2026')`), `auto:policy_missing:${P1}`, "拿掉比對 → 併錯卡（B1 會紅）");
  await db1.close();
  // 拿掉 scope 條件 → tenure 併到自動缺口
  const noScope = mutate(MIG, "WHEN c.task_id LIKE 'auto:%' THEN p_scope = 'pledge'", "WHEN c.task_id LIKE 'auto:%' THEN TRUE");
  const db2 = await env(noScope);
  await gap(db2, `auto:policy_missing:${P1}`);
  assertEquals(await one(db2, `work_card_resolve('${KEY_P1}', 'tenure')`), `auto:policy_missing:${P1}`, "拿掉 scope → B2 會紅");
  await db2.close();
  // attach 不看新增與否就插隊 → 重複按會重複插隊
  const noAdded = mutate(MIG, "IF p_boost AND v_added THEN", "IF p_boost THEN");
  const db3 = await env(noAdded);
  await gap(db3, `auto:policy_missing:${P1}`);
  await one(db3, `work_card_attach('${KEY_P1}', 'request', 'ip1', true)`);
  await db3.exec(`UPDATE task_dispatches SET boost_seconds = 0`);
  await one(db3, `work_card_attach('${KEY_P1}', 'request', 'ip1', true)`);
  assertNotEquals(String(await one(db3, `(SELECT boost_seconds FROM task_dispatches LIMIT 1)`)), "0", "拿掉新增判斷 → B4 會紅");
  await db3.close();
});
