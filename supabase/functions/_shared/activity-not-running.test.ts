/**
 * 派工與排程的啟用時間窗，P2「not_running」（2026-10-08，docs/PLAN-task-activation.md；migration 20261008161000_activity_windows_p2_not_running.sql）。
 *
 * 一支臂一個 PR：not_running 臂內的兩個日期條件（registration_closed_on <= CURRENT_DATE、election_date >= CURRENT_DATE）搬成規則
 * 「登記截止 +0 起、投票日 +0 止」（兩端都含當天、範圍不限）。這是第二支「有迄日」的臂，也是第一支起點不是投票日的臂。
 * 今天輸出必須逐件不變。只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. 文字層：not_running 的新定義＝前一版（緊接在這支之前的那一版，與正式庫 pg_get_functiondef 一字不差）加一處機械式替換；這支只改這一支臂、這一條規則，不動總表與 seed
 *   B. PGlite（行為層）：臂本體換成 stub（回放表裡的列），總表、規則、里程碑、seed 跑真的（已上線的 P2 migration 依序套好：選舉結果、party_gap、party_roster）
 *        1. 今天（2026-10-08）的總表＝P1（只有舊本體的輸出、規則全是永遠開）逐件相同
 *        2. 假時鐘：2026-09-03 關、09-04（登記截止當天）開、11-28（投票日當天）開、11-29 關；每個職位用自己的登記截止；2028 的新選舉各自從自己的登記截止到自己的投票日
 *        3. 舊屆別（2022、2024、重行選舉）沒有 registration_close 里程碑，窗口永遠關（fail closed）；其他臂不受影響；opened_by 帶規則、起點里程碑與迄日
 *        4. seed：窗口沒開不建派工列、開了才建；窗口關了的收回記 window、臂已算不出來的記 filled
 *        5. 臂層（端到端等價，B5）：把 not_running 真實的 SQL 文字在合成資料上跑——舊本體把 CURRENT_DATE 換成假日期，新本體不比日期、輸出再用 activity_open() 依同一個假日期過濾，
 *           兩邊在每個日期逐列相同。這一項不靠 stub，直接驗「規則＝被拿掉的那兩個條件」（正式庫快照上這一步是空對空，見 PR 說明）
 *        6. 每條守門都做還原驗證：把 migration 改壞一處（精確改一處，改不到就失敗），對應的守門必須紅；migration 自己的檢查也要擋得住
 *
 * 正式庫快照版的「逐件不變」見 scripts/arms-parity-p2.ts check not_running <snapshot.json>（不進 CI：要唯讀快照；PR 說明附結果）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import {
  applyP2, ARM_BRANCHES, armsFingerprint, buildArmsDb, DEFAULT_ELECTIONS, DEFAULT_SCOPE, fnText, type GapRow, latestFn, migrationNames, mutate,
  P2_ER_MIG, P2_NR_MIG, P2_PG_MIG, P2_PR_MIG, readMig,
} from "./arms-pglite.ts";

const QP = await readMig("20261008090000_queue_priority_tiers.sql");
const P2 = await readMig(P2_NR_MIG);
// 依序套用所有已上線的 P2 migration（選舉結果、party_gap、party_roster 在前），測的是累積後的真實狀態；臂本體都換回 stub
const RESTUB = ["raw", "election_results", "party_gap", "party_roster", "not_running"] as const;
const count = (s: string, sub: string) => s.split(sub).length - 1;

// ============================================================
// A. 文字層
// ============================================================
const COND = `  WHERE pe.candidacy_status = 'withdrawn'
    AND s.registration_closed_on <= CURRENT_DATE
    -- 投票日過了就不必再問「他有沒有登記」，那時該問的是結果
    AND (e.election_date IS NULL OR e.election_date >= CURRENT_DATE)
    AND pe.verified IS NOT TRUE
`;
const NEW_FRAG = `  WHERE pe.candidacy_status = 'withdrawn'
    -- 登記截止之後、投票日當天（含）之前才派：移到規則（activity_rules「not_running」：登記截止 +0 起、投票日 +0 止，P2 20261008161000）；這裡不再比日期
    AND pe.verified IS NOT TRUE
`;
const PREV = await latestFn("contribution_auto_tasks_not_running", P2_NR_MIG);
const NEW = fnText(P2, "contribution_auto_tasks_not_running");
const isMechanical = (fn: string) => {
  try {
    return mutate(fn, NEW_FRAG, COND) === PREV;
  } catch {
    return false;
  }
};

Deno.test("A1 前一版是對的：緊接在這支之前的 not_running 定義是 20261006220000（與正式庫一字不差），中間沒有人插一版（插了，抄的底就過期）", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_not_running(")) defining.push(n);
  const i = defining.indexOf(P2_NR_MIG);
  assert(i > 0, "這支要在重新定義 not_running 的清單裡");
  assertEquals(defining[i - 1], "20261006220000_candidacy_read_side.sql", "前一版變了：那一版要以最新的為底重做機械式替換");
});

Deno.test("A2 not_running 的新定義＝前一版加一處機械式替換（兩個日期條件換成一行說明註解），其餘一字不差", () => {
  assert(isMechanical(NEW));
  assertEquals(count(PREV, COND), 1);
  assertEquals(count(NEW, "CURRENT_DATE"), 0, "臂裡已經沒有任何一處拿 CURRENT_DATE 比日期");
  assertEquals(count(NEW, "registration_closed_on <="), 0);
  assertEquals(count(NEW, "e.election_date"), 0);
  // 簽名、回傳型別、語言、穩定度不動
  assertEquals(NEW.split("\n").slice(0, 4).join("\n"), PREV.split("\n").slice(0, 4).join("\n"));
  // 其餘的過濾條件都還在（只拿掉日期那兩條，沒有順手動別的）
  assert(NEW.includes("WHERE pe.candidacy_status = 'withdrawn'"));
  assert(NEW.includes("AND pe.verified IS NOT TRUE"));
  assert(NEW.includes("JOIN roster_check_scope s ON s.election_id = pe.election_id AND s.election_type = pe.election_type"));
  assert(NEW.includes("JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL"));
  assert(NEW.includes("AND pe.withdrawn_after_filing IS NOT TRUE"));
  assert(NEW.includes("h.table_name = 'politician_elections' AND h.record_id = pe.id::TEXT"));
  // 文案裡的登記截止日（target 與說明）仍然讀 scope 的欄位，不動
  assert(NEW.includes("'registration_closed_on', s.registration_closed_on"));
});

Deno.test("A3 這支只動 not_running 一支臂與它的規則：不重寫別的函式（含總表與 seed）、不動表結構、不新增規則", () => {
  const code = P2.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, ["contribution_auto_tasks_not_running"]);
  assert(!/DROP |ALTER TABLE|CREATE TABLE|INSERT INTO|DELETE FROM|TRUNCATE/i.test(code), "不建表、不刪東西、不新增規則（只把現有的一條原地改成窗口）");
  assertEquals(count(code, "UPDATE activity_rules"), 1, "只有一個 UPDATE");
  assert(code.includes("WHERE activity = 'not_running'"), "UPDATE 只指名這個活動");
  assert(!/UPDATE (elections|election_milestones|task_dispatches|politician_elections|roster_check_scope)/i.test(code));
  assert(!/seed_auto_task_queue|FUNCTION contribution_auto_tasks_arms/.test(code), "不動總表與 seed");
  // 規則的形狀：登記截止 +0 起、投票日 +0 止、不限範圍、預設 announced
  assert(code.includes("window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0, min_status = 'announced'"));
  assert(code.includes("reasons = NULL, levels = NULL, election_types = NULL, jurisdictions = NULL"));
});

Deno.test("A4 還原驗證（文字層）：動不該動的字、把日期條件放回去、少一處替換，A2 都要紅", () => {
  assert(!isMechanical(mutate(NEW, "AND pe.verified IS NOT TRUE", "AND pe.verified IS TRUE")), "偷改過濾");
  assert(!isMechanical(mutate(NEW, "AND pe.withdrawn_after_filing IS NOT TRUE", "AND pe.withdrawn_after_filing IS TRUE")), "偷改登記後退選的排除");
  assert(!isMechanical(mutate(NEW, NEW_FRAG, COND.replace("s.registration_closed_on <= CURRENT_DATE", "s.registration_closed_on < CURRENT_DATE"))), "放回去的日期條件不一樣");
  assert(!isMechanical(mutate(NEW, NEW_FRAG, NEW_FRAG.replace("    -- 登記截止之後", "    AND true\n    -- 登記截止之後"))), "多加一條");
  assert(!isMechanical(mutate(NEW, "'auto:not_running_recheck:' || pe.id", "'auto:not_running_recheck2:' || pe.id")), "偷改 task_id 形狀");
  assert(!isMechanical(PREV), "前一版本身不是「新的」（還有日期條件）");
});

// ============================================================
// B. PGlite（行為層）
// ============================================================
const G = (id: string, type: string, target: Record<string, unknown> | null = null, region: string | null = "台北市"): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h1"], reward: 2, region });
const N = (pe: number, election_id: number, election_type: string) =>
  G(`not_running_recheck:${pe}`, "not_running_recheck", { politician_election_id: pe, politician_id: `p${pe}`, name: `人${pe}`, election_id, election_type, region: "台北市", registration_closed_on: "2026-09-04" });
const tid = (pe: number) => `auto:not_running_recheck:${pe}`;

// 2026 九合一：登記 09-04 截止、11-28 投票（正式庫現況，今天臂的輸出就是這幾列）
const N2026 = [N(701, 2026, "縣市長"), N(702, 2026, "縣市議員"), N(703, 2026, "村里長")];
// 新臂本體會多算、但窗口之外的列：2028 立法委員（登記 2027-12-01 截止、2028-01-15 投票，今天還沒登記）；以及假想的舊屆別列（2022、2024、重行選舉：沒有 registration_close 里程碑）
const N2028 = [N(801, 2028, "立法委員")];
const N_OLD = [N(901, 2022, "縣市長"), N(902, 2024, "立法委員"), N(903, 4, "縣市長")];
const OTHERS: Partial<Record<(typeof ARM_BRANCHES)[number], GapRow[]>> = {
  withdrawn_filing: [G("wf1", "not_running_recheck", { politician_election_id: 77, election_id: 2026, election_type: "縣市長" })],
  party_info: [G("party_info1", "party_info_missing", { election_id: 2026 })],
  dup: [G("dup1", "duplicate_politician", null)],
  term_policies: [G("tp26", "term_policy_missing", { election_id: 2026, election_type: "縣市長" })],
  raw: [G("candidate_status_stale:55", "candidate_status_stale", { election_id: 2026, election_type: "縣市長" })],
};
const OLD_BRANCHES = { ...OTHERS, not_running: N2026 };
const NEW_BRANCHES = { ...OTHERS, not_running: [...N2026, ...N2028, ...N_OLD] };
const OTHER_IDS = Object.values(OTHERS).flat().map((r) => r!.task_id);
const N2026_IDS = N2026.map((r) => r.task_id);
const TODAY_IDS = [...OTHER_IDS, ...N2026_IDS];
const NEW_TOTAL = [...OTHER_IDS, ...[...N2026, ...N2028, ...N_OLD].map((r) => r.task_id)];

const ELECTIONS = [...DEFAULT_ELECTIONS, { id: 2028, election_key: "2028-01-15_national", election_date: "2028-01-15", election_reason: "regular", election_types: ["總統副總統", "立法委員"] }];
// 2028 立法委員：登記 2027-12-01 截止（里程碑由 P0 從 scope 回填，每個職位一列）
const SCOPE = [...DEFAULT_SCOPE, { election_id: 2028, election_type: "立法委員", registration_closed_on: "2027-12-01", list_announced_on: "2028-01-05" }];

// 優先層（#443）加的東西，用最小的替身讓 seed 跑得動（簽名照 #443 的定義）；優先層本身由 queue-priority.test.ts 守
// politicians／politician_elections／regions 多給幾個欄位，臂層等價測試（B5）要在上面跑 not_running 真實的 SQL
const QP_STUB = `
CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid, region text);
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text);
CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL, election_id integer, election_type text, candidacy_status text, region_id integer,
  source_note text, verified boolean, withdrawn_after_filing boolean);
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
    p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: P2_NR_MIG, mutate: mutateP2 }], restub: RESTUB },
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
  const nr = (day: string) => clock(db, day).then(() => ids(db, `arm = 'not_running'`));
  const only2026 = async (day: string) => (await nr(day)).filter((i) => N2026_IDS.includes(i));
  const seed = () => db.exec(`SELECT seed_auto_task_queue()`);

  // ---- 1. 今天輸出逐件不變 ----
  await g("today_hides_rows_outside_window", async () => {
    await clock(db, "2026-10-08");
    // 新本體多算的列（2028 還沒登記、舊屆別沒有 registration_close 里程碑）被規則濾掉：今天的總表＝舊本體世界的清單（手算）
    return same(await ids(db), TODAY_IDS) && (await ids(db)).length === NEW_TOTAL.length - N2028.length - N_OLD.length;
  });

  // ---- 2. 假時鐘：登記截止當天開、投票日當天仍開、隔天關 ----
  await g("window_edges_registration_close_and_polling_day", async () => {
    return (await only2026("2026-01-01")).length === 0 && (await only2026("2026-09-03")).length === 0 &&
      same(await only2026("2026-09-04"), N2026_IDS) && same(await only2026("2026-09-05"), N2026_IDS) && same(await only2026("2026-10-23"), N2026_IDS) &&
      same(await only2026("2026-11-12"), N2026_IDS) && same(await only2026("2026-11-17"), N2026_IDS) &&
      same(await only2026("2026-11-27"), N2026_IDS) && same(await only2026("2026-11-28"), N2026_IDS) &&
      (await only2026("2026-11-29")).length === 0 && (await only2026("2026-12-31")).length === 0 && (await only2026("2030-01-01")).length === 0;
  });
  await g("each_position_uses_its_own_registration_close", async () => {
    // 縣市議員的登記截止改到 09-10（里程碑是每個職位一列）：縣市長 09-04 起、縣市議員 09-10 起、村里長 09-04 起
    await db.exec(`UPDATE election_milestones SET on_date = '2026-09-10' WHERE kind = 'registration_close' AND election_id = 2026 AND election_type = '縣市議員'`);
    return same(await only2026("2026-09-04"), [tid(701), tid(703)]) && same(await only2026("2026-09-09"), [tid(701), tid(703)]) &&
      same(await only2026("2026-09-10"), N2026_IDS) && same(await only2026("2026-11-28"), N2026_IDS) && (await only2026("2026-11-29")).length === 0;
  });
  await g("new_election_runs_its_own_window", async () => {
    // 2028 立法委員：登記 2027-12-01 截止、投票 2028-01-15；2028 不用再改任何規則
    const at = async (day: string) => (await nr(day)).filter((i) => i === tid(801));
    return (await at("2027-11-30")).length === 0 && (await at("2027-12-01")).length === 1 && (await at("2028-01-15")).length === 1 && (await at("2028-01-16")).length === 0 &&
      (await at("2026-10-08")).length === 0;
  });
  await g("old_elections_never_open_no_registration_milestone", async () => {
    // 2022、2024、重行選舉沒有 registration_close 里程碑：窗口永遠關（fail closed），和臂內原本 JOIN scope 擋掉它們的結果一致
    const oldIds = N_OLD.map((r) => r.task_id);
    for (const d of ["2022-01-01", "2022-11-26", "2022-12-18", "2024-01-13", "2026-10-08", "2030-01-01"]) {
      if ((await nr(d)).some((i) => oldIds.includes(i))) return false;
    }
    return true;
  });
  await g("polling_day_missing_closes_window", async () => {
    // 沒有投票日的選舉沒有 polling 里程碑，迄點找不到＝關（原條件把 NULL 當作還沒投票；正式庫每場選舉都有投票日，health 會報 election_without_polling）
    await db.exec(`UPDATE elections SET election_date = NULL WHERE id = 2026`);
    return (await only2026("2026-10-08")).length === 0;
  });

  // ---- 3. 其他臂不受影響；規則形狀；健康檢查 ----
  await g("other_arms_unaffected_on_every_day", async () => {
    for (const d of ["2022-01-01", "2026-09-03", "2026-09-04", "2026-10-08", "2026-11-28", "2026-11-29", "2030-01-01"]) {
      await clock(db, d);
      // withdrawn_filing 與 not_running 產出同型任務（not_running_recheck），這個 PR 只動 not_running 一支
      if (!same(await ids(db, `arm <> 'not_running'`), OTHER_IDS)) return false;
    }
    return true;
  });
  await g("rules_shape_and_untouched_rules", async () => {
    const r = await rows<{ activity: string; window_kind: string; from_kind: string | null; from_offset: number; until_kind: string | null; until_offset: number; min_status: string; enabled: boolean; scoped: boolean }>(db,
      `SELECT activity, window_kind, from_kind, from_offset::int, until_kind, until_offset::int, min_status, enabled,
              (reasons IS NOT NULL OR levels IS NOT NULL OR election_types IS NOT NULL OR jurisdictions IS NOT NULL) AS scoped FROM activity_rules ORDER BY activity`);
    const me = r.filter((x) => x.activity === "not_running");
    const done = ["election_results", "raw:election_result_missing", "party_gap", "party_roster"];
    const rest = r.filter((x) => x.activity !== "not_running" && !done.includes(x.activity));
    return r.length === 36 && me.length === 1 &&
      me.every((x) => x.window_kind === "event" && x.from_kind === "registration_close" && x.from_offset === 0 && x.until_kind === "polling" && x.until_offset === 0 && x.min_status === "announced" && x.enabled && !x.scoped) &&
      // 已上線的四條（選舉結果兩條、party_gap、party_roster）這個 PR 不碰；其餘 31 條仍是永遠開
      done.every((a) => r.filter((x) => x.activity === a).every((x) => x.window_kind === "event")) &&
      rest.length === 31 && rest.every((x) => x.window_kind === "always" && x.enabled && x.from_kind === null) && rest.some((x) => x.activity === "withdrawn_filing");
  });
  await g("health_empty", async () => (await rows(db, `SELECT * FROM activity_health`)).length === 0);

  // ---- 4. opened_by 帶規則、起點里程碑與迄日 ----
  await g("opened_by_carries_rule_milestone_and_until", async () => {
    await clock(db, "2026-10-08");
    const x = await rows<{ task_id: string; ob: Record<string, unknown> }>(db, `SELECT task_id, opened_by AS ob FROM contribution_auto_tasks_arms() WHERE arm = 'not_running' ORDER BY task_id`);
    const rid = (await one<{ id: number }>(db, `SELECT id::int AS id FROM activity_rules WHERE activity = 'not_running'`)).id;
    return x.length === N2026.length && x.every((r) => r.ob.basis === "rule" && r.ob.rule_id === rid && r.ob.election_id === 2026 && r.ob.milestone_kind === "registration_close" &&
      r.ob.milestone_on_date === "2026-09-04" && r.ob.expected_open_on === "2026-09-04" && r.ob.open_until === "2026-11-28");
  });

  // ---- 5. seed：窗口沒開不建派工列、開了才建、關了收回記 window、臂算不出來記 filled ----
  await g("seed_waits_for_window_and_closes_with_window_reason", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-09-03");
    await seed();
    const before = await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id = ANY ($1)`, [N2026_IDS]);
    await clock(db, "2026-09-04");
    await seed();
    const opened = await rows<{ task_id: string; ob: Record<string, unknown> }>(db, `SELECT task_id, opened_by AS ob FROM task_dispatches WHERE task_id = ANY ($1)`, [N2026_IDS]);
    const ev = await rows<{ event: string; ex: string }>(db, `SELECT event, detail->>'expected_open_on' AS ex FROM gap_events WHERE task_id = ANY ($1)`, [N2026_IDS]);
    // 投票日當天還在，隔天收回：臂還算得出這些列（stub 還在回放），是規則的窗口關了 → window
    await clock(db, "2026-11-28");
    await seed();
    const still = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = ANY ($1)`, [N2026_IDS]);
    await clock(db, "2026-11-29");
    await seed();
    const gone = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = ANY ($1)`, [N2026_IDS]);
    const closed = await rows<{ task_id: string; reason: string }>(db, `SELECT task_id, reason FROM gap_events WHERE event = 'closed' AND task_id = ANY ($1)`, [N2026_IDS]);
    return before.length === 0 && same(opened.map((r) => r.task_id), N2026_IDS) && opened.every((r) => r.ob.expected_open_on === "2026-09-04" && r.ob.open_until === "2026-11-28") &&
      ev.length === N2026.length && ev.every((e) => e.event === "opened" && e.ex === "2026-09-04") &&
      still.length === N2026.length && gone.length === 0 && closed.length === N2026.length && closed.every((c) => c.reason === "window");
  });
  await g("seed_records_filled_when_arm_no_longer_computes", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-10-08");
    await seed();
    // 補上了（臂不再算它）：記 filled，不是 window
    await db.exec(`DELETE FROM _b_not_running WHERE task_id = '${tid(701)}'`);
    await seed();
    const closed = await rows<{ task_id: string; reason: string }>(db, `SELECT task_id, reason FROM gap_events WHERE event = 'closed' AND task_id = ANY ($1)`, [N2026_IDS]);
    return closed.length === 1 && closed[0].task_id === tid(701) && closed[0].reason === "filled";
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
    await applyP2(db, await readMig(P2_NR_MIG), RESTUB);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_rules`);
    const after = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await db.exec("RESET app.activity_today"); // 時鐘被覆寫時 activity_health 會列 clock_overridden
    return before.h === after.h && before.n === after.n && n.n === 36 && (await rows(db, `SELECT * FROM activity_health`)).length === 0;
  });
  return v;
}

const ALL_GUARDS = [
  "today_hides_rows_outside_window", "window_edges_registration_close_and_polling_day", "each_position_uses_its_own_registration_close", "new_election_runs_its_own_window",
  "old_elections_never_open_no_registration_milestone", "polling_day_missing_closes_window", "other_arms_unaffected_on_every_day", "rules_shape_and_untouched_rules",
  "health_empty", "opened_by_carries_rule_milestone_and_until", "seed_waits_for_window_and_closes_with_window_reason", "seed_records_filled_when_arm_no_longer_computes",
  "seed_keeps_rows_inside_window_today", "rerunnable",
];

Deno.test("B1 這支 migration 在 PGlite 上整支跑得動；全部守門都綠（今天不變、起迄邊界日、每職位自己的登記截止、新選舉、舊屆別永遠關、seed window／filled）", async () => {
  const db = await buildP2();
  const v = await runSuite(db);
  const red = ALL_GUARDS.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...ALL_GUARDS].sort(), "守門清單與實際跑的要一致");
  await db.close();
});

Deno.test("B2 今天的總表＝P1（舊本體輸出、規則全是永遠開）逐件相同：筆數與全欄雜湊；規則 id 沒變（原地改成窗口）；沒套規則時窗口外的列確實會露出來", async () => {
  // 舊世界：已上線的 P2 都套好，只差這一支；臂是舊本體的輸出（只有 2026 的列）
  const oldDb = await buildArmsDb({
    branches: OLD_BRANCHES, elections: ELECTIONS, scope: SCOPE, afterP1Sql: QP_STUB,
    p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }], restub: RESTUB.filter((x) => x !== "not_running") },
  });
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
  const noRule = await buildArmsDb({
    branches: NEW_BRANCHES, elections: ELECTIONS, scope: SCOPE, afterP1Sql: QP_STUB,
    p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }], restub: RESTUB.filter((x) => x !== "not_running") },
  });
  await clock(noRule, "2026-10-08");
  assertEquals((await armsFingerprint(noRule, "contribution_auto_tasks_arms")).n, NEW_TOTAL.length);
  await oldDb.close();
  await newDb.close();
  await noRule.close();
});

Deno.test("B3 與 scope 的關係：登記截止日（scope 欄位）改了而里程碑沒改，窗口跟里程碑走——兩邊對不上是 activity_health 的 milestone_scope_drift 管的事", async () => {
  const db = await buildP2();
  await db.exec(`UPDATE roster_check_scope SET registration_closed_on = DATE '2026-09-20' WHERE election_id = 2026 AND election_type = '縣市長'`);
  await clock(db, "2026-09-10");
  // 窗口讀里程碑（09-04），不讀 scope 欄位：09-10 已經開
  assert((await ids(db, `arm = 'not_running'`)).includes(tid(701)));
  const drift = await rows<{ check_name: string }>(db, `SELECT check_name FROM activity_health WHERE check_name = 'milestone_scope_drift'`);
  assertEquals(drift.length, 1, "兩份真相走鐘時，健康檢查看得到");
  await db.close();
});

// ---- 臂層端到端等價：真實的 not_running SQL 文字，合成資料，假日期 ----
// 臂本體是一個完整的 SELECT：取 $$ 與 $$ 之間，當子查詢跑。舊本體把 CURRENT_DATE 換成假日期；新本體不比日期，輸出再用 activity_open() 依同一個假日期過濾
const bodyOf = (fn: string) => {
  const a = fn.indexOf("AS $$") + "AS $$".length;
  return fn.slice(a, fn.lastIndexOf("$$")).trim();
};
const OLD_BODY = bodyOf(PREV);
const NEW_BODY = bodyOf(NEW);
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";

async function equivalenceDb(mutateP2?: (s: string) => string): Promise<Db> {
  const db = await buildP2(mutateP2, { ...OTHERS, not_running: [] });
  const U = (n: number) => `'00000000-0000-0000-0000-${String(n).padStart(12, "0")}'`;
  await db.exec(`
    INSERT INTO regions (id, region) VALUES (1, '台北市'), (2, '新北市');
    INSERT INTO politicians (id, name, region, merged_into)
      SELECT ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, '人' || n, CASE WHEN n % 2 = 0 THEN '新北市' END, CASE WHEN n = 13 THEN '00000000-0000-0000-0000-000000000001'::uuid END FROM generate_series(1, 14) n;
    -- candidacy_status＝withdrawn 才算；verified、withdrawn_after_filing 的各種組合；2026 各職位、2028、2022、2024、重行選舉
    INSERT INTO politician_elections (id, politician_id, election_id, election_type, candidacy_status, region_id, verified, withdrawn_after_filing) VALUES
      (1, ${U(1)}, 2026, '縣市長', 'withdrawn', 1, NULL, false),
      (2, ${U(2)}, 2026, '縣市議員', 'withdrawn', 2, false, false),
      (3, ${U(3)}, 2026, '村里長', 'withdrawn', 1, NULL, false),
      (4, ${U(4)}, 2026, '縣市長', 'withdrawn', 1, true, false),
      (5, ${U(5)}, 2026, '縣市長', 'filed', 1, NULL, false),
      (6, ${U(6)}, 2026, '縣市長', 'withdrawn', 1, NULL, true),
      (7, ${U(7)}, 2026, '縣市長', 'withdrawn', 1, NULL, NULL),
      (8, ${U(8)}, 2028, '立法委員', 'withdrawn', NULL, NULL, false),
      (9, ${U(9)}, 2022, '縣市長', 'withdrawn', 1, NULL, false),
      (10, ${U(10)}, 2024, '立法委員', 'withdrawn', 1, NULL, false),
      (11, ${U(11)}, 4, '縣市長', 'withdrawn', 1, NULL, false),
      (12, ${U(12)}, 2026, '鄉鎮市長', 'withdrawn', NULL, NULL, false),
      (13, ${U(13)}, 2026, '縣市長', 'withdrawn', 1, NULL, false),
      (14, ${U(14)}, 2028, '總統副總統', 'withdrawn', 1, NULL, false);
    -- 有人已經照名冊交過更正（還沒還原）：這一列不再問；還原了的照問
    INSERT INTO edit_history (table_name, record_id, field, reverted_at) VALUES ('politician_elections', '3', 'withdrawn_after_filing', NULL), ('politician_elections', '12', 'withdrawn_after_filing', now())`);
  // 縣市議員的登記截止錯開到 09-10，驗「每個職位用自己的」
  await db.exec(`UPDATE election_milestones SET on_date = '2026-09-10' WHERE kind = 'registration_close' AND election_id = 2026 AND election_type = '縣市議員'`);
  await db.exec(`UPDATE roster_check_scope SET registration_closed_on = DATE '2026-09-10' WHERE election_id = 2026 AND election_type = '縣市議員'`);
  return db;
}
const equivDays = [
  "2022-01-01", "2022-11-26", "2026-08-31", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-09", "2026-09-10", "2026-09-11", "2026-10-08", "2026-10-23", "2026-11-12",
  "2026-11-17", "2026-11-27", "2026-11-28", "2026-11-29", "2026-12-31", "2027-11-30", "2027-12-01", "2028-01-14", "2028-01-15", "2028-01-16", "2030-01-01",
];
async function equivalence(db: Db): Promise<{ ok: boolean; detail: string; sizes: number[] }> {
  const sizes: number[] = [];
  for (const d of equivDays) {
    await clock(db, d);
    const oldRows = await rows<{ j: string }>(db, `SELECT to_jsonb(x)::text AS j FROM (${OLD_BODY.replaceAll("CURRENT_DATE", `DATE '${d}'`)}\n) AS x(${COLS}) ORDER BY 1`);
    const newRows = await rows<{ j: string }>(db,
      `SELECT to_jsonb(x)::text AS j FROM (${NEW_BODY}\n) AS x(${COLS})
        WHERE EXISTS (SELECT 1 FROM activity_open('not_running', (x.target->>'election_id')::int, x.target->>'election_type', DATE '${d}')) ORDER BY 1`);
    sizes.push(oldRows.length);
    if (JSON.stringify(oldRows) !== JSON.stringify(newRows)) return { ok: false, detail: `${d}：舊 ${oldRows.length} 列、新 ${newRows.length} 列`, sizes };
  }
  return { ok: true, detail: "", sizes };
}

Deno.test("B5 臂層端到端等價：真實的 not_running SQL 文字在合成資料上跑，舊（CURRENT_DATE 換成假日期）與新（不比日期＋規則過濾同一天）每個日期逐列相同", async () => {
  const db = await equivalenceDb();
  const r = await equivalence(db);
  assert(r.ok, r.detail);
  const at = (d: string) => r.sizes[equivDays.indexOf(d)];
  // 不是空對空：登記前 0 列；09-04 縣市長（pe 1、7 不算：withdrawn_after_filing 看不出來由別支臂派；13 已合併；4 已核對；6 登記後退選）剩 1、村里長 3 已有更正、鄉鎮市長 12 還原了的照問 → 2 列；
  // 縣市議員（pe 2）09-10 才起 → 3 列；2028 立法委員（pe 8）2027-12-01 起 → 4 列；各自投票日隔天關
  assertEquals(at("2026-09-03"), 0);
  assertEquals(at("2026-09-04"), 2);
  assertEquals(at("2026-09-10"), 3);
  assertEquals(at("2026-11-28"), 3);
  assertEquals(at("2026-11-29"), 0);
  assertEquals(at("2027-12-01"), 1);
  assertEquals(at("2028-01-15"), 1);
  assertEquals(at("2028-01-16"), 0);
  assertEquals(at("2030-01-01"), 0);
  await db.close();
});

// ---- 還原驗證：migration 文字改壞一處（精確改一處），對應的守門必須紅；有 migration 自己的檢查擋住的，要「整支失敗」 ----
const noGuard = (s: string) => s.slice(0, s.indexOf("\nDO $$"));
const MUTATIONS: { name: string; breaks: string[]; edit: (sql: string) => string; buildFails?: boolean; equivalenceFails?: boolean }[] = [
  { name: "起點偏移 0 改成 +1（登記截止當天還沒開）", breaks: ["window_edges_registration_close_and_polling_day", "opened_by_carries_rule_milestone_and_until", "rules_shape_and_untouched_rules", "seed_waits_for_window_and_closes_with_window_reason"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "from_kind = 'registration_close', from_offset = 0, until_kind", "from_kind = 'registration_close', from_offset = 1, until_kind") },
  { name: "起點偏移 0 改成 -1（登記截止前一天就開）", breaks: ["window_edges_registration_close_and_polling_day", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "from_kind = 'registration_close', from_offset = 0, until_kind", "from_kind = 'registration_close', from_offset = -1, until_kind") },
  { name: "迄點偏移 0 改成 -1（投票日當天已經關）", breaks: ["window_edges_registration_close_and_polling_day", "new_election_runs_its_own_window", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "until_kind = 'polling', until_offset = 0, min_status", "until_kind = 'polling', until_offset = -1, min_status") },
  { name: "迄點偏移 0 改成 +1（投票日隔天還開）", breaks: ["window_edges_registration_close_and_polling_day", "new_election_runs_its_own_window", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "until_kind = 'polling', until_offset = 0, min_status", "until_kind = 'polling', until_offset = 1, min_status") },
  { name: "不改規則（還是永遠開）：窗口外的列今天就露出來", breaks: ["today_hides_rows_outside_window", "window_edges_registration_close_and_polling_day", "old_elections_never_open_no_registration_milestone", "rules_shape_and_untouched_rules", "seed_waits_for_window_and_closes_with_window_reason"], equivalenceFails: true,
    edit: (s) => s.slice(0, s.indexOf("-- 2. 規則")) },
  { name: "拿掉迄點（登記截止起、沒有迄日）：投票日之後還開", breaks: ["window_edges_registration_close_and_polling_day", "new_election_runs_its_own_window", "rules_shape_and_untouched_rules", "seed_waits_for_window_and_closes_with_window_reason"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0, min_status", "from_kind = 'registration_close', from_offset = 0, until_kind = NULL, until_offset = 0, min_status") },
  { name: "拿掉起點（只有迄點）：登記截止之前就開", breaks: ["window_edges_registration_close_and_polling_day", "today_hides_rows_outside_window", "new_election_runs_its_own_window", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind", "window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind") },
  { name: "起點掛錯里程碑（名單公告日 list_published）", breaks: ["window_edges_registration_close_and_polling_day", "each_position_uses_its_own_registration_close", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "from_kind = 'registration_close', from_offset = 0, until_kind", "from_kind = 'list_published', from_offset = 0, until_kind") },
  { name: "min_status 改成 done：還沒發生的登記截止（2028）不開窗", breaks: ["new_election_runs_its_own_window", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "until_offset = 0, min_status = 'announced'", "until_offset = 0, min_status = 'done'") },
  { name: "限定職位（只開縣市長）：其他職位的缺口被濾掉", breaks: ["window_edges_registration_close_and_polling_day", "each_position_uses_its_own_registration_close", "new_election_runs_its_own_window", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "levels = NULL, election_types = NULL", "levels = NULL, election_types = ARRAY['縣市長']") },
  { name: "限定事由（只開 regular）", breaks: ["rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "recur_months = NULL, reasons = NULL", "recur_months = NULL, reasons = ARRAY['regular']") },
  { name: "改到別的活動（withdrawn_filing）：not_running 還是永遠開、withdrawn_filing 被改成窗口", breaks: ["today_hides_rows_outside_window", "window_edges_registration_close_and_polling_day", "other_arms_unaffected_on_every_day", "rules_shape_and_untouched_rules"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "WHERE activity = 'not_running'", "WHERE activity = 'withdrawn_filing'") },
  { name: "把停用（enabled=false）寫進規則：整類任務不派", breaks: ["window_edges_registration_close_and_polling_day", "rules_shape_and_untouched_rules", "seed_keeps_rows_inside_window_today"], equivalenceFails: true,
    edit: (s) => mutate(noGuard(s), "jurisdictions = NULL, enabled = true,", "jurisdictions = NULL, enabled = false,") },
  // migration 自己的檢查：規則不是預期的一條「登記截止 +0 起、投票日 +0 止」就整支失敗（寧可不上線）
  { name: "起點偏移 +1，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "from_kind = 'registration_close', from_offset = 0, until_kind", "from_kind = 'registration_close', from_offset = 1, until_kind") },
  { name: "迄點偏移 -1，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "until_kind = 'polling', until_offset = 0, min_status", "until_kind = 'polling', until_offset = -1, min_status") },
  { name: "拿掉迄點，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0, min_status", "from_kind = 'registration_close', from_offset = 0, until_kind = NULL, until_offset = 0, min_status") },
  { name: "min_status 改成 done，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "until_offset = 0, min_status = 'announced'", "until_offset = 0, min_status = 'done'") },
  { name: "改到別的活動，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "WHERE activity = 'not_running'", "WHERE activity = 'withdrawn_filing'") },
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
