/**
 * 政見三要素（#364，2026-10-05；與日本站 keifu 的 policy_elements 同一套）的守門測試。
 *
 * 這件事的核心只有一個分別：**沒有列＝未調查（我們還沒查）；有列而 stated=false＝未說明（查過原文、他沒寫）**。
 * 兩者一混，網站就會把「我們沒查」講成「他沒說」。所以這裡守的是：
 *   1. 交件 schema：沒寫就不能有文字、有寫就要有文字（120 字）、每個要素都要附原句位置、期限日期只在原文寫了的期限上
 *   2. 落庫：一個要素一列、重交就覆蓋（每欄寫查核履歷）、全部一樣就 superseded、移除的政見不收
 *   3. SQL 與 TS 同一套數字（字數上限、要素清單）；資料表約束把同一個分別擋在資料庫
 *   4. 派工臂：範圍、等票中的不派、期限到了的條件、跟 progress_stale 不重複；migration 不寫任何一筆資料（資料走流程）
 *   5. 任務與驗證送給代理的說明講得出「未說明／未調查」、骨架只列還缺的要素
 * SQL 本身另外在 PGlite（WASM Postgres）上實跑過，見 PR 說明；這裡沒有資料庫。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { CONTRIBUTION_TYPES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { applyContribution } from "./apply-contribution.ts";
import { precheckApplyTargets } from "./apply-precheck.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import {
  changedElementFields,
  charLength,
  isRealDate,
  missingElements,
  POLICY_ELEMENT_KINDS,
  POLICY_ELEMENT_TEXT_MAX,
  policyElementValues,
} from "./policy-elements.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { buildReportTemplate, PAYLOAD_SHAPE, TASK_GUIDANCE } from "./task-guidance.ts";
import { POLICY_ELEMENTS_VERIFY_HINT, shapeTaskCurrent, shapeVerifyCurrent } from "./task-context.ts";
import { riskLevel } from "./consensus.ts";
import { SINGLE_ANSWER_TASK_TYPES } from "./single-answer-guard.ts";

const POLICY = "00000000-0000-4000-8000-000000000001";
const BULLETIN = "https://bulletin.cec.gov.tw/2026/some-district.pdf";
const SITE = "https://candidate.example.tw/policy";

type Obj = Record<string, unknown>;

function submit(elements: unknown, sourceUrls: string[] = [BULLETIN], extra: Obj = {}) {
  return validateContributionRequest({
    agent_name: "tester",
    contribution_type: "policy_elements",
    payload: { policy_id: POLICY, elements, ...extra },
    source_urls: sourceUrls,
  });
}
const errorPaths = (r: ReturnType<typeof validateContributionRequest>) => r.errors.map((e) => e.path);

// ── 1. 交件 schema ────────────────────────────────────────────────────────────

Deno.test("三要素交件：三個要素、有寫與沒寫混著交，都收", () => {
  const r = submit([
    { element: "target", stated: true, text: "新建社會住宅 3,000 戶", source_locator: "公報第 2 頁〈居住〉第 1 點" },
    { element: "deadline", stated: true, text: "2028 年前完工", deadline_date: "2028-12-31", source_locator: "公報第 2 頁〈居住〉第 1 點" },
    { element: "funding", stated: false, source_locator: "公報第 2 頁〈居住〉全段" },
  ]);
  assertEquals(r.errors, []);
  assert(r.ok);
});

Deno.test("三要素交件：只交其中一個也可以（沒交的要素留著＝未調查）", () => {
  const r = submit([{ element: "funding", stated: false, source_locator: "官網政見頁第 3 段" }]);
  assert(r.ok, JSON.stringify(r.errors));
});

Deno.test("三要素交件：原文有寫就要有文字，沒寫就不能有文字（不可以拿「未說明」當內容）", () => {
  const noText = submit([{ element: "target", stated: true, source_locator: "第 1 頁" }]);
  assert(errorPaths(noText).includes("payload.elements[0].text"), "stated=true 沒有 text 要擋");
  const blank = submit([{ element: "target", stated: true, text: "   ", source_locator: "第 1 頁" }]);
  assert(errorPaths(blank).includes("payload.elements[0].text"), "只有空白也算沒寫");
  const filled = submit([{ element: "funding", stated: false, text: "未說明", source_locator: "第 1 頁" }]);
  assert(errorPaths(filled).includes("payload.elements[0].text"), "stated=false 卻有文字要擋——那是在冒充內容");
  const noStated = submit([{ element: "funding", source_locator: "第 1 頁" }]);
  assert(errorPaths(noStated).includes("payload.elements[0].stated"), "stated 必填，不可以靠有沒有 text 猜");
});

Deno.test("三要素交件：text 120 字為上限，算字元不算 UTF-16 單位（罕用字不多算）", () => {
  const exact = "一".repeat(POLICY_ELEMENT_TEXT_MAX);
  assert(submit([{ element: "target", stated: true, text: exact, source_locator: "p.1" }]).ok, "剛好 120 字要收");
  const over = `${exact}一`;
  assert(errorPaths(submit([{ element: "target", stated: true, text: over, source_locator: "p.1" }])).includes("payload.elements[0].text"));
  // 𦰡（U+26C21）在 UTF-16 是兩個單位：120 個字元的 .length 是 240，但 SQL char_length 是 120
  const rare = "𦰡".repeat(POLICY_ELEMENT_TEXT_MAX);
  assertEquals(charLength(rare), POLICY_ELEMENT_TEXT_MAX);
  assert(submit([{ element: "target", stated: true, text: rare, source_locator: "p.1" }]).ok, "罕用字照字元算，跟 SQL 一致");
});

Deno.test("三要素交件：每個要素都要附原句位置，原文沒寫的也一樣（要講得出查的是哪一段）", () => {
  const r = submit([
    { element: "target", stated: true, text: "3 座", source_locator: "" },
    { element: "funding", stated: false },
  ]);
  assert(errorPaths(r).includes("payload.elements[0].source_locator"));
  assert(errorPaths(r).includes("payload.elements[1].source_locator"), "stated=false 也要原句位置");
});

Deno.test("三要素交件：期限日期只放在原文寫了的達成期限，而且要是真的日期", () => {
  const onTarget = submit([{ element: "target", stated: true, text: "3 座", deadline_date: "2028-12-31", source_locator: "p.1" }]);
  assert(errorPaths(onTarget).includes("payload.elements[0].deadline_date"), "數值目標不能帶期限日期");
  const notStated = submit([{ element: "deadline", stated: false, deadline_date: "2028-12-31", source_locator: "p.1" }]);
  assert(errorPaths(notStated).includes("payload.elements[0].deadline_date"), "原文沒寫期限就沒有日期可換");
  const fake = submit([{ element: "deadline", stated: true, text: "2028 年 2 月底", deadline_date: "2028-02-30", source_locator: "p.1" }]);
  assert(errorPaths(fake).includes("payload.elements[0].deadline_date"), "2028-02-30 不存在");
  const roc = submit([{ element: "deadline", stated: true, text: "民國 117 年前", deadline_date: "0117-12-31", source_locator: "p.1" }]);
  assert(errorPaths(roc).includes("payload.elements[0].deadline_date"), "民國年要換成西元");
  const noDate = submit([{ element: "deadline", stated: true, text: "儘速完成", source_locator: "p.1" }]);
  assert(noDate.ok, "換不成日期的期限只填 text 就好");
  assert(isRealDate("2028-12-31") && !isRealDate("2028-02-30") && !isRealDate("2028/12/31"));
});

Deno.test("三要素交件：同一個要素不能交兩次；要素名稱、個數、policy_id 都要對", () => {
  const dup = submit([
    { element: "target", stated: true, text: "3 座", source_locator: "p.1" },
    { element: "target", stated: false, source_locator: "p.2" },
  ]);
  assert(errorPaths(dup).includes("payload.elements[1].element"));
  assert(errorPaths(submit([{ element: "budget", stated: false, source_locator: "p.1" }])).includes("payload.elements[0].element"));
  assert(errorPaths(submit([])).includes("payload.elements"));
  const four = Array.from({ length: 4 }, () => ({ element: "target", stated: false, source_locator: "p.1" }));
  assert(errorPaths(submit(four)).includes("payload.elements"));
  const noPolicy = validateContributionRequest({
    agent_name: "tester", contribution_type: "policy_elements",
    payload: { elements: [{ element: "target", stated: false, source_locator: "p.1" }] }, source_urls: [BULLETIN],
  });
  assert(errorPaths(noPolicy).includes("payload.policy_id"));
});

Deno.test("三要素交件：要素指的出處要是這筆 source_urls 之一（驗證者只會打開 source_urls）", () => {
  const ok = submit([{ element: "target", stated: true, text: "3 座", source_locator: "p.1", source_url: SITE }], [BULLETIN, SITE]);
  assert(ok.ok, JSON.stringify(ok.errors));
  const elsewhere = submit([{ element: "target", stated: true, text: "3 座", source_locator: "p.1", source_url: "https://other.example.tw/x" }], [BULLETIN]);
  assert(errorPaths(elsewhere).includes("payload.elements[0].source_url"));
});

// ── 2. 正規化與落庫 ──────────────────────────────────────────────────────────

Deno.test("寫進資料表的值：沒寫的文字與日期一律 NULL，出處沒指名就是第一個來源", () => {
  const v = policyElementValues({ element: "funding", stated: false, text: "（應該被丟掉）", deadline_date: "2028-12-31", source_locator: " 全段 " }, [BULLETIN, SITE]);
  assertEquals(v, { element: "funding", stated: false, text: null, deadline_date: null, source_url: BULLETIN, source_locator: "全段" });
  const d = policyElementValues({ element: "deadline", stated: true, text: " 2028 年前 ", deadline_date: "2028-12-31", source_locator: "p.1", source_url: SITE }, [BULLETIN, SITE]);
  assertEquals(d.text, "2028 年前");
  assertEquals(d.deadline_date, "2028-12-31");
  assertEquals(d.source_url, SITE);
  assertEquals(missingElements([{ element: "deadline" }]), ["target", "funding"]);
  assertEquals(changedElementFields({ stated: true, text: "3 座", deadline_date: null, source_url: BULLETIN, source_locator: "p.1" }, { ...d, element: "target", text: "3 座", deadline_date: null, source_url: BULLETIN, source_locator: "p.1" }), []);
});

function row(payload: Obj, sourceUrls: string[] = [BULLETIN]) {
  return { id: "11111111-1111-4111-8111-111111111111", contribution_type: "policy_elements" as const, payload, source_urls: sourceUrls, note: null, agent_name: "tester", contributor_url: null };
}

Deno.test("落庫：沒有的要素新增一列（查核履歷記整列），回 policy_id", async () => {
  const fake = createFakeSupabase({ policies: [{ id: POLICY, title: "社會住宅 3,000 戶", removed_at: null }], policy_elements: [], edit_history: [] });
  const out = await applyContribution(fake.client, row({
    policy_id: POLICY,
    elements: [
      { element: "target", stated: true, text: "新建社會住宅 3,000 戶", source_locator: "p.2" },
      { element: "funding", stated: false, source_locator: "p.2 全段" },
    ],
  }));
  assertEquals(out.status, "applied", out.message);
  assertEquals(out.policy_id, POLICY);
  const rows = fake.db.policy_elements;
  assertEquals(rows.length, 2);
  const funding = rows.find((r) => r.element === "funding")!;
  assertEquals(funding.stated, false);
  assertEquals(funding.text, null, "未說明的那一列沒有文字");
  assertEquals(funding.source_url, BULLETIN, "未說明也記查的是哪份原文");
  assertEquals(funding.contribution_id, "11111111-1111-4111-8111-111111111111");
  assertEquals(fake.db.edit_history.filter((e) => e.field === "*" && e.table_name === "policy_elements").length, 2);
  assertStringIncludes(out.message, "財源：未說明");
});

Deno.test("落庫：已經有的要素照這次覆蓋，只動變了的欄位、每欄記一筆；全部一樣就 superseded", async () => {
  const existing = { id: "e1", policy_id: POLICY, element: "deadline", stated: false, text: null, deadline_date: null, source_url: BULLETIN, source_locator: "p.2" };
  const fake = createFakeSupabase({ policies: [{ id: POLICY, title: "社宅", removed_at: null }], policy_elements: [existing], edit_history: [] });
  const out = await applyContribution(fake.client, row({
    policy_id: POLICY,
    elements: [{ element: "deadline", stated: true, text: "2028 年前完工", deadline_date: "2028-12-31", source_locator: "p.2" }],
  }));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.policy_elements.length, 1, "同一個要素只有一列");
  const after = fake.db.policy_elements[0];
  assertEquals([after.stated, after.text, after.deadline_date], [true, "2028 年前完工", "2028-12-31"]);
  const fields = fake.db.edit_history.map((e) => e.field).sort();
  assertEquals(fields, ["deadline_date", "stated", "text"], "只記變了的三欄，舊值留著給還原");
  assertEquals(fake.db.edit_history.find((e) => e.field === "stated")!.old_value, false);

  const again = await applyContribution(fake.client, row({
    policy_id: POLICY,
    elements: [{ element: "deadline", stated: true, text: "2028 年前完工", deadline_date: "2028-12-31", source_locator: "p.2" }],
  }));
  assertEquals(again.status, "superseded", "跟現有一樣不重複寫，也不寫假的履歷");
  assertEquals(fake.db.edit_history.length, 3);
});

Deno.test("落庫：政見已移除或不存在 → failed，不寫任何東西", async () => {
  const removed = createFakeSupabase({ policies: [{ id: POLICY, title: "x", removed_at: "2026-10-01", removed_reason: "口號" }], policy_elements: [], edit_history: [] });
  const r1 = await applyContribution(removed.client, row({ policy_id: POLICY, elements: [{ element: "target", stated: false, source_locator: "p.1" }] }));
  assertEquals(r1.status, "failed");
  assertEquals(removed.db.policy_elements.length, 0);
  const missing = createFakeSupabase({ policies: [], policy_elements: [], edit_history: [] });
  const r2 = await applyContribution(missing.client, row({ policy_id: POLICY, elements: [{ element: "target", stated: false, source_locator: "p.1" }] }));
  assertEquals(r2.status, "failed");
});

Deno.test("交件前置檢查：指到不存在的政見 → target_not_found；已移除 → apply_would_fail", async () => {
  const items = [{ contribution_type: "policy_elements", payload: { policy_id: POLICY, elements: [] } }];
  const none = await precheckApplyTargets(createFakeSupabase({ policies: [] }).client, items, new Set());
  assertEquals(none.map((p) => p.code), ["target_not_found"]);
  const gone = await precheckApplyTargets(createFakeSupabase({ policies: [{ id: POLICY, removed_at: "2026-10-01" }] }).client, items, new Set());
  assertEquals(gone.map((p) => p.code), ["apply_would_fail"]);
  const live = await precheckApplyTargets(createFakeSupabase({ policies: [{ id: POLICY, removed_at: null }] }).client, items, new Set());
  assertEquals(live, []);
});

// ── 3. 型別、門檻、清單 ──────────────────────────────────────────────────────

Deno.test("型別清點：貢獻型別、兩個任務型別、建議回報型別、一次一份的任務都登記了", () => {
  assert((CONTRIBUTION_TYPES as readonly string[]).includes("policy_elements"));
  for (const t of ["policy_elements_missing", "deadline_due"]) {
    assert((TASK_TYPES as readonly string[]).includes(t), `TASK_TYPES 少了 ${t}`);
    assert(SINGLE_ANSWER_TASK_TYPES.has(t), `${t} 一個來源 IP 一次一份`);
  }
  assertEquals(SUGGESTED_TYPE.policy_elements_missing, "policy_elements");
  assertEquals(SUGGESTED_TYPE.deadline_due, "policy_progress");
});

Deno.test("門檻照一般資料（不動計分）：policy_elements 是 normal，跟 policy／correction 同一級", () => {
  assertEquals(riskLevel("policy_elements", {}), "normal");
  assertEquals(riskLevel("policy_elements", {}), riskLevel("policy", {}));
});

// ── 4. SQL（migration）────────────────────────────────────────────────────────

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
async function migrationWith(needle: string): Promise<{ name: string; sql: string }> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    if (sql.includes(needle)) return { name, sql };
  }
  throw new Error(`沒有 migration 含 ${needle}`);
}
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
}
const { name: MIG, sql } = await migrationWith("CREATE TABLE IF NOT EXISTS policy_elements");
// 表定義到「單獨一行的 );」為止（Windows checkout 是 CRLF，所以找 \n); 不找 );\n）
const table = between(sql, "CREATE TABLE IF NOT EXISTS policy_elements", "\n);").replace(/\r/g, "");

Deno.test("資料表：要素清單、字數上限、一個要素一列，SQL 跟 TS 同一套", () => {
  const kinds = table.match(/element\s+TEXT NOT NULL CHECK \(element IN \(([^)]+)\)\)/)![1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assertEquals(kinds, [...POLICY_ELEMENT_KINDS]);
  assertEquals(Number(table.match(/char_length\(text\) <= (\d+)/)![1]), POLICY_ELEMENT_TEXT_MAX);
  assertStringIncludes(table, "UNIQUE (policy_id, element)");
});

Deno.test("資料表：未說明與未調查的分別擋在資料庫——沒寫就沒文字、期限日期只在寫了的期限、原句位置與出處必填", () => {
  assert(/\(stated AND text IS NOT NULL AND btrim\(text\) <> ''\) OR \(NOT stated AND text IS NULL\)/.test(table), "stated 與 text 要互相綁住");
  assert(/deadline_date IS NULL OR \(element = 'deadline' AND stated\)/.test(table));
  assert(/source_url\s+TEXT NOT NULL/.test(table) && /source_locator\s+TEXT NOT NULL/.test(table));
  assert(/policy_id\s+UUID NOT NULL REFERENCES policies\(id\) ON DELETE CASCADE/.test(table));
  assertStringIncludes(sql, 'CREATE POLICY "Public read" ON policy_elements FOR SELECT USING (true)');
});

Deno.test("出處：source_refs 只加不刪，原本的兩種照舊；要素的出處寫不進去要擋、刪列要清引用", () => {
  const check = sql.match(/ADD CONSTRAINT source_refs_target_table_check\s+CHECK \(target_table IN \(([^)]+)\)\)/)![1];
  for (const t of ["policies", "tracking_logs", "policy_elements"]) assertStringIncludes(check, `'${t}'`);
  const sync = between(sql, "CREATE OR REPLACE FUNCTION policy_elements_sync_source", "$$;");
  assert(!/EXCEPTION WHEN OTHERS/.test(sync), "三要素的出處是資料的一部分：寫不進去要讓落庫失敗、自動重試，不能吞掉");
  assertStringIncludes(sync, "RAISE EXCEPTION");
  assertStringIncludes(sql, "AFTER INSERT OR UPDATE OF source_url ON policy_elements");
  assertStringIncludes(sql, "AFTER DELETE ON policy_elements");
});

Deno.test("視圖：policies_with_logs 前面的欄位一字不差，只在最後加 elements，security_invoker 再設一次", async () => {
  const prev = await Deno.readTextFile(new URL("20260921000028_policies_updated_at.sql", MIGRATIONS));
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const oldBody = norm(between(prev, "CREATE VIEW policies_with_logs AS", "FROM policies p;"));
  const newBody = norm(between(sql, "CREATE OR REPLACE VIEW policies_with_logs AS", "FROM policies p;"));
  const oldCols = oldBody.replace("CREATE VIEW policies_with_logs AS", "").trim();
  assert(newBody.includes(`${oldCols}, COALESCE(`), "原本的 p.*、logs、related_policy_ids 要原樣保留、新欄位接在後面（CREATE OR REPLACE VIEW 只能在最後加欄位）");
  assert(/AS related_policy_ids,\s*COALESCE\([\s\S]*AS elements\s*FROM policies p;/.test(sql), "elements 要是最後一欄");
  const after = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW policies_with_logs"));
  assert(/ALTER VIEW policies_with_logs SET \(security_invoker = on\)/.test(after), "CREATE OR REPLACE VIEW 會清掉 reloptions，要再設一次");
});

Deno.test("資料走流程：這支 migration 不寫任何一筆三要素", () => {
  assert(!/INSERT INTO policy_elements/i.test(sql), `${MIG} 不可以直接寫三要素——要派任務、驗證後上線`);
  assert(!/UPDATE policy_elements/i.test(sql));
});

const arms = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "COMMENT ON FUNCTION contribution_auto_tasks_arms");
const missingArm = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_elements()", "COMMENT ON FUNCTION contribution_auto_tasks_policy_elements");
const dueArm = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_deadline_due()", "COMMENT ON FUNCTION contribution_auto_tasks_deadline_due");

Deno.test("派工臂：兩支新臂都接進 contribution_auto_tasks_arms，原有的臂一支不少", () => {
  const called = new Set([...arms.matchAll(/FROM\s+(contribution_auto_tasks_[a-z_]+)\(\)/g)].map((m) => m[1]));
  for (const a of ["contribution_auto_tasks_policy_elements", "contribution_auto_tasks_deadline_due", "contribution_auto_tasks_raw",
    "contribution_auto_tasks_region_gap", "contribution_auto_tasks_elected_missing", "contribution_auto_tasks_township_gap"]) {
    assert(called.has(a), `arms 少了 ${a}`);
  }
  assertStringIncludes(arms, "roster_scope_covers", "名單清查的縣市範圍過濾要原樣保留");
});

Deno.test("拆三要素的範圍：還沒投票的在選者、已投票的當選者且未達成未跳票；等票中的不派；拆完三個就消失", () => {
  assertStringIncludes(missingArm, "'auto:policy_elements_missing:'");
  assert(/e\.election_date >= CURRENT_DATE AND x\.candidate_status NOT IN \('not_running', 'withdrawn'\)/.test(missingArm));
  assert(/e\.election_date < CURRENT_DATE AND x\.election_result = 'elected' AND pl\.status::TEXT NOT IN \('Achieved', 'Failed'\)/.test(missingArm));
  assert(/c\.contribution_type = 'policy_elements' AND c\.status IN \('pending', 'verified', 'apply_failed'\)/.test(missingArm), "等票中的不派");
  assertStringIncludes(missingArm, "cardinality(c.missing) > 0");
  assertStringIncludes(missingArm, "pl.removed_at IS NULL");
  assertStringIncludes(missingArm, "office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, x.election_type)",
    "「任內」要換成卸任日，任務要給；屆別年份從投票日取，不從 id 推（#344）");
});

Deno.test("期限到了：日期已過、未達成也未跳票、期限之後沒有進度；競選承諾要投完票、落選者不問；跟 progress_stale 不重複", () => {
  assertStringIncludes(dueArm, "'auto:deadline_due:'");
  assert(/d\.element = 'deadline' AND d\.stated AND d\.deadline_date IS NOT NULL/.test(dueArm));
  assertStringIncludes(dueArm, "d.deadline_date < CURRENT_DATE");
  assert(/pl\.status::TEXT NOT IN \('Achieved', 'Failed'\)/.test(dueArm));
  assert(/tl\.policy_id = pl\.id AND tl\.date > d\.deadline_date\)/.test(dueArm), "期限「之後」的進度才算");
  assert(/pl\.status::TEXT <> 'Campaign Pledge' OR \(e\.election_date IS NOT NULL AND e\.election_date < CURRENT_DATE\)/.test(dueArm));
  assert(/election_result IN \('not_elected', 'withdrawn'\)/.test(dueArm));
  assert(/r\.task_type = 'progress_stale' AND EXISTS \(SELECT 1 FROM due d WHERE d\.target->>'policy_id' = r\.target->>'policy_id'\)/.test(arms),
    "同一條政見期限到了只派 deadline_due，不再另派 progress_stale");
});

// ── 5. 送給代理的說明 ────────────────────────────────────────────────────────

Deno.test("任務說明講得出未說明與未調查的分別、不補數字、原句位置與期限換算", () => {
  const g = TASK_GUIDANCE.policy_elements_missing;
  for (const w of ["未說明", "未調查", "不補數字、不換算、不評價", "source_locator", "2028-12-31", "target.term_end", "不是原文"]) assertStringIncludes(g, w);
  for (const w of ["policy_progress", "不要自己判定跳票", "date 填事件日期"]) assertStringIncludes(TASK_GUIDANCE.deadline_due, w);
  assertStringIncludes(PAYLOAD_SHAPE.policy_elements, "source_locator");
});

Deno.test("回報骨架只列還缺的要素，期限那一個才有 deadline_date", () => {
  const tpl = buildReportTemplate("policy_elements_missing", "policy_elements", { policy_id: POLICY, missing: ["deadline", "funding"] }, `auto:policy_elements_missing:${POLICY}`);
  const p = tpl!.payload as { policy_id: string; elements: Obj[] };
  assertEquals(p.policy_id, POLICY);
  assertEquals(p.elements.map((e) => e.element), ["deadline", "funding"]);
  assert("deadline_date" in p.elements[0] && !("deadline_date" in p.elements[1]));
  assert(p.elements.every((e) => "source_locator" in e));
  assertEquals(tpl!.contribution_type, "policy_elements");
});

Deno.test("任務現況：已有的要素與還缺的要素都給；期限到了給原文那一列期限", () => {
  const cur = shapeTaskCurrent("policy_elements_missing", {
    politician: { id: "p", name: "王小明" },
    policy: { id: POLICY, title: "社宅", description: "摘要" },
    elements: [{ element: "target", stated: true, text: "3,000 戶", source_locator: "p.2", source_url: BULLETIN }],
  });
  assertEquals(cur.missing_elements, ["deadline", "funding"]);
  assertEquals((cur.existing_elements as Obj[]).length, 1);
  assertEquals(cur.hint, TASK_GUIDANCE.policy_elements_missing);
  const due = shapeTaskCurrent("deadline_due", {
    policy: { id: POLICY, title: "社宅" },
    elements: [{ element: "deadline", stated: true, text: "2025 年底", deadline_date: "2025-12-31", source_locator: "p.2", source_url: BULLETIN }],
  });
  assertEquals((due.deadline as Obj).deadline_date, "2025-12-31");
});

Deno.test("驗證項：逐個要素對原文，講得出 agree／disagree／unsure，不教提交端的詞", () => {
  const cur = shapeVerifyCurrent("policy_elements", { policy_id: POLICY }, { policy: { id: POLICY, title: "社宅" }, elements: [], term_end: "2030-12-24" });
  assertEquals(cur.hint, POLICY_ELEMENTS_VERIFY_HINT);
  assertEquals(cur.term_end, "2030-12-24");
  for (const w of ["agree", "disagree", "unsure", "stated=false", "term_end"]) assertStringIncludes(String(cur.hint), w);
  assert(!/uphold|reject/.test(String(cur.hint)));
});

Deno.test("協議文件：skill.md 有這一型的段落，講清楚未說明／未調查、原句位置、曆年換算", async () => {
  const md = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  const at = md.indexOf("**`policy_elements`**");
  assert(at > 0, "skill.md 要有 policy_elements 段落");
  const section = md.slice(at, md.indexOf("**`roster_check`**", at));
  for (const w of ["source_locator", "2028-12-31", "term_end", "不換算"]) assertStringIncludes(section, w);
  // 兩個狀態各自的意思都要講到：交了 stated=false＝未說明；沒交＝未調查（不可以拿 stated=false 代替「沒查到」）
  assert(/stated=false`? ?的要素[^。]*「未說明」/.test(section), "要講交了 stated=false 的要素顯示「未說明」");
  assert(/沒有交的要素[^。]*「未調查」/.test(section), "要講沒有交的要素顯示「未調查」");
  assertStringIncludes(md, "deadline_due");
});
