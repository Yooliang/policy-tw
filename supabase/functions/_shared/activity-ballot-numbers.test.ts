/**
 * 補號次：新派工臂 ballot_numbers（2026-10-08，缺口盤點 R8；migration 20261008150000_ballot_numbers_arm.sql）。
 *
 * 2026 的參選號次 cand_no 是 0／1,637，沒有任何臂會在抽籤（2026-10-23）後派。新臂把「已登記、沒有號次」的參選紀錄按單位整批派，
 * 窗口由規則決定：draw +0 開、polling +0 關（含頭含尾）；draw 里程碑由這支 migration 從 roster_check_scope.ballot_draw_on 自己補（ON CONFLICT DO NOTHING）。
 * 只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. 文字層：總表＝前一版（20261008121000）加一行 UNION 分支；臂名清單＝P1 的清單加一個名字；新增一支臂的三處登記（標籤、清單、規則）對得上；
 *      這支只動這幾樣（不碰 seed、candidacy_list_published、not_running、candidate_status_stale）；臂本體沒有寫死的年份／日期／職位；任務提示、skill.md、protocol 版號、roster_batch 的守門
 *   B. PGlite（行為層，總表＋規則＋里程碑＋seed 跑真的，臂本體換 stub）：今天輸出不變；假時鐘 10-22 不開、10-23 開、11-28 開、11-29 關；舊選舉永遠不開；
 *      缺 draw 里程碑的職位關著；里程碑回填與 ON CONFLICT；opened_by 帶 draw 與 polling；seed 窗口關了記 window；每條守門做還原驗證
 *   C. 臂本體（真的 SQL 灌進 PGlite 的小資料表）：誰會被派（filed、沒號次、沒被併走、有縣市）、單位怎麼切（村里長與代表到鄉鎮、議員的選舉區放 items）、
 *      50 位拆件、已有人交了帶號次的 candidacy 先不派、candidate_status 隨名單公告翻
 *
 * 正式庫快照版的「今天輸出逐件不變」見 scripts/arms-parity-p2.ts ballot_numbers（不進 CI；PR 說明附結果）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyP2, armsFingerprint, BALLOT_MIG, buildArmsDb, DEFAULT_SCOPE, fnText, type GapRow, latestFn, migrationNames, mutate, P1_MIG, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";
import { BALLOT_NUMBERS_HINT, CAND_NO_VERIFY_HINT, isBallotNumbersTask, shapeTaskCurrent, shapeVerifyCurrent, type TaskContextData, type VerifyContextData } from "./task-context.ts";
import { rosterBatchEligible } from "./cec-roster.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const B = await readMig(BALLOT_MIG);
const P1 = await readMig(P1_MIG);
const PR = await readMig(P2_PR_MIG);
const QP = await readMig("20261008090000_queue_priority_tiers.sql");
const count = (s: string, sub: string) => s.split(sub).length - 1;
const codeOf = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ============================================================
// A. 文字層
// ============================================================
const ARMS_PREV = fnText(PR, "contribution_auto_tasks_arms");
const ARMS_NEW = fnText(B, "contribution_auto_tasks_arms");
const ADD_LINE = "  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t\n";
const isMechanicalArms = (fn: string) => {
  try {
    return mutate(fn, ADD_LINE, "") === ARMS_PREV;
  } catch {
    return false;
  }
};
const NAMES_PREV = fnText(P1, "activity_arm_names");
const NAMES_NEW = fnText(B, "activity_arm_names");
const isMechanicalNames = (fn: string) => {
  try {
    return mutate(fn, "    'owner_mismatch',\n    'ballot_numbers'\n", "    'owner_mismatch'\n") === NAMES_PREV;
  } catch {
    return false;
  }
};
const namesIn = (fn: string): string[] => [...fn.slice(fn.indexOf("SELECT ARRAY["), fn.indexOf("]::TEXT[]")).matchAll(/'([^']+)'/g)].map((m) => m[1]);
const tagsIn = (fn: string): string[] => [...fn.matchAll(/SELECT '([a-z_]+)' AS arm, t\.\*/g)].map((m) => m[1]);
const ARM = fnText(B, "contribution_auto_tasks_ballot_numbers");

Deno.test("A1 前一版是對的：總表緊接著 party_roster 那支 P2（20261008121000），活動名清單緊接著 P1（中間沒有人插一版，抄的底就過期）", async () => {
  for (const [fn, base] of [["contribution_auto_tasks_arms", P2_PR_MIG], ["activity_arm_names", P1_MIG]]) {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) defining.push(n);
    const i = defining.indexOf(BALLOT_MIG);
    assert(i > 0, `這支 migration 要在重新定義 ${fn} 的清單裡`);
    assertEquals(defining[i - 1], base, `${fn} 的前一版應該是 ${base}；有人在中間改了，要以那一版為底重做機械式替換`);
  }
});

Deno.test("A2 總表新定義＝前一版加一行 UNION 分支（臂名 ballot_numbers）；簽名、回傳型別、其餘分支與 #448／gap.arms_all 一字不動", () => {
  assert(isMechanicalArms(ARMS_NEW));
  assertEquals(mutate(ARMS_NEW, ADD_LINE, ""), ARMS_PREV);
  assertEquals(ARMS_NEW.split("\n").slice(0, 3).join("\n"), ARMS_PREV.split("\n").slice(0, 3).join("\n"));
  assertEquals(tagsIn(ARMS_NEW), [...tagsIn(ARMS_PREV), "ballot_numbers"]);
  assertEquals(tagsIn(ARMS_NEW).length, 28);
  assert(ARMS_NEW.includes("ph AS MATERIALIZED") && ARMS_NEW.includes("phe AS MATERIALIZED"), "#448 的測試名人物過濾不動");
  assert(ARMS_NEW.includes("current_setting('gap.arms_all', true) = 'on'"), "gap.arms_all 旗標不動");
  assert(ARMS_NEW.includes("activity_require_rule(x.arm)"), "沒有規則的臂照樣 RAISE");
});

Deno.test("A3 活動名清單＝P1 的清單加一個名字；新增一支臂的三處登記（標籤、清單、規則）對得上，最新一版的清單＝最新總表的標籤＋raw 的任務型別", async () => {
  assert(isMechanicalNames(NAMES_NEW));
  assertEquals(namesIn(NAMES_NEW), [...namesIn(NAMES_PREV), "ballot_numbers"]);
  assertEquals(namesIn(NAMES_NEW).length, 37);
  const rawTypes = [...new Set([...(await latestFn("contribution_auto_tasks_raw")).matchAll(/SELECT 'auto:([a-z_]+):'/g)].map((m) => m[1]))];
  const latestNames = namesIn(await latestFn("activity_arm_names"));
  const latestTags = tagsIn(await latestFn("contribution_auto_tasks_arms"));
  assertEquals([...latestNames].sort(), [...latestTags, ...rawTypes.map((t) => `raw:${t}`)].sort(), "最新一版的清單與總表標籤＋raw 型別各說各話");
  assert(latestNames.includes("ballot_numbers") && latestTags.includes("ballot_numbers"));
  // 規則：直接種成窗口（不經過永遠開）
  assert(B.includes("'ballot_numbers', 'event', 'draw', 0, 'polling', 0, 'announced', true"));
  assertEquals(count(codeOf(B), "INSERT INTO activity_rules"), 1);
});

Deno.test("A4 這支只動這幾樣：三支函式、一條規則、draw 里程碑回填；不碰 seed、candidacy_list_published、not_running、candidate_status_stale；不建表不刪東西", () => {
  const code = codeOf(B);
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, ["activity_arm_names", "contribution_auto_tasks_arms", "contribution_auto_tasks_ballot_numbers"]);
  assert(!/DROP FUNCTION|DROP TABLE|ALTER TABLE|CREATE TABLE|TRUNCATE|DELETE FROM|UPDATE (activity_rules|elections|election_milestones|politician_elections|roster_check_scope)/i.test(code), "不建表、不刪、不改別人的列");
  assert(!code.includes("FUNCTION seed_auto_task_queue"), "不碰 seed");
  assertEquals(count(code, "candidacy_list_published("), 1, "candidacy_list_published 只被呼叫一次（不重寫它：另一條 PR 在改）");
  assert(!/FUNCTION contribution_auto_tasks_(not_running|raw|party_roster|party_gap)/.test(code));
  const inserts = [...code.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]);
  assertEquals(inserts, ["election_milestones", "activity_rules"]);
  // 里程碑回填：取 roster_check_scope.ballot_draw_on、一個職位一列、已存在的不動
  assert(code.includes("FROM roster_check_scope s\n WHERE s.ballot_draw_on IS NOT NULL\nON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;"));
  assert(code.includes("SELECT s.election_id, 'draw', s.election_type, s.ballot_draw_on, 'official'"));
});

Deno.test("A5 臂本體：沒有寫死的年份、日期、職位清單；單位與拆件規則在；條件是 filed、沒號次、沒被併走", () => {
  // 提示文字裡舉 2022 年的公告當「長相」範例（桃園市長名單、苗栗縣登記冊）是說明，不是條件；2026 或任何別的年份都不該出現
  assertEquals([...new Set(ARM.replace(/--.*$/gm, "").match(/\b(19|20)\d\d\b/g) ?? [])], ["2022"], "臂裡不寫死年份（只有提示文字裡的 2022 範例）");
  assert(!/election_date\s*[<>=]|CURRENT_DATE\s*[<>+-]|now\(\)/i.test(ARM), "臂裡不比日期（窗口在規則）");
  assert(!/election_id\s*=\s*\d/.test(ARM), "臂裡不指名屆別");
  assert(ARM.includes("pe.candidacy_status = 'filed' AND pe.cand_no IS NULL AND pe.election_type IS NOT NULL"));
  assert(ARM.includes("JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL"));
  assert(ARM.includes("/ 50 + 1"), "超過 50 位拆件");
  assert(ARM.includes("pe.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')"), "村里長與代表再細到鄉鎮市區");
  assert(ARM.includes("'kind', 'cand_no'") && ARM.includes("'election_id', u.election_id, 'election_type', u.election_type"), "target 帶 election_id 與 election_type（總表用它們問規則）");
  assert(ARM.includes("'auto:candidacy_source_missing:cand_no:'"));
  assert(ARM.includes("c.payload->>'cand_no' IS NOT NULL"), "已經有人交了帶號次的 candidacy 先不派");
  assert(ARM.includes("candidacy_protocol_status('filed', candidacy_list_published(gr.election_id, gr.election_type, CURRENT_DATE))"), "candidate_status 照名單公告了沒翻（呼叫方式同 party_roster）");
});

Deno.test("A6 任務提示、驗證提示、skill.md、協議版號、roster_batch 的守門都在", async () => {
  assert(BALLOT_NUMBERS_HINT.includes("target.items") && BALLOT_NUMBERS_HINT.includes("登記彙總表") && BALLOT_NUMBERS_HINT.includes("unreachable") && BALLOT_NUMBERS_HINT.includes("不要回 no_change not_found"));
  assert(CAND_NO_VERIFY_HINT.includes("payload.cand_no") && CAND_NO_VERIFY_HINT.includes("剛好等於"));
  const md = (await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url))).replace(/\r\n/g, "\n");
  assert(md.includes("### 補選票號次（`candidacy_source_missing`，`target.kind` 是 `cand_no`）（1.75.0）"));
  assert(md.includes("**系統不核號次**") && md.includes("`outcome` 填 `unreachable`") && md.includes("不能當號次的來源"));
  assert(md.includes("**版本**：1.75.0") && md.includes("*協議版本 1.75.0"));
  assertEquals(PROTOCOL_VERSION, "1.75.0");
  // roster_batch：帶號次的不撿
  const si = (await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(si.includes("const todo = list.filter((c) => rosterBatchEligible(c.payload));"));
  assert(si.includes("rosterBatchEligible,"));
  const guidance = (await Deno.readTextFile(new URL("./task-guidance.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(guidance.includes("t.kind === \"cand_no\"") && guidance.includes("缺的是號次（target.kind＝cand_no"));
});

Deno.test("A7 rosterBatchEligible：有 cand_no 的不撿、沒有的照舊", () => {
  assertEquals(rosterBatchEligible({ name: "甲", cand_no: 3 }), false);
  assertEquals(rosterBatchEligible({ name: "甲", cand_no: "3" }), false);
  assertEquals(rosterBatchEligible({ name: "甲" }), true);
  assertEquals(rosterBatchEligible({ name: "甲", cand_no: null }), true);
  assertEquals(rosterBatchEligible({ name: "甲", cand_no: "" }), true);
  assertEquals(rosterBatchEligible(null), true);
  assertEquals(rosterBatchEligible(undefined), true);
});

Deno.test("A8 任務現況與提示：補號次任務走 BALLOT_NUMBERS_HINT、骨架給第一位；驗證帶號次的 candidacy 多一句號次提示；沒帶的不多", () => {
  const target = {
    kind: "cand_no", election_id: 2026, election_type: "縣市議員", region: "台北市", candidate_status: "registered", items_count: 2,
    items: [{ politician_election_id: 1, politician_id: "00000000-0000-4000-8000-000000000001", name: "甲", electoral_district: "第01選舉區" }, { politician_election_id: 2, politician_id: "00000000-0000-4000-8000-000000000002", name: "乙", electoral_district: "第02選舉區" }],
  };
  assert(isBallotNumbersTask("candidacy_source_missing", target));
  assert(!isBallotNumbersTask("candidacy_source_missing", { ...target, kind: "party" }));
  assert(!isBallotNumbersTask("policy_missing", target));
  const cur = shapeTaskCurrent("candidacy_source_missing", {} as TaskContextData, { task_id: "auto:candidacy_source_missing:cand_no:2026:縣市議員:台北市", target });
  assertEquals(cur.hint, BALLOT_NUMBERS_HINT);
  assertEquals(cur.items_count, 2);
  assert(!("politician_election" in cur), "整個單位一件，沒有單一人物的現況");
  const tpl = (cur.report_template as { payload: Record<string, unknown> }).payload;
  assertEquals((cur.report_template as { contribution_type: string }).contribution_type, "candidacy");
  assertEquals(tpl.politician_id, "00000000-0000-4000-8000-000000000001");
  assertEquals(tpl.election_id, 2026);
  assertEquals(tpl.electoral_district, "第01選舉區");
  assertEquals(tpl.candidate_status, "registered");
  assert(typeof tpl.cand_no === "string" && (tpl.cand_no as string).includes("號次"));
  const v = shapeVerifyCurrent("candidacy", { name: "甲", cand_no: 3 }, {} as VerifyContextData);
  assert(String(v.hint).includes(CAND_NO_VERIFY_HINT));
  const v2 = shapeVerifyCurrent("candidacy", { name: "甲" }, {} as VerifyContextData);
  assert(!String(v2.hint).includes("payload.cand_no"));
});

// ============================================================
// B. PGlite（行為層）
// ============================================================
const G = (id: string, type: string, target: Record<string, unknown> | null = null, region: string | null = "台北市"): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h1"], reward: 1, region });
const E = (election_id: number | null, election_type?: string | null, extra: Record<string, unknown> = {}) => ({ ...(election_id === null ? {} : { election_id }), ...(election_type === undefined ? {} : { election_type }), ...extra });
const Bn = (key: string, eid: number, type: string) => G(`candidacy_source_missing:cand_no:${key}`, "candidacy_source_missing", E(eid, type, { kind: "cand_no" }));
const BALLOT_2026 = [Bn("2026:縣市長:台北市", 2026, "縣市長"), Bn("2026:縣市議員:台北市", 2026, "縣市議員"), Bn("2026:村里長:台北市:中山區", 2026, "村里長")];
const BALLOT_PAST = [Bn("2022:縣市長:台北市", 2022, "縣市長"), Bn("2024:立法委員:台北市", 2024, "立法委員"), Bn("4:縣市長:嘉義市", 4, "縣市長")];
const ROSTER_2026 = [G("candidacy_source_missing:party:401", "candidacy_source_missing", E(2026, "縣市長", { kind: "party_roster" }))];
const OTHERS = {
  party_info: [G("party_info1", "party_info_missing", E(2026))],
  dup: [G("dup1", "duplicate_politician", null)],
  term_policies: [G("tp26", "term_policy_missing", E(2026, "縣市長"))],
  raw: [G("candidacy_source_missing:77", "candidacy_source_missing", E(2026, "縣市長"))],
};
const OTHER_IDS = Object.values(OTHERS).flat().map((r) => r.task_id);
const ROSTER_IDS = ROSTER_2026.map((r) => r.task_id);
const BALLOT_2026_IDS = BALLOT_2026.map((r) => r.task_id);
const BALLOT_PAST_IDS = BALLOT_PAST.map((r) => r.task_id);
const TODAY_IDS = [...OTHER_IDS, ...ROSTER_IDS];
const BASE_BRANCHES = { ...OTHERS, party_roster: ROSTER_2026 };
const NEW_BRANCHES = { ...OTHERS, party_roster: ROSTER_2026, ballot_numbers: [...BALLOT_2026, ...BALLOT_PAST] };
const SCOPE = DEFAULT_SCOPE.map((s) => ({ ...s, ballot_draw_on: "2026-10-23" }));
const EXTRA = ["ballot_numbers"] as const;
const RESTUB = ["raw", "election_results", "party_gap", "party_roster", "ballot_numbers"] as const;

// 優先層（#443）加的東西，用最小的替身讓 seed 跑得動（同 activity-party-roster.test.ts）
const QP_STUB = `
CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid);
CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL);
${await latestFn("politician_name_is_placeholder")}
ALTER TABLE task_dispatches ADD COLUMN priority SMALLINT;
CREATE FUNCTION activity_priority(p_activity TEXT, p_election_id INTEGER DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT NULL)
RETURNS TABLE (priority SMALLINT, rule_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE)
LANGUAGE sql STABLE AS $$ SELECT 2::SMALLINT, NULL::BIGINT, NULL::TEXT, NULL::DATE, NULL::DATE $$;`;
Deno.test("B0 優先層替身的簽名與回傳欄位跟 #443 的真實定義一致", () => {
  assert(QP.includes("RETURNS TABLE (priority SMALLINT, rule_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE)"));
});

const buildBallot = (mutateB?: (s: string) => string, branches: Record<string, GapRow[]> = NEW_BRANCHES) =>
  buildArmsDb({ branches, scope: SCOPE, extraBranches: EXTRA, afterP1Sql: QP_STUB, p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: BALLOT_MIG, mutate: mutateB }], restub: RESTUB } });
const buildBase = () =>
  buildArmsDb({ branches: BASE_BRANCHES, scope: SCOPE, extraBranches: EXTRA, afterP1Sql: QP_STUB, p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }], restub: RESTUB.filter((n) => n !== "ballot_numbers") } });

type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];
const ids = async (db: Db, where = "true") => (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_arms() WHERE ${where} ORDER BY task_id COLLATE "C"`)).map((r) => r.task_id);
const clock = (db: Db, day: string) => db.exec(`SET app.activity_today = '${day}'`);
const sorted = (a: string[]) => [...a].sort();
const same = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

type Verdicts = Record<string, boolean>;
async function guard(out: Verdicts, db: Db, name: string, f: () => Promise<boolean>) {
  await db.exec("BEGIN");
  try {
    out[name] = await f();
  } catch {
    out[name] = false;
  } finally {
    try {
      await db.exec("ROLLBACK");
    } catch { /* 已經回滾 */ }
  }
}

async function runSuite(db: Db, mutateB: (s: string) => string = (s) => s): Promise<Verdicts> {
  const v: Verdicts = {};
  const g = (name: string, f: () => Promise<boolean>) => guard(v, db, name, f);
  const ballot = (day: string) => clock(db, day).then(() => ids(db, `arm = 'ballot_numbers'`));
  const seed = () => db.exec(`SELECT seed_auto_task_queue()`);

  // ---- 1. 今天輸出不變 ----
  await g("today_hides_ballot_rows", async () => {
    await clock(db, "2026-10-08");
    return same(await ids(db), TODAY_IDS) && (await ids(db, `arm = 'ballot_numbers'`)).length === 0;
  });

  // ---- 2. 假時鐘：抽籤當天起開、投票日當天仍開、隔天關 ----
  await g("closed_before_draw_day", async () => {
    for (const d of ["2026-01-01", "2026-10-08", "2026-10-22"]) if ((await ballot(d)).length !== 0) return false;
    return true;
  });
  await g("open_from_draw_day", async () => same(await ballot("2026-10-23"), BALLOT_2026_IDS) && same(await ballot("2026-11-01"), BALLOT_2026_IDS));
  await g("open_through_polling_day_closed_next_day", async () => {
    return same(await ballot("2026-11-27"), BALLOT_2026_IDS) && same(await ballot("2026-11-28"), BALLOT_2026_IDS) &&
      (await ballot("2026-11-29")).length === 0 && (await ballot("2026-12-31")).length === 0 && (await ballot("2030-01-01")).length === 0;
  });
  await g("past_elections_never_open", async () => {
    for (const d of ["2022-01-01", "2022-11-26", "2024-01-13", "2026-10-23", "2026-11-28", "2030-01-01"]) {
      await clock(db, d);
      if ((await ids(db, `task_id = ANY ($1)`.replace("$1", `ARRAY[${BALLOT_PAST_IDS.map((i) => `'${i}'`).join(",")}]`))).length !== 0) return false;
    }
    return true;
  });
  await g("type_without_draw_milestone_stays_closed", async () => {
    await db.exec(`DELETE FROM election_milestones WHERE kind = 'draw' AND election_type = '村里長'`);
    const open = await ballot("2026-11-01");
    return same(open, BALLOT_2026_IDS.filter((i) => !i.includes("村里長")));
  });
  await g("other_arms_unaffected_on_every_day", async () => {
    for (const d of ["2022-01-01", "2026-10-08", "2026-10-23", "2026-11-28", "2026-11-29", "2030-01-01"]) {
      await clock(db, d);
      if (!same(await ids(db, `arm NOT IN ('ballot_numbers', 'party_roster', 'party_gap')`), OTHER_IDS)) return false;
    }
    return true;
  });

  // ---- 3. 規則與里程碑 ----
  await g("rules_shape_and_untouched_rules", async () => {
    const r = await rows<{ activity: string; window_kind: string; from_kind: string | null; from_offset: number; until_kind: string | null; until_offset: number; min_status: string; enabled: boolean; scoped: boolean }>(db,
      `SELECT activity, window_kind, from_kind, from_offset::int, until_kind, until_offset::int, min_status, enabled,
              (reasons IS NOT NULL OR levels IS NOT NULL OR election_types IS NOT NULL OR jurisdictions IS NOT NULL) AS scoped FROM activity_rules ORDER BY activity`);
    const bn = r.filter((x) => x.activity === "ballot_numbers");
    const windowed = ["election_results", "raw:election_result_missing", "party_gap", "party_roster", "ballot_numbers"];
    const rest = r.filter((x) => !windowed.includes(x.activity));
    return r.length === 37 && bn.length === 1 && bn[0].window_kind === "event" && bn[0].from_kind === "draw" && bn[0].from_offset === 0 &&
      bn[0].until_kind === "polling" && bn[0].until_offset === 0 && bn[0].min_status === "announced" && bn[0].enabled && !bn[0].scoped &&
      rest.length === 32 && rest.every((x) => x.window_kind === "always" && x.enabled);
  });
  await g("names_and_rules_in_sync", async () => {
    const x = await one<{ ok: boolean; n: number }>(db, `SELECT (SELECT array_agg(activity ORDER BY activity) FROM activity_rules) = (SELECT array_agg(a ORDER BY a) FROM unnest(activity_arm_names()) a) AS ok, cardinality(activity_arm_names())::int AS n`);
    return x.ok && x.n === 37;
  });
  await g("draw_milestones_backfilled_per_type", async () => {
    const m = await rows<{ election_type: string; on_date: string; basis: string; status: string }>(db, `SELECT election_type, on_date::text AS on_date, basis, status FROM election_milestones WHERE kind = 'draw' AND election_id = 2026 ORDER BY election_type`);
    return m.length === 7 && m.every((x) => x.on_date === "2026-10-23" && x.basis === "official" && x.status === "announced") && new Set(m.map((x) => x.election_type)).size === 7;
  });
  await g("health_empty", async () => (await rows(db, `SELECT * FROM activity_health`)).length === 0);
  await g("opened_by_carries_draw_and_polling", async () => {
    await clock(db, "2026-11-01");
    const x = await rows<{ ob: Record<string, unknown> }>(db, `SELECT opened_by AS ob FROM contribution_auto_tasks_arms() WHERE arm = 'ballot_numbers' ORDER BY task_id`);
    const rid = (await one<{ id: number }>(db, `SELECT id::int AS id FROM activity_rules WHERE activity = 'ballot_numbers'`)).id;
    return x.length === 3 && x.every((r) => r.ob.basis === "rule" && r.ob.arm === "ballot_numbers" && r.ob.rule_id === rid && r.ob.election_id === 2026 &&
      r.ob.milestone_kind === "draw" && r.ob.milestone_on_date === "2026-10-23" && r.ob.expected_open_on === "2026-10-23" && r.ob.open_until === "2026-11-28");
  });

  // ---- 4. seed：窗口開了派、關了記 window ----
  await g("seed_opens_on_draw_day_closes_as_window", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    const has = async (day: string) => {
      await clock(db, day);
      await seed();
      return (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id = ANY ($1)`, [BALLOT_2026_IDS])).length;
    };
    const a = await has("2026-10-22");
    const b = await has("2026-10-23");
    const c = await has("2026-11-28");
    const d = await has("2026-11-29");
    const closed = await rows<{ task_id: string; reason: string }>(db, `SELECT task_id, reason FROM gap_events WHERE event = 'closed' AND task_id = ANY ($1)`, [BALLOT_2026_IDS]);
    return a === 0 && b === 3 && c === 3 && d === 0 && closed.length === 3 && closed.every((x) => x.reason === "window");
  });
  await g("seed_stable_when_open", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-11-01");
    await seed();
    await seed();
    return (await rows(db, `SELECT 1 FROM gap_events WHERE event IN ('closed', 'reopened')`)).length === 0;
  });

  // ---- 5. 重跑、里程碑不被覆蓋 ----
  await g("rerunnable", async () => {
    await clock(db, "2026-10-08");
    const before = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await applyP2(db, mutateB(await readMig(BALLOT_MIG)), RESTUB);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_rules`);
    const m = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM election_milestones WHERE kind = 'draw'`);
    const after = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await db.exec("RESET app.activity_today");
    return before.h === after.h && before.n === after.n && n.n === 37 && m.n === 7 && (await rows(db, `SELECT * FROM activity_health`)).length === 0;
  });
  await g("milestone_rerun_keeps_existing", async () => {
    // 別的 PR 先把 draw 里程碑搬了（日期不同、說明不同）：這支再跑一遍不覆蓋
    await db.exec(`UPDATE election_milestones SET on_date = '2026-10-24', note = '別的 PR 先搬的' WHERE kind = 'draw' AND election_id = 2026 AND election_type = '縣市長'`);
    await applyP2(db, mutateB(await readMig(BALLOT_MIG)), RESTUB);
    const x = await one<{ d: string; note: string }>(db, `SELECT on_date::text AS d, note FROM election_milestones WHERE kind = 'draw' AND election_id = 2026 AND election_type = '縣市長'`);
    return x.d === "2026-10-24" && x.note === "別的 PR 先搬的";
  });
  return v;
}

const ALL_GUARDS = [
  "today_hides_ballot_rows", "closed_before_draw_day", "open_from_draw_day", "open_through_polling_day_closed_next_day", "past_elections_never_open",
  "type_without_draw_milestone_stays_closed", "other_arms_unaffected_on_every_day", "rules_shape_and_untouched_rules", "names_and_rules_in_sync",
  "draw_milestones_backfilled_per_type", "health_empty", "opened_by_carries_draw_and_polling", "seed_opens_on_draw_day_closes_as_window", "seed_stable_when_open",
  "rerunnable", "milestone_rerun_keeps_existing",
];

Deno.test("B1 整支跑得動；全部守門都綠（今天不變、10-22 不開、10-23 開、11-28 開、11-29 關、舊選舉不開、缺里程碑的職位不開、seed 記 window）", async () => {
  const db = await buildBallot();
  const v = await runSuite(db);
  const red = ALL_GUARDS.filter((x) => v[x] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...ALL_GUARDS].sort(), "守門清單與實際跑的要一致");
  await db.close();
});

Deno.test("B2 今天的總表＝沒有這支 migration 時逐件相同（筆數與全欄雜湊）；新臂的輸出在沒有規則時照樣會露出來（證明「濾掉」是規則在做事）", async () => {
  const oldDb = await buildBase();
  const newDb = await buildBallot();
  await clock(oldDb, "2026-10-08");
  await clock(newDb, "2026-10-08");
  const a = await armsFingerprint(oldDb, "contribution_auto_tasks_arms");
  const b = await armsFingerprint(newDb, "contribution_auto_tasks_arms");
  assertEquals(b, a);
  assert(a.h !== null && a.n === TODAY_IDS.length);
  // 規則 id 沒動既有的
  const idsOf = async (db: Db) => (await rows<{ activity: string; id: number }>(db, `SELECT activity, id::int FROM activity_rules WHERE activity <> 'ballot_numbers' ORDER BY activity`)).map((r) => `${r.activity}#${r.id}`);
  assertEquals(await idsOf(newDb), await idsOf(oldDb), "既有規則的 id 不變");
  // 投票日當天（11-28）新臂有輸出、舊的沒有
  await clock(oldDb, "2026-11-28");
  await clock(newDb, "2026-11-28");
  assertEquals((await armsFingerprint(newDb, "contribution_auto_tasks_arms")).n, (await armsFingerprint(oldDb, "contribution_auto_tasks_arms")).n + BALLOT_2026.length);
  await oldDb.close();
  await newDb.close();
});

// ---- 還原驗證：migration 文字改壞一處（精確改一處），對應的守門必須紅；有 migration 自己的檢查擋住的，要「整支失敗」 ----
const noRuleGuard = (s: string) => {
  const re = /\nDO \$\$\nBEGIN\n  IF \(SELECT count\(\*\) FROM activity_rules r WHERE r\.activity = 'ballot_numbers'[\s\S]*?\n\$\$;\n/;
  assert(re.test(s), "規則檢查的 DO 區塊要在");
  return s.replace(re, "\n");
};
const RULE_FRAG = "'ballot_numbers', 'event', 'draw', 0, 'polling', 0, 'announced', true";
const MUTATIONS: { name: string; breaks: string[]; edit: (sql: string) => string; buildFails?: boolean }[] = [
  { name: "起點 draw +0 改成 +1（抽籤隔天才開）", breaks: ["open_from_draw_day", "rules_shape_and_untouched_rules", "opened_by_carries_draw_and_polling", "seed_opens_on_draw_day_closes_as_window"],
    edit: (s) => mutate(noRuleGuard(s), RULE_FRAG, "'ballot_numbers', 'event', 'draw', 1, 'polling', 0, 'announced', true") },
  { name: "起點 draw +0 改成 -1（抽籤前一天就開）", breaks: ["closed_before_draw_day", "rules_shape_and_untouched_rules", "opened_by_carries_draw_and_polling", "seed_opens_on_draw_day_closes_as_window"],
    edit: (s) => mutate(noRuleGuard(s), RULE_FRAG, "'ballot_numbers', 'event', 'draw', -1, 'polling', 0, 'announced', true") },
  { name: "迄點 polling +0 改成 -1（投票日當天就關）", breaks: ["open_through_polling_day_closed_next_day", "rules_shape_and_untouched_rules", "opened_by_carries_draw_and_polling", "seed_opens_on_draw_day_closes_as_window"],
    edit: (s) => mutate(noRuleGuard(s), RULE_FRAG, "'ballot_numbers', 'event', 'draw', 0, 'polling', -1, 'announced', true") },
  { name: "迄點 polling +0 改成 +1（投票日隔天還開）", breaks: ["open_through_polling_day_closed_next_day", "rules_shape_and_untouched_rules", "opened_by_carries_draw_and_polling", "seed_opens_on_draw_day_closes_as_window"],
    edit: (s) => mutate(noRuleGuard(s), RULE_FRAG, "'ballot_numbers', 'event', 'draw', 0, 'polling', 1, 'announced', true") },
  { name: "沒有迄點（抽籤後一直開）", breaks: ["open_through_polling_day_closed_next_day", "rules_shape_and_untouched_rules", "seed_opens_on_draw_day_closes_as_window"],
    edit: (s) => mutate(noRuleGuard(s), RULE_FRAG, "'ballot_numbers', 'event', 'draw', 0, NULL, 0, 'announced', true") },
  { name: "min_status 改成 done（draw 里程碑只是 announced，永遠開不起來）", breaks: ["open_from_draw_day", "open_through_polling_day_closed_next_day", "rules_shape_and_untouched_rules", "seed_opens_on_draw_day_closes_as_window"],
    edit: (s) => mutate(noRuleGuard(s), RULE_FRAG, "'ballot_numbers', 'event', 'draw', 0, 'polling', 0, 'done', true") },
  { name: "規則停用（enabled=false），migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(noRuleGuard(s), RULE_FRAG, "'ballot_numbers', 'event', 'draw', 0, 'polling', 0, 'announced', false") },
  { name: "規則限定職位（只開縣市長）", breaks: ["rules_shape_and_untouched_rules", "open_from_draw_day"],
    edit: (s) => mutate(noRuleGuard(s), "SELECT 'ballot_numbers', 'event', 'draw', 0, 'polling', 0, 'announced', true,", "SELECT 'ballot_numbers', 'event', 'draw', 0, 'polling', 0, 'announced', true,") .replace("INSERT INTO activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, enabled, note)", "INSERT INTO activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, enabled, election_types, note)").replace("'announced', true,\n       '補號次", "'announced', true, ARRAY['縣市長'],\n       '補號次") },
  { name: "沒有種規則（總表對沒有規則的臂 RAISE）", breaks: [],
    buildFails: true, edit: (s) => { const t = noRuleGuard(s); const a = t.indexOf("INSERT INTO activity_rules"); const b = t.indexOf("WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'ballot_numbers');") + "WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'ballot_numbers');".length; assert(a > 0 && b > a); return t.slice(0, a) + t.slice(b); } },
  { name: "拿掉里程碑回填（沒有 draw 里程碑，窗口永遠開不起來）", breaks: ["open_from_draw_day", "open_through_polling_day_closed_next_day", "draw_milestones_backfilled_per_type", "opened_by_carries_draw_and_polling", "seed_opens_on_draw_day_closes_as_window"],
    edit: (s) => mutate(s, " WHERE s.ballot_draw_on IS NOT NULL\nON CONFLICT", " WHERE false\nON CONFLICT") },
  { name: "里程碑回填改成 DO UPDATE（覆蓋別的 PR 先搬的）", breaks: ["milestone_rerun_keeps_existing"],
    edit: (s) => mutate(s, "WHERE s.ballot_draw_on IS NOT NULL\nON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;", "WHERE s.ballot_draw_on IS NOT NULL\nON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO UPDATE SET on_date = EXCLUDED.on_date, note = EXCLUDED.note;") },
  { name: "里程碑回填改成整場選舉一列（election_type 空）：缺職位的關著守門紅", breaks: ["type_without_draw_milestone_stays_closed", "draw_milestones_backfilled_per_type"],
    edit: (s) => mutate(s, "SELECT s.election_id, 'draw', s.election_type, s.ballot_draw_on, 'official',", "SELECT DISTINCT s.election_id, 'draw', NULL, s.ballot_draw_on, 'official',") },
  { name: "總表少了 UNION 分支（臂接不進總表）", breaks: ["open_from_draw_day", "open_through_polling_day_closed_next_day", "opened_by_carries_draw_and_polling", "seed_opens_on_draw_day_closes_as_window"],
    edit: (s) => mutate(s, ADD_LINE, "") },
  { name: "總表的臂名標籤寫錯（標成 ballot_number）", breaks: ["open_from_draw_day", "opened_by_carries_draw_and_polling", "seed_opens_on_draw_day_closes_as_window"],
    edit: (s) => mutate(s, ADD_LINE, ADD_LINE.replace("'ballot_numbers' AS arm", "'ballot_number' AS arm")) },
  { name: "活動名清單漏了 ballot_numbers", breaks: ["names_and_rules_in_sync"],
    edit: (s) => mutate(s, "    'owner_mismatch',\n    'ballot_numbers'\n", "    'owner_mismatch'\n") },
  // ---- migration 自己的檢查 ----
  { name: "迄點改成 -1，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, RULE_FRAG, "'ballot_numbers', 'event', 'draw', 0, 'polling', -1, 'announced', true") },
  { name: "起點改成 +1，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, RULE_FRAG, "'ballot_numbers', 'event', 'draw', 1, 'polling', 0, 'announced', true") },
];

for (const m of MUTATIONS) {
  Deno.test(`B3 還原驗證：${m.name} → ${m.buildFails ? "migration 本身要失敗" : m.breaks.join("、") + " 必須紅"}`, async () => {
    if (m.buildFails) {
      let failed = false;
      try {
        const db = await buildBallot(m.edit);
        await db.close();
      } catch {
        failed = true;
      }
      assert(failed, `改壞了「${m.name}」，migration 卻照樣跑完（它自己的檢查沒擋住）`);
      return;
    }
    const db = await buildBallot(m.edit);
    const v = await runSuite(db, m.edit);
    const red = ALL_GUARDS.filter((x) => v[x] !== true).sort();
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
    await db.close();
  });
}

Deno.test("A9 還原驗證（文字層）：多動一個字、少一行、清單漏名字，A2／A3 都要紅", () => {
  assert(!isMechanicalArms(ARMS_PREV), "前一版本身不是「新的」");
  assert(!isMechanicalArms(mutate(ARMS_NEW, "ph AS MATERIALIZED", "ph AS")), "偷改 #448 的 MATERIALIZED");
  assert(!isMechanicalArms(mutate(ARMS_NEW, "activity_require_rule(x.arm)", "true")), "偷拿掉沒有規則就 RAISE");
  assert(!isMechanicalArms(ARMS_NEW.replace(ADD_LINE, ADD_LINE + ADD_LINE)), "多加一行");
  assert(!isMechanicalArms(mutate(ARMS_NEW, "UNION ALL SELECT 'party_info' AS arm", "UNION ALL SELECT 'party_info2' AS arm")), "偷改別的臂名標籤");
  assert(!isMechanicalNames(NAMES_PREV), "P1 的清單本身不是「新的」");
  assert(!isMechanicalNames(mutate(NAMES_NEW, "    'dup',\n", "")), "偷拿掉別的名字");
  assert(!isMechanicalNames(mutate(NAMES_NEW, "    'ballot_numbers'\n", "    'ballot_number'\n")), "名字拼錯");
});

// ============================================================
// C. 臂本體（真的 SQL 灌進 PGlite 的小資料表）
// ============================================================
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Pe = { id: number; eid?: number; pid: number; type: string | null; region_id?: number | null; status?: string; cand_no?: number | null };
type Person = { id: number; name: string; region?: string | null; merged?: boolean };
type Region = { id: number; region: string; sub_region?: string | null; village?: string | null };
async function buildArmDb(o: { people: Person[]; pes: Pe[]; regions?: Region[]; contributions?: Array<{ type: string; status: string; payload: Record<string, unknown> }>; listPublished?: boolean }): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text, region text, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, election_id integer, politician_id uuid, election_type text, region_id integer, candidacy_status text, cand_no integer);
    CREATE TABLE contributions (id serial PRIMARY KEY, contribution_type text, status text, payload jsonb);
    CREATE TABLE election_milestones_all (election_id integer, kind text, election_type text, on_date date, status text);
    CREATE TABLE _lp (published boolean);
    CREATE FUNCTION candidacy_list_published(p_election_id integer, p_election_type text, p_on date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT published FROM _lp $$;
    ${await latestFn("candidacy_protocol_status")}
    ${ARM}`);
  await db.exec(`INSERT INTO _lp VALUES (${o.listPublished ? "true" : "false"})`);
  await db.exec(`INSERT INTO elections VALUES (2026, '2026-11-28'), (2022, '2022-11-26')`);
  await db.exec(`INSERT INTO election_milestones_all VALUES (2026, 'draw', '縣市議員', '2026-10-23', 'announced'), (2026, 'list_published', NULL, '2026-11-17', 'announced')`);
  for (const r of o.regions ?? []) await db.query(`INSERT INTO regions VALUES ($1, $2, $3, $4)`, [r.id, r.region, r.sub_region ?? null, r.village ?? null]);
  for (const p of o.people) await db.query(`INSERT INTO politicians VALUES ($1, $2, $3, $4)`, [U(p.id), p.name, p.region === undefined ? "台北市" : p.region, p.merged ? U(9999) : null]);
  for (const e of o.pes) await db.query(`INSERT INTO politician_elections VALUES ($1, $2, $3, $4, $5, $6, $7)`, [e.id, e.eid ?? 2026, U(e.pid), e.type, e.region_id ?? null, e.status ?? "filed", e.cand_no ?? null]);
  for (const c of o.contributions ?? []) await db.query(`INSERT INTO contributions (contribution_type, status, payload) VALUES ($1, $2, $3::jsonb)`, [c.type, c.status, JSON.stringify(c.payload)]);
  return db;
}
const armRows = (db: Db) => rows<{ task_id: string; task_type: string; target: Record<string, any>; what_we_need: string; hint_sources: string[]; reward: number; region: string }>(db, `SELECT * FROM contribution_auto_tasks_ballot_numbers() ORDER BY task_id COLLATE "C"`);

Deno.test("C1 誰會被派：filed、沒號次、沒被併走、有選舉別、有縣市；退選／表態未登記／已有號次的不派；臺→台", async () => {
  const db = await buildArmDb({
    people: [{ id: 1, name: "甲" }, { id: 2, name: "乙" }, { id: 3, name: "丙" }, { id: 4, name: "丁" }, { id: 5, name: "戊", merged: true }, { id: 6, name: "己", region: null }, { id: 7, name: "庚", region: "臺中市" }, { id: 8, name: "辛" }],
    pes: [
      { id: 1, pid: 1, type: "縣市長" }, { id: 2, pid: 2, type: "縣市長", status: "withdrawn" }, { id: 3, pid: 3, type: "縣市長", status: "declared" },
      { id: 4, pid: 4, type: "縣市長", cand_no: 5 }, { id: 5, pid: 5, type: "縣市長" }, { id: 6, pid: 6, type: "縣市長" }, { id: 7, pid: 7, type: "縣市長" },
      { id: 8, pid: 8, type: null },
    ],
  });
  const r = await armRows(db);
  assertEquals(r.map((x) => x.task_id), ["auto:candidacy_source_missing:cand_no:2026:縣市長:台中市", "auto:candidacy_source_missing:cand_no:2026:縣市長:台北市"]);
  const tp = r.find((x) => x.region === "台北市")!;
  assertEquals(tp.target.items.map((i: any) => i.name), ["甲"]);
  assertEquals(tp.task_type, "candidacy_source_missing");
  assertEquals(tp.reward, 1);
  assertEquals(tp.target.kind, "cand_no");
  assertEquals(tp.target.election_id, 2026);
  assertEquals(tp.target.election_type, "縣市長");
  assertEquals(tp.target.items_count, 1);
  assertEquals(tp.target.missing, ["cand_no"]);
  assert(tp.hint_sources.length >= 3);
  await db.close();
});

Deno.test("C2 單位：縣市長／鄉鎮市長按縣市；議員按縣市、選舉區放 items 且排在一起；村里長與代表再按鄉鎮市區（task_id、target.sub_region、items.village）", async () => {
  const db = await buildArmDb({
    people: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `人${i + 1}` })),
    regions: [
      { id: 1, region: "台北市", sub_region: "第02選舉區" }, { id: 2, region: "台北市", sub_region: "第01選舉區" },
      { id: 3, region: "台北市", sub_region: "中山區", village: "新生里" }, { id: 4, region: "台北市", sub_region: "大安區", village: "德安里" },
      { id: 5, region: "屏東縣", sub_region: "來義鄉" }, { id: 6, region: "屏東縣", sub_region: "來義鄉", village: "來義村" },
    ],
    pes: [
      { id: 1, pid: 1, type: "縣市議員", region_id: 1 }, { id: 2, pid: 2, type: "縣市議員", region_id: 2 }, { id: 3, pid: 3, type: "縣市議員", region_id: 2 },
      { id: 4, pid: 4, type: "村里長", region_id: 3 }, { id: 5, pid: 5, type: "村里長", region_id: 4 }, { id: 6, pid: 6, type: "村里長", region_id: 3 },
      { id: 7, pid: 7, type: "鄉鎮市民代表", region_id: 5 }, { id: 8, pid: 8, type: "鄉鎮市長", region_id: null }, { id: 9, pid: 9, type: "鄉鎮市長", region_id: null },
      { id: 10, pid: 10, type: "村里長", region_id: 6 },
    ],
  });
  const r = await armRows(db);
  const by = Object.fromEntries(r.map((x) => [x.task_id.replace("auto:candidacy_source_missing:cand_no:2026:", ""), x]));
  assertEquals(Object.keys(by).sort(), ["村里長:台北市:中山區", "村里長:台北市:大安區", "村里長:屏東縣:來義鄉", "縣市議員:台北市", "鄉鎮市民代表:屏東縣:來義鄉", "鄉鎮市長:台北市"].sort());
  const council = by["縣市議員:台北市"];
  assertEquals(council.target.items.map((i: any) => `${i.electoral_district}/${i.name}`), ["第01選舉區/人2", "第01選舉區/人3", "第02選舉區/人1"]);
  assertEquals(council.target.sub_region, undefined, "議員沒有鄉鎮單位");
  const zs = by["村里長:台北市:中山區"];
  assertEquals(zs.target.sub_region, "中山區");
  assertEquals(zs.target.items.map((i: any) => `${i.village}/${i.name}`), ["新生里/人4", "新生里/人6"]);
  assertEquals(zs.target.items[0].sub_region, "中山區");
  assertEquals(by["鄉鎮市長:台北市"].target.items_count, 2);
  assertEquals(by["鄉鎮市長:台北市"].target.sub_region, undefined, "鄉鎮市長按縣市，不細到鄉鎮");
  assertEquals(by["鄉鎮市民代表:屏東縣:來義鄉"].target.items[0].village, undefined, "代表沒有村里");
  await db.close();
});

Deno.test("C3 拆件：一個單位超過 50 位拆成 :p1、:p2…（50 位剛好不拆、51 位拆兩件），parts、items_count 正確", async () => {
  const mk = (n: number, start: number) => Array.from({ length: n }, (_, i) => ({ id: start + i, name: `村${String(start + i).padStart(4, "0")}` }));
  const db = await buildArmDb({
    people: [...mk(120, 1), ...mk(50, 1000), ...mk(51, 2000)],
    regions: [{ id: 1, region: "高雄市", sub_region: "鼓山區", village: "A里" }, { id: 2, region: "高雄市", sub_region: "左營區", village: "B里" }, { id: 3, region: "高雄市", sub_region: "苓雅區", village: "C里" }],
    pes: [
      ...mk(120, 1).map((p) => ({ id: p.id, pid: p.id, type: "村里長", region_id: 1 })),
      ...mk(50, 1000).map((p) => ({ id: p.id, pid: p.id, type: "村里長", region_id: 2 })),
      ...mk(51, 2000).map((p) => ({ id: p.id, pid: p.id, type: "村里長", region_id: 3 })),
    ],
  });
  const r = await armRows(db);
  const sizes = Object.fromEntries(r.map((x) => [x.task_id.replace("auto:candidacy_source_missing:cand_no:2026:村里長:高雄市:", ""), `${x.target.items_count}/${x.target.items.length}/${x.target.part}of${x.target.parts}`]));
  assertEquals(sizes, { "左營區": "50/50/1of1", "苓雅區:p1": "50/50/1of2", "苓雅區:p2": "1/1/2of2", "鼓山區:p1": "50/50/1of3", "鼓山區:p2": "50/50/2of3", "鼓山區:p3": "20/20/3of3" });
  // 同一單位的拆件不重複、不遺漏
  const gu = r.filter((x) => x.task_id.includes("鼓山區")).flatMap((x) => x.target.items.map((i: any) => i.politician_election_id));
  assertEquals(new Set(gu).size, 120);
  await db.close();
});

Deno.test("C4 已經有人交了這一人這一屆帶號次的 candidacy、還在等票（pending／verified）的先不派；退件／套用完、沒帶號次的、別的人別的屆的不影響", async () => {
  const db = await buildArmDb({
    people: [{ id: 1, name: "甲" }, { id: 2, name: "乙" }, { id: 3, name: "丙" }, { id: 4, name: "丁" }, { id: 5, name: "戊" }, { id: 6, name: "己" }],
    pes: [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, pid: i, type: "縣市長" })),
    contributions: [
      { type: "candidacy", status: "pending", payload: { politician_id: U(1), election_id: 2026, cand_no: 3 } },
      { type: "candidacy", status: "verified", payload: { politician_id: U(2), election_id: 2026, cand_no: 4 } },
      { type: "candidacy", status: "rejected", payload: { politician_id: U(3), election_id: 2026, cand_no: 5 } },
      { type: "candidacy", status: "pending", payload: { politician_id: U(4), election_id: 2026 } },
      { type: "candidacy", status: "pending", payload: { politician_id: U(5), election_id: 2022, cand_no: 1 } },
      { type: "policy", status: "pending", payload: { politician_id: U(6), election_id: 2026, cand_no: 1 } },
    ],
  });
  const r = await armRows(db);
  assertEquals(r.length, 1);
  assertEquals(r[0].target.items.map((i: any) => i.name).sort(), ["丙", "丁", "戊", "己"].sort());
  await db.close();
});

Deno.test("C5 candidate_status 隨名單公告翻（公告前 registered、公告後 qualified）；任務說明講得出單位、件數、抽籤日與名單公告日、不要用登記彙總表、不要猜；target 帶日期", async () => {
  for (const [published, want] of [[false, "registered"], [true, "qualified"]] as const) {
    const db = await buildArmDb({ people: [{ id: 1, name: "甲" }], pes: [{ id: 1, pid: 1, type: "縣市議員", region_id: 1 }], regions: [{ id: 1, region: "台北市", sub_region: "第01選舉區" }], listPublished: published });
    const [x] = await armRows(db);
    assertEquals(x.target.candidate_status, want);
    assert(x.what_we_need.includes(`candidate_status 填「${want}」`));
    assert(x.what_we_need.includes("台北市 2026 縣市議員") && x.what_we_need.includes("1 位已登記") && x.what_we_need.includes("2026-10-23") && x.what_we_need.includes("2026-11-17"));
    assert(x.what_we_need.includes("與選舉區") && x.what_we_need.includes("electoral_district 照 target.items"));
    assert(x.what_we_need.includes("登記彙總表") && x.what_we_need.includes("不要猜"));
    assertEquals(x.target.draw_on, "2026-10-23");
    assertEquals(x.target.list_on, "2026-11-17");
    assertEquals(x.target.election_date, "2026-11-28");
    await db.close();
  }
});
