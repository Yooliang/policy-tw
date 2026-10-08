/**
 * 名單清查（roster_check）的重查判準（2026-10-08，10-08 缺口盤點 R2；migration 20261008112000）。
 *
 * 舊判準：last_checked IS NULL OR last_checked < now() - recheck_days。代理只要交一筆帶 cec_count 的 roster_check，
 * 任務就被收回 7 天，即使我們的人數遠少於它回報的 cec_count（彰化縣議員 10-02 回報中選會 86 位、我們 0 位，一直沒有任務）。
 * 新判準：最近一次回報的 cec_count 大於我們目前的名冊內人數（排除 considering、withdrawn） → 不套 recheck_days，繼續派；落差為 0（或我們比較多）才套。
 *
 * 守門三道：
 *   1. 前一版是對的：新定義緊接著 20261008070000（P2 選舉結果，最後一次改 raw），而且是最後一版（之後有人改了，抄的底就過期）
 *   2. 新定義＝現行定義＋三處機械替換（ours 多一欄、LATERAL 多一欄、WHERE 一條）：反向替換回去逐字等於前一版；
 *      所以 target、說明文字、hint_sources、reward、task_id、其他臂都沒動，輸出只會「多」不會「變」
 *   3. 行為：把 roster_check 那一段（含 ours）原文抽出來在 PGlite 上跑 15 個情境；再對它做 10 種還原驗證，每一種都必須讓指定情境轉紅
 * 對正式庫唯讀快照的逐件比對在 scripts/raw-roster-parity.ts（不進 CI）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, mutate, readMig } from "./arms-pglite.ts";

export const GAP_MIG = "20261008112000_roster_check_gap_dispatch.sql";
export const PREV_RAW_MIG = "20261008070000_activity_windows_p2_election_results.sql";
const FN = "contribution_auto_tasks_raw";

const bodyOf = (fn: string) => fn.slice(fn.indexOf("$function$") + "$function$".length, fn.lastIndexOf("$function$"));
const headerOf = (fn: string) => fn.slice(0, fn.indexOf("$function$") + "$function$".length);

/** 三處機械替換（新 → 舊的反向替換在 reverse() 裡） */
const EDITS: Array<[string, string]> = [
  ["    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n\n",
    "    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n,\n" +
    "           -- 名單缺口用：名冊內人數＝排除 considering（可能參選）與 withdrawn（退選），其餘都算——已登記、已表態，選後的當選／落選也算（只算 filed、declared 的話，選後人數歸零、缺口永遠成立）\n" +
    "           COUNT(*) FILTER (WHERE COALESCE(pe.candidacy_status, '') NOT IN ('considering', 'withdrawn')) AS n_listed\n"],
  ["           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count\n",
    "           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count,\n" +
    "           -- 最近一次真的清查（cec_count 有值）回報的中選會人數\n" +
    "           (array_agg(cec_count ORDER BY checked_at DESC, id DESC) FILTER (WHERE cec_count IS NOT NULL))[1] AS last_cec_count\n"],
  ["    AND (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)\n",
    "    -- 最近一次回報的 cec_count 比我們現在的名冊內人數多＝缺口還在：不套 recheck_days，繼續派；落差為 0（或我們比較多）才套\n" +
    "    AND (rc.last_checked IS NULL\n" +
    "         OR COALESCE(rc.last_cec_count, 0) > COALESCE(o.n_listed, 0)\n" +
    "         OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)\n"],
];
const reverse = (body: string) => EDITS.reduce((s, [from, to]) => mutate(s, to, from), body);

const NEW_FN = fnText(await readMig(GAP_MIG), FN);
const PREV_FN = fnText(await readMig(PREV_RAW_MIG), FN);
const NEW_BODY = bodyOf(NEW_FN);

Deno.test("R2-1 前一版是對的：新定義緊接著 20261008070000，而且是 raw 的最後一版（之後有人改了，抄的底就過期，要以最新那版為底重做）", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${FN}(`)) defining.push(n);
  const i = defining.indexOf(GAP_MIG);
  assert(i > 0, "新 migration 要在重新定義 raw 的清單裡");
  assertEquals(defining[i - 1], PREV_RAW_MIG, `raw 的前一版應該是 ${PREV_RAW_MIG}；有人在中間改了，要以那一版為底重做`);
  // 之後只允許 P2 candidate_status_stale 那一支（20261008162000：把 candidate_status_stale 一段的日期條件移到規則，守門在 activity-candidate-status-stale.test.ts，它以這一版為底並檢查沒丟任何一處）
  assertEquals(defining.slice(i + 1), ["20261008162000_activity_windows_p2_candidate_status_stale.sql"], "新 migration 之後又有人改了 raw：請以最新那版為底，把這三處替換套上去");
});

Deno.test("R2-2 新定義＝現行定義＋三處機械替換：反向替換回去逐字等於前一版（簽名、其他臂、roster_check 的 target／說明／reward 都沒動）", () => {
  assertEquals(headerOf(NEW_FN), headerOf(PREV_FN), "函式簽名與屬性不能動（STABLE、回傳欄位）");
  assertEquals(reverse(NEW_BODY), bodyOf(PREV_FN));
  // 新增的東西只有三處：缺口人數欄、最近一次 cec_count 欄、WHERE 的一個 OR
  assertEquals(NEW_BODY.split("\n").length - bodyOf(PREV_FN).split("\n").length, 7);
});

// ── 行為：roster_check 那一段原文在 PGlite 上跑 ─────────────────────────────────────
/** raw 本體裡的 ours CTE 與 roster_check 那一個 SELECT，原文抽出來組成可以單獨跑的查詢 */
function rosterSql(body: string): string {
  const a = body.indexOf("  ours AS (");
  const b = body.indexOf("  SELECT 'auto:policy_missing:'");
  const c = body.indexOf("  SELECT 'auto:roster_check:'");
  const d = body.indexOf("  UNION ALL\n  SELECT 'auto:policy_election_missing:'");
  assert(a > 0 && b > a && c > b && d > c, "找不到 ours 或 roster_check 那一段");
  return `WITH ${body.slice(a, b).trim()}\n${body.slice(c, d)}`;
}

type Scenario = {
  name: string;
  /** [幾天前, cec_count（null＝試過沒查到）]，由舊到新或亂序都可以 */
  reports?: Array<[number, number | null]>;
  /** [小時前, cec_count] 用小時的版本（冷卻要看小時） */
  reportsH?: Array<[number, number | null]>;
  filed?: number; declared?: number; considering?: number; withdrawn?: number; elected?: number; notElected?: number;
  want: boolean;
  why: string;
};
const SCENARIOS: Scenario[] = [
  { name: "s01_never", want: true, why: "從沒清查過：照舊派" },
  { name: "s02_equal", reports: [[1, 3]], filed: 3, want: false, why: "昨天清查過、人數一樣：照舊壓 7 天" },
  { name: "s03_changhua", reports: [[1, 86]], want: true, why: "彰化縣議員：回報 86 位、我們 0 位（沒有任何參選紀錄）→ 繼續派" },
  { name: "s04_declared_gap", reports: [[1, 5]], filed: 3, declared: 1, want: true, why: "回報 5、我們 filed 3＋declared 1＝4 → 差 1，繼續派" },
  { name: "s04b_declared_counts", reports: [[1, 4]], filed: 3, declared: 1, want: false, why: "回報 4、我們 filed 3＋declared 1＝4 → declared 算進去，沒有落差" },
  { name: "s05_considering_not_counted", reports: [[1, 5]], filed: 3, considering: 2, want: true, why: "只是 considering（可能參選）的人不算已登記，落差還在" },
  { name: "s06_withdrawn_not_counted", reports: [[1, 5]], filed: 3, withdrawn: 5, want: true, why: "退選的不算（ours 本來就不收 withdrawn）" },
  { name: "s07_ours_more", reports: [[1, 2]], filed: 4, want: false, why: "我們比中選會多（負落差）不是缺人：照舊壓 7 天" },
  { name: "s08_old_report_no_gap", reports: [[8, 3]], filed: 3, want: true, why: "沒有落差、8 天前清查的：過了 recheck_days 照舊再派" },
  { name: "s09_latest_report_used", reports: [[3, 86], [1, 3]], filed: 3, want: false, why: "用最近一次的 cec_count（3），不是最大的（86）也不是最舊的" },
  { name: "s10_attempt_cooldown", reports: [[2, 86]], reportsH: [[6, null]], want: false, why: "有落差，但 6 小時前才有人回報「查不到」：嘗試冷卻（1 天）照舊壓著" },
  { name: "s11_attempt_cooldown_passed", reports: [[3, 86], [2, null]], want: true, why: "有落差，「查不到」是 2 天前：冷卻過了，用的是最近一次有數字的回報（86），不是那筆空的" },
  { name: "s12_zero_zero", reports: [[1, 0]], want: false, why: "回報 0 位、我們 0 位：沒有落差（0 > 0 不成立）" },
  { name: "s14_after_election_no_gap", reports: [[1, 5]], elected: 3, notElected: 2, want: false, why: "選後大家是 elected／not_elected：照算，沒有落差就不派（只算 filed、declared 的話人數歸零、缺口永遠成立，每 10 分鐘派一次）" },
  { name: "s15_after_election_gap", reports: [[1, 5]], elected: 3, want: true, why: "選後 elected 3 人、回報 5 位：缺 2 位，照樣繼續派" },
  { name: "s13_zero_theirs", reports: [[1, 0]], filed: 2, want: false, why: "回報 0 位、我們 2 位：負落差，照舊壓 7 天" },
];

async function seed(db: PGlite) {
  await db.exec(`
    CREATE TABLE locations (name text);
    CREATE TABLE roster_check_scope (election_id int, election_type text, recheck_days int NOT NULL DEFAULT 7, enabled boolean NOT NULL DEFAULT true,
      list_announced_on date, registration_closed_on date, qualification_review_by date, ballot_draw_on date, municipal_mayor_list_on date);
    CREATE TABLE roster_checks (id bigserial PRIMARY KEY, election_id int, region text, election_type text, checked_at timestamptz, cec_count int);
    CREATE TABLE politicians (id int PRIMARY KEY, region text);
    CREATE TABLE regions (id int PRIMARY KEY, region text);
    CREATE TABLE politician_elections (id serial PRIMARY KEY, politician_id int, election_id int, election_type text, region_id int, candidacy_status text);
    CREATE FUNCTION roster_attempt_cooldown_days() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE FUNCTION roster_schedule_text(date, date, date, date, date, date DEFAULT CURRENT_DATE) RETURNS text LANGUAGE sql AS $$ SELECT '' $$;
    INSERT INTO roster_check_scope (election_id, election_type, list_announced_on, registration_closed_on) VALUES (2026, '縣市議員', '2026-11-17', '2026-09-04');
  `);
  let pid = 0;
  for (const s of SCENARIOS) {
    await db.query(`INSERT INTO locations VALUES ($1)`, [s.name]);
    for (const [d, c] of s.reports ?? []) await db.query(`INSERT INTO roster_checks (election_id, region, election_type, checked_at, cec_count) VALUES (2026, $1, '縣市議員', now() - ($2 || ' days')::interval, $3)`, [s.name, d, c]);
    for (const [h, c] of s.reportsH ?? []) await db.query(`INSERT INTO roster_checks (election_id, region, election_type, checked_at, cec_count) VALUES (2026, $1, '縣市議員', now() - ($2 || ' hours')::interval, $3)`, [s.name, h, c]);
    for (const [status, n] of [["filed", s.filed], ["declared", s.declared], ["considering", s.considering], ["withdrawn", s.withdrawn], ["elected", s.elected], ["not_elected", s.notElected]] as const) {
      for (let i = 0; i < (n ?? 0); i++) {
        pid++;
        await db.query(`INSERT INTO politicians VALUES ($1, $2)`, [pid, s.name]);
        await db.query(`INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status) VALUES ($1, 2026, '縣市議員', $2)`, [pid, status]);
      }
    }
  }
}

/** 這支查詢派出去的（以 location 名稱當 key） */
async function dispatched(db: PGlite, sql: string): Promise<Set<string>> {
  // 這一段 SELECT 的欄位沒有名字（在函式裡由 RETURNS TABLE 命名）：第 1 欄就是 task_id（auto:roster_check:<屆別>:<縣市>:<選舉別>）
  const r = await db.query<string[]>(sql, [], { rowMode: "array" });
  return new Set(r.rows.map((x) => x[0].split(":")[3]));
}

const db = new PGlite();
await seed(db);
const BASE = rosterSql(NEW_BODY);

Deno.test("R2-3 情境：最近一次回報的 cec_count 大於我們的名冊內人數 就繼續派，落差為 0 才套 recheck_days", async () => {
  const got = await dispatched(db, BASE);
  for (const s of SCENARIOS) assertEquals(got.has(s.name), s.want, `${s.name}：${s.why}`);
  // 對照：舊判準（前一版的那一段）在同一批情境上，缺口那幾件都派不出來——這就是要修的事
  const old = await dispatched(db, rosterSql(bodyOf(PREV_FN)));
  assertEquals(old.has("s03_changhua"), false, "舊判準：彰化縣議員（回報 86 位、我們 0 位）派不出來");
  assertEquals([...old].sort(), SCENARIOS.filter((s) => s.want && !["s03_changhua", "s04_declared_gap", "s05_considering_not_counted", "s06_withdrawn_not_counted", "s11_attempt_cooldown_passed", "s15_after_election_gap"].includes(s.name)).map((s) => s.name).sort(),
    "舊判準只派得出「從沒清查」與「過了 7 天」的那兩件");
  // 新判準比舊的多的，就是缺口還在的那六件；舊的有的新的都有（只多不少）
  const added = [...got].filter((x) => !old.has(x)).sort();
  assertEquals(added, ["s03_changhua", "s04_declared_gap", "s05_considering_not_counted", "s06_withdrawn_not_counted", "s11_attempt_cooldown_passed", "s15_after_election_gap"]);
  for (const x of old) assert(got.has(x), `${x}：舊判準派的，新判準不能少`);
});

Deno.test("R2-4 還原驗證：把判準改壞（10 種），指定的情境必須轉紅——這組不紅，上面的全綠什麼都證明不了", async () => {
  const MUTATIONS: Array<{ name: string; edit: (b: string) => string; breaks: string[] }> = [
    { name: "拿掉缺口那一行（回到舊判準）", edit: (b) => mutate(b, "         OR COALESCE(rc.last_cec_count, 0) > COALESCE(o.n_listed, 0)\n", ""),
      breaks: ["s03_changhua", "s04_declared_gap", "s05_considering_not_counted", "s06_withdrawn_not_counted", "s11_attempt_cooldown_passed"] },
    { name: "> 改成 >=（沒有落差也繼續派）", edit: (b) => mutate(b, "COALESCE(rc.last_cec_count, 0) > COALESCE(o.n_listed, 0)", "COALESCE(rc.last_cec_count, 0) >= COALESCE(o.n_listed, 0)"),
      breaks: ["s02_equal", "s04b_declared_counts", "s09_latest_report_used", "s12_zero_zero"] },
    { name: "> 改成 <（方向相反）", edit: (b) => mutate(b, "COALESCE(rc.last_cec_count, 0) > COALESCE(o.n_listed, 0)", "COALESCE(rc.last_cec_count, 0) < COALESCE(o.n_listed, 0)"),
      breaks: ["s03_changhua", "s07_ours_more"] },
    { name: "缺口人數把 considering 也算進去", edit: (b) => mutate(b, "COUNT(*) FILTER (WHERE COALESCE(pe.candidacy_status, '') NOT IN ('considering', 'withdrawn')) AS n_listed", "COUNT(*) AS n_listed"),
      breaks: ["s05_considering_not_counted"] },
    { name: "缺口人數不算 declared", edit: (b) => mutate(b, "NOT IN ('considering', 'withdrawn')) AS n_listed", "NOT IN ('considering', 'withdrawn', 'declared')) AS n_listed"),
      breaks: ["s04b_declared_counts"] },
    { name: "缺口人數只算 filed、declared（選後的當選／落選不算）", edit: (b) => mutate(b, "COALESCE(pe.candidacy_status, '') NOT IN ('considering', 'withdrawn')", "pe.candidacy_status IN ('filed', 'declared')"),
      breaks: ["s14_after_election_no_gap"] },
    { name: "取最大的 cec_count、不取最近一次", edit: (b) => mutate(b, "ORDER BY checked_at DESC, id DESC) FILTER", "ORDER BY cec_count DESC NULLS LAST) FILTER"),
      breaks: ["s09_latest_report_used"] },
    { name: "我們沒有任何參選紀錄時 n_listed 是 NULL、沒當成 0", edit: (b) => mutate(b, "COALESCE(o.n_listed, 0)", "o.n_listed"),
      breaks: ["s03_changhua", "s11_attempt_cooldown_passed"] },
    { name: "最近一次 cec_count 把「試過沒查到」（NULL）的回報也算進去", edit: (b) => mutate(b, "(array_agg(cec_count ORDER BY checked_at DESC, id DESC) FILTER (WHERE cec_count IS NOT NULL))[1]", "(array_agg(cec_count ORDER BY checked_at DESC, id DESC))[1]"),
      breaks: ["s11_attempt_cooldown_passed"] },
    { name: "有缺口就不管嘗試冷卻（缺口條件也放進冷卻那一行）", edit: (b) => mutate(b,
        "    AND (rc.last_attempt_without_count IS NULL\n", "    AND (COALESCE(rc.last_cec_count, 0) > COALESCE(o.n_listed, 0) OR rc.last_attempt_without_count IS NULL\n"),
      breaks: ["s10_attempt_cooldown"] },
  ];
  for (const m of MUTATIONS) {
    const got = await dispatched(db, rosterSql(m.edit(NEW_BODY)));
    const red = SCENARIOS.filter((s) => got.has(s.name) !== s.want).map((s) => s.name);
    for (const must of m.breaks) assert(red.includes(must), `還原驗證「${m.name}」：${must} 應該轉紅，實際轉紅的是 [${red.join(", ")}]`);
  }
});
