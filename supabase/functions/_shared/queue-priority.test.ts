/**
 * 佇列的優先層（2026-10-08，docs/PLAN-task-activation.md 第 11 節；migration 20261008090000_queue_priority_tiers.sql）。
 *
 * 維護者 10-08「加推自動化」：任務排在哪一層由 activity_rules 決定（投票日前 180 天內＝前段、公報前的非縣市長 policy_missing＝中段、
 * 投票日後 181 天起的歷史補資料＝後段），rebalance_queue 用 task_priority_tiers.weight 加權交錯，同一層內仍是先進先出，驗證：任務＝2:1 不變，
 * 手動插隊（queue_at 1980 年段）仍在最前面，後段保有 1/10 不會餓死。守門分兩半，都只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）：
 *
 *   A. 文字層（不開資料庫）
 *      1. rebalance_queue、seed_auto_task_queue 新定義＝前一版（20260924000006、P1 20261008060000）加機械式替換（標記起訖），其餘一字不差；
 *         election_milestones_all＝P0 的視圖加一段 bulletin_published；這支 migration 是它們最後一版，而且沒有動總表、/next、queue_slot、task_dispatched
 *      2. 規則值（年份、職位、天數、權重、里程碑名）只在種子資料裡，三支函式的本體裡一個都沒有
 *      3. 還原驗證：動一個不該動的字，上面都要紅
 *
 *   B. PGlite（行為層）：真的 queue_slot／rebalance_queue／contribution_auto_tasks／task_dispatched／seed／P0／P1，28 個分支換成 stub 表；
 *      多輪「seed＋派出」（派出＝照 /next 取隊頭、task_dispatched 放回隊尾，每 10 筆跑一次 seed 當 10 分鐘排程）
 *      1. 優先層：表格化的（臂×選舉×職位×日期→層）、個案降級勝過通則、公報日／投票日／投票日後 181 天換層、公報日是空的＝已上架不降級
 *      2. 交錯：三層都有積壓時每 10 筆＝6 前段、3 中段、1 後段（獨立的 TS 版加權公平排隊當對照），同一層內先進先出
 *      3. 不餓死：後段在前段永遠有事做時，每一輪都有後段、每一筆後段在一個週期內都派到過；驗證：任務＝2:1 不變
 *      4. 手動插隊仍在最前面、領走後回到自己那一層的隊尾；沒有任何優先規則時輸出與舊 rebalance_queue 逐件相同
 *      5. 記錄：opened_by.priority／priority_rule_id、gap_events.priority（出生時的層），換層後 task_dispatches.priority 變、出生時的層不變
 *      6. 規則值是資料：改種子表（權重、規則的層）結果跟著變；優先規則不會把活動「開」起來（派工輸出與 P1 逐件相同）
 *      7. 每條守門都做還原驗證：把 migration 文字改壞一處（精確改一處，改不到就失敗），對應的檢查必須紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { armsDiff, buildArmsDb, fnText, type GapRow, latestFn, migrationNames, mutate, P0_MIG, P1_MIG, readMig } from "./arms-pglite.ts";

export const QP_MIG = "20261008090000_queue_priority_tiers.sql";
const BASE_REBALANCE_MIG = "20260924000006_rebalance_keep_head.sql";

const QP = await readMig(QP_MIG);
const P0 = await readMig(P0_MIG);
const P1 = await readMig(P1_MIG);

// ============================================================
// A. 文字層
// ============================================================
const OLD_REBALANCE = fnText(await readMig(BASE_REBALANCE_MIG), "rebalance_queue");
const NEW_REBALANCE = fnText(QP, "rebalance_queue");
const OLD_SEED = fnText(P1, "seed_auto_task_queue");
const NEW_SEED = fnText(QP, "seed_auto_task_queue");
const bodyOf = (fn: string) => fn.slice(fn.indexOf("$$\n") + 3, fn.lastIndexOf("$$;"));

const MARK = /  -- >>> 優先層[^\n]*\n[\s\S]*?  -- <<< 優先層\n\n?/g;
const OLD_REBALANCE_CTE = `  WITH t AS (
    SELECT d.task_id, row_number() OVER (ORDER BY d.queue_at, d.task_id) - 1 AS rn
      FROM task_dispatches d JOIN _ready r ON r.task_id = d.task_id
  )
`;
const isMechanicalRebalance = (fn: string) => {
  try {
    return (fn.match(MARK) ?? []).length === 1 && fn.replace(MARK, () => OLD_REBALANCE_CTE) === OLD_REBALANCE;
  } catch {
    return false;
  }
};

const SEED_INS_COLS_NEW = "refreshed_at, opened_at, opened_by, priority)";
const SEED_INS_COLS_OLD = "refreshed_at, opened_at, opened_by)";
const SEED_INS_SEL_NEW = "g.region, now(), now(),\n         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id)), g.priority\n    FROM _gaps g";
const SEED_INS_SEL_OLD = "g.region, now(), now(), g.opened_by\n    FROM _gaps g";
const isMechanicalSeed = (fn: string) => {
  try {
    let s = fn.replace(MARK, "");
    s = mutate(s, SEED_INS_COLS_NEW, SEED_INS_COLS_OLD);
    s = mutate(s, SEED_INS_SEL_NEW, SEED_INS_SEL_OLD);
    return s === OLD_SEED;
  } catch {
    return false;
  }
};

const viewText = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE VIEW election_milestones_all AS"), sql.indexOf(";\nCOMMENT ON VIEW election_milestones_all"));
const BULLETIN_BRANCH = /\n  UNION ALL\n  SELECT e\.id, 'bulletin_published'::TEXT[\s\S]*$/;
const isMechanicalView = (sql: string) => {
  const v = viewText(sql);
  return BULLETIN_BRANCH.test(v) && v.replace(BULLETIN_BRANCH, "") === viewText(P0);
};

Deno.test("A1 這支 migration 是 rebalance_queue、seed_auto_task_queue 的最後一版，緊接著現行版；沒有動總表、/next、queue_slot、task_dispatched", async () => {
  for (const [fn, chain] of [
    ["rebalance_queue", ["20260924000005_queue_rebalance.sql", BASE_REBALANCE_MIG, QP_MIG, "20261008165000_manual_tasks_as_arm.sql"]],
    ["seed_auto_task_queue", [] as string[]], // seed 的完整歷史很長，只看最後三版
  ] as [string, string[]][]) {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) defining.push(n);
    if (chain.length) assertEquals(defining, chain, `${fn} 的定義歷史：這支要緊接在現行版之後、而且是最後一版（有人在中間或之後改了，抄的底就過期）`);
    // 這支之後只允許 party_roster 那支 P2（20261008121000：seed 加 window／filled 兩段插入，與這支的優先層區塊互不相撞，守門在 activity-party-roster.test.ts）
    else assertEquals(defining.slice(-5), [P0_MIG, P1_MIG, QP_MIG, "20261008121000_activity_windows_p2_party_roster.sql", "20261008165000_manual_tasks_as_arm.sql"], `${fn} 最後五版應該是 P0、P1、這支、party_roster 的 P2、手動任務臂；有人在中間或之後改了，要以最新那版為底重做`);
  }
  const code = QP.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const untouched of ["contribution_auto_tasks_arms", "contribution_auto_tasks", "queue_slot", "task_dispatched", "task_boost", "task_boost_matches", "activity_open", "activity_require_rule"]) {
    assert(!new RegExp(`(CREATE OR REPLACE FUNCTION|DROP FUNCTION( IF EXISTS)?) ${untouched}\\(`).test(code), `這支不改 ${untouched}`);
  }
  assert(!/DROP FUNCTION/.test(code) && !/DROP COLUMN|DROP TABLE (?!IF EXISTS _)/.test(code), "只加不刪");
  assert(!/UPDATE elections|ALTER TABLE elections/i.test(code), "不動 elections（bulletin_published_on 是既有欄位，只讀）");
});

Deno.test("A2 rebalance_queue 新定義＝現行定義＋機械式替換（可派任務那一段的排名換成加權交錯），其餘一字不差", () => {
  assert(isMechanicalRebalance(NEW_REBALANCE));
  assertEquals(NEW_REBALANCE.replace(MARK, () => OLD_REBALANCE_CTE), OLD_REBALANCE);
  assertEquals((NEW_REBALANCE.match(/-- >>> 優先層/g) ?? []).length, 1);
  // 驗證那一段、不可派那一段、起點、回傳值都在（上面的全文比對已經涵蓋，這裡點名，讀的人一眼看到）
  assert(NEW_REBALANCE.includes("UPDATE task_dispatches d SET queue_at = v_start + v.rn * INTERVAL '1 second' FROM v"), "驗證每筆 1 秒");
  assert(NEW_REBALANCE.includes("v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds'"), "任務每筆 2 秒（2:1）");
  assert(NEW_REBALANCE.includes("WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';"), "插隊的不進重排");
});

Deno.test("A3 seed 新定義＝P1 的定義加標記起訖的優先層區塊與 INSERT 兩處，其餘一字不差；election_milestones_all＝P0 的視圖加一段", () => {
  assert(isMechanicalSeed(NEW_SEED));
  assertEquals((NEW_SEED.match(/-- >>> 優先層/g) ?? []).length, 2, "算層一段、既有列換層一段");
  assert(NEW_SEED.includes("PERFORM rebalance_queue();") && NEW_SEED.includes("RETURN v_new + v_verify;"));
  assert(isMechanicalView(QP));
});

Deno.test("A4 規則值只在種子資料裡：activity_priority、rebalance 的優先層區塊、seed 的優先層區塊沒有年份、職位、天數、權重、里程碑名", () => {
  const blocks = [
    ["activity_priority", bodyOf(fnText(QP, "activity_priority"))],
    ["rebalance 優先層區塊", [...NEW_REBALANCE.matchAll(MARK)].map((m) => m[0]).join("")],
    ["seed 優先層區塊", [...NEW_SEED.matchAll(MARK)].map((m) => m[0]).join("")],
  ];
  for (const [name, text] of blocks) {
    const code = text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const lit of [/20\d\d/, /縣市|村里|鄉鎮|議員|立法|總統/, /polling|bulletin|registration|term_start/, /\b(180|181|60|30|365)\b/, /weight\s*[=<>]\s*\d/i]) {
      assert(!lit.test(code), `${name} 裡不該有寫死的規則值（${lit}）`);
    }
  }
  // 種子在 migration 的資料段：三層、三條規則，權重 6:3:1，預設層＝中段
  assert(/\(1, '前段', 6, false,/.test(QP) && /\(2, '中段', 3, true,/.test(QP) && /\(3, '後段', 1, false,/.test(QP));
  assert(QP.includes("('priority:*', 'polling', -180, 'polling', 0, NULL::TEXT[], 1::SMALLINT,"));
  assert(QP.includes("('priority:*', 'polling', 181, NULL, 0, NULL::TEXT[], 3::SMALLINT,"));
  assert(QP.includes("('priority:raw:policy_missing', NULL, 0, 'bulletin_published', -1,"));
});

Deno.test("A5 還原驗證（文字層）：動不該動的字、少一處替換、動 seed 本體，A2～A3 都要紅", () => {
  // rebalance
  assert(!isMechanicalRebalance(mutate(NEW_REBALANCE, "UPDATE task_dispatches d SET queue_at = v_start + v.rn * INTERVAL '1 second' FROM v", "UPDATE task_dispatches d SET queue_at = v_start + v.rn * INTERVAL '2 seconds' FROM v")), "偷改驗證間距");
  assert(!isMechanicalRebalance(mutate(NEW_REBALANCE, "WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';", "WHERE true;")), "偷改插隊的排除");
  assert(!isMechanicalRebalance(mutate(NEW_REBALANCE, "RETURN v_n;", "RETURN 0;")), "偷改回傳值");
  assert(!isMechanicalRebalance(mutate(NEW_REBALANCE, "+ (v_ready + t2.rn) * INTERVAL '2 seconds'", "+ (t2.rn) * INTERVAL '2 seconds'")), "偷改不可派那一段");
  assert(!isMechanicalRebalance(OLD_REBALANCE), "舊版本身不是新的");
  assert(!isMechanicalRebalance(mutate(NEW_REBALANCE, "  -- <<< 優先層\n", "")), "結束標記掉了＝替換抓不到，也要紅");
  // seed
  assert(!isMechanicalSeed(mutate(NEW_SEED, "AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);", "AND true;")), "偷改收回條件");
  assert(!isMechanicalSeed(mutate(NEW_SEED, "RETURN v_new + v_verify;", "RETURN v_new;")), "偷改回傳值");
  assert(!isMechanicalSeed(mutate(NEW_SEED, "ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,", "ORDER BY g.priority, g.task_id) - 1) * INTERVAL '2 seconds', 0,")), "偷改新缺口的排隊位置");
  assert(!isMechanicalSeed(OLD_SEED), "P1 的 seed 本身不是新的");
  // view
  assert(!isMechanicalView(QP.replace("   WHERE e.bulletin_published_on IS NOT NULL\n", "   WHERE true\n").replace("  SELECT e.id, 'polling'::TEXT", "  SELECT e.id, 'polling2'::TEXT")), "偷改 P0 的視圖");
});

// ============================================================
// B. PGlite（行為層）
// ============================================================
const G = (id: string, type: string, target: Record<string, unknown> | null = null): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h"], reward: 1, region: "台北市" });
const E = (election_id: number, election_type?: string) => ({ election_id, ...(election_type === undefined ? {} : { election_type }) });
const seq = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${String(i + 1).padStart(2, "0")}`);

// 前段 f：2026 村里長 roster_check（roster_villages 臂）；中段降級 m：2026 縣市議員 policy_missing（raw）；中段預設 n：沒有選舉的 duplicate_politician；後段 b：2022 term_policy_missing
const NF = 12, NM = 6, NN = 3, NB = 10;
const F_IDS = seq("f", NF), M_IDS = seq("m", NM), N_IDS = seq("n", NN), B_IDS = seq("b", NB);
const FIXTURE = {
  roster_villages: F_IDS.map((i) => G(i, "roster_check", E(2026, "村里長"))),
  raw: M_IDS.map((i) => G(i, "policy_missing", E(2026, "縣市議員"))),
  dup: N_IDS.map((i) => G(i, "duplicate_politician")),
  term_policies: B_IDS.map((i) => G(i, "term_policy_missing", E(2022, "縣市議員"))),
};
const tierOf = (id: string) => (id.startsWith("f") ? 1 : id.startsWith("b") ? 3 : 2);

type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];
const short = (t: string) => t.replace(/^auto:/, "");
const setToday = (db: Db, d: string) => db.exec(`SET app.activity_today = '${d}'`);

/** P0＋P1（28 個分支 stub）＋真的 queue_slot／contribution_auto_tasks／task_dispatched／rebalance／seed（套這支 migration，可被改壞） */
async function buildDb(mutateQP: (s: string) => string = (s) => s, applyQP = true): Promise<Db> {
  const db = await buildArmsDb({ branches: FIXTURE });
  // elections.bulletin_published_on 是 20261008000002 加的既有欄位（測試環境的 elections 是精簡版，補上）
  await db.exec(`ALTER TABLE elections ADD COLUMN bulletin_published_on date; UPDATE elections SET bulletin_published_on = DATE '2026-11-18' WHERE id = 2026;`);
  await db.exec(`
    ALTER TABLE contributions ADD COLUMN contributor_ip_hash text, ADD COLUMN agent_name text, ADD COLUMN payload jsonb;
    CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
    CREATE FUNCTION task_target_key(t text, tg jsonb) RETURNS text LANGUAGE sql AS $$ SELECT t $$;
  `);
  await db.exec(`DROP FUNCTION queue_slot(text)`); // 測試環境的空殼參數名不同，CREATE OR REPLACE 不能改參數名
  await db.exec(await latestFn("queue_slot"));
  await db.exec(await latestFn("contribution_auto_tasks"));
  await db.exec(await latestFn("task_dispatched"));
  // 測試環境的驗證列照真的 queue_slot('verify') 排（正式庫的 contribution_queue_at 還要看插隊類型，與這裡無關）
  await db.exec(`CREATE OR REPLACE FUNCTION contribution_queue_at(t text, k text, c timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT queue_slot('verify') $$`);
  if (applyQP) await db.exec(mutateQP(QP));
  await setToday(db, "2026-10-08");
  return db;
}

/** 獨立的 TS 版加權公平排隊（不讀 migration 的 SQL）：第 k 筆的虛擬完成時間＝k／權重，同時間層號小的先，同一層內照 (queue_at, task_id) */
type Ready = { task_id: string; tier: number; ord: number };
function wfqOrder(ready: Ready[], weights: Record<number, number>): string[] {
  const byTier = new Map<number, Ready[]>();
  for (const r of [...ready].sort((a, b) => a.ord - b.ord)) byTier.set(r.tier, [...(byTier.get(r.tier) ?? []), r]);
  const items: { id: string; tier: number; k: number; w: number }[] = [];
  for (const [tier, rs] of byTier) rs.forEach((r, i) => items.push({ id: r.task_id, tier, k: i + 1, w: weights[tier] ?? 1 }));
  // k1/w1 vs k2/w2 用交叉相乘比，不用浮點
  items.sort((a, b) => a.k * b.w - b.k * a.w || a.tier - b.tier);
  return items.map((x) => x.id);
}
const readyState = (db: Db) =>
  rows<Ready>(db,
    `SELECT d.task_id, COALESCE(d.priority, (SELECT id FROM task_priority_tiers WHERE is_default))::int AS tier,
            (row_number() OVER (ORDER BY d.queue_at, d.task_id COLLATE "C"))::int AS ord
       FROM task_dispatches d WHERE d.task_id LIKE 'auto:%' AND NOT d.blocked AND NOT d.cooling AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
      ORDER BY d.queue_at, d.task_id COLLATE "C"`);
const weightsOf = async (db: Db) => Object.fromEntries((await rows<{ id: number; weight: number }>(db, `SELECT id::int, weight FROM task_priority_tiers`)).map((r) => [r.id, r.weight]));
const actualOrder = async (db: Db) =>
  (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:%' AND NOT blocked AND NOT cooling AND queue_at >= TIMESTAMPTZ '2000-01-01' ORDER BY queue_at, task_id COLLATE "C"`)).map((r) => r.task_id);
/** 現在這份派工列，照 oracle 該排成什麼順序（呼叫 rebalance 之前算） */
const oracleNow = async (db: Db) => wfqOrder(await readyState(db), await weightsOf(db));
const tiersOf = async (db: Db, ids: string[]) =>
  Object.fromEntries((await rows<{ task_id: string; priority: number | null }>(db, `SELECT task_id, priority::int FROM task_dispatches WHERE task_id = ANY($1)`, [ids.map((i) => `auto:${i}`)])).map((r) => [short(r.task_id), r.priority]));
const allTierIs = (m: Record<string, number | null>, ids: string[], t: number) => ids.every((i) => m[i] === t);

async function dispatchHead(db: Db): Promise<string> {
  const h = await one<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks(NULL, NULL, 1, '', NULL, NULL)`);
  await db.query(`SELECT task_dispatched($1)`, [h.task_id]);
  return h.task_id;
}
/** 多輪：每輪派出 per 筆，之後跑一次 seed（＝10 分鐘排程）。回傳每輪派出的 task_id */
async function rounds(db: Db, n: number, per = 10): Promise<string[][]> {
  const out: string[][] = [];
  for (let r = 0; r < n; r++) {
    const batch: string[] = [];
    for (let i = 0; i < per; i++) batch.push(short(await dispatchHead(db)));
    out.push(batch);
    await db.exec(`SELECT seed_auto_task_queue()`);
  }
  return out;
}

type Verdicts = Record<string, boolean>;
async function check(out: Verdicts, name: string, f: () => Promise<boolean>) {
  try {
    out[name] = await f();
  } catch (e) {
    console.error(`[${name}]`, (e as Error).message);
    out[name] = false;
  }
}

const GUARDS = [
  "priority_table", "namespace_and_open_unaffected", "bulletin_milestone", "tiers_assigned", "opened_by_records_priority", "gap_events_priority_column",
  "weave_matches_oracle", "pattern_6_3_1", "rounds_weave_each_block", "fifo_within_tier", "no_starvation", "ratio_2_1", "boost_stays_front", "boost_returns_to_its_tier_tail",
  "promotion_reflected", "demotion_beats_front", "later_tiers_by_date", "closed_event_keeps_birth_priority", "weights_are_data", "rules_are_data", "same_tier_equals_old_rebalance",
] as const;

async function runSuite(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  const c = (name: string, f: () => Promise<boolean>) => check(v, name, f);
  const tierAt = async (activity: string, eid: number | null, etype: string | null, day: string) =>
    (await one<{ priority: number | null; rule_id: number | null }>(db, `SELECT priority::int, rule_id::int FROM activity_priority($1::text, $2::int, $3::text, $4::date)`, [activity, eid, etype, day]));

  // ---- 1. 優先層：表格化 ----
  await c("priority_table", async () => {
    const T: [string, number | null, string | null, string, number][] = [
      // 前段：投票日前 180 天（2026-06-01）起到投票日（含頭含尾）
      ["raw:profile_gap", 2026, null, "2026-10-08", 1], ["roster_villages", 2026, "村里長", "2026-10-08", 1], ["mayor_policies", 2026, "縣市長", "2026-10-08", 1],
      ["raw:profile_gap", 2026, null, "2026-05-31", 2], ["raw:profile_gap", 2026, null, "2026-06-01", 1], ["raw:profile_gap", 2026, null, "2026-11-28", 1],
      // 投票後 180 天內＝預設（中段）；181 天起＝後段（2026-11-28 + 181 天 ＝ 2027-05-28）
      ["raw:profile_gap", 2026, null, "2026-11-29", 2], ["raw:profile_gap", 2026, null, "2027-05-27", 2], ["raw:profile_gap", 2026, null, "2027-05-28", 3],
      // 歷史補資料
      ["term_policies", 2022, "縣市議員", "2026-10-08", 3], ["term_policies", 2024, "立法委員", "2026-10-08", 3], ["roster_cec_gap", 4, "縣市長", "2026-10-08", 3],
      ["election_results", 2022, "縣市長", "2026-10-08", 3],
      // 沒有選舉的任務＝預設層
      ["dup", null, null, "2026-10-08", 2], ["party_info", null, null, "2026-10-08", 2],
      // 個案降級：非縣市長的 policy_missing 在公報上架日（2026-11-18）之前＝中段，當天起回到前段；縣市長不降級
      ["raw:policy_missing", 2026, "縣市議員", "2026-10-08", 2], ["raw:policy_missing", 2026, "村里長", "2026-11-17", 2], ["raw:policy_missing", 2026, "縣市議員", "2026-11-18", 1],
      ["raw:policy_missing", 2026, "縣市長", "2026-10-08", 1], ["mayor_policies", 2026, "縣市長", "2026-10-08", 1],
      // 個案規則只管 raw:policy_missing；同一批人的別種任務不降級
      ["raw:candidacy_source_missing", 2026, "縣市議員", "2026-10-08", 1], ["township_gap", 2026, "鄉鎮市長", "2026-10-08", 1],
    ];
    const bad: string[] = [];
    for (const [a, e, t, d, want] of T) {
      const got = await tierAt(a, e, t, d);
      if (got.priority !== want) bad.push(`${a}/${e}/${t}/${d}: 要 ${want} 得 ${got.priority}`);
    }
    // 相符的規則 id：預設層沒有規則；降級那條規則 id 是種子的第三條
    const rules = await rows<{ id: number; activity: string; priority: number }>(db, `SELECT id::int, activity, priority::int FROM activity_rules WHERE priority IS NOT NULL ORDER BY id`);
    const front = await tierAt("raw:profile_gap", 2026, null, "2026-10-08");
    const demote = await tierAt("raw:policy_missing", 2026, "縣市議員", "2026-10-08");
    const dflt = await tierAt("dup", null, null, "2026-10-08");
    const back = await tierAt("term_policies", 2022, "縣市議員", "2026-10-08");
    if (bad.length) console.error(bad.join("\n"));
    return bad.length === 0 && rules.length === 3 && front.rule_id === rules[0].id && back.rule_id === rules[1].id && demote.rule_id === rules[2].id && dflt.rule_id === null;
  });
  await c("demotion_beats_front", async () => {
    // 同時相符時取號碼最大的：2026 縣市議員 policy_missing 同時符合「前段通則」與「中段個案」→ 中段
    const hits = await rows<{ rid: number }>(db, `SELECT o.rule_id::int AS rid FROM activity_open('priority:*', 2026, '縣市議員', DATE '2026-10-08') o
                                                   UNION ALL SELECT o.rule_id::int FROM activity_open('priority:raw:policy_missing', 2026, '縣市議員', DATE '2026-10-08') o`);
    return hits.length === 2 && (await tierAt("raw:policy_missing", 2026, "縣市議員", "2026-10-08")).priority === 2;
  });
  await c("bulletin_milestone", async () => {
    const m = await rows<{ election_id: number; on_date: string; status: string; origin: string }>(db, `SELECT election_id::int, on_date::text, status, origin FROM election_milestones_all WHERE kind = 'bulletin_published'`);
    // 公報日是空的＝已上架：沒有里程碑，個案規則比對不到，不降級（2026 的公報日清成空，中段降級就解除）
    await db.exec("BEGIN");
    await db.exec(`UPDATE elections SET bulletin_published_on = NULL WHERE id = 2026`);
    const none = (await rows(db, `SELECT 1 FROM election_milestones_all WHERE kind = 'bulletin_published'`)).length === 0;
    const notDemoted = (await tierAt("raw:policy_missing", 2026, "縣市議員", "2026-10-08")).priority === 1;
    // 表裡有整場的 bulletin_published 列時以表為準（不重複）
    await db.exec(`UPDATE elections SET bulletin_published_on = DATE '2026-11-18' WHERE id = 2026`);
    await db.exec(`INSERT INTO election_milestones (election_id, kind, on_date, basis, status) VALUES (2026, 'bulletin_published', DATE '2026-11-10', 'official', 'announced')`);
    const t = await rows<{ on_date: string; origin: string }>(db, `SELECT on_date::text, origin FROM election_milestones_all WHERE kind = 'bulletin_published'`);
    const tableWins = t.length === 1 && t[0].on_date === "2026-11-10" && t[0].origin === "table";
    await db.exec("ROLLBACK");
    return m.length === 1 && m[0].election_id === 2026 && m[0].on_date === "2026-11-18" && m[0].status === "announced" && m[0].origin === "elections" && none && notDemoted && tableWins;
  });
  await c("namespace_and_open_unaffected", async () => {
    // 優先規則只管排序、不管開關：活動名一定是 priority:…，反過來也成立；總表輸出與 P1 逐件相同；沒有任何派工列的出生規則是優先規則
    const attempts = [
      `INSERT INTO activity_rules (activity, window_kind, priority) VALUES ('dup', 'always', 1)`,
      `INSERT INTO activity_rules (activity, window_kind) VALUES ('priority:dup', 'always')`,
      `INSERT INTO activity_rules (activity, window_kind, priority) VALUES ('priority:dup', 'always', 7)`,
    ];
    let rejected = 0;
    await db.exec("BEGIN");
    for (const sql of attempts) {
      await db.exec("SAVEPOINT s");
      try {
        await db.exec(sql);
        await db.exec("ROLLBACK TO SAVEPOINT s");
      } catch {
        await db.exec("ROLLBACK TO SAVEPOINT s");
        rejected++;
      }
    }
    await db.exec("ROLLBACK");
    const d = await armsDiff(db, "legacy_arms", "contribution_auto_tasks_arms");
    const health = (await rows(db, `SELECT * FROM activity_health WHERE check_name <> 'clock_overridden'`)).length === 0; // 假時鐘本來就會列 clock_overridden
    const priorityOpens = (await rows(db, `SELECT 1 FROM contribution_auto_tasks_arms() g WHERE (g.opened_by->>'rule_id')::bigint IN (SELECT id FROM activity_rules WHERE priority IS NOT NULL)`)).length === 0;
    // 優先規則的活動名拿去問 activity_open 只會回優先規則自己；一般活動名不會回優先規則
    const normal = (await rows(db, `SELECT 1 FROM activity_open('raw:profile_gap', 2026, NULL) o JOIN activity_rules r ON r.id = o.rule_id WHERE r.priority IS NOT NULL`)).length === 0;
    return rejected === 3 && d.aOnly === 0 && d.bOnly === 0 && d.aN === d.bN && d.aN > 0 && health && priorityOpens && normal;
  });

  // ---- 2. 第一次 seed：每個缺口算出自己的層，同一輪 rebalance 交錯 ----
  await db.exec(`SELECT seed_auto_task_queue()`);
  const ALL = [...F_IDS, ...M_IDS, ...N_IDS, ...B_IDS];
  await c("tiers_assigned", async () => {
    const t = await tiersOf(db, ALL.map((i) => i));
    const ok = allTierIs(t, F_IDS, 1) && allTierIs(t, M_IDS, 2) && allTierIs(t, N_IDS, 2) && allTierIs(t, B_IDS, 3);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'auto:%'`);
    return ok && n.n === ALL.length;
  });
  await c("opened_by_records_priority", async () => {
    const ob = async (id: string) => (await one<{ ob: Record<string, unknown> }>(db, `SELECT opened_by AS ob FROM task_dispatches WHERE task_id = $1`, [`auto:${id}`])).ob;
    const rules = await rows<{ id: number }>(db, `SELECT id::int FROM activity_rules WHERE priority IS NOT NULL ORDER BY id`);
    const f = await ob("f01"), m = await ob("m01"), n = await ob("n01"), b = await ob("b01");
    // 出生時的層與依據的規則；預設層沒有 priority_rule_id；原本 P1 帶的規則欄位（rule_id＝開窗規則）還在
    return f.priority === 1 && f.priority_rule_id === rules[0].id && m.priority === 2 && m.priority_rule_id === rules[2].id && n.priority === 2 && !("priority_rule_id" in n) &&
      b.priority === 3 && b.priority_rule_id === rules[1].id && f.basis === "rule" && typeof f.rule_id === "number" && f.rule_id !== f.priority_rule_id && f.election_id === 2026;
  });
  await c("gap_events_priority_column", async () => {
    const e = await rows<{ task_id: string; event: string; priority: number | null }>(db, `SELECT task_id, event, priority::int FROM gap_events WHERE event = 'opened' ORDER BY task_id COLLATE "C"`);
    const want = Object.fromEntries(ALL.map((i) => [`auto:${i}`, tierOf(i)]));
    return e.length === ALL.length && e.every((x) => x.priority === want[x.task_id]);
  });
  // 這時候每一列的 queue_at 是同一批插入的 task_id 順序（先進先出），rebalance 剛把它們交錯過；對照獨立算法
  await c("weave_matches_oracle", async () => {
    const tiers = Object.fromEntries(ALL.map((i) => [i, tierOf(i)]));
    const fifo = [...ALL].sort(); // 同一批插入，先進先出＝task_id 順序
    const want = wfqOrder(fifo.map((id, ord) => ({ task_id: `auto:${id}`, tier: tiers[id], ord })), await weightsOf(db));
    const got = await actualOrder(db);
    if (JSON.stringify(got) !== JSON.stringify(want)) console.error("got ", got.map(short).join(" "), "\nwant", want.map(short).join(" "));
    return JSON.stringify(got) === JSON.stringify(want) && got.length === ALL.length;
  });
  await c("pattern_6_3_1", async () => {
    const got = (await actualOrder(db)).slice(0, 20).map((t) => tierOf(short(t)));
    // 三層都有積壓：每 10 筆 6 前段、3 中段、1 後段，而且前段先走（同一個虛擬時間點層號小的先）
    return JSON.stringify(got.slice(0, 10)) === JSON.stringify([1, 1, 2, 1, 1, 2, 1, 1, 2, 3]) && got.slice(0, 20).filter((t) => t === 1).length === 12;
  });
  await c("ratio_2_1", async () => {
    // 加進 40 張待驗證貢獻：驗證與可派任務在同一條時間軸上是 驗 驗 任 驗 驗 任…；任務的順序仍是上面的交錯
    await db.exec(`INSERT INTO contributions (id, status, contribution_type, task_id, created_at)
                   SELECT gen_random_uuid(), 'pending', 'policy', NULL, now() FROM generate_series(1, 40)`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const kinds = (await rows<{ task_id: string }>(db,
      `SELECT task_id FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01' AND (task_id LIKE 'verify:%' OR (task_id LIKE 'auto:%' AND NOT blocked AND NOT cooling))
        ORDER BY queue_at, task_id COLLATE "C" LIMIT 30`)).map((r) => (r.task_id.startsWith("verify:") ? "V" : "T")).join("");
    const tasksInOrder = (await actualOrder(db)).slice(0, 5).map((t) => tierOf(short(t)));
    await db.exec(`DELETE FROM contributions`);
    await db.exec(`SELECT seed_auto_task_queue()`); // 驗證列收掉，回到只有任務
    return kinds === "VVT".repeat(10) && JSON.stringify(tasksInOrder) === JSON.stringify([1, 1, 2, 1, 1]);
  });

  // ---- 3. 多輪 seed＋派出 ----
  let blocks: string[][] = [];
  await c("rounds_weave_each_block", async () => {
    blocks = await rounds(db, 10); // 100 筆派出、10 次排程
    // 每一輪（兩次 seed 之間的 10 筆）都是 6 前段、3 中段、1 後段
    const per = blocks.map((b) => [1, 2, 3].map((t) => b.filter((x) => tierOf(x) === t).length).join("/"));
    if (per.some((p) => p !== "6/3/1")) console.error(per.join(" "));
    return per.every((p) => p === "6/3/1");
  });
  await c("fifo_within_tier", async () => {
    // 同一層內先進先出：每一層被派出的順序是它自己的循環（派過回到那一層的隊尾）
    const flat = blocks.flat();
    const cyc = (ids: string[], n: number) => Array.from({ length: n }, (_, i) => ids[i % ids.length]);
    const seen = (t: number) => flat.filter((x) => tierOf(x) === t);
    // 中段是 m 與 n 混在同一層，順序按它們的到達先後（m 先、n 後：同一批插入按 task_id 排，m < n）
    return JSON.stringify(seen(1)) === JSON.stringify(cyc(F_IDS, 60)) && JSON.stringify(seen(3)) === JSON.stringify(cyc(B_IDS, 10)) &&
      JSON.stringify(seen(2)) === JSON.stringify(cyc([...M_IDS, ...N_IDS], 30));
  });
  await c("no_starvation", async () => {
    // 前段永遠有事做（沒有人做完任何一筆）：後段每一輪都分到，10 輪下來每一筆後段剛好派到一次
    const back = blocks.flat().filter((x) => tierOf(x) === 3);
    return blocks.every((b) => b.some((x) => tierOf(x) === 3)) && new Set(back).size === NB && back.length === NB;
  });

  // ---- 4. 手動插隊 ----
  await c("boost_stays_front", async () => {
    // 照 task_boost 的寫法：把後段的 b05 排到 1980 年段
    await db.exec(`UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1980-01-01' - INTERVAL '3 minutes' WHERE task_id = 'auto:b05'`);
    const before = (await actualOrder(db)).filter((t) => t !== "auto:b05");
    await db.exec(`SELECT seed_auto_task_queue()`);
    const head = await one<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks(NULL, NULL, 1, '', NULL, NULL)`);
    const b5 = await one<{ q: boolean }>(db, `SELECT queue_at < TIMESTAMPTZ '1990-01-01' AS q FROM task_dispatches WHERE task_id = 'auto:b05'`);
    // 其餘的順序仍是 oracle 的（插隊的不進交錯、不改變別人的相對位置）
    const after = await actualOrder(db);
    return head.task_id === "auto:b05" && b5.q && after.length === ALL.length - 1 && after.every((t) => t !== "auto:b05") && before.length === after.length;
  });
  await c("boost_returns_to_its_tier_tail", async () => {
    const got = await dispatchHead(db); // 領走插隊的
    await db.exec(`SELECT seed_auto_task_queue()`);
    const back = (await actualOrder(db)).filter((t) => tierOf(short(t)) === 3).map(short);
    const q = await one<{ q: boolean }>(db, `SELECT queue_at >= TIMESTAMPTZ '2000-01-01' AS q FROM task_dispatches WHERE task_id = 'auto:b05'`);
    // 回到後段的隊尾（先進先出）；沒有被當成插隊也沒有跑到別層
    return got === "auto:b05" && q.q && back[back.length - 1] === "b05" && back.length === NB;
  });

  // ---- 5. 里程碑一過，下一輪 rebalance 就反映 ----
  await c("promotion_reflected", async () => {
    await setToday(db, "2026-11-18"); // 公報上架日：個案降級解除，回到前段
    await db.exec(`UPDATE task_dispatches SET queue_at = queue_at WHERE false`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const t = await tiersOf(db, ALL);
    const hasNew = allTierIs(t, M_IDS, 1) && allTierIs(t, F_IDS, 1) && allTierIs(t, N_IDS, 2) && allTierIs(t, B_IDS, 3);
    // seed 結束時 rebalance 已經依新的層交錯（對照：把現在的狀態餵給獨立算法，再 rebalance 一次應該不變）
    const want = await oracleNow(db);
    await db.exec(`SELECT rebalance_queue()`);
    const got = await actualOrder(db);
    // 出生時的層不變（m 出生在中段）、現在的層是前段
    const born = await one<{ p: number; now: number }>(db, `SELECT (opened_by->>'priority')::int AS p, priority::int AS now FROM task_dispatches WHERE task_id = 'auto:m01'`);
    return hasNew && JSON.stringify(got) === JSON.stringify(want) && born.p === 2 && born.now === 1;
  });
  await c("later_tiers_by_date", async () => {
    await setToday(db, "2026-11-29"); // 投票後：2026 的前段任務落到預設層（中段）
    await db.exec(`SELECT seed_auto_task_queue()`);
    const a = await tiersOf(db, ALL);
    await setToday(db, "2027-05-27");
    await db.exec(`SELECT seed_auto_task_queue()`);
    const b = await tiersOf(db, ALL);
    await setToday(db, "2027-05-28"); // 投票後 181 天：2026 也成了歷史補資料（後段）
    await db.exec(`SELECT seed_auto_task_queue()`);
    const d = await tiersOf(db, ALL);
    const want = await oracleNow(db);
    const got = await actualOrder(db);
    return allTierIs(a, [...F_IDS, ...M_IDS, ...N_IDS], 2) && allTierIs(a, B_IDS, 3) && allTierIs(b, [...F_IDS, ...M_IDS, ...N_IDS], 2) &&
      allTierIs(d, [...F_IDS, ...M_IDS], 3) && allTierIs(d, N_IDS, 2) && allTierIs(d, B_IDS, 3) && JSON.stringify(got) === JSON.stringify(want);
  });
  await setToday(db, "2026-10-08");
  await db.exec(`SELECT seed_auto_task_queue()`);

  // ---- 6. 記錄：換層後現在的層變、出生時的層不變；缺口補上＝closed 事件帶出生時的層 ----
  await c("closed_event_keeps_birth_priority", async () => {
    // 先升到前段（公報日），再補上 m01：closed 事件的 priority 是出生時的 2，不是現在的 1
    await setToday(db, "2026-11-18");
    await db.exec(`SELECT seed_auto_task_queue()`);
    await db.exec(`DELETE FROM _b_raw WHERE task_id = 'auto:m01'`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const e = await rows<{ event: string; priority: number | null; reason: string }>(db, `SELECT event, priority::int, reason FROM gap_events WHERE task_id = 'auto:m01' ORDER BY id`);
    await setToday(db, "2026-10-08");
    await db.exec(`INSERT INTO _b_raw (task_id, task_type, target, what_we_need, hint_sources, reward, region) VALUES ('auto:m01', 'policy_missing', '{"election_id":2026,"election_type":"縣市議員"}', '說明 m01', ARRAY['h'], 1, '台北市')`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const e2 = await rows<{ event: string; priority: number | null }>(db, `SELECT event, priority::int FROM gap_events WHERE task_id = 'auto:m01' ORDER BY id`);
    // 又出現＝reopened，帶重新出生那一天的層（2026-10-08＝中段）
    return e.length === 2 && e[0].event === "opened" && e[0].priority === 2 && e[1].event === "closed" && e[1].priority === 2 &&
      e2.length === 3 && e2[2].event === "reopened" && e2[2].priority === 2;
  });

  // ---- 7. 規則值是資料：改種子表，結果跟著變 ----
  await c("weights_are_data", async () => {
    await db.exec(`UPDATE task_priority_tiers SET weight = 1`); // 三層一樣重：輪流
    const want = await oracleNow(db);
    await db.exec(`SELECT rebalance_queue()`);
    const got = await actualOrder(db);
    const head = got.slice(0, 6).map((t) => tierOf(short(t)));
    await db.exec(`UPDATE task_priority_tiers SET weight = CASE id WHEN 1 THEN 6 WHEN 2 THEN 3 ELSE 1 END`);
    await db.exec(`SELECT rebalance_queue()`);
    return JSON.stringify(got) === JSON.stringify(want) && JSON.stringify(head) === JSON.stringify([1, 2, 3, 1, 2, 3]);
  });
  await c("rules_are_data", async () => {
    // 把降級那條規則改成後段：m 跟著換層；刪掉它：m 回到前段（通則）
    await db.exec(`UPDATE activity_rules SET priority = 3 WHERE activity = 'priority:raw:policy_missing'`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const a = await tiersOf(db, M_IDS);
    await db.exec(`DELETE FROM activity_rules WHERE activity = 'priority:raw:policy_missing'`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const b = await tiersOf(db, M_IDS);
    return allTierIs(a, M_IDS, 3) && allTierIs(b, M_IDS, 1);
  });
  await c("same_tier_equals_old_rebalance", async () => {
    // 沒有任何優先規則：每一列都是預設層，輸出與舊的 rebalance_queue（20260924000006）逐件相同——
    // 同一份狀態用交易回滾各跑一次，比任務順序與相對的排隊位置（起點取決於 now()，所以比相對差）
    await db.exec(`DELETE FROM activity_rules WHERE priority IS NOT NULL`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    await db.exec(`CREATE OR REPLACE FUNCTION rebalance_queue_old() RETURNS INTEGER ${OLD_REBALANCE.slice(OLD_REBALANCE.indexOf("LANGUAGE plpgsql"))}`);
    await db.exec(`INSERT INTO contributions (id, status, contribution_type, task_id, created_at) SELECT gen_random_uuid(), 'pending', 'policy', NULL, now() FROM generate_series(1, 7)`);
    await db.exec(`SELECT seed_auto_task_queue()`); // 驗證列進來
    await db.exec(`UPDATE task_dispatches SET cooling = true WHERE task_id IN ('auto:f03', 'auto:b04')`); // 不可派的任務也要一樣
    const snap = async (fn: string) => {
      await db.exec("BEGIN");
      await db.exec(`SELECT ${fn}()`);
      const r = await rows<{ task_id: string; rel: number }>(db, `SELECT task_id, extract(epoch from queue_at - (SELECT min(queue_at) FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01'))::float8 AS rel
                                                                    FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01' ORDER BY queue_at, task_id COLLATE "C"`);
      await db.exec("ROLLBACK");
      return r;
    };
    const a = await snap("rebalance_queue");
    const b = await snap("rebalance_queue_old");
    await db.exec(`UPDATE task_dispatches SET cooling = false`);
    return a.length > 20 && JSON.stringify(a) === JSON.stringify(b);
  });
  return v;
}

Deno.test("B1 行為層：優先層、加權交錯、不餓死、2:1、插隊、換層、記錄、規則值是資料（每條都要綠）", async () => {
  const db = await buildDb();
  const v = await runSuite(db);
  const red = GUARDS.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門沒過：${red.join("、")}`);
  await db.close();
});

// ------------------------------------------------------------
// 還原驗證：把 migration 文字精確改壞一處，對應的守門必須紅（改不到、改到兩處都算失敗）
// ------------------------------------------------------------
type Mut = { name: string; breaks: (typeof GUARDS[number])[]; edit: (s: string) => string };
const MUTATIONS: Mut[] = [
  { name: "rebalance 不看權重（嚴格優先：前段全走完才輪到中段、後段）", breaks: ["weave_matches_oracle", "pattern_6_3_1", "rounds_weave_each_block", "no_starvation", "weights_are_data"],
    edit: (s) => mutate(s, "ORDER BY k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier, k.queue_at, k.task_id) - 1 AS rn", "ORDER BY k.tier, k.queue_at, k.task_id) - 1 AS rn") },
  { name: "rebalance 不看層（回到單一先進先出）", breaks: ["weave_matches_oracle", "pattern_6_3_1", "rounds_weave_each_block", "fifo_within_tier", "no_starvation", "weights_are_data", "promotion_reflected", "later_tiers_by_date", "ratio_2_1"],
    edit: (s) => mutate(s, "ORDER BY k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier, k.queue_at, k.task_id) - 1 AS rn", "ORDER BY k.queue_at, k.task_id) - 1 AS rn") },
  { name: "rebalance 同一層內不照先進先出（照 task_id）", breaks: ["fifo_within_tier", "no_starvation", "boost_returns_to_its_tier_tail"],
    edit: (s) => mutate(s, "row_number() OVER (PARTITION BY w.tier ORDER BY w.queue_at, w.task_id) AS k", "row_number() OVER (PARTITION BY w.tier ORDER BY w.task_id) AS k") },
  { name: "rebalance 權重算反（k×權重）", breaks: ["weave_matches_oracle", "pattern_6_3_1", "rounds_weave_each_block", "ratio_2_1", "no_starvation"],
    edit: (s) => mutate(s, "k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier,", "k.k::NUMERIC * COALESCE(tw.weight, 1), k.tier,") },
  { name: "rebalance 同一個虛擬時間點層號大的先（前段不再先走）", breaks: ["weave_matches_oracle", "pattern_6_3_1", "ratio_2_1", "weights_are_data"],
    edit: (s) => mutate(s, "k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier, k.queue_at,", "k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier DESC, k.queue_at,") },
  { name: "rebalance 把插隊的也捲進交錯（拿掉 _ready 的 2000 年排除）", breaks: ["boost_stays_front", "boost_returns_to_its_tier_tail"],
    edit: (s) => mutate(s, "WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';", "WHERE true;") },
  { name: "rebalance 任務位置的間距改成 3 秒（驗證：任務不再是 2:1）", breaks: ["ratio_2_1", "same_tier_equals_old_rebalance"],
    edit: (s) => mutate(s, "SET queue_at = v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds' FROM t", "SET queue_at = v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '3 seconds' FROM t") },
  { name: "seed 不更新既有派工列的層（過了里程碑沒人換層）", breaks: ["promotion_reflected", "later_tiers_by_date", "rules_are_data"],
    edit: (s) => mutate(s, "UPDATE task_dispatches d SET priority = g.priority\n    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority IS DISTINCT FROM g.priority;", "PERFORM 1;") },
  { name: "seed 新增派工列時不寫 priority 欄（opened_by 有、派工列沒有，要等下一輪才歸位）", breaks: ["tiers_assigned", "weave_matches_oracle", "pattern_6_3_1"],
    edit: (s) => mutate(s, "'priority_rule_id', g.priority_rule_id)), g.priority\n    FROM _gaps g", "'priority_rule_id', g.priority_rule_id)), NULL\n    FROM _gaps g") },
  { name: "seed 的 opened_by 不帶出生時的層", breaks: ["opened_by_records_priority", "gap_events_priority_column", "closed_event_keeps_birth_priority"],
    edit: (s) => mutate(s, "g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id)), g.priority", "g.opened_by, g.priority") },
  { name: "seed 的 opened_by 不帶依據的規則", breaks: ["opened_by_records_priority"],
    edit: (s) => mutate(s, "jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id)), g.priority", "jsonb_build_object('priority', g.priority)), g.priority") },
  { name: "seed 算層時不傳職位（個案降級對不到職位）", breaks: ["tiers_assigned", "opened_by_records_priority", "weave_matches_oracle"],
    edit: (s) => mutate(s, "CROSS JOIN LATERAL activity_priority(k.arm, k.eid, k.etype) x", "CROSS JOIN LATERAL activity_priority(k.arm, k.eid, NULL) x") },
  { name: "seed 算層時不傳選舉（所有選舉的窗口都比不到）", breaks: ["tiers_assigned", "opened_by_records_priority", "weave_matches_oracle"],
    edit: (s) => mutate(s, "CROSS JOIN LATERAL activity_priority(k.arm, k.eid, k.etype) x", "CROSS JOIN LATERAL activity_priority(k.arm, NULL, k.etype) x") },
  { name: "activity_priority 同時相符取最小（個案降級永遠輸給通則）", breaks: ["priority_table", "demotion_beats_front", "tiers_assigned", "opened_by_records_priority", "weave_matches_oracle"],
    edit: (s) => mutate(s, "ORDER BY r.priority DESC, o.rule_id\n     LIMIT 1", "ORDER BY r.priority ASC, o.rule_id\n     LIMIT 1") },
  { name: "activity_priority 不看通則（priority:*）", breaks: ["priority_table", "tiers_assigned", "weave_matches_oracle", "pattern_6_3_1"],
    edit: (s) => mutate(s, "            UNION ALL SELECT * FROM activity_open('priority:*', p_election_id, p_election_type, p_today)) o", "            ) o") },
  { name: "activity_priority 不傳今天（窗口永遠用預設的今天，假時鐘以外的日期查不準）", breaks: ["priority_table"],
    edit: (s) => mutate(mutate(s, "activity_open('priority:' || p_activity, p_election_id, p_election_type, p_today)", "activity_open('priority:' || p_activity, p_election_id, p_election_type)"),
      "activity_open('priority:*', p_election_id, p_election_type, p_today)", "activity_open('priority:*', p_election_id, p_election_type)") },
  { name: "沒有相符規則時不回預設層（缺口沒有層）", breaks: ["priority_table", "tiers_assigned", "opened_by_records_priority", "gap_events_priority_column"],
    edit: (s) => mutate(s, "WHERE t.is_default AND NOT EXISTS (SELECT 1 FROM hit)", "WHERE false") },
  { name: "種子：公報前的個案降級規則種成前段（等於沒降級）", breaks: ["priority_table", "demotion_beats_front", "tiers_assigned", "opened_by_records_priority", "weave_matches_oracle", "closed_event_keeps_birth_priority"],
    edit: (s) => mutate(s, "'直轄市山地原住民區民代表', '村里長']::TEXT[], 2::SMALLINT,", "'直轄市山地原住民區民代表', '村里長']::TEXT[], 1::SMALLINT,") },
  { name: "種子：後段通則的起日改成投票日後 181 天以外（180 天）", breaks: ["priority_table", "later_tiers_by_date"],
    edit: (s) => mutate(s, "('priority:*', 'polling', 181, NULL, 0, NULL::TEXT[], 3::SMALLINT,", "('priority:*', 'polling', 180, NULL, 0, NULL::TEXT[], 3::SMALLINT,") },
  { name: "種子：前段通則的起日改成 -90", breaks: ["priority_table"],
    edit: (s) => mutate(s, "('priority:*', 'polling', -180, 'polling', 0, NULL::TEXT[], 1::SMALLINT,", "('priority:*', 'polling', -90, 'polling', 0, NULL::TEXT[], 1::SMALLINT,") },
  { name: "種子：權重改成 1:1:1（不再偏向前段）", breaks: ["pattern_6_3_1", "rounds_weave_each_block", "no_starvation", "ratio_2_1"],
    edit: (s) => mutate(mutate(mutate(s, "(1, '前段', 6, false,", "(1, '前段', 1, false,"), "(2, '中段', 3, true,", "(2, '中段', 1, true,"), "(3, '後段', 1, false,", "(3, '後段', 1, false,") },
  { name: "種子：後段權重 0 以外的最小值也拿掉（後段權重大於前段）", breaks: ["pattern_6_3_1", "rounds_weave_each_block", "no_starvation", "ratio_2_1"],
    edit: (s) => mutate(mutate(s, "(1, '前段', 6, false,", "(1, '前段', 1, false,"), "(3, '後段', 1, false,", "(3, '後段', 6, false,") },
  { name: "里程碑視圖不產生 bulletin_published（個案降級的座標沒有了）", breaks: ["bulletin_milestone", "priority_table", "demotion_beats_front", "tiers_assigned", "weave_matches_oracle", "opened_by_records_priority"],
    edit: (s) => mutate(s, "   WHERE e.bulletin_published_on IS NOT NULL\n     AND NOT EXISTS", "   WHERE false\n     AND NOT EXISTS") },
  { name: "里程碑視圖：表裡的整場 bulletin_published 不優先（重複兩列）", breaks: ["bulletin_milestone"],
    edit: (s) => mutate(s, "\n     AND NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL);", ";") },
  { name: "優先規則的活動名不必以 priority: 開頭（一般活動可以掛優先層，開關與排序混在一起）", breaks: ["namespace_and_open_unaffected"],
    edit: (s) => mutate(s, "CHECK ((activity LIKE 'priority:%') = (priority IS NOT NULL))", "CHECK (true)") },
  { name: "gap_events 沒有 priority 欄的生成式（讀錯 detail 鍵）", breaks: ["gap_events_priority_column", "closed_event_keeps_birth_priority"],
    edit: (s) => mutate(s, "COALESCE((detail->>'priority')::SMALLINT, (detail->'opened_by'->>'priority')::SMALLINT)", "(detail->>'tier')::SMALLINT") },
];

for (const m of MUTATIONS) {
  Deno.test(`B2 還原驗證：${m.name} → ${m.breaks.join("、")} 必須紅`, async () => {
    const db = await buildDb(m.edit);
    const v = await runSuite(db);
    const red = GUARDS.filter((g) => v[g] !== true);
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
    await db.close();
  });
}

Deno.test("B3 沒套這支 migration 的環境（只有 P0、P1）：守門跑不出「全綠」——測的是這支 migration 的東西", async () => {
  // buildDb(applyQP=false) 沒有 task_priority_tiers／activity_priority／priority 欄：runSuite 一開始就會壞掉，不能被當成通過
  const db = await buildDb((s) => s, false);
  let threw = false;
  try {
    const v = await runSuite(db);
    threw = GUARDS.some((g) => v[g] !== true);
  } catch {
    threw = true;
  }
  assert(threw, "沒有這支 migration 時守門竟然全綠");
  await db.close();
});
