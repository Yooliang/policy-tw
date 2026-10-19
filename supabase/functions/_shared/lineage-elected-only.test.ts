/**
 * 脈絡只收「那一屆已投票且當選」的政見：承諾 → 政見 → 脈絡（維護者 2026-10-19，協議 1.99.0，#670 第二步；
 * migration 20261019020000_lineage_elected_only.sql）。更正 10-06 #349 的分組範圍「還沒投票的屆別看在選者」。
 *
 *   A. TS 規則（lineagePolicyIneligibleReason）與訊息
 *   B. SQL 與 TS 兩份對齊：同一批資料（PGlite）上，lineage_policy_ineligible_reason／lineage_policy_eligible 與 TS 逐案相同；
 *      lineage_candidate_scope（真的函式本體）收進來的政見＝合格的政見。還原驗證：把 SQL 任何一條判斷拿掉，這裡要紅
 *   C. 開票後當選人的政見自動進格（真的臂本體 contribution_auto_tasks_lineage_candidates）：政見一進範圍、那一格的指紋就變、重新派；
 *      同一場選舉兩位候選人（還沒投票）不會被放進同一格
 *   D. 讀取端推導、資料不動（真的視圖 lineages_full）：policy_ids 只帶合格的、不合格的資料不動、事實之後才變視圖自動跟著變、台北日期、
 *      合格數 0 的脈絡那一列還在且 existing_lineages 仍列出；還原驗證：拿掉視圖的合格條件，這裡要紅
 *   E. 交件前置檢查與落庫：歸入不合格的政見 → apply_would_fail／failed；detach 不受限；已經在這條脈絡裡的不再問；查詢出錯放行
 *   F. migration 文字守門（範圍函式與視圖機械替換、不寫任何資料、沒有派工臂／觸發器／排程）與協議文字
 *   G. 同一人同一屆的多條政見不是脈絡（維護者同日檢討後追加）：純函式 isSamePersonSameTerm、前置檢查與落庫各判一次、協議文字
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyContribution } from "./apply-contribution.ts";
import { precheckApplyTargets } from "./apply-precheck.ts";
import { isElectedTerm, isElectionVoted } from "./elected-term.ts";
import { handleContribute } from "./contribute-handler.ts";
import { fnText, migrationNames, mutate, readMig } from "./arms-pglite.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { CONTRIBUTION_TYPES, TASK_TYPES } from "./contribution-schema.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { TASK_GUIDANCE } from "./task-guidance.ts";
import { LINEAGE_VERIFY_HINT } from "./task-context.ts";
import { readSkillWithTypes } from "./skill-text.ts";
import {
  CANDIDACY_STATUS_LABEL, candidacyStatusText, isSamePersonSameTerm, LINEAGE_INELIGIBLE_REASONS, type LineageEligibilityFacts, lineageIneligibleMessage,
  lineagePolicyIneligibleReason, lineageSamePersonMessage, taipeiToday,
} from "./lineage.ts";

const MIG = "20261019020000_lineage_elected_only.sql";
// 「今天」一律是台北日期 activity_today()（P0 migration 的真函式）
const ACTIVITY_TODAY_FN = fnText(await readMig("20261008001000_activity_windows_p0.sql"), "activity_today");
const SQL = await readMig(MIG);
const LINEAGE_MIG = "20261006034900_policy_lineages.sql";
const SCOPE_PREV_MIG = "20261006220000_candidacy_read_side.sql";
const ARMS_PREV_MIG = "20261011120000_traffic_watch_arms.sql";

const uid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const X = uid("aaaaaaaa", 1); // 2018 當選、2022 落選
const Y = uid("aaaaaaaa", 2); // 2022 當選（另有一筆退選的紀錄）；也是「今天」「昨天」那兩屆的當選人
const Z = uid("aaaaaaaa", 3); // 只在 2099（還沒投票）表態參選；2022 只有「表態參選」（結果沒記）
const Z2 = uid("aaaaaaaa", 4); // 2099 就是「當選」（不可能的資料）
const Q = uid("aaaaaaaa", 5); // 2022 沒有任何參選紀錄
const PL = (n: number) => uid("bbbbbbbb", n);
const L1 = uid("11111111", 1);
const L2 = uid("11111111", 2);
const L3 = uid("11111111", 3);
const L4 = uid("11111111", 4);
const L5 = uid("11111111", 5);
const L6 = uid("11111111", 6);

// ============================================================
// A. TS 規則
// ============================================================
const facts = (over: Partial<LineageEligibilityFacts> = {}): LineageEligibilityFacts => ({
  policy: { removed_at: null, election_id: 2022 }, election_date: "2022-11-26", candidacy_statuses: ["elected"], ...over,
});

Deno.test("A1 TS：合格＝那一屆已投票而且提出者在那一屆有當選紀錄；其餘各回一個原因", () => {
  const today = "2026-10-19";
  assertEquals(lineagePolicyIneligibleReason(facts(), today), null);
  assertEquals(lineagePolicyIneligibleReason(facts({ policy: null }), today), "not_found");
  assertEquals(lineagePolicyIneligibleReason(facts({ policy: { removed_at: "2026-01-01T00:00:00Z", election_id: 2022 } }), today), "removed");
  assertEquals(lineagePolicyIneligibleReason(facts({ policy: { removed_at: null, election_id: null }, election_date: null }), today), "no_election");
  assertEquals(lineagePolicyIneligibleReason(facts({ election_date: null }), today), "no_election", "屆別編號指到不存在的那一屆");
  assertEquals(lineagePolicyIneligibleReason(facts({ election_date: "2026-11-28", candidacy_statuses: ["declared"] }), today), "not_voted_yet");
  assertEquals(lineagePolicyIneligibleReason(facts({ candidacy_statuses: ["not_elected"] }), today), "not_elected");
  assertEquals(lineagePolicyIneligibleReason(facts({ candidacy_statuses: [] }), today), "not_elected", "那一屆沒有任何參選紀錄");
  assertEquals(lineagePolicyIneligibleReason(facts({ candidacy_statuses: ["declared"] }), today), "not_elected", "投過票但結果還沒記");
  assertEquals(lineagePolicyIneligibleReason(facts({ candidacy_statuses: ["withdrawn", "elected"] }), today), null, "同一屆有幾筆紀錄，只要有一筆當選");
});

Deno.test("A2 TS：投票日當天還算沒投票；前一天起才算已投票；還沒投票就算標了當選也不收", () => {
  assertEquals(lineagePolicyIneligibleReason(facts({ election_date: "2026-10-19" }), "2026-10-19"), "not_voted_yet");
  assertEquals(lineagePolicyIneligibleReason(facts({ election_date: "2026-10-18" }), "2026-10-19"), null);
  assertEquals(lineagePolicyIneligibleReason(facts({ election_date: "2099-11-28", candidacy_statuses: ["elected"] }), "2026-10-19"), "not_voted_yet");
  assertEquals(taipeiToday(new Date("2026-10-19T15:59:59Z")), "2026-10-19");
  assertEquals(taipeiToday(new Date("2026-10-19T16:00:00Z")), "2026-10-20", "UTC 16:00 已經是台北隔天");
  assertEquals(lineagePolicyIneligibleReason(facts({ election_date: "2022-11-26T00:00:00+00:00" }), "2026-10-19"), null, "日期帶時間也只比日期部分");
});

Deno.test("A3 TS：判斷看那條政見所屬的那一屆，不看這個人現在在不在任（2018 當選、2022 落選）", () => {
  const today = "2026-10-19";
  assertEquals(lineagePolicyIneligibleReason(facts({ policy: { removed_at: null, election_id: 2018 }, election_date: "2018-11-24", candidacy_statuses: ["elected"] }), today), null);
  assertEquals(lineagePolicyIneligibleReason(facts({ policy: { removed_at: null, election_id: 2022 }, election_date: "2022-11-26", candidacy_statuses: ["not_elected"] }), today), "not_elected");
});

Deno.test("A4 訊息：講哪一條、為什麼、怎麼辦；純中文；原因清單跟 SQL 同一組", () => {
  const future = lineageIneligibleMessage("not_voted_yet", { title: "推動興建巨蛋", electionDate: "2026-11-28" });
  assertStringIncludes(future, "「推動興建巨蛋」");
  assertStringIncludes(future, "2026-11-28");
  assertStringIncludes(future, "還沒投票");
  assertStringIncludes(future, "承諾");
  const lost = lineageIneligibleMessage("not_elected", { title: "某政見", electionDate: "2022-11-26", statuses: ["not_elected"] });
  assertStringIncludes(lost, "沒有當選");
  assertStringIncludes(lost, "落選");
  assertStringIncludes(lost, "落選者的承諾不收");
  assertStringIncludes(lineageIneligibleMessage("not_elected", { title: "某政見", statuses: [] }), "沒有這一屆的參選紀錄");
  assertStringIncludes(lineageIneligibleMessage("no_election", { title: "某政見" }), "election_id");
  assertEquals([...LINEAGE_INELIGIBLE_REASONS], ["not_found", "removed", "no_election", "not_voted_yet", "not_elected"]);
  // SQL 的原因字串都在 TS 清單裡
  const sqlReasons = [...fnText(SQL, "lineage_policy_ineligible_reason").matchAll(/(?:THEN|ELSE) '([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(sqlReasons, [...LINEAGE_INELIGIBLE_REASONS]);
  // 參選狀態字樣（只用在交件被擋的說明裡）：六個狀態都有字，沒有紀錄也講清楚
  assertEquals(Object.keys(CANDIDACY_STATUS_LABEL).sort(), ["considering", "declared", "elected", "filed", "not_elected", "withdrawn"]);
  assertEquals(candidacyStatusText(["declared", "elected", "declared"]), "表態參選、當選");
});

Deno.test("A5 底層 isElectedTerm（#672 共用）：已投票（投票日早於今天，當天算還沒）而且有一筆當選；脈絡資格建在它上面", () => {
  assertEquals(isElectionVoted("2022-11-26", "2026-10-19"), true);
  assertEquals(isElectionVoted("2026-10-19", "2026-10-19"), false, "投票日當天算還沒投票");
  assertEquals(isElectionVoted("2026-10-18", "2026-10-19"), true);
  assertEquals(isElectionVoted("2022-11-26T00:00:00+00:00", "2026-10-19"), true, "帶時間只看日期部分");
  assertEquals(isElectionVoted(null, "2026-10-19"), false, "沒有投票日＝不知道，當成還沒");
  const f = (date: string | null, statuses: Array<string | null>) => ({ election_date: date, candidacy_statuses: statuses });
  assertEquals(isElectedTerm(f("2022-11-26", ["elected"]), "2026-10-19"), true);
  assertEquals(isElectedTerm(f("2022-11-26", ["withdrawn", "elected"]), "2026-10-19"), true, "同一屆有幾筆，一筆當選就算");
  assertEquals(isElectedTerm(f("2022-11-26", ["not_elected"]), "2026-10-19"), false);
  assertEquals(isElectedTerm(f("2022-11-26", []), "2026-10-19"), false);
  assertEquals(isElectedTerm(f("2099-11-28", ["elected"]), "2026-10-19"), false, "還沒投票就算標了當選也不算");
  assertEquals(isElectedTerm(f("2022-11-26", ["elected"]), "2022-11-26"), false, "today 參數化：投票日當天還不算");
  assertEquals(isElectedTerm(f("2022-11-26", ["elected"]), "2022-11-27"), true);
  assertEquals(isElectedTerm(f(null, ["elected"]), "2026-10-19"), false);
  // 脈絡資格建在底層上：同一組事實，資格合格 ⇔ 底層通過（沒移除、有屆別的前提下）
  for (const [date, st] of [["2022-11-26", ["elected"]], ["2022-11-26", ["not_elected"]], ["2099-11-28", ["elected"]]] as Array<[string, string[]]>) {
    const eligible = lineagePolicyIneligibleReason(facts({ election_date: date, candidacy_statuses: st }), "2026-10-19") === null;
    assertEquals(eligible, isElectedTerm(f(date, st), "2026-10-19"));
  }
});

// ============================================================
// B. SQL 與 TS 對齊（PGlite）
// ============================================================
const BASE_SCHEMA = `
${ACTIVITY_TODAY_FN}
CREATE TABLE elections (id integer PRIMARY KEY, election_date date NOT NULL);
CREATE TABLE politicians (id uuid PRIMARY KEY, name text, merged_into uuid);
CREATE TABLE politician_elections (id serial PRIMARY KEY, politician_id uuid, election_id integer, election_type text, candidacy_status text, region_id integer);
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text);
CREATE TABLE policies (id uuid PRIMARY KEY, title text, description text, category text, status text, lineage_id uuid, politician_id uuid, election_id integer, removed_at timestamptz);
CREATE TABLE lineages (id uuid PRIMARY KEY, title text, category text, level text, region text, sub_region text);
CREATE TABLE lineage_candidate_reviews (review_key text, fingerprint text);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, task_id text);
INSERT INTO regions VALUES (1, '台中市', NULL);
INSERT INTO elections VALUES (2018, '2018-11-24'), (2022, '2022-11-26'), (2099, '2099-11-28');
INSERT INTO elections VALUES (3000, activity_today()), (3001, activity_today() - 1);   -- 投票日是今天／昨天
INSERT INTO politicians VALUES ('${X}', '甲', NULL), ('${Y}', '乙', NULL), ('${Z}', '丙', NULL), ('${Z2}', '丁', NULL), ('${Q}', '戊', NULL);
`;
const cand = (pid: string, eid: number, status: string | null) =>
  `INSERT INTO politician_elections (politician_id, election_id, election_type, candidacy_status, region_id) VALUES ('${pid}', ${eid}, '縣市長', ${status ? `'${status}'` : "NULL"}, 1);`;
const pol = (n: number, title: string, pid: string, eid: number | null, extra: { removed?: boolean; lineage?: string | null } = {}) =>
  `INSERT INTO policies (id, title, description, category, status, lineage_id, politician_id, election_id, removed_at) VALUES ('${PL(n)}', '${title}', '說明', '交通建設', 'Campaign Pledge', ${extra.lineage ? `'${extra.lineage}'` : "NULL"}, '${pid}', ${eid ?? "NULL"}, ${extra.removed ? "now()" : "NULL"});`;

/** 各種情況：id → 預期的原因（SQL 與 TS 都要得到這個） */
const CASES: Array<{ n: number; label: string; want: string | null }> = [
  { n: 1, label: "2018 當選（他 2022 落選，但這條是 2018 那一屆的）", want: null },
  { n: 2, label: "同一個人 2022 落選那一屆的政見", want: "not_elected" },
  { n: 3, label: "2022 同一屆有退選與當選兩筆紀錄", want: null },
  { n: 4, label: "2099 還沒投票、表態參選", want: "not_voted_yet" },
  { n: 5, label: "2099 資料標了當選（還沒投票就不收）", want: "not_voted_yet" },
  { n: 6, label: "投票日是今天", want: "not_voted_yet" },
  { n: 7, label: "投票日是昨天、當選", want: null },
  { n: 8, label: "2022 已投票但只記到表態參選（結果沒記）", want: "not_elected" },
  { n: 9, label: "2022 沒有任何參選紀錄", want: "not_elected" },
  { n: 10, label: "沒標屆別", want: "no_election" },
  { n: 11, label: "屆別編號指到不存在的那一屆", want: "no_election" },
  { n: 12, label: "已移除", want: "removed" },
  { n: 99, label: "沒這條政見", want: "not_found" },
];
const DATA = [
  cand(X, 2018, "elected"), cand(X, 2022, "not_elected"),
  cand(Y, 2022, "withdrawn"), cand(Y, 2022, "elected"), cand(Y, 3000, "elected"), cand(Y, 3001, "elected"),
  cand(Z, 2099, "declared"), cand(Z, 2022, "declared"), cand(Z2, 2099, "elected"),
  pol(1, "二〇一八年的政見", X, 2018), pol(2, "二〇二二年落選的政見", X, 2022), pol(3, "二〇二二年當選的政見", Y, 2022),
  pol(4, "還沒投票的承諾", Z, 2099), pol(5, "還沒投票卻標當選", Z2, 2099), pol(6, "投票日是今天", Y, 3000), pol(7, "投票日是昨天", Y, 3001),
  pol(8, "結果沒記", Z, 2022), pol(9, "沒有參選紀錄", Q, 2022), pol(10, "沒標屆別", Y, null), pol(11, "屆別不存在", Y, 9999),
  pol(12, "已移除的政見", Y, 2022, { removed: true }),
].join("\n");

// 兩層：底層 policy_is_elected_term（那一屆已投票且當選）在最前面，脈絡的資格 lineage_policy_ineligible_reason／lineage_policy_eligible 建在它上面
const ELIGIBLE_FNS = () => `${fnText(SQL, "policy_is_elected_term")}\n${fnText(SQL, "lineage_policy_ineligible_reason")}\n${fnText(SQL, "lineage_policy_eligible")}`;

async function eligibilityDb(overrideFns?: (s: string) => string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA + DATA);
  await db.exec((overrideFns ?? ((s) => s))(ELIGIBLE_FNS()));
  return db;
}

/** 從原始資料表讀事實（不經過 SQL 函式），餵給 TS 規則 */
async function factsOf(db: PGlite, id: string): Promise<LineageEligibilityFacts> {
  const p = (await db.query<{ removed_at: string | null; election_id: number | null; politician_id: string }>(
    `SELECT removed_at::text AS removed_at, election_id, politician_id FROM policies WHERE id = $1`, [id])).rows[0];
  if (!p) return { policy: null, election_date: null, candidacy_statuses: [] };
  const e = p.election_id === null ? undefined : (await db.query<{ d: string }>(`SELECT election_date::text AS d FROM elections WHERE id = $1`, [p.election_id])).rows[0];
  const s = p.election_id === null ? [] : (await db.query<{ s: string | null }>(
    `SELECT candidacy_status AS s FROM politician_elections WHERE politician_id = $1 AND election_id = $2`, [p.politician_id, p.election_id])).rows;
  return { policy: { removed_at: p.removed_at, election_id: p.election_id }, election_date: e?.d ?? null, candidacy_statuses: s.map((r) => r.s) };
}

/** SQL 與 TS 不一致的案例清單（空＝兩邊一樣）：每一案、每一個「今天」，底層與脈絡資格各比一次 */
async function mismatches(db: PGlite): Promise<string[]> {
  const today = (await db.query<{ t: string }>(`SELECT activity_today()::text AS t`)).rows[0].t;
  // 「今天」參數化：投票日前一天、當天、後一天（2018／2022／2099 三屆）都試，投票日當天要算還沒投票
  const todays = [today, "2018-11-24", "2018-11-25", "2022-11-26", "2022-11-27", "2099-11-28", "2099-11-29"];
  const bad: string[] = [];
  for (const c of CASES) {
    const facts = await factsOf(db, PL(c.n));
    // 預設參數（今天）那一組，也都要等於預期
    const sqlReason = (await db.query<{ r: string | null }>(`SELECT lineage_policy_ineligible_reason($1::uuid) AS r`, [PL(c.n)])).rows[0].r;
    const sqlOk = (await db.query<{ b: boolean }>(`SELECT lineage_policy_eligible($1::uuid) AS b`, [PL(c.n)])).rows[0].b;
    const sqlTerm = (await db.query<{ b: boolean }>(`SELECT policy_is_elected_term($1::uuid) AS b`, [PL(c.n)])).rows[0].b;
    const tsReason = lineagePolicyIneligibleReason(facts, today);
    if (sqlReason !== tsReason || sqlOk !== (tsReason === null) || sqlReason !== c.want) bad.push(`${c.label}：SQL=${sqlReason} TS=${tsReason} 預期=${c.want}`);
    const tsTerm = isElectedTerm({ election_date: facts.election_date, candidacy_statuses: facts.candidacy_statuses }, today);
    if (sqlTerm !== tsTerm) bad.push(`${c.label}：底層 SQL=${sqlTerm} TS=${tsTerm}`);
    for (const t of todays) {
      const r = (await db.query<{ r: string | null }>(`SELECT lineage_policy_ineligible_reason($1::uuid, $2::date) AS r`, [PL(c.n), t])).rows[0].r;
      const b = (await db.query<{ b: boolean }>(`SELECT policy_is_elected_term($1::uuid, $2::date) AS b`, [PL(c.n), t])).rows[0].b;
      const tsR = lineagePolicyIneligibleReason(facts, t);
      const tsB = isElectedTerm({ election_date: facts.election_date, candidacy_statuses: facts.candidacy_statuses }, t);
      if (r !== tsR) bad.push(`${c.label}（今天=${t}）：資格 SQL=${r} TS=${tsR}`);
      if (b !== tsB) bad.push(`${c.label}（今天=${t}）：底層 SQL=${b} TS=${tsB}`);
      // 上層建在底層上：合格 ⇔ 底層通過且沒被移除、有屆別
      if ((r === null) !== (b && facts.policy !== null && !facts.policy.removed_at)) bad.push(`${c.label}（今天=${t}）：資格與底層不一致 資格=${r} 底層=${b}`);
    }
  }
  return bad;
}

Deno.test("B1 SQL 與 TS 對齊：同一批資料逐案相同，也都等於預期", async () => {
  const db = await eligibilityDb();
  assertEquals(await mismatches(db), []);
  await db.close();
});

Deno.test("B2 還原驗證：把 SQL 的任何一條判斷拿掉，對齊測試就紅（標記字串唯一）", async () => {
  const cases: Array<[string, string, string]> = [
    ["底層拿掉『要當選』", "AND q.candidacy_status = 'elected'", ""],
    ["底層拿掉『已投票』", "SELECT e.election_date < p_today", "SELECT true"],
    ["底層投票日當天算已投票", "e.election_date < p_today", "e.election_date <= p_today"],
    ["底層忽略參數、永遠用今天", "e.election_date < p_today", "e.election_date < activity_today()"],
    ["上層拿掉『還沒投票』那一分", "WHEN e.election_date >= p_today THEN 'not_voted_yet'", ""],
    ["上層拿掉『已移除』", "WHEN pl.removed_at IS NOT NULL THEN 'removed'", ""],
    ["上層拿掉『沒標屆別』", "WHEN pl.election_id IS NULL OR e.id IS NULL THEN 'no_election'", ""],
    ["上層不問底層、自己判", "WHEN policy_is_elected_term(pl.id, p_today) THEN NULL", "WHEN e.election_date < p_today THEN NULL"],
  ];
  for (const [label, from, to] of cases) {
    const db = await eligibilityDb((s) => mutate(s, from, to));
    const bad = await mismatches(db);
    assert(bad.length > 0, `${label}：改壞了對齊測試卻沒紅`);
    await db.close();
  }
});

Deno.test("B2b 兩層的結構：脈絡資格呼叫底層（不是各寫一份）；底層是獨立的 SQL 函式、today 有預設值；底層檔沒有 import（前端 lib 也能引用）", async () => {
  const reason = fnText(SQL, "lineage_policy_ineligible_reason");
  assertStringIncludes(reason, "WHEN policy_is_elected_term(pl.id, p_today) THEN NULL");
  assert(!reason.includes("candidacy_status"), "脈絡資格自己不再讀參選狀態：那是底層的事");
  assertStringIncludes(fnText(SQL, "policy_is_elected_term"), "p_today DATE DEFAULT activity_today()");
  assertStringIncludes(fnText(SQL, "lineage_policy_eligible"), "lineage_policy_ineligible_reason(p_policy_id, p_today) IS NULL");
  const src = await Deno.readTextFile(new URL("./elected-term.ts", import.meta.url));
  assert(!/^\s*import\s/m.test(src), "elected-term.ts 不能有 import（要能被前端 lib 直接引用）");
  const lineage = await Deno.readTextFile(new URL("./lineage.ts", import.meta.url));
  assertStringIncludes(lineage, "isElectedTerm({ election_date: f.election_date, candidacy_statuses: f.candidacy_statuses }, today)");
  assert(!/candidacy_statuses\.includes\("elected"\)/.test(lineage), "lineage.ts 不再自己判當選：交給 isElectedTerm");
});

/** 範圍函式本體（真的）＋它用到的表；回它收進來的政見 id */
async function scopePolicyIds(db: PGlite, scopeSql: string): Promise<string[]> {
  await db.exec(scopeSql);
  return (await db.query<{ policy_id: string }>(`SELECT DISTINCT policy_id FROM lineage_candidate_scope() ORDER BY 1`)).rows.map((r) => r.policy_id);
}

Deno.test("B3 候選格範圍（真的函式本體）只收合格的政見；還沒投票的承諾、落選者的、沒結果的都不進格", async () => {
  const db = await eligibilityDb();
  const got = await scopePolicyIds(db, fnText(SQL, "lineage_candidate_scope"));
  const eligible = CASES.filter((c) => c.want === null).map((c) => PL(c.n)).sort();
  assertEquals(got, eligible);
  // 每一條範圍裡的政見，共用資格判斷也說合格（migration 自我檢查同一件事）
  for (const id of got) assertEquals((await db.query<{ b: boolean }>(`SELECT lineage_policy_eligible($1::uuid) AS b`, [id])).rows[0].b, true);
  await db.close();
});

Deno.test("B4 還原驗證：把『還沒投票看在選者』那一支放回去，範圍就收進不合格的政見（B3 會紅）", async () => {
  const db = await eligibilityDb();
  const oldBranch = "AND ((e.election_date >= activity_today() AND x.candidacy_status IS DISTINCT FROM 'withdrawn') OR (e.election_date < activity_today() AND x.candidacy_status = 'elected'))";
  const mutated = mutate(fnText(SQL, "lineage_candidate_scope"), "AND e.election_date < activity_today() AND x.candidacy_status = 'elected'", oldBranch);
  const got = await scopePolicyIds(db, mutated);
  const eligible = CASES.filter((c) => c.want === null).map((c) => PL(c.n)).sort();
  assert(got.some((id) => !eligible.includes(id)), "放回舊範圍卻沒收進任何不合格的政見：這支測試的資料沒有咬住");
  await db.close();
});

// ============================================================
// C. 開票後當選人的政見自動進格（真的臂本體）
// ============================================================
const LINEAGE_SQL = await readMig(LINEAGE_MIG);
const BLOCK_ARM = () => `${fnText(LINEAGE_SQL, "lineage_block_key")}\n${fnText(SQL, "lineage_candidate_scope")}\n${fnText(LINEAGE_SQL, "contribution_auto_tasks_lineage_candidates")}`;

Deno.test("C1 同一場選舉的兩位候選人（還沒投票）不會被放進同一格；開票、當選之後政見自己進格、指紋變了就重新派", async () => {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(BLOCK_ARM());
  const tasks = async () => (await db.query<{ task_id: string; target: { policies: Array<{ policy_id: string }>; fingerprint: string } }>(
    `SELECT task_id, target FROM contribution_auto_tasks_lineage_candidates()`)).rows;
  const ids = (t: { target: { policies: Array<{ policy_id: string }> } }) => t.target.policies.map((p) => p.policy_id).sort();

  // 2018 當選的 X 一條；2099（還沒投票）兩位候選人 Z、Z2 各一條，都是台中市、同一類別
  await db.exec([cand(X, 2018, "elected"), cand(Z, 2099, "declared"), cand(Z2, 2099, "declared"),
    pol(1, "前任的政見", X, 2018), pol(2, "候選人甲的承諾", Z, 2099), pol(3, "候選人乙的承諾", Z2, 2099)].join("\n"));
  assertEquals((await tasks()).length, 0, "還沒投票：兩位候選人的承諾不進格，這一格只剩一條，不派（舊範圍會把三條放成一格）");

  // 開票：2099 那一屆變成已投票，Z 當選、Z2 落選
  await db.exec(`UPDATE elections SET election_date = activity_today() - 1 WHERE id = 2099;
    UPDATE politician_elections SET candidacy_status = 'elected' WHERE politician_id = '${Z}' AND election_id = 2099;
    UPDATE politician_elections SET candidacy_status = 'not_elected' WHERE politician_id = '${Z2}' AND election_id = 2099;`);
  const t1 = await tasks();
  assertEquals(t1.length, 1, "開票後當選人的政見自己進格（不用另外觸發）");
  assertEquals(ids(t1[0]), [PL(1), PL(2)].sort(), "落選的人的承諾不進格");
  const fp1 = t1[0].target.fingerprint;

  // 代理看過這一份清單：記一列結論 → 同一份清單不再派
  await db.query(`INSERT INTO lineage_candidate_reviews (review_key, fingerprint) VALUES ('block:' || $1, $2)`, [t1[0].task_id.split(":")[2], fp1]);
  assertEquals((await tasks()).length, 0);

  // 之後又有一位當選人的政見進格：清單變了，指紋變，是新的一件
  await db.exec([cand(Y, 2022, "elected"), pol(4, "另一位當選人的政見", Y, 2022)].join("\n"));
  const t2 = await tasks();
  assertEquals(t2.length, 1, "格子內容變了就重新派");
  assertEquals(ids(t2[0]), [PL(1), PL(2), PL(4)].sort());
  assert(t2[0].target.fingerprint !== fp1);
  assert(t2[0].task_id !== t1[0].task_id, "task_id 帶指紋，所以是不同的一件");
  await db.close();
});

// ============================================================
// D. 讀取端推導、資料不動：lineages_full.policy_ids 只算合格的政見（真的視圖本體）
// ============================================================
// 維護者 10-19：跟 #672 承諾→政見同一做法（10-07「推導、不寫資料」）——不合格的政見仍掛在 policies.lineage_id 上，讀取端不算它；
// 開票後當選者那條自動回到脈絡、結果更正自動跟著變、沒有 edit_history 雜訊。
const VIEW_TEXT = () => {
  const a = SQL.indexOf("CREATE OR REPLACE VIEW lineages_full AS");
  return SQL.slice(a, SQL.indexOf("ALTER VIEW lineages_full", a));
};
const VIEW_STUBS = `
ALTER TABLE lineages ADD COLUMN summary text, ADD COLUMN admin_code text, ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE policies ADD COLUMN proposed_date date;
CREATE TABLE lineage_participants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lineage_id uuid, politician_id uuid, role text, basis text, source_url text, source_locator text, note text, created_at timestamptz DEFAULT now());
CREATE TABLE handovers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lineage_id uuid, from_politician_id uuid, from_election_id integer, to_politician_id uuid, to_election_id integer,
  from_office_id integer, to_office_id integer, handover_type text, decided_on date, note text, source_url text, source_locator text, created_at timestamptz DEFAULT now());
CREATE TABLE lineage_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), upper_lineage_id uuid, lower_lineage_id uuid, link_type text, note text, source_url text, source_locator text);
CREATE FUNCTION source_brief(t text, i text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
`;

/** 脈絡與政見的起始狀態（同一組資料）：L1 混合、L2 全合格、L3 全不合格、L4 只有已移除的、L5 沒標屆別與屆別不存在的、L6 本來就是空的 */
async function viewDb(mutateView?: (s: string) => string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA + DATA + VIEW_STUBS);
  await db.exec(ELIGIBLE_FNS());
  await db.exec(`INSERT INTO lineages (id, title, category, level, region, sub_region) VALUES
    ('${L1}', '混合的脈絡', '交通建設', 'county', '台中市', NULL),
    ('${L2}', '全部合格的脈絡', '交通建設', 'county', '台中市', NULL),
    ('${L3}', '只剩不合格的脈絡', '交通建設', 'national', NULL, NULL),
    ('${L4}', '只有已移除政見的脈絡', '交通建設', 'county', '台中市', NULL),
    ('${L5}', '掛著沒標屆別的脈絡', '交通建設', 'county', '台中市', NULL),
    ('${L6}', '本來就是空的脈絡', '交通建設', 'county', '台中市', NULL)`);
  await db.exec(`UPDATE policies SET lineage_id = '${L1}' WHERE id IN ('${PL(1)}', '${PL(7)}', '${PL(2)}', '${PL(4)}');
    UPDATE policies SET lineage_id = '${L2}' WHERE id = '${PL(3)}';
    UPDATE policies SET lineage_id = '${L3}' WHERE id IN ('${PL(5)}', '${PL(8)}');
    UPDATE policies SET lineage_id = '${L4}' WHERE id = '${PL(12)}';
    UPDATE policies SET lineage_id = '${L5}' WHERE id IN ('${PL(10)}', '${PL(11)}');`);
  await db.exec((mutateView ?? ((s) => s))(VIEW_TEXT()));
  return db;
}
const idsOf = async (db: PGlite, lineage: string): Promise<string[]> =>
  ((await db.query<{ policy_ids: string[] }>(`SELECT policy_ids FROM lineages_full WHERE id = $1`, [lineage])).rows[0]?.policy_ids ?? []).slice().sort();

/** 視圖的行為（回問題清單，空＝全對）：只算合格的、資料列都在、資料沒被動 */
async function viewScenario(db: PGlite): Promise<string[]> {
  const bad: string[] = [];
  const want: Array<[string, string[]]> = [[L1, [PL(1), PL(7)]], [L2, [PL(3)]], [L3, []], [L4, []], [L5, []], [L6, []]];
  for (const [l, ids] of want) {
    const got = await idsOf(db, l);
    if (JSON.stringify(got) !== JSON.stringify(ids.slice().sort())) bad.push(`脈絡 ${l} 的政見：${JSON.stringify(got)}，應為 ${JSON.stringify(ids)}`);
  }
  if ((await db.query(`SELECT 1 FROM lineages_full`)).rows.length !== 6) bad.push("合格政見數 0 的脈絡也要留著那一列（讀取端隱藏，不是視圖丟掉）");
  // 資料不動：不合格的政見還掛在原本的脈絡上
  const still = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM policies WHERE lineage_id IS NOT NULL`)).rows[0].n;
  if (still !== 10) bad.push(`policies.lineage_id 被動過：還掛著 ${still} 條，應為 10`);
  return bad;
}

Deno.test("D1 讀取端推導：lineages_full 只帶合格的政見；不合格的資料不動；合格數 0 的脈絡那一列還在（由前端隱藏）", async () => {
  const db = await viewDb();
  assertEquals(await viewScenario(db), []);
  await db.close();
});

Deno.test("D2 還原驗證：把視圖的合格條件拿掉，D1 的檢查就紅", async () => {
  const db = await viewDb((s) => mutate(s, " AND policy_is_elected_term(pl.id)", ""));
  assert((await viewScenario(db)).length > 0, "拿掉合格條件卻沒紅");
  await db.close();
});

Deno.test("D3 事實之後才變，視圖自動跟著變（不用任何排程）：開票後當選者那條回到脈絡、結果更正成落選的那條消失、改期的消失", async () => {
  const db = await viewDb();
  // ① 2099 開票（台北日期的昨天）、Z 當選：政見 4（在 L1）自動回來
  await db.exec(`UPDATE elections SET election_date = activity_today() - 1 WHERE id = 2099;
    UPDATE politician_elections SET candidacy_status = 'elected' WHERE politician_id = '${Z}' AND election_id = 2099`);
  assertEquals(await idsOf(db, L1), [PL(1), PL(4), PL(7)].sort());
  // 同一屆的政見 5（Z2 標當選，在 L3）也因為那一屆開票了而合格
  assertEquals(await idsOf(db, L3), [PL(5)]);
  // ② 結果更正：X 2018 當選 → 落選，政見 1 消失
  await db.exec(`UPDATE politician_elections SET candidacy_status = 'not_elected' WHERE politician_id = '${X}' AND election_id = 2018`);
  assertEquals(await idsOf(db, L1), [PL(4), PL(7)].sort());
  // ③ 投票日改期：昨天投票的那一屆（3001）改成下個月，政見 7 消失
  await db.exec(`UPDATE elections SET election_date = activity_today() + 30 WHERE id = 3001`);
  assertEquals(await idsOf(db, L1), [PL(4)]);
  // 資料全程沒動
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM policies WHERE lineage_id IS NOT NULL`)).rows[0].n, 10);
  await db.close();
});

Deno.test("D4 台北日期：投票日是『台北的今天』就還沒投票；『台北的昨天』才算已投票（假時鐘 app.activity_today）", async () => {
  const db = await viewDb();
  await db.exec(ACTIVITY_TODAY_FN);
  await db.exec(`SET app.activity_today = '2022-11-26'`); // 2022 那一屆的投票日當天
  assertEquals((await db.query<{ b: boolean }>(`SELECT policy_is_elected_term('${PL(3)}') AS b`)).rows[0].b, false);
  await db.exec(`SET app.activity_today = '2022-11-27'`);
  assertEquals((await db.query<{ b: boolean }>(`SELECT policy_is_elected_term('${PL(3)}') AS b`)).rows[0].b, true);
  assertEquals(await idsOf(db, L2), [PL(3)]);
  await db.close();
});

Deno.test("D5 合格政見數 0 的脈絡：分組任務的 existing_lineages 仍列出它（之後同一件事的政見可以再歸回這條）", async () => {
  const db = await viewDb();
  await db.exec(BLOCK_ARM());
  await db.exec([pol(13, "又一條當選的政見", Y, 2022)].join("\n")); // 合格、沒歸入脈絡，讓台中市這一格有任務
  const t = (await db.query<{ target: { existing_lineages: Array<{ lineage_id: string }> } }>(`SELECT target FROM contribution_auto_tasks_lineage_candidates()`)).rows;
  assertEquals(t.length, 1);
  const listed = t[0].target.existing_lineages.map((l) => l.lineage_id);
  assert(listed.includes(L5) && listed.includes(L6), "合格政見數 0 的脈絡還要列在 existing_lineages");
  assert(listed.includes(L1) && listed.includes(L2));
  await db.close();
});

// ============================================================
// E. 交件前置檢查與落庫
// ============================================================
function world() {
  return createFakeSupabase({
    policies: [
      { id: PL(1), title: "二〇一八年的政見", removed_at: null, lineage_id: null, politician_id: X, election_id: 2018 },
      { id: PL(2), title: "二〇二二年落選的政見", removed_at: null, lineage_id: null, politician_id: X, election_id: 2022 },
      { id: PL(4), title: "還沒投票的承諾", removed_at: null, lineage_id: null, politician_id: Z, election_id: 2099 },
      { id: PL(6), title: "已經在這條脈絡的承諾", removed_at: null, lineage_id: L1, politician_id: Q, election_id: 2099 }, // 另一位人物（同一人同一屆是另一條規則，G 區測）
      { id: PL(7), title: "二〇二二年當選的政見", removed_at: null, lineage_id: null, politician_id: Y, election_id: 2022 },
      { id: PL(8), title: "另一條當選的政見", removed_at: null, lineage_id: null, politician_id: Y, election_id: 2022 },
    ],
    lineages: [{ id: L1, title: "混合的脈絡", level: "county", region: "台中市", sub_region: null, summary: null, category: "交通建設" }],
    elections: [{ id: 2018, election_date: "2018-11-24" }, { id: 2022, election_date: "2022-11-26" }, { id: 2099, election_date: "2099-11-28" }],
    politician_elections: [
      { politician_id: X, election_id: 2018, candidacy_status: "elected" }, { politician_id: X, election_id: 2022, candidacy_status: "not_elected" },
      { politician_id: Z, election_id: 2099, candidacy_status: "declared" }, { politician_id: Y, election_id: 2022, candidacy_status: "elected" },
    ],
    edit_history: [], lineage_candidate_reviews: [],
  });
}
const NOTE = "這幾條政見講的是同一件事：計畫名稱與路線相同，見公報第 2 頁。";
const row = (payload: Record<string, unknown>, taskId: string | null = null) => ({
  id: "99999999-0000-4000-8000-000000000001", contribution_type: "lineage" as never, payload,
  source_urls: ["https://bulletin.cec.gov.tw/2026/district.pdf"], note: null, agent_name: "tester", contributor_url: null, task_id: taskId,
});

Deno.test("E1 前置檢查：歸入選前的承諾、落選者的政見 → apply_would_fail 講哪一條為什麼；合格的、已在這條脈絡裡的不問", async () => {
  const fake = world();
  const items = [{ contribution_type: "lineage", payload: { lineage_id: L1, policy_ids: [PL(4), PL(2), PL(1), PL(7), PL(6)], note: NOTE } }];
  const problems = await precheckApplyTargets(fake.client, items, new Set());
  assertEquals(problems.map((p) => [p.code, p.path]), [["apply_would_fail", "payload.policy_ids[0]"], ["apply_would_fail", "payload.policy_ids[1]"]]);
  assertStringIncludes(problems[0].message, "「還沒投票的承諾」");
  assertStringIncludes(problems[0].message, "2099-11-28");
  assertStringIncludes(problems[0].message, "還沒投票");
  assertStringIncludes(problems[1].message, "「二〇二二年落選的政見」");
  assertStringIncludes(problems[1].message, "沒有當選");
  assertStringIncludes(problems[1].message, "落選");
});

Deno.test("E2 前置檢查：新建的脈絡也一樣；detach_policy_ids 不受限（拿掉不合格的正是要的動作）", async () => {
  const fake = world();
  const problems = await precheckApplyTargets(fake.client, [
    { contribution_type: "lineage", payload: { new_lineage: { title: "全國的事", category: "交通建設", level: "national" }, policy_ids: [PL(1), PL(4)], note: NOTE } },
    { contribution_type: "lineage", payload: { lineage_id: L1, detach_policy_ids: [PL(4), PL(2), PL(6)], note: NOTE } },
  ], new Set());
  assertEquals(problems.map((p) => [p.index, p.path]), [[0, "payload.policy_ids[1]"]]);
});

Deno.test("E3 前置檢查：查詢本身出錯放行（不能讓系統的錯變成擋代理的理由）", async () => {
  const fake = world();
  const flaky = {
    from: (t: string) => t === "elections"
      ? { select: () => ({ in: () => Promise.resolve({ data: null, error: { message: "boom：連線逾時" } }) }) }
      : fake.client.from(t),
    rpc: fake.client.rpc,
  };
  const problems = await precheckApplyTargets(flaky, [{ contribution_type: "lineage", payload: { lineage_id: L1, policy_ids: [PL(4)], note: NOTE } }], new Set());
  assertEquals(problems, []);
});

Deno.test("E4 整個交件路徑：POST /contribute 歸入選前的承諾 → 400 apply_would_fail，errors 講哪一條為什麼，什麼都沒寫", async () => {
  const fake = world();
  const res = await handleContribute(fake.client, "https://x", {
    agent_name: "tester", contribution_type: "lineage",
    payload: { lineage_id: L1, policy_ids: [PL(4), PL(7)], note: NOTE },
    source_urls: ["https://bulletin.cec.gov.tw/2026/district.pdf"],
  }, "ip-1", () => Promise.resolve({ status: 403, body: { error: "self_vote" } }));
  assertEquals(res.status, 400);
  const body = res.body as { error: string; errors: Array<{ path: string; message: string }> };
  assertEquals(body.error, "apply_would_fail");
  assertEquals(body.errors.map((e) => e.path), ["payload.policy_ids[0]"]);
  assertStringIncludes(body.errors[0].message, "還沒投票");
  assertEquals(fake.db.contributions ?? [], [], "擋下就不落任何交件");
});

Deno.test("E5 落庫：交件之後那一屆的狀態才變（競態）也擋——落庫當下再判一次；整筆不寫", async () => {
  const fake = world();
  const out = await applyContribution(fake.client, row({ lineage_id: L1, policy_ids: [PL(7), PL(4)], note: NOTE }));
  assertEquals(out.status, "failed");
  assertStringIncludes(out.message, "「還沒投票的承諾」");
  assertStringIncludes(out.message, "還沒投票");
  assertEquals(fake.db.policies.find((p) => p.id === PL(7))!.lineage_id, null, "一條擋下就整筆不寫");
  assertEquals(fake.db.edit_history.length, 0);
  const lost = await applyContribution(fake.client, row({ lineage_id: L1, policy_ids: [PL(2)], note: NOTE }));
  assertEquals(lost.status, "failed");
  assertStringIncludes(lost.message, "沒有當選");
  // 同一份資料，把那一屆改成「已投票、他當選」就收（落庫判的是當下的資料，不是交件當時的）
  fake.db.elections.find((e) => e.id === 2099)!.election_date = "2026-01-01";
  fake.db.politician_elections.find((p) => p.politician_id === Z)!.candidacy_status = "elected";
  const ok = await applyContribution(fake.client, row({ lineage_id: L1, policy_ids: [PL(4)], note: NOTE }));
  assertEquals(ok.status, "applied", ok.message);
});

Deno.test("E6 落庫：合格的歸入、新建照常；detach 不受限（含不合格的）；已經在這條脈絡裡的不再問；通過的 detach 讓脈絡剩 0 條也不刪脈絡", async () => {
  const fake = world();
  const attach = await applyContribution(fake.client, row({ lineage_id: L1, policy_ids: [PL(1), PL(7)], note: NOTE }));
  assertEquals(attach.status, "applied", attach.message);
  assertEquals(fake.db.policies.filter((p) => p.lineage_id === L1).length, 3);
  const created = await applyContribution(fake.client, row({ new_lineage: { title: "全國的事", category: "交通建設", level: "national" }, policy_ids: [PL(8)], note: NOTE }));
  assertEquals(created.status, "applied", created.message);
  // 把脈絡裡不合格的拿掉（含已經在這條裡的承諾 PL(6)）
  const detach = await applyContribution(fake.client, row({ lineage_id: L1, detach_policy_ids: [PL(6)], note: NOTE }));
  assertEquals(detach.status, "applied", detach.message);
  assertEquals(fake.db.policies.find((p) => p.id === PL(6))!.lineage_id, null);
  // 已經在這條脈絡裡的政見重新帶一次（例如順手更正標題）不被資格擋
  const again = await applyContribution(fake.client, row({ lineage_id: L1, policy_ids: [PL(1)], title: "台中的事", note: NOTE }));
  assertEquals(again.status, "applied", again.message);
  const rest = fake.db.policies.filter((p) => p.lineage_id === L1).map((p) => p.id);
  const clear = await applyContribution(fake.client, row({ lineage_id: L1, detach_policy_ids: rest, note: NOTE }));
  assertEquals(clear.status, "applied", clear.message);
  assertEquals(fake.db.lineages.filter((l) => l.id === L1).length, 1, "脈絡剩 0 條政見也不刪資料列");
});

// ============================================================
// F. migration 文字與協議文字
// ============================================================
const definers = async (needle: string) => {
  const out: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes(needle)) out.push(n);
  return out;
};

Deno.test("F1 範圍函式＝前一版（20261006220000）只換 WHERE 那一處，其餘一字不動；是最後一版", async () => {
  const prev = fnText(await readMig(SCOPE_PREV_MIG), "lineage_candidate_scope");
  const want = mutate(prev,
    "       AND (\n         (e.election_date >= CURRENT_DATE AND x.candidacy_status IS DISTINCT FROM 'withdrawn')\n         OR (e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected')\n       )\n",
    "       -- >>> 只收那一屆已投票且當選的（2026-10-19）：拿掉「還沒投票看在選者」那一支——選前叫承諾、不是政見；判斷看這條政見所屬的那一屆\n" +
      "       AND e.election_date < activity_today() AND x.candidacy_status = 'elected'\n" +
      "       -- <<< 只收那一屆已投票且當選的\n");
  assertEquals(fnText(SQL, "lineage_candidate_scope"), want);
  const d = await definers("CREATE OR REPLACE FUNCTION lineage_candidate_scope(");
  assertEquals(d.slice(d.indexOf(MIG) - 1), [SCOPE_PREV_MIG, MIG], "範圍函式在這支前後又被別支重新定義：要以最新那版為底重做");
  assert(!fnText(SQL, "lineage_candidate_scope").includes("election_date >= CURRENT_DATE"), "不能再收還沒投票的");
});

Deno.test("F3 migration 不改任何資料：沒有 UPDATE／DELETE／INSERT、沒有觸發器與排程、沒有派工臂；視圖前一版只換 policy_ids 那一處", async () => {
  const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const s of ["contribution_auto_tasks_arms", "activity_arm_names", "activity_rules", "console_arm_stage_map", "lineage_ineligible", "lineage_detach", "cron.", "CREATE TRIGGER", "edit_history"]) {
    assert(!code.includes(s), `維護者 10-19 改成讀取端推導、資料不動：migration 不該有 ${s}`);
  }
  assert(!/\bUPDATE\s+\w+\s+SET\b|\bDELETE FROM\b|\bINSERT INTO\b|\bDROP\b|\bTRUNCATE\b/i.test(code), "只加不改：沒有任何寫資料的語句");
  const prev = (await readMig(LINEAGE_MIG));
  const pa = prev.indexOf("CREATE OR REPLACE VIEW lineages_full AS");
  const prevView = prev.slice(pa, prev.indexOf("ALTER VIEW lineages_full", pa));
  assertEquals(VIEW_TEXT(), mutate(prevView,
    "      WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL),\n    '[]'::json\n  ) AS policy_ids,",
    "      -- >>> 只算合格的政見（那一屆已投票且當選；台北日期）：不合格的資料不動、讀取端不算（2026-10-19）\n      WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id)),\n    '[]'::json\n  ) AS policy_ids,"));
  assertStringIncludes(SQL, "ALTER VIEW lineages_full SET (security_invoker = on);");
  assertStringIncludes(SQL, "SELECT 1 FROM lineage_candidate_scope() s WHERE NOT lineage_policy_eligible(s.policy_id)");
  assertStringIncludes(SQL, "WHERE NOT policy_is_elected_term(x.id::uuid)");
});

const versionAtLeast = (v: string, min: string) => {
  const a = v.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

Deno.test("F4 沒有新的任務型別：派工臂已拿掉（TASK_TYPES、建議回報型別、標籤、做法、協議都不再有 lineage_ineligible）；驗證提示講了資格與逐句核", async () => {
  assert(versionAtLeast(PROTOCOL_VERSION, "1.99.0"));
  assert(!(TASK_TYPES as readonly string[]).includes("lineage_ineligible"));
  assert(!("lineage_ineligible" in SUGGESTED_TYPE));
  assert(!("lineage_ineligible" in TASK_GUIDANCE));
  assert((CONTRIBUTION_TYPES as readonly string[]).includes("lineage"));
  const labels = await Deno.readTextFile(new URL("../../../lib/task-labels.ts", import.meta.url));
  assert(!labels.includes("lineage_ineligible"));
  assert(!(await readSkillWithTypes()).includes("lineage_ineligible"), "協議文字只寫「不合格的不收、會被系統拿掉」，沒有這個任務");
  // 驗證提示：資格、逐句核
  for (const s of ["那一屆已投票且當選", "逐句", "立場或承諾", "不是脈絡", "detach_policy_ids"]) assertStringIncludes(LINEAGE_VERIFY_HINT.lineage, s);
});

Deno.test("F5 協議文字（skill-types.md）：只收當選後的政見、承諾→政見→脈絡、同一場選舉候選人比較不是脈絡、摘要只寫事實、驗證逐句核", async () => {
  const skill = await readSkillWithTypes();
  for (const s of [
    "**脈絡只收「那一屆已投票且當選」的政見**",
    "承諾 → 政見 → 脈絡",
    "選前的承諾、落選人的承諾不收",
    "不是看這個人現在在不在任（2018 當選、2022 落選的人，2018 那一屆的政見仍然收）",
    "**同一場選舉的候選人之間的比較不是脈絡。**",
    "`detach_policy_ids` 不受這條限制",
    "只寫這件事本身的事實",
    "每個事實句都要能在附的來源找到",
    "不寫各人的立場或承諾",
    "**逐句**核摘要與來源",
    "投 `disagree` 並寫是哪一句",
    "已經在脈絡裡的政見之後才變得不合格（例如那一屆的結果更正成落選），網站上就不算它，不用交件",
  ]) assertStringIncludes(skill, s);
});

// ============================================================
// G. 同一人同一屆的多條政見不是脈絡
// ============================================================
const owned = (id: string, pid: string | null, eid: number | null, title?: string) => ({ id, title, politician_id: pid, election_id: eid });

Deno.test("G1 純函式：兩條以上（id 不重複）、全都是同一人同一屆才算；跨人、跨屆、一條、不知道都不算", () => {
  assertEquals(isSamePersonSameTerm([]), false);
  assertEquals(isSamePersonSameTerm([owned("a", X, 2022)]), false, "一條政見談不上全都是同一人同一屆（中央層級允許 1 條的老規矩照舊）");
  assertEquals(isSamePersonSameTerm([owned("a", X, 2022), owned("b", X, 2022)]), true);
  assertEquals(isSamePersonSameTerm([owned("a", X, 2022), owned("b", X, 2022), owned("c", X, 2022)]), true);
  assertEquals(isSamePersonSameTerm([owned("a", X, 2022), owned("b", X, 2018)]), false, "同一個人跨屆是承諾兌現後的延續，可以是脈絡");
  assertEquals(isSamePersonSameTerm([owned("a", X, 2022), owned("b", Y, 2022)]), false, "同一屆跨人是同級多人，可以是脈絡");
  assertEquals(isSamePersonSameTerm([owned("a", X, 2022), owned("b", X, 2022), owned("c", Y, 2022)]), false, "只要有一條不同就不算");
  assertEquals(isSamePersonSameTerm([owned("a", X, 2022), owned("A", X, 2022)]), false, "同一個 id（大小寫不同）只算一條");
  assertEquals(isSamePersonSameTerm([owned("a", X.toUpperCase(), 2022), owned("b", X, 2022)]), true, "uuid 大小寫不影響");
  assertEquals(isSamePersonSameTerm([owned("a", null, 2022), owned("b", null, 2022)]), false, "人物不知道不下結論");
  assertEquals(isSamePersonSameTerm([owned("a", X, null), owned("b", X, null)]), false, "屆別不知道不下結論（沒標屆別另有資格判斷擋）");
  const msg = lineageSamePersonMessage([owned("a", X, 2022, "城市色彩一"), owned("b", X, 2022, "城市色彩二")]);
  for (const t of ["「城市色彩一」", "「城市色彩二」", "同一位政治人物在同一屆", "重複政見", "不是脈絡", "duplicate_policy", "跨人", "跨屆"]) assertStringIncludes(msg, t);
});

Deno.test("G2 前置檢查：建新脈絡兩條以上全都是同一人同一屆 → apply_would_fail 改走重複清查；中央層級 1 條、跨人、跨屆照舊", async () => {
  const fake = world();
  const national = (ids: string[]) => ({ contribution_type: "lineage", payload: { new_lineage: { title: "全國的事", category: "交通建設", level: "national" }, policy_ids: ids, note: NOTE } });
  const problems = await precheckApplyTargets(fake.client, [
    national([PL(7), PL(8)]), // 同一人（Y）同一屆（2022）
    national([PL(7)]), // 中央層級 1 條：照舊
    national([PL(7), PL(1)]), // 跨人跨屆
  ], new Set());
  assertEquals(problems.map((p) => [p.index, p.code, p.path]), [[0, "apply_would_fail", "payload.policy_ids"]]);
  assertStringIncludes(problems[0].message, "重複政見");
  assertStringIncludes(problems[0].message, "duplicate_policy");
  assertStringIncludes(problems[0].message, "「另一條當選的政見」");
});

/** world() 加兩條脈絡：L6 只有 PL(7)（Y 2022） */
function worldWithLineages() {
  const fake = world();
  fake.db.lineages.push({ id: L6, title: "第六條", level: "national", region: null, sub_region: null, summary: null, category: "交通建設" });
  fake.db.policies.find((p) => p.id === PL(7))!.lineage_id = L6;
  return fake;
}

Deno.test("G3 前置檢查：歸入既有脈絡——加入之後整條只剩同一人同一屆才擋；混了別人、別屆就過；只拿掉不歸入的不查", async () => {
  const fake = worldWithLineages();
  const items = [
    { contribution_type: "lineage", payload: { lineage_id: L6, policy_ids: [PL(8)], note: NOTE } }, // 0：L6 現有 Y 2022，再加 Y 2022 → 只剩同一人同一屆
    { contribution_type: "lineage", payload: { lineage_id: L6, policy_ids: [PL(1)], note: NOTE } }, // 1：加跨人跨屆 → 過
    { contribution_type: "lineage", payload: { lineage_id: L6, policy_ids: [PL(8), PL(1)], note: NOTE } }, // 2：混了別人 → 過
    { contribution_type: "lineage", payload: { lineage_id: L6, policy_ids: [PL(8)], detach_policy_ids: [PL(7)], note: NOTE } }, // 3：拿掉 PL(7) 再加 PL(8) → 只剩一條 → 過
    { contribution_type: "lineage", payload: { lineage_id: L6, detach_policy_ids: [PL(7)], note: NOTE } }, // 4：只拿掉 → 不查
  ];
  const problems = await precheckApplyTargets(fake.client, items, new Set());
  assertEquals(problems.map((p) => [p.index, p.path]), [[0, "payload.policy_ids"]]);
  assertStringIncludes(problems[0].message, "整條脈絡不能只剩同一人同一屆");
});

Deno.test("G4 前置檢查：查脈絡現有政見出錯就放行（讀不到不能擋代理）", async () => {
  const fake = worldWithLineages();
  const inner = fake.client;
  const flaky = {
    // 只讓「按 lineage_id 撈脈絡現有政見」那一條查詢失敗，其餘照常
    from: (t: string) => {
      if (t !== "policies") return inner.from(t);
      const real = inner.from(t);
      return {
        select: (cols: string) => {
          const q = real.select(cols);
          return cols === "id, title, politician_id, election_id"
            ? { eq: () => ({ is: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "boom：連線逾時" } }) }) }) }
            : q;
        },
      };
    },
    rpc: inner.rpc,
  };
  const problems = await precheckApplyTargets(flaky, [{ contribution_type: "lineage", payload: { lineage_id: L6, policy_ids: [PL(8)], note: NOTE } }], new Set());
  assertEquals(problems, []);
});

Deno.test("G5 落庫：建新脈絡全都是同一人同一屆 → failed、什麼都不寫；歸入既有脈絡只剩同一人同一屆 → failed；混了別人就收；只拿掉不被擋", async () => {
  const fake = worldWithLineages();
  fake.db.policies.push({ id: PL(9), title: "又一條當選的政見", removed_at: null, lineage_id: null, politician_id: Y, election_id: 2022 });
  const before = structuredClone(fake.db.policies);
  const created = await applyContribution(fake.client, row({ new_lineage: { title: "全國的事", category: "交通建設", level: "national" }, policy_ids: [PL(8), PL(9)], note: NOTE }));
  assertEquals(created.status, "failed");
  assertStringIncludes(created.message, "重複政見");
  assertStringIncludes(created.message, "duplicate_policy");
  assertEquals(fake.db.lineages.length, 2, "沒有建新脈絡（只有 worldWithLineages 裡原本那兩條）");
  assertEquals(fake.db.policies, before, "什麼都沒掛上去");
  assertEquals(fake.db.edit_history.length, 0);
  // 中央層級 1 條照舊
  const one = await applyContribution(fake.client, row({ new_lineage: { title: "全國的事", category: "交通建設", level: "national" }, policy_ids: [PL(8)], note: NOTE }));
  assertEquals(one.status, "applied", one.message);
  // 既有脈絡：L6 有 Y 2022 的 PL(7)，再歸入 Y 2022 的 PL(9) → 只剩同一人同一屆 → failed；連 X 2018 的 PL(1) 一起歸入 → 收
  const bad = await applyContribution(fake.client, row({ lineage_id: L6, policy_ids: [PL(9)], note: NOTE }));
  assertEquals(bad.status, "failed");
  assertStringIncludes(bad.message, "整條脈絡不能只剩同一人同一屆");
  const ok = await applyContribution(fake.client, row({ lineage_id: L6, policy_ids: [PL(9), PL(1)], note: NOTE }));
  assertEquals(ok.status, "applied", ok.message);
  // L6 現在是 Y 2022 兩條＋X 2018 一條；把 X 那條拿掉，剩下兩條同人同屆——只拿掉的不查，清理不被擋
  const clean = await applyContribution(fake.client, row({ lineage_id: L6, detach_policy_ids: [PL(1)], note: NOTE }));
  assertEquals(clean.status, "applied", clean.message);
  assertEquals(fake.db.policies.filter((p) => p.lineage_id === L6).map((p) => p.id).sort(), [PL(7), PL(9)].sort());
});

Deno.test("G6 整個交件路徑：POST /contribute 建新脈絡兩條同一人同一屆 → 400 apply_would_fail，errors 講改走重複清查", async () => {
  const fake = world();
  const res = await handleContribute(fake.client, "https://x", {
    agent_name: "tester", contribution_type: "lineage",
    payload: { new_lineage: { title: "全國的事", category: "交通建設", level: "national" }, policy_ids: [PL(7), PL(8)], note: NOTE },
    source_urls: ["https://bulletin.cec.gov.tw/2026/district.pdf"],
  }, "ip-1", () => Promise.resolve({ status: 403, body: { error: "self_vote" } }));
  assertEquals(res.status, 400);
  const body = res.body as { error: string; errors: Array<{ path: string; message: string }> };
  assertEquals(body.error, "apply_would_fail");
  assertEquals(body.errors.map((e) => e.path), ["payload.policy_ids"]);
  assertStringIncludes(body.errors[0].message, "重複清查");
  assertEquals(fake.db.contributions ?? [], []);
});

Deno.test("G7 前置檢查與落庫各呼叫同一支純函式（不是各寫一份，判準不會一邊寬一邊嚴）；清理不被擋寫在原始碼裡", async () => {
  const apply = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  const precheck = await Deno.readTextFile(new URL("./apply-precheck.ts", import.meta.url));
  assertEquals(apply.split("isSamePersonSameTerm([...after.values()])").length - 1, 1);
  assertEquals(precheck.split("isSamePersonSameTerm([...after.values()])").length - 1, 1);
  assertStringIncludes(apply, "只拿掉不歸入的不查");
  assertStringIncludes(precheck, "只拿掉不歸入的不查");
});

Deno.test("G8 協議文字：同一人同一屆是重複政見、驗證同步一句", async () => {
  const skill = await readSkillWithTypes();
  for (const s of [
    "**同一位政治人物、同一屆的多條政見講同一件事，是重複政見，走重複清查（`duplicate_policy`），不是脈絡**",
    "**同一人同一屆的多條政見不是脈絡**",
    "整條脈絡不能只剩同一人同一屆的政見",
    "中央層級建新脈絡只有 1 條的老規矩照舊",
    "整條脈絡不是只剩同一位政治人物在同一屆的多條政見（那是重複政見、不是脈絡，投 `disagree` 並寫改走重複清查）",
  ]) assertStringIncludes(skill, s);
  for (const s of ["同一位政治人物", "重複清查", "disagree"]) assertStringIncludes(LINEAGE_VERIFY_HINT.lineage, s);
  for (const s of ["重複政見", "duplicate_policy", "全都是同一人同一屆"]) assertStringIncludes(TASK_GUIDANCE.lineage_candidate, s);
});

Deno.test("G9 隱藏的（不合格的）既有政見不可掩護新的同人同屆違規：脈絡裡掛著 2099 未投票的承諾，再歸入同一人同一屆的兩條 → 照擋", async () => {
  const fake = worldWithLineages();
  fake.db.policies.find((p) => p.id === PL(7))!.lineage_id = null; // L6 先清空，再掛一條隱藏的（Z、2099 還沒投票）
  fake.db.policies.find((p) => p.id === PL(4))!.lineage_id = L6;
  fake.db.policies.push({ id: PL(9), title: "又一條當選的政見", removed_at: null, lineage_id: null, politician_id: Y, election_id: 2022 });
  const problems = await precheckApplyTargets(fake.client, [{ contribution_type: "lineage", payload: { lineage_id: L6, policy_ids: [PL(7), PL(9)], note: NOTE } }], new Set());
  assertEquals(problems.map((p) => p.path), ["payload.policy_ids"]);
  assertStringIncludes(problems[0].message, "重複政見");
  const out = await applyContribution(fake.client, row({ lineage_id: L6, policy_ids: [PL(7), PL(9)], note: NOTE }));
  assertEquals(out.status, "failed");
  assertStringIncludes(out.message, "重複政見");
  assertStringIncludes(lineageSamePersonMessage([owned("a", X, 2022, "甲"), owned("b", X, 2022, "乙")]), "「甲」、「乙」");
});
