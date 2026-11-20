/**
 * 政策脈絡「現況」（policy-ops#201 第 2 期，協議 1.118.0；migration 20261105200000_lineage_status.sql）。
 *
 * 維護者 2026-11-05：程式可以先寫，但派工開關維持關閉，選前不佔用代理額度（#872 上線時 enabled=false）。
 * **2026-11-20 更正（policy-tw#675 第二期 2b，migration 20261120170000_lineage_arms_start_date.sql）**：規則改成啟用，
 * 輸出由 lineage_settings.dispatch_start_on（起跑日，預設 2026-11-29）決定——起跑日前臂函式回空。所以 B 改守「起跑日前輸出必須為空」：
 * 規則 activity_rules.lineage_status 是啟用的，但起跑日前總表不回這支臂的任何列、seed 不寫 task_dispatches、gap_events 沒有紀錄；跨過起跑日同一批資料立刻出現。
 * （三支臂共用起跑日的遍歷守門與反向守門在 lineage-arms-start-date.test.ts。）
 *
 *   A. 文字層：總表／臂名清單／lineages_full／票數預算候選／兩個 CHECK 都是「前一版加一處」；#872 上線當時規則停用、現行規則啟用且臂函式讀起跑日；SQL 的階段與字數 = TS 常數
 *   B. 起跑日（PGlite，總表＋規則＋seed 跑真的，臂本體用 2b 的真函式）：起跑日前 → 沒有列、沒有派工列、沒有 gap_events；跨過 → 有；還原驗證
 *   C. 臂本體（PGlite，真的 SQL 灌小資料表）：沒有現況、過期天數（階段分兩組）、結案階段不過期、合格政見、在途交件、not_found 冷卻
 *   D. 交件驗證（含撤回／取代）、落庫（新增／覆蓋／較舊的進歷史／撤回／取代／履歷）、前置檢查、唯一出處守門
 *   E. 清點：型別／任務型別／做法／協議文件／標籤，以及 /next 既有任務的輸出不變
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { buildArmsDb, fnText, type GapRow, mutate, P1_MIG, readMig } from "./arms-pglite.ts";
import { CONTRIBUTION_TYPES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { STATUS_PHASES, STATUS_TEXT_MAX, STATUS_TEXT_MIN } from "./lineage.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { hasGuidance, PAYLOAD_SHAPE } from "./task-guidance.ts";
import { applyContribution } from "./apply-contribution.ts";
import { precheckApplyTargets } from "./apply-precheck.ts";
import { soleSourceProblems } from "./sole-source-guard.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { readSkillWithTypes } from "./skill-text.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { shapeTaskCurrent } from "./task-context.ts";

const MIG_NAME = "20261105200000_lineage_status.sql";
const MIG = await readMig(MIG_NAME);
// 現行的貢獻型別 CHECK 由最後一支改它的 migration 決定（二期 20261120160000 加了 lineage_stance／lineage_event）
const TYPES_MIG = await readMig("20261120160000_lineage_stance_event_types.sql");
// 二期 2b：現行的現況臂函式與規則（起跑日機制）
const ARMS_MIG = await readMig("20261120170000_lineage_arms_start_date.sql");
const ONE_MIG = await readMig("20261120120000_lineage_stances_events.sql");
const SETTINGS_ALTERS = [...ONE_MIG.matchAll(/^ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS [^\n]*;$/gm)].map((m) => m[0]).join("\n");
const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const LID = u(1);

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 總表＝20261103010000 的現行定義只多一行 UNION；臂名清單＝20261102010000 的只多一個名字", async () => {
  const prev = fnText(await readMig("20261103010000_roster_gap_units.sql"), "contribution_auto_tasks_arms");
  const now = fnText(MIG, "contribution_auto_tasks_arms");
  const added = "  UNION ALL SELECT 'lineage_status' AS arm, t.* FROM contribution_auto_tasks_lineage_status() t\n";
  assertEquals(now.replace(added, ""), prev);
  const prevNames = fnText(await readMig("20261102010000_issue_subtopics.sql"), "activity_arm_names");
  const nowNames = fnText(MIG, "activity_arm_names");
  assertEquals(nowNames.replace("    'issue_too_broad',\n    'lineage_status'\n", "    'issue_too_broad'\n"), prevNames);
});

Deno.test("A2 lineages_full＝20261019020000 的現行定義只在最後多 status 一欄；票數預算候選只多一個型別", async () => {
  const prevSql = await readMig("20261019020000_lineage_elected_only.sql");
  const cut = (s: string) => s.slice(s.indexOf("CREATE OR REPLACE VIEW lineages_full AS"), s.indexOf("FROM lineages l;") + "FROM lineages l;".length);
  const prev = cut(prevSql), now = cut(MIG);
  const a = now.indexOf("  ) AS links,\n  -- >>> 現況");
  const b = now.indexOf("  -- <<< 現況\n") + "  -- <<< 現況\n".length;
  assert(a > 0 && b > a, "找不到 status 區塊");
  assertEquals(now.slice(0, a) + "  ) AS links\n" + now.slice(b), prev, "除了 status 一欄，視圖一個字不改");
  assertStringIncludes(now, "ORDER BY st.as_of DESC\n    LIMIT 1) AS status");
  const prevVotes = fnText(await readMig("20261102010000_issue_subtopics.sql"), "system_one_vote_budget_candidates");
  assertEquals(fnText(MIG, "system_one_vote_budget_candidates").replace("'policy_subtopics', 'lineage_status')", "'policy_subtopics')"), prevVotes);
});

Deno.test("A3 兩個 CHECK：型別清單＝TS 的 CONTRIBUTION_TYPES；source_refs 目標表＝正式庫現況加 lineage_statuses", () => {
  const a = TYPES_MIG.indexOf("ADD CONSTRAINT contributions_contribution_type_check");
  const chk = TYPES_MIG.slice(a, TYPES_MIG.indexOf(";", a));
  const sqlTypes = [...chk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(sqlTypes.sort(), [...CONTRIBUTION_TYPES].sort(), "SQL CHECK 與 TS 清單要同一組");
  const b = MIG.indexOf("ADD CONSTRAINT source_refs_target_table_check");
  const refs = [...MIG.slice(b, MIG.indexOf(";", b)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  // 2026-11-05 唯讀查正式庫 pg_get_constraintdef 的十個值
  assertEquals(refs, ["policies", "tracking_logs", "policy_elements", "lineage_participants", "handovers", "lineage_links", "politician_careers", "parties", "politician_elections", "regional_stats", "lineage_statuses"]);
});

Deno.test("A4 規則：#872 上線時剛好一條、always、enabled=false；現行（2b）改成 enabled=true，臂函式文字讀起跑日（activity_today() >= dispatch_start_on）", () => {
  // 歷史：#872 上線當時的樣子
  const ins = ruleInsertSql();
  assertStringIncludes(ins, "'lineage_status', 'always', false,");
  assertEquals(MIG.split("INSERT INTO activity_rules").length - 1, 1, "只種這一條規則");
  assertStringIncludes(MIG, "('lineage_status', 6, '政策脈絡')");
  // 現行：二期那支 migration 把它改成啟用，輸出由起跑日決定
  assertStringIncludes(ARMS_MIG, "UPDATE activity_rules SET enabled = true,");
  assertStringIncludes(ARMS_MIG, " WHERE activity = 'lineage_status';");
  const fn = fnText(ARMS_MIG, "contribution_auto_tasks_lineage_status");
  assertStringIncludes(fn, "activity_today() >= st.dispatch_start_on");
  assertStringIncludes(fn, "st.enabled");
});

Deno.test("A5 SQL 的階段、字數＝TS 常數", () => {
  const tbl = MIG.slice(MIG.indexOf("CREATE TABLE IF NOT EXISTS lineage_statuses"), MIG.indexOf("\n);", MIG.indexOf("CREATE TABLE IF NOT EXISTS lineage_statuses")));
  const phases = [...tbl.slice(tbl.indexOf("phase"), tbl.indexOf("text ")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(phases, [...STATUS_PHASES]);
  assertStringIncludes(tbl, `char_length(btrim(text)) BETWEEN ${STATUS_TEXT_MIN} AND ${STATUS_TEXT_MAX}`);
});

Deno.test("A6 這支 migration 不改既有資料：沒有 UPDATE／DELETE 既有表、沒有碰 seed 與計分", () => {
  const code = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assertFalse(/\bDELETE\s+FROM\b/i.test(code.replace(/DELETE FROM source_refs/g, "")), "不刪資料");
  assertFalse(/UPDATE\s+(policies|politicians|lineages\s+SET\s+(title|summary)|politician_elections|task_dispatches|activity_rules)\b/i.test(code), "不改既有資料");
  assertFalse(code.includes("FUNCTION seed_auto_task_queue"), "不碰 seed");
  assertFalse(code.includes("FUNCTION contribution_required_agree"), "不改計分（走預設的 normal，目標分數 3）");
  assertFalse(code.includes("FUNCTION contribution_queue_tasks"), "不碰 /next 的佇列函式");
});

// ============================================================
// B. 起跑日
// ============================================================
function ruleInsertSql(): string {
  const a = MIG.indexOf("INSERT INTO activity_rules");
  return MIG.slice(a, MIG.indexOf("WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'lineage_status');", a) + "WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'lineage_status');".length);
}
const startRuleSql = (): string => ARMS_MIG.slice(ARMS_MIG.indexOf("UPDATE activity_rules SET enabled = true,"), ARMS_MIG.indexOf("INSERT INTO activity_rules (activity, window_kind, enabled, params, note)\nSELECT 'lineage_stances'"));
const P1 = await readMig(P1_MIG);
const OWNER_LINE = "  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t\n";
const ARM_LINE = "  UNION ALL SELECT 'lineage_status' AS arm, t.* FROM contribution_auto_tasks_lineage_status() t\n";
const STATUS_ID = `auto:lineage_status_stale:${LID}:none`;
const stubRow: GapRow = {
  task_id: STATUS_ID, task_type: "lineage_status_stale", target: { lineage_id: LID }, what_we_need: "寫現況", hint_sources: [], reward: 1, region: "全國",
};
const dupRow: GapRow = { task_id: "auto:dup:control", task_type: "duplicate_politician", target: { name: "對照" }, what_we_need: "對照組", hint_sources: [], reward: 1, region: "台北市" };

const lineageSchema = (): string => `
  CREATE TABLE lineages (id uuid PRIMARY KEY, title text, summary text, level text, region text, sub_region text, category text, created_at timestamptz DEFAULT now());
  CREATE TABLE policies (id uuid PRIMARY KEY, lineage_id uuid, removed_at timestamptz);
  CREATE TABLE _ineligible (id uuid PRIMARY KEY);
  CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text, checked_at timestamptz DEFAULT now(), outcome text);
  CREATE FUNCTION policy_is_elected_term(p uuid, d date DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT NOT EXISTS (SELECT 1 FROM _ineligible WHERE id = p) $$;
  ${tableSql("lineage_settings")}
  INSERT INTO lineage_settings (id) VALUES (1);
  ${SETTINGS_ALTERS}
  ${tableSql("lineage_statuses")}
`;

/** P1 的環境（總表、規則、seed、gap_events 跑真的），總表換成「P1 總表＋這支 migration 加的那一行」，臂本體用 2b 的真函式，規則＝#872 上線的那句 INSERT 再套 2b 的啟用 UPDATE */
async function startDateDb(ruleSql: string, armSql: string = fnText(ARMS_MIG, "contribution_auto_tasks_lineage_status"), startRule = startRuleSql()): Promise<PGlite> {
  const db = await buildArmsDb({ extraBranches: ["lineage_status"], branches: { dup: [dupRow] } });
  await db.exec(mutate(fnText(P1, "contribution_auto_tasks_arms"), OWNER_LINE, OWNER_LINE + ARM_LINE));
  await db.exec(`ALTER TABLE contributions ADD COLUMN payload jsonb`);
  await db.exec(lineageSchema());
  await db.exec(ruleSql);
  await db.exec(startRule);
  await db.exec(armSql);
  // 一條合格、沒有現況的脈絡：起跑日之後這支臂就該派它
  await db.exec(`INSERT INTO lineages (id, title, summary, level, region, sub_region, category) VALUES ('${LID}', '脈絡一', '摘要', 'county', '高雄市', NULL, '交通建設')`);
  await db.exec(`INSERT INTO policies VALUES ('${u(1001)}', '${LID}', NULL)`);
  return db;
}
const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
const armTaskIds = async (db: PGlite) => (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_arms() WHERE arm = 'lineage_status' ORDER BY 1`)).map((r) => r.task_id);

/** 起跑日前的全部斷言；回傳是否全過（還原驗證用） */
async function beforeStartHolds(armSql?: string, startRule?: string): Promise<boolean> {
  const db = await startDateDb(ruleInsertSql(), armSql, startRule);
  const rule = (await rows<{ enabled: boolean; window_kind: string }>(db, `SELECT enabled, window_kind FROM activity_rules WHERE activity = 'lineage_status'`));
  if (rule.length !== 1 || rule[0].enabled !== true || rule[0].window_kind !== "always") return false; // 規則是啟用的
  await db.exec(`SET app.activity_today = '2026-11-28'`); // 起跑日（2026-11-29）前一天
  if ((await armTaskIds(db)).length !== 0) return false; // 總表不回這支臂
  await db.exec(`SELECT seed_auto_task_queue()`);
  const dispatched = await rows(db, `SELECT task_id FROM task_dispatches WHERE task_type = 'lineage_status_stale'`);
  const events = await rows(db, `SELECT 1 FROM gap_events WHERE task_type = 'lineage_status_stale'`);
  const control = await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = 'auto:dup:control'`);
  return dispatched.length === 0 && events.length === 0 && control.length === 1; // 對照組照常派，證明不是整個 seed 壞了
}

Deno.test("B1 起跑日前（用 SET app.activity_today 注入假時鐘）：總表不回、seed 不寫 task_dispatches、gap_events 沒有紀錄，其他臂照常", async () => {
  assert(await beforeStartHolds());
});

Deno.test("B2 對照：同一批資料跨過起跑日（2026-11-29）→ 總表回、seed 寫派工列（帶規則）；起跑日改晚 → seed 下一輪收回", async () => {
  const db = await startDateDb(ruleInsertSql());
  await db.exec(`SET app.activity_today = '2026-11-28'`);
  assertEquals(await armTaskIds(db), []);
  await db.exec(`SET app.activity_today = '2026-11-29'`);
  assertEquals(await armTaskIds(db), [STATUS_ID], "起跑日當天就開（證明 B1 的空不是因為臂本身壞了）");
  await db.exec(`SELECT seed_auto_task_queue()`);
  const d = await rows<{ task_type: string; basis: string; arm: string }>(db, `SELECT task_type, opened_by->>'basis' AS basis, opened_by->>'arm' AS arm FROM task_dispatches WHERE task_id = '${STATUS_ID}'`);
  assertEquals(d, [{ task_type: "lineage_status_stale", basis: "rule", arm: "lineage_status" }]);
  await db.exec(`UPDATE lineage_settings SET dispatch_start_on = '2027-01-01' WHERE id = 1`);
  await db.exec(`SELECT seed_auto_task_queue()`);
  assertEquals((await rows(db, `SELECT 1 FROM task_dispatches WHERE task_id = '${STATUS_ID}'`)).length, 0, "起跑日改晚之後下一輪 seed 收回");
});

Deno.test("B3 還原驗證：把臂函式裡的起跑日條件拿掉 → B1 的守門會紅；規則回到停用的舊版 → 『規則是啟用的』那條也會紅", async () => {
  const bad = mutate(fnText(ARMS_MIG, "contribution_auto_tasks_lineage_status"), " AND activity_today() >= st.dispatch_start_on", "");
  assertFalse(await beforeStartHolds(bad), "壞版本（沒有起跑日條件）必須被守門抓到");
  assertFalse(await beforeStartHolds(undefined, "SELECT 1;"), "規則沒被改成啟用也要被抓到");
});

Deno.test("B4 還原驗證：規則漏種 → 總表 RAISE（新臂漏登記不是無聲消失）", async () => {
  const db = await buildArmsDb({ extraBranches: ["lineage_status"], branches: { lineage_status: [stubRow] } });
  await db.exec(mutate(fnText(P1, "contribution_auto_tasks_arms"), OWNER_LINE, OWNER_LINE + ARM_LINE));
  let raised = "";
  try {
    await rows(db, `SELECT * FROM contribution_auto_tasks_arms()`);
  } catch (e) {
    raised = e instanceof Error ? e.message : String(e);
  }
  assertStringIncludes(raised, "lineage_status");
});

// ============================================================
// C. 臂本體
// ============================================================
const tableSql = (name: string) => {
  const a = MIG.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  return MIG.slice(a, MIG.indexOf("\n);", a) + 3);
};
async function armDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE lineages (id uuid PRIMARY KEY, title text, summary text, level text, region text, sub_region text, category text, created_at timestamptz DEFAULT now());
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, task_type text);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb);
    CREATE TABLE policies (id uuid PRIMARY KEY, lineage_id uuid, removed_at timestamptz);
    CREATE TABLE _ineligible (id uuid PRIMARY KEY);
    CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text, checked_at timestamptz DEFAULT now(), outcome text);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT '2026-11-05'::date $$;
    CREATE FUNCTION policy_is_elected_term(p uuid, d date DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT NOT EXISTS (SELECT 1 FROM _ineligible WHERE id = p) $$;
    ${tableSql("lineage_settings")}
    INSERT INTO lineage_settings (id) VALUES (1);
    ${SETTINGS_ALTERS}
    UPDATE lineage_settings SET dispatch_start_on = '2026-01-01', open_cap_per_arm = NULL;
    ${tableSql("lineage_statuses")}
  `);
  // 臂本體＝二期（起跑日）的現行定義；C 守的條件（過期天數、階段、在途交件、冷卻）與 #872 一字不差，起跑日在這裡設成過去
  await db.exec(fnText(ARMS_MIG, "contribution_auto_tasks_lineage_status"));
  return db;
}
const day = (back: number) => new Date(Date.UTC(2026, 10, 5) - back * 86400000).toISOString().slice(0, 10);
async function addLineage(db: PGlite, n: number, opts: { eligible?: boolean; status?: [string, number, string?] } = {}) {
  await db.query(`INSERT INTO lineages VALUES ($1, $2, '摘要', 'county', '高雄市', NULL, '交通建設')`, [u(n), `脈絡${n}`]);
  await db.query(`INSERT INTO policies VALUES ($1, $2, NULL)`, [u(1000 + n), u(n)]);
  if (opts.eligible === false) await db.query(`INSERT INTO _ineligible VALUES ($1)`, [u(1000 + n)]);
  if (opts.status) {
    await db.query(`INSERT INTO lineage_statuses (lineage_id, phase, text, as_of, source_url, source_locator) VALUES ($1, $2, '現況一句話，長度夠。', $3, 'https://www.gov.tw/a', '第 1 點')`, [u(n), opts.status[0], day(opts.status[1])]);
  }
}
const due = async (db: PGlite) => (await rows<{ task_id: string; target: Record<string, unknown>; region: string }>(db, `SELECT task_id, target, region FROM contribution_auto_tasks_lineage_status() ORDER BY task_id`));

Deno.test("C1 沒有現況 → 派（task_id 尾段 none、reason none、沒有 current）；有合格政見才算", async () => {
  const db = await armDb();
  await addLineage(db, 1);
  await addLineage(db, 2, { eligible: false });
  await db.query(`UPDATE policies SET removed_at = now() WHERE id = $1`, [u(1002)]);
  const r = await due(db);
  assertEquals(r.map((x) => x.task_id), [`auto:lineage_status_stale:${u(1)}:none`]);
  assertEquals(r[0].target.reason, "none");
  assertEquals(r[0].target.lineage_id, u(1));
  assertFalse("current" in r[0].target);
  assertEquals(r[0].region, "高雄市");
});

Deno.test("C2 過期天數看階段：approved／in_progress 90 天、proposed／planning／paused 180 天；剛好等於天數不算過期", async () => {
  const db = await armDb();
  await addLineage(db, 1, { status: ["approved", 90] }); // 剛好 90：不算
  await addLineage(db, 2, { status: ["in_progress", 91] }); // 過期
  await addLineage(db, 3, { status: ["planning", 150] }); // 沒到 180
  await addLineage(db, 4, { status: ["paused", 181] }); // 過期
  await addLineage(db, 5, { status: ["proposed", 200] }); // 過期
  const r = await due(db);
  assertEquals(r.map((x) => x.task_id).sort(), [
    `auto:lineage_status_stale:${u(2)}:${day(91)}`, `auto:lineage_status_stale:${u(4)}:${day(181)}`, `auto:lineage_status_stale:${u(5)}:${day(200)}`,
  ].sort());
  const t2 = r.find((x) => x.task_id.includes(u(2)))!;
  assertEquals(t2.target.reason, "stale");
  assertEquals((t2.target.current as Record<string, unknown>).phase, "in_progress");
  assertEquals((t2.target.current as Record<string, unknown>).as_of, day(91));
});

Deno.test("C3 結案階段（completed／cancelled）不會過期；現行是最大 as_of 那一列", async () => {
  const db = await armDb();
  await addLineage(db, 1, { status: ["completed", 2000] });
  await addLineage(db, 2, { status: ["cancelled", 2000] });
  await addLineage(db, 3, { status: ["in_progress", 400] }); // 舊的過期列……
  await db.query(`INSERT INTO lineage_statuses (lineage_id, phase, text, as_of, source_url, source_locator) VALUES ($1, 'in_progress', '較新的現況一句話。', $2, 'https://www.gov.tw/b', '第 2 點')`, [u(3), day(10)]); // ……被新的一列取代
  assertEquals((await due(db)).length, 0);
});

Deno.test("C4 設定表生效：改 status_stale_days_active 後同一筆現況變成過期；函式裡沒有寫死天數", async () => {
  const db = await armDb();
  await addLineage(db, 1, { status: ["approved", 40] });
  assertEquals((await due(db)).length, 0);
  await db.exec(`UPDATE lineage_settings SET status_stale_days_active = 30 WHERE id = 1`);
  assertEquals((await due(db)).length, 1);
  const body = fnText(MIG, "contribution_auto_tasks_lineage_status");
  assertFalse(/\b(90|180|60)\b/.test(body.replace(/'[^']*'/g, "")), "天數只能來自 lineage_settings");
});

Deno.test("C5 在途的 lineage_status 交件（pending／verified／disputed／apply_failed）擋掉；applied／rejected 與別條脈絡的不擋", async () => {
  const db = await armDb();
  for (const n of [1, 2, 3, 4, 5, 6]) await addLineage(db, n);
  const put = (status: string, lid: string) => db.query(`INSERT INTO contributions (contribution_type, status, payload) VALUES ('lineage_status', $1, jsonb_build_object('lineage_id', $2::text))`, [status, lid]);
  await put("pending", u(1));
  await put("verified", u(2));
  await put("disputed", u(3));
  await put("applied", u(4));
  await put("rejected", u(5));
  await db.query(`INSERT INTO contributions (contribution_type, status, payload) VALUES ('lineage_handover', 'pending', jsonb_build_object('lineage_id', $1::text))`, [u(6)]);
  assertEquals((await due(db)).map((x) => x.target.lineage_id).sort(), [u(4), u(5), u(6)].sort());
});

Deno.test("C6 not_found 冷卻：gap_not_found_days 內不派（不比指紋）；過了、或結論是 confirmed／別條脈絡的不擋", async () => {
  const db = await armDb();
  for (const n of [1, 2, 3, 4, 5]) await addLineage(db, n);
  const check = (lid: string, tail: string, outcome: string, daysAgo: number) =>
    db.query(`INSERT INTO task_checks (task_id, outcome, checked_at) VALUES ($1, $2, now() - make_interval(days => $3))`, [`auto:lineage_status_stale:${lid}:${tail}`, outcome, daysAgo]);
  await check(u(1), "none", "not_found", 10); // 冷卻內
  await check(u(2), "2025-01-01", "not_found", 30); // 舊指紋也擋（換號不能繞過冷卻）
  await check(u(3), "none", "not_found", 61); // 過了
  await check(u(4), "none", "confirmed", 1); // 結論不是 not_found
  await check(u(99), "none", "not_found", 1); // 別條脈絡
  assertEquals((await due(db)).map((x) => x.target.lineage_id).sort(), [u(3), u(4), u(5)].sort());
  await db.exec(`UPDATE lineage_settings SET gap_not_found_days = 5 WHERE id = 1`);
  assertEquals((await due(db)).length, 5, "冷卻天數改 5：10 天前、30 天前的都過了");
});

// ============================================================
// D. 交件驗證、落庫、前置檢查
// ============================================================
const SRC = "https://www.kcg.gov.tw/news/1";
const goodStatus = (over: Record<string, unknown> = {}) => ({
  lineage_id: LID, phase: "in_progress", text: "高雄市政府已於 2026 年 9 月完成工程招標並開工。", as_of: "2026-09-30", source_locator: "新聞稿第 2 段", ...over,
});
const check = (payload: Record<string, unknown>, sourceUrls: string[] = [SRC]) =>
  validateContributionRequest({ agent_name: "tester", contributions: [{ contribution_type: "lineage_status", payload, source_urls: sourceUrls }] }).errors;

Deno.test("D1 交件驗證：合法的過（含選填 task_id／note／source_url）", () => {
  assertEquals(check(goodStatus()), []);
  assertEquals(check(goodStatus({ task_id: `auto:lineage_status_stale:${LID}:none`, note: "備註", source_url: SRC })), []);
  assertEquals(check(goodStatus({ replace_as_of: "2026-06-01" })), []);
});

Deno.test("D2 交件驗證：必填欄、階段、字數、日期（不能是未來、不能不是真的日期）、出處", () => {
  const bad = (over: Record<string, unknown>, path: string, urls?: string[]) => assert(check(goodStatus(over), urls).some((e) => e.path.startsWith(path)), `${path}：${JSON.stringify(over)}`);
  bad({ lineage_id: "x" }, "payload.lineage_id");
  bad({ phase: "unknown" }, "payload.phase");
  bad({ phase: undefined }, "payload.phase");
  bad({ text: "太短了" }, "payload.text");
  bad({ text: "字".repeat(STATUS_TEXT_MAX + 1) }, "payload.text");
  bad({ as_of: "2026-13-40" }, "payload.as_of");
  bad({ as_of: undefined }, "payload.as_of");
  bad({ as_of: "2099-01-01" }, "payload.as_of");
  bad({ source_locator: "" }, "payload.source_locator");
  bad({ source_url: "https://other.example/x" }, "payload.source_url");
  bad({ replace_as_of: "2026-09-30" }, "payload.replace_as_of"); // 跟 as_of 一樣
  bad({ replace_as_of: "亂寫" }, "payload.replace_as_of");
  bad({}, "source_urls", ["https://www.facebook.com/someone/posts/1"]); // 讀不到的社群
  assertEquals(check(goodStatus({ text: "字".repeat(STATUS_TEXT_MAX) })), []);
  assertEquals(check(goodStatus({ text: "字".repeat(STATUS_TEXT_MIN) })), []);
});

Deno.test("D3 撤回：只要 lineage_id＋as_of＋note（20～300 字）；不能同時取代；其他內容欄不必填", () => {
  const rm = { lineage_id: LID, remove: true, as_of: "2026-09-30", note: "這一列的截至日是新聞發布日，出處內文寫的是 8 月的狀態，日期填錯了。" };
  assertEquals(check(rm), []);
  assert(check({ ...rm, note: "太短" }).some((e) => e.path === "payload.note"));
  assert(check({ ...rm, replace_as_of: "2026-06-01" }).some((e) => e.path === "payload.replace_as_of"));
  assert(check({ ...rm, as_of: undefined }).some((e) => e.path === "payload.as_of"));
});

Deno.test("D4 唯一出處：現況只有一家媒體要被擋；官方來源過；撤回不受限", () => {
  const media = ["https://news.ltn.com.tw/a"];
  assertEquals(soleSourceProblems([{ contribution_type: "lineage_status", source_urls: media, payload: goodStatus() }]).length, 1);
  assertStringIncludes(soleSourceProblems([{ contribution_type: "lineage_status", source_urls: media, payload: goodStatus() }])[0].message, "現況");
  assertEquals(soleSourceProblems([{ contribution_type: "lineage_status", source_urls: [SRC], payload: goodStatus() }]).length, 0);
  assertEquals(soleSourceProblems([{ contribution_type: "lineage_status", source_urls: [...media, "https://udn.com/b"], payload: goodStatus() }]).length, 0);
  assertEquals(soleSourceProblems([{ contribution_type: "lineage_status", source_urls: media, payload: { lineage_id: LID, remove: true, as_of: "2026-09-30" } }]).length, 0);
});

const row = (payload: Record<string, unknown>, id = "c-1") => ({
  id, contribution_type: "lineage_status" as (typeof CONTRIBUTION_TYPES)[number], payload, source_urls: [SRC], note: null, agent_name: "tester", contributor_url: null,
});
const world = (statuses: Array<Record<string, unknown>> = []) => createFakeSupabase({ lineages: [{ id: LID, title: "高雄捷運黃線" }], lineage_statuses: statuses, edit_history: [] });
const existing = (asOf: string, text = "原本的現況一句話，長度夠。", id = "s-" + asOf) => ({
  id, lineage_id: LID, phase: "planning", text, as_of: asOf, source_url: SRC, source_locator: "第 1 點", contribution_id: "c-0",
});

Deno.test("D5 落庫：新增一列（帶 contribution_id）、記 edit_history 整列", async () => {
  const fake = world();
  const out = await applyContribution(fake.client, row(goodStatus()));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.lineage_statuses.length, 1);
  const r = fake.db.lineage_statuses[0];
  assertEquals([r.lineage_id, r.phase, r.as_of, r.source_url, r.source_locator, r.contribution_id], [LID, "in_progress", "2026-09-30", SRC, "新聞稿第 2 段", "c-1"]);
  assert(fake.db.edit_history.some((e) => e.table_name === "lineage_statuses" && e.field === "*" && e.new_value));
});

Deno.test("D6 落庫：同截至日重交＝覆蓋（逐欄記履歷）；完全一樣 → superseded；較舊的截至日照樣新增一列（不動較新的）", async () => {
  const fake = world([existing("2026-09-30")]);
  const out = await applyContribution(fake.client, row(goodStatus(), "c-2"));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.lineage_statuses.length, 1);
  assertEquals(fake.db.lineage_statuses[0].phase, "in_progress");
  const fields = fake.db.edit_history.filter((e) => e.table_name === "lineage_statuses" && e.field !== "*").map((e) => e.field).sort();
  assert(fields.includes("phase") && fields.includes("text") && fields.includes("source_locator"));
  assertEquals((await applyContribution(fake.client, row(goodStatus(), "c-3"))).status, "superseded");
  const older = await applyContribution(fake.client, row(goodStatus({ as_of: "2026-03-01", text: "較早之前的現況一句話，長度夠。" }), "c-4"));
  assertEquals(older.status, "applied");
  assertEquals(fake.db.lineage_statuses.map((r) => r.as_of).sort(), ["2026-03-01", "2026-09-30"], "歷史留著");
});

Deno.test("D7 落庫：撤回刪掉那一列並把整列記進履歷（可還原）；本來就沒有 → superseded", async () => {
  const fake = world([existing("2026-09-30"), existing("2026-05-01")]);
  const out = await applyContribution(fake.client, row({ lineage_id: LID, remove: true, as_of: "2026-09-30", note: "日期填成發布日，出處內文寫的是更早的狀態，這一列是錯的。" }));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.lineage_statuses.map((r) => r.as_of), ["2026-05-01"], "視圖會自動退回次新的一列");
  const h = fake.db.edit_history.find((e) => e.table_name === "lineage_statuses" && e.field === "*" && e.new_value === null);
  assert(h && (h.old_value as Record<string, unknown>).as_of === "2026-09-30", "被刪的整列在履歷裡");
  const again = await applyContribution(fake.client, row({ lineage_id: LID, remove: true, as_of: "2026-09-30", note: "日期填成發布日，出處內文寫的是更早的狀態，這一列是錯的。" }, "c-2"));
  assertEquals(again.status, "superseded");
});

Deno.test("D8 落庫：取代＝刪舊截至日那一列＋寫新的一筆；兩邊都記履歷", async () => {
  const fake = world([existing("2026-06-01")]);
  const out = await applyContribution(fake.client, row(goodStatus({ replace_as_of: "2026-06-01" })));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.lineage_statuses.map((r) => r.as_of), ["2026-09-30"]);
  assertStringIncludes(out.message, "取代");
  const kinds = fake.db.edit_history.filter((e) => e.field === "*").map((e) => (e.new_value === null ? "delete" : "insert")).sort();
  assertEquals(kinds, ["delete", "insert"]);
});

Deno.test("D9 落庫：脈絡不存在 → failed", async () => {
  const fake = createFakeSupabase({ lineages: [], lineage_statuses: [], edit_history: [] });
  assertEquals((await applyContribution(fake.client, row(goodStatus()))).status, "failed");
  assertEquals(fake.db.lineage_statuses.length, 0);
});

Deno.test("D10 前置檢查：脈絡不存在、撤回／取代指到不存在的那一列 → target_not_found；存在的不擋；查詢出錯放行", async () => {
  const fake = world([existing("2026-06-01")]);
  const run = (payload: Record<string, unknown>) => precheckApplyTargets(fake.client, [{ contribution_type: "lineage_status", payload }], new Set());
  assertEquals(await run(goodStatus()), []);
  assertEquals((await run(goodStatus({ lineage_id: u(99) }))).map((p) => [p.code, p.path]), [["target_not_found", "payload.lineage_id"]]);
  assertEquals(await run(goodStatus({ replace_as_of: "2026-06-01" })), []);
  assertEquals((await run(goodStatus({ replace_as_of: "2026-07-07" }))).map((p) => [p.code, p.path]), [["target_not_found", "payload.replace_as_of"]]);
  assertEquals(await run({ lineage_id: LID, remove: true, as_of: "2026-06-01", note: "x".repeat(25) }), []);
  assertEquals((await run({ lineage_id: LID, remove: true, as_of: "2026-01-01", note: "x".repeat(25) })).map((p) => p.path), ["payload.as_of"]);
  const flaky = { from: (t: string) => (t === "lineage_statuses" ? { select: () => ({ in: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) } : fake.client.from(t)) };
  assertEquals(await precheckApplyTargets(flaky, [{ contribution_type: "lineage_status", payload: goodStatus({ replace_as_of: "2026-07-07" }) }], new Set()), []);
});

// ============================================================
// E. 清點
// ============================================================
Deno.test("E1 型別清點：交件型別／任務型別／SUGGESTED_TYPE／做法／標籤（純中文）／協議說明", async () => {
  assert((CONTRIBUTION_TYPES as readonly string[]).includes("lineage_status"));
  assert((TASK_TYPES as readonly string[]).includes("lineage_status_stale"));
  assertEquals(SUGGESTED_TYPE.lineage_status_stale, "lineage_status");
  assert(hasGuidance("lineage_status_stale"));
  assert(PAYLOAD_SHAPE.lineage_status);
  const lib = async (f: string) => await Deno.readTextFile(new URL(`../../../lib/${f}`, import.meta.url));
  for (const [file, key] of [["task-labels.ts", "lineage_status_stale"], ["model-quality.ts", "lineage_status"], ["dispatch-schedule.ts", "lineage_status"]]) {
    const label = (await lib(file)).match(new RegExp(`\\b${key}:\\s*'([^']*)'`))?.[1] ?? "";
    assert(label && !/[A-Za-z]/.test(label), `${file} 的中文名稱要有且不夾英文字母`);
  }
  const skill = await readSkillWithTypes();
  assertStringIncludes(skill, "`lineage_status`");
  assertStringIncludes(skill, "lineage_status_stale");
  assertStringIncludes(skill, "沒有新消息不等於新截至日");
});

Deno.test("E2 協議版號：skill.md 檔頭與 protocol.ts 一致、不低於 1.118.0", async () => {
  const head = (await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url))).match(/\*\*版本\*\*：(\d+\.\d+\.\d+)/)?.[1];
  assertEquals(head, PROTOCOL_VERSION);
  const [maj, min] = PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 1 || min >= 118);
});

Deno.test("E3 /next 既有任務的輸出不變：沒有現況的脈絡，既有三種脈絡任務的 current 不多任何欄位；有現況才多 status", () => {
  const lineage = { id: LID, title: "高雄捷運黃線", summary: "摘要", category: "交通建設", level: "county", region: "高雄市", policy_ids: [], participants: [], handovers: [], links: [] };
  for (const type of ["handover_missing", "lineage_roles_missing"]) {
    const cur = shapeTaskCurrent(type, { lineage, lineage_policies: [] } as never) as { lineage: Record<string, unknown> };
    assertFalse("status" in cur.lineage, `${type}：現況表還沒資料時 lineage 不多 status 欄`);
  }
  const withStatus = shapeTaskCurrent("lineage_status_stale", { lineage: { ...lineage, status: { phase: "in_progress", text: "施工中的一句話", as_of: "2026-09-30", source_url: SRC, source_locator: "x", extra: 1 } }, lineage_policies: [] } as never) as { lineage: Record<string, unknown> };
  assertEquals(withStatus.lineage.status, { phase: "in_progress", text: "施工中的一句話", as_of: "2026-09-30", source_url: SRC, source_locator: "x" });
});

Deno.test("E4 /next 與派工函式沒被改：migration 沒有重定義 /next 用到的佇列函式、既有任務型別的做法文字沒變", () => {
  for (const f of ["contribution_queue_tasks", "contribution_auto_tasks", "contribution_auto_tasks_lineage_candidates", "contribution_auto_tasks_handover_missing", "contribution_auto_tasks_lineage_roles", "contribution_auto_tasks_lineage_links"]) {
    assertFalse(MIG.includes(`FUNCTION ${f}(`), `${f} 不能在這支 migration 被改`);
  }
});
