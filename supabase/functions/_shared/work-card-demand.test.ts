/**
 * 工作卡①：需求疊加成卡優先級，暗上線（migration 20261112070000_work_card_demand.sql＋20261112070100_work_card_demand_seed.sql，docs/PLAN-workcard-123.md）。
 *
 *   需求秒數 ＝ min(上限 14 天, 單位數 × 2 天) × 0.5^沒產出派出次數；冷卻中／階梯結案／減半到上限 ＝ 0
 *   seed：規則秒數 → 流量提層 GREATEST → ＋需求（旗標 demand_enabled，預設關）→ ＋選舉年
 *
 *   A. 文字層：seed ＝ 上一版逐字 ＋ 一個標記區塊、位置在流量之後選舉年之前；新函式不給 anon／authenticated；不碰 TS／協議／日本站
 *   B. PGlite：公式、上限、減半、冷卻、同人同卡只算一次、30 天過期、旗標開關對 priority_seconds 的影響、觸發器記帳、視圖不含 actor
 *   C. 還原驗證：拿掉上限／減半／冷卻條件／旗標條件，對應情境要翻面
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261112070000_work_card_demand.sql";
const SEED_NAME = "20261112070100_work_card_demand_seed.sql";
const MIG = await readMig(MIG_NAME);
const SEED_MIG = await readMig(SEED_NAME);
const DAY = 86400;
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 seed：新定義 ＝ 上一版逐字 ＋ 一個標記區塊（>>> 需求疊加），拿掉區塊後與上一版完全相同；位置在流量提層之後、選舉年之前", async () => {
  const prev = await latestFn("seed_auto_task_queue", SEED_NAME);
  const neu = fnText(SEED_MIG, "seed_auto_task_queue");
  const stripped = neu.replace(/  -- >>> 需求疊加[^\n]*\n[\s\S]*?  -- <<< 需求疊加\n/, "");
  assertNotEquals(stripped, neu, "有標記區塊");
  assertEquals(stripped, prev);
  assert(prev.includes(">>> 選舉年優先（20261112005000）") && prev.includes(">>> 一人一包（20261112065000）"), "底是一人一包 PR2（含選舉年優先）那一版");
  assert(neu.indexOf("流量提層的缺口（opened_by.traffic_boost）至少給") < neu.indexOf(">>> 需求疊加"));
  assert(neu.indexOf("<<< 需求疊加") < neu.indexOf(">>> 選舉年優先"), "順序：流量取最大 → ＋需求 → ＋選舉年");
  assert(neu.includes("demand_enabled"), "旗標才生效");
});

Deno.test("A2 新函式與表：REVOKE PUBLIC／anon／authenticated、RLS 開、視圖不含 actor；不碰 TS、協議、日本站；不刪東西；禁 id::text =", () => {
  const c = code(MIG);
  for (const f of ["work_card_demand_seconds(TEXT)", "work_card_demand_refresh()", "work_card_signal_add(TEXT, TEXT, TEXT)",
    "work_card_mark_dispatched(TEXT)", "work_card_mark_output(TEXT)", "work_card_on_dispatch()", "work_card_on_output()"]) {
    assert(c.includes(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon, authenticated;`), `REVOKE ${f}`);
  }
  assert(c.includes("ALTER TABLE work_card_signals ENABLE ROW LEVEL SECURITY"));
  assert(c.includes("REVOKE ALL ON work_card_signals FROM PUBLIC, anon, authenticated"));
  assert(!/FOR SELECT[^;]*ON work_card_signals/.test(c) && !/ON work_card_signals FOR SELECT/.test(c), "訊號表沒有公開讀");
  const view = /CREATE OR REPLACE VIEW work_card_demand_preview AS[\s\S]*?;\n/.exec(c)![0];
  assert(!/\bactor\b/.test(view), "視圖不含 actor");
  assert(!/policy_jp\./.test(c + code(SEED_MIG)));
  assert(!/DROP\s+(FUNCTION|COLUMN|VIEW)\b/i.test(c) && !/DROP TABLE(?! IF EXISTS _)/i.test(c + code(SEED_MIG)));
  assert(!/id::text\s*=/i.test(c + code(SEED_MIG)));
  assert(c.includes("demand_enabled        BOOLEAN NOT NULL DEFAULT false"), "旗標預設關");
});

// ============================================================
// B. PGlite
// ============================================================
const SCHEMA = `
CREATE TABLE queue_settings (id smallint PRIMARY KEY);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, work_key text, dispatch_count integer NOT NULL DEFAULT 0, priority_seconds integer NOT NULL DEFAULT 0);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text NOT NULL DEFAULT 'pending');
-- 查核階梯的替身：一列＝這張卡「結案」或「冷卻到哪」（真的 work_key_ladder_state 由 work-key.test.ts 守）
CREATE TABLE _ladder (work_key text PRIMARY KEY, closed boolean NOT NULL DEFAULT false, check_cool_until timestamptz);
CREATE FUNCTION work_key_ladder_state(p_work_key TEXT)
RETURNS TABLE (checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
LANGUAGE sql STABLE AS $f$
  SELECT 0::bigint, COALESCE((SELECT l.closed FROM _ladder l WHERE l.work_key = p_work_key), false), NULL::timestamptz, NULL::timestamptz,
         NULL::timestamptz, (SELECT l.check_cool_until FROM _ladder l WHERE l.work_key = p_work_key)
$f$;
`;
const cols = /ALTER TABLE queue_settings[\s\S]*?;\n/.exec(MIG)![0];
const tables = /CREATE TABLE IF NOT EXISTS work_card_signals[\s\S]*?\n\);\nCREATE INDEX[^\n]*\n/.exec(MIG)![0] +
  /CREATE TABLE IF NOT EXISTS work_cards[\s\S]*?\n\);\n/.exec(MIG)![0];
const triggers = (/CREATE TRIGGER trg_work_card_dispatch[\s\S]*?;\n/.exec(MIG)![0]) + (/CREATE TRIGGER trg_work_card_output[\s\S]*?;\n/.exec(MIG)![0]);
const FNS = ["work_card_demand_seconds", "work_card_demand_refresh", "work_card_signal_add", "work_card_mark_dispatched", "work_card_mark_output", "work_card_on_dispatch", "work_card_on_output"];
const view = /CREATE OR REPLACE VIEW work_card_demand_preview AS[\s\S]*?;\n/.exec(MIG)![0];

async function env(mig = MIG): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(cols);
  await db.exec(tables);
  for (const f of FNS) await db.exec(fnText(mig, f));
  await db.exec(triggers);
  await db.exec(view);
  return db;
}
const num = async (db: PGlite, sql: string): Promise<number> => Number((await db.query<{ v: string }>(`SELECT (${sql})::text AS v`)).rows[0]!.v);
const demand = (db: PGlite, wk = "k1") => num(db, `work_card_demand_seconds('${wk}')`);
const sig = async (db: PGlite, wk: string, kind: string, actor: string) =>
  (await db.query<{ r: boolean }>(`SELECT work_card_signal_add('${wk}', '${kind}', '${actor}') AS r`)).rows[0]!.r;

Deno.test("B1 公式：3 個請求者＋1 個提議者＝4 單位 × 2 天；同人同卡同類只算一次；沒訊號為 0", async () => {
  const db = await env();
  assertEquals(await demand(db), 0);
  for (const a of ["ip1", "ip2", "ip3"]) assertEquals(await sig(db, "k1", "request", a), true);
  assertEquals(await sig(db, "k1", "suggest", "agentA"), true);
  assertEquals(await demand(db), 4 * 2 * DAY);
  assertEquals(await sig(db, "k1", "request", "ip1"), false, "冪等：重複呼叫回 false");
  assertEquals(await demand(db), 4 * 2 * DAY, "同一人再按不加");
  assertEquals(await sig(db, "k1", "suggest", "ip1"), true, "不同類別各算各的");
  assertEquals(await demand(db), 5 * 2 * DAY);
  assertEquals(await demand(db, "other"), 0, "別張卡不受影響");
  await db.close();
});

Deno.test("B2 上限 14 天：7 單位剛好、之後被截斷", async () => {
  const db = await env();
  for (let i = 0; i < 7; i++) await sig(db, "k1", "request", `ip${i}`);
  assertEquals(await demand(db), 14 * DAY);
  for (let i = 7; i < 12; i++) await sig(db, "k1", "request", `ip${i}`);
  assertEquals(await demand(db), 14 * DAY, "12 單位仍 14 天");
  await db.close();
});

Deno.test("B3 頁面項：view 訊號 floor(n ÷ 5) − 1 單位（第一個單位已由流量提層領走）", async () => {
  const db = await env();
  for (let i = 0; i < 5; i++) await sig(db, "k1", "view", `v${i}`);
  assertEquals(await demand(db), 0, "剛過門檻 5 人 → 0");
  for (let i = 5; i < 25; i++) await sig(db, "k1", "view", `v${i}`);
  assertEquals(await demand(db), 4 * 2 * DAY, "25 人 → floor(25/5)−1 ＝ 4 單位");
  await db.close();
});

Deno.test("B4 減半：派出沒產出一次 1/2、兩次 1/4，到上限 6 次視同 0；有產出回滿；no_change／task_suggestion 不算產出", async () => {
  const db = await env();
  for (const a of ["a", "b", "c", "d"]) await sig(db, "k1", "request", a); // 8 天
  await db.exec(`INSERT INTO task_dispatches (task_id, work_key, dispatch_count) VALUES ('auto:t1', 'k1', 0), ('verify:x', 'k1', 0)`);
  const bump = () => db.exec(`UPDATE task_dispatches SET dispatch_count = dispatch_count + 1 WHERE task_id = 'auto:t1'`);
  await bump();
  assertEquals(await demand(db), 4 * DAY);
  await bump();
  assertEquals(await demand(db), 2 * DAY);
  await db.exec(`UPDATE task_dispatches SET dispatch_count = dispatch_count + 1 WHERE task_id = 'verify:x'`);
  assertEquals(await demand(db), 2 * DAY, "驗證票被領走不算卡被派出");
  // no_change／task_suggestion 不算產出
  await db.exec(`INSERT INTO contributions (task_id, contribution_type) VALUES ('auto:t1', 'no_change'), ('auto:t1', 'task_suggestion')`);
  assertEquals(await demand(db), 2 * DAY);
  // 有產出回滿
  await db.exec(`INSERT INTO contributions (task_id, contribution_type) VALUES ('auto:t1', 'policy')`);
  assertEquals(await demand(db), 8 * DAY, "有產出需求回滿");
  assertEquals(await num(db, `(SELECT count(*) FROM work_cards WHERE work_key = 'k1' AND last_output_at IS NOT NULL)`), 1);
  // 派出 6 次沒產出 → 0
  for (let i = 0; i < 6; i++) await bump();
  assertEquals(await demand(db), 0, "減半到上限視同 0");
  // 不是 pending 的交件、沒母任務的交件不記帳
  await db.exec(`INSERT INTO contributions (task_id, contribution_type, status) VALUES ('auto:t1', 'policy', 'rejected')`);
  assertEquals(await demand(db), 0);
  await db.close();
});

Deno.test("B5 防線①：冷卻中與階梯結案回 0，冷卻結束後回來", async () => {
  const db = await env();
  for (const a of ["a", "b"]) await sig(db, "k1", "request", a);
  assertEquals(await demand(db), 4 * DAY);
  await db.exec(`INSERT INTO _ladder VALUES ('k1', false, now() + interval '3 days')`);
  assertEquals(await demand(db), 0, "冷卻中");
  await db.exec(`UPDATE _ladder SET check_cool_until = now() - interval '1 day'`);
  assertEquals(await demand(db), 4 * DAY, "冷卻結束");
  await db.exec(`UPDATE _ladder SET closed = true, check_cool_until = NULL`);
  assertEquals(await demand(db), 0, "階梯結案");
  await db.close();
});

Deno.test("B6 30 天過期不算；過期後同一人再按會續期（回 true）", async () => {
  const db = await env();
  await sig(db, "k1", "request", "old");
  await sig(db, "k1", "request", "new");
  await db.exec(`UPDATE work_card_signals SET created_at = now() - interval '31 days' WHERE actor = 'old'`);
  assertEquals(await demand(db), 1 * 2 * DAY, "只算沒過期的一個");
  assertEquals(await sig(db, "k1", "request", "new"), false);
  assertEquals(await sig(db, "k1", "request", "old"), true, "過期後再按＝續期");
  assertEquals(await demand(db), 2 * 2 * DAY);
  await db.exec(`UPDATE queue_settings SET demand_signal_days = 60`);
  await db.exec(`UPDATE work_card_signals SET created_at = now() - interval '45 days' WHERE actor = 'old'`);
  assertEquals(await demand(db), 2 * 2 * DAY, "設定值改了行為跟著變（60 天內仍有效）");
  await db.close();
});

Deno.test("B7 signal_add 輸入檢查：空值回 false、未知 kind 丟錯", async () => {
  const db = await env();
  assertEquals(await sig(db, "", "request", "a"), false);
  assertEquals(await sig(db, "k1", "request", ""), false);
  let threw = false;
  try { await sig(db, "k1", "bogus", "a"); } catch { threw = true; }
  assert(threw);
  await db.close();
});

Deno.test("B8 refresh：快照寫 work_cards.demand_seconds、沒變不重寫、訊號全過期後歸 0", async () => {
  const db = await env();
  for (const a of ["a", "b", "c"]) await sig(db, "k1", "request", a);
  assertEquals(await num(db, `work_card_demand_refresh()`), 1);
  assertEquals(await num(db, `(SELECT demand_seconds FROM work_cards WHERE work_key = 'k1')`), 3 * 2 * DAY);
  assertEquals(await num(db, `work_card_demand_refresh()`), 0, "沒變不寫（守 #465 的精神）");
  await db.exec(`UPDATE work_card_signals SET created_at = now() - interval '40 days'`);
  assertEquals(await num(db, `work_card_demand_refresh()`), 1);
  assertEquals(await num(db, `(SELECT demand_seconds FROM work_cards WHERE work_key = 'k1')`), 0);
  await db.close();
});

/** 把 seed 的標記區塊單獨拿出來跑在一張暫存 _gaps 上（區塊內容就是 seed 裡那一段，A1 守著它與 seed 的關係） */
const BLOCK = /  -- >>> 需求疊加[^\n]*\n[\s\S]*?  -- <<< 需求疊加\n/.exec(fnText(SEED_MIG, "seed_auto_task_queue"))![0];
async function runBlock(db: PGlite, block = BLOCK): Promise<Record<string, number>> {
  await db.exec(`DROP TABLE IF EXISTS _gaps; CREATE TEMP TABLE _gaps (task_id text, priority_seconds integer);
    INSERT INTO _gaps VALUES ('auto:t1', 100), ('auto:t2', 200), ('auto:t3', 300);`);
  await db.exec(`DO $$ BEGIN\n${block}\nEND $$;`);
  const r = await db.query<{ task_id: string; p: number }>(`SELECT task_id, priority_seconds AS p FROM _gaps ORDER BY 1`);
  return Object.fromEntries(r.rows.map((x) => [x.task_id, x.p]));
}
async function seedWorld(db: PGlite) {
  await db.exec(`INSERT INTO task_dispatches (task_id, work_key) VALUES ('auto:t1', 'k1'), ('auto:t2', 'k2'), ('auto:t3', NULL)`);
  for (const a of ["a", "b"]) { await sig(db, "k1", "request", a); await sig(db, "k2", "request", a); }
  await sig(db, "k2", "suggest", "z");
}

Deno.test("B9 旗標關（預設）：priority_seconds 與沒有需求時逐列相同，但 work_cards 快照照寫；開了才疊加；關回去立刻退回", async () => {
  const db = await env();
  await seedWorld(db);
  assertEquals(await num(db, `(SELECT demand_enabled::int FROM queue_settings)`), 0, "預設關");
  assertEquals(await runBlock(db), { "auto:t1": 100, "auto:t2": 200, "auto:t3": 300 });
  assertEquals(await num(db, `(SELECT demand_seconds FROM work_cards WHERE work_key = 'k2')`), 3 * 2 * DAY, "關著也記快照");
  await db.exec(`UPDATE queue_settings SET demand_enabled = true`);
  assertEquals(await runBlock(db), { "auto:t1": 100 + 4 * DAY, "auto:t2": 200 + 6 * DAY, "auto:t3": 300 });
  await db.exec(`UPDATE queue_settings SET demand_enabled = false`);
  assertEquals(await runBlock(db), { "auto:t1": 100, "auto:t2": 200, "auto:t3": 300 });
  await db.close();
});

Deno.test("B10 旗標開：冷卻中的卡不疊；參數改值（單位／上限）跟著變；INTEGER 範圍內（2800 年選舉年 ＋ 14 天上限）", async () => {
  const db = await env();
  await seedWorld(db);
  await db.exec(`UPDATE queue_settings SET demand_enabled = true`);
  await db.exec(`INSERT INTO _ladder VALUES ('k1', false, now() + interval '2 days')`);
  const r = await runBlock(db);
  assertEquals(r["auto:t1"], 100, "冷卻中的卡不疊");
  await db.exec(`UPDATE queue_settings SET demand_unit_seconds = 3600, demand_cap_seconds = 7200`);
  assertEquals((await runBlock(db))["auto:t2"], 200 + 3600 * 2, "上限 7200 秒");
  // 選舉年 2800 年（2800 天 ＝ 241,920,000 秒）＋ 14 天上限仍在 int4 內
  assert(2800 * DAY + 14 * DAY < 2 ** 31 - 1);
  await db.close();
});

Deno.test("B11 觸發器：seed 新增列（INSERT）不算派出；只有 dispatch_count 變大的非驗證列才記帳", async () => {
  const db = await env();
  await db.exec(`INSERT INTO task_dispatches (task_id, work_key, dispatch_count) VALUES ('auto:t1', 'k1', 3)`);
  assertEquals(await num(db, `(SELECT count(*) FROM work_cards)`), 0, "INSERT 帶著舊 dispatch_count（換號沿用）不算");
  await db.exec(`UPDATE task_dispatches SET priority_seconds = 5 WHERE task_id = 'auto:t1'`);
  assertEquals(await num(db, `(SELECT count(*) FROM work_cards)`), 0, "改別的欄不算");
  await db.exec(`UPDATE task_dispatches SET dispatch_count = 4 WHERE task_id = 'auto:t1'`);
  assertEquals(await num(db, `(SELECT no_output_dispatches FROM work_cards WHERE work_key = 'k1')`), 1);
  await db.exec(`INSERT INTO task_dispatches (task_id, work_key, dispatch_count) VALUES ('auto:nokey', NULL, 0)`);
  await db.exec(`UPDATE task_dispatches SET dispatch_count = 1 WHERE task_id = 'auto:nokey'`);
  assertEquals(await num(db, `(SELECT count(*) FROM work_cards)`), 1, "沒有 work_key 的列不記");
  await db.close();
});

Deno.test("B12 視圖 work_card_demand_preview：各類訊號數、需求秒數、現 priority_seconds、旗標；不含 actor；過期訊號不列", async () => {
  const db = await env();
  await seedWorld(db);
  await db.exec(`UPDATE task_dispatches SET priority_seconds = 777 WHERE task_id = 'auto:t2'`);
  const r = await db.query<Record<string, unknown>>(`SELECT * FROM work_card_demand_preview ORDER BY work_key`);
  assertEquals(r.fields.map((f) => f.name), ["work_key", "requests", "views", "suggests", "rosters", "demand_seconds", "priority_seconds", "demand_enabled"]);
  const m = Object.fromEntries(r.rows.map((x) => [x.work_key as string, x]));
  assertEquals([m.k1!.requests, m.k1!.demand_seconds, m.k1!.demand_enabled], [2, `${4 * DAY}`, false].map((v, i) => i === 1 ? Number(v) : v).map((v) => v) as unknown[]);
  assertEquals([Number(m.k2!.requests), Number(m.k2!.suggests), Number(m.k2!.demand_seconds), m.k2!.priority_seconds], [2, 1, 6 * DAY, 777]);
  await db.exec(`UPDATE work_card_signals SET created_at = now() - interval '40 days' WHERE work_key = 'k1'`);
  assertEquals((await db.query(`SELECT 1 FROM work_card_demand_preview WHERE work_key = 'k1'`)).rows.length, 0);
  await db.close();
});

// ============================================================
// C. 還原驗證
// ============================================================
Deno.test("C1 還原驗證：拿掉上限 → B2 翻面；拿掉減半 → B4 翻面；拿掉冷卻條件 → B5 翻面", async () => {
  // 拿掉上限
  const noCap = mutate(MIG, "LEAST(s.demand_cap_seconds::NUMERIC,\n                            (sig.direct + GREATEST(0, sig.views / s.demand_view_unit - 1)) * s.demand_unit_seconds::NUMERIC)",
    "((sig.direct + GREATEST(0, sig.views / s.demand_view_unit - 1)) * s.demand_unit_seconds::NUMERIC)");
  let db = await env(noCap);
  for (let i = 0; i < 12; i++) await sig(db, "k1", "request", `ip${i}`);
  assertNotEquals(await demand(db), 14 * DAY, "沒有上限會超過 14 天");
  await db.close();
  // 拿掉減半
  const noHalf = mutate(MIG, "* power(0.5::NUMERIC, card.n))::BIGINT", ")::BIGINT");
  db = await env(noHalf);
  await sig(db, "k1", "request", "a");
  await db.exec(`INSERT INTO task_dispatches (task_id, work_key) VALUES ('auto:t1', 'k1'); UPDATE task_dispatches SET dispatch_count = 1`);
  assertEquals(await demand(db), 2 * DAY, "沒有減半：派出一次仍是全額（正常版是 1 天）");
  await db.close();
  // 拿掉冷卻條件
  const noCool = mutate(MIG, "WHEN (SELECT st.closed OR COALESCE(st.check_cool_until > now(), FALSE) FROM st) THEN 0", "WHEN FALSE THEN 0");
  db = await env(noCool);
  await sig(db, "k1", "request", "a");
  await db.exec(`INSERT INTO _ladder VALUES ('k1', false, now() + interval '3 days')`);
  assertEquals(await demand(db), 2 * DAY, "沒有冷卻條件：冷卻中仍有需求（正常版是 0）");
  await db.close();
});

Deno.test("C2 還原驗證：seed 區塊拿掉旗標條件 → 旗標關時 priority_seconds 就變了（B9 翻面）", async () => {
  const db = await env();
  await seedWorld(db);
  const broken = mutate(BLOCK, "IF COALESCE((SELECT q.demand_enabled FROM queue_settings q WHERE q.id = 1), false) THEN", "IF true THEN");
  const r = await runBlock(db, broken);
  assertNotEquals(r["auto:t1"], 100, "沒有旗標條件，關著也會疊加");
  await db.close();
});

Deno.test("B13 refresh 失敗不拖垮 seed（旗標關著照常、只留 WARNING）；demand_cap_seconds 有 90 天上限的 CHECK", async () => {
  const db = await env();
  await seedWorld(db);
  await db.exec(`DROP FUNCTION work_card_demand_refresh()`);
  assertEquals(await runBlock(db), { "auto:t1": 100, "auto:t2": 200, "auto:t3": 300 }, "refresh 掛了，區塊仍跑完、priority_seconds 不變");
  assert(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'work_card_demand_refresh/.test(BLOCK));
  await db.exec(`UPDATE queue_settings SET demand_cap_seconds = 7776000`);
  let threw = false;
  try { await db.exec(`UPDATE queue_settings SET demand_cap_seconds = 7776001`); } catch { threw = true; }
  assert(threw, "超過 90 天被擋");
  await db.close();
});
