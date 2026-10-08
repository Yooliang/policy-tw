/**
 * seed_auto_task_queue／rebalance_queue「內容沒變不重寫」（#465，migration 20261009040000_seed_skip_unchanged.sql）。
 *
 * 起因：每 10 分鐘的 seed 把約 8,000 列派工列整列重寫（正式庫唯讀實測：內容真的變了的是 0 列），加上 rebalance 的三段 UPDATE queue_at；
 * task_dispatches 累計 2,000 多萬次更新，HOT 只有約 15%。這支只加「真的有變才更新」的條件，結果（派工列、queue_at、gap_events）一個字都不能變。
 *
 * 守門分三半，只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）：
 *
 *   A. 文字層（不開資料庫）
 *      1. 這支是 seed_auto_task_queue、rebalance_queue 的最後一版，各自緊接著現行版（頁面流量提層、手動任務變一支臂）；只換這兩支函式，不動 schema、別的函式、觸發器
 *      2. seed 新定義＝現行定義＋一個條件（六個內容欄的列比較 IS DISTINCT FROM），其餘一字不差；rebalance 新定義＝現行定義＋三個「queue_at IS DISTINCT FROM 新值」
 *      3. 條件裡的欄位＝SET 的內容欄（有人往 SET 加欄位卻忘了加進條件，這條就紅）
 *      4. 沒有任何 TS／Vue／Edge Function 程式讀 task_dispatches.refreshed_at（refreshed_at 的語意因此可以改成「內容最後一次被改寫的時間」）
 *
 *   B. PGlite（行為層）：真的 P0／P1／優先層／P2×3／手動任務臂／流量提層／這支；改前的兩支函式以 _old 留在同一個資料庫
 *      同一個交易、同一個起點，各跑一次改前與改後的 seed，逐輪比：task_dispatches（除 refreshed_at）與 gap_events（除 id、at）完全相同；
 *      輪次含：第一次入列、什麼都沒變、六個內容欄各變一次（含 NULL↔值）、收回與新增、領走後重排、驗證列增減
 *      寫入量：什麼都沒變的一輪，內容 UPDATE 0 列（改前＝全部既有列）、refreshed_at 不動；只變 k 列就只寫那 k 列、refreshed_at 只動那 k 列；
 *      rebalance 沒有變動時 0 列寫入、領走後結果與改前逐件相同
 *   C. 每條守門都做還原驗證：把 migration 改壞一處（精確改一處，改不到就失敗），對應的檢查必須紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, type GapRow, migrationNames, mutate, readMig } from "./arms-pglite.ts";
import { buildSeedEnv, MIG, REBALANCE_BASE_MIG, SEED_BASE_MIG } from "./seed-skip-env.ts";

const MIG_SQL = await readMig(MIG);
const OLD_SEED = fnText(await readMig(SEED_BASE_MIG), "seed_auto_task_queue");
const OLD_REBALANCE = fnText(await readMig(REBALANCE_BASE_MIG), "rebalance_queue");
const NEW_SEED = fnText(MIG_SQL, "seed_auto_task_queue");
const NEW_REBALANCE = fnText(MIG_SQL, "rebalance_queue");

// ============================================================
// A. 文字層
// ============================================================
const SEED_OPEN = /  -- >>> 內容沒變不重寫[^\n]*\n/g;
const SEED_CLOSE = /  -- <<< 內容沒變不重寫\n/g;
const SEED_COND = /\n     AND \(d\.task_type, d\.target, d\.what_we_need, d\.hint_sources, d\.reward, d\.region\) IS DISTINCT FROM \(g\.task_type, g\.target, g\.what_we_need, g\.hint_sources, g\.reward, g\.region\);/g;
const REB_COND = /\n     AND d\.queue_at IS DISTINCT FROM [^\n]*?; -- #465：位置沒變的不重寫/g;

/** 改後的 seed 還原成改前：拿掉標記起訖與條件（條件原本接在分號前） */
const reverseSeed = (fn: string) => fn.replace(SEED_OPEN, "").replace(SEED_CLOSE, "").replace(SEED_COND, ";");
const reverseRebalance = (fn: string) => fn.replace(REB_COND, ";");
const isMechanicalSeed = (fn: string) => {
  try {
    return (fn.match(SEED_OPEN) ?? []).length === 1 && (fn.match(SEED_CLOSE) ?? []).length === 1 && (fn.match(SEED_COND) ?? []).length === 1 && reverseSeed(fn) === OLD_SEED;
  } catch {
    return false;
  }
};
const isMechanicalRebalance = (fn: string) => (fn.match(REB_COND) ?? []).length === 3 && reverseRebalance(fn) === OLD_REBALANCE;
const codeOf = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").replace(/'(?:[^']|'')*'/g, "''");

Deno.test("A1 這支是 seed_auto_task_queue、rebalance_queue 的最後一版，各自緊接著現行版；只換這兩支函式，不動 schema、別的函式、觸發器", async () => {
  for (const [fn, prev] of [["seed_auto_task_queue", SEED_BASE_MIG], ["rebalance_queue", REBALANCE_BASE_MIG]]) {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) defining.push(n);
    const i = defining.indexOf(MIG);
    assert(i > 0, `這支要在重新定義 ${fn} 的清單裡`);
    assertEquals(defining[i - 1], prev, `${fn} 的前一版應該是 ${prev}；有人在中間改了，要以那一版為底重做機械式替換`);
    assertEquals(defining.slice(i + 1), [], `這支之後又有人改了 ${fn}：後合併的以最新那版為底重做（並更新 activity-arms／queue-priority／activity-windows／page-traffic-boost／manual-open-arm 的 A1 清單）`);
  }
  const code = codeOf(MIG_SQL);
  assertEquals([...code.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?([a-z_]+)\(/g)].map((m) => m[1]), ["rebalance_queue", "seed_auto_task_queue"]);
  const outside = codeOf(MIG_SQL.replace(NEW_SEED, "").replace(NEW_REBALANCE, ""));
  assert(!/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE)\b/i.test(outside), "函式之外只有 COMMENT 與 NOTIFY：沒有 schema 變動（不建表、不改表、不動觸發器與索引）、不寫任何資料、不改授權");
  for (const untouched of ["contribution_auto_tasks_arms", "activity_priority", "queue_slot", "task_dispatched", "refresh_dispatch_blocked", "traffic_boost_apply", "manual_front_pull"]) {
    assert(!new RegExp(`CREATE OR REPLACE FUNCTION ${untouched}\\(`).test(code), `這支不改 ${untouched}`);
  }
});

Deno.test("A2 seed 新定義＝現行定義（頁面流量提層那支）＋一個條件（六個內容欄的列比較），其餘一字不差", () => {
  assert(isMechanicalSeed(NEW_SEED));
  // 優先層那句本來就有 IS DISTINCT FROM，沒有被動到；新增的條件只有一處，只在內容 UPDATE 裡
  assertEquals((NEW_SEED.match(/IS DISTINCT FROM/g) ?? []).length, (OLD_SEED.match(/IS DISTINCT FROM/g) ?? []).length + 1);
  const upd = NEW_SEED.slice(NEW_SEED.indexOf("UPDATE task_dispatches d SET task_type"), NEW_SEED.indexOf("-- <<< 內容沒變不重寫"));
  assert(upd.includes("refreshed_at = now()") && upd.includes("FROM _gaps g WHERE g.task_id = d.task_id"), "條件接在原本的 WHERE 後面（AND），不取代 task_id 的連接");
  assert(NEW_SEED.includes("PERFORM rebalance_queue();") && NEW_SEED.includes("RETURN v_new + v_verify;"));
});

Deno.test("A3 rebalance 新定義＝現行定義（手動任務變一支臂那支）＋三段 UPDATE 各一個「queue_at IS DISTINCT FROM 新值」，其餘一字不差", () => {
  assert(isMechanicalRebalance(NEW_REBALANCE));
  // 條件裡的新值運算式與 SET 的運算式是同一個字串（不然會「寫的是 A、比的是 B」）
  for (const m of NEW_REBALANCE.matchAll(/SET queue_at = ([^\n]*?) FROM (?:v|t|t2) WHERE d\.task_id = (?:v|t|t2)\.task_id\n     AND d\.queue_at IS DISTINCT FROM ([^\n]*?); -- #465/g)) {
    assertEquals(m[2], m[1], "比的運算式必須和寫的一樣");
  }
  assertEquals((NEW_REBALANCE.match(/SET queue_at = /g) ?? []).length, 3);
  assert(NEW_REBALANCE.includes("GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;") && NEW_REBALANCE.includes("RETURN v_n;"));
});

Deno.test("A4 還原驗證（文字層）：動 seed／rebalance 本體、少條件、多條件，A2／A3 都要紅", () => {
  assert(!isMechanicalSeed(mutate(NEW_SEED, "RETURN v_new + v_verify;", "RETURN v_new;")), "偷改回傳值");
  assert(!isMechanicalSeed(mutate(NEW_SEED, "AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)\n     AND EXISTS", "AND true\n     AND EXISTS")), "偷改收回條件");
  assert(!isMechanicalSeed(mutate(NEW_SEED, "  -- <<< 內容沒變不重寫\n", "")), "結束標記掉了");
  assert(!isMechanicalSeed(NEW_SEED.replace("  -- <<< 內容沒變不重寫\n", "  -- <<< 內容沒變不重寫\n  PERFORM 1;\n")), "區塊外多一行");
  assert(!isMechanicalSeed(mutate(NEW_SEED, "IS DISTINCT FROM (g.task_type", "<> (g.task_type")), "條件換運算子");
  assert(!isMechanicalSeed(mutate(NEW_SEED, ", d.reward, d.region) IS DISTINCT", ", d.reward) IS DISTINCT")), "少一個欄位");
  assert(!isMechanicalSeed(OLD_SEED), "改前本身不是改後");
  assert(!isMechanicalRebalance(OLD_REBALANCE), "改前本身不是改後");
  assert(!isMechanicalRebalance(mutate(NEW_REBALANCE, "RETURN v_n;", "RETURN 0;")), "偷改回傳值");
  assert(!isMechanicalRebalance(mutate(NEW_REBALANCE, "AND d.queue_at IS DISTINCT FROM v_start + v.rn * INTERVAL '1 second'; -- #465：位置沒變的不重寫", "; -- #465：位置沒變的不重寫")), "少一段");
  assert(!isMechanicalRebalance(mutate(NEW_REBALANCE, "ORDER BY queue_at, task_id) - 1 AS rn FROM task_dispatches\n     WHERE task_id LIKE 'verify:%'", "ORDER BY queue_at) - 1 AS rn FROM task_dispatches\n     WHERE task_id LIKE 'verify:%'")), "偷改排序");
});

Deno.test("A5 條件裡的欄位＝SET 的內容欄（往 SET 加欄位卻忘了加進條件，這條就紅）", () => {
  const set = /UPDATE task_dispatches d SET ([\s\S]*?), refreshed_at = now\(\)/.exec(NEW_SEED)![1].split(",").map((s) => s.trim());
  const setCols = set.map((s) => s.split(" = ")[0]);
  const [, left, right] = /AND \(([^)]*)\) IS DISTINCT FROM \(([^)]*)\);/.exec(NEW_SEED)!;
  assertEquals(left.split(",").map((s) => s.trim().replace(/^d\./, "")), setCols, "左邊（現有的列）＝SET 的欄位，順序也一樣");
  assertEquals(right.split(",").map((s) => s.trim().replace(/^g\./, "")), setCols, "右邊（新算的缺口）＝SET 的欄位");
  assertEquals(setCols, ["task_type", "target", "what_we_need", "hint_sources", "reward", "region"]);
  // SET 的右邊也都是同名欄位（task_type = g.task_type …），不是別的運算式
  for (const s of set) assertEquals(s.split(" = ")[1], `g.${s.split(" = ")[0]}`);
});

async function* walk(dir: URL, skip: (name: string) => boolean): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    if (skip(e.name)) continue;
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u, skip);
    else yield u;
  }
}

Deno.test("A6 沒有任何程式讀 task_dispatches.refreshed_at（TS／Vue／Edge Function／前端／腳本）：它的語意是「內容最後一次被改寫的時間」，不是「seed 最近掃過」", async () => {
  const root = new URL("../../../", import.meta.url);
  const hits: string[] = [];
  let scanned = 0;
  for (const d of ["supabase/functions", "lib", "composables", "pages", "components", "cloudflare", "scripts", "router", "stores", "utils"]) {
    let dir: URL;
    try {
      dir = new URL(d + "/", root);
      await Deno.stat(dir);
    } catch {
      continue;
    }
    for await (const f of walk(dir, (n) => n === "node_modules" || n === ".git")) {
      if (!/\.(ts|vue|mjs|js|cjs)$/.test(f.pathname) || /\.test\.ts$/.test(f.pathname) || /(seed-skip-(env|parity)|arms-pglite)\.ts$/.test(f.pathname)) continue;
      const src = await Deno.readTextFile(f);
      scanned++;
      if (/refreshed_at/.test(src) && /task_dispatches/.test(src)) hits.push(f.pathname);
    }
  }
  assert(scanned > 100, `掃到的檔案數太少（${scanned}），目錄清單可能走樣`);
  assertEquals(hits, [], "有程式同時提到 task_dispatches 與 refreshed_at：確認它沒有拿 refreshed_at 當新鮮度（每輪都更新的假設已不成立）");
});

// ============================================================
// B. PGlite
// ============================================================
type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];

const G = (id: string, type: string, target: Record<string, unknown> | null, extra: Partial<GapRow> = {}): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h"], reward: 1, region: "台北市", ...extra });
const E = (election_id: number, election_type: string, extra: Record<string, unknown> = {}) => ({ election_id, election_type, ...extra });

// 三層都有：dup、legacy、policy_elements 沒有選舉＝中段(2)；term_policies 2022＝後段(3)；roster_villages 2026 村里長＝前段(1)
const FIXTURE: Record<string, GapRow[]> = {
  dup: [
    G("dup1", "duplicate_politician", { a: 1 }),
    G("dup2", "duplicate_politician", { a: 2 }),
    G("dup3", "duplicate_politician", { a: 3 }),
    G("dup4", "duplicate_politician", null),
  ],
  term_policies: [
    G("tp1", "term_policy_missing", E(2022, "縣市議員", { politician_id: "p1" })),
    G("tp2", "term_policy_missing", E(2022, "縣市議員", { politician_id: "p2" })),
    G("tp3", "term_policy_missing", E(2022, "縣市議員", { politician_id: "p3" })),
  ],
  roster_villages: [
    G("rv1", "roster_check", E(2026, "村里長", { politician_id: "p4" })),
    G("rv2", "roster_check", E(2026, "村里長", { politician_id: "p5" })),
  ],
  legacy: [
    G("lg1", "legacy_policy_label", { politician_election_id: 11 }),
    G("lg2", "legacy_policy_label", { politician_election_id: 12 }, { region: null }),
    G("lg3", "legacy_policy_label", { politician_election_id: 13 }, { region: null }),
  ],
  policy_elements: [
    G("pe1", "policy_element_missing", { policy_id: "x1" }),
    G("pe2", "policy_element_missing", { policy_id: "x2" }),
  ],
};
const GAP_COUNT = Object.values(FIXTURE).reduce((n, r) => n + r.length, 0);

/** 改前與改後的結果比對用：派工列（除 refreshed_at）與 gap_events（除 id、at）。同一個交易 now() 一樣，queue_at 比得起來 */
const snap = async (db: Db): Promise<string> =>
  (await one<{ j: string }>(
    db,
    `SELECT (SELECT coalesce(jsonb_agg(to_jsonb(t) - 'refreshed_at' ORDER BY t.task_id), '[]') FROM task_dispatches t)::text
         || (SELECT coalesce(jsonb_agg(to_jsonb(e) - 'id' - 'at' ORDER BY e.task_id, e.event, coalesce(e.reason, ''), e.id), '[]') FROM gap_events e)::text AS j`,
  )).j;

const PAST = "2026-10-01 00:00:00+00";
type Writes = { total: number; content: string[]; moved: string[]; queue: number };
/** 跑一個動作，回報 task_dispatches 被 UPDATE 了幾列（含「寫了但值一樣」的）、內容欄真的變的列、refreshed_at 動了的列、queue_at 真的變的列數 */
async function measured(db: Db, f: () => Promise<unknown>): Promise<Writes> {
  await db.exec(`UPDATE task_dispatches SET refreshed_at = TIMESTAMPTZ '${PAST}'; TRUNCATE _upd`);
  await f();
  const r = await rows<{ task_id: string; content: boolean; qat: boolean; refr: boolean }>(db, `SELECT task_id, content, qat, refr FROM _upd`);
  return {
    total: r.length,
    content: r.filter((x) => x.content).map((x) => x.task_id).sort(),
    moved: r.filter((x) => x.refr).map((x) => x.task_id).sort(),
    queue: r.filter((x) => x.qat).length,
  };
}

const COUNTER = `
  CREATE TABLE _upd (task_id text, content boolean, qat boolean, refr boolean);
  CREATE FUNCTION _upd_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO _upd VALUES (NEW.task_id,
      (OLD.task_type, OLD.target, OLD.what_we_need, OLD.hint_sources, OLD.reward, OLD.region) IS DISTINCT FROM (NEW.task_type, NEW.target, NEW.what_we_need, NEW.hint_sources, NEW.reward, NEW.region),
      OLD.queue_at IS DISTINCT FROM NEW.queue_at, OLD.refreshed_at IS DISTINCT FROM NEW.refreshed_at);
    RETURN NEW; END $$;
  CREATE TRIGGER _upd_log AFTER UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION _upd_log();`;

type Scenario = {
  /** 每一輪改前改後結果是否相同 */
  parity: boolean[];
  /** 第 2 輪（什麼都沒變）：改前、改後各寫了幾列 */
  idle: { old: Writes; neu: Writes; neuMovedAll: boolean };
  /** 第 3 輪（9 列內容變了）：改後寫的內容列、refreshed_at 動的列，以及應該變的列 */
  edit: { old: Writes; neu: Writes; want: string[]; values: Record<string, unknown>; lg3Untouched: boolean };
  /** 第 7 輪（領走後）：rebalance 單獨跑 */
  rebalance: { idleNeu: { n: number; w: Writes }; idleOld: { n: number; w: Writes }; idleSame: boolean; dispatchSame: boolean; dispatchNew: Writes; dispatchOld: Writes };
  /** 回傳值 */
  returns: { same: boolean };
};

async function scenario(db: Db): Promise<Scenario> {
  const parity: boolean[] = [];
  /** 同一個起點各跑一次改前與改後，比結果；回傳兩邊各自的寫入量。之後的狀態是「改後」的 */
  async function round(label: string, setup = ""): Promise<{ old: Writes; neu: Writes; retSame: boolean }> {
    if (setup) await db.exec(setup);
    await db.exec("SAVEPOINT r");
    let oldSnap = "";
    let oldRet = -1;
    const old = await measured(db, async () => {
      oldRet = (await one<{ v: number }>(db, `SELECT seed_auto_task_queue_old() AS v`)).v;
      oldSnap = await snap(db);
    });
    await db.exec("ROLLBACK TO r");
    let newRet = -2;
    const neu = await measured(db, async () => {
      newRet = (await one<{ v: number }>(db, `SELECT seed_auto_task_queue() AS v`)).v;
    });
    const newSnap = await snap(db);
    parity.push(oldSnap === newSnap);
    if (oldSnap !== newSnap) console.error(`[parity] 第 ${label} 輪改前改後不同`);
    return { old, neu, retSame: oldRet === newRet };
  }
  const retSames: boolean[] = [];
  const track = async (label: string, setup?: string) => {
    const r = await round(label, setup);
    retSames.push(r.retSame);
    return r;
  };

  // 驗證列：四筆待驗證貢獻
  await db.exec(`INSERT INTO contributions (id, status, contribution_type, task_id, created_at) VALUES
    ('00000000-0000-4000-8000-000000000001', 'pending', 'correction', NULL, now()), ('00000000-0000-4000-8000-000000000002', 'pending', 'correction', NULL, now()),
    ('00000000-0000-4000-8000-000000000003', 'pending', 'correction', NULL, now()), ('00000000-0000-4000-8000-000000000004', 'pending', 'correction', NULL, now())`);

  // 0. 第一次入列（全是新缺口）
  await track("0 第一次入列");
  // 1. 什麼都沒變（第二次起的常態）
  const idleR = await track("1 什麼都沒變");
  const idleNeu = idleR.neu;
  const moved1 = idleNeu.moved.length;
  // 2. 又一輪什麼都沒變（改前改後都已穩定）
  await track("2 又一輪");
  // 3. 內容變了：六個欄位各一次、含 NULL↔值（dup1 task_type、dup2 target、dup3 what_we_need、tp1 hint_sources、tp2 reward、lg1 region 值→NULL、lg2 region NULL→值、dup4 target NULL→值、rv1 hint_sources 順序）
  const edited = ["dup1", "dup2", "dup3", "dup4", "tp1", "tp2", "lg1", "lg2", "rv1"].map((s) => `auto:${s}`).sort();
  const editR = await track(
    "3 六欄各變",
    `UPDATE _b_dup SET task_type = 'duplicate_politician_v2' WHERE task_id = 'auto:dup1';
     UPDATE _b_dup SET target = '{"a": 22}'::jsonb WHERE task_id = 'auto:dup2';
     UPDATE _b_dup SET what_we_need = '改過的說明' WHERE task_id = 'auto:dup3';
     UPDATE _b_dup SET target = '{"a": 4}'::jsonb WHERE task_id = 'auto:dup4';
     UPDATE _b_term_policies SET hint_sources = ARRAY['h', 'h2'] WHERE task_id = 'auto:tp1';
     UPDATE _b_term_policies SET reward = 2 WHERE task_id = 'auto:tp2';
     UPDATE _b_legacy SET region = NULL WHERE task_id = 'auto:lg1';
     UPDATE _b_legacy SET region = '高雄市' WHERE task_id = 'auto:lg2';
     UPDATE _b_roster_villages SET hint_sources = ARRAY['h', 'a'] WHERE task_id = 'auto:rv1'`,
  );
  const vals = await one<Record<string, unknown>>(
    db,
    `SELECT (SELECT task_type FROM task_dispatches WHERE task_id = 'auto:dup1') AS dup1_type, (SELECT target->>'a' FROM task_dispatches WHERE task_id = 'auto:dup2') AS dup2_a,
            (SELECT what_we_need FROM task_dispatches WHERE task_id = 'auto:dup3') AS dup3_need, (SELECT target->>'a' FROM task_dispatches WHERE task_id = 'auto:dup4') AS dup4_a,
            (SELECT hint_sources::text FROM task_dispatches WHERE task_id = 'auto:tp1') AS tp1_hint, (SELECT reward FROM task_dispatches WHERE task_id = 'auto:tp2') AS tp2_reward,
            (SELECT region FROM task_dispatches WHERE task_id = 'auto:lg1') AS lg1_region, (SELECT region FROM task_dispatches WHERE task_id = 'auto:lg2') AS lg2_region,
            (SELECT hint_sources::text FROM task_dispatches WHERE task_id = 'auto:rv1') AS rv1_hint`,
  );
  const lg3 = (await measured(db, async () => { await db.exec(`SELECT seed_auto_task_queue()`); })).content.includes("auto:lg3");
  // 4. 收回與新增
  await track("4 收回與新增", `DELETE FROM _b_dup WHERE task_id = 'auto:dup1'; DELETE FROM _b_term_policies WHERE task_id = 'auto:tp2';
    INSERT INTO _b_policy_elements VALUES ('auto:pe9', 'policy_element_missing', '{"policy_id": "x9"}', '說明 pe9', ARRAY['h'], 1, '台北市');
    INSERT INTO _b_roster_villages VALUES ('auto:rv9', 'roster_check', '{"election_id": 2026, "election_type": "村里長", "politician_id": "p9"}', '說明 rv9', ARRAY['h'], 1, '台北市')`);
  // 5. 領走三筆（排回隊尾）後 seed
  const top = (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:%' ORDER BY queue_at, task_id LIMIT 3`)).map((r) => r.task_id);
  await db.exec(`SELECT task_dispatched('${top[0]}'), task_dispatched('${top[1]}'), task_dispatched('${top[2]}')`);
  await track("5 領走三筆");
  // 6. 驗證列增減：多兩筆待驗證、一筆已定案
  await track("6 驗證列增減", `INSERT INTO contributions (id, status, contribution_type, task_id, created_at) VALUES
    ('00000000-0000-4000-8000-000000000005', 'pending', 'correction', NULL, now()), ('00000000-0000-4000-8000-000000000006', 'pending', 'correction', NULL, now());
    UPDATE contributions SET status = 'verified' WHERE id = '00000000-0000-4000-8000-000000000001'`);

  // 7. rebalance 單獨跑：沒有變動時 0 列；領走後與改前相同
  await db.exec("SAVEPOINT rb");
  const idleOld: { n: number; w: Writes } = { n: -1, w: { total: 0, content: [], moved: [], queue: 0 } };
  idleOld.w = await measured(db, async () => { idleOld.n = (await one<{ v: number }>(db, `SELECT rebalance_queue_old() AS v`)).v; });
  const idleOldSnap = await snap(db);
  await db.exec("ROLLBACK TO rb");
  const idleNeuR: { n: number; w: Writes } = { n: -1, w: { total: 0, content: [], moved: [], queue: 0 } };
  idleNeuR.w = await measured(db, async () => { idleNeuR.n = (await one<{ v: number }>(db, `SELECT rebalance_queue() AS v`)).v; });
  const idleNeuSnap = await snap(db);
  // 領走兩筆（任務與已經排好的隊伍錯開），再各重排一次
  const heads = (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:%' ORDER BY queue_at, task_id LIMIT 2`)).map((r) => r.task_id);
  await db.exec(`SELECT task_dispatched('${heads[0]}'), task_dispatched('${heads[1]}')`);
  await db.exec("SAVEPOINT rb2");
  let dOldSnap = "";
  const dOld = await measured(db, async () => { await db.exec(`SELECT rebalance_queue_old()`); dOldSnap = await snap(db); });
  await db.exec("ROLLBACK TO rb2");
  const dNew = await measured(db, async () => { await db.exec(`SELECT rebalance_queue()`); });
  const dNewSnap = await snap(db);

  return {
    parity,
    idle: { old: idleR.old, neu: idleNeu, neuMovedAll: moved1 === 0 },
    edit: { old: editR.old, neu: editR.neu, want: edited, values: vals, lg3Untouched: !lg3 },
    rebalance: { idleNeu: idleNeuR, idleOld, idleSame: idleOldSnap === idleNeuSnap, dispatchSame: dOldSnap === dNewSnap, dispatchNew: dNew, dispatchOld: dOld },
    returns: { same: retSames.every(Boolean) },
  };
}

type Verdicts = Record<string, boolean>;
const GUARDS = [
  "parity_all_rounds", "return_values_same", "idle_seed_writes_nothing", "idle_seed_keeps_refreshed_at", "changed_rows_only", "changed_rows_refreshed",
  "each_column_applied", "null_transitions", "unchanged_null_not_written", "rebalance_idle_writes_nothing", "rebalance_idle_result_same", "rebalance_after_dispatch_same",
  "rebalance_fewer_writes", "old_baseline_rewrites_all",
] as const;

async function runSuite(mutateMig?: (s: string) => string, skipMig = false): Promise<Verdicts> {
  const db = await buildSeedEnv({ branches: FIXTURE, mutateMig, skipMig });
  await db.exec(COUNTER);
  await db.exec("BEGIN");
  let sc: Scenario;
  try {
    sc = await scenario(db);
  } finally {
    await db.exec("ROLLBACK");
  }
  const { idle, edit, rebalance } = sc;
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const v = edit.values;
  const rbRows = rebalance.idleOld.w.total;
  await db.close();
  return {
    parity_all_rounds: sc.parity.length === 7 && sc.parity.every(Boolean),
    return_values_same: sc.returns.same,
    // 什麼都沒變的一輪：內容列 0 寫入（改前＝全部既有列都被 UPDATE 一次）
    idle_seed_writes_nothing: idle.neu.total === 0,
    idle_seed_keeps_refreshed_at: idle.neuMovedAll,
    // 只變 9 列：只寫那 9 列，refreshed_at 只動那 9 列
    changed_rows_only: eq(edit.neu.content, edit.want),
    changed_rows_refreshed: eq(edit.neu.moved, edit.want),
    each_column_applied: v.dup1_type === "duplicate_politician_v2" && v.dup2_a === "22" && v.dup3_need === "改過的說明" && v.tp1_hint === "{h,h2}" && v.tp2_reward === 2 && v.rv1_hint === "{h,a}" && v.dup4_a === "4",
    null_transitions: v.lg1_region === null && v.lg2_region === "高雄市" && edit.neu.content.includes("auto:lg1") && edit.neu.content.includes("auto:lg2") && edit.neu.content.includes("auto:dup4"),
    unchanged_null_not_written: edit.lg3Untouched,
    // rebalance
    rebalance_idle_writes_nothing: rebalance.idleNeu.n === 0 && rebalance.idleNeu.w.total === 0,
    rebalance_idle_result_same: rebalance.idleSame,
    rebalance_after_dispatch_same: rebalance.dispatchSame,
    rebalance_fewer_writes: rebalance.dispatchNew.total <= rebalance.dispatchOld.total && rebalance.dispatchNew.total === rebalance.dispatchNew.queue,
    // 基準線：改前的版本確實每輪把所有既有列都 UPDATE 一次（這條不紅，上面「沒寫」就可能只是什麼都沒量到）
    old_baseline_rewrites_all: idle.old.content.length === 0 && idle.old.total >= GAP_COUNT && rbRows >= GAP_COUNT,
  };
}

const MUTATIONS: Record<string, { mutate: (s: string) => string; red: (typeof GUARDS[number])[] }> = {
  // 拿掉 seed 的條件：內容沒變的列又被整列重寫
  no_seed_condition: {
    mutate: (s) => mutate(s, "\n     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region);", ";"),
    red: ["idle_seed_writes_nothing", "idle_seed_keeps_refreshed_at", "changed_rows_refreshed"],
  },
  // 換成 <>：NULL 參與的比較變 NULL，region NULL→值 不會被更新
  not_equal_operator: {
    mutate: (s) => mutate(s, "IS DISTINCT FROM (g.task_type", "<> (g.task_type"),
    red: ["null_transitions", "parity_all_rounds"],
  },
  // 條件少一個欄位
  no_region: {
    mutate: (s) => mutate(mutate(s, ", d.reward, d.region) IS DISTINCT FROM", ", d.reward) IS DISTINCT FROM"), ", g.reward, g.region);", ", g.reward);"),
    red: ["null_transitions", "parity_all_rounds", "changed_rows_only"],
  },
  no_hint_sources: {
    mutate: (s) => mutate(mutate(s, "d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT", "d.what_we_need, d.reward, d.region) IS DISTINCT"), "g.what_we_need, g.hint_sources, g.reward, g.region);", "g.what_we_need, g.reward, g.region);"),
    red: ["each_column_applied", "parity_all_rounds"],
  },
  no_target: {
    mutate: (s) => mutate(mutate(s, "(d.task_type, d.target, d.what_we_need", "(d.task_type, d.what_we_need"), "(g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region);", "(g.task_type, g.what_we_need, g.hint_sources, g.reward, g.region);"),
    red: ["each_column_applied", "null_transitions", "parity_all_rounds"],
  },
  // refreshed_at 不再更新（沒人讀，但語意要對：內容改了就動）
  refreshed_at_never_moves: {
    mutate: (s) => mutate(s, "hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()\n    FROM _gaps g WHERE g.task_id = d.task_id\n     AND", "hint_sources = g.hint_sources, reward = g.reward, region = g.region\n    FROM _gaps g WHERE g.task_id = d.task_id\n     AND"),
    red: ["changed_rows_refreshed"],
  },
  // 拿掉 rebalance 的三個條件：沒變動也整批重寫
  no_rebalance_conditions: {
    mutate: (s) => s.replace(REB_COND, ";"),
    red: ["rebalance_idle_writes_nothing", "rebalance_fewer_writes"],
  },
  // rebalance 條件寫反：變了的列反而不寫
  rebalance_inverted: {
    mutate: (s) => s.replaceAll("AND d.queue_at IS DISTINCT FROM v_start", "AND d.queue_at IS NOT DISTINCT FROM v_start"),
    red: ["rebalance_after_dispatch_same", "parity_all_rounds"],
  },
  // 只守第一段（驗證列），任務兩段沒守
  rebalance_only_verify: {
    mutate: (s) =>
      mutate(
        mutate(s, "\n     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫", ";"),
        "\n     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫", ";",
      ),
    red: ["rebalance_idle_writes_nothing", "rebalance_fewer_writes"],
  },
};

let BASELINE: Verdicts | undefined;
const baseline = async () => (BASELINE ??= await runSuite());

Deno.test("B1 行為層：改前改後逐輪相同（派工列、queue_at、gap_events）、沒變的列不寫、變了的列才寫、rebalance 沒變動時不寫", async () => {
  const v = await baseline();
  for (const g of GUARDS) assert(v[g], `守門 ${g} 應該是綠的`);
  assertEquals(Object.keys(v).sort(), [...GUARDS].sort());
});

Deno.test("B2 基準線：沒套這支 migration（改前的函式）時，「沒變不寫」的守門會紅、parity 與基準線守門是綠的", async () => {
  const v = await runSuite(undefined, true);
  assert(v.parity_all_rounds && v.return_values_same && v.rebalance_idle_result_same && v.rebalance_after_dispatch_same && v.old_baseline_rewrites_all, "改前＝改前：parity 與基準線是綠的");
  assert(v.each_column_applied && v.null_transitions && v.unchanged_null_not_written, "改前每一欄都會更新");
  for (const g of ["idle_seed_writes_nothing", "idle_seed_keeps_refreshed_at", "changed_rows_refreshed", "rebalance_idle_writes_nothing"] as const) assert(!v[g], `改前版本在 ${g} 應該是紅的（不然這條守門什麼都驗不出來）`);
});

for (const [name, m] of Object.entries(MUTATIONS)) {
  Deno.test(`C 還原驗證（行為層）：${name} → ${m.red.join("、")} 要紅`, async () => {
    const v = await runSuite(m.mutate);
    for (const g of m.red) assert(!v[g], `${name} 之後守門 ${g} 應該是紅的`);
    // 其他不相關的守門不該一起紅（指到對的原因）：基準線與回傳值永遠不受影響
    assert(v.old_baseline_rewrites_all, "基準線不受影響");
  });
}
