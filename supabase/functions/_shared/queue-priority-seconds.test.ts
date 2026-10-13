/**
 * 派工排序改成「優先級秒數」、取消驗證：任務＝2:1（migration 20261011320000_queue_priority_seconds.sql，2026-10-13 維護者）。
 *
 *   A. 文字層：改到的七支函式＝前一版加機械式替換（倒回去一字不差）；seed 不再呼叫 rebalance_queue；
 *      任務列不再寫 1970／1980（manual_front_at 不再被呼叫）；主控台與規則總表多 priority_seconds
 *   B. PGlite（seed-skip-env 的環境＋這支）：
 *      B1 前段／預設／後段的秒數與排序鍵；後段推到一天以後的先擋著
 *      B2 派出：回隊尾、插隊秒數歸零
 *      B3 冷卻：查核時間＋冷卻天數當下限；一天以內結束的放行；優先秒數不會讓冷卻提早結束；插隊蓋過冷卻
 *      B4 插隊：/boost 加 5 年、兩次加兩份，馬上排到最前；派出就歸零
 *      B5 驗證列：進隊時間 − 14 天；1970 年段不動
 *      B6 手動任務：網站請求第一次進佇列＝10 年、維護者建的＝5 年；固定時段拉回只在沒拉過、時段開始後沒派過時
 *      B7 既有列換算：1970／1980 年段的任務列換成插隊秒數、先後不變
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, type GapRow, migrationNames, readMig } from "./arms-pglite.ts";
import { buildSeedEnv } from "./seed-skip-env.ts";

const MIG_NAME = "20261011320000_queue_priority_seconds.sql";
const MIG = await readMig(MIG_NAME);
type Rep = [string, string, number];

// ============================================================
// A. 文字層
// ============================================================
const SEED_REPS: Rep[] = [
  [
    "  -- <<< 優先層\n\n  -- >>> 流量提層",
    `  -- <<< 優先層

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小，跟優先層「取最後面那層」同一個方向）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER;
  UPDATE _gaps g SET priority_seconds = p.seconds
    FROM (SELECT k.arm, k.eid, k.etype, x.seconds
            FROM (SELECT DISTINCT y.arm, election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL activity_priority_seconds(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先秒數

  -- >>> 流量提層`,
    1,
  ],
  [
    "  PERFORM traffic_boost_apply();\n  -- <<< 流量提層\n",
    `  PERFORM traffic_boost_apply();
  -- <<< 流量提層
  -- >>> 優先秒數：流量提層的缺口（opened_by.traffic_boost）至少給 traffic_boost_settings.boost_seconds
  UPDATE _gaps g SET priority_seconds = GREATEST(COALESCE(g.priority_seconds, 0), s.boost_seconds)
    FROM traffic_boost_settings s
   WHERE s.id = 1 AND s.enabled AND g.opened_by->>'traffic_boost' = 'true';
  -- <<< 優先秒數
`,
    1,
  ],
  [
    "    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority IS DISTINCT FROM g.priority;\n  -- <<< 優先層\n",
    `    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority IS DISTINCT FROM g.priority;
  -- <<< 優先層
  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數
`,
    1,
  ],
  ["region, refreshed_at, opened_at, opened_by, priority)\n", "region, refreshed_at, opened_at, opened_by, priority, priority_seconds, boost_seconds)\n", 1],
  [
    "  SELECT g.task_id, now(), COALESCE(CASE WHEN g.arm LIKE 'manual\\_%' THEN manual_front_at(g.task_id) END,\n                                    v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds'), 0,\n",
    "  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,\n",
    1,
  ],
  [
    "         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id)), g.priority\n",
    "         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds)), g.priority,\n" +
    "         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds；原本排到 1970／1980）\n" +
    "         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE 0 END\n" +
    "         -- <<< 優先秒數\n",
    1,
  ],
  ["  -- 每 10 分鐘重排成 驗證：任務＝2:1（維護者 09-24：不要手動調）\n", "", 1],
  [
    "  PERFORM rebalance_queue();\n",
    "  -- >>> 優先秒數（20261011320000）：不再重排（驗證：任務＝2:1 取消，維護者 10-13「什麼時候進隊伍就處理」）；\n" +
    "  --     queue_at 由觸發器 task_dispatches_queue_key 照排序鍵算，上面改到優先秒數、冷卻、插隊秒數的列已經跟著換了位置\n" +
    "  -- <<< 優先秒數\n",
    1,
  ],
];

/** 每支函式的新定義＝前一版加「標了 >>> 優先秒數 的區塊」與幾處一行替換；這裡只核對：拿掉區塊後，其餘的行都在前一版裡、而且前一版被拿掉的行都說得出理由 */
const BLOCK = /[ \t]*-- >>> 優先秒數[^\n]*\n[\s\S]*?[ \t]*-- <<< 優先秒數\n/g;

/** 新定義倒推回前一版：每一組替換倒過來做，次數要對 */
function undo(fn: string, reps: Rep[]): string {
  let s = fn;
  for (const [from, to, n] of [...reps].reverse()) {
    if (to === "") continue;
    assertEquals(s.split(to).length - 1, n, `「${to.slice(0, 40)}」應出現 ${n} 次`);
    s = s.replaceAll(to, from);
  }
  return s;
}

const PREV: Record<string, string> = {
  seed_auto_task_queue: "20261009040000_seed_skip_unchanged.sql",
  refresh_dispatch_blocked: "20261009010000_village_chief_progress_cooling.sql",
  manual_front_pull: "20261008165000_manual_tasks_as_arm.sql",
  contribution_tasks_insert_dispatch: "20261008165000_manual_tasks_as_arm.sql",
  task_boost: "20260921000032_boost_newest_first.sql",
  task_boost_remaining: "20260921000030_single_queue_boosts.sql",
  console_admin_rule_save: "20261011290000_console_admin_rule_save.sql",
  "shared.dispatch_plan_write": "20261011270000_shared_dispatch_plan.sql",
};

for (const [name, prevMig] of Object.entries(PREV)) {
  Deno.test(`A1 ${name}：前一版是 ${prevMig}，中間沒有人插一版`, async () => {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${name}(`)) defining.push(n);
    const i = defining.indexOf(MIG_NAME);
    assert(i > 0, `${name} 不在這支 migration 裡`);
    assertEquals(defining[i - 1], prevMig, "前一版變了：要以最新的為底重做替換");
  });
}

Deno.test("A2 seed：新定義＝前一版加機械式替換，倒回去一字不差（拿掉 2:1 那一行註解除外）", async () => {
  const prev = fnText(await readMig(PREV.seed_auto_task_queue), "seed_auto_task_queue");
  const neu = fnText(MIG, "seed_auto_task_queue");
  const back = undo(neu, SEED_REPS);
  assertEquals(back, prev.replace("  -- 每 10 分鐘重排成 驗證：任務＝2:1（維護者 09-24：不要手動調）\n", ""));
});

Deno.test("A3 其餘函式：拿掉 >>> 優先秒數 區塊後，留下的每一行都在前一版裡（只加不改，改的都在區塊裡或下面列出的一行替換）", async () => {
  const ONE_LINE_OK = [
    "region, refreshed_at, opened_at, priority, priority_seconds, boost_seconds)",
    "  SELECT m.task_id, now(), queue_slot('task'), 0,",
    "(SELECT x.priority FROM activity_priority(CASE WHEN manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1),",
    "COALESCE((SELECT x.seconds FROM activity_priority_seconds(",
    "COALESCE(manual_front_seconds(m.task_id), 0)",
    "OR d.boost_seconds > 0",
    "'priority_seconds', 'requires_traffic',",
    "priority = v_row.priority, priority_seconds = v_row.priority_seconds,",
    "OR NEW.priority_seconds IS NOT NULL",
    "requires_traffic、priority_seconds 是台灣專用的欄位",
    "params, enabled, note, priority_seconds)",
    "NEW.note, NEW.priority_seconds)",
    "note = NEW.note, priority_seconds = NEW.priority_seconds",
    "    GROUP BY tc.task_id",
  ];
  for (const name of Object.keys(PREV)) {
    if (name === "seed_auto_task_queue") continue;
    const prevLines = new Set(fnText(await readMig(PREV[name]), name).split("\n"));
    const neu = fnText(MIG, name).replace(BLOCK, "");
    for (const l of neu.split("\n")) {
      if (prevLines.has(l) || ONE_LINE_OK.some((ok) => l.includes(ok))) continue;
      throw new Error(`${name} 多了一行不在前一版、也不在區塊裡：${l}`);
    }
  }
});

Deno.test("A4 seed 不再重排；任務列不再寫 1970／1980；驗證列的年段照舊；舊的 Edge 不用改", () => {
  const seed = fnText(MIG, "seed_auto_task_queue");
  assert(!/PERFORM rebalance_queue\(\)/.test(seed), "seed 不再呼叫 rebalance_queue（2:1 取消）");
  for (const n of ["seed_auto_task_queue", "contribution_tasks_insert_dispatch", "manual_front_pull"]) {
    const c = fnText(MIG, n).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert(!c.includes("manual_front_at(") && !c.includes("visitor_front_at()"), `${n} 還在寫 1970／1980`);
  }
  const trig = fnText(MIG, "task_dispatches_queue_key");
  assert(trig.includes("NEW.queue_at >= TIMESTAMPTZ '2000-01-01'"), "驗證列的 1970／1980 年段不動");
  assert(trig.includes("NEW.boost_seconds := 0"), "派出時插隊秒數歸零");
  // 觸發器名字排在 verify_front_* 前面（網站請求交件的驗證列仍由那兩支排到 1970）
  assert("trg_task_dispatches_queue_key" < "trg_task_dispatches_verify_front");
  assert("trg_task_dispatches_queue_key" < "trg_task_dispatches_verify_front_insert");
});

Deno.test("A5 主控台：規則總表多 priority_seconds（日本站給 NULL），存檔白名單有它", () => {
  const view = MIG.slice(MIG.indexOf("CREATE OR REPLACE VIEW shared.dispatch_plan"), MIG.indexOf("CREATE OR REPLACE FUNCTION shared.dispatch_plan_write"));
  assert(view.includes("r.updated_at, r.priority_seconds\n") && view.includes("r.updated_at, NULL::INTEGER\n"), "新欄位加在最後（CREATE OR REPLACE VIEW 只能往後加）");
  assert(fnText(MIG, "console_admin_rule_save").includes("'priority_seconds'"));
});

// ============================================================
// B. PGlite
// ============================================================
type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string): Promise<T> => (await rows<T>(db, sql))[0];
const G = (id: string, type: string, target: Record<string, unknown> | null): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h"], reward: 1, region: "台北市" });
const FIXTURE: Record<string, GapRow[]> = {
  dup: [G("dup1", "duplicate_politician", { a: 1 })], // 沒有選舉：預設層 0 秒
  term_policies: [G("tp22", "term_policy_missing", { election_id: 2022, election_type: "縣市議員", politician_id: "p1" })], // 投票後 181 天起：後段
  roster_villages: [G("rv26", "roster_check", { election_id: 2026, election_type: "村里長", politician_id: "v1" })], // 投票前 180 天內：前段
};
const DAY = 86400;
/** PGlite 環境沒有的表與函式（正式庫有）：查核紀錄與冷卻天數、插隊紀錄、手動任務的派出時間 */
const STUBS = `
  CREATE TABLE IF NOT EXISTS task_checks (id BIGSERIAL PRIMARY KEY, task_id TEXT, outcome TEXT, checked_at TIMESTAMPTZ DEFAULT now());
  CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT) RETURNS INTEGER
    LANGUAGE sql STABLE AS $$ SELECT CASE p_outcome WHEN 'not_found' THEN 14 ELSE 7 END $$;
  CREATE OR REPLACE FUNCTION task_cooldown_max_days() RETURNS INTEGER LANGUAGE sql STABLE AS $$ SELECT 30 $$;
  CREATE TABLE IF NOT EXISTS task_boosts (id BIGSERIAL PRIMARY KEY, label TEXT, filter JSONB, agent_name TEXT, ip_hash TEXT,
    matched_tasks INTEGER, matched_verifies INTEGER, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE _boost_src (task_id TEXT, kind TEXT);
  CREATE OR REPLACE FUNCTION task_boost_matches(p_filter JSONB) RETURNS TABLE(task_id TEXT, kind TEXT) LANGUAGE sql STABLE AS $$ SELECT task_id, kind FROM _boost_src $$;
  ALTER TABLE contribution_tasks ADD COLUMN IF NOT EXISTS last_dispatched_at TIMESTAMPTZ;
`;

async function env(): Promise<Db> {
  const db = await buildSeedEnv({ branches: FIXTURE });
  await db.exec(STUBS);
  // 主控台那一段（shared schema、日本站的表）PGlite 沒有，其餘照這支 migration 原文套
  const cut = (a: string, b: string) => MIG.slice(MIG.indexOf(a), MIG.indexOf(b));
  await db.exec(cut("-- 1. 設定與欄位", "-- 4. 主控台"));
  await db.exec(cut("-- 5. 既有的派工列換算", "NOTIFY pgrst"));
  return db;
}
const age = async (db: Db, id: string) =>
  await one<{ s: number; cooling: boolean; boost: number; prio: number }>(db,
    `SELECT round(extract(epoch FROM now() - queue_at))::INTEGER AS s, cooling, boost_seconds::INTEGER AS boost, priority_seconds AS prio FROM task_dispatches WHERE task_id = '${id}'`);

Deno.test("B1 前段 +3 天、預設 0、後段 −30 天；queue_at＝排序鍵；後段推到一天以後的先擋著（不在可派清單）", async () => {
  const db = await env();
  await db.exec("SELECT seed_auto_task_queue()");
  const rv = await age(db, "auto:rv26"), dup = await age(db, "auto:dup1"), tp = await age(db, "auto:tp22");
  assertEquals([rv.prio, dup.prio, tp.prio], [3 * DAY, 0, -30 * DAY]);
  assert(Math.abs(rv.s - 3 * DAY) < 5 && Math.abs(dup.s) < 5 && Math.abs(tp.s + 30 * DAY) < 5, JSON.stringify({ rv, dup, tp }));
  assertEquals([rv.cooling, dup.cooling, tp.cooling], [false, false, true]);
  const ready = (await rows<{ task_id: string }>(db, "SELECT task_id FROM contribution_queue_tasks(NULL, NULL, 100, '')")).map((r) => r.task_id);
  assertEquals(ready, ["auto:rv26", "auto:dup1"], "照排序鍵：前段先、預設後；後段擋著");
});

Deno.test("B2 派出：回隊尾（進隊時間＝派出當下 − 優先秒數）、插隊秒數歸零", async () => {
  const db = await env();
  await db.exec("SELECT seed_auto_task_queue()");
  await db.exec("UPDATE task_dispatches SET boost_seconds = 100, last_dispatched_at = now() - INTERVAL '5 days' WHERE task_id = 'auto:dup1'");
  assert(Math.abs((await age(db, "auto:dup1")).s - (5 * DAY + 100)) < 5);
  await db.exec("SELECT task_dispatched('auto:dup1')");
  const d = await age(db, "auto:dup1");
  assertEquals(d.boost, 0);
  assert(Math.abs(d.s) < 5, `派出後回隊尾：${d.s}`);
});

Deno.test("B3 冷卻：查核時間＋天數當下限；一天內結束的放行；優先秒數不會提早結束冷卻；插隊蓋過冷卻", async () => {
  const db = await env();
  await db.exec("SELECT seed_auto_task_queue()");
  // 前段的 rv26：14 天前 not_found → 冷卻剛好今天結束（≤ 一天）→ 放行；3 天前 → 還有 11 天，前段的 3 天不會讓它提早
  await db.exec("INSERT INTO task_checks (task_id, outcome, checked_at) VALUES ('auto:rv26', 'not_found', now() - INTERVAL '3 days')");
  await db.exec("SELECT refresh_dispatch_blocked()");
  let rv = await age(db, "auto:rv26");
  assert(rv.cooling && Math.abs(rv.s + 11 * DAY) < 5, JSON.stringify(rv));
  await db.exec("UPDATE task_checks SET checked_at = now() - INTERVAL '13 days 12 hours'");
  await db.exec("SELECT refresh_dispatch_blocked()");
  rv = await age(db, "auto:rv26");
  assert(!rv.cooling, "冷卻半天後結束：在可派視界（一天）內，放行");
  // 插隊：冷卻中也照派
  await db.exec("UPDATE task_checks SET checked_at = now() - INTERVAL '1 day'");
  await db.exec("SELECT refresh_dispatch_blocked()");
  assert((await age(db, "auto:rv26")).cooling);
  await db.exec("INSERT INTO _boost_src VALUES ('auto:rv26', 'task'); SELECT task_boost('t', '{}'::jsonb)");
  rv = await age(db, "auto:rv26");
  assert(!rv.cooling && rv.boost === 157680000, JSON.stringify(rv));
  await db.exec("SELECT refresh_dispatch_blocked()");
  assert(!(await age(db, "auto:rv26")).cooling, "下一輪 refresh 也不會把插隊的擋回去");
});

Deno.test("B4 插隊：加 5 年、兩次加兩份，馬上排在最前；派出就歸零", async () => {
  const db = await env();
  await db.exec("SELECT seed_auto_task_queue()");
  await db.exec("INSERT INTO _boost_src VALUES ('auto:dup1', 'task'); SELECT task_boost('a', '{}'::jsonb)");
  const head = async () => (await one<{ task_id: string }>(db, "SELECT task_id FROM contribution_queue_tasks(NULL, NULL, 1, '')")).task_id;
  assertEquals(await head(), "auto:dup1");
  await db.exec("SELECT task_boost('b', '{}'::jsonb)");
  assertEquals((await age(db, "auto:dup1")).boost, 2 * 157680000);
  await db.exec("SELECT task_dispatched('auto:dup1')");
  assertEquals((await age(db, "auto:dup1")).boost, 0);
  assertEquals(await head(), "auto:rv26");
});

Deno.test("B5 驗證列：進隊時間 − 任務的優先秒數（負的當 0）− 14 天；1970 年段（網站請求的交件）不動", async () => {
  const db = await env();
  await db.exec("SELECT seed_auto_task_queue()");
  await db.exec(`INSERT INTO contributions (id, contribution_type, status, task_id) VALUES ('00000000-0000-0000-0000-000000000101', 'policy', 'pending', 'auto:rv26'), ('00000000-0000-0000-0000-000000000102', 'policy', 'pending', 'auto:tp22'), ('00000000-0000-0000-0000-000000000103', 'policy', 'pending', NULL)`);
  await db.exec(`INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count) VALUES
    ('verify:00000000-0000-0000-0000-000000000101', now(), queue_slot('verify'), 0), ('verify:00000000-0000-0000-0000-000000000102', now(), queue_slot('verify'), 0), ('verify:00000000-0000-0000-0000-000000000103', now(), queue_slot('verify'), 0),
    ('verify:2', now(), TIMESTAMPTZ '1970-01-01 00:00:01+00', 0)`);
  assert(Math.abs((await age(db, "verify:00000000-0000-0000-0000-000000000101")).s - 17 * DAY) < 5, "前段任務的交件：3 天＋14 天");
  assert(Math.abs((await age(db, "verify:00000000-0000-0000-0000-000000000102")).s - 14 * DAY) < 5, "後段（−30 天）當 0");
  assert(Math.abs((await age(db, "verify:00000000-0000-0000-0000-000000000103")).s - 14 * DAY) < 5, "沒有任務：0");
  await db.exec("UPDATE queue_settings SET verify_inherit_negative = true");
  await db.exec("UPDATE task_dispatches SET priority_seconds = verify_inherited_priority_seconds(task_id) WHERE task_id = 'verify:00000000-0000-0000-0000-000000000102'");
  assert(Math.abs((await age(db, "verify:00000000-0000-0000-0000-000000000102")).s - (14 - 30) * DAY) < 5, "設定打開：負的照算");
  await db.exec("SELECT task_dispatched('verify:00000000-0000-0000-0000-000000000101')");
  assert(Math.abs((await age(db, "verify:00000000-0000-0000-0000-000000000101")).s - 17 * DAY) < 5, "再派出：沿用的秒數留著");
  assertEquals((await one<{ q: string }>(db, "SELECT queue_at::TEXT AS q FROM task_dispatches WHERE task_id = 'verify:2'")).q.slice(0, 4), "1970");
});

Deno.test("B6 手動任務：網站請求第一次進佇列＝10 年、維護者建的＝5 年；固定時段只拉沒拉過、時段開始後沒派過的", async () => {
  const db = await env();
  await db.exec(`INSERT INTO contribution_tasks (id, title, task_type, source) VALUES
    ('00000000-0000-0000-0000-00000000000a', '網站請求', 'policy_missing', 'web_request'),
    ('00000000-0000-0000-0000-00000000000b', '維護者建的', 'policy_missing', 'manual')`);
  const a = await age(db, "00000000-0000-0000-0000-00000000000a"), b = await age(db, "00000000-0000-0000-0000-00000000000b");
  assertEquals([a.boost, b.boost], [315360000, 157680000]);
  assertEquals(a.prio, 3 * DAY, "priority:manual_visitor 是前段");
  await db.exec("SELECT task_dispatched('00000000-0000-0000-0000-00000000000a')");
  assertEquals((await age(db, "00000000-0000-0000-0000-00000000000a")).boost, 0);
  // 台北 06:05（時段內）：派出在時段開始之後 → 不拉；派出在之前 → 拉，第二次冪等
  await db.exec("SET app.queue_now = '2026-10-08 06:05:00+08'");
  await db.exec("UPDATE task_dispatches SET last_dispatched_at = TIMESTAMPTZ '2026-10-08 06:01:00+08' WHERE task_id = '00000000-0000-0000-0000-00000000000a'");
  assertEquals((await one<{ n: number }>(db, "SELECT manual_front_pull() AS n")).n, 0);
  await db.exec("UPDATE task_dispatches SET last_dispatched_at = TIMESTAMPTZ '2026-10-08 05:50:00+08' WHERE task_id = '00000000-0000-0000-0000-00000000000a'");
  assertEquals((await one<{ n: number }>(db, "SELECT manual_front_pull() AS n")).n, 1);
  assertEquals((await one<{ n: number }>(db, "SELECT manual_front_pull() AS n")).n, 0);
  assertEquals((await age(db, "00000000-0000-0000-0000-00000000000a")).boost, 315360000);
});

Deno.test("B7 既有列換算：1970／1980 年段的任務列換成插隊秒數（1980 年段越早的多給幾秒，先後不變），不留在年段裡", async () => {
  const db = await buildSeedEnv({ branches: FIXTURE });
  await db.exec(STUBS);
  await db.exec(`
    SELECT seed_auto_task_queue();
    UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1980-01-01 00:00:00+00' - INTERVAL '3 minutes' WHERE task_id = 'auto:dup1';
    UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1980-01-01 00:00:00+00' - INTERVAL '1 minute' WHERE task_id = 'auto:tp22';
    UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1970-01-01 00:00:00+00' WHERE task_id = 'auto:rv26';
  `);
  const cut = (a: string, b: string) => MIG.slice(MIG.indexOf(a), MIG.indexOf(b));
  await db.exec(cut("-- 1. 設定與欄位", "-- 4. 主控台"));
  await db.exec(cut("-- 5. 既有的派工列換算", "NOTIFY pgrst"));
  const b = Object.fromEntries((await rows<{ task_id: string; boost: number }>(db, "SELECT task_id, boost_seconds::INTEGER AS boost FROM task_dispatches")).map((r) => [r.task_id, r.boost]));
  assertEquals(b["auto:rv26"], 315360000);
  assertEquals(b["auto:dup1"], 157680000 + 180);
  assertEquals(b["auto:tp22"], 157680000 + 60);
  assertEquals((await one<{ n: number }>(db, "SELECT count(*)::INTEGER AS n FROM task_dispatches WHERE queue_at < '2000-01-01'")).n, 0);
});
