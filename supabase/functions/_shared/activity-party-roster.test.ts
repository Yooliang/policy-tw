/**
 * 派工與排程的啟用時間窗，P2「party_roster」（2026-10-08，docs/PLAN-task-activation.md；migration 20261008121000_activity_windows_p2_party_roster.sql）。
 *
 * 第一支「有迄日」的臂：臂內的「election_date >= CURRENT_DATE」搬成只有迄點的規則（到投票日當天為止，含當天；隔天關）；同一支 migration 讓 seed 分得出
 * 收回原因是 window（臂還算得出來、規則的窗口關了）還是 filled（臂已經算不出來）。今天輸出必須逐件不變。只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. 文字層：party_roster 新定義＝前一版加一處機械式替換；總表＝P1 的現行定義加四處機械式替換（多回傳被濾掉的列）；seed＝P1 的現行定義加兩處機械式插入；這支只動這三支函式與一條規則
 *   B. PGlite（行為層）：臂本體換成 stub（回放表裡的列），總表、規則、里程碑、seed、觸發器跑真的
 *        1. 今天（2026-10-08）的總表＝P1（舊本體輸出、規則全是永遠開）逐件相同
 *        2. 假時鐘：2026-11-28 開、11-29 關；舊選舉各到自己的投票日當天為止；與 party_gap（上一個 PR）的窗口在每個邊界日都「剛好一邊開著」
 *        3. 總表預設只回開著的列；旗標 gap.arms_all＝on 時多回傳被濾掉的列（opened_by 是 NULL）；seed 用完旗標就清掉
 *        4. seed：窗口關了的缺口收回記 window、臂已算不出來的記 filled、被 party_gap 接手的不收回；貢獻 applied 的收回仍記 filled；窗口重開記 reopened
 *        5. 每條守門都做還原驗證：把這支 migration 改壞一處（精確改一處，改不到就失敗），對應的守門必須紅；migration 自己的檢查也要擋得住
 *
 * 正式庫快照版的「逐件不變」見 scripts/arms-parity-p2.ts party_roster（不進 CI：要唯讀快照；PR 說明附結果）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyP2, armsFingerprint, buildArmsDb, fnText, type GapRow, latestFn, migrationNames, mutate, P1_MIG, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";

const PH_MIG = "20261008114000_placeholder_task_isolation.sql"; // 測試名人物隔離 #448：總表的現行版
const PH = await readMig(PH_MIG);
const QP_MIG = "20261008090000_queue_priority_tiers.sql"; // 佇列優先層 #443：seed 的現行版
const QP = await readMig(QP_MIG);
const P2 = await readMig(P2_PR_MIG);
// 依序套用所有已上線的 P2 migration（選舉結果 20261008070000、party_gap 20261008120000 在前），測的是累積後的真實狀態；臂本體都換回 stub
const RESTUB = ["raw", "election_results", "party_gap", "party_roster"] as const;

// ============================================================
// A. 文字層
// ============================================================
// ---- party_roster：前一版加一處機械式替換 ----
const R_NOTE = "\n      -- 投票日當天之前才派：移到規則（activity_rules「party_roster」：到投票日 +0 為止，P2 20261008121000）；這裡不再比日期";
const R_COND = "      JOIN elections e ON e.id = pe.election_id AND e.election_date >= CURRENT_DATE";
const R_NEW_FRAG = "      JOIN elections e ON e.id = pe.election_id" + R_NOTE;
const PREV_ROSTER = await latestFn("contribution_auto_tasks_party_roster", P2_PR_MIG);
const NEW_ROSTER = fnText(P2, "contribution_auto_tasks_party_roster");
const isMechanicalRoster = (fn: string) => {
  try {
    return mutate(fn, R_NEW_FRAG, R_COND) === PREV_ROSTER;
  } catch {
    return false;
  }
};
const count = (s: string, sub: string) => s.split(sub).length - 1;

// ---- 總表：測試名人物隔離（#448）的現行定義加機械式替換 ----
const PH_ARMS = fnText(PH, "contribution_auto_tasks_arms");
const NEW_ARMS = fnText(P2, "contribution_auto_tasks_arms");
const A_SEL_OLD = "o.milestone_on_date, o.expected_open_on\n";
const A_SEL_NEW = "o.milestone_on_date, o.expected_open_on, o.open_until\n";
const A_JOIN_OLD = "    CROSS JOIN LATERAL (\n";
const A_JOIN_NEW = "    LEFT JOIN LATERAL (  -- LEFT：窗口關著的組也留下來（o.source 是 NULL），旗標 gap.arms_all 開著時 seed 要看它們\n";
const A_ON_OLD = "    ) o\n       )\n";
const A_ON_NEW = "    ) o ON true\n       )\n";
const A_BY_OLD = "         jsonb_strip_nulls(jsonb_build_object(\n";
const A_BY_NEW = "         CASE WHEN o.source IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(\n";
const A_BY_END_OLD = "'expected_open_on', o.expected_open_on)) AS opened_by\n";
const A_BY_END_NEW = "'expected_open_on', o.expected_open_on, 'open_until', o.open_until)) END AS opened_by\n";
const A_WHERE_OLD = "   WHERE g.arm = 'placeholder_politicians'\n      OR NOT (EXISTS";
const A_WHERE = "   WHERE (o.source IS NOT NULL OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算\n     AND (g.arm = 'placeholder_politicians'\n      OR NOT (EXISTS";
const A_CLOSE_OLD = "g.target->>'politician_election_id' = phe.peid::TEXT))\n$$;";
const A_CLOSE_NEW = "g.target->>'politician_election_id' = phe.peid::TEXT)))\n$$;";
/** 新總表倒推回 P1 的總表。結構不對就丟錯 */
function reverseArms(fn: string): string {
  let s = fn;
  s = mutate(s, A_SEL_NEW, A_SEL_OLD);
  s = mutate(s, A_JOIN_NEW, A_JOIN_OLD);
  s = mutate(s, A_ON_NEW, A_ON_OLD);
  s = mutate(s, A_BY_NEW, A_BY_OLD);
  s = mutate(s, A_BY_END_NEW, A_BY_END_OLD);
  s = mutate(s, A_WHERE, A_WHERE_OLD);
  s = mutate(s, A_CLOSE_NEW, A_CLOSE_OLD);
  return s;
}
const isMechanicalArms = (fn: string) => {
  try {
    return reverseArms(fn) === PH_ARMS;
  } catch {
    return false;
  }
};

// ---- seed：優先層（#443，20261008090000）的現行定義加兩處機械式插入 ----
const BASE_SEED = fnText(QP, "seed_auto_task_queue");
const NEW_SEED = fnText(P2, "seed_auto_task_queue");
const S_BLOCK1_START = "  -- >>> gap_events window／filled：";
const S_BLOCK1_END = "  -- <<< gap_events window／filled\n  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id;\n";
const S_OLD1 = "  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM contribution_auto_tasks_arms() g ORDER BY g.task_id;\n";
const S_BLOCK2_START = "\n  -- >>> gap_events window：";
const S_BLOCK2_END = "  -- <<< gap_events window\n\n  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）\n";
const S_OLD2 = "\n  -- 已經不存在的缺口（補上了）：收回號碼牌\n";
/** 新 seed 倒推回 P1 的 seed：兩段插入各自換回原文。結構不對就丟錯 */
function reverseSeed(fn: string): string {
  let s = fn;
  const a1 = s.indexOf(S_BLOCK1_START);
  const b1 = s.indexOf(S_BLOCK1_END);
  assert(a1 >= 0 && b1 > a1, "第一段插入的起迄標記要在");
  s = s.slice(0, a1) + S_OLD1 + s.slice(b1 + S_BLOCK1_END.length);
  const a2 = s.indexOf(S_BLOCK2_START);
  const b2 = s.indexOf(S_BLOCK2_END);
  assert(a2 >= 0 && b2 > a2, "第二段插入的起迄標記要在");
  s = s.slice(0, a2) + S_OLD2 + s.slice(b2 + S_BLOCK2_END.length);
  return s;
}
const isMechanicalSeed = (fn: string) => {
  try {
    return reverseSeed(fn) === BASE_SEED;
  } catch {
    return false;
  }
};

Deno.test("A1 前一版是對的：party_roster 緊接著 20261006220000、總表緊接著 #448、seed 緊接著優先層（中間沒有人插一版，抄的底就過期）", async () => {
  for (const [fn, sig, base] of [
    ["contribution_auto_tasks_party_roster", "(", "20261006220000_candidacy_read_side.sql"],
    ["contribution_auto_tasks_arms", "(", PH_MIG],
    ["seed_auto_task_queue", "(", QP_MIG],
  ]) {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}${sig}`)) defining.push(n);
    const i = defining.indexOf(P2_PR_MIG);
    assert(i > 0, `這支 migration 要在重新定義 ${fn} 的清單裡`);
    assertEquals(defining[i - 1], base, `${fn} 的前一版應該是 ${base}；有人在中間改了，要以那一版為底重做機械式替換`);
  }
});

Deno.test("A2 party_roster 新定義＝前一版加一處機械式替換，其餘一字不差", () => {
  assert(isMechanicalRoster(NEW_ROSTER));
  assertEquals(count(PREV_ROSTER, R_COND), 1);
  assertEquals(count(NEW_ROSTER, "election_date"), 0, "臂裡已經沒有任何一處用到 election_date");
  assertEquals(NEW_ROSTER.split("\n").slice(0, 3).join("\n"), PREV_ROSTER.split("\n").slice(0, 3).join("\n"), "簽名、語言不動");
  assert(NEW_ROSTER.includes("WHERE pe.party_basis IS NULL AND pe.candidacy_status = 'filed'"), "已登記、缺政黨的過濾還在");
  assert(NEW_ROSTER.includes("JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL"));
  assert(NEW_ROSTER.includes("'kind', 'party_roster'"));
  assert(NEW_ROSTER.includes("candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)"), "名單公告日那一處不是「這支臂何時開」，不動");
});

Deno.test("A3 總表新定義＝P1 的現行定義加四處機械式替換；28 個分支與臂名標籤一個都沒動", () => {
  assert(isMechanicalArms(NEW_ARMS));
  assertEquals(reverseArms(NEW_ARMS), PH_ARMS);
  // 簽名與回傳型別不動（同簽名同型別：CREATE OR REPLACE，不用 DROP）
  assertEquals(NEW_ARMS.split("\n").slice(0, 3).join("\n"), PH_ARMS.split("\n").slice(0, 3).join("\n"));
  const tags = (s: string) => [...s.matchAll(/SELECT '([a-z_]+)' AS arm, t\.\*/g)].map((m) => m[1]);
  assertEquals(tags(NEW_ARMS), tags(PH_ARMS));
  assertEquals(tags(NEW_ARMS).length, 27);
  // 預設（沒設旗標）仍然濾掉沒開窗的列：WHERE 在、而且是 InitPlan（不是每列呼叫 current_setting）
  assert(NEW_ARMS.includes(A_WHERE));
  assert(NEW_ARMS.includes("ph AS MATERIALIZED") && NEW_ARMS.includes("phe AS MATERIALIZED"), "#448 的測試名人物過濾（兩個 MATERIALIZED CTE）一字不動");
  assert(NEW_ARMS.includes("activity_require_rule(x.arm)"), "沒有規則的臂照樣 RAISE");
  assertEquals(count(NEW_ARMS, "current_setting('gap.arms_all'"), 1, "旗標只在 WHERE 裡讀一次");
});

Deno.test("A4 seed 新定義＝P1 的現行定義加兩處機械式插入；窗口收回在原本的收回之前、原本那一段 DELETE 一字不動", () => {
  assert(isMechanicalSeed(NEW_SEED));
  assertEquals(reverseSeed(NEW_SEED), BASE_SEED);
  assert(!/INSERT INTO gap_events/.test(NEW_SEED), "事件由 task_dispatches 的觸發器寫，seed 裡不直接寫 gap_events");
  // window 那段先設原因、刪、清掉；順序：設 → 刪 → 清，而且都在原本的收回之前
  const iSet = NEW_SEED.indexOf("PERFORM set_config('gap.close_reason', 'window', true);");
  const iDel = NEW_SEED.indexOf("AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);");
  const iClear = NEW_SEED.indexOf("PERFORM set_config('gap.close_reason', '', true);");
  const iFilled = NEW_SEED.indexOf("-- 已經不存在的缺口（補上了）：收回號碼牌（");
  assert(iSet > 0 && iSet < iDel && iDel < iClear && iClear < iFilled);
  // 旗標開了馬上關
  const iOn = NEW_SEED.indexOf("set_config('gap.arms_all', 'on', true)");
  const iOff = NEW_SEED.indexOf("set_config('gap.arms_all', '', true)");
  assert(iOn > 0 && iOn < NEW_SEED.indexOf("CREATE TEMP TABLE _gaps_all") && NEW_SEED.indexOf("CREATE TEMP TABLE _gaps_all") < iOff);
});

Deno.test("A5 這支只動三支函式與一條規則：party_roster、總表、seed；不建表、不刪東西、不新增規則、不動別的函式（含 party_gap）", () => {
  const code = P2.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, ["contribution_auto_tasks_arms", "contribution_auto_tasks_party_roster", "seed_auto_task_queue"]);
  assert(!/DROP FUNCTION|ALTER TABLE|CREATE TABLE(?! ON)|INSERT INTO activity_rules|DELETE FROM activity_rules|TRUNCATE/i.test(code.replace(/CREATE TEMP TABLE _gaps(_all)? ON COMMIT DROP/g, "").replace(/ALTER TABLE _gaps ADD COLUMN[^;]*;/g, "") /* 暫存表與優先層（#443）在 seed 裡加的欄位 */), "不建表、不新增規則");
  assertEquals(count(code, "UPDATE activity_rules"), 1, "只有一個 UPDATE");
  assert(code.includes("WHERE activity = 'party_roster'"), "UPDATE 只指名這個活動");
  assert(!/UPDATE (elections|election_milestones|politician_elections)/i.test(code));
  assert(!/FUNCTION contribution_auto_tasks_party_gap/.test(code), "party_gap 是上一個 PR，這支不碰");
  // 規則的形狀：沒有起點、迄點投票日 +0、不限範圍、預設 announced
  assert(code.includes("window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0, min_status = 'announced'"));
  assert(code.includes("reasons = NULL, levels = NULL, election_types = NULL, jurisdictions = NULL"));
});

Deno.test("A6 還原驗證（文字層）：動不該動的字、少一處替換、多一處，A2～A4 都要紅", () => {
  assert(!isMechanicalRoster(mutate(NEW_ROSTER, "WHERE pe.party_basis IS NULL AND pe.candidacy_status = 'filed'", "WHERE pe.party_basis IS NULL")), "偷改 party_roster 的過濾");
  assert(!isMechanicalRoster(NEW_ROSTER.replace(R_NOTE, "")), "把說明拿掉也不是原本的替換");
  assert(!isMechanicalRoster(PREV_ROSTER), "前一版本身不是「新的」");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "activity_require_rule(x.arm)", "true")), "偷拿掉沒有規則就 RAISE");
  assert(!isMechanicalArms(NEW_ARMS.replace(A_WHERE, A_WHERE_OLD)), "拿掉預設濾掉的 WHERE");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "ph AS MATERIALIZED", "ph AS")), "偷改 #448 的 MATERIALIZED（拿掉會撞 statement timeout）");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "UNION ALL SELECT 'party_info' AS arm", "UNION ALL SELECT 'party_info2' AS arm")), "偷改臂名標籤");
  assert(!isMechanicalArms(PH_ARMS), "#448 的總表本身不是「新的」");
  // 插入的兩段（起迄標記之間）整段換回原文，所以段內的內容由 B 的行為守門與還原驗證守；段外一個字都不能動
  assert(!isMechanicalSeed(mutate(NEW_SEED, "WHERE d.task_id LIKE 'verify:%'", "WHERE d.task_id LIKE 'verify2:%'")), "偷改段外的驗證列收回");
  assert(!isMechanicalSeed(mutate(NEW_SEED, "ON CONFLICT (task_id) DO NOTHING;\n  GET DIAGNOSTICS v_new", "ON CONFLICT (task_id) DO UPDATE SET task_id = excluded.task_id;\n  GET DIAGNOSTICS v_new")), "偷改後面不相干的地方");
  assert(!isMechanicalSeed(BASE_SEED), "優先層（#443）那版 seed 本身不是「新的」");
});

// ============================================================
// B. PGlite（行為層）
// ============================================================
const G = (id: string, type: string, target: Record<string, unknown> | null = null, region: string | null = "台北市"): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h1"], reward: 1, region });
const E = (election_id: number | null, election_type?: string | null, extra: Record<string, unknown> = {}) => ({ ...(election_id === null ? {} : { election_id }), ...(election_type === undefined ? {} : { election_type }), ...extra });
const P = (pe: number, election_id: number, election_type: string, kind: string) =>
  G(`candidacy_source_missing:party:${pe}`, "candidacy_source_missing", E(election_id, election_type, { kind, politician_election_id: pe }));
const R = (pe: number, eid: number, type: string) => P(pe, eid, type, "party_roster");
const Gp = (pe: number, eid: number, type: string) => P(pe, eid, type, "party");
const tid = (pe: number) => `auto:candidacy_source_missing:party:${pe}`;

// 舊本體（今天）：party_roster 只有還沒投票的 2026；party_gap 只有已投票的屆別
const ROSTER_2026 = [R(401, 2026, "縣市長"), R(402, 2026, "縣市議員"), R(403, 2026, "村里長")];
const GAP_PAST = [Gp(501, 2022, "縣市長"), Gp(502, 2024, "立法委員"), Gp(503, 4, "縣市長"), Gp(504, 2022, "村里長")];
// 新本體多出來的：party_roster 也算已投票屆別（由規則濾掉）；party_gap 也算 2026（上一個 PR，由規則濾掉；401 中選會名冊對得到）
const ROSTER_PAST = [R(501, 2022, "縣市長"), R(502, 2024, "立法委員"), R(503, 4, "縣市長")];
const GAP_2026 = [Gp(401, 2026, "縣市長")];
const OTHERS = {
  party_info: [G("party_info1", "party_info_missing", E(2026))],
  dup: [G("dup1", "duplicate_politician", null)],
  term_policies: [G("tp26", "term_policy_missing", E(2026, "縣市長"))],
  raw: [G("candidacy_source_missing:77", "candidacy_source_missing", E(2026, "縣市長"))],
};
const OLD_BRANCHES = { ...OTHERS, party_gap: GAP_PAST, party_roster: ROSTER_2026 };
const NEW_BRANCHES = { ...OTHERS, party_gap: [...GAP_PAST, ...GAP_2026], party_roster: [...ROSTER_2026, ...ROSTER_PAST] };
const OTHER_IDS = Object.values(OTHERS).flat().map((r) => r.task_id);
/** 今天（舊本體世界）的總表 task_id（重複的 task_id 各算一次：總表本來就不去重） */
const TODAY_IDS = [...OTHER_IDS, ...GAP_PAST.map((r) => r.task_id), ...ROSTER_2026.map((r) => r.task_id)];
const NEW_TOTAL = [...OTHER_IDS, ...[...GAP_PAST, ...GAP_2026, ...ROSTER_2026, ...ROSTER_PAST].map((r) => r.task_id)];

// 優先層（#443）加的東西，用最小的替身讓 seed 跑得動：task_dispatches.priority 欄、activity_priority()（簽名與回傳欄位照 #443 的定義，一律回中段 2）；
// 優先層本身（規則、權重、rebalance）由 queue-priority.test.ts 守，這裡只驗 seed 的 window／filled 沒有弄壞它
const QP_STUB = `
CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid);
CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL);
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

const buildP2 = (mutateP2?: (s: string) => string) =>
  buildArmsDb({ branches: NEW_BRANCHES, afterP1Sql: QP_STUB, p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG, mutate: mutateP2 }], restub: RESTUB } });

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

async function runSuite(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  const g = (name: string, f: () => Promise<boolean>) => guard(v, db, name, f);
  const roster = (day: string) => clock(db, day).then(() => ids(db, `arm = 'party_roster'`));
  const gap = (day: string) => clock(db, day).then(() => ids(db, `arm = 'party_gap'`));
  const seed = () => db.exec(`SELECT seed_auto_task_queue()`);
  const closed = (extra = "") => rows<{ task_id: string; reason: string; via: string | null }>(db, `SELECT task_id, reason, detail->>'via' AS via FROM gap_events WHERE event = 'closed' ${extra} ORDER BY id`);

  // ---- 1. 今天輸出逐件不變 ----
  await g("today_hides_closed_rows", async () => {
    await clock(db, "2026-10-08");
    return same(await ids(db), TODAY_IDS) && (await ids(db)).length === NEW_TOTAL.length - ROSTER_PAST.length - GAP_2026.length;
  });

  // ---- 2. 假時鐘：投票日當天開、隔天關 ----
  await g("roster_open_through_polling_day_closed_next_day", async () => {
    const r2026 = ROSTER_2026.map((r) => r.task_id);
    const only2026 = async (day: string) => (await roster(day)).filter((i) => r2026.includes(i));
    return same(await only2026("2026-01-01"), r2026) && same(await only2026("2026-11-27"), r2026) && same(await only2026("2026-11-28"), r2026) &&
      (await only2026("2026-11-29")).length === 0 && (await only2026("2026-12-31")).length === 0 && (await only2026("2030-01-01")).length === 0;
  });
  await g("old_elections_each_through_their_own_polling_day", async () => {
    const at = async (day: string) => (await roster(day)).filter((i) => !ROSTER_2026.some((r) => r.task_id === i));
    // 2022-11-26 投票日（縣市長 501）當天仍開、11-27 關；重行選舉 2022-12-18 當天仍開、12-19 關；2024-01-13 當天仍開、01-14 關
    return same(await at("2022-01-01"), [tid(501), tid(502), tid(503)]) &&
      same(await at("2022-11-26"), [tid(501), tid(502), tid(503)]) &&
      same(await at("2022-11-27"), [tid(502), tid(503)]) &&
      same(await at("2022-12-18"), [tid(502), tid(503)]) &&
      same(await at("2022-12-19"), [tid(502)]) &&
      same(await at("2024-01-13"), [tid(502)]) &&
      (await at("2024-01-14")).length === 0 && (await at("2030-01-01")).length === 0;
  });
  await g("no_overlap_no_gap_with_party_gap", async () => {
    // 401（2026，兩支臂都有）、501（2022）、502（2024）、503（重行）：每個邊界日前後，同一個 task_id 在兩支臂合起來「剛好一列」
    const days = ["2022-01-01", "2022-11-26", "2022-11-27", "2022-12-18", "2022-12-19", "2024-01-13", "2024-01-14", "2026-10-08", "2026-11-28", "2026-11-29", "2030-01-01"];
    for (const d of days) {
      await clock(db, d);
      const both = await rows<{ task_id: string; n: number }>(db,
        `SELECT task_id, count(*)::int AS n FROM contribution_auto_tasks_arms() WHERE arm IN ('party_gap', 'party_roster') AND task_id = ANY ($1) GROUP BY task_id`, [[tid(401), tid(501), tid(502), tid(503)]]);
      if (both.length !== 4 || both.some((r) => r.n !== 1)) return false;
    }
    return true;
  });
  await g("handoff_arm_on_boundary_day", async () => {
    await clock(db, "2026-11-28");
    const a = await rows<{ arm: string }>(db, `SELECT arm FROM contribution_auto_tasks_arms() WHERE task_id = $1`, [tid(401)]);
    await clock(db, "2026-11-29");
    const b = await rows<{ arm: string }>(db, `SELECT arm FROM contribution_auto_tasks_arms() WHERE task_id = $1`, [tid(401)]);
    return a.length === 1 && a[0].arm === "party_roster" && b.length === 1 && b[0].arm === "party_gap";
  });

  // ---- 3. 其他臂不受影響；規則形狀；健康檢查 ----
  await g("other_arms_unaffected_on_every_day", async () => {
    for (const d of ["2022-01-01", "2026-10-08", "2026-11-28", "2026-11-29", "2030-01-01"]) {
      await clock(db, d);
      if (!same(await ids(db, `arm NOT IN ('party_gap', 'party_roster')`), OTHER_IDS)) return false;
    }
    return true;
  });
  await g("rules_shape_and_untouched_rules", async () => {
    const r = await rows<{ activity: string; window_kind: string; from_kind: string | null; from_offset: number; until_kind: string | null; until_offset: number; min_status: string; enabled: boolean; scoped: boolean }>(db,
      `SELECT activity, window_kind, from_kind, from_offset::int, until_kind, until_offset::int, min_status, enabled,
              (reasons IS NOT NULL OR levels IS NOT NULL OR election_types IS NOT NULL OR jurisdictions IS NOT NULL) AS scoped FROM activity_rules ORDER BY activity`);
    const pr = r.filter((x) => x.activity === "party_roster");
    const pg = r.filter((x) => x.activity === "party_gap");
    // 已上線的選舉結果那兩條（P2 20261008070000）：投票日 +1 起、無迄日，這個 PR 不碰；其餘 32 條仍是永遠開
    const er = r.filter((x) => ["election_results", "raw:election_result_missing"].includes(x.activity));
    const rest = r.filter((x) => x.activity !== "party_roster" && x.activity !== "party_gap" && !er.includes(x));
    return r.length === 36 && pr.length === 1 && pg.length === 1 &&
      er.length === 2 && er.every((x) => x.window_kind === "event" && x.from_kind === "polling" && x.from_offset === 1 && x.until_kind === null && x.enabled) &&
      pr[0].window_kind === "event" && pr[0].from_kind === null && pr[0].until_kind === "polling" && pr[0].until_offset === 0 && pr[0].min_status === "announced" && pr[0].enabled && !pr[0].scoped &&
      pg[0].window_kind === "event" && pg[0].from_kind === "polling" && pg[0].from_offset === 1 && pg[0].until_kind === null &&
      rest.length === 32 && rest.every((x) => x.window_kind === "always" && x.enabled && x.from_kind === null && x.until_kind === null);
  });
  await g("health_empty", async () => (await rows(db, `SELECT * FROM activity_health`)).length === 0);
  await g("opened_by_roster_carries_open_until_not_milestone", async () => {
    await clock(db, "2026-10-08");
    const x = await rows<{ task_id: string; ob: Record<string, unknown> }>(db, `SELECT task_id, opened_by AS ob FROM contribution_auto_tasks_arms() WHERE arm = 'party_roster' ORDER BY task_id`);
    const rid = (await one<{ id: number }>(db, `SELECT id::int AS id FROM activity_rules WHERE activity = 'party_roster'`)).id;
    return x.length === 3 && x.every((r) => r.ob.basis === "rule" && r.ob.arm === "party_roster" && r.ob.rule_id === rid && r.ob.election_id === 2026 && r.ob.open_until === "2026-11-28" &&
      !("milestone_kind" in r.ob) && !("milestone_on_date" in r.ob) && !("expected_open_on" in r.ob));
  });

  // ---- 4. 總表的旗標 ----
  await g("arms_default_only_open_flag_shows_closed", async () => {
    await clock(db, "2026-10-08");
    const def = await rows<{ task_id: string; arm: string; ob: unknown }>(db, `SELECT task_id, arm, opened_by AS ob FROM contribution_auto_tasks_arms()`);
    await db.exec(`SELECT set_config('gap.arms_all', 'on', true)`);
    const all = await rows<{ task_id: string; arm: string; ob: unknown }>(db, `SELECT task_id, arm, opened_by AS ob FROM contribution_auto_tasks_arms()`);
    await db.exec(`SELECT set_config('gap.arms_all', '', true)`);
    const off = await rows(db, `SELECT 1 FROM contribution_auto_tasks_arms()`);
    const closedPairs = all.filter((r) => r.ob === null).map((r) => `${r.task_id}|${r.arm}`);
    const expected = [`${tid(401)}|party_gap`, `${tid(501)}|party_roster`, `${tid(502)}|party_roster`, `${tid(503)}|party_roster`];
    return def.length === TODAY_IDS.length && def.every((r) => r.ob !== null) && all.length === NEW_TOTAL.length && same(closedPairs, expected) &&
      all.filter((r) => r.ob !== null).length === def.length && off.length === def.length;
  });

  // ---- 5. seed：window／filled ----
  await g("seed_window_vs_filled", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-11-28");
    await seed();
    const day1 = (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:candidacy_source_missing:party:%'`)).map((r) => r.task_id);
    // 11-28：roster 的 401、402、403 開著（party_gap 的 401 還沒到窗口，不重複）
    if (!same(day1.filter((i) => [tid(401), tid(402), tid(403)].includes(i)), [tid(401), tid(402), tid(403)])) return false;
    // 403 在窗口還開著時，臂自己算不出來了（缺口補上了）＋一筆沒有任何臂會產出的派工列（臂已經算不出來）
    await db.exec(`DELETE FROM _b_party_roster WHERE task_id = '${tid(403)}'`);
    await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target, what_we_need, hint_sources, reward) VALUES ('auto:candidacy_source_missing:party:999', 'candidacy_source_missing', '{"election_id":2026}'::jsonb, 'x', '{}', 1)`);
    await seed();
    const c1 = await closed();
    // 11-29：402 臂還算得出來、窗口關了（window）；401 由 party_gap 接手（不收回）
    await clock(db, "2026-11-29");
    await seed();
    const c2 = await closed();
    const left = (await rows<{ task_id: string }>(db, `SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:candidacy_source_missing:party:%'`)).map((r) => r.task_id);
    const find = (cs: typeof c1, id: string) => cs.filter((c) => c.task_id === id);
    return find(c1, tid(403)).length === 1 && find(c1, tid(403))[0].reason === "filled" && find(c1, tid(403))[0].via === null &&
      find(c1, "auto:candidacy_source_missing:party:999").length === 1 && find(c1, "auto:candidacy_source_missing:party:999")[0].reason === "filled" &&
      find(c1, tid(402)).length === 0 &&
      find(c2, tid(402)).length === 1 && find(c2, tid(402))[0].reason === "window" && find(c2, tid(402))[0].via === "seed_window" &&
      find(c2, tid(401)).length === 0 && left.includes(tid(401)) && !left.includes(tid(402)) && !left.includes(tid(403)) &&
      c2.length === 3;
  });
  await g("seed_window_reopens_when_clock_goes_back", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-11-28");
    await seed();
    await clock(db, "2026-11-29");
    await seed();
    const gone = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = '${tid(402)}'`);
    await clock(db, "2026-11-28");
    await seed();
    const back = await rows<{ event: string }>(db, `SELECT event FROM gap_events WHERE task_id = '${tid(402)}' ORDER BY id`);
    return gone.length === 0 && JSON.stringify(back.map((e) => e.event)) === JSON.stringify(["opened", "closed", "reopened"]);
  });
  await g("seed_applied_contribution_still_filled", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-11-28");
    await seed();
    await db.exec(`INSERT INTO contributions (id, status, contribution_type, task_id, created_at) VALUES ('00000000-0000-4000-8000-0000000000aa', 'pending', 'candidacy', '${tid(402)}', now())`);
    await db.exec(`UPDATE contributions SET status = 'applied' WHERE id = '00000000-0000-4000-8000-0000000000aa'`);
    const c = await closed(`AND task_id = '${tid(402)}'`);
    return c.length === 1 && c[0].reason === "filled" && c[0].via === "drop_applied";
  });
  await g("seed_clears_flags_and_keeps_old_rows", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-10-08");
    await seed();
    const flag = await one<{ a: string | null; r: string | null; d: string | null }>(db, `SELECT current_setting('gap.arms_all', true) AS a, current_setting('gap.close_reason', true) AS r, current_setting('gap.close_detail', true) AS d`);
    const after = await rows(db, `SELECT 1 FROM contribution_auto_tasks_arms()`); // 旗標清掉了：同一個交易裡接著呼叫，不會多出被濾掉的列
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'auto:%'`);
    const ev = await rows(db, `SELECT 1 FROM gap_events WHERE event = 'closed'`);
    return (flag.a ?? "") === "" && (flag.r ?? "") === "" && (flag.d ?? "") === "" && after.length === TODAY_IDS.length &&
      n.n === new Set(TODAY_IDS).size && ev.length === 0;
  });
  await g("seed_stable_when_nothing_changes", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-11-28");
    await seed();
    await seed();
    return (await closed()).length === 0 && (await rows(db, `SELECT 1 FROM gap_events WHERE event = 'reopened'`)).length === 0;
  });

  // ---- 5b. 測試名人物（#448）：過濾在旗標之外，他們的任務旗標開著也不出現；已經在派工列裡的收回記 filled，不是 window ----
  await g("placeholder_person_rows_excluded_and_closed_as_filled", async () => {
    const pid = "00000000-0000-4000-8000-0000000000f1";
    const tpid = tid(405);
    await db.exec(`INSERT INTO politicians (id, name) VALUES ('${pid}', '測試候選人ABC')`);
    await db.exec(`INSERT INTO _b_party_roster VALUES ('${tpid}', 'candidacy_source_missing', '{"election_id":2026,"election_type":"縣市長","kind":"party_roster","politician_id":"${pid}"}'::jsonb, 'x', '{}', 1, '台北市')`);
    await clock(db, "2026-11-28");
    const open = await rows(db, `SELECT 1 FROM contribution_auto_tasks_arms() WHERE task_id = $1`, [tpid]);
    await db.exec(`SELECT set_config('gap.arms_all', 'on', true)`);
    const flagged = await rows(db, `SELECT 1 FROM contribution_auto_tasks_arms() WHERE task_id = $1`, [tpid]);
    await db.exec(`SELECT set_config('gap.arms_all', '', true)`);
    // 這個人的派工列本來就在（以前派出去的）：窗口關了之後它也是「臂不再算」→ filled
    await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target, what_we_need, hint_sources, reward) VALUES ('${tpid}', 'candidacy_source_missing', '{"election_id":2026}'::jsonb, 'x', '{}', 1)`);
    await clock(db, "2026-11-29");
    await seed();
    const c = await closed(`AND task_id = '${tpid}'`);
    return open.length === 0 && flagged.length === 0 && c.length === 1 && c[0].reason === "filled" && c[0].via === null;
  });

  // ---- 6. 重跑 ----
  await g("rerunnable", async () => {
    await clock(db, "2026-10-08");
    const before = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await applyP2(db, await readMig(P2_PR_MIG), RESTUB);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_rules`);
    const after = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await db.exec("RESET app.activity_today"); // 時鐘被覆寫時 activity_health 會列 clock_overridden
    return before.h === after.h && before.n === after.n && n.n === 36 && (await rows(db, `SELECT * FROM activity_health`)).length === 0;
  });
  return v;
}

const ALL_GUARDS = [
  "today_hides_closed_rows", "roster_open_through_polling_day_closed_next_day", "old_elections_each_through_their_own_polling_day", "no_overlap_no_gap_with_party_gap",
  "handoff_arm_on_boundary_day", "other_arms_unaffected_on_every_day", "rules_shape_and_untouched_rules", "health_empty", "opened_by_roster_carries_open_until_not_milestone",
  "arms_default_only_open_flag_shows_closed", "seed_window_vs_filled", "seed_window_reopens_when_clock_goes_back", "seed_applied_contribution_still_filled",
  "seed_clears_flags_and_keeps_old_rows", "seed_stable_when_nothing_changes", "placeholder_person_rows_excluded_and_closed_as_filled", "rerunnable",
];

Deno.test("B1 P2 在 PGlite 上整支跑得動；全部守門都綠（今天不變、投票日當天開隔天關、與 party_gap 銜接、旗標、seed 分 window／filled）", async () => {
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
  // 沒套 P2、新本體的輸出照樣露出來：證明「濾掉」是規則在做事，不是 stub 本來就少
  const noRule = await buildArmsDb({ branches: NEW_BRANCHES });
  await clock(noRule, "2026-10-08");
  assertEquals((await armsFingerprint(noRule, "contribution_auto_tasks_arms")).n, NEW_TOTAL.length);
  await oldDb.close();
  await newDb.close();
  await noRule.close();
});

// seed 的收回行為：新舊 seed 在「沒有窗口關閉」的缺口序列下，派工列（內容、排隊位置、回傳值）逐件相同——窗口收回只是多了 window 這個原因，沒動別的
Deno.test("B3 沒有窗口關閉時，新 seed 與 P1 的 seed 產生的派工列逐件相同（內容、排隊位置、回傳值）", async () => {
  const oldDb = await buildArmsDb({ branches: OLD_BRANCHES });
  const newDb = await buildP2();
  for (const d of [oldDb, newDb]) await clock(d, "2026-10-08");
  const ra = await one<{ n: number }>(newDb, `SELECT seed_auto_task_queue() AS n`);
  const rb = await one<{ n: number }>(oldDb, `SELECT seed_auto_task_queue() AS n`);
  assertEquals(ra.n, rb.n);
  const dump = (db: Db) => rows(db, `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region, queue_at, dispatch_count FROM task_dispatches WHERE task_id LIKE 'auto:%' ORDER BY task_id COLLATE "C"`);
  assertEquals(await dump(newDb), await dump(oldDb));
  await oldDb.close();
  await newDb.close();
});

// ---- 還原驗證：P2 migration 文字改壞一處（精確改一處），對應的守門必須紅；有 migration 自己的檢查擋住的，要「整支失敗」 ----
const noGuard = (s: string) => s.slice(0, s.indexOf("\nDO $$"));
const RULE_FRAG = "from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0";
const SEED_WINDOW_SET = "PERFORM set_config('gap.close_reason', 'window', true);";
const MUTATIONS: { name: string; breaks: string[]; edit: (sql: string) => string; buildFails?: boolean }[] = [
  { name: "迄日 +0 改成 -1（投票日前一天就關）", breaks: ["roster_open_through_polling_day_closed_next_day", "no_overlap_no_gap_with_party_gap", "rules_shape_and_untouched_rules", "opened_by_roster_carries_open_until_not_milestone"],
    edit: (s) => mutate(noGuard(s), "until_kind = 'polling', until_offset = 0", "until_kind = 'polling', until_offset = -1") },
  { name: "迄日 +0 改成 +1（投票日隔天還開，跟 party_gap 重疊）", breaks: ["roster_open_through_polling_day_closed_next_day", "no_overlap_no_gap_with_party_gap", "handoff_arm_on_boundary_day", "rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "until_kind = 'polling', until_offset = 0", "until_kind = 'polling', until_offset = 1") },
  { name: "不改規則（還是永遠開）：已投票屆別的列今天就露出來", breaks: ["today_hides_closed_rows", "roster_open_through_polling_day_closed_next_day", "rules_shape_and_untouched_rules", "no_overlap_no_gap_with_party_gap"],
    edit: (s) => s.slice(0, s.indexOf("-- 4. 規則")) },
  { name: "加起點（投票日前 30 天才開）：今天（投票日前 51 天）就關", breaks: ["today_hides_closed_rows", "rules_shape_and_untouched_rules", "roster_open_through_polling_day_closed_next_day"],
    edit: (s) => mutate(noGuard(s), RULE_FRAG, "from_kind = 'polling', from_offset = -30, until_kind = 'polling', until_offset = 0") },
  { name: "限定職位（只開縣市長）：其他職位的缺口被濾掉", breaks: ["today_hides_closed_rows", "rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "levels = NULL, election_types = NULL", "levels = NULL, election_types = ARRAY['縣市長']") },
  { name: "規則停用（enabled=false）：整類任務不派", breaks: ["today_hides_closed_rows", "rules_shape_and_untouched_rules", "roster_open_through_polling_day_closed_next_day"],
    edit: (s) => mutate(noGuard(s), "jurisdictions = NULL, enabled = true,", "jurisdictions = NULL, enabled = false,") },
  { name: "改到別的活動（party_gap）：party_roster 還是永遠開", breaks: ["today_hides_closed_rows", "roster_open_through_polling_day_closed_next_day", "rules_shape_and_untouched_rules"],
    edit: (s) => mutate(noGuard(s), "WHERE activity = 'party_roster'", "WHERE activity = 'party_gap'") },
  // ---- seed 的 window／filled ----
  { name: "seed：窗口收回的原因寫成 filled（沒分 window）", breaks: ["seed_window_vs_filled"],
    edit: (s) => mutate(s, SEED_WINDOW_SET, "PERFORM set_config('gap.close_reason', 'filled', true);") },
  { name: "seed：窗口收回的條件拿掉「臂還算得出來」（臂已算不出來的也記 window）", breaks: ["seed_window_vs_filled"],
    edit: (s) => mutate(s, "\n     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);", ";") },
  { name: "seed：_gaps 不濾掉被規則關著的列（窗口關了也不收回）", breaks: ["seed_window_vs_filled", "seed_window_reopens_when_clock_goes_back"],
    edit: (s) => mutate(s, "FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id;", "FROM _gaps_all g ORDER BY g.task_id;") },
  { name: "seed：旗標開了沒關（總表後面的呼叫會多出被濾掉的列）", breaks: ["seed_clears_flags_and_keeps_old_rows"],
    edit: (s) => mutate(s, "  PERFORM set_config('gap.arms_all', '', true);\n", "") },
  { name: "seed：window 收回後沒清掉 gap.close_reason（後面 filled 的收回也被記成 window）", breaks: ["seed_window_vs_filled", "seed_clears_flags_and_keeps_old_rows"],
    edit: (s) => mutate(s, "  PERFORM set_config('gap.close_reason', '', true);\n  PERFORM set_config('gap.close_detail', '', true);\n  -- <<< gap_events window\n", "  -- <<< gap_events window\n") },
  { name: "seed：旗標沒開（_gaps_all 只有開著的列，分不出 window）", breaks: ["seed_window_vs_filled"],
    edit: (s) => mutate(s, "set_config('gap.arms_all', 'on', true)", "set_config('gap.arms_all', '', true)") },
  // ---- 總表 ----
  { name: "總表：沒有預設濾掉的 WHERE（被規則關著的列一律露出）", breaks: ["today_hides_closed_rows", "roster_open_through_polling_day_closed_next_day", "arms_default_only_open_flag_shows_closed", "no_overlap_no_gap_with_party_gap"],
    edit: (s) => mutate(mutate(s, A_WHERE, A_WHERE_OLD), A_CLOSE_NEW, A_CLOSE_OLD) },
  { name: "總表：LEFT JOIN 改回 CROSS JOIN（旗標開著也看不到被關著的列）", breaks: ["arms_default_only_open_flag_shows_closed", "seed_window_vs_filled"],
    edit: (s) => mutate(mutate(s, A_JOIN_NEW, A_JOIN_OLD), A_ON_NEW, A_ON_OLD) },
  { name: "總表：旗標的值判斷寫反（on 時反而不多回傳）", breaks: ["arms_default_only_open_flag_shows_closed", "seed_window_vs_filled"],
    edit: (s) => mutate(s, "current_setting('gap.arms_all', true) = 'on')", "current_setting('gap.arms_all', true) = 'off')") },
  { name: "總表：被關著的列也帶 opened_by（拿 opened_by 分辨的 seed 會把它們當開著的）", breaks: ["arms_default_only_open_flag_shows_closed", "seed_window_vs_filled"],
    edit: (s) => mutate(mutate(s, A_BY_NEW, A_BY_OLD), "'open_until', o.open_until)) END AS opened_by\n", "'open_until', o.open_until)) AS opened_by\n") },
  { name: "總表：#448 的測試名人物過濾退到 OR 裡（關著的列與旗標開著時，測試人物的任務都露出來）", breaks: ["placeholder_person_rows_excluded_and_closed_as_filled", "arms_default_only_open_flag_shows_closed"],
    edit: (s) => mutate(s, "     AND (g.arm = 'placeholder_politicians'", "     OR (g.arm = 'placeholder_politicians'") },
  { name: "總表：opened_by 沒帶 open_until", breaks: ["opened_by_roster_carries_open_until_not_milestone"],
    edit: (s) => mutate(s, ", 'open_until', o.open_until)) END AS opened_by\n", ")) END AS opened_by\n") },
  // ---- migration 自己的檢查 ----
  { name: "迄日 +0 改成 -1，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "until_kind = 'polling', until_offset = 0", "until_kind = 'polling', until_offset = -1") },
  { name: "改到別的活動，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "WHERE activity = 'party_roster'\n   AND", "WHERE activity = 'party_info'\n   AND") },
  { name: "加起點，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, RULE_FRAG, "from_kind = 'polling', from_offset = -30, until_kind = 'polling', until_offset = 0") },
];

for (const m of MUTATIONS) {
  Deno.test(`B4 還原驗證：${m.name} → ${m.buildFails ? "migration 本身要失敗" : m.breaks.join("、") + " 必須紅"}`, async () => {
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
