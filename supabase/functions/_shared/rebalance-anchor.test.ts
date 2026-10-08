/**
 * rebalance_queue 沒有待驗證列時起點不漂移（#490，migration 20261009150000_rebalance_anchor_no_drift.sql）。
 *
 * 起因：v_start 取整張表 MIN(queue_at)。有驗證列時隊頭是驗證列（排在 v_start），MIN 就是 v_start；
 * 一筆驗證列都沒有時隊頭是任務列（排在 v_start＋1.5 秒），下一輪 MIN 變大，整條隊伍每輪往後漂 1.5 秒，#465 的「位置沒變不寫」省不到。
 * 修法：沒有任何驗證列時，起點從隊頭退回 1.5 秒。有驗證列時一個字不變。
 *
 *   A. 文字層：這支是 rebalance_queue 的最後一版，緊接 #465 那版；新定義＝#465 的定義＋一個 #490 區塊，其餘一字不差
 *   B. PGlite：零驗證列、什麼都沒變，連跑多輪 rebalance，後面每輪 0 列被改寫、queue_at 不變；1970／1980 年段不影響起點；
 *      有驗證列時與改前逐輪相同（含領走後）；改前的版本在零驗證列時確實會漂（基準線）
 *   C. 還原驗證：拿掉 #490 區塊，B 的零驗證列守門要紅，有驗證列的守門不受影響
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, type GapRow, migrationNames, mutate, readMig } from "./arms-pglite.ts";
import { buildSeedEnv, MIG as SKIP_MIG } from "./seed-skip-env.ts";

const MIG = "20261009150000_rebalance_anchor_no_drift.sql";
const MIG_SQL = await readMig(MIG);
const OLD_REBALANCE = fnText(await readMig(SKIP_MIG), "rebalance_queue");
const NEW_REBALANCE = fnText(MIG_SQL, "rebalance_queue");

const BLOCK = /  -- >>> #490[^\n]*\n[\s\S]*?  -- <<< #490\n/g;
const isMechanical = (fn: string) => (fn.match(BLOCK) ?? []).length === 1 && fn.replace(BLOCK, "") === OLD_REBALANCE;

Deno.test("A1 這支是 rebalance_queue 的最後一版，緊接 #465（20261009040000）；只換這一支函式，沒有 schema 變動", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION rebalance_queue(")) defining.push(n);
  const i = defining.indexOf(MIG);
  assert(i > 0);
  assertEquals(defining[i - 1], SKIP_MIG, "前一版應該是 #465；有人在中間改了，要以那一版為底重做");
  assertEquals(defining.slice(i + 1), [], "這支之後又有人改了 rebalance_queue：後合併的以最新那版為底重做（並更新各測試的 A1 清單）");
  const code = MIG_SQL.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").replace(/'(?:[^']|'')*'/g, "''");
  assertEquals([...code.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?([a-z_]+)\(/g)].map((m) => m[1]), ["rebalance_queue"]);
  const outside = code.replace(/CREATE OR REPLACE FUNCTION rebalance_queue\(\)[\s\S]*?\n\$\$;/, "");
  assert(!/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE)\b/i.test(outside), "函式之外只有 COMMENT 與 NOTIFY");
});

Deno.test("A2 新定義＝#465 的定義＋一個 #490 區塊（起點退回 1.5 秒），其餘一字不差；2:1 間距、優先層、1970／1980 排除條件都在", () => {
  assert(isMechanical(NEW_REBALANCE));
  assert(!isMechanical(OLD_REBALANCE));
  assert(NEW_REBALANCE.includes("INTERVAL '1 second'") && NEW_REBALANCE.includes("INTERVAL '2 seconds'") && NEW_REBALANCE.includes("INTERVAL '1.5 seconds' + t.rn"));
  assert(!isMechanical(mutate(NEW_REBALANCE, "RETURN v_n;", "RETURN 0;")), "偷改回傳值");
  assert(!isMechanical(mutate(NEW_REBALANCE, "ORDER BY k.k::NUMERIC", "ORDER BY k.tier, k.k::NUMERIC")), "偷改優先層排序");
});

// ============================================================
// B. PGlite
// ============================================================
type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string): Promise<T> => (await rows<T>(db, sql))[0];
const G = (id: string, type: string, target: Record<string, unknown> | null, extra: Partial<GapRow> = {}): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h"], reward: 1, region: "台北市", ...extra });
const FIXTURE: Record<string, GapRow[]> = {
  dup: [1, 2, 3, 4, 5].map((n) => G(`dup${n}`, "duplicate_politician", { a: n })),
  term_policies: [1, 2, 3].map((n) => G(`tp${n}`, "term_policy_missing", { election_id: 2022, election_type: "縣市議員", politician_id: `p${n}` })),
  roster_villages: [1, 2].map((n) => G(`rv${n}`, "roster_check", { election_id: 2026, election_type: "村里長", politician_id: `v${n}` })),
};

const COUNTER = `
  CREATE TABLE _moved (task_id text);
  CREATE FUNCTION _moved_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.queue_at IS DISTINCT FROM NEW.queue_at THEN INSERT INTO _moved VALUES (NEW.task_id); END IF; RETURN NEW; END $$;
  CREATE TRIGGER _moved_log AFTER UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION _moved_log();`;
const snapQ = `SELECT coalesce(jsonb_agg(jsonb_build_array(task_id, queue_at) ORDER BY task_id), '[]')::text AS j FROM task_dispatches`;
const minQ = `SELECT min(queue_at)::text AS m FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01'`;
const orderQ = `SELECT task_id FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01' ORDER BY queue_at, task_id`;

async function movedBy(db: Db, f: () => Promise<unknown>): Promise<number> {
  await db.exec("TRUNCATE _moved");
  await f();
  return (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM _moved")).n;
}

type Verdicts = Record<string, boolean>;
const GUARDS = [
  "zero_verify_idle_writes_nothing", "zero_verify_anchor_stable", "zero_verify_order_kept", "manual_slots_untouched",
  "with_verify_same_as_before", "with_verify_after_claim_same", "baseline_before_drifts",
] as const;

async function runSuite(mig?: (s: string) => string): Promise<Verdicts> {
  const v: Partial<Verdicts> = {};
  const db = await buildSeedEnv({ branches: FIXTURE });
  // 改前（#465 版）留成 _prev，之後用 rebalance_queue（新）或 rebalance_queue_prev 各跑一次
  await db.exec(OLD_REBALANCE.replace("CREATE OR REPLACE FUNCTION rebalance_queue()", "CREATE OR REPLACE FUNCTION rebalance_queue_prev()"));
  await db.exec((mig ?? ((s: string) => s))(NEW_REBALANCE));
  await db.exec(COUNTER);
  await db.exec("BEGIN"); // 同一個交易：now() 固定，SAVEPOINT 才能用

  // ---- 零驗證列：第一次入列後，什麼都沒變，連跑多輪
  await db.exec("SELECT seed_auto_task_queue()");
  await db.exec("SELECT seed_auto_task_queue()");
  assertEquals((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'verify:%'")).n, 0, "此段沒有驗證列");
  assert((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM task_dispatches")).n >= 10, "有任務列");
  // 整條隊伍搬到一天前：正式庫的隊頭是過去的時間；起點有 LEAST(MIN, now()) 的上限，隊頭在交易的 now() 附近時漂移會被它蓋住、量不到
  await db.exec(`UPDATE task_dispatches SET queue_at = queue_at - INTERVAL '1 day' WHERE queue_at >= TIMESTAMPTZ '2000-01-01'`);
  // 手動插隊的列：1970／1980 年段，不參與重排、也不能影響起點
  await db.exec(`UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1980-01-01 00:00:00+00' WHERE task_id = 'auto:dup1';
                 UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1970-01-01 00:00:00+00' WHERE task_id = 'auto:dup2'`);
  await db.exec("SELECT rebalance_queue()"); // 拿掉 dup1／dup2 之後的穩態
  await db.exec("SELECT rebalance_queue()");
  const before = (await one<{ j: string }>(db, snapQ)).j;
  const minBefore = (await one<{ m: string }>(db, minQ)).m;
  const orderBefore = (await rows<{ task_id: string }>(db, orderQ)).map((r) => r.task_id).join(",");
  let moved = 0;
  for (let i = 0; i < 3; i++) moved += await movedBy(db, () => db.exec("SELECT rebalance_queue()"));
  v.zero_verify_idle_writes_nothing = moved === 0;
  v.zero_verify_anchor_stable = (await one<{ m: string }>(db, minQ)).m === minBefore;
  v.zero_verify_order_kept = (await rows<{ task_id: string }>(db, orderQ)).map((r) => r.task_id).join(",") === orderBefore;
  const manual = (await rows<{ task_id: string; q: string }>(db, `SELECT task_id, queue_at::text AS q FROM task_dispatches WHERE queue_at < TIMESTAMPTZ '2000-01-01' ORDER BY task_id`)).map((r) => `${r.task_id}@${r.q}`).join("|");
  v.manual_slots_untouched = manual.includes("auto:dup1@1980-01-01") && manual.includes("auto:dup2@1970-01-01") && before === (await one<{ j: string }>(db, snapQ)).j;

  // ---- 基準線：改前的版本在零驗證列時每輪都漂（沒有這條，上面的守門可能什麼都驗不出來）
  await db.exec("SAVEPOINT b");
  v.baseline_before_drifts = (await movedBy(db, async () => { await db.exec("SELECT rebalance_queue_prev()"); await db.exec("SELECT rebalance_queue_prev()"); })) > 0;
  await db.exec("ROLLBACK TO b");

  // ---- 有驗證列：與改前逐輪相同
  await db.exec(`INSERT INTO contributions (id, status, contribution_type, task_id, created_at) VALUES
    ('00000000-0000-4000-8000-000000000001', 'pending', 'correction', NULL, now()), ('00000000-0000-4000-8000-000000000002', 'pending', 'correction', NULL, now()),
    ('00000000-0000-4000-8000-000000000003', 'pending', 'correction', NULL, now())`);
  await db.exec("SELECT seed_auto_task_queue()");
  assert((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'verify:%'")).n >= 1, "有驗證列");
  const same = async (): Promise<boolean> => {
    await db.exec("SAVEPOINT s");
    await db.exec("SELECT rebalance_queue_prev()");
    const a = (await one<{ j: string }>(db, snapQ)).j;
    await db.exec("ROLLBACK TO s");
    await db.exec("SELECT rebalance_queue()");
    return a === (await one<{ j: string }>(db, snapQ)).j;
  };
  const r1 = await same();
  const r2 = await same();
  v.with_verify_same_as_before = r1 && r2;
  // 領走兩筆任務後再比一次
  const heads = (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:%' AND queue_at >= TIMESTAMPTZ '2000-01-01' ORDER BY queue_at, task_id LIMIT 2`)).map((r) => r.task_id);
  await db.exec(`SELECT task_dispatched('${heads[0]}'), task_dispatched('${heads[1]}')`);
  v.with_verify_after_claim_same = await same();
  return v as Verdicts;
}

let BASE: Verdicts | undefined;
const baseline = async () => (BASE ??= await runSuite());

Deno.test("B1 行為層：零驗證列、什麼都沒變，連跑多輪 rebalance 0 列被改寫、起點與順序不變、1970／1980 不受影響；有驗證列時與改前逐輪相同；改前版本確實會漂", async () => {
  const v = await baseline();
  for (const g of GUARDS) assert(v[g], `守門 ${g} 應該是綠的`);
  assertEquals(Object.keys(v).sort(), [...GUARDS].sort());
});

Deno.test("C 還原驗證：拿掉 #490 區塊 → 零驗證列的守門要紅，有驗證列的守門仍綠；退錯秒數、永遠退起點也要紅", async () => {
  const noFix = await runSuite((s) => {
    const out = s.replace(BLOCK, "");
    assert(out !== s, "要真的拿掉區塊");
    return out;
  });
  assert(!noFix.zero_verify_idle_writes_nothing && !noFix.zero_verify_anchor_stable, "拿掉修正後零驗證列會漂，守門要紅");
  assert(noFix.with_verify_same_as_before && noFix.with_verify_after_claim_same, "有驗證列的守門不受影響");
  assert(noFix.baseline_before_drifts, "基準線不受影響");
  const wrong = await runSuite((s) => mutate(s, "MIN(queue_at) - INTERVAL '1.5 seconds'", "MIN(queue_at) - INTERVAL '0 seconds'"));
  assert(!wrong.zero_verify_idle_writes_nothing, "退的不是 1.5 秒也要紅");
  const always = await runSuite((s) => mutate(s, "  IF NOT EXISTS (SELECT 1 FROM task_dispatches WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01')\n     AND EXISTS", "  IF EXISTS"));
  assert(!always.with_verify_same_as_before, "有驗證列也退起點，行為就和改前不同，守門要紅");
});
