/**
 * 派工與排程的啟用時間窗，P1（2026-10-08，docs/PLAN-task-activation.md；migration 20261008060000_activity_windows_p1.sql）。
 *
 * P1 讓 contribution_auto_tasks_arms() 開始呼叫 activity_open()，並把每個活動的規則種子種成「永遠開」——所以派工輸出必須逐件不變。
 * 守門分兩半，都只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）：
 *
 *   A. 文字層（不開資料庫）
 *      1. 總表新定義＝20261006141600 的現行定義（與正式庫 pg_get_functiondef 一字不差）加機械式替換，其餘一字不差（28 支臂的簽名與內容沒動）
 *      2. 臂名清單 activity_arm_names()＝總表本體裡實際貼的標籤＋raw 函式實際會產出的任務型別（raw:<型別>），不會各說各話
 *      3. seed 新函式＝P0 的定義只把寫死的 opened_by 換成 g.opened_by；activity_health 新視圖＝P0 的加一段 arm_without_rule
 *      4. 還原驗證：動一個不該動的字、掉一個臂、標籤拼錯，上面都要紅
 *
 *   B. PGlite（行為層）：28 個分支換成 stub（回放表裡的列），總表、相依函式、P0／P1 migration 跑真的
 *      1. 派工輸出逐件不變：舊總表（改名複本 legacy_arms）與新總表（去掉 arm、opened_by）逐件相同，輸出的 task_id 與手算的清單一致
 *      2. 規則真的有效（不是裝飾）：關掉／刪掉／closed 覆寫某臂的規則，那一臂的列剛好少掉；窗口規則依各場選舉的投票日各自開關；缺選舉＝關；職位與事由限定
 *      3. 臂名貼對了：raw 依任務型別拆開、mayor_policies 與 raw 的 policy_missing 各管各的
 *      4. opened_by 帶規則與里程碑，seed 寫進派工列、P0 的觸發器抄進 gap_events；gap_open_lateness 對帳視圖；activity_health 的 arm_without_rule
 *      5. 每條守門都做還原驗證：把 migration 文字改壞一處（精確改一處，改不到就失敗），對應的檢查必須紅
 *
 * 正式庫快照版的「逐件不變」見 scripts/arms-parity.ts（不進 CI：要唯讀快照）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { ARM_BRANCHES, armsDiff, armsFingerprint, BASE_ARMS_MIG, buildArmsDb, fnText, type GapRow, latestFn, migrationNames, mutate, P0_MIG, P1_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";

const P0 = await readMig(P0_MIG);
const P1 = await readMig(P1_MIG);

// ============================================================
// A. 文字層
// ============================================================
const OLD_ARMS = fnText(await readMig(BASE_ARMS_MIG), "contribution_auto_tasks_arms");
const NEW_ARMS = fnText(P1, "contribution_auto_tasks_arms");
const OLD_SEED = fnText(P0, "seed_auto_task_queue");
const NEW_SEED = fnText(P1, "seed_auto_task_queue");
const bodyOf = (fn: string) => fn.slice(fn.indexOf("$$\n") + 3, fn.lastIndexOf("$$;"));
const CUT = "       ),\n       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）";

/** 新總表倒推回舊總表：拿掉規則過濾那一段、還原臂名標籤與說明欄的欄名。結構不對就丟錯 */
function reverseArms(fn: string): string {
  const b = bodyOf(fn);
  assertEquals(b.split(CUT).length, 2, "規則過濾那一段的起點標記要剛好出現一次");
  let s = b.slice(0, b.indexOf(CUT));
  s = mutate(s, "       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),\n       tagged AS (\n  SELECT 'raw:' || r.task_type AS arm, r.task_id,", "       due AS (SELECT * FROM contribution_auto_tasks_deadline_due())\n  SELECT r.task_id,");
  s = mutate(s, "ELSE '' END AS what_we_need,\n         r.hint_sources", "ELSE '' END,\n         r.hint_sources");
  s = mutate(s, "  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM due t\n", "  UNION ALL SELECT * FROM due\n");
  let n = 0;
  s = s.replace(/UNION ALL SELECT '([a-z_]+)' AS arm, t\.\* FROM contribution_auto_tasks_\1\(\) t\n/g, (_m, name) => {
    n++;
    return `UNION ALL SELECT * FROM contribution_auto_tasks_${name}()\n`;
  });
  assertEquals(n, 26, "貼了臂名的分支要有 26 支（raw 與 deadline_due 另外處理）");
  return s;
}
const isMechanicalArms = (fn: string) => {
  try {
    return reverseArms(fn) === bodyOf(OLD_ARMS) && fn.split("\n").slice(0, 3).join("\n") === OLD_ARMS.split("\n").slice(0, 3).join("\n").replace("region TEXT)", "region TEXT, arm TEXT, opened_by JSONB)");
  } catch {
    return false;
  }
};

const SEED_OLD_FRAG = "g.region, now(), now(), '{\"basis\":\"seed\"}'::JSONB\n    FROM _gaps g";
const SEED_NEW_FRAG = "g.region, now(), now(), g.opened_by\n    FROM _gaps g";
const isMechanicalSeed = (fn: string) => {
  try {
    return mutate(fn, SEED_NEW_FRAG, SEED_OLD_FRAG) === OLD_SEED;
  } catch {
    return false;
  }
};

const viewText = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE VIEW activity_health AS"), sql.indexOf(";\nCOMMENT ON VIEW activity_health"));
const ARM_CHECK_FRAG = /  UNION ALL\n  SELECT 'arm_without_rule'[\s\S]*?\n(?=  UNION ALL\n  SELECT 'clock_overridden')/;
const isMechanicalHealth = (sql: string) => {
  const v = viewText(sql);
  return ARM_CHECK_FRAG.test(v) && v.replace(ARM_CHECK_FRAG, "") === viewText(P0);
};

/** activity_arm_names() 裡列的名字 */
const namesIn = (sql: string): string[] => {
  const t = fnText(sql, "activity_arm_names");
  return [...t.slice(t.indexOf("SELECT ARRAY["), t.indexOf("]::TEXT[]")).matchAll(/'([^']+)'/g)].map((m) => m[1]);
};
/** 總表本體裡貼的臂名標籤（不含 raw 的動態標籤） */
const tagsIn = (sql: string): string[] => [...fnText(sql, "contribution_auto_tasks_arms").matchAll(/SELECT '([a-z_]+)' AS arm, t\.\*/g)].map((m) => m[1]);
/** raw 函式（最新一版）實際會產出的任務型別 */
const rawTypes = async (): Promise<string[]> => [...new Set([...(await latestFn("contribution_auto_tasks_raw")).matchAll(/SELECT 'auto:([a-z_]+):'/g)].map((m) => m[1]))];

Deno.test("A1 總表與 seed 的前一版是對的：P1 緊接著 20261006141600（總表）與 P0（seed）之後，而且是最後一版（中間或之後有人改了，抄的底就過期）", async () => {
  for (const [fn, base, signature] of [
    ["contribution_auto_tasks_arms", BASE_ARMS_MIG, "("],
    ["seed_auto_task_queue", P0_MIG, "("],
  ]) {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}${signature}`)) defining.push(n);
    const i = defining.indexOf(P1_MIG);
    assert(i > 0, `P1 要在重新定義 ${fn} 的清單裡`);
    assertEquals(defining[i - 1], base, `${fn} 的前一版應該是 ${base}；有人在中間改了，要以那一版為底重做`);
    // P1 之後只允許：優先層那一版改 seed（20261008090000，守門在 queue-priority.test.ts）、測試人物隔離那一版改總表（20261008114000，守門在 placeholder-isolation.test.ts）、party_roster 那支 P2（20261008121000：總表多回傳被規則濾掉的列、seed 分 window／filled，以前兩者的版本為底；機械式替換與守門見 activity-party-roster.test.ts）；多了別人的就要以最新那版為底重做
    assertEquals(defining.slice(i + 1), fn === "seed_auto_task_queue" ? ["20261008090000_queue_priority_tiers.sql", P2_PR_MIG] : ["20261008114000_placeholder_task_isolation.sql", P2_PR_MIG], `P1 之後又有人改了 ${fn}：新增派工臂請改最新那版的總表（標籤、activity_arm_names、規則種子三處一起加），要以最新那版為底`);
  }
});

Deno.test("A2 總表新定義＝現行定義＋機械式替換（標籤、CTE 包裝、規則過濾），28 支臂的簽名與內容一字不差", () => {
  assert(isMechanicalArms(NEW_ARMS));
  assertEquals(reverseArms(NEW_ARMS), bodyOf(OLD_ARMS));
  // 回傳型別只多 arm、opened_by 兩欄（前 7 欄不動）；總表沒有動任何一支臂的函式
  assert(NEW_ARMS.includes("region TEXT, arm TEXT, opened_by JSONB)"));
  const code = P1.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/CREATE OR REPLACE FUNCTION contribution_auto_tasks_(?!arms\()/.test(code), "P1 不重寫任何一支臂（只動總表）");
  assert(!/ALTER TABLE elections|UPDATE elections/i.test(code), "P1 不動 elections（P4）");
  assert(!/DROP TABLE (?!IF EXISTS _gaps)/i.test(code) && !/DROP COLUMN/i.test(code), "P1 不刪表或欄位（seed 函式裡原本就有的 DROP TABLE IF EXISTS _gaps 除外）");
  assertEquals((code.match(/DROP FUNCTION/g) ?? []).length, 1, "只有總表為了改回傳型別 DROP 一次");
});

Deno.test("A3 臂名清單＝總表實際貼的標籤＋raw 函式實際會產出的任務型別；每個名字種一條規則", async () => {
  const names = namesIn(P1);
  const expected = [...tagsIn(P1), ...(await rawTypes()).map((t) => `raw:${t}`)]; // tagsIn 含 deadline_due（那個分支是 CTE，標籤寫法同）
  assertEquals(new Set(names).size, names.length, "名字不重複");
  assertEquals(names.length, 36);
  assertEquals([...names].sort(), [...expected].sort());
  // 標籤與函式同名（SELECT 'x' AS arm … contribution_auto_tasks_x()）：A2 的反向替換用 \1 比對過；分支一支不少
  assertEquals(tagsIn(P1).length, 27, "26 支臂＋deadline_due");
  for (const b of ARM_BRANCHES) if (b !== "raw") assert(tagsIn(P1).includes(b), `總表少了 ${b} 的標籤`);
  // 種子：從 activity_arm_names() 取名字，每個沒有規則的活動種一條永遠開
  assert(/INSERT INTO activity_rules \(activity, window_kind, note\)\s+SELECT a\.arm, 'always'/.test(P1));
  assert(P1.includes("FROM unnest(activity_arm_names()) AS a(arm)\n WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm);"));
});

Deno.test("A4 seed 新函式＝P0 的定義，只把寫死的 opened_by 換成 g.opened_by；health 新視圖＝P0 的視圖加一段 arm_without_rule", () => {
  assert(isMechanicalSeed(NEW_SEED));
  assertEquals(mutate(NEW_SEED, SEED_NEW_FRAG, SEED_OLD_FRAG), OLD_SEED);
  assert(!NEW_SEED.includes("gap_events"), "事件交給 task_dispatches 的觸發器，seed 函式裡不寫 gap_events");
  assert(isMechanicalHealth(P1));
});

Deno.test("A5 還原驗證（文字層）：動不該動的字、少一處替換、標籤拼錯、少一個臂、動 seed 本體，A2～A4 都要紅", async () => {
  // 總表
  assert(!isMechanicalArms(mutate(NEW_ARMS, "r.task_type <> 'roster_check' OR", "r.task_type <> 'roster_check' AND")), "偷改 raw 那段的過濾");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "'直轄市山地原住民區民代表')\n                                THEN", "'直轄市山地原住民區民代表', '村里長')\n                                THEN")), "偷改 raw 那段的說明");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "UNION ALL SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t\n", "")), "掉一支臂");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t", "SELECT 'dupe' AS arm, t.* FROM contribution_auto_tasks_dup() t")), "標籤拼錯（跟函式名不同）");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t", "SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_legacy() t")), "分支接錯函式");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t\n", "UNION ALL SELECT * FROM contribution_auto_tasks_owner_mismatch()\n")), "有一支沒貼標籤");
  assert(!isMechanicalArms(mutate(NEW_ARMS, "RETURNS TABLE (task_id TEXT,", "RETURNS TABLE (task_id TEXT, extra TEXT,")), "回傳型別多一欄");
  assert(!isMechanicalArms(OLD_ARMS.replace("$$", "$$")), "舊總表本身不是「新的」（沒有標籤）");
  // seed
  assert(!isMechanicalSeed(mutate(NEW_SEED, "WHERE d.task_id LIKE 'auto:%'\n     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);\n\n  -- 既有的", "WHERE d.task_id LIKE 'auto:%' AND true\n     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);\n\n  -- 既有的")), "偷改收回條件");
  assert(!isMechanicalSeed(mutate(NEW_SEED, "RETURN v_new + v_verify;", "RETURN v_new;")), "偷改回傳值");
  assert(!isMechanicalSeed(OLD_SEED), "P0 的 seed 本身不是新的");
  // health
  assert(!isMechanicalHealth(P1.replace("   WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm)\n", "   WHERE false\n").replace("  UNION ALL\n  SELECT 'activity_all_rules_disabled'", "  UNION ALL\n  SELECT 'activity_all_rules_disabled2'")), "偷改 P0 的檢查");
  // 臂名清單：掉一個名字、多一個名字、raw 的任務型別少一個，A3 的比對都要不一致
  const names = namesIn(P1);
  assert(!(JSON.stringify([...names.filter((n) => n !== "dup")].sort()) === JSON.stringify([...tagsIn(P1), ...(await rawTypes()).map((t) => `raw:${t}`)].sort())));
  assert(!(JSON.stringify([...names].sort()) === JSON.stringify([...tagsIn(P1), ...(await rawTypes()).filter((t) => t !== "roster_check").map((t) => `raw:${t}`)].sort())));
});

// ============================================================
// B. PGlite（行為層）
// ============================================================
const G = (id: string, type: string, target: Record<string, unknown> | null = null, region: string | null = "台北市"): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h1", "h2"], reward: 1, region });
const E = (election_id: number | null, election_type?: string | null, extra: Record<string, unknown> = {}) => ({ ...(election_id === null ? {} : { election_id }), ...(election_type === undefined ? {} : { election_type }), ...extra });

/** 每個分支至少一列、raw 的 9 種任務型別各一列，加上總表要濾掉的兩列（roster_check 不在清查範圍、progress_stale 已有 deadline_due） */
const FIXTURE: Partial<Record<(typeof ARM_BRANCHES)[number], GapRow[]>> = {
  raw: [
    G("pm", "policy_missing", E(2026, "縣市長")),
    G("pg", "profile_gap", E(2026)),
    G("pv", "policy_validity", { policy_id: "pol-v" }),
    G("ps1", "progress_stale", E(2022, undefined, { policy_id: "pol-1" })),
    G("ps2", "progress_stale", E(2024, undefined, { policy_id: "pol-2" })), // deadline_due 也有 pol-2 → 總表濾掉
    G("ps3", "progress_stale", { policy_id: "pol-3" }), // 沒有選舉
    G("csm", "candidacy_source_missing", E(2026, "縣市議員")),
    G("rc1", "roster_check", E(2026, "縣市長")),
    G("rc2", "roster_check", E(2026, "鄉鎮市長")), // 說明會多一句 sub_region
    G("rc3", "roster_check", E(2026, "總統副總統")), // roster_check_scope 沒有這個職位 → 總表濾掉
    G("pem", "policy_election_missing", { policy_id: "pol-e" }),
    G("css", "candidate_status_stale", E(2026, "村里長")),
    G("erm", "election_result_missing", E(2022, "縣市長")),
  ],
  deadline_due: [G("dd", "deadline_due", E(2024, undefined, { policy_id: "pol-2" }))],
  dup: [G("dup1", "duplicate_politician", null)],
  legacy: [G("leg1", "legacy_audit", null)],
  mismatch: [G("mm1", "policy_election_mismatch", E(2026))],
  policy_dup: [G("pd1", "duplicate_policy", null)],
  not_running: [G("nr1", "not_running_recheck", E(2026, "縣市長"))],
  mayor_policies: [G("mp1", "policy_missing", E(2026, "縣市長"))],
  term_policies: [
    G("t22", "term_policy_missing", E(2022, "縣市長")),
    G("t24", "term_policy_missing", E(2024, "立法委員")),
    G("t26", "term_policy_missing", E(2026, "縣市長")),
    G("t4", "term_policy_missing", E(4, "縣市長")),
    G("t22c", "term_policy_missing", E(2022, "縣市議員")),
    G("tnone", "term_policy_missing", null),
    G("tempty", "term_policy_missing", E(2022, "")), // election_type 是空字串＝沒有職位
  ],
  roster_villages: [G("rv1", "roster_check", E(2026, "村里長"))],
  township_gap: [G("tg1", "candidacy_source_missing", E(2026, "鄉鎮市長"))],
  region_gap: [G("rg1", "candidacy_source_missing", E(2026, "縣市議員"))],
  elected_missing: [G("em1", "election_result_missing", E(2022, "縣市長"))],
  roster_cec_gap: [G("rcg1", "roster_check", E(2026, "縣市長"))],
  district_seats: [G("ds1", "district_seats_missing", E(2022, "縣市議員"))],
  policy_elements: [G("pe1", "policy_elements_missing", E(2026))],
  lineage_candidates: [G("lc1", "lineage_candidate", null)],
  handover_missing: [G("hm1", "handover_missing", null)],
  lineage_roles: [G("lr1", "lineage_roles_missing", null)],
  lineage_links: [G("ll1", "lineage_link_candidate", null)],
  career_sources: [G("cs1", "profile_detail_gap", null)],
  withdrawn_filing: [G("wf1", "not_running_recheck", E(2026, "縣市長"))],
  party_gap: [G("pgap1", "candidacy_source_missing", E(2022, "縣市長"))],
  party_roster: [G("pr1", "candidacy_source_missing", E(2026, "縣市長"))],
  party_info: [G("pi1", "party_info_missing", null)],
  placeholder_politicians: [G("pp1", "placeholder_politician", null)],
  election_results: [G("er1", "election_results_missing", E(2022, "縣市長"))],
  owner_mismatch: [G("om1", "candidacy_owner_mismatch", E(2026, "縣市長"))],
};
const FIXTURE_IDS = Object.values(FIXTURE).flat().map((r) => r!.task_id);
const FILTERED_BY_ARMS = ["auto:rc3", "auto:ps2"];
const EXPECTED_IDS = FIXTURE_IDS.filter((i) => !FILTERED_BY_ARMS.includes(i)).sort();

type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];
const ids = async (db: Db, where = "true", params: unknown[] = []) =>
  (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_arms() WHERE ${where} ORDER BY task_id COLLATE "C"`, params)).map((r) => r.task_id);

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
const idsOf = (rs: GapRow[] | undefined) => (rs ?? []).map((r) => r.task_id);

async function runSuite(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  const g = (name: string, f: () => Promise<boolean>) => guard(v, db, name, f);
  const ruleId = async (activity: string) => (await one<{ id: number }>(db, `SELECT id::int AS id FROM activity_rules WHERE activity = $1 ORDER BY id LIMIT 1`, [activity])).id;

  // ---- 1. 派工輸出逐件不變 ----
  await g("parity_same_rows", async () => {
    const d = await armsDiff(db, "legacy_arms", "contribution_auto_tasks_arms");
    const fo = await armsFingerprint(db, "legacy_arms");
    const fn = await armsFingerprint(db, "contribution_auto_tasks_arms");
    const got = await ids(db);
    // 手算的清單：28 個分支每列都在，只有兩列被總表本來就濾掉（不在清查範圍的 roster_check、deadline_due 已涵蓋的 progress_stale）
    return d.aOnly === 0 && d.bOnly === 0 && d.aN === d.bN && d.aN === EXPECTED_IDS.length && fo.n === fn.n && fo.h === fn.h && fo.h !== null &&
      JSON.stringify(got) === JSON.stringify(EXPECTED_IDS);
  });
  await g("every_arm_has_a_row_and_a_name", async () => {
    // 36 個活動各有一列輸出：總表實際貼的臂名＝activity_arm_names()（runtime 版的臂名清單守門）
    const used = (await rows<{ arm: string }>(db, `SELECT DISTINCT arm FROM contribution_auto_tasks_arms() ORDER BY 1`)).map((r) => r.arm);
    const listed = (await one<{ names: string[] }>(db, `SELECT activity_arm_names() AS names`)).names.sort();
    return used.length === 36 && JSON.stringify(used) === JSON.stringify(listed);
  });
  await g("arms_signature_stable", async () => {
    // 前 7 欄與前一版同名同順序，多 arm、opened_by；task_boost_matches 這類用欄位名取值的呼叫端照舊能用
    const cols = (await db.query(`SELECT * FROM contribution_auto_tasks_arms() LIMIT 0`)).fields.map((f) => f.name);
    const old = (await db.query(`SELECT * FROM legacy_arms() LIMIT 0`)).fields.map((f) => f.name);
    const caller = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM (SELECT g.task_id, g.task_type, g.target, g.region FROM contribution_auto_tasks_arms() g) x`);
    return JSON.stringify(cols) === JSON.stringify([...old, "arm", "opened_by"]) && caller.n === EXPECTED_IDS.length;
  });

  // ---- 2. 規則種子與健康檢查 ----
  await g("rules_seeded_always", async () => {
    const r = await one<{ n: number; on: number; al: number; d: number; shaped: number }>(db,
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE enabled)::int AS "on", count(*) FILTER (WHERE window_kind = 'always')::int AS al, count(DISTINCT activity)::int AS d,
              count(*) FILTER (WHERE from_kind IS NULL AND until_kind IS NULL AND reasons IS NULL AND levels IS NULL AND election_types IS NULL AND jurisdictions IS NULL AND note LIKE 'P1 種子%')::int AS shaped
         FROM activity_rules`);
    const same = await one<{ ok: boolean }>(db, `SELECT (SELECT array_agg(activity ORDER BY activity) FROM activity_rules) = (SELECT array_agg(a ORDER BY a) FROM unnest(activity_arm_names()) a) AS ok`);
    return r.n === 36 && r.on === 36 && r.al === 36 && r.d === 36 && r.shaped === 36 && same.ok;
  });
  await g("health_empty_after_seed", async () => (await rows(db, `SELECT * FROM activity_health`)).length === 0 && (await rows(db, `SELECT * FROM gap_open_lateness`)).length === 0);
  await g("health_arm_without_rule", async () => {
    await db.exec(`DELETE FROM activity_rules WHERE activity IN ('dup', 'raw:roster_check')`);
    const h = (await rows<{ check_name: string; subject: string }>(db, `SELECT check_name, subject FROM activity_health ORDER BY subject`)).map((x) => `${x.check_name}|${x.subject}`);
    // 規則全停用是另一種（P0 的檢查）：兩種都要看得到
    await db.exec(`UPDATE activity_rules SET enabled = false WHERE activity = 'legacy'`);
    const h2 = (await rows<{ check_name: string; subject: string }>(db, `SELECT check_name, subject FROM activity_health ORDER BY subject`)).map((x) => `${x.check_name}|${x.subject}`);
    return JSON.stringify(h) === JSON.stringify(["arm_without_rule|dup", "arm_without_rule|raw:roster_check"]) && h2.includes("activity_all_rules_disabled|legacy");
  });

  // ---- 3. 規則真的有效：關掉／刪掉／覆寫 closed，那一臂剛好少那些列 ----
  await g("disable_rule_drops_exactly_that_arm", async () => {
    const all = await ids(db);
    await db.exec(`UPDATE activity_rules SET enabled = false WHERE activity = 'term_policies'`);
    const left = await ids(db);
    const gone = all.filter((i) => !left.includes(i));
    // 只少 term_policies 的 7 列；同樣是 policy_missing 型別的 mayor_policies 與 raw:policy_missing 還在
    return JSON.stringify(gone) === JSON.stringify(idsOf(FIXTURE.term_policies).sort()) && left.includes("auto:mp1") && left.includes("auto:pm") && left.length === all.length - 7;
  });
  await g("raw_split_by_task_type", async () => {
    const all = await ids(db);
    await db.exec(`UPDATE activity_rules SET enabled = false WHERE activity = 'raw:progress_stale'`);
    const left = await ids(db);
    const gone = all.filter((i) => !left.includes(i));
    // raw 一支函式產出多種任務型別：只少 progress_stale 的兩列（ps2 本來就被濾掉），deadline_due 與 raw 的其他型別不受影響
    return JSON.stringify(gone) === JSON.stringify(["auto:ps1", "auto:ps3"]) && left.includes("auto:dd") && left.includes("auto:pm") && left.includes("auto:rc1");
  });
  await g("mayor_policies_and_raw_policy_missing_are_separate", async () => {
    await db.exec(`UPDATE activity_rules SET enabled = false WHERE activity = 'mayor_policies'`);
    const a = await ids(db, `task_type = 'policy_missing'`);
    await db.exec(`UPDATE activity_rules SET enabled = true WHERE activity = 'mayor_policies'; UPDATE activity_rules SET enabled = false WHERE activity = 'raw:policy_missing'`);
    const b = await ids(db, `task_type = 'policy_missing'`);
    return JSON.stringify(a) === JSON.stringify(["auto:pm"]) && JSON.stringify(b) === JSON.stringify(["auto:mp1"]);
  });
  await g("all_rules_disabled_means_closed", async () => {
    // 規則存在但全部停用＝窗口關著（不丟錯）：一支臂、再所有臂
    await db.exec(`UPDATE activity_rules SET enabled = false WHERE activity = 'roster_villages'`);
    const a = await ids(db, `arm = 'roster_villages'`);
    await db.exec(`UPDATE activity_rules SET enabled = false`);
    const b = await ids(db);
    return a.length === 0 && b.length === 0;
  });
  await g("arm_without_rule_raises", async () => {
    // 臂在 activity_rules 連一列規則都沒有（新分支漏登記）：總表與 seed 丟錯、訊息寫明是哪個臂，不是無聲濾掉
    const raises = async (sql: string, arm: string) => {
      await db.exec("SAVEPOINT s");
      try {
        await db.query(sql);
        await db.exec("RELEASE SAVEPOINT s");
        return false;
      } catch (e) {
        await db.exec("ROLLBACK TO SAVEPOINT s");
        return String((e as Error).message).includes(`「${arm}」`);
      }
    };
    await db.exec(`DELETE FROM activity_rules WHERE activity = 'dup'`);
    const viaArms = await raises(`SELECT count(*) FROM contribution_auto_tasks_arms()`, "dup");
    const viaSeed = await raises(`SELECT seed_auto_task_queue()`, "dup");
    await db.exec(`INSERT INTO activity_rules (activity, window_kind) VALUES ('dup', 'always'); DELETE FROM activity_rules WHERE activity = 'raw:progress_stale'`);
    const viaRaw = await raises(`SELECT count(*) FROM contribution_auto_tasks_arms()`, "raw:progress_stale");
    await db.exec(`INSERT INTO activity_rules (activity, window_kind) VALUES ('raw:progress_stale', 'always')`);
    const okAgain = (await ids(db)).length === EXPECTED_IDS.length;
    return viaArms && viaSeed && viaRaw && okAgain;
  });
  await g("override_closed_closes_arm", async () => {
    await db.exec(`INSERT INTO activity_overrides (activity, "force", reason) VALUES ('election_results', 'closed', '還原驗證')`);
    const a = await ids(db, `arm = 'election_results'`);
    const rest = await ids(db);
    await db.exec(`DELETE FROM activity_overrides`);
    // 範圍：只關 2022 → 這一臂只有 2022 的列，所以同樣整臂關；改關 2026 就不影響
    await db.exec(`INSERT INTO activity_overrides (activity, election_id, "force", reason) VALUES ('election_results', 2026, 'closed', '還原驗證')`);
    const b = await ids(db, `arm = 'election_results'`);
    return a.length === 0 && rest.length === EXPECTED_IDS.length - 1 && JSON.stringify(b) === JSON.stringify(["auto:er1"]);
  });

  // ---- 4. 窗口規則：每場選舉各自算、缺選舉＝關、職位與事由限定 ----
  const polling1 = (activity: string, extra = "") => db.exec(`UPDATE activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = 1 ${extra} WHERE activity = '${activity}'`);
  await g("window_per_election", async () => {
    await polling1("term_policies");
    const at = async (day: string) => {
      await db.exec(`SET app.activity_today = '${day}'`);
      return await ids(db, `arm = 'term_policies'`);
    };
    const d1 = await at("2022-11-26"); // 投票日當天：2022 還沒到
    const d2 = await at("2022-11-27"); // +1：2022 開（縣市長、縣市議員、空職位）；重行選舉 2022-12-18 還沒到
    const d3 = await at("2024-01-14"); // 重行與 2024 都開；2026 還沒
    const d4 = await at("2026-11-28");
    const d5 = await at("2026-11-29");
    // 沒有選舉的列（tnone）永遠關（缺里程碑＝關）
    return d1.length === 0 && JSON.stringify(d2) === JSON.stringify(["auto:t22", "auto:t22c", "auto:tempty"]) &&
      JSON.stringify(d3) === JSON.stringify(["auto:t22", "auto:t22c", "auto:t24", "auto:t4", "auto:tempty"]) && d4.length === 5 &&
      JSON.stringify(d5) === JSON.stringify(["auto:t22", "auto:t22c", "auto:t24", "auto:t26", "auto:t4", "auto:tempty"]);
  });
  await g("window_closes_after_until", async () => {
    // 投票日 +1 ～ 投票日 +14（含頭含尾）：2022 在 2022-12-10 還開、12-11 關（重行選舉 2022-12-18 另算）
    await polling1("term_policies", `, until_kind = 'polling', until_offset = 14`);
    const at = async (day: string) => {
      await db.exec(`SET app.activity_today = '${day}'`);
      return await ids(db, `arm = 'term_policies' AND target->>'election_id' = '2022'`);
    };
    return (await at("2022-12-10")).length === 3 && (await at("2022-12-11")).length === 0;
  });
  await g("scope_election_types", async () => {
    // 規則限定縣市長：t22（縣市長）開；t22c（縣市議員）與空職位、沒有職位的列關
    await db.exec(`UPDATE activity_rules SET election_types = ARRAY['縣市長'] WHERE activity = 'term_policies'`);
    const open = await ids(db, `arm = 'term_policies'`);
    return JSON.stringify(open) === JSON.stringify(["auto:t22", "auto:t26", "auto:t4"]);
  });
  await g("scope_reasons_and_levels", async () => {
    await db.exec(`UPDATE activity_rules SET reasons = ARRAY['rerun'] WHERE activity = 'term_policies'`);
    const rerun = await ids(db, `arm = 'term_policies'`); // 只有重行選舉（id 4）；沒有選舉的列比對不到事由
    await db.exec(`UPDATE activity_rules SET reasons = NULL, levels = ARRAY['national'] WHERE activity = 'term_policies'`);
    const national = await ids(db, `arm = 'term_policies'`); // 立法委員是 national；沒有職位的列比對不到層級
    return JSON.stringify(rerun) === JSON.stringify(["auto:t4"]) && JSON.stringify(national) === JSON.stringify(["auto:t24"]);
  });

  // ---- 5. opened_by 帶規則與里程碑 ----
  await g("opened_by_shape_always", async () => {
    const r = await rows<{ task_id: string; arm: string; ob: Record<string, unknown> }>(db, `SELECT task_id, arm, opened_by AS ob FROM contribution_auto_tasks_arms() ORDER BY task_id`);
    for (const x of r) {
      const want = await ruleId(x.arm);
      const eid = Object.values(FIXTURE).flat().find((f) => f!.task_id === x.task_id)?.target?.election_id as number | undefined;
      const keys = Object.keys(x.ob).sort();
      // 永遠開的規則：basis=rule、臂名、規則 id、（有選舉的才有）election_id；沒有里程碑、沒有 null 欄位
      if (x.ob.basis !== "rule" || x.ob.arm !== x.arm || x.ob.rule_id !== want || x.ob.election_id !== eid) return false;
      if (JSON.stringify(keys) !== JSON.stringify(eid === undefined ? ["arm", "basis", "rule_id"] : ["arm", "basis", "election_id", "rule_id"])) return false;
    }
    return r.length === EXPECTED_IDS.length;
  });
  await g("opened_by_shape_window", async () => {
    await polling1("term_policies");
    await db.exec(`SET app.activity_today = '2026-11-29'`);
    const x = await one<{ ob: Record<string, unknown> }>(db, `SELECT opened_by AS ob FROM contribution_auto_tasks_arms() WHERE task_id = 'auto:t26'`);
    const rid = await ruleId("term_policies");
    return x.ob.rule_id === rid && x.ob.milestone_kind === "polling" && x.ob.milestone_on_date === "2026-11-28" && x.ob.expected_open_on === "2026-11-29" && x.ob.election_id === 2026 && x.ob.basis === "rule";
  });
  await g("opened_by_override", async () => {
    await db.exec(`INSERT INTO activity_overrides (activity, election_id, "force", reason) VALUES ('mayor_policies', 2026, 'open', '測試：覆寫開')`);
    const x = await one<{ ob: Record<string, unknown> }>(db, `SELECT opened_by AS ob FROM contribution_auto_tasks_arms() WHERE task_id = 'auto:mp1'`);
    return x.ob.basis === "override" && x.ob.override_id !== undefined && x.ob.rule_id === undefined;
  });

  // ---- 6. seed 把規則帶進派工列與 gap_events ----
  await g("seed_writes_rule_into_dispatch_and_events", async () => {
    await polling1("term_policies");
    await db.exec(`SET app.activity_today = '2026-11-29'`);
    await db.exec(`DELETE FROM task_dispatches`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const rid = await ruleId("term_policies");
    const d = await one<{ ob: Record<string, unknown>; at: string | null }>(db, `SELECT opened_by AS ob, opened_at::text AS at FROM task_dispatches WHERE task_id = 'auto:t26'`);
    const e = await one<{ rule_id: number; election_id: number; k: string; d: string; event: string; ex: string }>(db,
      `SELECT rule_id::int, election_id, milestone_kind AS k, milestone_on_date::text AS d, event, detail->>'expected_open_on' AS ex FROM gap_events WHERE task_id = 'auto:t26' ORDER BY id LIMIT 1`);
    const dup = await one<{ ob: Record<string, unknown> }>(db, `SELECT opened_by AS ob FROM task_dispatches WHERE task_id = 'auto:dup1'`);
    const n = await one<{ n: number; same: number }>(db, `SELECT count(*)::int AS n, count(*) FILTER (WHERE d.opened_by = g.opened_by)::int AS same FROM task_dispatches d JOIN contribution_auto_tasks_arms() g ON g.task_id = d.task_id WHERE d.task_id LIKE 'auto:%'`);
    return d.at !== null && d.ob.rule_id === rid && d.ob.expected_open_on === "2026-11-29" && e.rule_id === rid && e.election_id === 2026 && e.k === "polling" && e.d === "2026-11-28" &&
      e.event === "opened" && e.ex === "2026-11-29" && dup.ob.basis === "rule" && dup.ob.rule_id === (await ruleId("dup")) &&
      n.n === EXPECTED_IDS.length - 1 /* tnone（沒有選舉）在窗口規則下是關的 */ && n.same === n.n;
  });
  await g("seed_dispatch_content_same_as_gaps", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const x = await one<{ n: number }>(db,
      `SELECT count(*)::int AS n FROM task_dispatches d JOIN legacy_arms() g ON g.task_id = d.task_id
        WHERE d.task_type = g.task_type AND d.target IS NOT DISTINCT FROM g.target AND d.what_we_need = g.what_we_need AND d.hint_sources = g.hint_sources AND d.reward = g.reward AND d.region IS NOT DISTINCT FROM g.region`);
    const total = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'auto:%'`);
    return x.n === EXPECTED_IDS.length && total.n === EXPECTED_IDS.length;
  });
  await g("seed_reclaims_when_rule_closes", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    await db.exec(`UPDATE activity_rules SET enabled = false WHERE activity = 'term_policies'`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const left = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'auto:t%' AND task_type = 'term_policy_missing'`);
    const closed = await rows<{ event: string }>(db, `SELECT event FROM gap_events WHERE task_id = 'auto:t22' ORDER BY id`);
    await db.exec(`UPDATE activity_rules SET enabled = true WHERE activity = 'term_policies'`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const back = (await rows<{ event: string }>(db, `SELECT event FROM gap_events WHERE task_id = 'auto:t22' ORDER BY id`)).map((x) => x.event);
    // 窗口關＝下一輪收回（計畫 3.2），重新打開＝reopened。關閉原因現在一律記 filled（P1 規則都是永遠開，P2 起才分 window，見 migration 檔頭）
    return left.n === 0 && closed.map((x) => x.event).join() === "opened,closed" && back.join() === "opened,closed,reopened";
  });

  // ---- 7. 缺口出生對帳 ----
  await g("gap_open_lateness_view", async () => {
    // 規則「投票日 +offset」：expected_open_on 比實際出生日早很多天 → 列出；剛好今天 → 不列；永遠開的 → 不列
    const today = (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE 'Asia/Taipei')::date::text AS d`)).d;
    const offLate = (await one<{ n: number }>(db, `SELECT ($1::date - DATE '2026-11-28')::int AS n`, [today])).n; // 里程碑 2026-11-28 + offLate ＝ 今天
    // 假時鐘讓窗口今天就開：把投票日 +offLate 設成「今天」，t26 準時（expected＝今天）；2022 的投票日 +offLate 是很久以前，卻到今天才被 seed 看到 → 遲
    await db.exec(`UPDATE activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = ${offLate} WHERE activity = 'term_policies'`);
    await db.exec(`DELETE FROM task_dispatches`);
    await db.exec(`SELECT seed_auto_task_queue()`);
    const late = await rows<{ task_id: string; late_days: number; expected_open_on: string }>(db, `SELECT task_id, late_days::int, expected_open_on::text FROM gap_open_lateness ORDER BY task_id`);
    const ids2 = late.map((x) => x.task_id);
    return ids2.includes("auto:t22") && ids2.includes("auto:t24") && ids2.includes("auto:t4") && !ids2.includes("auto:t26") && !ids2.includes("auto:dup1") && late.every((x) => x.late_days > 1);
  });

  // ---- 8. 重跑（migration 可以重跑，不多規則、輸出不變）----
  await g("rerunnable", async () => {
    const before = await armsFingerprint(db, "contribution_auto_tasks_arms");
    await db.exec(await readMig(P1_MIG));
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_rules`);
    const after = await armsFingerprint(db, "contribution_auto_tasks_arms");
    const health = await rows(db, `SELECT * FROM activity_health`);
    return n.n === 36 && before.h === after.h && before.n === after.n && health.length === 0;
  });
  return v;
}

const ALL_GUARDS = [
  "parity_same_rows", "every_arm_has_a_row_and_a_name", "arms_signature_stable",
  "rules_seeded_always", "health_empty_after_seed", "health_arm_without_rule",
  "disable_rule_drops_exactly_that_arm", "raw_split_by_task_type", "mayor_policies_and_raw_policy_missing_are_separate", "all_rules_disabled_means_closed", "arm_without_rule_raises", "override_closed_closes_arm",
  "window_per_election", "window_closes_after_until", "scope_election_types", "scope_reasons_and_levels",
  "opened_by_shape_always", "opened_by_shape_window", "opened_by_override",
  "seed_writes_rule_into_dispatch_and_events", "seed_dispatch_content_same_as_gaps", "seed_reclaims_when_rule_closes",
  "gap_open_lateness_view", "rerunnable",
];

const buildFixtureDb = (mutateP1?: (s: string) => string) => buildArmsDb({ branches: FIXTURE, mutateP1 });

Deno.test("B1 P1 在 PGlite 上整支跑得動；全部守門都綠（派工輸出逐件不變、規則有效、臂名貼對、opened_by 與 gap_events、對帳視圖）", async () => {
  const db = await buildFixtureDb();
  const v = await runSuite(db);
  const red = ALL_GUARDS.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...ALL_GUARDS].sort(), "守門清單與實際跑的要一致");
  await db.close();
});

// ---- 還原驗證：migration 文字改壞一處（精確改一處），對應的守門必須紅 ----
const JOIN_FRAG = "    FROM keyed g\n    JOIN opened o ON";
const MUTATIONS: { name: string; breaks: string[]; edit: (sql: string) => string; buildFails?: boolean }[] = [
  { name: "規則過濾的 JOIN 改成 LEFT JOIN（沒有開窗的規則也放行）", breaks: ["disable_rule_drops_exactly_that_arm", "raw_split_by_task_type", "all_rules_disabled_means_closed", "window_per_election", "override_closed_closes_arm", "scope_election_types", "seed_reclaims_when_rule_closes"],
    edit: (s) => mutate(s, JOIN_FRAG, "    FROM keyed g\n    LEFT JOIN opened o ON") },
  { name: "總表不檢查臂有沒有規則（新分支漏登記時缺口無聲消失）", breaks: ["arm_without_rule_raises"],
    edit: (s) => mutate(s, "WHERE activity_require_rule(x.arm) OFFSET 0) k", "WHERE true OFFSET 0) k") },  { name: "mayor_policies 那個分支貼成別人的臂名", breaks: ["mayor_policies_and_raw_policy_missing_are_separate", "every_arm_has_a_row_and_a_name"],
    edit: (s) => mutate(s, "UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t", "UNION ALL SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t") },
  { name: "raw 不依任務型別拆開（臂名＝任務型別，沒有 raw: 前綴）", breaks: ["parity_same_rows", "raw_split_by_task_type", "every_arm_has_a_row_and_a_name"],
    edit: (s) => mutate(s, "SELECT 'raw:' || r.task_type AS arm,", "SELECT r.task_type AS arm,") },
  { name: "規則過濾不看職位（join 少一個條件）", breaks: ["scope_election_types", "parity_same_rows"],
    edit: (s) => mutate(s, " AND COALESCE(o.etype, '') = COALESCE(g.etype, '')\n", "\n") },
  { name: "規則過濾不看選舉（join 少一個條件）", breaks: ["window_per_election", "scope_reasons_and_levels", "parity_same_rows"],
    edit: (s) => mutate(s, " AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1)", "") },
  { name: "查規則時不傳職位", breaks: ["scope_election_types", "scope_reasons_and_levels"],
    edit: (s) => mutate(s, "SELECT * FROM activity_open(k.arm, k.eid, k.etype)", "SELECT * FROM activity_open(k.arm, k.eid, NULL)") },
  { name: "查規則時不傳選舉", breaks: ["window_per_election", "window_closes_after_until", "scope_reasons_and_levels", "opened_by_shape_window"],
    edit: (s) => mutate(s, "SELECT * FROM activity_open(k.arm, k.eid, k.etype)", "SELECT * FROM activity_open(k.arm, NULL, k.etype)") },
  { name: "opened_by 的 basis 寫死 seed（不帶規則來源）", breaks: ["opened_by_shape_always", "opened_by_shape_window", "opened_by_override", "seed_writes_rule_into_dispatch_and_events"],
    edit: (s) => mutate(s, "'basis', o.source, 'arm', g.arm,", "'basis', 'seed', 'arm', g.arm,") },
  { name: "opened_by 不去掉空欄位（rule 的列多出 override_id: null）", breaks: ["opened_by_shape_always"],
    edit: (s) => mutate(s, "jsonb_strip_nulls(jsonb_build_object(", "(jsonb_build_object(") },
  { name: "opened_by 不帶里程碑", breaks: ["opened_by_shape_window", "seed_writes_rule_into_dispatch_and_events"],
    edit: (s) => mutate(s, "'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on", "'milestone_kind', NULL::text") },
  { name: "opened_by 的規則 id 拿錯欄位", breaks: ["opened_by_shape_always", "opened_by_shape_window", "seed_writes_rule_into_dispatch_and_events"],
    edit: (s) => mutate(s, "'rule_id', o.rule_id,", "'rule_id', o.override_id,") },
  { name: "seed 新增派工列時又寫死 {\"basis\":\"seed\"}（規則資訊沒進派工列）", breaks: ["seed_writes_rule_into_dispatch_and_events"],
    edit: (s) => mutate(s, SEED_NEW_FRAG, SEED_OLD_FRAG) },
  { name: "有一個活動沒種規則、又拿掉 migration 裡的檢查（那一臂整支濾光，健康檢查要紅）", breaks: ["parity_same_rows", "rules_seeded_always", "health_empty_after_seed", "every_arm_has_a_row_and_a_name"],
    edit: (s) => mutate(mutate(s, "WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm);\n", "WHERE a.arm <> 'dup' AND NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm);\n"),
      "    RAISE EXCEPTION 'P1：有活動沒有啟用中的規則，不能換總表（會把那支臂的缺口整批濾掉）';", "    NULL;") },
  { name: "有一個活動沒種規則：migration 自己的檢查要讓整支失敗（寧可不上線）", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm);\n", "WHERE a.arm <> 'dup' AND NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm);\n") },
  { name: "臂名清單少一個名字（規則沒種、健康檢查也看不到）", breaks: ["parity_same_rows", "every_arm_has_a_row_and_a_name", "rules_seeded_always"],
    edit: (s) => mutate(mutate(s, "    'dup',\n", ""), "    RAISE EXCEPTION 'P1：有活動沒有啟用中的規則，不能換總表（會把那支臂的缺口整批濾掉）';", "    NULL;") },
  { name: "規則種子不是永遠開（window_kind 種成 event）", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "SELECT a.arm, 'always', 'P1 種子", "SELECT a.arm, 'event', 'P1 種子") },
  { name: "規則種子 enabled 種成 false（migration 自己的檢查要擋）", breaks: [], buildFails: true,
    edit: (s) => mutate(mutate(s, "INSERT INTO activity_rules (activity, window_kind, note)\nSELECT a.arm, 'always',", "INSERT INTO activity_rules (activity, window_kind, note, enabled)\nSELECT a.arm, 'always',"), "換成相對里程碑的窗口'\n  FROM", "換成相對里程碑的窗口', false\n  FROM") },
  { name: "健康檢查拿掉 arm_without_rule", breaks: ["health_arm_without_rule"],
    edit: (s) => mutate(s, "   WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm)\n  UNION ALL\n  SELECT 'clock_overridden'", "   WHERE false\n  UNION ALL\n  SELECT 'clock_overridden'") },
  { name: "對帳視圖的門檻改成永遠不列", breaks: ["gap_open_lateness_view"],
    edit: (s) => mutate(s, "- (e.detail->>'expected_open_on')::DATE > 1;", "- (e.detail->>'expected_open_on')::DATE > 100000;") },
  { name: "對帳視圖拿掉「有 expected_open_on」那一行（雙重保險：NULL 日期的差距本來就比不出 > 1，結果不變）", breaks: [],
    edit: (s) => mutate(s, "     AND e.detail ? 'expected_open_on'\n", "") },
];

for (const m of MUTATIONS) {
  Deno.test(`B2 還原驗證：${m.name} → ${m.buildFails ? "migration 本身要失敗" : m.breaks.length ? m.breaks.join("、") + " 必須紅" : "全部仍綠（本來就不該變）"}`, async () => {
    if (m.buildFails) {
      let failed = false;
      try {
        const db = await buildFixtureDb(m.edit);
        await db.close();
      } catch {
        failed = true;
      }
      assert(failed, `改壞了「${m.name}」，migration 卻照樣跑完（它自己的檢查沒擋住）`);
      return;
    }
    const db = await buildFixtureDb(m.edit);
    const v = await runSuite(db);
    const red = ALL_GUARDS.filter((g) => v[g] !== true).sort();
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
    if (m.breaks.length === 0) assertEquals(red, [], `「${m.name}」本來就不該讓任何守門變紅`);
    await db.close();
  });
}

Deno.test("B3 沒有 P1 的環境（只到 P0、總表還是前一版）：守門測的是真東西——legacy_arms 與前一版總表同一份本體，P1 之前派工輸出就是 legacy_arms", async () => {
  const db = await buildArmsDb({ branches: FIXTURE, applyP1: false });
  const a = await armsFingerprint(db, "contribution_auto_tasks_arms");
  const b = await armsFingerprint(db, "legacy_arms");
  assertEquals(a, b);
  assertEquals(a.n, EXPECTED_IDS.length, "手算的清單是用前一版（沒有任何規則過濾）算出來的，跟新版不是同一份程式");
  await db.close();
});
