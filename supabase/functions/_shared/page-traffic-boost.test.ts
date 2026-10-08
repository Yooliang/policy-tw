/**
 * 頁面流量提層（2026-10-08，migration 20261008190000_page_traffic_boost.sql）。
 *
 * 維護者 10-08：人物頁或政見頁在「一段時間內」有真實流量時，把它們名下的缺口任務提到前段；流量退了自動回原層；效果有時效、不是永久；參數可調。
 * 守門分兩半，只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）：
 *
 *   A. 文字層（不開資料庫）
 *      1. 這支是 seed_auto_task_queue 的最後一版，緊接著 party_roster 的 P2；新定義＝現行版加一個標記起訖的區塊（PERFORM traffic_boost_apply()），其餘一字不差
 *      2. 時間窗、門檻、層、無產出觀察期、暫停天數、資料時效只在 traffic_boost_settings：traffic_boost_apply、page_traffic_hot、replace_page_traffic、seed 的新區塊
 *         與 TS 端（page-traffic.ts）都沒有寫死的數字；console-fetch 的接線（先讀設定、寫入只經 RPC、RPC 只授權 service_role）
 *      3. 沒動 activity_priority、rebalance_queue、總表、/next、queue_slot、task_dispatched、/boost
 *
 *   B. PGlite（行為層）：真的 P0／P1／優先層 #443／P2×3／這支；多輪 seed
 *      達標提層（門檻剛好、各種 target 形狀）、退了回層、資料過期與時間窗不符失效、無產出暫停與期滿重算、交件算產出（no_change／rejected／提層前的不算）、
 *      接續同一期、已在前段的不開始計時、設定值是資料（改表行為就跟著變）、停用、page_traffic 空時與舊 seed 逐件相同、RPC 整批覆寫、審計
 *   C. 每條守門都做還原驗證：把 migration 改壞一處（精確改一處，改不到就失敗），對應的檢查必須紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { buildArmsDb, fnText, type GapRow, latestFn, migrationNames, mutate, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";

const MIG = "20261008190000_page_traffic_boost.sql";
const QP_MIG = "20261008090000_queue_priority_tiers.sql";
const MIG_SQL = await readMig(MIG);
const PR_SQL = await readMig(P2_PR_MIG);

// ============================================================
// A. 文字層
// ============================================================
const OLD_SEED = fnText(PR_SQL, "seed_auto_task_queue");
const NEW_SEED = fnText(MIG_SQL, "seed_auto_task_queue");
const MARK = /  -- >>> 流量提層[^\n]*\n[\s\S]*?  -- <<< 流量提層\n\n?/g;
const isMechanicalSeed = (fn: string) => {
  try {
    return (fn.match(MARK) ?? []).length === 1 && fn.replace(MARK, "") === OLD_SEED;
  } catch {
    return false;
  }
};
const bodyOf = (fn: string) => fn.slice(fn.indexOf("$$\n") + 3, fn.lastIndexOf("$$;"));
/** SQL 的程式碼本身：去掉整行與行尾註解、單引號字串（字串裡的 uuid 樣式、'{}' 不是規則值） */
const codeOf = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").replace(/'(?:[^']|'')*'/g, "''");
/** 函式或視圖裡的數字常數（[1] 是 regexp_matches 的第一個群，不算） */
const numerals = (sql: string) => (codeOf(sql).replace(/\[1\]/g, "").replace(/\bid = 1\b/g, "").replace(/SELECT 1\b/g, "").match(/(?<![A-Za-z_])\d+(?![A-Za-z_])/g) ?? []).filter((n) => n !== "0");
const viewText = (sql: string, name: string) => sql.slice(sql.indexOf(`CREATE OR REPLACE VIEW ${name} AS`), sql.indexOf(";\nCOMMENT ON VIEW", sql.indexOf(`CREATE OR REPLACE VIEW ${name} AS`)));
const APPLY = fnText(MIG_SQL, "traffic_boost_apply");
const REPLACE_RPC = fnText(MIG_SQL.replace("CREATE OR REPLACE FUNCTION public.replace_page_traffic", "CREATE OR REPLACE FUNCTION replace_page_traffic"), "replace_page_traffic");
const HOT_VIEW = viewText(MIG_SQL, "page_traffic_hot");
const SEED_BLOCK = [...NEW_SEED.matchAll(MARK)].map((m) => m[0]).join("");

Deno.test("A1 這支是 seed_auto_task_queue 的最後一版，緊接著 party_roster 的 P2；沒有動優先層、重排、總表、/next、插隊", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue(")) defining.push(n);
  const i = defining.indexOf(MIG);
  assert(i > 0, "這支要在重新定義 seed 的清單裡");
  assertEquals(defining[i - 1], P2_PR_MIG, "seed 的前一版應該是 party_roster 的 P2；有人在中間改了，要以那一版為底重做機械式替換");
  assertEquals(defining.slice(i + 1), [], "這支之後又有人改了 seed：要以最新那版為底重做（#453、#455、#458 若改到 seed，後合的重做）");
  const code = codeOf(MIG_SQL);
  for (const untouched of ["activity_priority", "rebalance_queue", "contribution_auto_tasks_arms", "contribution_auto_tasks", "queue_slot", "task_dispatched", "task_boost", "activity_open", "activity_require_rule"]) {
    assert(!new RegExp(`(CREATE OR REPLACE FUNCTION|DROP FUNCTION( IF EXISTS)?) ${untouched}\\(`).test(code), `這支不改 ${untouched}`);
  }
  assert(!/DROP FUNCTION|DROP COLUMN|DROP TABLE (?!IF EXISTS _)/.test(code), "只加不刪");
  assertEquals([...code.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?([a-z_]+)\(/g)].map((m) => m[1]), ["replace_page_traffic", "traffic_boost_apply", "seed_auto_task_queue"]);
  assert(!/(UPDATE|INSERT INTO|DELETE FROM)\s+(politicians|policies|politician_elections|contributions|activity_rules|activity_overrides|task_priority_tiers|election_milestones)\b/i.test(code), "不寫任何正式資料表、規則表、里程碑表");
});

Deno.test("A2 seed 新定義＝party_roster 那支 P2 的定義＋一個標記起訖的區塊（PERFORM traffic_boost_apply），其餘一字不差", () => {
  assert(isMechanicalSeed(NEW_SEED));
  assertEquals((NEW_SEED.match(/-- >>> 流量提層/g) ?? []).length, 1);
  assertEquals(codeOf(SEED_BLOCK).trim(), "PERFORM traffic_boost_apply();");
  // 新區塊在優先層算完之後、收回與更新之前：nobody 讀 _gaps.priority 之前層就已經定了
  assert(NEW_SEED.indexOf("-- <<< 優先層") < NEW_SEED.indexOf("-- >>> 流量提層") && NEW_SEED.indexOf("-- <<< 流量提層") < NEW_SEED.indexOf("-- >>> gap_events window：臂自己"));
  assert(NEW_SEED.includes("PERFORM rebalance_queue();") && NEW_SEED.includes("RETURN v_new + v_verify;"));
});

Deno.test("A3 還原驗證（文字層）：動 seed 本體、少區塊、多一個區塊，A2 都要紅", () => {
  assert(!isMechanicalSeed(mutate(NEW_SEED, "RETURN v_new + v_verify;", "RETURN v_new;")), "偷改回傳值");
  assert(!isMechanicalSeed(mutate(NEW_SEED, "AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)\n     AND EXISTS", "AND true\n     AND EXISTS")), "偷改收回條件");
  assert(!isMechanicalSeed(mutate(NEW_SEED, "  -- <<< 流量提層\n", "")), "結束標記掉了");
  assert(!isMechanicalSeed(NEW_SEED.replace("  -- <<< 流量提層\n", "  -- <<< 流量提層\n  PERFORM 1;\n")), "區塊外多一行");
  assert(!isMechanicalSeed(OLD_SEED), "舊版本身不是新的");
});

Deno.test("A4 參數只在設定表：函式與視圖本體、seed 區塊都沒有寫死的天數、人數、層號、小時", () => {
  for (const [name, text] of [["traffic_boost_apply", bodyOf(APPLY)], ["replace_page_traffic", bodyOf(REPLACE_RPC)], ["page_traffic_hot", HOT_VIEW], ["seed 區塊", SEED_BLOCK]] as const) {
    assertEquals(numerals(text), [], `${name} 裡不該有數字常數`);
  }
  // 設定表欄位是資料：預設值只在 CREATE TABLE（初值 7 天、5 人、前段、14／14、24 小時）
  const t = MIG_SQL.slice(MIG_SQL.indexOf("CREATE TABLE IF NOT EXISTS traffic_boost_settings"), MIG_SQL.indexOf("COMMENT ON TABLE traffic_boost_settings"));
  for (const frag of ["window_days       INTEGER NOT NULL DEFAULT 7", "min_users         INTEGER NOT NULL DEFAULT 5", "boost_tier        SMALLINT NOT NULL DEFAULT 1", "no_yield_days     INTEGER NOT NULL DEFAULT 14", "pause_days        INTEGER NOT NULL DEFAULT 14", "stale_after_hours INTEGER NOT NULL DEFAULT 24"]) {
    assert(t.includes(frag), `設定表的初值：${frag}`);
  }
  // 每個參數函式都真的讀表欄位
  for (const col of ["s.boost_tier", "s.pause_days", "s.no_yield_days", "s.enabled"]) assert(APPLY.includes(col), `traffic_boost_apply 要讀 ${col}`);
  for (const col of ["s.window_days", "s.min_users", "s.stale_after_hours", "s.enabled"]) assert(HOT_VIEW.includes(col), `page_traffic_hot 要讀 ${col}`);
  assert(REPLACE_RPC.includes("s.window_days"));
});

Deno.test("A5 還原驗證（文字層）：把設定值寫死回函式裡，A4 的數字檢查要紅", () => {
  assertEquals(numerals(HOT_VIEW.replace("t.users >= s.min_users", "t.users >= 5")), ["5"]);
  assertEquals(numerals(bodyOf(APPLY).replace("make_interval(days => s.pause_days)", "make_interval(days => 14)")).length > 0, true);
  assertEquals(numerals(bodyOf(APPLY).replace("SET priority = s.boost_tier", "SET priority = 1")).length > 0, true);
  assertEquals(numerals(HOT_VIEW.replace("make_interval(hours => s.stale_after_hours)", "make_interval(hours => 24)")), ["24"]);
  assertEquals(numerals(bodyOf(REPLACE_RPC).replace("p_window_days IS DISTINCT FROM v_window", "p_window_days IS DISTINCT FROM 7")), ["7"]);
});

Deno.test("A6 寫入只經 RPC：RPC 只授權 service_role；表開 RLS、公開唯讀；設定表有審計與 updated_at 觸發器", () => {
  const code = codeOf(MIG_SQL);
  for (const role of ["PUBLIC", "anon", "authenticated"]) assert(code.includes(`REVOKE ALL ON FUNCTION public.replace_page_traffic(jsonb, integer) FROM ${role};`), `收回 ${role}`);
  assert(code.includes("GRANT EXECUTE ON FUNCTION public.replace_page_traffic(jsonb, integer) TO service_role;"));
  assert(!/GRANT EXECUTE ON FUNCTION[^;]*TO (anon|authenticated|PUBLIC)/i.test(code));
  // 這支新建的函式（seed 是 CREATE OR REPLACE 既有的，授權沿用）：每一個都逐一收回、只留 service_role
  for (const fn of ["replace_page_traffic(jsonb, integer)", "traffic_boost_apply()"]) {
    for (const role of ["PUBLIC", "anon", "authenticated"]) assert(code.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM ${role};`), `${fn} 收回 ${role}`);
    assert(code.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`), `${fn} 只授 service_role`);
  }
  assert(REPLACE_RPC.includes("SECURITY DEFINER") && REPLACE_RPC.includes("SET search_path = ''"));
  for (const t of ["traffic_boost_settings", "page_traffic", "page_traffic_boosts"]) {
    assert(code.includes(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`), `${t} 開 RLS`);
    assert(MIG_SQL.includes(`CREATE POLICY "Public read" ON ${t} FOR SELECT USING (true);`), `${t} 公開唯讀`);
    assert(MIG_SQL.includes(`CREATE POLICY "Service role write" ON ${t} FOR ALL USING (auth.role() = 'service_role')`), `${t} 只有 service_role 寫`);
  }
  assert(code.includes("EXECUTE FUNCTION activity_audit()") && code.includes("trg_traffic_boost_settings_audit AFTER INSERT OR UPDATE OR DELETE ON traffic_boost_settings"));
});

const readSrc = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url)).then((s) => s.replace(/\r\n/g, "\n"));
const stripJsComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

Deno.test("A7 TS 端不知道門檻、層、暫停天數，也沒有寫死的時間窗；console-fetch 先讀設定、寫入只經 RPC、不碰 Firestore 的 meta/status", async () => {
  const ts = stripJsComments(await readSrc("./page-traffic.ts"));
  assert(!/min_users|boost_tier|pause_days|no_yield_days|stale_after_hours/.test(ts), "門檻、層、暫停天數只在資料庫");
  assert(!/\b\d+daysAgo\b/.test(ts) && !/windowDays\s*=\s*\d/.test(ts) && !/window_days:\s*\d/.test(ts), "時間窗不寫死");
  assert(ts.includes("input.store.readSettings()") && ts.indexOf("input.store.readSettings()") < ts.indexOf("fetchPageTraffic(propertyId"), "先讀設定再抓");
  const idx = stripJsComments(await readSrc("../console-fetch/index.ts"));
  assert(idx.includes('.from("traffic_boost_settings").select("enabled, window_days")'), "設定讀表");
  assert(idx.includes('db.rpc("replace_page_traffic", { p_rows: rows, p_window_days: windowDays })'), "寫入只經 RPC");
  assert(!/\.from\("page_traffic"\)/.test(idx), "不直接寫表");
  assert(idx.indexOf("verifyCaller(") < idx.indexOf("runPageTrafficSync("), "流量同步排在呼叫者驗證之後");
  assert(!/store\.(set|merge)\([^)]*traffic/i.test(idx), "流量的成敗不寫進 Firestore 的 meta/status");
});

// ============================================================
// B. PGlite
// ============================================================
type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];

const PA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // 熱門人物
const PB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // 人物（不熱門，有參選紀錄 902）
const PD = "dddddddd-dddd-dddd-dddd-dddddddddddd"; // 人物（不熱門）
const POL_A = "a0a0a0a0-0000-4000-8000-000000000001"; // PA 名下的政見
const POL_HOT = "c0c0c0c0-0000-4000-8000-000000000003"; // 熱門政見（擁有者 PD，PD 不熱門）
const POL_OTHER = "c0c0c0c0-0000-4000-8000-000000000009"; // 擁有者 PD 的另一條政見（不熱門）
const PE_A = 901, PE_B = 902;

const G = (id: string, type: string, target: Record<string, unknown> | null): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h"], reward: 1, region: "台北市" });
const E = (election_id: number, election_type: string, extra: Record<string, unknown> = {}) => ({ election_id, election_type, ...extra });

// 各臂的 target 形狀（原層）：term_policies 2022＝後段(3)；dup、handover_missing、lineage_roles、policy_elements、mismatch、legacy 沒有選舉＝預設層(2)；roster_villages 2026 村里長＝前段(1)
const FIXTURE = {
  term_policies: [
    G("aa_term", "term_policy_missing", E(2022, "縣市議員", { politician_id: PA })), // 3 → PA 熱門時提
    G("a0_term", "term_policy_missing", E(2022, "縣市議員", { politician_id: PD })), // 3，永遠不熱門
  ],
  dup: [
    G("dup_ab", "duplicate_politician", { a: PA, b: PB }), // 2：a 是 PA
    G("dup_null", "duplicate_politician", null), // 2：沒有 target
  ],
  handover_missing: [G("handover", "handover_missing", { from_politician_id: PB, to_politician_id: PA }) /* 2：to_ 是 PA */],
  lineage_roles: [G("roles", "lineage_roles", { lineage_id: "l1", people: [{ politician_id: PD, role: "x" }, { politician_id: PA, role: "y" }] }) /* 2：people[] 第二位是 PA */],
  policy_elements: [
    G("items", "policy_element_missing", { items: [{ policy_id: POL_OTHER }, { policy_id: POL_A }] }), // 2：items[] 裡有 PA 名下的政見
    G("hot_policy", "policy_element_missing", { policy_id: POL_HOT }), // 2：政見頁熱門時提
    G("other_policy", "policy_element_missing", { policy_id: POL_OTHER }), // 2：不熱門
  ],
  mismatch: [G("pe_ids", "policy_election_mismatch", { politician_election_ids: [PE_A, 950] }) /* 2：陣列含 PA 的參選紀錄 */],
  legacy: [G("pe_one_b", "legacy_policy_label", { politician_election_id: PE_B }) /* 2：單值是 PB 的參選紀錄（PB 不熱門） */,
    G("pe_one_a", "legacy_policy_label", { politician_election_id: PE_A }) /* 2：單值是 PA 的參選紀錄 */],
  roster_villages: [G("front", "roster_check", E(2026, "村里長", { politician_id: PA })) /* 1：已經在前段 */],
};
const ORIGINAL: Record<string, number> = {
  aa_term: 3, a0_term: 3, dup_ab: 2, dup_null: 2, handover: 2, roles: 2, items: 2, hot_policy: 2, other_policy: 2, pe_ids: 2, pe_one_b: 2, pe_one_a: 2, front: 1,
};
const IDS = Object.keys(ORIGINAL);
/** PA 熱門時會被提到前段的（原層不是前段、target 指到 PA 或他名下的政見／參選紀錄） */
const PA_LIFTED = ["aa_term", "dup_ab", "handover", "roles", "items", "pe_ids", "pe_one_a"];

const RESTUB = ["raw", "election_results", "party_gap", "party_roster"] as const;

async function buildDb(mutateMig: (s: string) => string = (s) => s, branches: Record<string, GapRow[]> = FIXTURE): Promise<Db> {
  const pre = `
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER TABLE elections ADD COLUMN bulletin_published_on date;
    UPDATE elections SET bulletin_published_on = DATE '2026-11-18' WHERE id = 2026;
    ALTER TABLE contributions ADD COLUMN contributor_ip_hash text, ADD COLUMN agent_name text, ADD COLUMN payload jsonb;
    CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
    CREATE FUNCTION task_target_key(t text, tg jsonb) RETURNS text LANGUAGE sql AS $$ SELECT t $$;
    DROP FUNCTION queue_slot(text);
    ${await latestFn("queue_slot")}
    ${await latestFn("contribution_auto_tasks")}
    ${await latestFn("task_dispatched")}
    CREATE OR REPLACE FUNCTION contribution_queue_at(t text, k text, c timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT queue_slot('verify') $$;
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL);
    CREATE TABLE policies (id uuid PRIMARY KEY, politician_id uuid NOT NULL);
    ${await latestFn("politician_name_is_placeholder")}`;
  const db = await buildArmsDb({
    branches,
    afterP1Sql: pre,
    p2: { migs: [{ name: QP_MIG }, { name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: MIG, mutate: mutateMig }], restub: RESTUB },
  });
  await db.exec(`
    INSERT INTO politicians VALUES ('${PA}', '甲', NULL), ('${PB}', '乙', NULL), ('${PD}', '丁', NULL);
    INSERT INTO politician_elections VALUES (${PE_A}, '${PA}'), (${PE_B}, '${PB}'), (903, '${PD}');
    INSERT INTO policies VALUES ('${POL_A}', '${PA}'), ('${POL_HOT}', '${PD}'), ('${POL_OTHER}', '${PD}');
    SET app.activity_today = '2026-10-08';`);
  return db;
}

type Row = { kind: string; target_id: string; users: number; views?: number };
const traffic = (db: Db, rs: Row[], window = 7) => db.query(`SELECT replace_page_traffic($1::jsonb, $2)`, [JSON.stringify(rs.map((r) => ({ views: r.users, ...r }))), window]);
const hotA = (users = 5): Row => ({ kind: "politician", target_id: PA, users });
const seed = (db: Db) => db.exec(`SELECT seed_auto_task_queue()`);
const tiers = async (db: Db): Promise<Record<string, number | null>> =>
  Object.fromEntries((await rows<{ task_id: string; priority: number | null }>(db, `SELECT task_id, priority::int FROM task_dispatches WHERE task_id LIKE 'auto:%'`)).map((r) => [r.task_id.replace(/^auto:/, ""), r.priority]));
const sameTiers = (a: Record<string, number | null>, b: Record<string, number | null>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const lifted = (t: Record<string, number | null>) => Object.keys(t).filter((k) => t[k] !== ORIGINAL[k]).sort();
const boost = (db: Db, id = PA) => one<{ boosted_since: string; last_hot_at: string; last_yield_at: string | null; paused_until: string | null; lifted_task_ids: string[] } | undefined>(
  db, `SELECT boosted_since::text, last_hot_at::text, last_yield_at::text, paused_until::text, lifted_task_ids FROM page_traffic_boosts WHERE target_id = $1`, [id]);
/** 時光倒流：把這一頁的狀態往前推 n 天（等於「那是 n 天前發生的」；測試在同一個交易裡 now() 不動） */
const age = (db: Db, days: number, cols = "boosted_since, last_hot_at") =>
  db.exec(`UPDATE page_traffic_boosts SET ${cols.split(",").map((c) => `${c.trim()} = ${c.trim()} - interval '${days} days'`).join(", ")} WHERE target_id = '${PA}'`);
const contribute = (db: Db, taskId: string, type: string, status: string, daysAgo: number) =>
  db.query(`INSERT INTO contributions (id, status, contribution_type, task_id, created_at) VALUES (gen_random_uuid(), $2, $3, $1, now() - ($4 || ' days')::interval)`, [`auto:${taskId}`, status, type, String(daysAgo)]);

type Verdicts = Record<string, boolean>;
async function guard(out: Verdicts, db: Db, name: string, f: () => Promise<boolean>) {
  await db.exec("BEGIN");
  try {
    out[name] = await f();
  } catch (e) {
    console.error(`[${name}]`, (e as Error).message);
    out[name] = false;
  } finally {
    try {
      await db.exec("ROLLBACK");
    } catch { /* 已經回滾 */ }
  }
}

const GUARDS = [
  "baseline_original_tiers", "hot_lifts_all_shapes", "threshold_exact", "policy_page_lifts", "min_of_original_and_boost", "front_gap_not_counted",
  "returns_when_cold", "returns_when_stale", "returns_when_window_changes", "pauses_without_yield", "paused_stays_paused", "resumes_after_pause",
  "yield_counts", "no_change_not_yield", "rejected_not_yield", "old_contribution_not_yield", "yield_rolls_window", "continues_same_period", "forgets_after_cold",
  "settings_are_data", "disabled_does_nothing", "empty_traffic_parity", "unrelated_traffic_parity", "new_gap_born_lifted", "queue_front", "boosted_view", "audit_on_settings",
  "rpc_replace", "rpc_rejects", "rpc_null_metrics", "function_privileges", "yield_recomputed_after_rejection", "expired_pause_cold_forgotten", "empty_period_not_paused",
  "new_period_starts_at_first_lift", "boosted_view_requires_hot",
] as const;

async function runSuite(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  const g = (name: string, f: () => Promise<boolean>) => guard(v, db, name, f);

  await g("baseline_original_tiers", async () => {
    await seed(db);
    const t = await tiers(db);
    return sameTiers(t, ORIGINAL);
  });

  await g("hot_lifts_all_shapes", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    const t = await tiers(db);
    const b = await boost(db);
    return JSON.stringify(lifted(t)) === JSON.stringify([...PA_LIFTED].sort()) && PA_LIFTED.every((k) => t[k] === 1) &&
      t.front === 1 && t.a0_term === 3 && t.pe_one_b === 2 && t.hot_policy === 2 && t.other_policy === 2 && t.dup_null === 2 &&
      b !== undefined && JSON.stringify([...b.lifted_task_ids].sort()) === JSON.stringify(PA_LIFTED.map((k) => `auto:${k}`).sort()) && b.paused_until === null;
  });

  await g("threshold_exact", async () => {
    await traffic(db, [hotA(4)]);
    await seed(db);
    const below = sameTiers(await tiers(db), ORIGINAL) && (await boost(db)) === undefined;
    await traffic(db, [hotA(5)]);
    await seed(db);
    return below && (await tiers(db)).aa_term === 1;
  });

  await g("policy_page_lifts", async () => {
    await traffic(db, [{ kind: "policy", target_id: POL_HOT, users: 9 }]);
    await seed(db);
    const t = await tiers(db);
    // 政見頁熱門：只提這條政見的缺口；擁有者 PD 不熱門，PD 的其他任務不動
    return JSON.stringify(lifted(t)) === JSON.stringify(["hot_policy"]) && t.hot_policy === 1;
  });

  await g("min_of_original_and_boost", async () => {
    await db.exec(`UPDATE traffic_boost_settings SET boost_tier = 2 WHERE id = 1`);
    await traffic(db, [hotA()]);
    await seed(db);
    const t = await tiers(db);
    // 提到中段(2)：後段(3)的升到 2，原本 2 的不動，原本 1 的不降
    return t.aa_term === 2 && t.dup_ab === 2 && t.front === 1 && JSON.stringify(lifted(t)) === JSON.stringify(["aa_term"]);
  });

  await g("front_gap_not_counted", async () => {
    // PA 的缺口只剩已經在前段的那件：提層沒有效果，不開始計時
    await db.exec(`DELETE FROM _b_term_policies; DELETE FROM _b_dup; DELETE FROM _b_handover_missing; DELETE FROM _b_lineage_roles; DELETE FROM _b_policy_elements; DELETE FROM _b_mismatch; DELETE FROM _b_legacy`);
    await traffic(db, [hotA()]);
    await seed(db);
    return (await boost(db)) === undefined && (await tiers(db)).front === 1;
  });

  await g("returns_when_cold", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    const up = (await tiers(db)).aa_term === 1;
    await traffic(db, [hotA(2)]);
    await seed(db);
    return up && sameTiers(await tiers(db), ORIGINAL);
  });

  await g("returns_when_stale", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    const up = (await tiers(db)).aa_term === 1;
    await db.exec(`UPDATE page_traffic SET updated_at = now() - interval '25 hours'`); // 比 24 小時舊（初值）：GA 抓失敗、console-fetch 停擺
    await seed(db);
    return up && sameTiers(await tiers(db), ORIGINAL);
  });

  await g("returns_when_window_changes", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    const up = (await tiers(db)).aa_term === 1;
    await db.exec(`UPDATE traffic_boost_settings SET window_days = 14 WHERE id = 1`); // 舊窗口的數字不採用，等下一輪抓
    await seed(db);
    const back = sameTiers(await tiers(db), ORIGINAL);
    await traffic(db, [hotA()], 14);
    await seed(db);
    return up && back && (await tiers(db)).aa_term === 1;
  });

  await g("pauses_without_yield", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 15);
    await seed(db);
    const b = await boost(db);
    const days = await one<{ d: number }>(db, `SELECT extract(epoch FROM (paused_until - now())) / 86400 AS d FROM page_traffic_boosts WHERE target_id = $1`, [PA]);
    return b!.paused_until !== null && Math.round(Number(days.d)) === 14 && sameTiers(await tiers(db), ORIGINAL);
  });

  await g("paused_stays_paused", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 15);
    await seed(db);
    await seed(db);
    await traffic(db, [hotA(50)]);
    await seed(db);
    return sameTiers(await tiers(db), ORIGINAL) && (await boost(db))!.paused_until !== null;
  });

  await g("resumes_after_pause", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 15);
    await seed(db);
    await db.exec(`UPDATE page_traffic_boosts SET paused_until = now() - interval '1 minute' WHERE target_id = '${PA}'`);
    await seed(db);
    const b = (await boost(db))!;
    const fresh = await one<{ ok: boolean }>(db, `SELECT boosted_since >= now() - interval '1 minute' AS ok FROM page_traffic_boosts WHERE target_id = $1`, [PA]);
    return b.paused_until === null && fresh.ok && (await tiers(db)).aa_term === 1 && b.lifted_task_ids.length === PA_LIFTED.length;
  });

  await g("yield_counts", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 15);
    await contribute(db, "aa_term", "policy", "pending", 3); // 3 天前有一筆實質交件
    await seed(db);
    const b = (await boost(db))!;
    return b.paused_until === null && b.last_yield_at !== null && (await tiers(db)).aa_term === 1;
  });

  await g("no_change_not_yield", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 15);
    await contribute(db, "aa_term", "no_change", "approved", 3); // 查無：不算產出
    await contribute(db, "aa_term", "task_suggestion", "pending", 3);
    await seed(db);
    return (await boost(db))!.paused_until !== null;
  });

  await g("rejected_not_yield", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 15);
    await contribute(db, "aa_term", "policy", "rejected", 3);
    await seed(db);
    return (await boost(db))!.paused_until !== null;
  });

  await g("old_contribution_not_yield", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 15);
    await contribute(db, "aa_term", "policy", "pending", 20); // 提層之前的交件
    await contribute(db, "a0_term", "policy", "pending", 3); // 別頁任務上的交件
    await seed(db);
    return (await boost(db))!.paused_until !== null;
  });

  await g("yield_rolls_window", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 40);
    await contribute(db, "aa_term", "policy", "pending", 20); // 20 天前的產出：距今超過 14 天 → 暫停
    await seed(db);
    const paused = (await boost(db))!.paused_until !== null;
    await db.exec(`UPDATE page_traffic_boosts SET paused_until = NULL, boosted_since = now() - interval '40 days', last_yield_at = NULL WHERE target_id = '${PA}'`);
    await contribute(db, "aa_term", "policy", "pending", 10); // 10 天前再一筆：滾動起點是它 → 不暫停
    await seed(db);
    return paused && (await boost(db))!.paused_until === null;
  });

  await g("continues_same_period", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 10);
    const since = (await boost(db))!.boosted_since;
    await traffic(db, [hotA(1)]); // 流量暫時退下去
    await seed(db);
    const mid = sameTiers(await tiers(db), ORIGINAL) && (await boost(db)) !== undefined;
    await traffic(db, [hotA(8)]); // 又回來：接續同一期，不重新計時
    await seed(db);
    const b = (await boost(db))!;
    return mid && b.boosted_since === since && (await tiers(db)).aa_term === 1;
  });

  await g("forgets_after_cold", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 20);
    await traffic(db, [hotA(1)]);
    await seed(db); // 距上次達標超過 14 天：狀態列清掉
    const gone = (await boost(db)) === undefined;
    await traffic(db, [hotA(8)]);
    await seed(db);
    const b = (await boost(db))!;
    const fresh = await one<{ ok: boolean }>(db, `SELECT boosted_since >= now() - interval '1 minute' AS ok FROM page_traffic_boosts WHERE target_id = $1`, [PA]);
    return gone && fresh.ok && b.paused_until === null && (await tiers(db)).aa_term === 1;
  });

  await g("settings_are_data", async () => {
    // min_users：3 → 4 人也算
    await db.exec(`UPDATE traffic_boost_settings SET min_users = 3 WHERE id = 1`);
    await traffic(db, [hotA(4)]);
    await seed(db);
    const a = (await tiers(db)).aa_term === 1;
    await db.exec(`UPDATE traffic_boost_settings SET min_users = 5 WHERE id = 1`);
    await seed(db);
    const b = sameTiers(await tiers(db), ORIGINAL);
    // no_yield_days／pause_days：3 天沒產出就暫停 2 天
    await db.exec(`UPDATE traffic_boost_settings SET min_users = 3, no_yield_days = 3, pause_days = 2 WHERE id = 1`);
    await seed(db);
    await age(db, 4);
    await seed(db);
    const days = await one<{ d: number }>(db, `SELECT extract(epoch FROM (paused_until - now())) / 86400 AS d FROM page_traffic_boosts WHERE target_id = $1`, [PA]);
    const c = Math.round(Number(days.d)) === 2 && sameTiers(await tiers(db), ORIGINAL);
    // stale_after_hours：2 小時，3 小時前的資料失效
    await db.exec(`UPDATE page_traffic_boosts SET paused_until = NULL; UPDATE traffic_boost_settings SET stale_after_hours = 2, no_yield_days = 14 WHERE id = 1; UPDATE page_traffic SET updated_at = now() - interval '3 hours'`);
    await seed(db);
    return a && b && c && sameTiers(await tiers(db), ORIGINAL);
  });

  await g("disabled_does_nothing", async () => {
    await traffic(db, [hotA()]);
    await db.exec(`UPDATE traffic_boost_settings SET enabled = false WHERE id = 1`);
    await seed(db);
    return sameTiers(await tiers(db), ORIGINAL) && (await boost(db)) === undefined && (await rows(db, `SELECT 1 FROM page_traffic_hot`)).length === 0;
  });

  // ---- parity：page_traffic 空，或有流量但沒有一頁對得到缺口，輸出逐件不變 ----
  const snapshot = async () => ({
    t: Object.entries(await tiers(db)).sort(),
    order: (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches ORDER BY queue_at, task_id COLLATE "C"`)).map((r) => r.task_id),
    by: (await rows<{ task_id: string; opened_by: unknown }>(db, `SELECT task_id, opened_by FROM task_dispatches WHERE task_id LIKE 'auto:%' ORDER BY task_id COLLATE "C"`)),
  });
  const parity = async (setup: () => Promise<void>) => {
    // 舊 seed（party_roster 那支 P2 的定義）改名放進來，同一份資料各跑一次，輸出逐件比
    await db.exec(OLD_SEED.replace("FUNCTION seed_auto_task_queue()", "FUNCTION seed_old()"));
    await db.exec("SAVEPOINT p0");
    await setup();
    await db.exec(`SELECT seed_old()`);
    const before = await snapshot();
    await db.exec("ROLLBACK TO SAVEPOINT p0");
    await setup();
    await seed(db);
    const after = await snapshot();
    const same = JSON.stringify(before) === JSON.stringify(after);
    if (!same) console.error("parity 不同：", JSON.stringify(before).slice(0, 1500), " vs ", JSON.stringify(after).slice(0, 1500));
    return same;
  };
  await g("empty_traffic_parity", () => parity(async () => {}));
  await g("unrelated_traffic_parity", () =>
    parity(async () => {
      // 達標，但頁面不是任何缺口的對象；另一頁有缺口但不到門檻
      await traffic(db, [{ kind: "politician", target_id: "99999999-9999-4999-8999-999999999999", users: 50 }, { kind: "politician", target_id: PD, users: 4 }]);
    }));

  await g("new_gap_born_lifted", async () => {
    await traffic(db, [hotA()]);
    await seed(db); // 新缺口出生就在前段
    const born = await rows<{ task_id: string; opened_by: Record<string, unknown> }>(db, `SELECT task_id, opened_by FROM task_dispatches WHERE task_id IN ('auto:aa_term', 'auto:a0_term') ORDER BY task_id`);
    const ev = await rows<{ p: number | null }>(db, `SELECT priority::int AS p FROM gap_events WHERE task_id = 'auto:aa_term' AND event = 'opened'`);
    const [cold, hot] = born; // a0_term（PD，不熱門）排在 aa_term（PA，熱門）前面
    return hot.opened_by.traffic_boost === true && hot.opened_by.priority === 1 && cold.opened_by.traffic_boost === undefined && cold.opened_by.priority === 3 && ev[0].p === 1;
  });

  await g("queue_front", async () => {
    const orderNow = async () => (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:%' ORDER BY queue_at, task_id COLLATE "C"`)).map((r) => r.task_id.replace(/^auto:/, ""));
    await seed(db);
    const before = await orderNow();
    await traffic(db, [hotA()]);
    await seed(db);
    const after = await orderNow();
    // 同在後段時 a0_term（先進先出，id 較小）排在 aa_term 前面；aa_term 被提到前段之後排到它前面（rebalance 照新層交錯）
    return before.indexOf("a0_term") < before.indexOf("aa_term") && after.indexOf("aa_term") < after.indexOf("a0_term");
  });

  await g("boosted_view", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    const a = (await rows<{ task_id: string }>(db, `SELECT task_id FROM page_traffic_boosted_tasks WHERE target_id = $1`, [PA])).map((r) => r.task_id.replace(/^auto:/, "")).sort();
    // 前段本來就有的 front 在 lifted_task_ids 裡沒有；暫停後不列
    await age(db, 15);
    await seed(db);
    const b = await rows(db, `SELECT 1 FROM page_traffic_boosted_tasks`);
    return JSON.stringify(a) === JSON.stringify([...PA_LIFTED].sort()) && b.length === 0;
  });

  await g("audit_on_settings", async () => {
    await db.exec(`UPDATE traffic_boost_settings SET min_users = 9, note = '改' WHERE id = 1`);
    const h = await one<{ o: { min_users: number }; n: { min_users: number }; a: string }>(db,
      `SELECT old_value AS o, new_value AS n, agent_name AS a FROM edit_history WHERE table_name = 'traffic_boost_settings' ORDER BY id DESC LIMIT 1`);
    return h.o.min_users === 5 && h.n.min_users === 9 && h.a === "activity-audit";
  });

  await g("rpc_replace", async () => {
    await traffic(db, [{ kind: "politician", target_id: PA, users: 6, views: 10 }, { kind: "policy", target_id: POL_HOT, users: 2, views: 3 }]);
    // 第二輪：PA 的數字變、政見頁消失、新增一頁；重複的鍵（大小寫不同）加總
    await db.query(`SELECT replace_page_traffic($1::jsonb, 7)`, [JSON.stringify([
      { kind: "politician", target_id: PA, users: 8, views: 12 }, { kind: "politician", target_id: PD, users: 1, views: 1 },
      { kind: "politician", target_id: PB.toUpperCase(), users: 2, views: 3 }, { kind: "politician", target_id: PB, users: 3, views: 4 },
    ])]);
    const r = await rows<{ kind: string; target_id: string; users: number; views: number; window_days: number }>(db, `SELECT kind, target_id, users, views, window_days FROM page_traffic ORDER BY target_id`);
    const first = new Map(r.map((x) => [x.target_id, x]));
    const empty = await db.query(`SELECT replace_page_traffic('[]'::jsonb, 7) AS n`); // 空陣列＝這一小時沒有任何頁達到統計：清空
    return r.length === 3 && first.get(PA)!.users === 8 && first.get(PA)!.views === 12 && first.get(PB)!.users === 5 && first.get(PB)!.views === 7 && !first.has(POL_HOT) &&
      r.every((x) => x.window_days === 7) && (await rows(db, `SELECT 1 FROM page_traffic`)).length === 0 && Number((empty.rows[0] as { n: number }).n) === 0;
  });

  await g("rpc_rejects", async () => {
    const bad = async (sql: string, params: unknown[] = []) => {
      await db.exec("SAVEPOINT s");
      try {
        await db.query(sql, params);
        await db.exec("RELEASE SAVEPOINT s");
        return false;
      } catch {
        await db.exec("ROLLBACK TO SAVEPOINT s");
        return true;
      }
    };
    const okRow = JSON.stringify([{ kind: "politician", target_id: PA, users: 1, views: 1 }]);
    return (await bad(`SELECT replace_page_traffic($1::jsonb, 14)`, [okRow])) && // 時間窗不符
      (await bad(`SELECT replace_page_traffic('{"a":1}'::jsonb, 7)`)) && // 不是陣列
      (await bad(`SELECT replace_page_traffic($1::jsonb, 7)`, [JSON.stringify([{ kind: "party", target_id: PA, users: 1, views: 1 }])])) && // 不認得的種類
      (await bad(`SELECT replace_page_traffic($1::jsonb, 7)`, [JSON.stringify([{ kind: "policy", target_id: "not-a-uuid", users: 1, views: 1 }])])) &&
      (await bad(`SELECT replace_page_traffic($1::jsonb, 7)`, [JSON.stringify([{ kind: "policy", target_id: PA, users: -1, views: 1 }])])) &&
      (await rows(db, `SELECT 1 FROM page_traffic`)).length === 0;
  });

  await g("rpc_null_metrics", async () => {
    // users／views 是 null 或缺欄：轉成 0，不讓整批覆寫失敗
    await db.query(`SELECT replace_page_traffic($1::jsonb, 7)`, [JSON.stringify([
      { kind: "politician", target_id: PA, users: null, views: null }, { kind: "politician", target_id: PD, users: 4 }, { kind: "policy", target_id: POL_HOT, views: 3 },
      { kind: "politician", target_id: PB, users: 2, views: 5 },
    ])]);
    const r = Object.fromEntries((await rows<{ target_id: string; users: number; views: number }>(db, `SELECT target_id, users, views FROM page_traffic`)).map((x) => [x.target_id, x]));
    return Object.keys(r).length === 4 && r[PA].users === 0 && r[PA].views === 0 && r[PD].users === 4 && r[PD].views === 0 && r[POL_HOT].users === 0 && r[POL_HOT].views === 3 && r[PB].users === 2;
  });

  await g("function_privileges", async () => {
    // anon／authenticated 不能執行（PostgREST 會把能執行的 public 函式當成公開 RPC）；service_role 可以
    const can = async (role: string, fn: string) => (await one<{ ok: boolean }>(db, `SELECT has_function_privilege('${role}', '${fn}'::regprocedure, 'EXECUTE') AS ok`)).ok;
    const fns = ["traffic_boost_apply()", "replace_page_traffic(jsonb, integer)"];
    for (const fn of fns) {
      if ((await can("anon", fn)) || (await can("authenticated", fn)) || !(await can("service_role", fn))) return false;
      // PUBLIC 也不行：隨便建一個沒有任何授權的角色來試
    }
    await db.exec(`CREATE ROLE nobody_role`);
    for (const fn of fns) if (await can("nobody_role", fn)) return false;
    return true;
  });

  await g("yield_recomputed_after_rejection", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 10);
    await db.exec(`UPDATE page_traffic SET updated_at = now()`);
    await contribute(db, "aa_term", "policy", "pending", 3); // 3 天前一筆實質交件（當時還有效）
    await seed(db);
    const counted = (await boost(db))!.last_yield_at !== null;
    await db.exec(`UPDATE contributions SET status = 'rejected' WHERE task_id = 'auto:aa_term'`); // 後來被駁回
    await seed(db);
    const cleared = (await boost(db))!.last_yield_at === null;
    await age(db, 5); // 這一期已滿 15 天、沒有任何有效產出 → 暫停
    await seed(db);
    return counted && cleared && (await boost(db))!.paused_until !== null;
  });

  await g("expired_pause_cold_forgotten", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    await age(db, 15);
    await seed(db); // 暫停
    await db.exec(`UPDATE page_traffic_boosts SET paused_until = now() - interval '1 minute', last_hot_at = now() - interval '5 days' WHERE target_id = '${PA}'`);
    await traffic(db, [hotA(1)]); // 期滿當天已經冷卻
    await seed(db);
    const gone = (await boost(db)) === undefined && sameTiers(await tiers(db), ORIGINAL); // 不開始新的觀察計時
    await traffic(db, [hotA(8)]); // 之後再次達標才開始
    await seed(db);
    const b = (await boost(db))!;
    const fresh = await one<{ ok: boolean }>(db, `SELECT boosted_since >= now() - interval '1 minute' AS ok FROM page_traffic_boosts WHERE target_id = $1`, [PA]);
    return gone && b.paused_until === null && fresh.ok && (await tiers(db)).aa_term === 1;
  });

  await g("empty_period_not_paused", async () => {
    // 達標、有狀態列，但名下已經沒有任何可提層的缺口（lifted 是空的）：沒提層過就不算「無產出」
    await db.exec(`DELETE FROM _b_term_policies; DELETE FROM _b_dup; DELETE FROM _b_handover_missing; DELETE FROM _b_lineage_roles; DELETE FROM _b_policy_elements; DELETE FROM _b_mismatch; DELETE FROM _b_legacy`);
    await traffic(db, [hotA()]);
    await db.exec(`INSERT INTO page_traffic_boosts (kind, target_id, boosted_since, last_hot_at, lifted_task_ids) VALUES ('politician', '${PA}', now() - interval '20 days', now(), '{}')`);
    await seed(db);
    return (await boost(db))!.paused_until === null;
  });

  await g("new_period_starts_at_first_lift", async () => {
    // 狀態列是空的一期（20 天前建的），這時才第一次有缺口被提層：觀察從現在才開始，不會當場被判 14 天無產出
    await traffic(db, [hotA()]);
    await db.exec(`INSERT INTO page_traffic_boosts (kind, target_id, boosted_since, last_hot_at, lifted_task_ids) VALUES ('politician', '${PA}', now() - interval '20 days', now(), '{}')`);
    await seed(db);
    const b = (await boost(db))!;
    const fresh = await one<{ ok: boolean }>(db, `SELECT boosted_since >= now() - interval '1 minute' AS ok FROM page_traffic_boosts WHERE target_id = $1`, [PA]);
    return b.paused_until === null && fresh.ok && b.lifted_task_ids.length === PA_LIFTED.length && (await tiers(db)).aa_term === 1;
  });

  await g("boosted_view_requires_hot", async () => {
    await traffic(db, [hotA()]);
    await seed(db);
    const listed = async () => (await rows(db, `SELECT 1 FROM page_traffic_boosted_tasks`)).length;
    const hot = (await listed()) === PA_LIFTED.length;
    // 流量退了、還沒跑下一輪 seed：任務的層還是前段，但已經不是「因流量」排前段
    await traffic(db, [hotA(1)]);
    const cold = (await listed()) === 0;
    await traffic(db, [hotA()]);
    const back = (await listed()) === PA_LIFTED.length;
    await db.exec(`UPDATE traffic_boost_settings SET enabled = false WHERE id = 1`);
    return hot && cold && back && (await listed()) === 0;
  });

  return v;
}

Deno.test("B1 行為層：達標提層、退了回層、時效、暫停、產出、設定是資料、parity、RPC（每條都要綠）", async () => {
  const db = await buildDb();
  const v = await runSuite(db);
  const bad = GUARDS.filter((n) => v[n] !== true);
  assertEquals(bad, [], `不綠的守門：${bad.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...GUARDS].sort(), "GUARDS 清單與實際跑的守門一致");
});

// ============================================================
// C. 還原驗證：把 migration 改壞一處，對應的守門必須紅
// ============================================================
const SEED_CALL = "  PERFORM traffic_boost_apply();\n";
const MUTATIONS: { why: string; from: string; to: string; times?: number; also?: [string, string]; red: (typeof GUARDS[number])[] }[] = [
  { why: "seed 不呼叫提層", from: SEED_CALL, to: "", red: ["hot_lifts_all_shapes", "policy_page_lifts", "new_gap_born_lifted"] },
  { why: "門檻變成大於（剛好 5 人不算）", from: "AND t.users >= s.min_users", to: "AND t.users > s.min_users", red: ["threshold_exact", "hot_lifts_all_shapes"] },
  { why: "不看時間窗是否一致", from: "   AND t.window_days = s.window_days\n", to: "", red: ["returns_when_window_changes"] },
  { why: "不看資料時效", from: "   AND t.updated_at > now() - make_interval(hours => s.stale_after_hours)", to: "   AND true", red: ["returns_when_stale"] },
  { why: "不暫停", from: "   WHERE b.paused_until IS NULL AND cardinality(b.lifted_task_ids) > 0\n     AND EXISTS (SELECT 1 FROM _tb_hot h WHERE h.kind = b.kind AND h.target_id = b.target_id)\n     AND GREATEST(", to: "   WHERE false AND b.paused_until IS NULL\n     AND EXISTS (SELECT 1 FROM _tb_hot h WHERE h.kind = b.kind AND h.target_id = b.target_id)\n     AND GREATEST(", red: ["pauses_without_yield", "no_change_not_yield", "rejected_not_yield", "old_contribution_not_yield"] },
  { why: "暫停期滿不重新計", from: "   WHERE b.paused_until IS NOT NULL AND b.paused_until <= now()\n     AND EXISTS (SELECT 1 FROM _tb_hot h", to: "   WHERE false AND b.paused_until IS NOT NULL AND b.paused_until <= now()\n     AND EXISTS (SELECT 1 FROM _tb_hot h", also: ["  DELETE FROM page_traffic_boosts b WHERE b.paused_until IS NOT NULL AND b.paused_until <= now();", "  DELETE FROM page_traffic_boosts b WHERE false;"], red: ["resumes_after_pause"] },
  { why: "no_change 也算產出", from: "c.contribution_type NOT IN ('no_change', 'task_suggestion')", to: "c.contribution_type NOT IN ('task_suggestion')", times: 2, red: ["no_change_not_yield"] },
  { why: "rejected 也算產出", from: "AND c.status <> 'rejected'", to: "", times: 2, red: ["rejected_not_yield", "yield_recomputed_after_rejection"] },
  { why: "被駁回後不重算（只在還有有效交件時才更新，沒有就留著舊值）", from: "     AND b.last_yield_at IS DISTINCT FROM (SELECT max(c.created_at)", to: "     AND EXISTS (SELECT 1 FROM contributions c WHERE c.task_id = ANY (b.lifted_task_ids) AND c.created_at >= b.boosted_since AND c.contribution_type NOT IN ('no_change', 'task_suggestion') AND c.status <> 'rejected')\n     AND b.last_yield_at IS DISTINCT FROM (SELECT max(c.created_at)", red: ["yield_recomputed_after_rejection"] },
  { why: "期滿而冷卻的也重新計時（不清掉）", from: "  DELETE FROM page_traffic_boosts b WHERE b.paused_until IS NOT NULL AND b.paused_until <= now();", to: "  UPDATE page_traffic_boosts b SET paused_until = NULL, boosted_since = now() - interval '15 days', lifted_task_ids = '{}' WHERE b.paused_until IS NOT NULL AND b.paused_until <= now();", red: ["expired_pause_cold_forgotten"] },
  { why: "沒提層過任何任務也判無產出", from: "WHERE b.paused_until IS NULL AND cardinality(b.lifted_task_ids) > 0", to: "WHERE b.paused_until IS NULL", red: ["empty_period_not_paused"] },
  { why: "空的一期第一次提層時不從現在重新計時", from: "SET boosted_since = CASE WHEN cardinality(page_traffic_boosts.lifted_task_ids) = 0 THEN now() ELSE page_traffic_boosts.boosted_since END,", to: "SET boosted_since = page_traffic_boosts.boosted_since,", red: ["new_period_starts_at_first_lift"] },
  { why: "視圖不看現在是否達標", from: "  JOIN page_traffic_hot h ON h.kind = b.kind AND h.target_id = b.target_id\n  JOIN traffic_boost_settings s ON s.id = 1\n  JOIN task_dispatches d", to: "  JOIN traffic_boost_settings s ON s.id = 1\n  JOIN task_dispatches d", red: ["boosted_view_requires_hot"] },
  { why: "traffic_boost_apply 沒收回 anon", from: "REVOKE ALL ON FUNCTION public.traffic_boost_apply() FROM anon;\n", to: "", red: ["function_privileges"] },
  { why: "traffic_boost_apply 沒收回 authenticated", from: "REVOKE ALL ON FUNCTION public.traffic_boost_apply() FROM authenticated;\n", to: "", red: ["function_privileges"] },
  { why: "traffic_boost_apply 沒收回 PUBLIC", from: "REVOKE ALL ON FUNCTION public.traffic_boost_apply() FROM PUBLIC;\n", to: "", red: ["function_privileges"] },
  { why: "replace_page_traffic 沒收回 PUBLIC", from: "REVOKE ALL ON FUNCTION public.replace_page_traffic(jsonb, integer) FROM PUBLIC;\n", to: "", red: ["function_privileges"] },
  { why: "RPC 不把 NULL 的人數當 0", from: "COALESCE(sum(x.users), 0)::INTEGER AS users, COALESCE(sum(x.views), 0)::INTEGER AS views", to: "sum(x.users)::INTEGER AS users, sum(x.views)::INTEGER AS views", red: ["rpc_null_metrics"] },
  { why: "產出不更新觀察起點（只看第一天）", from: "GREATEST(b.boosted_since, COALESCE(b.last_yield_at, b.boosted_since))", to: "b.boosted_since", red: ["yield_counts", "yield_rolls_window"] },
  { why: "已在前段的缺口也開始計時、也被取代（不是 min）", from: "COALESCE(g.priority, v_default) > s.boost_tier\n            UNION\n            SELECT g.task_id, 'pe:' || e", to: "true\n            UNION\n            SELECT g.task_id, 'pe:' || e", red: ["front_gap_not_counted", "min_of_original_and_boost", "hot_lifts_all_shapes"] },
  { why: "提層寫死前段", from: "UPDATE _gaps g SET priority = s.boost_tier,", to: "UPDATE _gaps g SET priority = 1,", red: ["min_of_original_and_boost"] },
  { why: "參選紀錄 id 陣列對不上", from: "SELECT g.task_id, 'pe:' || e\n", to: "SELECT g.task_id, 'xx:' || e\n", red: ["hot_lifts_all_shapes"] },
  { why: "參選紀錄 id 單值對不上", from: "SELECT g.task_id, 'pe:' || (g.target->>'politician_election_id')", to: "SELECT g.task_id, 'xx:' || (g.target->>'politician_election_id')", red: ["hot_lifts_all_shapes"] },
  { why: "人物頁不涵蓋名下政見", from: "JOIN policies pl ON pl.politician_id = h.target_id::UUID WHERE h.kind = 'politician'", to: "JOIN policies pl ON pl.politician_id = h.target_id::UUID WHERE false", red: ["hot_lifts_all_shapes", "boosted_view"] },
  { why: "只看第一個 uuid（target 整份比對變成只比 politician_id 欄）", from: "regexp_matches(g.target::TEXT, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g')", to: "regexp_matches(coalesce(g.target->>'politician_id', ''), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g')", red: ["hot_lifts_all_shapes"] },
  { why: "提層黏住：退了、過期了也照提（只看狀態列，不看現在達不達標）", from: "WHERE g.task_id IN (SELECT p.task_id FROM _tb_pages p JOIN page_traffic_boosts b ON b.kind = p.kind AND b.target_id = p.target_id WHERE b.paused_until IS NULL);", to: "WHERE g.task_id IN (SELECT p.task_id FROM _tb_pages p JOIN page_traffic_boosts b ON b.kind = p.kind AND b.target_id = p.target_id WHERE b.paused_until IS NULL) OR g.task_id IN (SELECT unnest(lifted_task_ids) FROM page_traffic_boosts WHERE paused_until IS NULL);", red: ["returns_when_cold", "returns_when_stale", "returns_when_window_changes"] },
  { why: "狀態列永不清掉", from: "DELETE FROM page_traffic_boosts b WHERE b.paused_until IS NULL AND b.last_hot_at < now() - make_interval(days => s.no_yield_days);", to: "DELETE FROM page_traffic_boosts b WHERE false;", red: ["forgets_after_cold"] },
  { why: "退了再回來每次都重新計時", from: "SET boosted_since = CASE WHEN cardinality(page_traffic_boosts.lifted_task_ids) = 0 THEN now() ELSE page_traffic_boosts.boosted_since END,", to: "SET boosted_since = now(),", red: ["continues_same_period"] },
  { why: "停用開關不管用（函式與視圖都不看 enabled）", from: "IF NOT FOUND OR NOT s.enabled THEN RETURN 0; END IF;", to: "IF NOT FOUND THEN RETURN 0; END IF;", also: [" WHERE s.enabled\n", " WHERE true\n"], red: ["disabled_does_nothing"] },
  { why: "把門檻寫死回視圖", from: "AND t.users >= s.min_users", to: "AND t.users >= 5", red: ["settings_are_data"] },
  { why: "把暫停天數寫死回函式", from: "now() + make_interval(days => s.pause_days)", to: "now() + make_interval(days => 14)", red: ["settings_are_data"] },
  { why: "把無產出天數寫死回函式", from: "<= now() - make_interval(days => s.no_yield_days);\n\n  -- f.", to: "<= now() - make_interval(days => 14);\n\n  -- f.", red: ["settings_are_data"] },
  { why: "無條件提層（不看達標頁）", from: "WHERE g.task_id IN (SELECT p.task_id FROM _tb_pages p JOIN page_traffic_boosts b ON b.kind = p.kind AND b.target_id = p.target_id WHERE b.paused_until IS NULL);", to: "WHERE true;", red: ["unrelated_traffic_parity", "hot_lifts_all_shapes"] },
  { why: "設定表沒有審計", from: "CREATE TRIGGER trg_traffic_boost_settings_audit AFTER INSERT OR UPDATE OR DELETE ON traffic_boost_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();", to: "", red: ["audit_on_settings"] },
  { why: "RPC 不核對時間窗", from: "IF v_window IS NULL OR p_window_days IS DISTINCT FROM v_window THEN", to: "IF v_window IS NULL THEN", red: ["rpc_rejects"] },
  { why: "RPC 不清掉這次沒出現的", from: "DELETE FROM public.page_traffic t WHERE NOT EXISTS", to: "DELETE FROM public.page_traffic t WHERE false AND NOT EXISTS", red: ["rpc_replace"] },
  { why: "RPC 不合併重複的鍵", from: "     GROUP BY x.kind, lower(x.target_id);", to: "     GROUP BY x.kind, x.target_id;", red: ["rpc_replace"] },
];

for (const [i, m] of MUTATIONS.entries()) {
  Deno.test(`C${i + 1} 還原驗證：${m.why}`, async () => {
    const once = (sql: string, from: string, to: string) => {
      if (!m.times) return mutate(sql, from, to);
      assertEquals(sql.split(from).length - 1, m.times, `要改的字串必須剛好出現 ${m.times} 次：${from.slice(0, 60)}`);
      return sql.replaceAll(from, to);
    };
    const db = await buildDb((s) => (m.also ? mutate(once(s, m.from, m.to), m.also[0], m.also[1]) : once(s, m.from, m.to)));
    const v = await runSuite(db);
    for (const name of m.red) assert(v[name] === false, `改壞「${m.why}」之後守門 ${name} 必須紅，實際是 ${v[name]}`);
  });
}

Deno.test("C0 沒套這支 migration 時守門跑不出全綠（測的是這支的東西）", async () => {
  // 把這支改成「只有設定表，沒有任何函式」：seed 退回舊版，提層守門全紅
  const db = await buildDb((s) => mutate(s, SEED_CALL, "").replace("IF NOT FOUND OR NOT s.enabled THEN RETURN 0; END IF;", "RETURN 0;"));
  const v = await runSuite(db);
  assert(v.hot_lifts_all_shapes === false && v.policy_page_lifts === false);
});
