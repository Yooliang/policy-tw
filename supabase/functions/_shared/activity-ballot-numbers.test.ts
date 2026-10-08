/**
 * 補號次：新派工臂 ballot_numbers（2026-10-08，缺口盤點 R8；migration 20261008150000_ballot_numbers_arm.sql）。
 *
 * 2026 的參選號次 cand_no 是 0／1,637，沒有任何臂會在抽籤（2026-10-23）後派。新臂把「已登記、沒有號次」的參選紀錄按單位整批派，
 * 窗口由規則決定：draw +0 開、polling +0 關（含頭含尾）；draw 里程碑由這支 migration 從 roster_check_scope.ballot_draw_on 自己補（ON CONFLICT DO NOTHING）。
 * 只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. 文字層：總表＝前一版（20261008121000）加一行 UNION 分支；臂名清單＝P1 的清單加一個名字；新增一支臂的三處登記（標籤、清單、規則）對得上；
 *      drop_applied／roster_batch_candidates／activity_health 各是現行定義加一處；這支只動這幾樣（不碰 seed、candidacy_list_published、not_running、candidate_status_stale）；
 *      臂本體沒有寫死的年份／日期；任務提示、skill.md、protocol 版號的守門
 *   B. PGlite（行為層，總表＋規則＋里程碑＋seed 跑真的，臂本體換 stub）：今天輸出不變；假時鐘 10-22 不開、10-23 開、11-28 開、11-29 關；舊選舉永遠不開；
 *      缺 draw 里程碑的職位關著；里程碑回填與 ON CONFLICT；opened_by 帶 draw 與 polling；seed 窗口關了記 window；每條守門做還原驗證
 *   C. 臂本體（真的 SQL 灌進 PGlite 的小資料表）：誰會被派（filed、沒號次、沒被併走、有縣市）、單位怎麼切（村里長與代表到鄉鎮、議員的選舉區放 items）、
 *      50 位拆件、已有人交了帶號次的 candidacy 先不派、candidate_status 隨名單公告翻
 *   D. 端到端（真的臂本體＋總表＋規則＋seed＋觸發器，不換 stub）：窗口、seed、單筆落庫不收回整件、重查任務、roster_batch_candidates 不被帶號次的擠掉、health
 *   E. 號次單位與重複／跳號視圖（真的 SQL）：重複、跳號、人數未齊不算、不同選舉區同號不算、村里長按村里、代表不檢查
 *
 * 正式庫快照版的「今天輸出逐件不變」見 scripts/arms-parity-p2.ts ballot_numbers（不進 CI；PR 說明附結果）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyP2, armsFingerprint, BALLOT_MIG, buildArmsDb, DEFAULT_SCOPE, fnText, type GapRow, latestFn, migrationNames, mutate, P0_MIG, P1_MIG, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";
import { BALLOT_NUMBERS_HINT, BALLOT_NUMBERS_RECHECK_HINT, CAND_NO_VERIFY_HINT, isBallotNumbersRecheckTask, isBallotNumbersTask, shapeTaskCurrent, shapeVerifyCurrent, type TaskContextData, type VerifyContextData } from "./task-context.ts";
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

// 這支 migration 順手改的另外三個既有物件：每個都是「現行定義加一處」
const DA_PREV = fnText(await readMig(P0_MIG), "task_dispatches_drop_applied");
const DA_NEW = fnText(B, "task_dispatches_drop_applied");
const DA_OLD_COND = "  IF NEW.task_id IS NOT NULL AND NEW.task_id LIKE 'auto:%' THEN\n";
const DA_NEW_COND = "  IF NEW.task_id IS NOT NULL AND NEW.task_id LIKE 'auto:%'\n     -- 補號次與重查是一個單位一件、代理一位一筆交：一筆落庫不代表整件做完，由 seed 依缺口還在不在收回（補號次 20261008150000）\n     AND NEW.task_id NOT LIKE 'auto:candidacy_source_missing:cand_no%' THEN\n";
const isMechanicalDropApplied = (fn: string) => {
  try {
    return mutate(fn, DA_NEW_COND, DA_OLD_COND) === DA_PREV;
  } catch {
    return false;
  }
};
const RBC_MIG = "20260924000013_roster_batch.sql";
const RBC_PREV = fnText(await readMig(RBC_MIG), "roster_batch_candidates");
const RBC_NEW = fnText(B, "roster_batch_candidates");
const RBC_ANCHOR = "   WHERE c.status = 'pending' AND c.contribution_type = 'candidacy'\n";
const RBC_ADD = "     -- 帶號次的不撿：登記彙總表沒有號次，名冊判 supported 會讓沒人核過的號次一票過（補號次 20261008150000）；在查詢裡排除，不佔 LIMIT\n     AND (c.payload->>'cand_no' IS NULL OR c.payload->>'cand_no' = '')\n";
const isMechanicalRosterBatch = (fn: string) => {
  try {
    return mutate(fn, RBC_ANCHOR + RBC_ADD, RBC_ANCHOR) === RBC_PREV;
  } catch {
    return false;
  }
};
const HEALTH_PREV_SQL = await readMig("20261008113000_bulletin_watch.sql");
const healthView = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE VIEW activity_health AS"), sql.indexOf("COMMENT ON VIEW activity_health IS"));
const HEALTH_SEG = /  UNION ALL\n  SELECT 'ballot_number_anomaly'[\s\S]*?\n(?=  UNION ALL\n  SELECT 'clock_overridden')/;
const isMechanicalHealth = (sql: string) => HEALTH_SEG.test(healthView(sql)) && healthView(sql).replace(HEALTH_SEG, "") === healthView(HEALTH_PREV_SQL);

Deno.test("A1 前一版是對的：總表緊接著 party_roster 那支 P2、活動名清單緊接著 P1、drop_applied 緊接著 P0、roster_batch_candidates 緊接著 20260924000013（中間沒有人插一版，抄的底就過期）", async () => {
  for (const [fn, base] of [["contribution_auto_tasks_arms", P2_PR_MIG], ["activity_arm_names", P1_MIG], ["task_dispatches_drop_applied", P0_MIG], ["roster_batch_candidates", RBC_MIG]]) {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) defining.push(n);
    const i = defining.indexOf(BALLOT_MIG);
    assert(i > 0, `這支 migration 要在重新定義 ${fn} 的清單裡`);
    assertEquals(defining[i - 1], base, `${fn} 的前一版應該是 ${base}；有人在中間改了，要以那一版為底重做機械式替換`);
  }
  const health: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE VIEW activity_health AS")) health.push(n);
  const hi = health.indexOf(BALLOT_MIG);
  assert(hi > 0);
  assertEquals(health[hi - 1], "20261008113000_bulletin_watch.sql", "activity_health 的前一版應該是公報偵測那支");
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

Deno.test("A4 這支只動這幾樣：新臂與號次單位函式／視圖、總表與清單各一處、drop_applied／roster_batch_candidates／activity_health 各加一處；不碰 seed、candidacy_list_published、not_running、candidate_status_stale；不建表不刪東西", () => {
  const code = codeOf(B);
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, ["activity_arm_names", "ballot_number_dups", "ballot_number_missing", "ballot_number_unit", "contribution_auto_tasks_arms", "contribution_auto_tasks_ballot_numbers", "roster_batch_candidates", "task_dispatches_drop_applied"]);
  assertEquals([...code.matchAll(/CREATE OR REPLACE VIEW ([a-z_]+)/g)].map((m) => m[1]), ["ballot_number_units", "ballot_number_anomalies", "activity_health"]);
  // drop_applied 本來就有的那一句 DELETE FROM task_dispatches（P0 的現行定義）不算
  assert(!/DROP FUNCTION|DROP TABLE|ALTER TABLE|CREATE TABLE|TRUNCATE|DELETE FROM|UPDATE (activity_rules|elections|election_milestones|politician_elections|roster_check_scope)/i.test(code.replace("DELETE FROM task_dispatches WHERE task_id = NEW.task_id;", "")), "不建表、不刪、不改別人的列");
  assert(!code.includes("FUNCTION seed_auto_task_queue"), "不碰 seed");
  assertEquals(count(code, "candidacy_list_published("), 2, "candidacy_list_published 只被呼叫兩次（補號次與重查各一，不重寫它：另一條 PR 在改）");
  assert(!/FUNCTION contribution_auto_tasks_(not_running|raw|party_roster|party_gap)/.test(code));
  const inserts = [...code.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]);
  assertEquals(inserts, ["election_milestones", "activity_rules"]);
  // 里程碑回填：取 roster_check_scope.ballot_draw_on、一個職位一列、已存在的不動
  assert(code.includes("FROM roster_check_scope s\n WHERE s.ballot_draw_on IS NOT NULL\nON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;"));
  assert(code.includes("SELECT s.election_id, 'draw', s.election_type, s.ballot_draw_on, 'official'"));
  // 三個既有物件各是現行定義加一處
  assert(isMechanicalDropApplied(DA_NEW));
  assert(isMechanicalRosterBatch(RBC_NEW));
  assert(isMechanicalHealth(B));
  assertEquals(count(codeOf(DA_NEW), "set_config('gap.close_reason', 'filled', true)"), 1, "drop_applied 的 gap_events 收回原因那幾行不動");
  assertEquals(codeOf(RBC_NEW).split("\n").filter((l) => l.includes("LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 1000))")).length, 1, "LIMIT 不動：過濾在查詢裡，不是撈出來再丟");
});

Deno.test("A5 臂本體：沒有寫死的年份、日期；單位與拆件規則在；條件是 filed、沒號次、沒被併走；五種選舉別再細到鄉鎮市區（含區長與鄉鎮市長）", () => {
  // 提示文字裡舉 2022 年的公告當「長相」範例（桃園市長名單、苗栗縣登記冊）是說明，不是條件；2026 或任何別的年份都不該出現
  assertEquals([...new Set(ARM.replace(/--.*$/gm, "").match(/\b(19|20)\d\d\b/g) ?? [])], ["2022"], "臂裡不寫死年份（只有提示文字裡的 2022 範例）");
  assert(!/CURRENT_DATE\s*[<>+-]|now\(\)/i.test(ARM), "臂裡不用 CURRENT_DATE／now() 比日期（窗口在規則）");
  assertEquals(count(ARM, "e.election_date >= activity_today() - 1"), 1, "唯一的日期比較是效能預篩（只掃還沒投票的屆別，等於規則的迄日），台北日界");
  assert(!/election_id\s*=\s*\d/.test(ARM), "臂裡不指名屆別");
  assert(ARM.includes("WHERE pe.candidacy_status = 'filed' AND pe.election_type IS NOT NULL AND COALESCE(r.region, p.region) IS NOT NULL"), "g_all：全部已登記者（號次補沒補不影響名次）");
  assert(ARM.includes("WHERE rk.cand_no IS NULL"), "沒號次的過濾在名次之後（分件後綴才穩定）");
  assert(ARM.includes("JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL"));
  assert(ARM.includes("/ 50 + 1"), "超過 50 位拆件");
  const FIVE = "('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')";
  assertEquals(count(ARM, FIVE), 4, "補號次（1）與重查（3：欄位、分件總數、視窗）切法一樣（鄉鎮市長、區長、村里長、代表到鄉鎮市區）");
  assert(ARM.includes("'kind', 'cand_no'") && ARM.includes("'election_id', u.election_id, 'election_type', u.election_type"), "target 帶 election_id 與 election_type（總表用它們問規則）");
  assert(ARM.includes("'kind', 'cand_no_recheck'") && ARM.includes("'election_id', rc.election_id, 'election_type', rc.election_type"), "重查也帶 election_id 與 election_type");
  assert(ARM.includes("'auto:candidacy_source_missing:cand_no:'") && ARM.includes("'auto:candidacy_source_missing:cand_no_recheck:'"));
  assert(ARM.includes("c.payload->>'cand_no' IS NOT NULL"), "已經有人交了帶號次的 candidacy 先不派");
  assert(ARM.includes("candidacy_protocol_status('filed', candidacy_list_published(gr.election_id, gr.election_type, CURRENT_DATE))"), "candidate_status 照名單公告了沒翻（呼叫方式同 party_roster）");
  assert(ARM.includes("FROM ballot_number_units bu") && ARM.includes("WHERE ru.kind IS NOT NULL"), "重查讀視圖（號次單位的檢查一定按號次單位），名次先算在全部號次單位上再留有問題的");
  assert(ARM.includes("btrim(c.payload->>'name') = rk.name"), "只有姓名、沒有 politician_id 的等票交件也能抑制");
});

Deno.test("A6 任務提示、驗證提示、skill.md、協議版號、system-one 的守門都在；roster_batch 的過濾在 SQL 不在記憶體", async () => {
  assert(BALLOT_NUMBERS_HINT.includes("target.items") && BALLOT_NUMBERS_HINT.includes("登記彙總表") && BALLOT_NUMBERS_HINT.includes("unreachable") && BALLOT_NUMBERS_HINT.includes("不要回 no_change not_found"));
  assert(BALLOT_NUMBERS_HINT.includes("各自從 1 編起") && BALLOT_NUMBERS_HINT.includes("not_supported"));
  assert(BALLOT_NUMBERS_RECHECK_HINT.includes("duplicate") && BALLOT_NUMBERS_RECHECK_HINT.includes("gap") && BALLOT_NUMBERS_RECHECK_HINT.includes("units[].members") && BALLOT_NUMBERS_RECHECK_HINT.includes("no_change"));
  assert(CAND_NO_VERIFY_HINT.includes("payload.cand_no") && CAND_NO_VERIFY_HINT.includes("剛好等於"));
  const md = (await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url))).replace(/\r\n/g, "\n");
  assert(md.includes("### 補選票號次（`candidacy_source_missing`，`target.kind` 是 `cand_no`）（1.76.0）"));
  assert(md.includes("**系統不核號次來源**") && md.includes("`outcome` 填 `unreachable`") && md.includes("不能當號次的來源"));
  assert(md.includes("`cand_no_recheck`") && md.includes("各自從 1 編起") && md.includes("重複") && md.includes("跳號"));
  // 版號不再釘死 1.76.0（之後的每次升版都會踩到）：這一節 1.76.0 起有，目前版號不低於它，且檔頭與常數一致（protocol.test.ts 另守）
  const ver = (v: string) => v.split(".").map(Number).reduce((x, n) => x * 1000 + n, 0);
  assert(ver(PROTOCOL_VERSION) >= ver("1.76.0"));
  assert(md.includes(`**版本**：${PROTOCOL_VERSION}`));
  const si = (await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(si.includes('if (action === "cand_no_check")') && si.includes('supabase.rpc("cand_no_dup_check_pending"'));
  assert(!si.includes("rosterBatchEligible"), "roster_batch 的過濾已經搬到 SQL（roster_batch_candidates），記憶體裡不再有");
  const guidance = (await Deno.readTextFile(new URL("./task-guidance.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(guidance.includes("t.kind === \"cand_no\"") && guidance.includes("t.kind === \"cand_no_recheck\"") && guidance.includes("缺的是號次（target.kind＝cand_no"));
});

Deno.test("A8 任務現況與提示：補號次任務走 BALLOT_NUMBERS_HINT、骨架給第一位；重查走 RECHECK 提示、骨架給第一個單位的第一位；驗證帶號次的 candidacy 多一句號次提示；沒帶的不多", () => {
  const target = {
    kind: "cand_no", election_id: 2026, election_type: "縣市議員", region: "台北市", candidate_status: "registered", items_count: 2,
    items: [{ politician_election_id: 1, politician_id: "00000000-0000-4000-8000-000000000001", name: "甲", electoral_district: "第01選舉區" }, { politician_election_id: 2, politician_id: "00000000-0000-4000-8000-000000000002", name: "乙", electoral_district: "第02選舉區" }],
  };
  assert(isBallotNumbersTask("candidacy_source_missing", target));
  assert(!isBallotNumbersTask("candidacy_source_missing", { ...target, kind: "party" }));
  assert(!isBallotNumbersTask("candidacy_source_missing", { ...target, kind: "cand_no_recheck" }));
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
  // 重查
  const rt = {
    kind: "cand_no_recheck", election_id: 2026, election_type: "村里長", region: "台北市", sub_region: "中山區", candidate_status: "qualified", units_count: 1,
    units: [{ unit: "中山區 新生里", anomaly: "duplicate", registered: 2, numbered: 2, duplicates: [1], missing: [2], sub_region: "中山區", village: "新生里",
      members: [{ politician_id: "00000000-0000-4000-8000-0000000000a1", name: "丙", cand_no: 1 }, { politician_id: "00000000-0000-4000-8000-0000000000a2", name: "丁", cand_no: 1 }] }],
  };
  assert(isBallotNumbersRecheckTask("candidacy_source_missing", rt));
  assert(!isBallotNumbersTask("candidacy_source_missing", rt));
  const cur2 = shapeTaskCurrent("candidacy_source_missing", {} as TaskContextData, { task_id: "auto:candidacy_source_missing:cand_no_recheck:2026:村里長:台北市:中山區", target: rt });
  assertEquals(cur2.hint, BALLOT_NUMBERS_RECHECK_HINT);
  assertEquals(cur2.units_count, 1);
  const tpl2 = (cur2.report_template as { payload: Record<string, unknown> }).payload;
  assertEquals(tpl2.politician_id, "00000000-0000-4000-8000-0000000000a1");
  assertEquals(tpl2.village, "新生里");
  assertEquals(tpl2.sub_region, "中山區");
  assertEquals(tpl2.candidate_status, "qualified");
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
// 這支 migration 建的視圖要能建起來：參選紀錄、地區、貢獻的欄位補齊（D 組端到端還會灌資料）；候選狀態換算用真的 candidacy_protocol_status，名單公告了沒用替身（預設沒公告）
const FULL_STUB = QP_STUB + `
ALTER TABLE elections ADD COLUMN bulletin_dir text;
ALTER TABLE politicians ADD COLUMN region text;
ALTER TABLE politician_elections ADD COLUMN election_id integer, ADD COLUMN election_type text, ADD COLUMN region_id integer, ADD COLUMN candidacy_status text, ADD COLUMN cand_no integer;
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
ALTER TABLE contributions ADD COLUMN payload jsonb, ADD COLUMN source_urls text[];
CREATE TABLE jev_decisions (id bigserial PRIMARY KEY, subject_type text, subject_id text, question text, choice text, model text);
CREATE TABLE _lp (published boolean);
INSERT INTO _lp VALUES (false);
CREATE FUNCTION candidacy_list_published(p_election_id integer, p_election_type text, p_on date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT published FROM _lp $$;
${await latestFn("candidacy_protocol_status")}`;

Deno.test("B0 優先層替身的簽名與回傳欄位跟 #443 的真實定義一致", () => {
  assert(QP.includes("RETURNS TABLE (priority SMALLINT, rule_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE)"));
});

const buildBallot = (mutateB?: (s: string) => string, branches: Record<string, GapRow[]> = NEW_BRANCHES) =>
  buildArmsDb({ branches, scope: SCOPE, extraBranches: EXTRA, afterP1Sql: FULL_STUB, p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: BALLOT_MIG, mutate: mutateB }], restub: RESTUB } });
const buildBase = () =>
  buildArmsDb({ branches: BASE_BRANCHES, scope: SCOPE, extraBranches: EXTRA, afterP1Sql: FULL_STUB, p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }], restub: RESTUB.filter((n) => n !== "ballot_numbers") } });

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
/** 號次單位函式、兩個視圖、臂本體（都是真的 SQL；mutateB 可以把 migration 文字改壞一處做還原驗證） */
const viewSql = (sql: string, name: string) => {
  const a = sql.indexOf(`CREATE OR REPLACE VIEW ${name} AS`);
  assert(a >= 0, `找不到視圖 ${name}`);
  return sql.slice(a, sql.indexOf(";\nCOMMENT ON VIEW", a) + 1);
};
const piecesSql = (b: string) => `${fnText(b, "ballot_number_unit")}\n${fnText(b, "ballot_number_dups")}\n${fnText(b, "ballot_number_missing")}\n${viewSql(b, "ballot_number_units")}\n${viewSql(b, "ballot_number_anomalies")}\n${fnText(b, "contribution_auto_tasks_ballot_numbers")}`;
async function buildArmDb(o: { people: Person[]; pes: Pe[]; regions?: Region[]; contributions?: Array<{ type: string; status: string; payload: Record<string, unknown> }>; listPublished?: boolean; mutateB?: (s: string) => string }): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text, region text, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, election_id integer, politician_id uuid, election_type text, region_id integer, candidacy_status text, cand_no integer);
    CREATE TABLE contributions (id serial PRIMARY KEY, contribution_type text, status text, payload jsonb);
    CREATE TABLE election_milestones_all (election_id integer, kind text, election_type text, on_date date, status text);
    CREATE TABLE _lp (published boolean);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT date '2026-10-23' $$;
    CREATE FUNCTION candidacy_list_published(p_election_id integer, p_election_type text, p_on date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT published FROM _lp $$;
    ${await latestFn("candidacy_protocol_status")}
    ${piecesSql(o.mutateB ? o.mutateB(B) : B)}`);
  await db.exec(`INSERT INTO _lp VALUES (${o.listPublished ? "true" : "false"})`);
  await db.exec(`INSERT INTO elections VALUES (2026, '2026-11-28'), (2022, '2022-11-26'), (2028, '2028-11-25')`);
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
    people: [{ id: 1, name: "甲" }, { id: 2, name: "乙" }, { id: 3, name: "丙" }, { id: 4, name: "丁" }, { id: 5, name: "戊" }, { id: 6, name: "己" }, { id: 7, name: "庚" }],
    pes: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: i, pid: i, type: "縣市長" })),
    contributions: [
      { type: "candidacy", status: "pending", payload: { politician_id: U(1), election_id: 2026, cand_no: 3 } },
      { type: "candidacy", status: "verified", payload: { politician_id: U(2), election_id: 2026, cand_no: 4 } },
      { type: "candidacy", status: "rejected", payload: { politician_id: U(3), election_id: 2026, cand_no: 5 } },
      { type: "candidacy", status: "pending", payload: { politician_id: U(4), election_id: 2026 } },
      { type: "candidacy", status: "pending", payload: { politician_id: U(5), election_id: 2022, cand_no: 1 } },
      { type: "policy", status: "pending", payload: { politician_id: U(6), election_id: 2026, cand_no: 1 } },
      // 只給姓名、沒給 politician_id（協議允許）：姓名＋選舉別＋縣市對得上的才抑制
      { type: "candidacy", status: "pending", payload: { election_id: 2026, election_type: "縣市長", region: "臺北市", name: "庚", cand_no: 6 } },
      { type: "candidacy", status: "pending", payload: { election_id: 2026, election_type: "縣市長", region: "高雄市", name: "己", cand_no: 6 } },
    ],
  });
  const r = await armRows(db);
  assertEquals(r.length, 1);
  assertEquals(r[0].target.items.map((i: any) => i.name).sort(), ["丙", "丁", "戊", "己"].sort(), "庚（只給姓名、縣市寫臺北市）被抑制；己的姓名交件是高雄市，不抑制");
  const db2 = await buildArmDb({
    people: [{ id: 1, name: "庚" }], pes: [{ id: 1, pid: 1, type: "縣市長" }],
    contributions: [{ type: "candidacy", status: "pending", payload: { election_id: 2026, election_type: "縣市長", region: "台北市", name: "庚", cand_no: 6 } }],
    mutateB: (s) => mutate(s, "OR (NULLIF(c.payload->>'politician_id', '') IS NULL AND btrim(c.payload->>'name') = rk.name", "OR (false AND btrim(c.payload->>'name') = rk.name"),
  });
  assertEquals((await armRows(db2)).length, 1, "還原驗證：拿掉姓名比對，只給姓名的等票交件抑制不到，任務照派");
  await db2.close();
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

// ============================================================
// E. 號次單位與重複／跳號視圖（真的 SQL，一個資料庫灌一整組情境，逐單位看有沒有被列）
// ============================================================
function scenarioE() {
  const people: Person[] = [];
  const pes: Pe[] = [];
  const add = (type: string, regionId: number | null, no: number | null, status = "filed", o: { eid?: number; region?: string | null; merged?: boolean } = {}) => {
    const id = people.length + 1;
    people.push({ id, name: `人${id}`, region: o.region === undefined ? "台北市" : o.region, merged: o.merged });
    pes.push({ id, pid: id, type, region_id: regionId, status, cand_no: no, eid: o.eid });
    return id;
  };
  const regions: Region[] = [
    { id: 1, region: "台北市", sub_region: "第01選舉區" }, { id: 2, region: "台北市", sub_region: "第02選舉區" },
    { id: 12, region: "台北市", sub_region: "第03選舉區" }, { id: 13, region: "台北市", sub_region: "第04選舉區" },
    { id: 3, region: "台北市", sub_region: "中山區", village: "新生里" }, { id: 4, region: "台北市", sub_region: "中山區", village: "長安里" },
    { id: 5, region: "台北市", sub_region: "中山區", village: "民族里" }, { id: 6, region: "台北市", sub_region: "中山區", village: "松江里" },
    { id: 7, region: "台北市", sub_region: "中山區", village: "大直里" },
    { id: 8, region: "新北市" }, { id: 9, region: "連江縣", sub_region: "東引鄉" },
    { id: 14, region: "雲林縣", sub_region: "臺西鄉", village: "臺西村" }, { id: 15, region: "雲林縣", sub_region: "台西鄉", village: "台西村" },
    { id: 10, region: "屏東縣", sub_region: "泰武鄉" }, { id: 11, region: "屏東縣", sub_region: "來義鄉" },
  ];
  // 縣市議員：第01選舉區 有人重複（2,2）、第02 正常（同樣用 1、2、3，不算重複）、第03 有一位退選但有號次（算進名單）、第04 重複但人數沒到齊
  add("縣市議員", 1, 1); add("縣市議員", 1, 2); add("縣市議員", 1, 2);
  add("縣市議員", 2, 1); add("縣市議員", 2, 2); add("縣市議員", 2, 3);
  add("縣市議員", 12, 1); add("縣市議員", 12, 3); add("縣市議員", 12, 2, "withdrawn"); add("縣市議員", 12, null, "withdrawn");
  add("縣市議員", 13, 1); add("縣市議員", 13, 1); add("縣市議員", 13, null);
  add("縣市議員", 2, 2, "filed", { merged: true }); // 被併走的人不算
  // 村里長：新生里重複（1,1）、長安里正常（同樣的 1、2）、民族里到齊卻跳號（1,3）、松江里人數沒到齊、大直里人數沒到齊而且最大號次大於人數
  add("村里長", 3, 1); add("村里長", 3, 1);
  add("村里長", 4, 1); add("村里長", 4, 2);
  add("村里長", 5, 1); add("村里長", 5, 3);
  add("村里長", 6, 2); add("村里長", 6, null);
  add("村里長", 7, 3); add("村里長", 7, null);
  add("村里長", 3, 1, "elected", { eid: 2028 }); // 別屆（還沒投票）同一個村里的 1 號：不算重複
  add("村里長", 3, 1, "elected", { eid: 2022 }); // 已投票的屆別：視圖不算
  add("村里長", 14, 1, "filed", { region: "雲林縣" }); add("村里長", 15, 1, "filed", { region: "雲林縣" }); // 臺西村／台西村是同一個村里（臺／台正規化）→ 重複
  // 縣市長：台北市正常（1,2,3）、新北市重複（1,1）——兩個縣市都有 1 號不算重複
  add("縣市長", null, 1); add("縣市長", null, 2); add("縣市長", null, 3);
  add("縣市長", 8, 1, "filed", { region: "新北市" }); add("縣市長", 8, 1, "filed", { region: "新北市" });
  // 代表：我們沒記選舉區，單位算不出來＝不檢查（即使同鄉鎮同號）
  add("鄉鎮市民代表", 9, 1, "filed", { region: "連江縣" }); add("鄉鎮市民代表", 9, 1, "filed", { region: "連江縣" });
  // 鄉鎮市長：沒記到鄉鎮的算不出單位＝不檢查；記到鄉鎮的按鄉鎮（泰武鄉重複、來義鄉正常）
  add("鄉鎮市長", null, 1, "filed", { region: "台東縣" }); add("鄉鎮市長", null, 1, "filed", { region: "台東縣" });
  add("鄉鎮市長", 10, 1, "filed", { region: "屏東縣" }); add("鄉鎮市長", 10, 1, "filed", { region: "屏東縣" });
  add("鄉鎮市長", 11, 1, "filed", { region: "屏東縣" });
  return { people, pes, regions };
}
const EXPECTED_ANOMALIES = [
  "2026|台北市|第01選舉區|duplicate|2|3",
  "2026|台北市|第04選舉區|duplicate|1|",
  "2026|台北市|中山區|新生里|duplicate|1|2",
  "2026|台北市|中山區|民族里|gap||2",
  "2026|新北市|duplicate|1|2",
  "2026|屏東縣|泰武鄉|duplicate|1|2",
  "2026|雲林縣|台西鄉|台西村|duplicate|1|2",
].sort();

async function runE(mutateB?: (s: string) => string): Promise<Verdicts> {
  const sc = scenarioE();
  const db = await buildArmDb({ ...sc, mutateB });
  const v: Verdicts = {};
  const an = (await rows<{ election_id: number; unit: string; kind: string; duplicates: number[]; missing: number[]; members: unknown[] }>(db, `SELECT election_id, unit, kind, duplicates, missing, members FROM ballot_number_anomalies`));
  const key = (r: (typeof an)[number]) => `${r.election_id}|${r.unit}|${r.kind}|${r.duplicates.join(",")}|${r.missing.join(",")}`;
  const has = (unit: string) => an.filter((r) => r.unit === unit);
  const units = await rows<{ unit: string; election_id: number; registered: number; numbered: number }>(db, `SELECT unit, election_id, registered, numbered FROM ballot_number_units`);
  v.e_exact_set = JSON.stringify(an.map(key).sort()) === JSON.stringify(EXPECTED_ANOMALIES);
  v.e_dup_detected = has("台北市|第01選舉區").length === 1 && has("台北市|第01選舉區")[0].duplicates.join() === "2" && has("台北市|中山區|新生里").length === 1 && has("新北市").length === 1;
  v.e_dup_scoped_by_unit = has("台北市|第02選舉區").length === 0 && has("台北市|中山區|長安里").length === 0 && has("台北市").length === 0 && has("屏東縣|來義鄉").length === 0;
  v.e_gap_complete = has("台北市|中山區|民族里").length === 1 && has("台北市|中山區|民族里")[0].kind === "gap" && has("台北市|中山區|民族里")[0].missing.join() === "2";
  v.e_incomplete_not_gap = has("台北市|中山區|松江里").length === 0 && has("台北市|中山區|大直里").length === 0 &&
    JSON.stringify(has("台北市|第04選舉區").map((r) => r.missing)) === "[[]]";
  v.e_withdrawn_with_number_counted = has("台北市|第03選舉區").length === 0 && units.some((u) => u.unit === "台北市|第03選舉區" && u.registered === 3 && u.numbered === 3);
  v.e_unknown_unit_unchecked = !units.some((u) => u.unit.startsWith("連江縣") || u.unit.startsWith("台東縣")) && units.filter((u) => u.unit.startsWith("屏東縣")).length === 2;
  v.e_village_is_the_unit = units.some((u) => u.unit === "台北市|中山區|松江里" && u.registered === 2 && u.numbered === 1) && has("台北市|中山區|新生里")[0]?.members.length === 2;
  v.e_election_scoped = units.filter((u) => u.unit === "台北市|中山區|新生里").map((u) => u.election_id).sort().join() === "2026,2028";
  v.e_voted_election_excluded = !units.some((u) => u.election_id === 2022);
  v.e_tai_variants_one_unit = units.filter((u) => u.unit.startsWith("雲林縣")).length === 1 && has("雲林縣|台西鄉|台西村").length === 1;
  v.e_merged_ignored = units.some((u) => u.unit === "台北市|第02選舉區" && u.registered === 3);
  await db.close();
  return v;
}
const ALL_E = ["e_voted_election_excluded", "e_tai_variants_one_unit", "e_exact_set", "e_dup_detected", "e_dup_scoped_by_unit", "e_gap_complete", "e_incomplete_not_gap", "e_withdrawn_with_number_counted", "e_unknown_unit_unchecked", "e_village_is_the_unit", "e_election_scoped", "e_merged_ignored"];

Deno.test("E1 號次單位與重複／跳號：重複、跳號、人數未齊不算、不同選舉區同號不算、村里長按村里、代表與單位不明不檢查、退選有號次算進名單、被併走不算、別屆不混", async () => {
  const v = await runE();
  const red = ALL_E.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
});

const UNIT_COUNCIL = "WHEN p_election_type = '縣市議員' AND btrim(COALESCE(p_district, '')) LIKE '%選舉區' THEN replace(btrim(p_county), '臺', '台') || '|' || replace(replace(btrim(p_district), ' ', ''), '臺', '台')";
const E_MUTATIONS: { name: string; breaks: string[]; edit: (s: string) => string }[] = [
  { name: "縣市議員的號次單位只到縣市（不分選舉區）", breaks: ["e_exact_set", "e_dup_scoped_by_unit", "e_dup_detected"],
    edit: (s) => mutate(s, UNIT_COUNCIL, "WHEN p_election_type = '縣市議員' AND btrim(COALESCE(p_district, '')) LIKE '%選舉區' THEN replace(btrim(p_county), '臺', '台')") },
  { name: "村里長的號次單位只到鄉鎮市區（不分村里）", breaks: ["e_exact_set", "e_village_is_the_unit"],
    edit: (s) => mutate(s, "|| '|' || replace(btrim(p_town), '臺', '台') || '|' || replace(btrim(p_village), '臺', '台')", "|| '|' || replace(btrim(p_town), '臺', '台')") },
  { name: "鄉鎮與村里不做臺／台正規化", breaks: ["e_exact_set", "e_tai_variants_one_unit"],
    edit: (s) => s.replaceAll("replace(btrim(p_town), '臺', '台')", "btrim(p_town)").replaceAll("replace(btrim(p_village), '臺', '台')", "btrim(p_village)") },
  { name: "視圖算已投票的屆別", breaks: ["e_voted_election_excluded"],
    edit: (s) => mutate(s, "      JOIN elections e ON e.id = pe.election_id AND e.election_date >= activity_today() - 1\n      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL\n      LEFT JOIN regions r ON r.id = pe.region_id\n     WHERE pe.candidacy_status IN", "      JOIN elections e ON e.id = pe.election_id\n      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL\n      LEFT JOIN regions r ON r.id = pe.region_id\n     WHERE pe.candidacy_status IN") },
  { name: "把鄉鎮市民代表也當有單位（鄉鎮）", breaks: ["e_exact_set", "e_unknown_unit_unchecked"],
    edit: (s) => mutate(s, "WHEN p_election_type IN ('鄉鎮市長', '直轄市山地原住民區長') AND", "WHEN p_election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表') AND") },
  { name: "跳號不看人數到齊（只看最大號次≠人數）", breaks: ["e_exact_set", "e_incomplete_not_gap"],
    edit: (s) => mutate(s, "WHEN count(m.cand_no) = count(*) AND count(DISTINCT m.cand_no) = count(*) AND max(m.cand_no) <> count(*) THEN 'gap' END AS kind", "WHEN max(m.cand_no) <> count(*) THEN 'gap' END AS kind") },
  { name: "退選但有號次的不算進名單", breaks: ["e_exact_set", "e_withdrawn_with_number_counted"],
    edit: (s) => mutate(s, " OR (pe.candidacy_status = 'withdrawn' AND pe.cand_no IS NOT NULL)", "") },
  { name: "缺的號次不管到不到齊都算", breaks: ["e_exact_set", "e_incomplete_not_gap"],
    edit: (s) => mutate(s, "SELECT CASE WHEN p_numbered = p_registered\n", "SELECT CASE WHEN true\n") },
  { name: "重複的判斷拿掉", breaks: ["e_exact_set", "e_dup_detected"],
    edit: (s) => mutate(s, "CASE WHEN count(DISTINCT m.cand_no) < count(m.cand_no) THEN 'duplicate'", "CASE WHEN false THEN 'duplicate'") },
  { name: "被併走的人也算", breaks: ["e_exact_set", "e_merged_ignored", "e_dup_scoped_by_unit"],
    edit: (s) => mutate(s, "      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL\n      LEFT JOIN regions r ON r.id = pe.region_id\n     WHERE pe.candidacy_status IN", "      JOIN politicians p ON p.id = pe.politician_id\n      LEFT JOIN regions r ON r.id = pe.region_id\n     WHERE pe.candidacy_status IN") },
];
for (const m of E_MUTATIONS) {
  Deno.test(`E2 還原驗證：${m.name} → ${m.breaks.join("、")} 必須紅`, async () => {
    const v = await runE(m.edit);
    const red = ALL_E.filter((g) => v[g] !== true);
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
  });
}

// ============================================================
// D. 端到端：真的臂本體＋總表＋規則＋seed＋觸發器（不換 stub）
// ============================================================
const buildD = (mutateB?: (s: string) => string) =>
  buildArmsDb({ branches: {}, scope: SCOPE, extraBranches: EXTRA, afterP1Sql: FULL_STUB, p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: BALLOT_MIG, mutate: mutateB }], restub: RESTUB.filter((n) => n !== "ballot_numbers") } });
async function loadD(db: Db) {
  const regions: Region[] = [
    { id: 1, region: "台北市", sub_region: "第01選舉區" }, { id: 3, region: "台北市", sub_region: "中山區", village: "新生里" }, { id: 4, region: "台北市", sub_region: "中山區", village: "長安里" },
    { id: 20, region: "高雄市", sub_region: "茂林區" }, { id: 21, region: "高雄市", sub_region: "那瑪夏區" }, { id: 22, region: "屏東縣", sub_region: "泰武鄉" },
  ];
  const people: Person[] = [];
  const pes: Pe[] = [];
  const add = (type: string, regionId: number | null, no: number | null, o: { eid?: number; region?: string; status?: string } = {}) => {
    const id = people.length + 1;
    people.push({ id, name: `人${id}`, region: o.region ?? "台北市" });
    pes.push({ id, pid: id, type, region_id: regionId, cand_no: no, eid: o.eid, status: o.status });
    return id;
  };
  add("縣市長", null, null); add("縣市長", null, null); add("縣市長", null, null);                 // pe 1-3
  add("村里長", 3, 1); add("村里長", 3, 1); add("村里長", 3, null);                                   // pe 4-6：新生里重複＋一位沒號次
  add("村里長", 4, 1); add("村里長", 4, 2);                                                           // pe 7-8：長安里正常
  add("直轄市山地原住民區長", 20, null, { region: "高雄市" }); add("直轄市山地原住民區長", 21, null, { region: "高雄市" }); // pe 9-10
  add("鄉鎮市長", 22, null, { region: "屏東縣" }); add("鄉鎮市長", null, null, { region: "屏東縣" });  // pe 11-12
  add("縣市議員", 1, 1); add("縣市議員", 1, 1);                                                       // pe 13-14：第01選舉區重複
  add("村里長", 3, 1, { eid: 2022, status: "elected" }); add("村里長", 3, 1, { eid: 2022, status: "elected" }); // pe 15-16：2022 的重複（已投票，視圖與 health 都不算）
  add("村里長", 3, null, { eid: 2022, status: "filed" });                                              // pe 17：2022 還停在已登記沒號次（臂不掃已投票的屆別）
  for (const r of regions) await db.query(`INSERT INTO regions VALUES ($1, $2, $3, $4)`, [r.id, r.region, r.sub_region ?? null, r.village ?? null]);
  for (const p of people) await db.query(`INSERT INTO politicians (id, name, region) VALUES ($1, $2, $3)`, [U(p.id), p.name, p.region]);
  for (const e of pes) await db.query(`INSERT INTO politician_elections (id, election_id, politician_id, election_type, region_id, candidacy_status, cand_no) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [e.id, e.eid ?? 2026, U(e.pid), e.type, e.region_id ?? null, e.status ?? "filed", e.cand_no ?? null]);
}
const TID = (kind: string, rest: string) => `auto:candidacy_source_missing:${kind}:${rest}`;
const MAIN_IDS = [
  TID("cand_no", "2026:縣市長:台北市"), TID("cand_no", "2026:村里長:台北市:中山區"),
  TID("cand_no", "2026:直轄市山地原住民區長:高雄市:茂林區"), TID("cand_no", "2026:直轄市山地原住民區長:高雄市:那瑪夏區"),
  TID("cand_no", "2026:鄉鎮市長:屏東縣:泰武鄉"), TID("cand_no", "2026:鄉鎮市長:屏東縣"),
];
const RECHECK_IDS = [TID("cand_no_recheck", "2026:村里長:台北市:中山區"), TID("cand_no_recheck", "2026:縣市議員:台北市")];

async function runD(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  const g = (name: string, f: () => Promise<boolean>) => guard(v, db, name, f);
  const open = async (day: string) => {
    await clock(db, day);
    return ids(db, `arm = 'ballot_numbers'`);
  };
  const seed = () => db.exec(`SELECT seed_auto_task_queue()`);
  await g("d_window", async () => {
    const want = [...MAIN_IDS, ...RECHECK_IDS];
    return (await open("2026-10-22")).length === 0 && same(await open("2026-10-23"), want) && same(await open("2026-11-28"), want) && (await open("2026-11-29")).length === 0;
  });
  await g("d_past_election_anomaly_never_dispatched", async () => {
    for (const d of ["2026-10-23", "2026-11-28"]) if ((await open(d)).some((i) => i.includes(":2022:"))) return false;
    return true;
  });
  await g("d_dispatch_unit_splits_by_town_for_five_types", async () => {
    await clock(db, "2026-10-23");
    const t = await rows<{ task_id: string; target: Record<string, any> }>(db, `SELECT task_id, target FROM contribution_auto_tasks_arms() WHERE arm = 'ballot_numbers' AND target->>'kind' = 'cand_no'`);
    const by = Object.fromEntries(t.map((r) => [r.task_id, r.target]));
    const mao = by[TID("cand_no", "2026:直轄市山地原住民區長:高雄市:茂林區")];
    const tai = by[TID("cand_no", "2026:鄉鎮市長:屏東縣:泰武鄉")];
    const rest = by[TID("cand_no", "2026:鄉鎮市長:屏東縣")];
    return mao?.sub_region === "茂林區" && mao.items[0].sub_region === "茂林區" && tai?.items[0].sub_region === "泰武鄉" && rest?.sub_region === undefined && rest.items.length === 1 &&
      by[TID("cand_no", "2026:村里長:台北市:中山區")]?.items.map((i: any) => i.village).join() === "新生里" && by[TID("cand_no", "2026:村里長:台北市:中山區")]?.items_count === 1;
  });
  await g("d_voted_elections_skipped_by_views_and_arm", async () => {
    await clock(db, "2026-10-23");
    const a = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM ballot_number_units WHERE election_id = 2022`);
    const b = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM contribution_auto_tasks_ballot_numbers() WHERE (target->>'election_id')::int = 2022`);
    const c = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM ballot_number_units WHERE election_id = 2026`);
    return a[0].n === 0 && b[0].n === 0 && c[0].n > 0;
  });
  await g("d_recheck_target_and_scope", async () => {
    await clock(db, "2026-10-23");
    const t = await rows<{ task_id: string; target: Record<string, any>; what_we_need: string; region: string }>(db, `SELECT task_id, target, what_we_need, region FROM contribution_auto_tasks_arms() WHERE arm = 'ballot_numbers' AND target->>'kind' = 'cand_no_recheck'`);
    const by = Object.fromEntries(t.map((r) => [r.task_id, r]));
    const vil = by[RECHECK_IDS[0]];
    const council = by[RECHECK_IDS[1]];
    return t.length === 2 && vil.target.election_id === 2026 && vil.target.election_type === "村里長" && vil.target.sub_region === "中山區" && vil.target.units_count === 1 &&
      vil.target.units[0].anomaly === "duplicate" && vil.target.units[0].village === "新生里" && vil.target.units[0].duplicates.join() === "1" && vil.target.units[0].members.length === 3 &&
      vil.what_we_need.includes("新生里") && vil.what_we_need.includes("號次 1 重複") && !vil.what_we_need.includes("長安里") && vil.region === "台北市" &&
      council.target.units[0].unit === "第01選舉區" && council.target.units[0].missing.join() === "2" && council.what_we_need.includes("缺 2") &&
      by[RECHECK_IDS[0]].task_id !== MAIN_IDS[1];
  });
  await g("d_seed_opens_and_closes_as_window", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    const n = async (day: string) => {
      await clock(db, day);
      await seed();
      return (await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = ANY ($1)`, [[...MAIN_IDS, ...RECHECK_IDS]])).length;
    };
    const a = await n("2026-10-22");
    const b = await n("2026-10-23");
    const c = await n("2026-11-29");
    const closed = await rows<{ reason: string }>(db, `SELECT reason FROM gap_events WHERE event = 'closed' AND task_id = ANY ($1)`, [[...MAIN_IDS, ...RECHECK_IDS]]);
    return a === 0 && b === 8 && c === 0 && closed.length === 8 && closed.every((x) => x.reason === "window");
  });
  await g("d_single_applied_candidacy_does_not_drop_whole_unit_task", async () => {
    await db.exec(`DELETE FROM task_dispatches`);
    await clock(db, "2026-10-23");
    await seed();
    const unitTask = TID("cand_no", "2026:村里長:台北市:中山區");
    await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target, what_we_need, hint_sources, reward) VALUES ('auto:other_kind:1', 'candidacy_source_missing', '{"election_id":2026}'::jsonb, 'x', '{}', 1)`);
    await db.exec(`INSERT INTO contributions (id, status, contribution_type, task_id, created_at) VALUES ('00000000-0000-4000-8000-0000000000b1', 'pending', 'candidacy', '${unitTask}', now()), ('00000000-0000-4000-8000-0000000000b2', 'pending', 'candidacy', 'auto:other_kind:1', now())`);
    await db.exec(`UPDATE contributions SET status = 'applied' WHERE id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2')`);
    const unitStill = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = $1`, [unitTask]);
    const otherGone = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = 'auto:other_kind:1'`);
    return unitStill.length === 1 && otherGone.length === 0;
  });
  await g("d_health_counts_anomalies_for_unvoted_elections_only", async () => {
    await clock(db, "2026-10-23");
    const h = await rows<{ check_name: string; subject: string; detail: string }>(db, `SELECT check_name, subject, detail FROM activity_health WHERE check_name = 'ballot_number_anomaly' ORDER BY subject`);
    return h.length === 2 && h.map((x) => x.subject).sort().join("|") === ["2026 / 村里長", "2026 / 縣市議員"].sort().join("|") && h.every((x) => x.detail.includes("ballot_number_anomalies"));
  });
  await g("d_roster_batch_candidates_filtered_in_sql_not_in_memory", async () => {
    await db.exec(`DELETE FROM contributions`);
    await db.exec(`INSERT INTO contributions (id, status, contribution_type, payload, source_urls, created_at)
      SELECT gen_random_uuid(), 'pending', 'candidacy', '{"name":"甲","cand_no":3}'::jsonb, ARRAY['https://web.cec.gov.tw/api/file/0d48e35c-3938-4ea5-abdc-169a60d9218a.pdf'], now() - interval '1 day' - g * interval '1 second' FROM generate_series(1, 600) g`);
    await db.exec(`INSERT INTO contributions (id, status, contribution_type, payload, source_urls, created_at) VALUES
      ('00000000-0000-4000-8000-0000000000c1', 'pending', 'candidacy', '{"name":"乙"}'::jsonb, ARRAY['https://web.cec.gov.tw/api/file/0d48e35c-3938-4ea5-abdc-169a60d9218a.pdf'], now()),
      ('00000000-0000-4000-8000-0000000000c2', 'pending', 'candidacy', '{"name":"丙","cand_no":null}'::jsonb, ARRAY['https://web.cec.gov.tw/api/file/0d48e35c-3938-4ea5-abdc-169a60d9218a.pdf'], now()),
      ('00000000-0000-4000-8000-0000000000c3', 'pending', 'candidacy', '{"name":"丁","cand_no":""}'::jsonb, ARRAY['https://web.cec.gov.tw/api/file/0d48e35c-3938-4ea5-abdc-169a60d9218a.pdf'], now())`);
    const r = await rows<{ id: string }>(db, `SELECT id FROM roster_batch_candidates(500)`);
    return r.length === 3 && r.every((x) => x.id.startsWith("00000000-0000-4000-8000-0000000000c"));
  });
  return v;
}
const ALL_D = ["d_window", "d_voted_elections_skipped_by_views_and_arm", "d_past_election_anomaly_never_dispatched", "d_dispatch_unit_splits_by_town_for_five_types", "d_recheck_target_and_scope", "d_seed_opens_and_closes_as_window", "d_single_applied_candidacy_does_not_drop_whole_unit_task", "d_health_counts_anomalies_for_unvoted_elections_only", "d_roster_batch_candidates_filtered_in_sql_not_in_memory"];

Deno.test("D1 端到端（真的臂本體）：窗口、區長與鄉鎮市長按鄉鎮切、重查只含有問題的單位、seed 開窗關窗記 window、單筆落庫不收回整件、health 只列還沒投票的、roster_batch 的過濾在 SQL", async () => {
  const db = await buildD();
  await loadD(db);
  const v = await runD(db);
  const red = ALL_D.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...ALL_D].sort());
  await db.close();
});

const D_MUTATIONS: { name: string; breaks: string[]; edit: (s: string) => string }[] = [
  { name: "drop_applied 沒有排除補號次（單筆落庫就收回整件）", breaks: ["d_single_applied_candidacy_does_not_drop_whole_unit_task"],
    edit: (s) => mutate(s, "\n     AND NEW.task_id NOT LIKE 'auto:candidacy_source_missing:cand_no%' THEN", " THEN") },
  { name: "roster_batch_candidates 沒有排除帶號次的", breaks: ["d_roster_batch_candidates_filtered_in_sql_not_in_memory"],
    edit: (s) => mutate(s, "     AND (c.payload->>'cand_no' IS NULL OR c.payload->>'cand_no' = '')\n", "") },
  { name: "區長沒有按鄉鎮切（補號次的 unit_town 少一種）", breaks: ["d_dispatch_unit_splits_by_town_for_five_types", "d_window"],
    edit: (s) => s.replaceAll("('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')", "('鄉鎮市長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')") },
  { name: "鄉鎮市長沒有按鄉鎮切", breaks: ["d_dispatch_unit_splits_by_town_for_five_types", "d_window"],
    edit: (s) => s.replaceAll("('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')", "('直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')") },
  { name: "activity_health 少了 ballot_number_anomaly", breaks: ["d_health_counts_anomalies_for_unvoted_elections_only"],
    edit: (s) => s.replace(/  UNION ALL\n  SELECT 'ballot_number_anomaly'[\s\S]*?\n(?=  UNION ALL\n  SELECT 'clock_overridden')/, "") },
  { name: "視圖不限還沒投票的選舉（seed 每 10 分鐘掃全部歷史）", breaks: ["d_voted_elections_skipped_by_views_and_arm"],
    edit: (s) => mutate(s, "      JOIN elections e ON e.id = pe.election_id AND e.election_date >= activity_today() - 1\n      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL\n      LEFT JOIN regions r ON r.id = pe.region_id\n     WHERE pe.candidacy_status IN", "      JOIN elections e ON e.id = pe.election_id\n      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL\n      LEFT JOIN regions r ON r.id = pe.region_id\n     WHERE pe.candidacy_status IN") },
  { name: "臂不限還沒投票的屆別", breaks: ["d_voted_elections_skipped_by_views_and_arm"],
    edit: (s) => mutate(s, "      JOIN elections e ON e.id = pe.election_id AND e.election_date >= activity_today() - 1\n      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL\n      LEFT JOIN regions r ON r.id = pe.region_id\n     WHERE pe.candidacy_status = 'filed' AND pe.election_type IS NOT NULL", "      JOIN elections e ON e.id = pe.election_id\n      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL\n      LEFT JOIN regions r ON r.id = pe.region_id\n     WHERE pe.candidacy_status = 'filed' AND pe.election_type IS NOT NULL") },
  { name: "重查不讀視圖而是漏掉（拿掉 UNION ALL 後半）", breaks: ["d_recheck_target_and_scope", "d_window"],
    edit: (s) => mutate(s, "  UNION ALL\n  SELECT 'auto:candidacy_source_missing:cand_no_recheck:'", "  UNION ALL\n  SELECT 'auto:candidacy_source_missing:cand_no_recheck_off:'") },
];
for (const m of D_MUTATIONS) {
  Deno.test(`D2 還原驗證：${m.name} → ${m.breaks.join("、")} 必須紅`, async () => {
    const db = await buildD(m.edit);
    await loadD(db);
    const v = await runD(db);
    const red = ALL_D.filter((g) => v[g] !== true);
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
    await db.close();
  });
}

// ============================================================
// S. 分件後綴穩定：task_id 不隨人數跨過門檻而變（補掉幾位、重查解決幾個，其餘的 task_id 不動）
// ============================================================
const mkPeople = (n: number, start: number) => Array.from({ length: n }, (_, i) => ({ id: start + i, name: `村${String(start + i).padStart(4, "0")}` }));
const taskIds = async (db: Db) => (await armRows(db)).map((r) => r.task_id.replace("auto:candidacy_source_missing:cand_no:2026:村里長:高雄市:鼓山區", "鼓山"));

async function stableMain(mutateB?: (s: string) => string): Promise<string[]> {
  const out: string[] = [];
  const people = mkPeople(51, 1);
  const db = await buildArmDb({
    people, regions: [{ id: 1, region: "高雄市", sub_region: "鼓山區", village: "A里" }],
    pes: people.map((p) => ({ id: p.id, pid: p.id, type: "村里長", region_id: 1 })), mutateB,
  });
  const snap = async () => JSON.stringify((await armRows(db)).map((r) => [r.task_id.split(":").pop(), r.target.items_count]));
  out.push(await snap()); // 51 位都沒號次：p1（50）、p2（1）
  // 前面 2 位補上號次：剩 49 位沒號次，但這個單位已登記 51 位，後綴不能消失
  await db.exec(`UPDATE politician_elections SET cand_no = id WHERE id IN (1, 2)`);
  out.push(await snap());
  // 第 51 位（p2 唯一的人）補上：p2 補完消失，p1 的 task_id 不變
  await db.exec(`UPDATE politician_elections SET cand_no = id WHERE id = 51`);
  out.push(await snap());
  await db.exec(`UPDATE politician_elections SET cand_no = id WHERE id > 2`);
  out.push(await snap()); // 全補完：沒有任務
  await db.close();
  return out;
}
Deno.test("S1 分件後綴穩定：51 位拆成 p1／p2，補掉幾位之後 task_id 不變（跨過 50 的門檻不重新編號）；補完的那一件才消失", async () => {
  const [a, b, c, d] = await stableMain();
  assertEquals(a, JSON.stringify([["p1", 50], ["p2", 1]]));
  assertEquals(b, JSON.stringify([["p1", 48], ["p2", 1]]), "49 位沒號次、已登記 51 位：後綴不消失");
  assertEquals(c, JSON.stringify([["p1", 48]]), "p2 補完才消失，p1 的 task_id 不變");
  assertEquals(d, "[]");
});
Deno.test("S2 還原驗證：名次改回只算還沒號次的（動態分件）→ 補掉幾位後 p1／p2 變成無後綴，S1 必須紅", async () => {
  const [, b] = await stableMain((s) => mutate(s, "     WHERE pe.candidacy_status = 'filed' AND pe.election_type IS NOT NULL AND COALESCE(r.region, p.region) IS NOT NULL\n  ),\n  ranked AS", "     WHERE pe.candidacy_status = 'filed' AND pe.cand_no IS NULL AND pe.election_type IS NOT NULL AND COALESCE(r.region, p.region) IS NOT NULL\n  ),\n  ranked AS"));
  assert(b !== JSON.stringify([["p1", 48], ["p2", 1]]), "動態分件下 49 位沒號次只剩一件，後綴消失");
});

async function stableRecheck(mutateB?: (s: string) => string): Promise<string[]> {
  // 一個鄉鎮 30 個村里（每村 2 位）→ 號次單位 30 個、重查一件 25 個：第 3 村與第 28 村重複，分別落在 p1、p2
  const people: Person[] = [];
  const pes: Pe[] = [];
  const regions: Region[] = [];
  for (let v = 1; v <= 30; v++) {
    regions.push({ id: v, region: "高雄市", sub_region: "鼓山區", village: `V${String(v).padStart(2, "0")}里` });
    for (const no of [1, v === 3 || v === 28 ? 1 : 2]) {
      const id = people.length + 1;
      people.push({ id, name: `人${id}` });
      pes.push({ id, pid: id, type: "村里長", region_id: v, cand_no: no });
    }
  }
  const db = await buildArmDb({ people, pes, regions, mutateB });
  const out: string[] = [];
  const snap = async () => {
    const t = await rows<{ task_id: string; target: Record<string, any> }>(db, `SELECT task_id, target FROM contribution_auto_tasks_ballot_numbers() WHERE target->>'kind' = 'cand_no_recheck' ORDER BY task_id COLLATE "C"`);
    return JSON.stringify(t.map((r) => [r.task_id.split(":").pop(), r.target.units.map((u: any) => u.unit)]));
  };
  out.push(await snap());
  // 第 3 村解決（改成 2 號）：p1 消失，第 28 村那一件的 task_id 不變
  await db.exec(`UPDATE politician_elections SET cand_no = 2 WHERE id = 6`);
  out.push(await snap());
  await db.close();
  return out;
}
Deno.test("S3 重查的分件後綴穩定：名次算在全部號次單位上，解決一個問題不會讓其餘的重查換 task_id", async () => {
  const [a, b] = await stableRecheck();
  assertEquals(a, JSON.stringify([["p1", ["鼓山區 V03里"]], ["p2", ["鼓山區 V28里"]]]));
  assertEquals(b, JSON.stringify([["p2", ["鼓山區 V28里"]]]));
});
Deno.test("S4 還原驗證：重查名次只算有問題的單位 → 解決第 3 村之後第 28 村那一件換成 p1，S3 必須紅", async () => {
  const [, b] = await stableRecheck((s) => mutate(s, "      FROM ballot_number_units bu\n    WINDOW w AS", "      FROM ballot_number_units bu WHERE bu.kind IS NOT NULL\n    WINDOW w AS"));
  assert(b !== JSON.stringify([["p2", ["鼓山區 V28里"]]]));
});
