/**
 * 總表輔助函式 roster_unit_findings、roster_gap_units 切 live（migration 20261128070000_roster_helper_live.sql）守門。
 *
 *   A 文字層：新的 tail 本體＝20261128040000 的 tail 只改三處（fnd、gapu、通用 live 分支排除）、set_mode 放行兩支輔助函式、
 *     開頭註解寫了原因／每日呼叫量變化／回滾、沒有新排程與觸發器
 *   B 等價（PGlite）：同一份資料，兩支都是 live 時新 tail 的輸出與「前一版 tail（即時算）」雙向差集為 0（含 findings_only、只有缺口的單位、
 *     村里長、已投票、items／kinds／origin_task_ids），還原函式與原函式逐列相同
 *   C 事件之後：常駐表沒更新時 tail 讀的是常駐表（與即時算不同）；對該臂同步後又相同；新增、修改、刪除三種都驗
 *   D 回滾：切回 shadow，tail 立刻回到即時算（即使常駐表是舊的）
 *   E 還原驗證：拿掉通用分支的排除、讓 fnd 永遠讀常駐表、還原函式把 arm 算錯、常駐表少一列，對應的比對都必須變紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const PR1 = "20261126170000_dispatch_gaps_phase0.sql";
const PHASE0B = "20261126180000_dispatch_gaps_phase0b.sql";
const TAIL_MIG = "20261128040000_arms_tail_function.sql";
const MIG_NAME = "20261128070000_roster_helper_live.sql";
const pr1 = await readMig(PR1);
const phase0b = await readMig(PHASE0B);
const tailMig = await readMig(TAIL_MIG);
const mig = await readMig(MIG_NAME);
const body = (fn: string) => fn.slice(fn.indexOf("AS $$") + 5, fn.lastIndexOf("$$"));
const OLD_TAIL = fnText(tailMig, "contribution_auto_tasks_arms_tail");
const NEW_TAIL = fnText(mig, "contribution_auto_tasks_arms_tail");

// ============================================================
// A 文字層
// ============================================================
Deno.test("A1 新 tail 本體＝20261128040000 的 tail 只改三處（fnd、gapu、通用 live 分支排除），其餘逐字相同", () => {
  let expected = body(OLD_TAIL);
  expected = mutate(
    expected,
    "       fnd AS MATERIALIZED (SELECT * FROM roster_unit_findings() WHERE roster_unify_on()),\n",
    body(NEW_TAIL).slice(body(NEW_TAIL).indexOf("       fnd AS MATERIALIZED"), body(NEW_TAIL).indexOf("       -- <<< 名單清查收斂\n       tagged0")),
  );
  expected = mutate(
    expected,
    "       gapu AS MATERIALIZED (SELECT * FROM roster_gap_units() WHERE roster_unify_on()),\n",
    body(NEW_TAIL).slice(body(NEW_TAIL).indexOf("       gapu AS MATERIALIZED"), body(NEW_TAIL).indexOf("       gapfresh AS MATERIALIZED")),
  );
  expected = mutate(
    expected,
    "     AND g.arm NOT LIKE 'raw:%' AND g.arm <> 'deadline_due' AND contribution_arm_selected(p_arms, g.arm)\n",
    "     AND g.arm NOT LIKE 'raw:%' AND g.arm <> 'deadline_due' AND g.arm NOT IN ('roster_unit_findings', 'roster_gap_units') AND contribution_arm_selected(p_arms, g.arm)\n",
  );
  // 說明用的註解行不算本體差異：兩邊都拿掉「20261128070000」開頭的註解行再比
  const strip = (s: string) => s.split("\n").filter((l) => !l.includes("20261128070000")).join("\n");
  assertEquals(strip(body(NEW_TAIL)), strip(expected));
});

Deno.test("A2 fnd、gapu 是二段式：live 讀還原函式、否則即時算；兩段各有一次性條件", () => {
  const b = body(NEW_TAIL);
  for (const [fn, restore] of [["roster_unit_findings", "dispatch_gap_rows_roster_unit_findings"], ["roster_gap_units", "dispatch_gap_rows_roster_gap_units"]]) {
    assert(b.includes(`FROM ${fn}() WHERE roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = '${fn}')`), `${fn} 的即時算那段缺一次性條件`);
    assert(b.includes(`FROM ${restore}() WHERE roster_unify_on() AND EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = '${fn}')`), `${fn} 的常駐表那段缺條件`);
  }
});

Deno.test("A3 tail 與總表都帶 work_mem 與 hash_mem_multiplier；tail 簽名與前一版相同；是 tail 的最新定義", async () => {
  const pre = NEW_TAIL.slice(0, NEW_TAIL.indexOf("AS $$"));
  assert(pre.includes("SET work_mem = '16MB'") && pre.includes("SET hash_mem_multiplier = '1'"));
  const sig = (f: string) => /RETURNS TABLE \(([^)]*)\)/.exec(f)![1];
  assertEquals(sig(NEW_TAIL), sig(OLD_TAIL));
  assert(mig.includes("總表函式層級 SET 沒帶全"));
  assert(MIG_NAME > TAIL_MIG);
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms_tail(")) defining.push(n);
  assertEquals(defining.slice(-2), [TAIL_MIG, MIG_NAME], "tail 的最新定義不是這支：要以最新的為底重做");
});

Deno.test("A4 set_mode 放行兩支輔助函式切 live，其他不在 activity_arm_names() 的名字照舊擋", () => {
  const f = fnText(mig, "dispatch_gap_set_mode");
  assert(f.includes("p_arm IN ('roster_unit_findings', 'roster_gap_units')"));
  assert(f.includes("activity_arm_names()"));
});

Deno.test("A5 開頭註解寫了原因、每日呼叫量變化、回滾；沒有排程、觸發器，也沒有對外呼叫", () => {
  const head = mig.slice(0, mig.indexOf("SET LOCAL statement_timeout"));
  for (const must of ["為什麼", "每日呼叫量變化：0", "回滾", "dispatch_gap_set_mode('roster_unit_findings', 'shadow'", "行為變更", "最晚 1 小時"]) {
    assert(head.includes(must), `註解缺「${must}」`);
  }
  const code = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/cron\.schedule\(|CREATE TRIGGER|net\.http_/i.test(code), "不新增排程、觸發器或對外呼叫");
});

Deno.test("A6 切 live 前先對齊（reconcile 套用）、檢查還原函式與原函式雙向差集、開著的列數等於即時筆數，才 set_mode live", () => {
  const i = (s: string) => mig.indexOf(s);
  assert(i("dispatch_gap_reconcile_arm('roster_unit_findings', true, 'reconcile', '0 seconds')") > 0);
  assert(i("dispatch_gap_reconcile_arm('roster_gap_units', true, 'reconcile', '0 seconds')") > 0);
  assert(i("dispatch_gap_reconcile_arm('roster_unit_findings'") < i("PERFORM dispatch_gap_set_mode('roster_unit_findings', 'live'"));
  assert(i("EXCEPT SELECT * FROM dispatch_gap_rows_roster_unit_findings()") > 0 && i("EXCEPT SELECT * FROM roster_unit_findings()") > 0);
  assert(i("EXCEPT SELECT * FROM dispatch_gap_rows_roster_gap_units()") > 0 && i("EXCEPT SELECT * FROM roster_gap_units()") > 0);
  assert(mig.includes("切 live 前對齊失敗"));
});

// ============================================================
// B～E PGlite
// ============================================================
const ARM_FNS = [
  "dup", "legacy", "mismatch", "policy_dup", "not_running", "mayor_policies", "term_policies", "roster_villages", "township_gap",
  "region_gap", "elected_missing", "roster_cec_gap", "district_seats", "policy_elements", "lineage_candidates", "handover_missing",
  "lineage_roles", "lineage_links", "career_sources", "withdrawn_filing", "party_gap", "party_roster", "party_info",
  "placeholder_politicians", "election_results", "owner_mismatch", "ballot_numbers", "regional_stats_missing", "issue_too_broad",
  "lineage_status", "lineage_stances", "lineage_events",
];
const ARM_NAMES = [
  "raw:policy_missing", "raw:profile_gap", "raw:policy_validity", "raw:progress_stale", "raw:candidacy_source_missing", "raw:roster_check",
  "raw:policy_election_missing", "raw:candidate_status_stale", ...ARM_FNS.slice(0, 14), "deadline_due", ...ARM_FNS.slice(14),
  "manual_visitor", "manual_open", "traffic:progress_stale", "traffic:deadline_due", "traffic:term_policies",
];
const RET = "RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT) LANGUAGE sql STABLE";
const SEL = "SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows";
const FND_COLS = "task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT, voted BOOLEAN, items JSONB, items_count INTEGER, kinds JSONB, origin_task_ids TEXT[], target JSONB, what_we_need TEXT, hint_sources TEXT[]";
const GAPU_COLS = "task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT, items JSONB, items_count INTEGER, kinds JSONB, target JSONB, what_we_need TEXT, hint_sources TEXT[]";

const ENV = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE fake_rows (src TEXT, task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT);
${ARM_FNS.map((n) => `CREATE FUNCTION contribution_auto_tasks_${n}() ${RET} AS $f$ ${SEL} WHERE src = '${n}' $f$;`).join("\n")}
CREATE FUNCTION contribution_auto_tasks_raw() ${RET} AS $f$ ${SEL} WHERE src = 'raw' $f$;
CREATE FUNCTION contribution_auto_tasks_deadline_due() ${RET} AS $f$ ${SEL} WHERE src = 'deadline_due' $f$;
CREATE FUNCTION contribution_auto_tasks_manual(p_visitor BOOLEAN) ${RET} AS $f$ ${SEL} WHERE src = CASE WHEN p_visitor THEN 'manual_visitor' ELSE 'manual_open' END $f$;
CREATE FUNCTION activity_arm_names() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $f$ SELECT ARRAY[${ARM_NAMES.map((n) => `'${n}'`).join(",")}]::TEXT[] $f$;
CREATE TABLE roster_flag (on_ BOOLEAN NOT NULL);
INSERT INTO roster_flag VALUES (false);
CREATE FUNCTION roster_unify_on() RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT on_ FROM roster_flag $f$;
CREATE TABLE fake_fnd (${FND_COLS});
CREATE FUNCTION roster_unit_findings() RETURNS TABLE (${FND_COLS}) LANGUAGE sql STABLE AS $f$ SELECT * FROM fake_fnd $f$;
CREATE TABLE fake_gapu (${GAPU_COLS});
CREATE FUNCTION roster_gap_units() RETURNS TABLE (${GAPU_COLS}) LANGUAGE sql STABLE AS $f$ SELECT * FROM fake_gapu $f$;
CREATE TABLE fake_fresh (tid TEXT);
CREATE FUNCTION roster_gap_fresh_units() RETURNS SETOF TEXT LANGUAGE sql STABLE AS $f$ SELECT tid FROM fake_fresh $f$;
CREATE FUNCTION roster_scope_covers(TEXT, TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION roster_unify_text(INTEGER, BOOLEAN) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT 'u' $f$;
CREATE FUNCTION roster_unify_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT jsonb_build_object('items_count', $3, 'uni', true, 'items', $2, 'kinds', $4) $f$;
CREATE FUNCTION roster_gap_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT jsonb_build_object('gap_n', $3, 'gap_items', $2, 'gap_kinds', $4) $f$;
CREATE FUNCTION roster_gap_text() RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT 'g' $f$;
CREATE FUNCTION roster_gap_tid(TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT $1 $f$;
CREATE TABLE politicians (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, birth_year INTEGER, status TEXT);
CREATE TABLE politician_elections (id SERIAL PRIMARY KEY, politician_id UUID, election_id INTEGER, election_type TEXT, candidacy_status TEXT);
CREATE FUNCTION politician_name_is_placeholder(TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT $1 LIKE '測試%' $f$;
CREATE TABLE activity_rules (activity TEXT, enabled BOOLEAN, except_election_types TEXT[], election_types TEXT[]);
CREATE FUNCTION traffic_watch_source_arms() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $f$ SELECT ARRAY['raw:progress_stale','deadline_due','term_policies']::TEXT[] $f$;
CREATE TABLE traffic_watch_levels (election_type TEXT, enabled BOOLEAN);
INSERT INTO traffic_watch_levels VALUES ('村里長', true);
CREATE FUNCTION traffic_watch_arm(TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $f$ SELECT 'traffic:' || regexp_replace($1, '^raw:', '') $f$;
CREATE FUNCTION election_id_or_null(TEXT) RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $f$ SELECT NULLIF(regexp_replace($1, '\\D', '', 'g'), '')::INTEGER $f$;
CREATE FUNCTION uuid_or_null(TEXT) RETURNS UUID LANGUAGE sql IMMUTABLE AS $f$ SELECT CASE WHEN $1 ~ '^[0-9a-f-]{36}$' THEN $1::UUID END $f$;
CREATE FUNCTION activity_require_rule(TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION activity_open(p_arm TEXT, p_eid INTEGER, p_etype TEXT)
  RETURNS TABLE (source TEXT, rule_id BIGINT, override_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE, open_until DATE)
  LANGUAGE sql STABLE AS $f$ SELECT 'rule', 7::BIGINT, NULL::BIGINT, NULL::TEXT, NULL::DATE, NULL::DATE, NULL::DATE $f$;
CREATE TABLE page_traffic_hot (kind TEXT, target_id TEXT);
CREATE TABLE seed_arm_timings (id BIGSERIAL PRIMARY KEY, run_started_at TIMESTAMPTZ NOT NULL, arm TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, row_count INTEGER, ok BOOLEAN NOT NULL DEFAULT true, error TEXT);
`;

// 兩支輔助臂在正式庫已登記（20261127044503），整表函式就是它們自己
const ARM_KEYS = `
INSERT INTO dispatch_gap_arm_keys (arm, full_fn, recompute_fn, key_expr_desc, key_example) VALUES
 ('roster_unit_findings', 'roster_unit_findings()', NULL, 'gap_key＝task_id', 'x'),
 ('roster_gap_units', 'roster_gap_units()', NULL, 'gap_key＝task_id', 'x')
ON CONFLICT (arm) DO NOTHING;
INSERT INTO dispatch_gap_arms (arm, mode, note) VALUES ('roster_unit_findings', 'shadow', 'x'), ('roster_gap_units', 'shadow', 'x') ON CONFLICT (arm) DO NOTHING;
`;

/** 涵蓋：已投票／未投票、村里長、鄉鎮有 town、items 多項、kinds 多種、origin_task_ids 有與沒有、findings_only 單位、只有缺口的單位、官方新鮮無缺口 */
const DATA = `
INSERT INTO politicians (id, name) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '王小明');
INSERT INTO fake_rows VALUES
 ('raw', 'auto:roster_check:2026:宜蘭縣:鄉鎮市長', 'roster_check', '{"election_type":"鄉鎮市長","election_id":2026}', 'need r1', NULL, 1, '宜蘭縣'),
 ('raw', 'auto:roster_check:2026:花蓮縣花蓮市:鄉鎮市長', 'roster_check', '{"election_type":"鄉鎮市長","election_id":2026}', 'need r2', NULL, 1, '花蓮縣'),
 ('raw', 'auto:roster_check:2026:花蓮縣:縣市長', 'roster_check', '{"election_type":"縣市長","election_id":2026}', 'need r3', NULL, 1, '花蓮縣'),
 ('roster_villages', 'auto:roster_check:2026:花蓮縣花蓮市:村里長', 'roster_check', '{"election_type":"村里長","election_id":2026}', 'villages', NULL, 1, '花蓮縣'),
 ('roster_cec_gap', 'auto:roster_check:2022:臺北市:縣市議員', 'roster_check', '{"election_type":"縣市議員","election_id":2022}', 'cec gap', NULL, 1, '臺北市'),
 ('dup', 'auto:dup:z1', 'dup', '{"politician_id":"22222222-2222-2222-2222-222222222222"}', 'need z', ARRAY['y'], 1, NULL);
INSERT INTO fake_fnd VALUES
 ('auto:roster_check:2026:宜蘭縣:鄉鎮市長', 'raw:roster_check', 2026, '鄉鎮市長', '宜蘭縣', '', '宜蘭縣', false,
  '[{"kind":"缺人","name":"甲"},{"kind":"縣市","name":"乙","current":"A","official":"B"}]', 2, '{"缺人":1,"縣市":1}', ARRAY['auto:township_gap:1','auto:region_gap:2'],
  '{"election_id":2026,"region":"宜蘭縣","findings_only":true,"voted":false}', 'f1 差異', ARRAY['h1','h2']),
 ('auto:roster_check:2026:花蓮縣花蓮市:村里長', 'roster_villages', 2026, '村里長', '花蓮縣', '花蓮市', '花蓮縣花蓮市', false,
  '[{"kind":"政黨","name":"丙"}]', 1, '{"政黨":1}', ARRAY[]::TEXT[],
  '{"election_id":2026,"region":"花蓮縣花蓮市","findings_only":true,"voted":false}', 'f2 差異', ARRAY['h3']),
 ('auto:roster_check:2022:臺北市:縣市議員', 'roster_cec_gap', 2022, '縣市議員', '臺北市', '', '臺北市', true,
  '[{"kind":"結果","name":"丁"}]', 1, '{"結果":1}', ARRAY['auto:election_results:9'],
  '{"election_id":2022,"region":"臺北市","findings_only":true,"voted":true}', 'f3 差異', ARRAY['h4','h5','h6']),
 ('auto:roster_check:2022:新北市:縣市議員', 'roster_cec_gap', 2022, '縣市議員', '新北市', '', '新北市', true,
  '[{"kind":"缺人","name":"戊"}]', 3, '{"缺人":3}', ARRAY[]::TEXT[],
  '{"election_id":2022,"region":"新北市","findings_only":true,"voted":true}', 'f4 只有差異沒有清查', ARRAY['h7']);
INSERT INTO fake_gapu VALUES
 ('auto:roster_check:2026:花蓮縣花蓮市:鄉鎮市長', 'raw:roster_check', 2026, '鄉鎮市長', '花蓮縣', '花蓮市', '花蓮縣花蓮市',
  '[{"kind":"缺人","name":"己"}]', 4, '{"缺人":4}',
  '{"election_id":2026,"region":"花蓮縣花蓮市","findings_only":true,"voted":false,"roster_gap":true}', 'g1 缺口', ARRAY['https://x/1','https://x/2']),
 ('auto:roster_check:2026:花蓮縣吉安鄉:村里長', 'roster_villages', 2026, '村里長', '花蓮縣', '吉安鄉', '花蓮縣吉安鄉',
  '[{"kind":"缺號次","name":"庚"}]', 5, '{"缺號次":5}',
  '{"election_id":2026,"region":"花蓮縣吉安鄉","findings_only":true,"voted":false,"roster_gap":true}', 'g2 只有缺口', ARRAY['https://x/3']);
INSERT INTO fake_fresh VALUES ('auto:roster_check:2026:花蓮縣花蓮市:鄉鎮市長');
INSERT INTO page_traffic_hot VALUES ('policy', 'pol-9');
`;

async function freshDb(opts: { unify?: boolean; mutateMig?: (s: string) => string; skipMig?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV);
  await db.exec(pr1);
  await db.exec(phase0b);
  await db.exec(ARM_KEYS);
  await db.exec(tailMig);
  await db.exec(DATA);
  if (opts.unify !== false) await db.exec("UPDATE roster_flag SET on_ = true");
  // 前一版 tail 複製成 old_tail()：新 migration 會把 contribution_auto_tasks_arms_tail 換掉，這份留著當 oracle（永遠即時算）
  // oracle 的 live_arms 排除兩支輔助臂：前一版 tail 沒有「輔助臂 live」這種狀態（它的通用 live 分支會把輔助臂的列漏進輸出，這正是新版要排除的），
  // 所以拿它當「兩支都是 shadow／即時算」的標準答案
  const oracle = mutate(
    OLD_TAIL.replace("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms_tail(", "CREATE OR REPLACE FUNCTION old_tail("),
    "live_arms AS MATERIALIZED (SELECT a.arm FROM dispatch_gap_arms a WHERE a.mode = 'live')",
    "live_arms AS MATERIALIZED (SELECT a.arm FROM dispatch_gap_arms a WHERE a.mode = 'live' AND a.arm NOT IN ('roster_unit_findings', 'roster_gap_units'))",
  );
  await db.exec(oracle);
  if (!opts.skipMig) await db.exec(opts.mutateMig ? opts.mutateMig(mig) : mig);
  return db;
}

const n = async (db: PGlite, sql: string) => Number((await db.query<{ v: number }>(`SELECT (${sql})::int AS v`)).rows[0].v);
const diffCount = async (db: PGlite, l: string, r: string) =>
  [await n(db, `SELECT count(*) FROM (SELECT * FROM ${l} EXCEPT SELECT * FROM ${r}) x`), await n(db, `SELECT count(*) FROM (SELECT * FROM ${r} EXCEPT SELECT * FROM ${l}) x`)];
const NEW = "contribution_auto_tasks_arms_tail(NULL::TEXT[], NULL::TEXT[])";
const OLD = "old_tail(NULL::TEXT[], NULL::TEXT[])";
const redWhen = async (f: () => Promise<boolean>) => { try { return await f(); } catch { return true; } };

// ============================================================
// B 等價
// ============================================================
Deno.test("B1 migration 跑完：兩支輔助函式都是 live，常駐表開著的列數等於即時筆數", async () => {
  const db = await freshDb();
  assertEquals(await n(db, "SELECT count(*) FROM dispatch_gap_arms WHERE mode = 'live' AND arm IN ('roster_unit_findings', 'roster_gap_units')"), 2);
  assertEquals(await n(db, "SELECT count(*) FROM dispatch_gaps WHERE arm = 'roster_unit_findings' AND closed_at IS NULL"), 4);
  assertEquals(await n(db, "SELECT count(*) FROM dispatch_gaps WHERE arm = 'roster_gap_units' AND closed_at IS NULL"), 2);
});

Deno.test("B2 還原函式與原函式逐列逐欄相同（雙向差集 0），而且不是空的", async () => {
  const db = await freshDb();
  assertEquals(await diffCount(db, "roster_unit_findings()", "dispatch_gap_rows_roster_unit_findings()"), [0, 0]);
  assertEquals(await diffCount(db, "roster_gap_units()", "dispatch_gap_rows_roster_gap_units()"), [0, 0]);
  assertEquals(await n(db, "SELECT count(*) FROM dispatch_gap_rows_roster_unit_findings()"), 4);
  assertEquals(await n(db, "SELECT count(*) FROM dispatch_gap_rows_roster_gap_units()"), 2);
  // 陣列的順序與空陣列、town 空字串都要保留
  const r = await db.query<{ o: string; t: string }>("SELECT origin_task_ids::text AS o, town AS t FROM dispatch_gap_rows_roster_unit_findings() WHERE task_id LIKE '%宜蘭縣:鄉鎮市長'");
  assertEquals([r.rows[0].o, r.rows[0].t], ["{auto:township_gap:1,auto:region_gap:2}", ""]);
});

for (const unify of [true, false]) {
  Deno.test(`B3 兩支都是 live（名單收斂${unify ? "開" : "關"}）：新 tail、新總表與前一版 tail（即時算）雙向差集為 0`, async () => {
    const db = await freshDb({ unify });
    const total = await n(db, `SELECT count(*) FROM ${OLD}`);
    assert(total >= 5, `假資料太少（${total} 列）`);
    assertEquals(await diffCount(db, NEW, OLD), [0, 0]);
    assertEquals(await diffCount(db, "contribution_auto_tasks_arms()", OLD), [0, 0]);
    assertEquals(await n(db, `SELECT count(*) FROM ${NEW}`), total);
  });
}

Deno.test("B4 這組資料真的走到名單族各段：掛 items、findings_only、只有缺口的單位；常駐表的列不會變成臂輸出", async () => {
  const db = await freshDb();
  const rows = (await db.query<{ task_id: string; arm: string; task_type: string }>(`SELECT task_id, arm, task_type FROM ${NEW}`)).rows;
  const has = (id: string) => rows.some((r) => r.task_id === id);
  assert(has("auto:roster_check:2026:宜蘭縣:鄉鎮市長"), "掛 items");
  assert(has("auto:roster_check:2022:新北市:縣市議員"), "findings_only 的單位");
  assert(has("auto:roster_check:2026:花蓮縣吉安鄉:村里長"), "只有缺口的單位");
  // 輔助臂名不會出現在輸出的 arm 欄（那是常駐表的臂名，不是臂輸出）；task_type 不得為空
  assert(!rows.some((r) => r.arm === "roster_unit_findings" || r.arm === "roster_gap_units"), "常駐表的輔助臂列漏進臂輸出");
  assert(rows.every((r) => r.task_type !== null), "有列沒有 task_type");
});

// ============================================================
// C 事件之後
// ============================================================
Deno.test("C1 常駐表還沒更新時 tail 讀常駐表（與即時算不同）；對該臂同步後又相同：新增、修改、刪除三種都驗", async () => {
  const db = await freshDb();
  // 新增一個單位、改一個單位的 items、刪一個單位
  await db.exec(`
    INSERT INTO fake_fnd VALUES ('auto:roster_check:2026:臺東縣:鄉鎮市長', 'raw:roster_check', 2026, '鄉鎮市長', '臺東縣', '', '臺東縣', false,
      '[{"kind":"缺人","name":"新"}]', 1, '{"缺人":1}', ARRAY[]::TEXT[], '{"election_id":2026,"region":"臺東縣","findings_only":true,"voted":false}', 'f5 新單位', ARRAY['h9']);
    UPDATE fake_fnd SET items = '[{"kind":"政黨","name":"改"}]', items_count = 9 WHERE task_id LIKE '%花蓮縣花蓮市:村里長';
    DELETE FROM fake_fnd WHERE task_id LIKE '%新北市%';`);
  const [a, b] = await diffCount(db, NEW, OLD);
  assert(a + b > 0, "常駐表沒更新時 tail 應該還是舊內容，與即時算不同");
  await db.exec("SELECT * FROM dispatch_gap_sync('roster_unit_findings', NULL, 'reconcile')");
  assertEquals(await diffCount(db, NEW, OLD), [0, 0]);

  await db.exec(`
    INSERT INTO fake_gapu VALUES ('auto:roster_check:2026:臺東縣:縣市長', 'raw:roster_check', 2026, '縣市長', '臺東縣', '', '臺東縣',
      '[{"kind":"缺人","name":"辛"}]', 2, '{"缺人":2}', '{"election_id":2026,"region":"臺東縣","findings_only":true,"voted":false,"roster_gap":true}', 'g3', ARRAY['https://x/9']);
    UPDATE fake_gapu SET items_count = 7, what_we_need = 'g2 改' WHERE task_id LIKE '%吉安鄉%';
    DELETE FROM fake_gapu WHERE task_id LIKE '%花蓮縣花蓮市%';`);
  const [c, d] = await diffCount(db, NEW, OLD);
  assert(c + d > 0, "gapu 常駐表沒更新時也應該與即時算不同");
  await db.exec("SELECT * FROM dispatch_gap_sync('roster_gap_units', NULL, 'reconcile')");
  assertEquals(await diffCount(db, NEW, OLD), [0, 0]);
});

Deno.test("C2 每小時比對對 live 臂是套用：shadow_compare 之後兩邊對齊", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO fake_fnd SELECT 'auto:roster_check:2026:屏東縣:鄉鎮市長', arm, 2026, election_type, '屏東縣', town, '屏東縣', voted, items, items_count, kinds, origin_task_ids, target, what_we_need, hint_sources FROM fake_fnd LIMIT 1");
  const [a, b] = await diffCount(db, NEW, OLD);
  assert(a + b > 0);
  // 20261127061500 之後 shadow_compare 對 live 臂 p_apply＝true；本測試環境只有 phase0 版（不套用），改用同一支底層函式驗證「套用」那一步
  await db.exec("SELECT dispatch_gap_reconcile_arm('roster_unit_findings', true, 'reconcile', '0 seconds')");
  assertEquals(await diffCount(db, NEW, OLD), [0, 0]);
});

// ============================================================
// D 回滾
// ============================================================
Deno.test("D1 切回 shadow：tail 立刻回到即時算（常駐表是舊的也一樣）；再切回 live 又讀常駐表", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO fake_fnd SELECT 'auto:roster_check:2026:屏東縣:鄉鎮市長', arm, 2026, election_type, '屏東縣', town, '屏東縣', voted, items, items_count, kinds, origin_task_ids, target, what_we_need, hint_sources FROM fake_fnd LIMIT 1");
  await db.exec("SELECT dispatch_gap_set_mode('roster_unit_findings', 'shadow', '回滾')");
  assertEquals(await diffCount(db, NEW, OLD), [0, 0]);
  await db.exec("SELECT dispatch_gap_set_mode('roster_unit_findings', 'live', 'again')");
  const [a, b] = await diffCount(db, NEW, OLD);
  assert(a + b > 0);
  // gapu 同理
  await db.exec("SELECT dispatch_gap_set_mode('roster_unit_findings', 'shadow', '回滾')");
  await db.exec("DELETE FROM fake_gapu WHERE task_id LIKE '%吉安鄉%'");
  await db.exec("SELECT dispatch_gap_set_mode('roster_gap_units', 'shadow', '回滾')");
  assertEquals(await diffCount(db, NEW, OLD), [0, 0]);
});

Deno.test("D2 回到 shadow 的輸出與沒有這支 migration 時（前一版 tail）完全相同", async () => {
  const db = await freshDb({ skipMig: true });
  const before = await n(db, `SELECT count(*) FROM ${OLD}`);
  await db.exec(mig);
  await db.exec("SELECT dispatch_gap_set_mode('roster_unit_findings', 'shadow', 'x'); SELECT dispatch_gap_set_mode('roster_gap_units', 'shadow', 'x')");
  assertEquals(await diffCount(db, NEW, OLD), [0, 0]);
  assertEquals(await n(db, `SELECT count(*) FROM ${NEW}`), before);
});

Deno.test("D3 set_mode：輔助函式可切 live；不在 activity_arm_names() 的其他名字照舊不能 live", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO dispatch_gap_arm_keys (arm, full_fn, key_expr_desc) VALUES ('not_a_union_branch', 'roster_unit_findings()', 'x')");
  let msg2 = "";
  try { await db.exec("SELECT dispatch_gap_set_mode('not_a_union_branch', 'live')"); } catch (e) { msg2 = String(e); }
  assert(msg2.includes("不是派工總表的 UNION 分支"), msg2);
  assertEquals(await db.query("SELECT dispatch_gap_set_mode('roster_gap_units', 'live') AS v").then((r) => (r.rows[0] as { v: string }).v), "live");
});

// ============================================================
// E 還原驗證：改壞一處，對應的比對必須變紅
// ============================================================
Deno.test("E1 常駐表少一列：與即時算不同", async () => {
  const db = await freshDb();
  await db.exec("UPDATE dispatch_gaps SET closed_at = now(), closed_reason = 'reconcile' WHERE arm = 'roster_unit_findings' AND gap_key LIKE '%宜蘭縣%'");
  const [a, b] = await diffCount(db, NEW, OLD);
  assert(a + b > 0, "少一列卻沒被抓到");
});

Deno.test("E2 通用 live 分支沒排除輔助臂：輔助臂的列漏進臂輸出，比對變紅", async () => {
  const db = await freshDb({ mutateMig: (s) => mutate(s, " AND g.arm NOT IN ('roster_unit_findings', 'roster_gap_units') AND contribution_arm_selected(p_arms, g.arm)", " AND contribution_arm_selected(p_arms, g.arm)") });
  const [a, b] = await diffCount(db, NEW, OLD);
  assert(a + b > 0, "沒排除卻沒被抓到");
});

Deno.test("E3 fnd 不管模式永遠讀常駐表：切回 shadow 後（常駐表是舊的）比對變紅", async () => {
  const db = await freshDb({
    mutateMig: (s) => mutate(s, "WHERE roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_unit_findings')", "WHERE false"),
  });
  await db.exec("DELETE FROM fake_fnd WHERE task_id LIKE '%新北市%'");
  await db.exec("SELECT dispatch_gap_set_mode('roster_unit_findings', 'shadow', '回滾')");
  // 這個壞版本在 shadow 時 fnd 變成兩段都不讀（第二段要 live）：輸出少了名單族的列
  const [a, b] = await diffCount(db, NEW, OLD);
  assert(a + b > 0, "fnd 壞掉卻沒被抓到");
});

Deno.test("E4 gapu 的常駐表段拿掉：live 時缺口單位整批消失，比對變紅", async () => {
  const db = await freshDb({
    mutateMig: (s) => mutate(s, "WHERE roster_unify_on() AND EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_gap_units')", "WHERE false"),
  });
  const [a, b] = await diffCount(db, NEW, OLD);
  assert(a + b > 0, "gapu 壞掉卻沒被抓到");
});

Deno.test("E5 還原函式把 arm 算錯（已投票沒走 roster_cec_gap）：migration 的自我檢查整支失敗", async () => {
  const red = await redWhen(async () => {
    await freshDb({ mutateMig: (s) => mutate(s, "CASE WHEN (g.payload ->> 'voted')::BOOLEAN THEN 'roster_cec_gap' WHEN", "CASE WHEN false THEN 'roster_cec_gap' WHEN") });
    return false;
  });
  assert(red, "還原函式壞掉卻沒被 migration 的檢查擋下");
});

Deno.test("E6 還原函式漏掉 origin_task_ids：migration 的自我檢查整支失敗", async () => {
  const red = await redWhen(async () => {
    await freshDb({ mutateMig: (s) => mutate(s, "THEN ARRAY(SELECT e.v FROM jsonb_array_elements_text(g.payload -> 'origin_task_ids') WITH ORDINALITY AS e(v, n) ORDER BY e.n)", "THEN ARRAY[]::TEXT[]") });
    return false;
  });
  assert(red, "還原函式漏欄卻沒被 migration 的檢查擋下");
});
