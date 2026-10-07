/**
 * 派工與排程的啟用時間窗，P2「party_gap」（2026-10-08，docs/PLAN-task-activation.md；migration 20261008120000_activity_windows_p2_party_gap.sql）。
 *
 * 一支臂一個 PR：party_gap 臂內的「election_date < CURRENT_DATE」搬成規則「投票日 +1 起」（沒有迄日、範圍不限），跟 P2「選舉結果」同一個型。
 * 今天輸出必須逐件不變。只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. 文字層：party_gap 的新定義＝前一版（緊接在 P2 之前的那一版，與正式庫 pg_get_functiondef 一字不差）加一處機械式替換；P2 只改這一支臂、這一條規則
 *   B. PGlite（行為層）：臂本體換成 stub（回放表裡的列：新本體在正式庫上的輸出，含投票日之前的 2026 列），總表、規則、里程碑、seed 跑真的
 *        1. 今天（2026-10-08）的總表＝P1（只有舊本體的輸出、規則全是永遠開）逐件相同
 *        2. 假時鐘：2026-11-28 當天 2026 的列不開、11-29 開；舊選舉（2022、2024、重行選舉）各從自己的投票日 +1 起、之後一直開
 *        3. party_roster 與其他臂不受影響；opened_by 帶規則與里程碑；seed 在窗口開之前不建派工列、開了才建
 *        4. 每條守門都做還原驗證：把 P2 改壞一處（精確改一處，改不到就失敗），對應的守門必須紅；migration 自己的檢查也要擋得住
 *
 * 正式庫快照版的「逐件不變」見 scripts/arms-parity-p2.ts check party_gap <snapshot.json>（不進 CI：要唯讀快照；PR 說明附結果）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyP2, ARM_BRANCHES, armsFingerprint, buildArmsDb, fnText, type GapRow, latestFn, migrationNames, mutate, P2_ER_MIG, P2_PG_MIG, readMig } from "./arms-pglite.ts";

const P2 = await readMig(P2_PG_MIG);
// 依序套用所有已上線的 P2 migration（選舉結果 20261008070000 在前），測的是累積後的真實狀態；臂本體都換回 stub
const RESTUB = ["raw", "election_results", "party_gap"] as const;
const ACTIVITIES = ["party_gap"];
const ER_ACTIVITIES = ["election_results", "raw:election_result_missing"];

// ============================================================
// A. 文字層
// ============================================================
const NOTE = "\n      -- 投票日之後才派：移到規則（activity_rules「party_gap」：投票日 +1 起，P2 20261008120000）；這裡不再比日期";
const COND = "      JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE";
const NEW_FRAG = "      JOIN elections e ON e.id = pe.election_id" + NOTE;

const PREV = await latestFn("contribution_auto_tasks_party_gap", P2_PG_MIG);
const NEW = fnText(P2, "contribution_auto_tasks_party_gap");

/** 新定義倒推回前一版：把說明註解換回原本的日期條件。結構不對就丟錯 */
const isMechanical = (fn: string) => {
  try {
    return mutate(fn, NEW_FRAG, COND) === PREV;
  } catch {
    return false;
  }
};
const count = (s: string, sub: string) => s.split(sub).length - 1;

Deno.test("A1 前一版是對的：緊接在 P2 之前的 party_gap 定義是 20261006220000（與正式庫一字不差），中間沒有人插一版（插了，抄的底就過期）", async () => {
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_gap(")) defining.push(n);
  const i = defining.indexOf(P2_PG_MIG);
  assert(i > 0, "P2 要在重新定義 party_gap 的清單裡");
  assertEquals(defining[i - 1], "20261006220000_candidacy_read_side.sql", "前一版變了：那一版要以最新的為底重做機械式替換");
});

Deno.test("A2 party_gap 的新定義＝前一版加一處機械式替換，其餘一字不差", () => {
  assert(isMechanical(NEW));
  // 前一版確實有一處要拿掉的日期條件；新版不再比投票日
  assertEquals(count(PREV, COND), 1);
  assertEquals(count(NEW, "e.election_date < CURRENT_DATE"), 0, "party_gap 臂內不再比投票日");
  assertEquals(count(NEW, "election_date"), 0, "臂裡已經沒有任何一處用到 election_date");
  // 簽名、回傳型別、語言、穩定度不動
  assertEquals(NEW.split("\n").slice(0, 5).join("\n"), PREV.split("\n").slice(0, 5).join("\n"));
  // 其餘的過濾條件都還在（只拿掉日期那一條，沒有順手動別的）
  assert(NEW.includes("JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL"));
  assert(NEW.includes("WHERE pe.party_basis IS NULL"));
  assert(NEW.includes("JOIN LATERAL ("));
  assert(NEW.includes("AND c.payload->>'politician_id' = m.politician_id::TEXT AND c.payload->>'election_id' = m.election_id::TEXT"));
  // 名單公告日（candidate_status 的字眼）那一處用 CURRENT_DATE 的不是「這支臂何時開」，不在 P2 範圍、一字不動
  assert(NEW.includes("candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)"));
});

Deno.test("A3 P2 只動 party_gap 一支臂與它的規則：不重寫別的函式（含 party_roster）、不動表結構、不動總表與 seed", () => {
  const code = P2.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, ["contribution_auto_tasks_party_gap"]);
  assert(!/party_roster/.test(code), "party_roster 是下一個 PR");
  assert(!/DROP |ALTER TABLE|CREATE TABLE|INSERT INTO|DELETE FROM|TRUNCATE/i.test(code), "不建表、不刪東西、不新增規則（只把現有的一條原地改成窗口）");
  assertEquals(count(code, "UPDATE activity_rules"), 1, "只有一個 UPDATE");
  assert(code.includes("WHERE activity = 'party_gap'"), "UPDATE 只指名這個活動");
  assert(!/UPDATE (elections|election_milestones|task_dispatches|politician_elections)/i.test(code));
  assert(!/seed_auto_task_queue|contribution_auto_tasks_arms/.test(code), "不動總表與 seed");
  // 規則的形狀：投票日 +1 起、沒有迄日、不限範圍、預設 announced
  assert(code.includes("window_kind = 'event', from_kind = 'polling', from_offset = 1, until_kind = NULL, until_offset = 0, min_status = 'announced'"));
  assert(code.includes("reasons = NULL, levels = NULL, election_types = NULL, jurisdictions = NULL"));
});

Deno.test("A4 還原驗證（文字層）：動不該動的字、把日期條件放回去、少一處替換，A2 都要紅", () => {
  assert(!isMechanical(mutate(NEW, "WHERE pe.party_basis IS NULL", "WHERE pe.party_basis IS NOT NULL")), "偷改過濾");
  assert(!isMechanical(mutate(NEW, "JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL", "JOIN politicians p ON p.id = pe.politician_id")), "偷改合併人物的排除");
  assert(!isMechanical(NEW.replace(NOTE, "")), "把說明拿掉也不是原本的替換（說明註解是替換的一部分）");
  assert(!isMechanical(mutate(NEW, NEW_FRAG, COND + " AND true")), "日期條件放回去又多加一條");
  assert(!isMechanical(mutate(NEW, "'auto:candidacy_source_missing:party:' || x.pe_id", "'auto:candidacy_source_missing:party2:' || x.pe_id")), "偷改 task_id 形狀");
  assert(!isMechanical(PREV), "前一版本身不是「新的」（還有日期條件）");
});

// ============================================================
// B. PGlite（行為層）
// ============================================================
const G = (id: string, type: string, target: Record<string, unknown> | null = null, region: string | null = "台北市"): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h1"], reward: 1, region });
const E = (election_id: number | null, election_type?: string | null, extra: Record<string, unknown> = {}) => ({ ...(election_id === null ? {} : { election_id }), ...(election_type === undefined ? {} : { election_type }), ...extra });
const P = (pe: number, election_id: number, election_type: string, kind = "party") =>
  G(`candidacy_source_missing:party:${pe}`, "candidacy_source_missing", E(election_id, election_type, { kind, politician_election_id: pe }));

// 窗口還沒到的列（投票日之前的 2026）：舊本體不會輸出、新本體會輸出，由總表依規則濾掉
const GATED = [P(301, 2026, "縣市長"), P(302, 2026, "縣市議員"), P(303, 2026, "村里長")];
const GATED_IDS = GATED.map((r) => r.task_id).sort();

const BASE = [
  P(101, 2022, "縣市長"),
  P(102, 2024, "立法委員"),
  P(103, 4, "縣市長"), // 2022-12-18 嘉義市長重行選舉
  P(104, 2022, "村里長"),
];
const OTHERS: Partial<Record<(typeof ARM_BRANCHES)[number], GapRow[]>> = {
  // party_roster 這個 PR 不動：它還在臂內自己比日期，輸出（stub）照舊；規則維持永遠開
  party_roster: [P(401, 2026, "縣市長", "party_roster"), P(402, 2026, "縣市議員", "party_roster")],
  party_info: [G("party_info1", "party_info_missing", E(2026))],
  dup: [G("dup1", "duplicate_politician", null)],
  term_policies: [G("tp26", "term_policy_missing", E(2026, "縣市長"))],
  raw: [G("candidacy_source_missing:77", "candidacy_source_missing", E(2026, "縣市長"))],
};
/** 舊本體在 2026-10-08 的輸出（P1 的世界：沒有投票日之前的列） */
const OLD_BRANCHES = { ...OTHERS, party_gap: BASE };
/** 新本體的輸出：多出投票日之前的 2026 列 */
const NEW_BRANCHES = { ...OTHERS, party_gap: [...BASE, ...GATED] };
const ALL_IDS = Object.values(NEW_BRANCHES).flat().map((r) => r!.task_id).sort();
const TODAY_IDS = ALL_IDS.filter((i) => !GATED_IDS.includes(i));
/** 舊本體在這支臂的輸出（今天、以及之後一直該開的） */
const OLD_P2_IDS = BASE.map((r) => r.task_id);
const P2_ARMS_SQL = `arm = 'party_gap'`;

const buildP2 = (mutateP2?: (s: string) => string) => buildArmsDb({ branches: NEW_BRANCHES, p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG, mutate: mutateP2 }], restub: RESTUB } });

type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];
const ids = async (db: Db, where = "true") => (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_arms() WHERE ${where} ORDER BY task_id COLLATE "C"`)).map((r) => r.task_id);
const clock = (db: Db, day: string) => db.exec(`SET app.activity_today = '${day}'`);
const sameIds = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

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
  const p2ids = (day: string) => clock(db, day).then(() => ids(db, P2_ARMS_SQL));
  const e2026 = (xs: string[]) => xs.filter((i) => GATED_IDS.includes(i));

  // ---- 1. 今天輸出逐件不變 ----
  await g("today_hides_pre_polling_rows", async () => {
    await clock(db, "2026-10-08");
    // 新本體多算的 2026 列被規則濾掉：今天的總表＝舊本體世界的清單（手算）
    return sameIds(await ids(db), TODAY_IDS) && (await ids(db)).length === ALL_IDS.length - GATED_IDS.length;
  });

  // ---- 2. 假時鐘：投票日當天不開、隔天開；舊選舉照常 ----
  await g("polling_day_closed_next_day_open", async () => {
    const d27 = e2026(await p2ids("2026-11-27"));
    const d28 = e2026(await p2ids("2026-11-28"));
    const d29 = e2026(await p2ids("2026-11-29"));
    const d30 = e2026(await p2ids("2026-11-30"));
    return d27.length === 0 && d28.length === 0 && sameIds(d29, GATED_IDS) && sameIds(d30, GATED_IDS);
  });
  await g("old_elections_each_from_their_own_polling_plus_one", async () => {
    const at = async (day: string) => (await p2ids(day)).filter((i) => !GATED_IDS.includes(i));
    const oldIds = {
      e2022: ["auto:candidacy_source_missing:party:101", "auto:candidacy_source_missing:party:104"],
      e4: ["auto:candidacy_source_missing:party:103"],
      e2024: ["auto:candidacy_source_missing:party:102"],
    };
    // 2022-11-26 投票日當天：什麼都還沒開；11-27 起 2022 開；重行選舉 2022-12-18 當天關、12-19 開；2024-01-13 當天關、01-14 開
    return (await at("2022-11-26")).length === 0 &&
      sameIds(await at("2022-11-27"), oldIds.e2022) &&
      sameIds(await at("2022-12-18"), oldIds.e2022) &&
      sameIds(await at("2022-12-19"), [...oldIds.e2022, ...oldIds.e4]) &&
      sameIds(await at("2024-01-13"), [...oldIds.e2022, ...oldIds.e4]) &&
      sameIds(await at("2024-01-14"), [...oldIds.e2022, ...oldIds.e4, ...oldIds.e2024]);
  });
  await g("old_elections_stay_open_long_after", async () => {
    // 沒有迄日：缺政黨的缺口一直派到補上為止（2027、2030 都照開）
    return sameIds(await p2ids("2027-06-01"), [...OLD_P2_IDS, ...GATED_IDS]) && sameIds(await p2ids("2030-01-01"), [...OLD_P2_IDS, ...GATED_IDS]);
  });

  // ---- 3. 其他臂不受影響 ----
  await g("party_roster_and_other_arms_unaffected", async () => {
    const others = TODAY_IDS.filter((i) => !OLD_P2_IDS.includes(i));
    // 窗口外（2026-11-28）：party_roster（2026 的列）、raw 的 candidacy_source_missing、別的臂都還在
    await clock(db, "2026-11-28");
    const got = await ids(db, `NOT (${P2_ARMS_SQL})`);
    // 投票日之前（2022-01-01）也一樣：這些臂的規則是永遠開
    await clock(db, "2022-01-01");
    const early = await ids(db, `NOT (${P2_ARMS_SQL})`);
    return sameIds(got, others) && sameIds(early, others) && got.includes("auto:candidacy_source_missing:party:401");
  });
  await g("rules_shape_and_untouched_rules", async () => {
    const r = await rows<{ activity: string; window_kind: string; from_kind: string | null; from_offset: number; until_kind: string | null; min_status: string; enabled: boolean; scoped: boolean }>(db,
      `SELECT activity, window_kind, from_kind, from_offset::int, until_kind, min_status, enabled,
              (reasons IS NOT NULL OR levels IS NOT NULL OR election_types IS NOT NULL OR jurisdictions IS NOT NULL) AS scoped FROM activity_rules ORDER BY activity`);
    const p2 = r.filter((x) => ACTIVITIES.includes(x.activity));
    // 已上線的選舉結果那兩條（P2 20261008070000）：同一形狀「投票日 +1 起、無迄日」，這個 PR 不碰；其餘 33 條仍是永遠開
    const er = r.filter((x) => ER_ACTIVITIES.includes(x.activity));
    const rest = r.filter((x) => !ACTIVITIES.includes(x.activity) && !ER_ACTIVITIES.includes(x.activity));
    return r.length === 36 && p2.length === 1 && p2.every((x) => x.window_kind === "event" && x.from_kind === "polling" && x.from_offset === 1 && x.until_kind === null && x.min_status === "announced" && x.enabled && !x.scoped) &&
      er.length === 2 && er.every((x) => x.window_kind === "event" && x.from_kind === "polling" && x.from_offset === 1 && x.until_kind === null && x.enabled) &&
      rest.length === 33 && rest.every((x) => x.window_kind === "always" && x.enabled && x.from_kind === null) && rest.some((x) => x.activity === "party_roster");
  });
  await g("health_empty", async () => (await rows(db, `SELECT * FROM activity_health`)).length === 0);

  // ---- 4. opened_by 帶規則與里程碑 ----
  await g("opened_by_carries_rule_and_polling", async () => {
    await clock(db, "2026-11-29");
    const x = await rows<{ task_id: string; arm: string; ob: Record<string, unknown> }>(db, `SELECT task_id, arm, opened_by AS ob FROM contribution_auto_tasks_arms() WHERE task_id = ANY ($1) AND arm = 'party_gap' ORDER BY task_id`, [GATED_IDS]);
    const rid = (await one<{ id: number }>(db, `SELECT id::int AS id FROM activity_rules WHERE activity = 'party_gap'`)).id;
    return x.length === GATED_IDS.length && x.every((r) => r.ob.basis === "rule" && r.ob.rule_id === rid && r.ob.election_id === 2026 && r.ob.milestone_kind === "polling" &&
      r.ob.milestone_on_date === "2026-11-28" && r.ob.expected_open_on === "2026-11-29");
  });

  // ---- 5. seed：窗口開之前不建派工列、開了才建 ----
  await g("seed_waits_for_window", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-11-28");
    await db.exec(`SELECT seed_auto_task_queue()`);
    const before = await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id = ANY ($1)`, [GATED_IDS]);
    await clock(db, "2026-11-29");
    await db.exec(`SELECT seed_auto_task_queue()`);
    const after = await rows<{ task_id: string; ob: Record<string, unknown> }>(db, `SELECT task_id, opened_by AS ob FROM task_dispatches WHERE task_id = ANY ($1)`, [GATED_IDS]);
    const ev = await rows<{ event: string; ex: string }>(db, `SELECT event, detail->>'expected_open_on' AS ex FROM gap_events WHERE task_id = ANY ($1)`, [GATED_IDS]);
    return before.length === 0 && sameIds(after.map((r) => r.task_id), GATED_IDS) && after.every((r) => r.ob.expected_open_on === "2026-11-29") &&
      ev.length === GATED_IDS.length && ev.every((e) => e.event === "opened" && e.ex === "2026-11-29");
  });
  await g("seed_keeps_old_election_rows", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-10-08");
    await db.exec(`SELECT seed_auto_task_queue()`);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'auto:%'`);
    return n.n === TODAY_IDS.length;
  });

  // ---- 6. 重跑 ----
  await g("rerunnable", async () => {
    await clock(db, "2026-10-08");
    const before = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await applyP2(db, await readMig(P2_PG_MIG), RESTUB);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_rules`);
    const after = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await db.exec("RESET app.activity_today"); // 時鐘被覆寫時 activity_health 會列 clock_overridden
    return before.h === after.h && before.n === after.n && n.n === 36 && (await rows(db, `SELECT * FROM activity_health`)).length === 0;
  });
  return v;
}

const ALL_GUARDS = [
  "today_hides_pre_polling_rows", "polling_day_closed_next_day_open", "old_elections_each_from_their_own_polling_plus_one", "old_elections_stay_open_long_after",
  "party_roster_and_other_arms_unaffected", "rules_shape_and_untouched_rules", "health_empty", "opened_by_carries_rule_and_polling",
  "seed_waits_for_window", "seed_keeps_old_election_rows", "rerunnable",
];

Deno.test("B1 P2 在 PGlite 上整支跑得動；全部守門都綠（今天不變、投票日當天不開隔天開、舊選舉照常、其他臂不受影響、seed 等窗口）", async () => {
  const db = await buildP2();
  const v = await runSuite(db);
  const red = ALL_GUARDS.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...ALL_GUARDS].sort(), "守門清單與實際跑的要一致");
  await db.close();
});

Deno.test("B2 今天的總表＝P1（舊本體輸出、規則全是永遠開）逐件相同：筆數與全欄雜湊；規則 id 沒變（原地改成窗口）", async () => {
  const oldDb = await buildArmsDb({ branches: OLD_BRANCHES }); // 只到 P1
  const newDb = await buildP2();
  await clock(oldDb, "2026-10-08");
  await clock(newDb, "2026-10-08");
  const a = await armsFingerprint(oldDb, "contribution_auto_tasks_arms");
  const b = await armsFingerprint(newDb, "contribution_auto_tasks_arms");
  assertEquals(b, a);
  assert(a.h !== null && a.n === TODAY_IDS.length);
  const idsOf = async (db: Db) => (await rows<{ activity: string; id: number }>(db, `SELECT activity, id::int FROM activity_rules ORDER BY activity`)).map((r) => `${r.activity}#${r.id}`);
  assertEquals(await idsOf(newDb), await idsOf(oldDb), "規則 id 不變（原地 UPDATE，不是刪了重種）");
  // 沒套 P2、新本體的輸出照樣露出來：證明「濾掉 2026 的列」是規則在做事，不是 stub 本來就少
  const noRule = await buildArmsDb({ branches: NEW_BRANCHES });
  await clock(noRule, "2026-10-08");
  assertEquals((await armsFingerprint(noRule, "contribution_auto_tasks_arms")).n, ALL_IDS.length);
  await oldDb.close();
  await newDb.close();
  await noRule.close();
});

// ---- 還原驗證：P2 migration 文字改壞一處（精確改一處），對應的守門必須紅；有 migration 自己的檢查擋住的，要「整支失敗」 ----
const noGuard = (s: string) => s.slice(0, s.indexOf("\nDO $$"));
const RULE_FRAG = "from_offset = 1, until_kind = NULL, until_offset = 0";
const MUTATIONS: { name: string; breaks: string[]; edit: (sql: string) => string; buildFails?: boolean }[] = [
  { name: "偏移 +1 改成 0（投票日當天就開）", breaks: ["polling_day_closed_next_day_open", "old_elections_each_from_their_own_polling_plus_one", "opened_by_carries_rule_and_polling", "rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "from_offset = 1, until_kind = NULL", "from_offset = 0, until_kind = NULL") },
  { name: "偏移 +1 改成 +2", breaks: ["polling_day_closed_next_day_open", "old_elections_each_from_their_own_polling_plus_one", "opened_by_carries_rule_and_polling", "rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "from_offset = 1, until_kind = NULL", "from_offset = 2, until_kind = NULL") },
  { name: "不改規則（還是永遠開）：2026 的列今天就露出來", breaks: ["today_hides_pre_polling_rows", "polling_day_closed_next_day_open", "rules_shape_and_untouched_rules", "seed_waits_for_window"],
    edit: (s) => s.slice(0, s.indexOf("-- 2. 規則")) },
  { name: "加迄日（投票日 +30）：舊選舉很快就關", breaks: ["old_elections_stay_open_long_after", "today_hides_pre_polling_rows", "seed_keeps_old_election_rows", "rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), RULE_FRAG, "from_offset = 1, until_kind = 'polling', until_offset = 30") },
  { name: "限定事由（只開 regular）：重行選舉的缺口被濾掉", breaks: ["old_elections_each_from_their_own_polling_plus_one", "today_hides_pre_polling_rows", "rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "recur_months = NULL, reasons = NULL", "recur_months = NULL, reasons = ARRAY['regular']") },
  { name: "限定職位（只開縣市長）：其他職位的缺口被濾掉", breaks: ["old_elections_each_from_their_own_polling_plus_one", "today_hides_pre_polling_rows", "rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "levels = NULL, election_types = NULL", "levels = NULL, election_types = ARRAY['縣市長']") },
  { name: "改到別的活動（party_roster）：party_gap 還是永遠開、party_roster 被改成窗口", breaks: ["today_hides_pre_polling_rows", "polling_day_closed_next_day_open", "party_roster_and_other_arms_unaffected", "rules_shape_and_untouched_rules", "seed_waits_for_window"],
    edit: (s) => mutate(noGuard(s), "WHERE activity = 'party_gap'", "WHERE activity = 'party_roster'") },
  { name: "把停用（enabled=false）寫進規則：整類任務不派", breaks: ["old_elections_stay_open_long_after", "today_hides_pre_polling_rows", "rules_shape_and_untouched_rules", "seed_keeps_old_election_rows"],
    edit: (s) => mutate(noGuard(s), "jurisdictions = NULL, enabled = true,", "jurisdictions = NULL, enabled = false,") },
  { name: "規則改成「迄日」型（只有迄點、沒有起點）", breaks: ["polling_day_closed_next_day_open", "rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "from_kind = 'polling', from_offset = 1, until_kind = NULL, until_offset = 0", "from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0") },
  // migration 自己的檢查：規則不是預期的一條「投票日 +1 起」就整支失敗（寧可不上線）
  { name: "偏移 +1 改成 0，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "from_offset = 1, until_kind = NULL", "from_offset = 0, until_kind = NULL") },
  { name: "加迄日，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, RULE_FRAG, "from_offset = 1, until_kind = 'polling', until_offset = 30") },
  { name: "改到別的活動，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "WHERE activity = 'party_gap'", "WHERE activity = 'party_roster'") },
];

for (const m of MUTATIONS) {
  Deno.test(`B3 還原驗證：${m.name} → ${m.buildFails ? "migration 本身要失敗" : m.breaks.join("、") + " 必須紅"}`, async () => {
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
  });
}
