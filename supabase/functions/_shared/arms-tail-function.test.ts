/**
 * 派工總表後半段抽成函式（migration 20261128040000_arms_tail_function.sql）守門。純重構：輸出與前一版逐列相同。
 *
 *   A 文字層：前一版總表是 20261126180000、新函式本體拿掉「臂篩選」與「鍵篩選」之後與前一版逐字相同、
 *     總表只剩呼叫、兩支都帶 work_mem 與 hash_mem_multiplier、開頭註解、沒有接任何呼叫者
 *   B 全量等價（PGlite）：同一組假資料，新總表與新函式 (NULL, NULL) 對前一版總表雙向差集為 0，
 *     涵蓋名單清查收斂開關開／關、名單缺口、findings_only、測試名人物過濾、流量閘與 traffic: 改名、窗口關著、live 臂讀常駐表
 *   C 子集：對任一 (臂集合, 鍵集合) 呼叫的輸出 ＝ 全量輸出用同樣條件過濾後的結果（含名單族與流量閘的列）
 *   D 還原驗證：拿掉臂篩選、鍵篩選、名單族不剪的例外、某一段名單改寫，上面對應的比對都必須變紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const PR1 = "20261126170000_dispatch_gaps_phase0.sql";
const PREV_NAME = "20261126180000_dispatch_gaps_phase0b.sql";
const MIG_NAME = "20261128040000_arms_tail_function.sql";
const pr1 = await readMig(PR1);
const prevMig = await readMig(PREV_NAME);
const mig = await readMig(MIG_NAME);
const body = (fn: string) => fn.slice(fn.indexOf("AS $$") + 5, fn.lastIndexOf("$$"));
const PREV_TOTAL = fnText(prevMig, "contribution_auto_tasks_arms");
const TAIL = fnText(mig, "contribution_auto_tasks_arms_tail");
const NEW_TOTAL = fnText(mig, "contribution_auto_tasks_arms");

// ============================================================
// A 文字層
// ============================================================
Deno.test("A1 總表的前一版定義是 20261126180000，新版時間戳在它之後", async () => {
  assert(MIG_NAME > PREV_NAME);
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms(")) defining.push(n);
  assertEquals(defining.slice(defining.indexOf(MIG_NAME) - 1, defining.indexOf(MIG_NAME) + 1), [PREV_NAME, MIG_NAME], "總表的前一版變了：要以最新的為底重做");
});

/** 拿掉新增的臂篩選、src_arm、臂與鍵篩選區塊 */
const normalizeTail = (b: string) =>
  b.replace(/ (AND|WHERE) contribution_arm_selected\(p_arms, [^)]*\)/g, "")
    .replace(/,\n\s+k\.arm AS src_arm[^\n]*/, "")
    .replace(/\n\s+-- >>> 臂與鍵篩選[\s\S]*?-- <<< 臂與鍵篩選/, "");

Deno.test("A2 新函式本體：拿掉臂篩選與鍵篩選之後與前一版總表本體逐字相同", () => {
  assertEquals(normalizeTail(body(TAIL)), body(PREV_TOTAL));
  // 每支臂的分支都有篩選條件（至少 35 處：總表 36 個分支 − raw 與 live 分支另計）
  const n = (body(TAIL).match(/contribution_arm_selected\(p_arms, /g) ?? []).length;
  assert(n >= 35, `臂篩選條件只有 ${n} 處`);
  // 新增的東西都在標記裡，改了別的地方就不等於前一版（還原驗證）
  assert(normalizeTail(body(TAIL).replace("roster_gap_tid(t.task_id) = gu.task_id)", "roster_gap_tid(t.task_id) <> gu.task_id)")) !== body(PREV_TOTAL), "偷改名單缺口卻沒被抓到");
});

Deno.test("A3 總表只剩呼叫（NULL, NULL），簽名與欄位不變；兩支都帶 work_mem 與 hash_mem_multiplier", () => {
  assert(/SELECT \* FROM contribution_auto_tasks_arms_tail\(NULL::TEXT\[\], NULL::TEXT\[\]\)/.test(body(NEW_TOTAL)));
  const sig = (f: string) => /RETURNS TABLE \(([^)]*)\)/.exec(f)![1];
  assertEquals(sig(NEW_TOTAL), sig(PREV_TOTAL));
  assertEquals(sig(TAIL), sig(PREV_TOTAL));
  for (const f of [TAIL, NEW_TOTAL]) {
    const pre = f.slice(0, f.indexOf("AS $$"));
    assert(pre.includes("SET work_mem = '16MB'") && pre.includes("SET hash_mem_multiplier = '1'"), "SET 沒帶全");
  }
  assert(mig.includes("總表函式層級 SET 沒帶全"));
  assert(/contribution_auto_tasks_arms_tail\(p_arms TEXT\[\] DEFAULT NULL, p_keys TEXT\[\] DEFAULT NULL\)/.test(mig));
});

Deno.test("A4 開頭註解寫了為什麼、每日呼叫量變化、回滾；沒有排程、觸發器，也沒有接任何呼叫者", async () => {
  const head = mig.slice(0, mig.indexOf("CREATE OR REPLACE FUNCTION contribution_arm_selected"));
  for (const must of ["為什麼", "3-D", "每日呼叫量變化：0", "回滾", "contribution_auto_tasks_arms_v20261126", "roster_villages"]) assert(head.includes(must), `註解缺「${must}」`);
  const code = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/cron\.schedule\(|CREATE TRIGGER|net\.http_/i.test(code), "不新增排程、觸發器或對外呼叫");
  // 沒有任何其他 migration 或函式在用新函式（seed、drain 都沒接）
  for (const n of await migrationNames()) {
    if (n <= MIG_NAME || n === "20261128070000_roster_helper_live.sql") continue;  // 070000 是 tail 的後續版本（fnd／gapu 讀常駐表），守門在 roster-helper-live.test.ts
    assert(!(await readMig(n)).includes("contribution_auto_tasks_arms_tail"), `${n} 用了新函式：本期不接呼叫者`);
  }
});

// ============================================================
// B／C／D PGlite
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
CREATE TABLE fake_fnd (task_id TEXT, arm TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], county TEXT, voted BOOLEAN, items JSONB, items_count INTEGER, kinds JSONB);
CREATE FUNCTION roster_unit_findings() RETURNS TABLE (task_id TEXT, arm TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], county TEXT, voted BOOLEAN, items JSONB, items_count INTEGER, kinds JSONB)
  LANGUAGE sql STABLE AS $f$ SELECT * FROM fake_fnd $f$;
CREATE TABLE fake_gapu (task_id TEXT, arm TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], county TEXT, items JSONB, items_count INTEGER, kinds JSONB);
CREATE FUNCTION roster_gap_units() RETURNS TABLE (task_id TEXT, arm TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], county TEXT, items JSONB, items_count INTEGER, kinds JSONB)
  LANGUAGE sql STABLE AS $f$ SELECT * FROM fake_gapu $f$;
CREATE TABLE fake_fresh (tid TEXT);
CREATE FUNCTION roster_gap_fresh_units() RETURNS SETOF TEXT LANGUAGE sql STABLE AS $f$ SELECT tid FROM fake_fresh $f$;
CREATE FUNCTION roster_scope_covers(TEXT, TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION roster_unify_text(INTEGER, BOOLEAN) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT 'u' $f$;
CREATE FUNCTION roster_unify_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT jsonb_build_object('items_count', $3, 'uni', true) $f$;
CREATE FUNCTION roster_gap_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT jsonb_build_object('gap_n', $3) $f$;
CREATE FUNCTION roster_gap_text() RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT 'g' $f$;
CREATE FUNCTION roster_gap_tid(TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT $1 $f$;
CREATE TABLE politicians (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, birth_year INTEGER, status TEXT);
CREATE TABLE politician_elections (id SERIAL PRIMARY KEY, politician_id UUID, election_id INTEGER, election_type TEXT, candidacy_status TEXT);
CREATE TABLE policies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), politician_id UUID, title TEXT);
CREATE TABLE contributions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id TEXT, status TEXT, payload JSONB);
CREATE TABLE tracking_logs (id SERIAL PRIMARY KEY, policy_id UUID);
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
  LANGUAGE sql STABLE AS $f$ SELECT CASE WHEN p_arm = 'lineage_events' THEN NULL ELSE 'rule' END, 7::BIGINT, NULL::BIGINT, NULL::TEXT, NULL::DATE, NULL::DATE, NULL::DATE $f$;
CREATE TABLE page_traffic_hot (kind TEXT, target_id TEXT);
CREATE TABLE seed_arm_timings (id BIGSERIAL PRIMARY KEY, run_started_at TIMESTAMPTZ NOT NULL, arm TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, row_count INTEGER, ok BOOLEAN NOT NULL DEFAULT true, error TEXT);
`;

/** 一組涵蓋各種形狀的假資料 */
const DATA = `
INSERT INTO politicians (id, name) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '測試甲'), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '王小明');
INSERT INTO politician_elections (id, politician_id, election_id, election_type) VALUES (900, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 2026, '村里長');
INSERT INTO fake_rows VALUES
 ('raw', 'auto:policy_missing:p1', 'policy_missing', '{"politician_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","election_id":2026}', 'need a', ARRAY['u1','u2'], 3, '臺北市'),
 ('raw', 'auto:policy_missing:ph', 'policy_missing', '{"politician_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","election_id":2026}', 'placeholder person', NULL, 3, NULL),
 ('raw', 'auto:progress_stale:s1', 'progress_stale', '{"policy_id":"pol-1","election_type":"縣市長"}', 'need b', ARRAY['u3'], 2, NULL),
 ('raw', 'auto:progress_stale:v1', 'progress_stale', '{"policy_id":"pol-9","election_type":"村里長"}', 'village hot', NULL, 2, NULL),
 ('raw', 'auto:progress_stale:v2', 'progress_stale', '{"policy_id":"pol-8","election_type":"村里長"}', 'village cold', NULL, 2, NULL),
 ('raw', 'auto:roster_check:2026:u1', 'roster_check', '{"election_type":"鄉鎮市長","election_id":2026}', 'need r1', NULL, 1, '宜蘭縣'),
 ('raw', 'auto:roster_check:2026:u2', 'roster_check', '{"election_type":"鄉鎮市長","election_id":2026}', 'need r2', NULL, 1, '宜蘭縣'),
 ('raw', 'auto:roster_check:2026:u3', 'roster_check', '{"election_type":"縣市長","election_id":2026}', 'need r3', NULL, 1, '花蓮縣'),
 ('roster_villages', 'auto:roster_check:2026:v9', 'roster_check', '{"election_type":"村里長","election_id":2026}', 'villages', NULL, 1, '花蓮縣'),
 ('roster_cec_gap', 'auto:roster_check:2026:c1', 'roster_check', '{"election_type":"縣市議員","election_id":2026}', 'cec gap', NULL, 1, '臺北市'),
 ('deadline_due', 'auto:deadline_due:d1', 'deadline_due', '{"policy_id":"pol-1","election_type":"村里長"}', 'need d', ARRAY['u4'], 2, NULL),
 ('deadline_due', 'auto:deadline_due:d2', 'deadline_due', '{"policy_id":"pol-7","election_type":"村里長"}', 'need d7', NULL, 2, NULL),
 ('term_policies', 'auto:term_policy_missing:t1', 'term_policy_missing', '{"politician_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","election_id":2026}', 'term', NULL, 1, NULL),
 ('legacy', 'auto:legacy_audit:6f1c0000-0000-0000-0000-000000000001', 'legacy_audit', '{"id":"a"}', 'need l1', ARRAY['x'], 1, '臺北市'),
 ('legacy', 'auto:legacy_audit:6f1c0000-0000-0000-0000-000000000002', 'legacy_audit', '{"id":"b"}', 'need l2', NULL, 1, NULL),
 ('mismatch', 'auto:policy_election_mismatch:6f1c0000-0000-0000-0000-000000000003', 'policy_election_mismatch', '{}', 'need m', ARRAY[]::TEXT[], 1, NULL),
 ('issue_too_broad', 'auto:issue_too_broad:2026:臺北市:交通', 'issue_too_broad', '{"election_id":2026,"region":"臺北市"}', 'need i', ARRAY['h'], 2, '臺北市'),
 ('township_gap', 'auto:township_gap:t1', 'township_gap', '{"election_id":2026}', 'need t', NULL, 1, '花蓮縣'),
 ('party_roster', 'auto:party_roster:q1', 'party_roster', '{}', 'need q', NULL, 1, NULL),
 ('dup', 'auto:dup:z1', 'dup', '{"politician_id":"22222222-2222-2222-2222-222222222222"}', 'need z', ARRAY['y'], 1, NULL),
 ('ballot_numbers', 'auto:ballot_numbers:2026:縣市長:臺北市:', 'candidacy_source_missing', '{"election_id":2026}', 'need b', NULL, 1, '臺北市'),
 ('manual_visitor', '33333333-3333-3333-3333-333333333333', 'question', '{}', 'q', NULL, 5, NULL),
 ('manual_open', '44444444-4444-4444-4444-444444444444', 'manual', '{}', 'm', ARRAY['k'], 5, NULL),
 ('lineage_events', 'auto:lineage_event_missing:l:ab12cd34', 'lineage_event_missing', '{"lineage_id":"x"}', 'ev', NULL, 1, NULL),
 ('placeholder_politicians', 'auto:placeholder_politician:ph1', 'placeholder_politician', '{"politician_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}', 'ph', NULL, 1, NULL);
-- 名單族：u1 有名單缺口＋差異、v9 只有差異、u2 官方名冊新鮮且無缺口（開關開著時被收回）、f1 只有差異沒有清查（findings_only）、g2 只有缺口
INSERT INTO fake_fnd VALUES
 ('auto:roster_check:2026:u1', 'raw:roster_check', '{}', 'f', NULL, '宜蘭縣', true, '[]', 2, '{"x":1}'),
 ('auto:roster_check:2026:v9', 'roster_villages', '{}', 'f', NULL, '花蓮縣', false, '[]', 1, '{"x":1}'),
 ('auto:roster_check:2026:c1', 'raw:roster_check', '{}', 'f', NULL, '臺北市', false, '[]', 1, '{"x":1}'),
 ('auto:roster_check:2026:f1', 'raw:roster_check', '{"election_type":"鄉鎮市長","election_id":2026}', 'only findings', ARRAY['h'], '新北市', true, '[]', 3, '{"x":1}');
INSERT INTO fake_gapu VALUES
 ('auto:roster_check:2026:u1', 'raw:roster_check', '{}', 'gw', NULL, '宜蘭縣', '[]', 4, '{"缺人":1}'),
 ('auto:roster_check:2026:g2', 'raw:roster_check', '{"election_type":"縣市議員","election_id":2026}', 'only gap', NULL, '臺北市', '[]', 5, '{"缺人":1}');
INSERT INTO fake_fresh VALUES ('auto:roster_check:2026:u2');
INSERT INTO activity_rules VALUES ('raw:progress_stale', true, NULL, ARRAY['村里長']);
INSERT INTO page_traffic_hot VALUES ('policy', 'pol-9'), ('policy', 'pol-7');
`;

async function freshDb(opts: { unify?: boolean; live?: boolean; mutateTail?: (s: string) => string } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV);
  await db.exec(pr1);
  await db.exec(prevMig);
  // 前一版總表複製成 prev_total()：新版 migration 會把 contribution_auto_tasks_arms() 換掉，這份留著當 oracle
  await db.exec(PREV_TOTAL.replace("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "CREATE OR REPLACE FUNCTION prev_total()"));
  await db.exec(opts.mutateTail ? opts.mutateTail(mig) : mig);
  await db.exec(DATA);
  if (opts.unify) await db.exec("UPDATE roster_flag SET on_ = true");
  if (opts.live) {
    // legacy、raw:roster_check、deadline_due 切 live：這三支改讀常駐表（含 raw 與 deadline_due 兩個 CTE 的二選一）
    await db.exec(`
      UPDATE dispatch_gap_arms SET mode = 'live' WHERE arm IN ('legacy', 'raw:roster_check', 'deadline_due');
      INSERT INTO dispatch_gaps (arm, gap_key, scope_key, payload) VALUES
       ('legacy', 'auto:legacy_audit:6f1c0000-0000-0000-0000-000000000010', 'policy:6f1c0000-0000-0000-0000-000000000010',
        '{"task_type":"legacy_audit","target":{"id":"live"},"what_we_need":"live l","hint_sources":["z"],"reward":1,"region":"臺北市"}'),
       ('raw:roster_check', 'auto:roster_check:2026:u1', 'unit:u1',
        '{"task_type":"roster_check","target":{"election_type":"鄉鎮市長","election_id":2026},"what_we_need":"live r1","hint_sources":null,"reward":1,"region":"宜蘭縣"}'),
       ('deadline_due', 'auto:deadline_due:dl1', 'auto:deadline_due:dl1',
        '{"task_type":"deadline_due","target":{"policy_id":"pol-9","election_type":"村里長"},"what_we_need":"live d","hint_sources":null,"reward":2,"region":null}');`);
  }
  return db;
}

const n = async (db: PGlite, sql: string) => Number((await db.query<{ v: number }>(`SELECT (${sql})::int AS v`)).rows[0].v);
const A = (xs: string[] | null) => (xs ? `ARRAY[${xs.map((x) => `'${x.replaceAll("'", "''")}'`).join(",")}]::text[]` : "NULL::text[]");
const diffCount = async (db: PGlite, l: string, r: string) =>
  [await n(db, `SELECT count(*) FROM (SELECT * FROM ${l} EXCEPT SELECT * FROM ${r}) x`), await n(db, `SELECT count(*) FROM (SELECT * FROM ${r} EXCEPT SELECT * FROM ${l}) x`)];

const SCENARIOS: Array<[string, { unify?: boolean; live?: boolean }]> = [
  ["全 off、名單收斂關", {}],
  ["全 off、名單收斂開", { unify: true }],
  ["三支切 live、名單收斂關", { live: true }],
  ["三支切 live、名單收斂開", { live: true, unify: true }],
];

// ============================================================
// B 全量等價
// ============================================================
for (const [label, o] of SCENARIOS) {
  Deno.test(`B 全量等價（${label}）：新總表、新函式 (NULL, NULL) 與前一版總表雙向差集為 0，而且不是空的`, async () => {
    const db = await freshDb(o);
    const total = await n(db, "SELECT count(*) FROM prev_total()");
    assert(total >= 10, `假資料太少（${total} 列）`);
    assertEquals(await diffCount(db, "contribution_auto_tasks_arms()", "prev_total()"), [0, 0]);
    assertEquals(await diffCount(db, "contribution_auto_tasks_arms_tail(NULL, NULL)", "prev_total()"), [0, 0]);
    assertEquals(await n(db, "SELECT count(*) FROM contribution_auto_tasks_arms()"), total);
    // 旗標開著時（seed 用）：被規則濾掉的列也要一致
    await db.exec("SET gap.arms_all = 'on'");
    assertEquals(await diffCount(db, "contribution_auto_tasks_arms()", "prev_total()"), [0, 0]);
    assert((await n(db, "SELECT count(*) FROM prev_total()")) > total, "旗標開著應多回被濾掉的列");
  });
}

Deno.test("B 這組假資料真的走到各段：流量閘留下 hot、拿掉 cold，改名 traffic:；測試名人物被擋；窗口關著的被擋；名單族掛 items／findings_only／gap", async () => {
  const db = await freshDb({ unify: true });
  const arms = async (sql: string) => (await db.query<{ task_id: string; arm: string }>(sql)).rows;
  const all = await arms("SELECT task_id, arm FROM contribution_auto_tasks_arms()");
  const has = (id: string, arm?: string) => all.some((r) => r.task_id === id && (arm === undefined || r.arm === arm));
  assert(has("auto:progress_stale:v1", "traffic:progress_stale") && !has("auto:progress_stale:v2"), "流量閘");
  assert(!has("auto:policy_missing:ph") && has("auto:policy_missing:p1"), "測試名人物");
  assert(has("auto:placeholder_politician:ph1"), "placeholder_politicians 不被擋");
  assert(!has("auto:lineage_event_missing:l:ab12cd34"), "窗口關著的臂");
  assert(has("auto:roster_check:2026:f1") && has("auto:roster_check:2026:g2"), "findings_only 與只有缺口的單位");
  assert(!has("auto:roster_check:2026:u2"), "官方名冊新鮮且無缺口的單位被收回");
  assert(!has("auto:township_gap:t1") && !has("auto:party_roster:q1"), "名單收斂開著時七支臂被閘掉");
  const t = (await db.query<{ target: Record<string, unknown> }>("SELECT target FROM contribution_auto_tasks_arms() WHERE task_id = 'auto:roster_check:2026:u1'")).rows[0].target;
  assertEquals([t.uni, t.gap_n], [true, 4]);
});

// ============================================================
// C 子集＝全量過濾
// ============================================================
const SUBSETS: Array<[string, string[] | null, string[] | null]> = [
  ["單一臂 dup", ["dup"], null],
  ["兩臂 dup＋issue_too_broad", ["dup", "issue_too_broad"], null],
  ["legacy（live 時讀常駐表）", ["legacy"], null],
  ["名單族 raw:roster_check", ["raw:roster_check"], null],
  ["名單族 roster_villages", ["roster_villages"], null],
  ["名單族 roster_cec_gap＋dup", ["roster_cec_gap", "dup"], null],
  ["來源臂 raw:progress_stale（含改名的 traffic 列）", ["raw:progress_stale"], null],
  ["流量臂 traffic:progress_stale", ["traffic:progress_stale"], null],
  ["deadline_due＋term_policies", ["deadline_due", "term_policies"], null],
  ["只剩被窗口擋掉的臂 lineage_events", ["lineage_events"], null],
  ["不存在的臂", ["不存在的臂"], null],
  ["只有鍵：一個 task_id", null, ["auto:dup:z1"]],
  ["只有鍵：政見鍵（legacy／mismatch 的 policy:）", null, ["policy:6f1c0000-0000-0000-0000-000000000001", "policy:6f1c0000-0000-0000-0000-000000000003"]],
  ["鍵含 '*'＝不限", null, ["*"]],
  ["臂與鍵交集", ["legacy", "dup"], ["auto:dup:z1"]],
  ["空陣列", [], null],
];

const subsetDiff = async (db: PGlite, arms: string[] | null, keys: string[] | null) => {
  const expected = `(SELECT * FROM contribution_auto_tasks_arms() f
     WHERE (${A(arms)} IS NULL OR f.arm = ANY (${A(arms)} || ARRAY(SELECT traffic_watch_arm(a) FROM unnest(${A(arms)}) a)))
       AND (${A(keys)} IS NULL OR '*' = ANY (${A(keys)}) OR dispatch_gap_scope_key(f.arm, f.task_id) = ANY (${A(keys)})))`;
  const got = `contribution_auto_tasks_arms_tail(${A(arms)}, ${A(keys)})`;
  return { diff: await diffCount(db, got, `${expected} e`), size: await n(db, `SELECT count(*) FROM ${got}`) };
};

for (const [label, o] of SCENARIOS) {
  Deno.test(`C 子集＝全量過濾（${label}）：每組 (臂, 鍵) 的輸出與全量用同樣條件過濾後逐列相同`, async () => {
    const db = await freshDb(o);
    let nonEmpty = 0;
    for (const [name, arms, keys] of SUBSETS) {
      const r = await subsetDiff(db, arms, keys);
      assertEquals(r.diff, [0, 0], `子集「${name}」與全量過濾後不同`);
      if (r.size > 0) nonEmpty++;
    }
    assert(nonEmpty >= 10, `非空的子集太少（${nonEmpty}）`);
  });
}

Deno.test("C 子集真的比全量小，而且指定的臂沒被多給、也沒漏（具體數字）", async () => {
  const db = await freshDb({ unify: true });
  const full = await n(db, "SELECT count(*) FROM contribution_auto_tasks_arms()");
  const dupOnly = await n(db, "SELECT count(*) FROM contribution_auto_tasks_arms_tail(ARRAY['dup'], NULL)");
  assertEquals(dupOnly, 1);
  assert(full > dupOnly);
  assertEquals(await n(db, "SELECT count(*) FROM contribution_auto_tasks_arms_tail(ARRAY['legacy'], NULL)"), 2);
  assertEquals(await n(db, "SELECT count(*) FROM contribution_auto_tasks_arms_tail(NULL, ARRAY['auto:dup:z1'])"), 1);
  // 被剪掉的臂函式整支不跑：把 dup 臂函式換成會丟錯的，選別的臂不會碰到它；選 dup 才會
  await db.exec("CREATE OR REPLACE FUNCTION contribution_auto_tasks_dup() RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT) LANGUAGE plpgsql STABLE AS $f$ BEGIN RAISE EXCEPTION 'dup 臂被呼叫'; END $f$");
  assertEquals(await n(db, "SELECT count(*) FROM contribution_auto_tasks_arms_tail(ARRAY['legacy'], NULL)"), 2);
  let threw = false;
  try { await n(db, "SELECT count(*) FROM contribution_auto_tasks_arms_tail(ARRAY['dup'], NULL)"); } catch { threw = true; }
  assert(threw, "選 dup 應該會碰到 dup 臂函式");
});

// ============================================================
// D 還原驗證：改壞一處，對應的比對必須變紅
// ============================================================
const REPLACE_ONCE = (s: string, from: string, to: string) => mutate(s, from, to);

Deno.test("D1 拿掉臂篩選：子集會多回別的臂的列", async () => {
  const db = await freshDb({ mutateTail: (s) => REPLACE_ONCE(s, "AND (p_arms IS NULL OR g.arm = ANY (p_arms) OR g.src_arm = ANY (p_arms))", "") });
  const r = await subsetDiff(db, ["dup"], null);
  assert(r.diff[0] + r.diff[1] > 0, "拿掉臂篩選卻沒被抓到");
});

Deno.test("D2 拿掉鍵篩選：只給鍵的子集會多回別的列", async () => {
  const db = await freshDb({ mutateTail: (s) => REPLACE_ONCE(s, "AND (p_keys IS NULL OR '*' = ANY (p_keys) OR dispatch_gap_scope_key(g.src_arm, g.task_id) = ANY (p_keys))", "") });
  const r = await subsetDiff(db, null, ["auto:dup:z1"]);
  assert(r.diff[0] + r.diff[1] > 0, "拿掉鍵篩選卻沒被抓到");
});

Deno.test("D3 名單族不剪的例外拿掉：選別的臂時 roster_villages 列被剪，名單收斂誤把已有清查的單位當成 findings_only", async () => {
  const db = await freshDb({
    unify: true,
    mutateTail: (s) => REPLACE_ONCE(s, "      OR p_arm IN ('roster_villages', 'roster_cec_gap', 'raw:roster_check')  -- 這三支的列是 roster_check，名單族彙總要拿它們比對，不能剪\n", ""),
  });
  // c1 是 roster_cec_gap 的清查列，差異彙總把它記在 raw:roster_check 名下：選 raw:roster_check 時，c1 的清查列不能被剪，
  // 不然單位彙總會以為這個單位沒有清查、多開一張 findings_only
  const r = await subsetDiff(db, ["raw:roster_check"], null);
  assert(r.diff[0] + r.diff[1] > 0, "拿掉例外卻沒被抓到");
});

Deno.test("D4 拿掉名單缺口那一段改寫：全量比對變紅", async () => {
  const db = await freshDb({
    unify: true,
    mutateTail: (s) => REPLACE_ONCE(s, "FROM gapu gu\n   WHERE NOT EXISTS (SELECT 1 FROM tagged t WHERE t.task_type = 'roster_check' AND roster_gap_tid(t.task_id) = gu.task_id)", "FROM gapu gu WHERE false"),
  });
  const d = await diffCount(db, "contribution_auto_tasks_arms()", "prev_total()");
  assert(d[0] + d[1] > 0, "拿掉名單缺口改寫卻沒被抓到");
});

Deno.test("D5 拿掉流量閘改名那一段：全量比對變紅", async () => {
  const db = await freshDb({
    mutateTail: (s) => REPLACE_ONCE(s, "THEN traffic_watch_arm(k.arm) ELSE k.arm END AS arm,", "THEN k.arm ELSE k.arm END AS arm,"),
  });
  const d = await diffCount(db, "contribution_auto_tasks_arms()", "prev_total()");
  assert(d[0] + d[1] > 0, "拿掉流量改名卻沒被抓到");
});

Deno.test("D6 拿掉測試名人物過濾：全量比對變紅", async () => {
  const db = await freshDb({
    mutateTail: (s) => REPLACE_ONCE(s, "OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)", "OR NOT (EXISTS (SELECT 1 FROM ph WHERE false)"),
  });
  const d = await diffCount(db, "contribution_auto_tasks_arms()", "prev_total()");
  assert(d[0] + d[1] > 0, "拿掉測試名人物過濾卻沒被抓到");
});
