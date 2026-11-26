/**
 * 派工臂事件驅動化 第 1 期 PR-1（migration 20261126193000_dispatch_gaps_phase1a.sql）守門。
 * 設計：docs/dispatch-arms-event-driven-plan.md 第 5 節「第 1 期」與附錄 A.1／A.3。
 *
 * 用 PGlite 真的把第 0 期兩支遷移與本支跑一遍；mismatch／issue_too_broad／legacy 三支臂用「現行真定義」
 * （從各自最新的遷移檔原文抽出來），其餘臂用假函式。驗：
 *   A 三支臂的最新定義沒被後來的遷移蓋掉；按鍵版與整表版本體只差鍵過濾（文字層）
 *   B 按鍵重算與整臂函式限定同鍵的結果雙向 EXCEPT 為 0（三支，各種缺口形狀）
 *   C 觸發器：各來源表 INSERT／UPDATE OF／DELETE 入列正確的 scope_key；不相關的更新不入列；events_enabled=false 不入列
 *   D drain：開、關、更新之後 dispatch_gaps 與整臂結果一致；證明走的是按鍵版（整表函式壞掉也能 drain）
 *   E 雙軌比對：shadow_run 只比三支、missing／extra／changed 為 0
 *   F 總表輸出與前一版（_v20261126）雙向 EXCEPT 為 0（三支 shadow、常駐表有資料）；drain 前後 seed 看到的總表輸出不變
 *   G 初始灌入：資料先在、遷移後才掛觸發器，常駐表馬上與整臂一致、補了整臂事件
 *   H 遷移文字守門：觸發器 UPDATE 一律 OF 欄位、高頻表有 WHEN、沒動總表與 seed、註解不含函式定義字樣、cron 分鐘
 *   I 觸發器成本（PGlite 計時，數字印在輸出）
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const PR1 = "20261126170000_dispatch_gaps_phase0.sql";
const PR2 = "20261126180000_dispatch_gaps_phase0b.sql";
const MIG_NAME = "20261126193000_dispatch_gaps_phase1a.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const pr1 = await read(PR1);
const pr2 = await read(PR2);
const mig = await read(MIG_NAME);
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ── 三支臂的最新定義（抽原文）──
const LEGACY_FILE = "20261126010000_seed_arms_slim.sql";
const MISMATCH_FILE = "20261011380000_mismatch_candidacy_sources.sql";
const ISSUE_FILE = "20261102010000_issue_subtopics.sql";
const slice = (src: string, from: string, to: string, inclusiveTo = false) => {
  const a = src.indexOf(from);
  assert(a >= 0, `找不到起點 ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert(b >= 0, `找不到終點 ${to}`);
  return src.slice(a, b + (inclusiveTo ? to.length : 0));
};
const legacySrc = slice(await read(LEGACY_FILE), "CREATE OR REPLACE FUNCTION contribution_auto_tasks_legacy()", "$function$;", true);
const mismatchSrc = slice(await read(MISMATCH_FILE), "CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()", "$function$;", true);
const issueSrc = slice(await read(ISSUE_FILE), "CREATE OR REPLACE FUNCTION issue_too_broad_threshold()", "COMMENT ON FUNCTION contribution_auto_tasks_issue_too_broad");
const issuesFns = slice(await read("20261031130000_issues_summary_page.sql"), "CREATE OR REPLACE FUNCTION issue_tag_is_junk", "-- 3. 議題清單");
const primaryUrlFn = slice(await read("20261007110000_sources_stage2b_read_side.sql"), "CREATE OR REPLACE FUNCTION policy_primary_url", "$$;", true);

// ── 假環境：真表的欄位只放臂函式與觸發器會碰到的 ──
const ARM_FNS = [
  "dup", "legacy", "mismatch", "policy_dup", "not_running", "mayor_policies", "term_policies", "roster_villages", "township_gap",
  "region_gap", "elected_missing", "roster_cec_gap", "district_seats", "policy_elements", "lineage_candidates", "handover_missing",
  "lineage_roles", "lineage_links", "career_sources", "withdrawn_filing", "party_gap", "party_roster", "party_info",
  "placeholder_politicians", "election_results", "owner_mismatch", "ballot_numbers", "regional_stats_missing", "issue_too_broad",
  "lineage_status", "lineage_stances", "lineage_events",
];
const REAL_ARMS = ["legacy", "mismatch", "issue_too_broad"];
const ARM_NAMES = [
  "raw:policy_missing", "raw:profile_gap", "raw:policy_validity", "raw:progress_stale", "raw:candidacy_source_missing", "raw:roster_check",
  "raw:policy_election_missing", "raw:candidate_status_stale", ...ARM_FNS.slice(0, 14), "deadline_due", ...ARM_FNS.slice(14),
  "manual_visitor", "manual_open", "traffic:progress_stale", "traffic:deadline_due", "traffic:term_policies",
];
const RET = "RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT) LANGUAGE sql STABLE";

const ENV_BASE = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE fake_rows (src TEXT, task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT);
${ARM_FNS.filter((n) => !REAL_ARMS.includes(n)).map((n) => `CREATE FUNCTION contribution_auto_tasks_${n}() ${RET} AS $f$ SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = '${n}' $f$;`).join("\n")}
CREATE FUNCTION contribution_auto_tasks_raw() ${RET} AS $f$ SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = 'raw' $f$;
CREATE FUNCTION contribution_auto_tasks_deadline_due() ${RET} AS $f$ SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = 'deadline_due' $f$;
CREATE FUNCTION contribution_auto_tasks_manual(p_visitor BOOLEAN) ${RET} AS $f$ SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM fake_rows WHERE src = CASE WHEN p_visitor THEN 'manual_visitor' ELSE 'manual_open' END $f$;
CREATE FUNCTION activity_arm_names() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $f$ SELECT ARRAY[${ARM_NAMES.map((n) => `'${n}'`).join(",")}]::TEXT[] $f$;
CREATE TABLE roster_flag (on_ BOOLEAN NOT NULL);
INSERT INTO roster_flag VALUES (false);
CREATE FUNCTION roster_unify_on() RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT on_ FROM roster_flag $f$;
CREATE FUNCTION roster_unit_findings() RETURNS TABLE (task_id TEXT, arm TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], county TEXT, voted BOOLEAN, items JSONB, items_count INTEGER, kinds JSONB)
  LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::TEXT[], NULL::TEXT, NULL::BOOLEAN, NULL::JSONB, NULL::INTEGER, NULL::JSONB WHERE false $f$;
CREATE FUNCTION roster_gap_units() RETURNS TABLE (task_id TEXT, arm TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], county TEXT, items JSONB, items_count INTEGER, kinds JSONB)
  LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::TEXT[], NULL::TEXT, NULL::JSONB, NULL::INTEGER, NULL::JSONB WHERE false $f$;
CREATE FUNCTION roster_gap_fresh_units() RETURNS SETOF TEXT LANGUAGE sql STABLE AS $f$ SELECT NULL::TEXT WHERE false $f$;
CREATE FUNCTION roster_scope_covers(TEXT, TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION roster_unify_text(INTEGER, BOOLEAN) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT 'u' $f$;
CREATE FUNCTION roster_unify_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT '{}'::JSONB $f$;
CREATE FUNCTION roster_gap_attach(JSONB, JSONB, INTEGER, JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$ SELECT '{}'::JSONB $f$;
CREATE FUNCTION roster_gap_text() RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT 'g' $f$;
CREATE FUNCTION roster_gap_tid(TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $f$ SELECT $1 $f$;
CREATE FUNCTION politician_name_is_placeholder(TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT false $f$;
CREATE FUNCTION traffic_watch_source_arms() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $f$ SELECT ARRAY['raw:progress_stale','deadline_due','term_policies']::TEXT[] $f$;
CREATE TABLE traffic_watch_levels (election_type TEXT, enabled BOOLEAN);
CREATE FUNCTION traffic_watch_arm(TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $f$ SELECT 'traffic:' || regexp_replace($1, '^raw:', '') $f$;
CREATE FUNCTION election_id_or_null(TEXT) RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $f$ SELECT NULLIF(regexp_replace($1, '\\D', '', 'g'), '')::INTEGER $f$;
CREATE FUNCTION uuid_or_null(TEXT) RETURNS UUID LANGUAGE sql IMMUTABLE AS $f$ SELECT CASE WHEN $1 ~ '^[0-9a-f-]{36}$' THEN $1::UUID END $f$;
CREATE FUNCTION activity_require_rule(TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION activity_open(p_arm TEXT, p_eid INTEGER, p_etype TEXT)
  RETURNS TABLE (source TEXT, rule_id BIGINT, override_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE, open_until DATE)
  LANGUAGE sql STABLE AS $f$ SELECT 'rule'::TEXT, 7::BIGINT, NULL::BIGINT, NULL::TEXT, NULL::DATE, NULL::DATE, NULL::DATE $f$;
CREATE TABLE page_traffic_hot (kind TEXT, target_id TEXT);
CREATE TABLE seed_arm_timings (id BIGSERIAL PRIMARY KEY, run_started_at TIMESTAMPTZ NOT NULL, arm TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, row_count INTEGER, ok BOOLEAN NOT NULL DEFAULT true, error TEXT);
CREATE TABLE tracking_logs (id SERIAL PRIMARY KEY, policy_id UUID);

-- 三支臂與觸發器會碰到的真表（欄位只放用得到的）
CREATE TABLE elections (id INTEGER PRIMARY KEY, election_date DATE NOT NULL);
CREATE TABLE regions (id INTEGER PRIMARY KEY, region TEXT, sub_region TEXT);
CREATE TABLE politicians (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, birth_year INTEGER, status TEXT, region TEXT, merged_into UUID);
CREATE TABLE politician_elections (id SERIAL PRIMARY KEY, politician_id UUID, election_id INTEGER, election_type TEXT, candidacy_status TEXT, region_id INTEGER, cand_no TEXT);
CREATE TABLE policies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), politician_id UUID, title TEXT, description TEXT, category TEXT, tags TEXT[],
  status TEXT, proposed_date DATE, last_updated TIMESTAMPTZ, progress TEXT, election_id INTEGER, removed_at TIMESTAMPTZ, lineage_id UUID);
CREATE INDEX policies_politician_idx ON policies (politician_id);
CREATE TABLE jev_decisions (id SERIAL PRIMARY KEY, subject_type TEXT, subject_id TEXT, question TEXT, choice TEXT, probability FLOAT, asked_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE edit_history (id SERIAL PRIMARY KEY, table_name TEXT, record_id TEXT, field TEXT);
CREATE TABLE contributions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id TEXT, status TEXT, payload JSONB, contribution_type TEXT, applied_policy_id UUID);
CREATE TABLE sources (id BIGSERIAL PRIMARY KEY, url TEXT);
CREATE TABLE source_refs (source_id BIGINT, target_table TEXT, target_id TEXT, role TEXT DEFAULT 'primary', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE policy_subtopics (policy_id UUID, issue TEXT, subtopic TEXT);
CREATE TABLE activity_rules (id SERIAL PRIMARY KEY, activity TEXT, enabled BOOLEAN DEFAULT true, params JSONB, except_election_types TEXT[], election_types TEXT[]);
INSERT INTO activity_rules (activity, params) VALUES ('issue_too_broad', '{"threshold": 2, "election_id": 2026}');
CREATE FUNCTION activity_today() RETURNS DATE LANGUAGE sql STABLE AS $f$ SELECT COALESCE(NULLIF(current_setting('app.activity_today', true), ''), '2026-11-26')::DATE $f$;
${primaryUrlFn}
${issuesFns}
${issueSrc}
${mismatchSrc}
${legacySrc}
`;

type Opts = { dataBeforeMig?: boolean; mig?: boolean };
async function freshDb(o: Opts = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV_BASE);
  await db.exec(pr1);
  await db.exec(pr2);
  if (o.dataBeforeMig) await db.exec(DATASET);
  if (o.mig !== false) await db.exec(mig);
  return db;
}

const one = async <T = unknown>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0]?.v;
const rows = async (db: PGlite, sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/**
 * 假資料（今天＝2026-11-26，2026 年選舉 11-28）。涵蓋：
 *  legacy：有主要出處、沒有 audit 的政見
 *  mismatch：by_future、by_no_candidacy、by_not_elected、by_date、by_jev 各一
 *  issue_too_broad：臺北市 2026 競選承諾「交通」四筆（門檻 2），臺中市只有一筆
 */
const DATASET = `
INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2026-11-28');
INSERT INTO regions VALUES (1, '臺北市', NULL), (2, '臺中市', NULL);
INSERT INTO politicians (id, name, region) VALUES
  ('${U(1)}', '甲', '臺北市'), ('${U(2)}', '乙', '臺北市'), ('${U(3)}', '丙', '臺中市'), ('${U(4)}', '丁', '臺北市');
INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES
  ('${U(1)}', 2026, '縣市長', 'filed', 1), ('${U(1)}', 2022, '縣市長', 'not_elected', 1),
  ('${U(2)}', 2026, '縣市議員', 'filed', 1),
  ('${U(3)}', 2026, '縣市長', 'filed', 2),
  ('${U(4)}', 2026, '縣市長', 'filed', 1);
-- 臺北市 交通 四筆競選承諾（甲、乙、丁），全部有主要出處、沒有 audit → 同時是 legacy 缺口
INSERT INTO policies (id, politician_id, title, tags, status, election_id) VALUES
  ('${U(101)}', '${U(1)}', '甲的交通一', ARRAY['交通'], 'Campaign Pledge', 2026),
  ('${U(102)}', '${U(1)}', '甲的交通二', ARRAY['交通'], 'Campaign Pledge', 2026),
  ('${U(103)}', '${U(2)}', '乙的交通', ARRAY['交通'], 'Campaign Pledge', 2026),
  ('${U(104)}', '${U(4)}', '丁的交通', ARRAY['交通'], 'Campaign Pledge', 2026),
  ('${U(105)}', '${U(3)}', '丙的交通', ARRAY['交通'], 'Campaign Pledge', 2026);
-- mismatch 五種
INSERT INTO policies (id, politician_id, title, tags, status, election_id, proposed_date) VALUES
  ('${U(201)}', '${U(1)}', '任內施政掛在未來選舉', ARRAY['其他'], 'Proposed', 2026, NULL),
  ('${U(202)}', '${U(3)}', '承諾掛在沒參選的屆', ARRAY['其他'], 'Campaign Pledge', 2022, NULL),
  ('${U(203)}', '${U(2)}', '任內施政掛在沒當選的屆', ARRAY['其他'], 'In Progress', 2022, NULL),
  ('${U(204)}', '${U(1)}', '提出日期晚於投票日', ARRAY['其他'], 'Campaign Pledge', 2022, '2023-01-01'),
  ('${U(205)}', '${U(4)}', 'Jev 說是別屆', ARRAY['其他'], 'Campaign Pledge', 2026, NULL);
INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability) VALUES
  ('policy', '${U(205)}', 'election', '2022', 0.9), ('policy', '${U(205)}', 'election', '2022', 0.95);
INSERT INTO sources (url) SELECT 'https://example.org/' || p.id FROM policies p;
INSERT INTO source_refs (source_id, target_table, target_id, role)
  SELECT s.id, 'policies', p.id::TEXT, 'primary' FROM policies p JOIN sources s ON s.url = 'https://example.org/' || p.id;
`;

/** 常駐表開著的列 vs 整臂函式輸出：雙向差異數 */
async function gapDiff(db: PGlite, arm: string): Promise<[number, number]> {
  const full = `SELECT t.task_id AS gap_key, to_jsonb(t) - 'task_id' AS payload FROM contribution_auto_tasks_${arm}() t`;
  const tab = `SELECT g.gap_key, g.payload FROM dispatch_gaps g WHERE g.arm = '${arm}' AND g.closed_at IS NULL`;
  const a = await one<number>(db, `SELECT count(*)::int AS v FROM (${full} EXCEPT ${tab}) x`);
  const b = await one<number>(db, `SELECT count(*)::int AS v FROM (${tab} EXCEPT ${full}) x`);
  return [a as number, b as number];
}
async function drainAll(db: PGlite) {
  for (let i = 0; i < 6; i++) {
    await db.exec("SELECT dispatch_gap_drain(500)");
    if ((await one<number>(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE processed_at IS NULL AND attempts < 5")) === 0) return;
  }
}
async function assertConsistent(db: PGlite, why: string) {
  for (const arm of REAL_ARMS) {
    assertEquals(await gapDiff(db, arm), [0, 0], `${why}：${arm} 常駐表與整臂結果對不上`);
  }
}
const pending = async (db: PGlite) =>
  (await rows(db, "SELECT arm || '|' || scope_key AS k FROM dispatch_gap_events WHERE processed_at IS NULL ORDER BY 1")).map((r) => r.k as string);

// ───────────────────────── A 最新定義與文字層 ─────────────────────────
Deno.test("A1 三支臂的最新定義就是抽出來的那三支（後面沒有遷移再改它們）", async () => {
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  const latest = async (re: RegExp) => {
    let last = "";
    for (const f of files) {
      if (f >= MIG_NAME) continue;
      if (re.test(await read(f))) last = f;
    }
    return last;
  };
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION contribution_auto_tasks_legacy\(\)/), LEGACY_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch\(\)/), MISMATCH_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION contribution_auto_tasks_issue_too_broad\(\)/), ISSUE_FILE);
  assertEquals(await latest(/CREATE OR REPLACE FUNCTION issues_scoped\(/), "20261031130000_issues_summary_page.sql");
});

Deno.test("A2 按鍵版本體與整表版只差鍵過濾（逐行比對：整表版每一行都在按鍵版裡，按鍵版多出的行都跟鍵有關）", () => {
  const bodyLines = (fn: string, name: string) => {
    const a = fn.indexOf(name);
    const body = fn.slice(a).split("\n").slice(1);
    return body.map((l) => l.trim().replace(/^WITH /, "")).filter((l) => l && !l.startsWith("--") && !/^(AS \$|LANGUAGE|STABLE|RETURNS|\$\$|\$function\$)/.test(l));
  };
  const keyed = (name: string) => slice(mig, `CREATE OR REPLACE FUNCTION ${name}(p_keys TEXT[])`, "$function$;", true);
  const keyedIssue = slice(mig, "CREATE OR REPLACE FUNCTION dispatch_gap_recompute_issue_too_broad(p_keys TEXT[])", "-- ----------", false);
  const cases: Array<[string, string, string]> = [
    ["legacy", legacySrc, keyed("dispatch_gap_recompute_legacy")],
    ["mismatch", mismatchSrc, keyed("dispatch_gap_recompute_mismatch")],
    ["issue_too_broad", issueSrc.slice(issueSrc.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_issue_too_broad()")), keyedIssue],
  ];
  for (const [arm, full, key] of cases) {
    const fl = bodyLines(full, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_").filter((l) => !l.startsWith("CREATE OR REPLACE"));
    const kl = bodyLines(key, "CREATE OR REPLACE FUNCTION dispatch_gap_recompute_").filter((l) => !l.startsWith("CREATE OR REPLACE"));
    const kset = new Set(kl);
    const fset = new Set(fl);
    const missing = fl.filter((l) => !kset.has(l));
    assertEquals(missing, [], `${arm}：整表版有、按鍵版沒有的行（不能少任何邏輯）`);
    const extra = kl.filter((l) => !fset.has(l));
    for (const l of extra) assert(/p_keys|kk|kc|鍵/.test(l), `${arm}：按鍵版多出來的行必須與鍵過濾有關：${l}`);
    assert(extra.length >= 1 && extra.length <= 14, `${arm}：多出的鍵過濾行數不合理 ${extra.length}`);
  }
});

// ───────────────────────── B 按鍵重算 = 整臂限定同鍵 ─────────────────────────
Deno.test("B1 三支按鍵重算與整臂函式限定同鍵的結果雙向 EXCEPT 為 0（假資料有各種缺口形狀）", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  const keysOf = async (arm: string) =>
    (await rows(db, `SELECT DISTINCT dispatch_gap_scope_key('${arm}', task_id) AS k FROM contribution_auto_tasks_${arm}() ORDER BY 1`)).map((r) => r.k as string);
  const counts: Record<string, number> = {};
  for (const arm of REAL_ARMS) {
    const all = await keysOf(arm);
    assert(all.length >= 1, `${arm} 的假資料至少要有一個缺口`);
    counts[arm] = all.length;
    const fnName = `dispatch_gap_recompute_${arm}`;
    // 全部鍵、單一鍵、一半的鍵、含不存在的鍵
    const subsets: string[][] = [all, [all[0]], all.slice(0, Math.max(1, Math.floor(all.length / 2))), [...all, arm === "issue_too_broad" ? "issue:2026:台北市:不存在" : "policy:" + U(999)]];
    for (const ks of subsets) {
      const arr = `ARRAY[${ks.map((k) => `'${k}'`).join(",")}]::TEXT[]`;
      const keyedQ = `SELECT * FROM ${fnName}(${arr})`;
      const fullQ = `SELECT * FROM contribution_auto_tasks_${arm}() t WHERE dispatch_gap_scope_key('${arm}', t.task_id) = ANY (${arr})`;
      assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${keyedQ} EXCEPT ${fullQ}) x`), 0, `${arm} 按鍵版多出列 keys=${ks.length}`);
      assertEquals(await one(db, `SELECT count(*)::int AS v FROM (${fullQ} EXCEPT ${keyedQ}) x`), 0, `${arm} 按鍵版缺列 keys=${ks.length}`);
    }
    // 單一鍵只回該鍵的缺口；不存在的鍵回空
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM ${fnName}(ARRAY['${all[0]}'])`), 1);
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM ${fnName}(ARRAY['${arm === "issue_too_broad" ? "issue:2026:台北市:不存在" : "policy:" + U(999)}'])`), 0);
    assertEquals(await one(db, `SELECT count(*)::int AS v FROM ${fnName}(ARRAY[]::TEXT[])`), 0);
  }
  // mismatch 五種原因都在、issue 只有臺北市交通一個、legacy 每條有出處的政見一個
  assertEquals(counts.mismatch, 5);
  assertEquals(counts.issue_too_broad, 1);
  assertEquals(counts.legacy, 10);
  await db.close();
});

Deno.test("B2 issue_too_broad 的臺／台寫法：鍵用「台」（與 task_id 同），按鍵版找得到臺北市的缺口", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  const key = await one<string>(db, "SELECT dispatch_gap_scope_key('issue_too_broad', task_id) AS v FROM contribution_auto_tasks_issue_too_broad() LIMIT 1");
  assertEquals(key, "issue:2026:台北市:交通");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_recompute_issue_too_broad(ARRAY['issue:2026:臺北市:交通'])"), 0, "臺寫法不是鍵");
  await db.close();
});

// ───────────────────────── C 觸發器 ─────────────────────────
Deno.test("C1 各來源表的觸發器入列正確的 scope_key；不相關的更新與列不入列", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2026-11-28')");
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec("INSERT INTO regions VALUES (1, '臺北市', NULL)");
  await db.exec(`INSERT INTO politicians (id, name, region) VALUES ('${U(1)}', '甲', '臺北市'), ('${U(2)}', '乙', '臺中市')`);
  assertEquals(await pending(db), [], "regions、politicians INSERT 都不入列");

  // policies INSERT：legacy、mismatch 各一；2026 競選承諾另入 issue_too_broad 整臂
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO policies (id, politician_id, title, status, election_id, tags) VALUES ('${U(101)}', '${U(1)}', 'a', 'Campaign Pledge', 2026, ARRAY['x'])`);
  assertEquals(await pending(db), [`issue_too_broad|*`, `legacy|policy:${U(101)}`, `mismatch|policy:${U(101)}`]);
  // 非 2026 競選承諾：不入 issue_too_broad
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO policies (id, politician_id, title, status, election_id) VALUES ('${U(102)}', '${U(1)}', 'b', 'Proposed', 2026)`);
  assertEquals(await pending(db), [`legacy|policy:${U(102)}`, `mismatch|policy:${U(102)}`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO policies (id, politician_id, title, status, election_id) VALUES ('${U(103)}', '${U(1)}', 'c', 'Campaign Pledge', 2022)`);
  assertEquals(await pending(db), [`legacy|policy:${U(103)}`, `mismatch|policy:${U(103)}`]);

  // policies UPDATE OF：description、progress、last_updated 不在欄位清單，連函式都不叫；title 在清單
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`UPDATE policies SET description = 'x', progress = 'p', last_updated = now() WHERE id = '${U(101)}'`);
  assertEquals(await pending(db), []);
  await db.exec(`UPDATE policies SET title = 'a2' WHERE id = '${U(101)}'`);
  assertEquals(await pending(db), [`issue_too_broad|*`, `legacy|policy:${U(101)}`, `mismatch|policy:${U(101)}`]);
  // 清單內的欄位被 SET 但值沒變：函式內比對後不入列
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`UPDATE policies SET title = title WHERE id = '${U(101)}'`);
  assertEquals(await pending(db), []);
  // DELETE
  await db.exec(`DELETE FROM policies WHERE id = '${U(102)}'`);
  assertEquals(await pending(db), [`legacy|policy:${U(102)}`, `mismatch|policy:${U(102)}`]);

  // jev_decisions：只有 policy×election 題入列
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability) VALUES ('policy', '${U(101)}', 'is_policy', 'yes', 1), ('politician', '${U(1)}', 'election', '2026', 1)`);
  assertEquals(await pending(db), []);
  await db.exec(`INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability) VALUES ('policy', '${U(101)}', 'election', '2026', 0.9)`);
  assertEquals(await pending(db), [`mismatch|policy:${U(101)}`]);

  // edit_history：只有 policies 的 audit／* 入列
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO edit_history (table_name, record_id, field) VALUES ('policies', '${U(101)}', 'title'), ('politicians', '${U(1)}', 'audit')`);
  assertEquals(await pending(db), []);
  await db.exec(`INSERT INTO edit_history (table_name, record_id, field) VALUES ('policies', '${U(101)}', 'audit'), ('policies', '${U(103)}', '*')`);
  assertEquals(await pending(db), [`legacy|policy:${U(101)}`, `legacy|policy:${U(103)}`]);

  // source_refs：只有政見的主要出處（新增、改 role、刪除）；佐證與進度紀錄的出處不入列
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec("INSERT INTO sources (url) VALUES ('https://a'), ('https://b')");
  await db.exec(`INSERT INTO source_refs (source_id, target_table, target_id, role) VALUES (1, 'policies', '${U(101)}', 'supporting'), (1, 'tracking_logs', 'x', 'primary')`);
  assertEquals(await pending(db), []);
  await db.exec(`INSERT INTO source_refs (source_id, target_table, target_id, role) VALUES (2, 'policies', '${U(101)}', 'primary')`);
  assertEquals(await pending(db), [`legacy|policy:${U(101)}`, `mismatch|policy:${U(101)}`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`UPDATE source_refs SET role = 'primary' WHERE source_id = 1 AND target_id = '${U(101)}'`);
  assertEquals(await pending(db), [`legacy|policy:${U(101)}`, `mismatch|policy:${U(101)}`], "supporting 升 primary");
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`DELETE FROM source_refs WHERE source_id = 2 AND target_id = '${U(101)}'`);
  assertEquals(await pending(db), [`legacy|policy:${U(101)}`, `mismatch|policy:${U(101)}`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`DELETE FROM source_refs WHERE target_table = 'tracking_logs'`);
  assertEquals(await pending(db), []);

  // contributions：只認 policy 與 policy_subtopics
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO contributions (task_id, status, contribution_type, payload) VALUES ('auto:legacy_audit:${U(101)}', 'pending', 'correction', '{}')`);
  assertEquals(await pending(db), [], "其他型別不入列");
  await db.exec(`INSERT INTO contributions (id, status, contribution_type, payload, applied_policy_id) VALUES ('${U(901)}', 'pending', 'policy', '{}', NULL)`);
  assertEquals(await pending(db), [], "policy 還沒落庫（沒有 applied_policy_id）不入列");
  await db.exec(`UPDATE contributions SET status = 'applied', applied_policy_id = '${U(103)}' WHERE id = '${U(901)}'`);
  assertEquals(await pending(db), [`legacy|policy:${U(103)}`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'policy_subtopics', '{"election_id": 2026, "region": "臺北市", "issue": "長照 服務"}')`);
  assertEquals(await pending(db), [`issue_too_broad|issue:2026:台北市:長照_服務`], "臺→台、議題空白→底線，與 task_id 同一個組法");
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'policy_subtopics', '{}')`);
  assertEquals(await pending(db), [`issue_too_broad|*`], "payload 組不出鍵就整臂");
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`UPDATE contributions SET payload = '{}'::jsonb WHERE contribution_type = 'policy_subtopics'`);
  assertEquals(await pending(db), [], "payload 不在 UPDATE OF 清單，不入列");

  // policy_subtopics、elections、activity_rules
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO policy_subtopics VALUES ('${U(101)}', '交通', '捷運')`);
  assertEquals(await pending(db), [`issue_too_broad|*`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec("UPDATE elections SET election_date = '2026-11-29' WHERE id = 2026");
  assertEquals(await pending(db), [`mismatch|*`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec("INSERT INTO activity_rules (activity, params) VALUES ('party_gap', '{}')");
  await db.exec("UPDATE activity_rules SET enabled = false WHERE activity = 'issue_too_broad'");
  assertEquals(await pending(db), [], "別支臂的規則、或不在 OF 清單的欄位都不入列");
  await db.exec(`UPDATE activity_rules SET params = '{"threshold": 3, "election_id": 2026}' WHERE activity = 'issue_too_broad'`);
  assertEquals(await pending(db), [`issue_too_broad|*`]);
  await db.close();
});

Deno.test("C2 參選紀錄與人物：mismatch 只入同一個人同一屆的政見；issue_too_broad 只在該屆有競選承諾時入整臂；politicians 只在 name／region／merged_into 變時入", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2026-11-28')");
  await db.exec(`INSERT INTO politicians (id, name, region) VALUES ('${U(1)}', '甲', '臺北市'), ('${U(2)}', '乙', '臺北市')`);
  await db.exec(`INSERT INTO policies (id, politician_id, title, status, election_id) VALUES
    ('${U(101)}', '${U(1)}', 'a', 'Campaign Pledge', 2026), ('${U(102)}', '${U(1)}', 'b', 'Proposed', 2022), ('${U(103)}', '${U(2)}', 'c', 'Campaign Pledge', 2026)`);
  await db.exec("DELETE FROM dispatch_gap_events");

  await db.exec(`INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id) VALUES (1001, '${U(1)}', 2026, '縣市長', 'filed', 1)`);
  assertEquals(await pending(db), [`issue_too_broad|*`, `mismatch|policy:${U(101)}`], "只有甲 2026 的政見（101），不含 2022 的 102、乙的 103");
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec("UPDATE politician_elections SET candidacy_status = 'elected' WHERE id = 1001");
  assertEquals(await pending(db), [`issue_too_broad|*`, `mismatch|policy:${U(101)}`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec("UPDATE politician_elections SET cand_no = '3' WHERE id = 1001");
  assertEquals(await pending(db), [], "cand_no 不在欄位清單");
  // 改掛到 2022：新舊兩屆的政見都入；2022 沒有競選承諾 → 不入 issue_too_broad 以外的……舊屆(2026)有承諾所以仍入整臂
  await db.exec("UPDATE politician_elections SET election_id = 2022 WHERE id = 1001");
  assertEquals(await pending(db), [`issue_too_broad|*`, `mismatch|policy:${U(101)}`, `mismatch|policy:${U(102)}`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  // 沒有競選承諾的人：只有 2022 的 Proposed 政見 → 不入 issue_too_broad
  await db.exec(`INSERT INTO politicians (id, name) VALUES ('${U(3)}', '丙')`);
  await db.exec(`INSERT INTO policies (id, politician_id, title, status, election_id) VALUES ('${U(104)}', '${U(3)}', 'd', 'Proposed', 2026)`);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES ('${U(3)}', 2026, '縣市長', 'filed', 1)`);
  assertEquals(await pending(db), [`mismatch|policy:${U(104)}`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`DELETE FROM politician_elections WHERE politician_id = '${U(3)}'`);
  assertEquals(await pending(db), [`mismatch|policy:${U(104)}`]);

  // politicians
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`UPDATE politicians SET birth_year = 1970, status = 'x' WHERE id = '${U(1)}'`);
  assertEquals(await pending(db), [], "birth_year、status 不在欄位清單");
  await db.exec(`UPDATE politicians SET name = '甲2' WHERE id = '${U(1)}'`);
  assertEquals(await pending(db), [`legacy|policy:${U(101)}`, `legacy|policy:${U(102)}`, `mismatch|policy:${U(101)}`, `mismatch|policy:${U(102)}`]);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec(`UPDATE politicians SET name = name WHERE id = '${U(1)}'`);
  assertEquals(await pending(db), [], "值沒變不入列");
  await db.exec(`UPDATE politicians SET merged_into = '${U(2)}' WHERE id = '${U(1)}'`);
  assertEquals((await pending(db)).length, 4);
  await db.close();
});

Deno.test("C3 events_enabled=false：所有表的觸發器都不入列；打開後恢復", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2026-11-28')");
  await db.exec(`INSERT INTO politicians (id, name) VALUES ('${U(1)}', '甲')`);
  await db.exec("DELETE FROM dispatch_gap_events");
  await db.exec("UPDATE dispatch_gap_settings SET events_enabled = false");
  await db.exec(`INSERT INTO policies (id, politician_id, title, status, election_id) VALUES ('${U(101)}', '${U(1)}', 'a', 'Campaign Pledge', 2026)`);
  await db.exec(`INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability) VALUES ('policy', '${U(101)}', 'election', '2026', 1)`);
  await db.exec(`INSERT INTO edit_history (table_name, record_id, field) VALUES ('policies', '${U(101)}', 'audit')`);
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'policy_subtopics', '{}')`);
  await db.exec(`INSERT INTO policy_subtopics VALUES ('${U(101)}', '交通', '捷運')`);
  await db.exec(`UPDATE politicians SET name = '甲2'`);
  await db.exec("UPDATE elections SET election_date = '2026-12-01'");
  assertEquals(await pending(db), []);
  await db.exec("UPDATE dispatch_gap_settings SET events_enabled = true");
  await db.exec(`UPDATE policies SET title = 'a2' WHERE id = '${U(101)}'`);
  assert((await pending(db)).length >= 2);
  await db.close();
});

Deno.test("C4 投票日翻轉：只有今天正好是某場選舉的投票日才入 mismatch 整臂事件", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2026-11-28')");
  await db.exec("DELETE FROM dispatch_gap_events");
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip() AS v"), 0);
  assertEquals(await pending(db), []);
  await db.exec("SET app.activity_today = '2026-11-28'");
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip() AS v"), 1);
  assertEquals(await pending(db), ["mismatch|*"]);
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip() AS v"), 0, "已有未處理的整臂事件不重複");
  await db.close();
});

// ───────────────────────── D drain ─────────────────────────
Deno.test("D1 drain：資料變動後常駐表與整臂結果一致（開、關、更新），走的是按鍵版", async () => {
  const db = await freshDb();
  await db.exec(DATASET);   // 觸發器在，資料進來就入列
  assert((await pending(db)).length > 5, "資料進來之後應有事件");
  await drainAll(db);
  await assertConsistent(db, "初次");
  assert((await one<number>(db, "SELECT count(*)::int AS v FROM dispatch_gaps WHERE closed_at IS NULL")) as number >= 16);

  // 把 legacy 與 mismatch 的整表函式弄壞：之後只有 issue_too_broad 事件才可以走整臂
  await db.exec("CREATE FUNCTION boom() RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT) LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '整表版不該被呼叫'; END $$");
  await db.exec("UPDATE dispatch_gap_arm_keys SET full_fn = 'boom()' WHERE arm IN ('legacy', 'mismatch')");

  const step = async (why: string, sql: string) => {
    await db.exec(sql);
    await drainAll(db);
    assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE processed_at IS NULL"), 0, `${why}：事件要消化完`);
    assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_events WHERE last_error IS NOT NULL"), 0, `${why}：不能有失敗的事件`);
    await db.exec("UPDATE dispatch_gap_arm_keys SET full_fn = 'contribution_auto_tasks_legacy()' WHERE arm = 'legacy'");
    await db.exec("UPDATE dispatch_gap_arm_keys SET full_fn = 'contribution_auto_tasks_mismatch()' WHERE arm = 'mismatch'");
    await assertConsistent(db, why);
    await db.exec("UPDATE dispatch_gap_arm_keys SET full_fn = 'boom()' WHERE arm IN ('legacy', 'mismatch')");
  };
  await step("改成競選承諾（by_future 關）", `UPDATE policies SET status = 'Campaign Pledge' WHERE id = '${U(201)}'`);
  await step("刪政見", `DELETE FROM policies WHERE id = '${U(104)}'`);
  await step("蓋 audit（legacy 關）", `INSERT INTO edit_history (table_name, record_id, field) VALUES ('policies', '${U(101)}', 'audit')`);
  await step("人物改名（內容更新）", `UPDATE politicians SET name = '甲改' WHERE id = '${U(1)}'`);
  await step("拿掉主要出處（legacy 關、mismatch 內容變）", `DELETE FROM source_refs WHERE target_id = '${U(205)}'`);
  await step("補主要出處（legacy 重開）", `INSERT INTO source_refs (source_id, target_table, target_id, role) SELECT id, 'policies', '${U(205)}', 'primary' FROM sources LIMIT 1`);
  await step("新的 Jev 判決（by_jev 內容變）", `INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability) VALUES ('policy', '${U(204)}', 'election', '2026', 0.85)`);
  await step("乙 2022 當選（by_not_elected 關）", `INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES ('${U(2)}', 2022, '縣市議員', 'elected', 1)`);
  await step("政見落庫的貢獻（legacy 排除）", `INSERT INTO contributions (status, contribution_type, payload, applied_policy_id) VALUES ('applied', 'policy', '{}', '${U(102)}')`);
  // 整臂事件（date_flip、issue_too_broad）走整表函式，所以先把整表函式還原
  await db.exec("UPDATE dispatch_gap_arm_keys SET full_fn = 'contribution_auto_tasks_legacy()' WHERE arm = 'legacy'");
  await db.exec("UPDATE dispatch_gap_arm_keys SET full_fn = 'contribution_auto_tasks_mismatch()' WHERE arm = 'mismatch'");
  // 今天進到投票日當天（2026-11-28）：by_future 翻成 by_not_elected，靠 date_flip 事件
  await db.exec("SET app.activity_today = '2026-11-28'");
  assertEquals(await one(db, "SELECT dispatch_gap_date_flip() AS v"), 1);
  await drainAll(db);
  await assertConsistent(db, "投票日翻面");
  await db.exec("SET app.activity_today = '2026-11-26'");
  await db.exec("SELECT dispatch_gap_enqueue('mismatch', '*', 'date_flip')");
  await drainAll(db);
  await assertConsistent(db, "翻回");
  // issue_too_broad 整臂事件：門檻調高 → 關；調回 → 開
  await db.exec(`UPDATE activity_rules SET params = '{"threshold": 5, "election_id": 2026}' WHERE activity = 'issue_too_broad'`);
  await drainAll(db);
  await assertConsistent(db, "門檻調高");
  assertEquals(await gapCount(db, "issue_too_broad"), 0);
  await db.exec(`UPDATE activity_rules SET params = '{"threshold": 2, "election_id": 2026}' WHERE activity = 'issue_too_broad'`);
  await drainAll(db);
  await assertConsistent(db, "門檻調回");
  assertEquals(await gapCount(db, "issue_too_broad"), 1);
  // 在途細項（鍵事件）關掉那個缺口：contributions 的 payload 對應縣市議題
  await db.exec(`INSERT INTO contributions (status, contribution_type, payload) VALUES ('pending', 'policy_subtopics', '{"election_id": 2026, "region": "台北市", "issue": "交通"}')`);
  await drainAll(db);
  await assertConsistent(db, "在途細項");
  assertEquals(await gapCount(db, "issue_too_broad"), 0);
  // 關掉的列 closed_reason 是 filled
  assert(((await one<number>(db, "SELECT count(*)::int AS v FROM dispatch_gaps WHERE closed_at IS NOT NULL AND closed_reason = 'filled'")) as number) >= 5);
  await db.close();
});
const gapCount = async (db: PGlite, arm: string) => await one<number>(db, `SELECT count(*)::int AS v FROM dispatch_gaps WHERE arm = '${arm}' AND closed_at IS NULL`);

// ───────────────────────── E 雙軌比對 ─────────────────────────
Deno.test("E1 shadow_run 只比三支 shadow 的臂，missing／extra／changed 全 0；故意弄髒常駐表會被抓到", async () => {
  const db = await freshDb();
  await db.exec(DATASET);
  await drainAll(db);
  const n = await one<number>(db, "SELECT dispatch_gap_shadow_run() AS v");
  assertEquals(n, 3);
  const runs = await rows(db, "SELECT arm, mode, missing, extra, changed, live_count, table_count, error FROM dispatch_gap_reconcile_runs WHERE mode = 'shadow' ORDER BY arm");
  assertEquals(runs.map((r) => r.arm), ["issue_too_broad", "legacy", "mismatch"]);
  for (const r of runs) {
    assertEquals([r.missing, r.extra, r.changed, r.error], [0, 0, 0, null], `${r.arm} 雙軌差異要為 0`);
    assertEquals(r.live_count, r.table_count);
    assert((r.live_count as number) >= 1);
  }
  // 弄髒：把一個開著的 legacy 缺口直接關掉（模擬漏事件），grace 2 分鐘只放過「剛重算過」的 extra／changed，missing 一定抓得到
  await db.exec("UPDATE dispatch_gaps SET closed_at = now(), closed_reason = 'filled' WHERE arm = 'legacy' AND gap_key = 'auto:legacy_audit:" + U(101) + "'");
  await db.exec("SELECT dispatch_gap_shadow_run()");
  assertEquals(await one(db, "SELECT missing::int AS v FROM dispatch_gap_reconcile_runs WHERE mode = 'shadow' AND arm = 'legacy' ORDER BY id DESC LIMIT 1"), 1);
  // 其他臂（off）沒有被比
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_reconcile_runs WHERE arm NOT IN ('legacy','mismatch','issue_too_broad')"), 0);
  await db.close();
});

// ───────────────────────── F 派工輸出不變 ─────────────────────────
const EXCEPT_BOTH = async (db: PGlite) => {
  const a = await one<number>(db, `SELECT count(*)::int AS v FROM (SELECT * FROM contribution_auto_tasks_arms() EXCEPT SELECT * FROM contribution_auto_tasks_arms_v20261126()) x`);
  const b = await one<number>(db, `SELECT count(*)::int AS v FROM (SELECT * FROM contribution_auto_tasks_arms_v20261126() EXCEPT SELECT * FROM contribution_auto_tasks_arms()) x`);
  return [a, b];
};
Deno.test("F1 三支 shadow：總表輸出與前一版（_v20261126）雙向 EXCEPT 為 0；三支真的有輸出；drain 前後總表輸出不變", async () => {
  const db = await freshDb();
  await db.exec(DATASET);
  await db.exec(`INSERT INTO fake_rows VALUES
    ('raw', 'auto:policy_missing:p1', 'policy_missing', '{"politician_id":"11111111-1111-1111-1111-111111111111","election_id":2026}', 'need a', ARRAY['u1'], 3, '臺北市'),
    ('dup', 'auto:dup:z1', 'dup', '{"politician_id":"22222222-2222-2222-2222-222222222222"}', 'need z', ARRAY['y'], 1, NULL),
    ('manual_open', '44444444-4444-4444-4444-444444444444', 'manual', '{}', 'm', ARRAY['k'], 5, NULL)`);
  // drain 之前常駐表是空的（資料是遷移後才進來的，事件還沒消化）：shadow 不讀它
  const total = await one<number>(db, "SELECT count(*)::int AS v FROM contribution_auto_tasks_arms()");
  assert((total as number) >= 15, `總表應有輸出，實際 ${total}`);
  for (const arm of REAL_ARMS) {
    assert(((await one<number>(db, `SELECT count(*)::int AS v FROM contribution_auto_tasks_arms() WHERE arm = '${arm}'`)) as number) >= 1, `${arm} 總表要有輸出`);
  }
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
  const snapshot = async () => (await rows(db, "SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY t.task_id)) AS h FROM contribution_auto_tasks_arms() t"))[0].h;
  const before = await snapshot();
  await drainAll(db);            // seed 開頭做的就是這個
  assert(((await gapCount(db, "legacy")) as number) >= 1, "drain 之後常駐表有資料");
  assertEquals(await snapshot(), before, "drain 只維護 dispatch_gaps，總表輸出不變");
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
  // 常駐表被弄壞也不影響總表（shadow 不讀）
  await db.exec("DELETE FROM dispatch_gaps");
  assertEquals(await snapshot(), before);
  assertEquals(await EXCEPT_BOTH(db), [0, 0]);
  await db.close();
});

// ───────────────────────── G 初始灌入 ─────────────────────────
Deno.test("G1 資料先在、遷移後才掛觸發器：常駐表立刻與整臂一致，且補了三筆整臂事件", async () => {
  const db = await freshDb({ dataBeforeMig: true });
  await assertConsistent(db, "遷移完");
  assert(((await gapCount(db, "mismatch")) as number) === 5);
  assertEquals(await pending(db), ["issue_too_broad|*", "legacy|*", "mismatch|*"], "灌入與掛觸發器之間的空窗由整臂事件補");
  assertEquals(await one(db, "SELECT count(*)::int AS v FROM dispatch_gap_reconcile_runs WHERE mode = 'reconcile'"), 3);
  // 補的整臂事件消化後仍一致
  await drainAll(db);
  await assertConsistent(db, "整臂事件消化後");
  // 設定與模式
  assertEquals(await rows(db, "SELECT arm, mode FROM dispatch_gap_arms WHERE mode <> 'off' ORDER BY arm"),
    [{ arm: "issue_too_broad", mode: "shadow" }, { arm: "legacy", mode: "shadow" }, { arm: "mismatch", mode: "shadow" }]);
  assertEquals(await rows(db, "SELECT events_enabled, seed_drain_enabled FROM dispatch_gap_settings"), [{ events_enabled: true, seed_drain_enabled: true }]);
  assertEquals(await rows(db, "SELECT arm, recompute_fn FROM dispatch_gap_arm_keys ORDER BY arm"), [
    { arm: "issue_too_broad", recompute_fn: "dispatch_gap_recompute_issue_too_broad(text[])" },
    { arm: "legacy", recompute_fn: "dispatch_gap_recompute_legacy(text[])" },
    { arm: "mismatch", recompute_fn: "dispatch_gap_recompute_mismatch(text[])" },
  ]);
  await db.close();
});

// ───────────────────────── H 遷移文字守門 ─────────────────────────
Deno.test("H1 觸發器：每一支 UPDATE 都限定欄位 OF；高頻表（jev_decisions、edit_history、contributions、source_refs）都有 WHEN；共 12 支", () => {
  const stmts = noComments(mig).split(/;\s*\n/).filter((s) => /CREATE TRIGGER/.test(s));
  assertEquals(stmts.length, 12);
  for (const s of stmts) {
    const head = s.replace(/\s+/g, " ");
    if (/\bUPDATE\b/.test(head.split(" ON ")[0])) assert(/UPDATE OF /.test(head), `UPDATE 必須帶 OF 欄位：${head}`);
    assert(/FOR EACH ROW/.test(head) && /EXECUTE FUNCTION dispatch_gap_on_change\(\)/.test(head));
    assert(/AFTER /.test(head), "只用 AFTER 觸發器（不擋寫入、不改列）");
  }
  for (const t of ["jev_decisions", "edit_history", "contributions", "source_refs"]) {
    const ss = stmts.filter((s) => new RegExp(`ON ${t}\\b`).test(s.replace(/\s+/g, " ")));
    assert(ss.length >= 1);
    for (const s of ss) assert(/\bWHEN \(/.test(s), `${t} 是高頻表，觸發器要有 WHEN：${s}`);
  }
  // 三支臂沒讀的表不掛
  assert(!/ON tracking_logs\b/.test(noComments(mig)));
});

Deno.test("H2 沒動總表與 seed 與三支臂本體；註解裡沒有函式定義字樣；不寫死版本清單的守門另有測試", () => {
  const code = noComments(mig);
  for (const f of ["seed_auto_task_queue", "contribution_auto_tasks_arms", "contribution_auto_tasks_legacy", "contribution_auto_tasks_mismatch", "contribution_auto_tasks_issue_too_broad"]) {
    assert(!new RegExp(`CREATE OR REPLACE FUNCTION ${f}\\b`).test(code), `本支不能重定義 ${f}`);
  }
  // 守門測試用 indexOf 抓第一個定義字樣：註解行裡不能出現
  for (const line of mig.split("\n").filter((l) => l.trim().startsWith("--"))) {
    assert(!/CREATE OR REPLACE FUNCTION\s+\w+/.test(line), `註解不能出現函式定義字樣：${line}`);
    assert(!/COMMENT ON FUNCTION\s+\w+/.test(line), `註解不能出現 COMMENT ON FUNCTION：${line}`);
  }
  // 同字首的函式副本：on_change 與 recompute／date_flip 互不同名，COMMENT／REVOKE 都在定義之後
  const iDef = mig.indexOf("CREATE OR REPLACE FUNCTION dispatch_gap_date_flip()");
  assert(iDef > 0 && mig.indexOf("COMMENT ON FUNCTION dispatch_gap_date_flip()") > iDef);
  assert(mig.indexOf("REVOKE ALL ON FUNCTION dispatch_gap_on_change()") > mig.indexOf("CREATE OR REPLACE FUNCTION dispatch_gap_on_change()"));
  // 三支按鍵版與 on_change 都不能讓 anon／authenticated 執行
  for (const f of ["dispatch_gap_recompute_legacy(TEXT[])", "dispatch_gap_recompute_mismatch(TEXT[])", "dispatch_gap_recompute_issue_too_broad(TEXT[])", "dispatch_gap_date_flip()", "dispatch_gap_on_change()"]) {
    assert(mig.includes(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon, authenticated;`), `缺 REVOKE ${f}`);
  }
});

Deno.test("H3 seed 開頭 drain 的總開關開著：PR-2 的 seed 只在開關開時呼叫 dispatch_gap_drain，且失敗只丟 WARNING；本支沒有重定義 seed", () => {
  const i = pr2.indexOf("CREATE OR REPLACE FUNCTION seed_auto_task_queue()");
  const body = pr2.slice(i, i + 4000);
  assert(/dispatch_gap_seed_drain_enabled\(\)/.test(body) && /dispatch_gap_drain\(\)/.test(body));
  assert(/RAISE WARNING/.test(body));
  assert(/SET statement_timeout = '280s'/.test(pr2.slice(i, pr2.indexOf("$$;", i + 4000) + 200)) || /statement_timeout/.test(pr2.slice(i, i + 3000)));
  assert(!/seed_auto_task_queue/.test(noComments(mig)), "本支不碰 seed");
});

Deno.test("H4 cron：date_flip 排在 UTC 16:04（台北 00:04），分鐘避開整十、:29、:35 與奇數分鐘", () => {
  const m = noComments(mig).match(/cron\.schedule\('dispatch-gap-date-flip-daily', '(\d+) (\d+) \* \* \*'/);
  assert(m, "找不到 cron.schedule");
  const [min, hour] = [Number(m![1]), Number(m![2])];
  assert(min % 10 !== 0 && min !== 29 && min !== 35 && min % 2 === 0, `分鐘 ${min} 不合規`);
  assertEquals(hour, 16);
});

// ───────────────────────── I 觸發器成本 ─────────────────────────
Deno.test("I1 觸發器單次成本：高頻表上不相干的列≈0、相干的列在毫秒以內（PGlite 計時，數字印出）", async () => {
  const db = await freshDb();
  await db.exec("INSERT INTO elections VALUES (2026, '2026-11-28')");
  await db.exec(`INSERT INTO politicians (id, name) SELECT gen_random_uuid(), 'p' || g FROM generate_series(1, 200) g`);
  const N = 2000;
  const timeIt = async (sql: string) => {
    const t0 = performance.now();
    await db.exec(sql);
    return performance.now() - t0;
  };
  const measure = async (label: string, table: string, sql: string, reset: string) => {
    await db.exec(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await db.exec(reset);
    const base = await timeIt(sql);
    await db.exec(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await db.exec(reset);
    await db.exec("DELETE FROM dispatch_gap_events");
    const withTrg = await timeIt(sql);
    const perRow = (withTrg - base) / N;
    console.log(`[觸發器成本] ${label}：每列多約 ${perRow.toFixed(3)} ms（無觸發器 ${(base / N).toFixed(3)} ms／列，有觸發器 ${(withTrg / N).toFixed(3)} ms／列）`);
    return perRow;
  };
  // contributions：型別不是 policy／policy_subtopics → WHEN 擋掉，連函式都不叫
  const c1 = await measure("contributions INSERT（其他型別，高頻）", "contributions",
    `INSERT INTO contributions (status, contribution_type, payload) SELECT 'pending', 'correction', '{"a":1}' FROM generate_series(1, ${N})`, "DELETE FROM contributions");
  // contributions policy_subtopics：會入列（每列一個不同的單位鍵）
  const c2 = await measure("contributions INSERT（policy_subtopics，入列）", "contributions",
    `INSERT INTO contributions (status, contribution_type, payload) SELECT 'pending', 'policy_subtopics', jsonb_build_object('election_id', 2026, 'region', '臺北市', 'issue', 'i' || g) FROM generate_series(1, ${N}) g`, "DELETE FROM contributions");
  const j1 = await measure("jev_decisions INSERT（其他題，每天 2.3 萬筆）", "jev_decisions",
    `INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability) SELECT 'policy', g::TEXT, 'is_policy', 'yes', 1 FROM generate_series(1, ${N}) g`, "DELETE FROM jev_decisions");
  const j2 = await measure("jev_decisions INSERT（政見×屆別題，入列）", "jev_decisions",
    `INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability) SELECT 'policy', g::TEXT, 'election', '2026', 1 FROM generate_series(1, ${N}) g`, "DELETE FROM jev_decisions");
  const e1 = await measure("edit_history INSERT（非 audit，高頻）", "edit_history",
    `INSERT INTO edit_history (table_name, record_id, field) SELECT 'policies', g::TEXT, 'title' FROM generate_series(1, ${N}) g`, "DELETE FROM edit_history");
  const p1 = await measure("policies INSERT（2026 競選承諾：入 legacy、mismatch、issue_too_broad 三筆）", "policies",
    `INSERT INTO policies (politician_id, title, status, election_id) SELECT (SELECT id FROM politicians LIMIT 1), 't' || g, 'Campaign Pledge', 2026 FROM generate_series(1, ${N}) g`, "DELETE FROM policies");
  const p2 = await measure("policies UPDATE OF description（不在欄位清單）", "policies",
    `UPDATE policies SET description = 'd'`, `DELETE FROM policies; INSERT INTO policies (politician_id, title, status, election_id) SELECT (SELECT id FROM politicians LIMIT 1), 't' || g, 'Proposed', 2026 FROM generate_series(1, ${N}) g`);
  const pe1 = await measure("politician_elections INSERT（該人沒有政見）", "politician_elections",
    `INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) SELECT (SELECT id FROM politicians OFFSET 150 LIMIT 1), 2026, '縣市長', 'filed', 1 FROM generate_series(1, ${N})`, "DELETE FROM politician_elections");
  // 判準：每列多的時間 < 1 ms（PGlite 比正式庫慢，正式庫更小）；高頻表上不相干的列應接近 0
  for (const [n, v] of Object.entries({ c1, c2, j1, j2, e1, p1, p2, pe1 })) assert(v < 1, `${n}：每列多 ${v.toFixed(3)} ms，超過 1ms`);
  assert(c1 < 0.05 && j1 < 0.05 && e1 < 0.05 && p2 < 0.05, "不相干的列（WHEN 或 OF 擋掉）每列成本應接近 0");
  await db.close();
});
