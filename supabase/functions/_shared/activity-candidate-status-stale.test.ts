/**
 * 派工與排程的啟用時間窗，P2「raw:candidate_status_stale」（2026-10-08，docs/PLAN-task-activation.md；migration 20261008162000_activity_windows_p2_candidate_status_stale.sql）。
 *
 * 一支臂一個 PR：raw 裡 candidate_status_stale 那一段的「registration_closed_on <= CURRENT_DATE」搬成規則「登記截止 +0 起」（沒有迄日、範圍不限）。
 * 做法照 #447（改 raw 的方式）：raw 的底版是 main 最新一版（20261008112000），現行定義＋一處機械式替換，其餘一字不差。
 * 今天輸出必須逐件不變。只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. 文字層：raw 的新定義＝前一版加一處機械式替換；這支只改 raw 一支函式、一條規則，不動總表與 seed
 *   B. PGlite（行為層）
 *        1. 總表層：raw 換成 stub（回放表裡的列），總表、規則、里程碑、seed 跑真的。今天的總表＝P1（舊本體輸出、規則全是永遠開）逐件相同；
 *           假時鐘 09-03 關、09-04 開、之後一直開（沒有迄日）；每職位用自己的登記截止；2028 新選舉各自從自己的登記截止起；舊屆別永遠關；raw 的其他任務型別不受影響；seed 等窗口
 *        2. 臂層（端到端等價）：把 raw 裡 candidate_status_stale 那一段的真實 SQL 文字抽出來，在 PGlite 的合成資料上跑——舊本體把 CURRENT_DATE 換成假日期，
 *           新本體不比日期、輸出再用 activity_open() 依同一個假日期過濾，兩邊在每個日期的 task_id 集合與內容必須相同。這一項不靠 stub，直接驗「規則＝被拿掉的那個條件」
 *        3. 每條守門都做還原驗證：把 migration 改壞一處（精確改一處，改不到就失敗），對應的守門必須紅；migration 自己的檢查也要擋得住
 *
 * 正式庫快照版的「逐件不變」見 scripts/arms-parity-p2.ts check candidate_status_stale <snapshot.json>（不進 CI：要唯讀快照；PR 說明附結果）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyP2, ARM_BRANCHES, armsFingerprint, buildArmsDb, DEFAULT_ELECTIONS, DEFAULT_SCOPE, fnText, type GapRow, latestFn, migrationNames, mutate, P2_CS_MIG, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";

const QP = await readMig("20261008090000_queue_priority_tiers.sql");
const P2 = await readMig(P2_CS_MIG);
// 依序套用所有已上線的 P2 migration（選舉結果、party_gap、party_roster 在前），測的是累積後的真實狀態；臂本體都換回 stub
const RESTUB = ["raw", "election_results", "party_gap", "party_roster"] as const;
const count = (s: string, sub: string) => s.split(sub).length - 1;

// ============================================================
// A. 文字層
// ============================================================
const COND = `  WHERE (pe.candidacy_status IS NULL OR pe.candidacy_status = 'considering')
    AND s.registration_closed_on <= CURRENT_DATE
`;
const NEW_FRAG = `  WHERE (pe.candidacy_status IS NULL OR pe.candidacy_status = 'considering')
    -- 登記截止之後才派：移到規則（activity_rules「raw:candidate_status_stale」：登記截止 +0 起，P2 20261008162000）；這裡不再比日期
`;
const PREV = await latestFn("contribution_auto_tasks_raw", P2_CS_MIG);
const NEW = fnText(P2, "contribution_auto_tasks_raw");
const isMechanical = (fn: string) => {
  try {
    return mutate(fn, NEW_FRAG, COND) === PREV;
  } catch {
    return false;
  }
};

Deno.test("A1 前一版是對的：緊接在這支之前的 raw 定義是 20261008112000（#447，與正式庫一字不差），中間沒有人插一版（插了，抄的底就過期）", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw(")) defining.push(n);
  const i = defining.indexOf(P2_CS_MIG);
  assert(i > 0, "這支要在重新定義 raw 的清單裡");
  assertEquals(defining[i - 1], "20261008112000_roster_check_gap_dispatch.sql", "前一版變了：那一版要以最新的為底重做機械式替換");
});

Deno.test("A2 raw 的新定義＝前一版加一處機械式替換（candidate_status_stale 的日期條件換成一行說明註解），其餘一字不差", () => {
  assert(isMechanical(NEW));
  assertEquals(count(PREV, COND), 1);
  assertEquals(count(NEW, "s.registration_closed_on <="), 0, "raw 裡不再有「登記截止日 <= 今天」");
  // 簽名、回傳型別、語言、穩定度不動
  assertEquals(NEW.split("\n").slice(0, 5).join("\n"), PREV.split("\n").slice(0, 5).join("\n"));
  // 前一版其他已上線的修改一個都沒丟：重查判準（#447）、名單時程句（20261008000001）、選舉結果的日期條件已移走（P2 選舉結果）
  assert(NEW.includes("OR COALESCE(rc.last_cec_count, 0) > COALESCE(o.n_listed, 0)"));
  assert(NEW.includes("roster_schedule_text(s.registration_closed_on, s.list_announced_on, s.municipal_mayor_list_on"));
  assert(NEW.includes("-- 投票日之後才派：移到規則（activity_rules「raw:election_result_missing」"));
  // 其他拿 CURRENT_DATE 當日期的地方都還在（它們不是「這一段何時開」，或是下一批）：progress_stale 的 90 天與投票日條件、roster_check 的名單公告日判斷
  assert(NEW.includes("pl.last_updated < CURRENT_DATE - INTERVAL '90 days'"));
  assert(NEW.includes("e.election_date < CURRENT_DATE"));
  assert(NEW.includes("CURRENT_DATE >= s.list_announced_on"));
  // 文案與 target 裡的登記截止日仍然讀 scope 的欄位，不動
  assert(NEW.includes("'registration_closed_on', s.registration_closed_on"));
});

Deno.test("A3 這支只動 raw 一支函式與 raw:candidate_status_stale 一條規則：不重寫別的函式（含總表與 seed）、不動表結構、不新增規則", () => {
  const code = P2.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, ["contribution_auto_tasks_raw"]);
  assert(!/DROP |ALTER TABLE|CREATE TABLE|INSERT INTO|DELETE FROM|TRUNCATE/i.test(code), "不建表、不刪東西、不新增規則（只把現有的一條原地改成窗口）");
  assertEquals(count(code, "UPDATE activity_rules"), 1, "只有一個 UPDATE");
  assert(code.includes("WHERE activity = 'raw:candidate_status_stale'"), "UPDATE 只指名這個活動");
  assert(!/UPDATE (elections|election_milestones|task_dispatches|politician_elections|roster_check_scope)/i.test(code));
  assert(!/seed_auto_task_queue|FUNCTION contribution_auto_tasks_arms/.test(code), "不動總表與 seed");
  // 規則的形狀：登記截止 +0 起、沒有迄日、不限範圍、預設 announced
  assert(code.includes("window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind = NULL, until_offset = 0, min_status = 'announced'"));
  assert(code.includes("reasons = NULL, levels = NULL, election_types = NULL, jurisdictions = NULL"));
});

Deno.test("A4 還原驗證（文字層）：動不該動的字、把日期條件放回去、少一處替換，A2 都要紅", () => {
  assert(!isMechanical(mutate(NEW, "(pe.candidacy_status IS NULL OR pe.candidacy_status = 'considering')", "(pe.candidacy_status IS NULL)")), "偷改過濾");
  assert(!isMechanical(mutate(NEW, "COALESCE(rc.last_cec_count, 0) > COALESCE(o.n_listed, 0)", "COALESCE(rc.last_cec_count, 0) >= COALESCE(o.n_listed, 0)")), "偷改 #447 的重查判準");
  assert(!isMechanical(mutate(NEW, NEW_FRAG, COND.replace("s.registration_closed_on <= CURRENT_DATE", "s.registration_closed_on < CURRENT_DATE"))), "放回去的日期條件不一樣");
  assert(!isMechanical(mutate(NEW, "'auto:candidate_status_stale:' || pe.id", "'auto:candidate_status_stale2:' || pe.id")), "偷改 task_id 形狀");
  assert(!isMechanical(mutate(NEW, "e.election_date < CURRENT_DATE", "e.election_date <= CURRENT_DATE")), "偷改別處的日期條件");
  assert(!isMechanical(PREV), "前一版本身不是「新的」（還有日期條件）");
});

// ============================================================
// B. PGlite（行為層）
// ============================================================
const G = (id: string, type: string, target: Record<string, unknown> | null = null, region: string | null = "台北市"): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h1"], reward: 1, region });
const S = (pe: number, election_id: number, election_type: string) =>
  G(`candidate_status_stale:${pe}`, "candidate_status_stale", { politician_id: `p${pe}`, name: `人${pe}`, election_id, election_type, candidate_status: "rumored", region: "台北市", registration_closed_on: "2026-09-04" });
const sid = (pe: number) => `auto:candidate_status_stale:${pe}`;

// 2026 九合一：登記 09-04 截止（正式庫現況）
const S2026 = [S(701, 2026, "縣市長"), S(702, 2026, "縣市議員"), S(703, 2026, "村里長")];
// 新臂本體會多算、但窗口之外的列：2028 立法委員（登記 2027-12-01 截止，今天還沒登記）；以及假想的舊屆別列（沒有 registration_close 里程碑）
const S2028 = [S(801, 2028, "立法委員")];
const S_OLD = [S(901, 2022, "縣市長"), S(902, 2024, "立法委員"), S(903, 4, "縣市長")];
// raw 的其他任務型別（各種日期）：規則只管 candidate_status_stale，這些任何一天都不能被影響
const RAW_OTHERS = [
  G("policy_missing:abc", "policy_missing", { politician_id: "a", election_id: 2026, election_type: "縣市長" }),
  G("roster_check:2026:台北市:縣市長", "roster_check", { election_id: 2026, election_type: "縣市長", region: "台北市" }),
  G("progress_stale:9", "progress_stale", { policy_id: 9, election_id: 2022 }),
  G("candidacy_source_missing:77", "candidacy_source_missing", { politician_id: "b", election_id: 2026, election_type: "縣市長" }),
];
const OTHERS: Partial<Record<(typeof ARM_BRANCHES)[number], GapRow[]>> = {
  not_running: [G("not_running_recheck:77", "not_running_recheck", { politician_election_id: 77, election_id: 2026, election_type: "縣市長" })],
  party_info: [G("party_info1", "party_info_missing", { election_id: 2026 })],
  dup: [G("dup1", "duplicate_politician", null)],
  term_policies: [G("tp26", "term_policy_missing", { election_id: 2026, election_type: "縣市長" })],
};
const OLD_BRANCHES = { ...OTHERS, raw: [...RAW_OTHERS, ...S2026] };
const NEW_BRANCHES = { ...OTHERS, raw: [...RAW_OTHERS, ...S2026, ...S2028, ...S_OLD] };
const OTHER_IDS = [...Object.values(OTHERS).flat().map((r) => r!.task_id), ...RAW_OTHERS.map((r) => r.task_id)];
const S2026_IDS = S2026.map((r) => r.task_id);
const TODAY_IDS = [...OTHER_IDS, ...S2026_IDS];
const NEW_TOTAL = [...OTHER_IDS, ...[...S2026, ...S2028, ...S_OLD].map((r) => r.task_id)];

const ELECTIONS = [...DEFAULT_ELECTIONS, { id: 2028, election_key: "2028-01-15_national", election_date: "2028-01-15", election_reason: "regular", election_types: ["總統副總統", "立法委員"] }];
// 2028 立法委員：登記 2027-12-01 截止（里程碑由 P0 從 scope 回填，每個職位一列）
const SCOPE = [...DEFAULT_SCOPE, { election_id: 2028, election_type: "立法委員", registration_closed_on: "2027-12-01", list_announced_on: "2028-01-05" }];

// 優先層（#443）加的東西與 #448 要的人物表，用最小的替身讓總表與 seed 跑得動（簽名照 #443 的定義）；優先層本身由 queue-priority.test.ts 守
// politicians／politician_elections／regions 多給幾個欄位，臂層等價測試（B5）要在上面跑真的 SQL
const STUB_TABLES = `
CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid, region text);
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text);
CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL, election_id integer, election_type text, candidacy_status text, region_id integer);`;
const QP_STUB = `${STUB_TABLES}
${await latestFn("politician_name_is_placeholder")}
ALTER TABLE task_dispatches ADD COLUMN priority SMALLINT;
CREATE FUNCTION activity_priority(p_activity TEXT, p_election_id INTEGER DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT NULL)
RETURNS TABLE (priority SMALLINT, rule_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE)
LANGUAGE sql STABLE AS $$ SELECT 2::SMALLINT, NULL::BIGINT, NULL::TEXT, NULL::DATE, NULL::DATE $$;`;
Deno.test("A0 優先層替身的簽名與回傳欄位跟 #443 的真實定義一致", () => {
  assert(QP.includes("RETURNS TABLE (priority SMALLINT, rule_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE)"));
  assert(QP.includes("p_activity TEXT, p_election_id INTEGER DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT activity_today()"));
  assert(QP.includes("ADD COLUMN IF NOT EXISTS priority SMALLINT REFERENCES task_priority_tiers(id)"));
});

const buildP2 = (mutateP2?: (s: string) => string, branches = NEW_BRANCHES) =>
  buildArmsDb({
    branches, elections: ELECTIONS, scope: SCOPE, afterP1Sql: QP_STUB,
    p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: P2_CS_MIG, mutate: mutateP2 }], restub: RESTUB },
  });

type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];
const ids = async (db: Db, where = "true") => (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_arms() WHERE ${where} ORDER BY task_id COLLATE "C"`)).map((r) => r.task_id);
const clock = (db: Db, day: string) => db.exec(`SET app.activity_today = '${day}'`);
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

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

async function runSuite(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  const g = (name: string, f: () => Promise<boolean>) => guard(v, db, name, f);
  const stale = (day: string) => clock(db, day).then(() => ids(db, `arm = 'raw:candidate_status_stale'`));
  const only2026 = async (day: string) => (await stale(day)).filter((i) => S2026_IDS.includes(i));
  const seed = () => db.exec(`SELECT seed_auto_task_queue()`);

  // ---- 1. 今天輸出逐件不變 ----
  await g("today_hides_rows_outside_window", async () => {
    await clock(db, "2026-10-08");
    return same(await ids(db), TODAY_IDS) && (await ids(db)).length === NEW_TOTAL.length - S2028.length - S_OLD.length;
  });

  // ---- 2. 假時鐘：登記截止當天開，之後一直開 ----
  await g("window_opens_on_registration_close_day_and_stays_open", async () => {
    return (await only2026("2026-01-01")).length === 0 && (await only2026("2026-09-03")).length === 0 &&
      same(await only2026("2026-09-04"), S2026_IDS) && same(await only2026("2026-09-05"), S2026_IDS) && same(await only2026("2026-10-23"), S2026_IDS) &&
      same(await only2026("2026-11-12"), S2026_IDS) && same(await only2026("2026-11-17"), S2026_IDS) &&
      // 沒有迄日：投票日之後也一直問到結論為止
      same(await only2026("2026-11-28"), S2026_IDS) && same(await only2026("2026-11-29"), S2026_IDS) && same(await only2026("2027-06-01"), S2026_IDS) && same(await only2026("2030-01-01"), S2026_IDS);
  });
  await g("each_position_uses_its_own_registration_close", async () => {
    // 縣市議員的登記截止改到 09-10（里程碑是每個職位一列）：縣市長 09-04 起、縣市議員 09-10 起、村里長 09-04 起
    await db.exec(`UPDATE election_milestones SET on_date = '2026-09-10' WHERE kind = 'registration_close' AND election_id = 2026 AND election_type = '縣市議員'`);
    return same(await only2026("2026-09-04"), [sid(701), sid(703)]) && same(await only2026("2026-09-09"), [sid(701), sid(703)]) && same(await only2026("2026-09-10"), S2026_IDS);
  });
  await g("new_election_runs_its_own_window", async () => {
    // 2028 立法委員：登記 2027-12-01 截止；2028 不用再改任何規則；沒有迄日所以投票日（2028-01-15）之後也開
    const at = async (day: string) => (await stale(day)).filter((i) => i === sid(801));
    return (await at("2026-10-08")).length === 0 && (await at("2027-11-30")).length === 0 && (await at("2027-12-01")).length === 1 && (await at("2028-01-15")).length === 1 &&
      (await at("2028-06-01")).length === 1;
  });
  await g("old_elections_never_open_no_registration_milestone", async () => {
    // 2022、2024、重行選舉沒有 registration_close 里程碑：窗口永遠關（fail closed），和臂內原本 JOIN scope 擋掉它們的結果一致
    const oldIds = S_OLD.map((r) => r.task_id);
    for (const d of ["2022-01-01", "2022-11-26", "2022-12-18", "2024-01-13", "2026-10-08", "2030-01-01"]) {
      if ((await stale(d)).some((i) => oldIds.includes(i))) return false;
    }
    return true;
  });

  // ---- 3. raw 的其他任務型別、別的臂不受影響；規則形狀；健康檢查 ----
  await g("other_task_types_and_arms_unaffected_on_every_day", async () => {
    for (const d of ["2022-01-01", "2026-09-03", "2026-09-04", "2026-10-08", "2026-11-28", "2026-11-29", "2030-01-01"]) {
      await clock(db, d);
      if (!same(await ids(db, `arm <> 'raw:candidate_status_stale'`), OTHER_IDS)) return false;
    }
    return true;
  });
  await g("rules_shape_and_untouched_rules", async () => {
    const r = await rows<{ activity: string; window_kind: string; from_kind: string | null; from_offset: number; until_kind: string | null; min_status: string; enabled: boolean; scoped: boolean }>(db,
      `SELECT activity, window_kind, from_kind, from_offset::int, until_kind, min_status, enabled,
              (reasons IS NOT NULL OR levels IS NOT NULL OR election_types IS NOT NULL OR jurisdictions IS NOT NULL) AS scoped FROM activity_rules ORDER BY activity`);
    const me = r.filter((x) => x.activity === "raw:candidate_status_stale");
    const done = ["election_results", "raw:election_result_missing", "party_gap", "party_roster"];
    const rest = r.filter((x) => x.activity !== "raw:candidate_status_stale" && !done.includes(x.activity));
    return r.length === 36 && me.length === 1 &&
      me.every((x) => x.window_kind === "event" && x.from_kind === "registration_close" && x.from_offset === 0 && x.until_kind === null && x.min_status === "announced" && x.enabled && !x.scoped) &&
      // 已上線的四條（選舉結果兩條、party_gap、party_roster）這個 PR 不碰；其餘 31 條仍是永遠開
      done.every((a) => r.filter((x) => x.activity === a).every((x) => x.window_kind === "event")) &&
      rest.length === 31 && rest.every((x) => x.window_kind === "always" && x.enabled && x.from_kind === null) && rest.some((x) => x.activity === "raw:roster_check");
  });
  await g("health_empty", async () => (await rows(db, `SELECT * FROM activity_health`)).length === 0);

  // ---- 4. opened_by 帶規則與起點里程碑（沒有迄點，不帶 open_until）----
  await g("opened_by_carries_rule_and_milestone_without_until", async () => {
    await clock(db, "2026-10-08");
    const x = await rows<{ task_id: string; ob: Record<string, unknown> }>(db, `SELECT task_id, opened_by AS ob FROM contribution_auto_tasks_arms() WHERE arm = 'raw:candidate_status_stale' ORDER BY task_id`);
    const rid = (await one<{ id: number }>(db, `SELECT id::int AS id FROM activity_rules WHERE activity = 'raw:candidate_status_stale'`)).id;
    return x.length === S2026.length && x.every((r) => r.ob.basis === "rule" && r.ob.rule_id === rid && r.ob.election_id === 2026 && r.ob.milestone_kind === "registration_close" &&
      r.ob.milestone_on_date === "2026-09-04" && r.ob.expected_open_on === "2026-09-04" && r.ob.open_until === undefined);
  });

  // ---- 5. seed：窗口沒開不建派工列、開了才建；沒有迄日所以不會因窗口收回；補上了記 filled ----
  await g("seed_waits_for_window_and_never_closes_on_window", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-09-03");
    await seed();
    const before = await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id = ANY ($1)`, [S2026_IDS]);
    await clock(db, "2026-09-04");
    await seed();
    const opened = await rows<{ task_id: string; ob: Record<string, unknown> }>(db, `SELECT task_id, opened_by AS ob FROM task_dispatches WHERE task_id = ANY ($1)`, [S2026_IDS]);
    const ev = await rows<{ event: string; ex: string }>(db, `SELECT event, detail->>'expected_open_on' AS ex FROM gap_events WHERE task_id = ANY ($1)`, [S2026_IDS]);
    // 投票日之後仍在：沒有迄日，窗口不會把它關掉
    await clock(db, "2026-11-29");
    await seed();
    const still = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = ANY ($1)`, [S2026_IDS]);
    const closed = await rows(db, `SELECT 1 FROM gap_events WHERE event = 'closed' AND task_id = ANY ($1)`, [S2026_IDS]);
    return before.length === 0 && same(opened.map((r) => r.task_id), S2026_IDS) && opened.every((r) => r.ob.expected_open_on === "2026-09-04" && r.ob.open_until === undefined) &&
      ev.length === S2026.length && ev.every((e) => e.event === "opened" && e.ex === "2026-09-04") && still.length === S2026.length && closed.length === 0;
  });
  await g("seed_records_filled_when_arm_no_longer_computes", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-10-08");
    await seed();
    // 結論有了（臂不再算它）：記 filled
    await db.exec(`DELETE FROM _b_raw WHERE task_id = '${sid(701)}'`);
    await seed();
    const closed = await rows<{ task_id: string; reason: string }>(db, `SELECT task_id, reason FROM gap_events WHERE event = 'closed' AND task_id = ANY ($1)`, [S2026_IDS]);
    return closed.length === 1 && closed[0].task_id === sid(701) && closed[0].reason === "filled";
  });
  await g("seed_keeps_rows_inside_window_today", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-10-08");
    await seed();
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'auto:%'`);
    return n.n === TODAY_IDS.length;
  });

  // ---- 6. 重跑 ----
  await g("rerunnable", async () => {
    await clock(db, "2026-10-08");
    const before = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await applyP2(db, await readMig(P2_CS_MIG), RESTUB);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_rules`);
    const after = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await db.exec("RESET app.activity_today"); // 時鐘被覆寫時 activity_health 會列 clock_overridden
    return before.h === after.h && before.n === after.n && n.n === 36 && (await rows(db, `SELECT * FROM activity_health`)).length === 0;
  });
  return v;
}

const ALL_GUARDS = [
  "today_hides_rows_outside_window", "window_opens_on_registration_close_day_and_stays_open", "each_position_uses_its_own_registration_close", "new_election_runs_its_own_window",
  "old_elections_never_open_no_registration_milestone", "other_task_types_and_arms_unaffected_on_every_day", "rules_shape_and_untouched_rules", "health_empty",
  "opened_by_carries_rule_and_milestone_without_until", "seed_waits_for_window_and_never_closes_on_window", "seed_records_filled_when_arm_no_longer_computes",
  "seed_keeps_rows_inside_window_today", "rerunnable",
];

Deno.test("B1 這支 migration 在 PGlite 上整支跑得動；全部守門都綠（今天不變、登記截止當天開並一直開、每職位自己的登記截止、新選舉、舊屆別永遠關、seed）", async () => {
  const db = await buildP2();
  const v = await runSuite(db);
  const red = ALL_GUARDS.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...ALL_GUARDS].sort(), "守門清單與實際跑的要一致");
  await db.close();
});

Deno.test("B2 今天的總表＝P1（舊本體輸出、規則全是永遠開）逐件相同：筆數與全欄雜湊；規則 id 沒變（原地改成窗口）；沒套規則時窗口外的列確實會露出來", async () => {
  const prior = { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }], restub: RESTUB };
  const oldDb = await buildArmsDb({ branches: OLD_BRANCHES, elections: ELECTIONS, scope: SCOPE, afterP1Sql: QP_STUB, p2: prior });
  const newDb = await buildP2();
  await clock(oldDb, "2026-10-08");
  await clock(newDb, "2026-10-08");
  const a = await armsFingerprint(oldDb, "contribution_auto_tasks_arms");
  const b = await armsFingerprint(newDb, "contribution_auto_tasks_arms");
  assertEquals(b, a);
  assert(a.h !== null && a.n === TODAY_IDS.length);
  const idsOf = async (db: Db) => (await rows<{ activity: string; id: number }>(db, `SELECT activity, id::int FROM activity_rules ORDER BY activity`)).map((r) => `${r.activity}#${r.id}`);
  assertEquals(await idsOf(newDb), await idsOf(oldDb), "規則 id 不變（原地 UPDATE，不是刪了重種）");
  // 沒套規則、新本體的輸出照樣露出來：證明「濾掉窗口外的列」是規則在做事，不是 stub 本來就少
  const noRule = await buildArmsDb({ branches: NEW_BRANCHES, elections: ELECTIONS, scope: SCOPE, afterP1Sql: QP_STUB, p2: prior });
  await clock(noRule, "2026-10-08");
  assertEquals((await armsFingerprint(noRule, "contribution_auto_tasks_arms")).n, NEW_TOTAL.length);
  await oldDb.close();
  await newDb.close();
  await noRule.close();
});

// ---- 臂層等價（端到端）：真實的 SQL 文字，合成資料，假日期 ----
// raw 裡 candidate_status_stale 那一段是一個完整的 SELECT（UNION ALL 的一支）：從 SELECT 'auto:candidate_status_stale:' 到下一個 UNION ALL
const segment = (fn: string) => {
  const a = fn.indexOf("SELECT 'auto:candidate_status_stale:'");
  const b = fn.indexOf("\n  UNION ALL", a);
  assert(a > 0 && b > a, "找不到 candidate_status_stale 那一段");
  return fn.slice(a, b);
};
const OLD_SEG = segment(PREV);
const NEW_SEG = segment(NEW);
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";

async function equivalenceDb(mutateP2?: (s: string) => string): Promise<Db> {
  const db = await buildP2(mutateP2, { ...OTHERS, raw: [] });
  await db.exec(`
    INSERT INTO regions (id, region) VALUES (1, '台北市'), (2, '新北市');
    INSERT INTO politicians (id, name, region) SELECT ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, '人' || n, CASE WHEN n % 2 = 0 THEN '新北市' END FROM generate_series(1, 12) n;
    -- 登記狀態：NULL（傳聞）／considering 才算；filed、withdrawn 不算
    INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id) VALUES
      (1, '00000000-0000-0000-0000-000000000001', 2026, '縣市長', NULL, 1),
      (2, '00000000-0000-0000-0000-000000000002', 2026, '縣市議員', 'considering', 2),
      (3, '00000000-0000-0000-0000-000000000003', 2026, '村里長', 'filed', 1),
      (4, '00000000-0000-0000-0000-000000000004', 2026, '縣市長', 'withdrawn', 1),
      (5, '00000000-0000-0000-0000-000000000005', 2028, '立法委員', NULL, NULL),
      (6, '00000000-0000-0000-0000-000000000006', 2022, '縣市長', NULL, 1),
      (7, '00000000-0000-0000-0000-000000000007', 2026, '縣市議員', NULL, 1),
      (8, '00000000-0000-0000-0000-000000000008', 2026, '鄉鎮市長', 'considering', NULL),
      (9, '00000000-0000-0000-0000-000000000009', 2024, '立法委員', NULL, 1),
      (10, '00000000-0000-0000-0000-000000000010', 4, '縣市長', NULL, 1),
      (11, '00000000-0000-0000-0000-000000000011', 2026, '直轄市山地原住民區長', NULL, 2),
      (12, '00000000-0000-0000-0000-000000000012', 2028, '總統副總統', NULL, 1)`);
  // 兩個職位的登記截止錯開，驗「每個職位用自己的」
  await db.exec(`UPDATE election_milestones SET on_date = '2026-09-10' WHERE kind = 'registration_close' AND election_id = 2026 AND election_type = '縣市議員'`);
  await db.exec(`UPDATE roster_check_scope SET registration_closed_on = DATE '2026-09-10' WHERE election_id = 2026 AND election_type = '縣市議員'`);
  return db;
}
const equivDays = [
  "2022-01-01", "2026-08-31", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-09", "2026-09-10", "2026-09-11", "2026-10-08", "2026-10-23", "2026-11-12", "2026-11-17",
  "2026-11-27", "2026-11-28", "2026-11-29", "2026-12-31", "2027-11-30", "2027-12-01", "2027-12-02", "2028-01-15", "2028-01-16", "2030-01-01",
];
async function equivalence(db: Db): Promise<{ ok: boolean; detail: string; sizes: number[] }> {
  const sizes: number[] = [];
  for (const d of equivDays) {
    await clock(db, d);
    // 舊：日期條件還在臂裡（CURRENT_DATE 換成這一天）；新：臂不比日期，輸出再依規則（同一天）過濾
    const oldRows = await rows<{ j: string }>(db, `SELECT to_jsonb(x)::text AS j FROM (${OLD_SEG.replaceAll("CURRENT_DATE", `DATE '${d}'`)}
) AS x(${COLS}) ORDER BY 1`);
    const newRows = await rows<{ j: string }>(db,
      `SELECT to_jsonb(x)::text AS j FROM (${NEW_SEG}
) AS x(${COLS})
        WHERE EXISTS (SELECT 1 FROM activity_open('raw:candidate_status_stale', (x.target->>'election_id')::int, x.target->>'election_type', DATE '${d}')) ORDER BY 1`);
    sizes.push(oldRows.length);
    if (JSON.stringify(oldRows) !== JSON.stringify(newRows)) return { ok: false, detail: `${d}：舊 ${oldRows.length} 列、新 ${newRows.length} 列`, sizes };
  }
  return { ok: true, detail: "", sizes };
}

Deno.test("B3 臂層端到端等價：真實的 candidate_status_stale SQL 文字在合成資料上跑，舊（CURRENT_DATE 換成假日期）與新（不比日期＋規則過濾同一天）每個日期逐列相同", async () => {
  const db = await equivalenceDb();
  const r = await equivalence(db);
  assert(r.ok, r.detail);
  // 不是空對空：登記前 0 列、縣市長／村里長的登記截止後有列、縣市議員晚幾天、2028 要到 2027-12-01 才有，最多 6 列（pe 1、2、7、8、11、5）
  assertEquals(r.sizes[equivDays.indexOf("2026-09-03")], 0);
  assertEquals(r.sizes[equivDays.indexOf("2026-09-04")], 3); // pe 1（縣市長）、8（鄉鎮市長）、11（原住民區長）；縣市議員（2、7）09-10 才起
  assertEquals(r.sizes[equivDays.indexOf("2026-09-10")], 5);
  assertEquals(r.sizes[equivDays.indexOf("2027-12-01")], 6);
  assertEquals(r.sizes[equivDays.indexOf("2030-01-01")], 6);
  await db.close();
});

// ---- 還原驗證：migration 文字改壞一處（精確改一處），對應的守門必須紅；有 migration 自己的檢查擋住的，要「整支失敗」 ----
const noGuard = (s: string) => s.slice(0, s.indexOf("\nDO $$"));
const MUTATIONS: { name: string; breaks: string[]; edit: (sql: string) => string; buildFails?: boolean; equivalenceFails?: boolean }[] = [
  { name: "起點偏移 0 改成 +1（登記截止當天還沒開）", breaks: ["window_opens_on_registration_close_day_and_stays_open", "opened_by_carries_rule_and_milestone_without_until", "rules_shape_and_untouched_rules", "seed_waits_for_window_and_never_closes_on_window"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "from_kind = 'registration_close', from_offset = 0, until_kind", "from_kind = 'registration_close', from_offset = 1, until_kind") },
  { name: "起點偏移 0 改成 -1（登記截止前一天就開）", breaks: ["window_opens_on_registration_close_day_and_stays_open", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "from_kind = 'registration_close', from_offset = 0, until_kind", "from_kind = 'registration_close', from_offset = -1, until_kind") },
  { name: "不改規則（還是永遠開）：窗口外的列今天就露出來", breaks: ["today_hides_rows_outside_window", "window_opens_on_registration_close_day_and_stays_open", "old_elections_never_open_no_registration_milestone", "rules_shape_and_untouched_rules", "seed_waits_for_window_and_never_closes_on_window"], equivalenceFails: true,
    edit: (s) => s.slice(0, s.indexOf("-- 2. 規則")) },
  { name: "加迄點（投票日當天止）：投票日之後不再問，但原條件沒有迄日", breaks: ["window_opens_on_registration_close_day_and_stays_open", "new_election_runs_its_own_window", "rules_shape_and_untouched_rules", "seed_waits_for_window_and_never_closes_on_window"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "from_offset = 0, until_kind = NULL, until_offset = 0, min_status", "from_offset = 0, until_kind = 'polling', until_offset = 0, min_status") },
  { name: "起點掛錯里程碑（名單公告日 list_published）", breaks: ["window_opens_on_registration_close_day_and_stays_open", "each_position_uses_its_own_registration_close", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "from_kind = 'registration_close', from_offset = 0, until_kind", "from_kind = 'list_published', from_offset = 0, until_kind") },
  { name: "min_status 改成 done：還沒發生的登記截止（2028）不開窗", breaks: ["new_election_runs_its_own_window", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "until_offset = 0, min_status = 'announced'", "until_offset = 0, min_status = 'done'") },
  { name: "限定職位（只開縣市長）：其他職位的缺口被濾掉", breaks: ["window_opens_on_registration_close_day_and_stays_open", "each_position_uses_its_own_registration_close", "new_election_runs_its_own_window", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "levels = NULL, election_types = NULL", "levels = NULL, election_types = ARRAY['縣市長']") },
  { name: "限定事由（只開 regular）", breaks: ["rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "recur_months = NULL, reasons = NULL", "recur_months = NULL, reasons = ARRAY['regular']") },
  { name: "改到別的活動（raw:roster_check）：candidate_status_stale 還是永遠開、roster_check 被改成窗口", breaks: ["today_hides_rows_outside_window", "window_opens_on_registration_close_day_and_stays_open", "other_task_types_and_arms_unaffected_on_every_day", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "WHERE activity = 'raw:candidate_status_stale'", "WHERE activity = 'raw:roster_check'") },
  { name: "把停用（enabled=false）寫進規則：整類任務不派", breaks: ["window_opens_on_registration_close_day_and_stays_open", "rules_shape_and_untouched_rules", "seed_keeps_rows_inside_window_today"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "jurisdictions = NULL, enabled = true,", "jurisdictions = NULL, enabled = false,") },
  // migration 自己的檢查：規則不是預期的一條「登記截止 +0 起」就整支失敗（寧可不上線）
  { name: "起點偏移 +1，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "from_kind = 'registration_close', from_offset = 0, until_kind", "from_kind = 'registration_close', from_offset = 1, until_kind") },
  { name: "加迄點，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "from_offset = 0, until_kind = NULL, until_offset = 0, min_status", "from_offset = 0, until_kind = 'polling', until_offset = 0, min_status") },
  { name: "min_status 改成 done，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "until_offset = 0, min_status = 'announced'", "until_offset = 0, min_status = 'done'") },
  { name: "改到別的活動，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "WHERE activity = 'raw:candidate_status_stale'", "WHERE activity = 'raw:roster_check'") },
];

for (const m of MUTATIONS) {
  Deno.test(`B4 還原驗證：${m.name} → ${m.buildFails ? "migration 本身要失敗" : m.breaks.join("、") + (m.equivalenceFails ? "、臂層等價" : "") + " 必須紅"}`, async () => {
    if (m.buildFails) {
      let failed = false;
      try {
        const db = await buildP2(m.edit);
        await db.close();
      } catch {
        failed = true;
      }
      assert(failed, `改壞了「${m.name}」，migration 卻照樣跑完（它自己的檢查沒擋住）`);
      return;
    }
    const db = await buildP2(m.edit);
    const v = await runSuite(db);
    const red = ALL_GUARDS.filter((g) => v[g] !== true).sort();
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
    await db.close();
    if (m.equivalenceFails) {
      const eq = await equivalenceDb(m.edit);
      const r = await equivalence(eq);
      assert(!r.ok, `改壞了「${m.name}」，臂層等價卻沒紅`);
      await eq.close();
    }
  });
}
