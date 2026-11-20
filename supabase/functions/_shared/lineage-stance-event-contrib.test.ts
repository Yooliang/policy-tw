/**
 * 脈絡「一件事的全貌」第二期 2a：立場（lineage_stance）、事件（lineage_event）兩種交件（policy-tw#675；migration 20261120160000）。
 *
 * 一期（#1010）只蓋資料櫃、A5 鎖「收不進」；二期把 A5 改成「有且對得上」（A5b）。這支守的是「收得進來、而且收得對」：
 *   A. 清點與 migration：四處清單（DB CHECK、TS 清單、協議、標籤）、migration 不碰 activity_rules 與資料
 *   B. 交件驗證（形狀、日期、條件、項目鍵、外層說明、出處）
 *   C. 唯一出處守門（逐項）：項目 A 只引媒體 1、項目 B 只引媒體 2 的整筆要被擋
 *   D. 前置檢查與承諾防線：選前日期的立場／事件交件被拒（date_outside_elected_term），含整個 POST 路徑；還原驗證＝任期函式恆真則守門失效
 *   E. 落庫：新增／覆蓋／同日不同句各一筆／軟刪除／下架後重交新開一列／履歷
 *   F. /next 與 /report 接線：驗證說明帶型別段落、目標分數 3、系統不給票
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { fnText, migrationNames, readMig } from "./arms-pglite.ts";
import { CONTRIBUTION_TYPES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { applyContribution } from "./apply-contribution.ts";
import { precheckApplyTargets } from "./apply-precheck.ts";
import { handleContribute } from "./contribute-handler.ts";
import { SOLE_SOURCE_GUARDED_TYPES, soleSourceProblems } from "./sole-source-guard.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { hasGuidance, PAYLOAD_SHAPE } from "./task-guidance.ts";
import { readSkillWithTypes } from "./skill-text.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { LINEAGE_VERIFY_HINT, shapeVerifyCurrent } from "./task-context.ts";
import { riskLevel, requiredAgree, systemVoteEligible } from "./consensus.ts";
import { typeSpecForTask, typeSpecForVerify } from "./type-spec-for.ts";
import { MAX_EVENTS, MAX_STANCES } from "./lineage.ts";
import { VOTE_DIMENSIONS } from "./vote-budget.ts";

const MIG_NAME = "20261120160000_lineage_stance_event_types.sql";
const MIG = await readMig(MIG_NAME);
const code = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LID = u(100), P1 = u(1), P2 = u(2), POL = u(50);
const OFFICIAL = "https://www.tcc.gov.tw/council/2026-03-01";
const NEWS_A = "https://news.example-a.com/story/1";
const NEWS_B = "https://news.example-b.com/story/2";
const NOTE = "這幾位都在講台中捷運藍線第一階段，與脈絡同一件事。";

const stance = (over: Record<string, unknown> = {}) => ({
  politician_id: P1, stance: "support", stated_on: "2026-03-01", quote: "藍線第一階段一定要在任內動工",
  source_locator: "議事錄 2026-03-01 質詢", source_url: OFFICIAL, ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  event_type: "approved", occurred_on: "2026-03-01", level: "national", decided_by: "行政院",
  description: "行政院核定藍線第一階段綜合規劃報告。", source_locator: "核定函", source_url: OFFICIAL, ...over,
});
const sendStances = (stances: unknown, over: Record<string, unknown> = {}, urls: string[] = [OFFICIAL]) =>
  validateContributionRequest({ agent_name: "tester", contributions: [{ contribution_type: "lineage_stance", payload: { lineage_id: LID, stances }, source_urls: urls, note: NOTE, ...over }] });
const sendEvents = (events: unknown, over: Record<string, unknown> = {}, urls: string[] = [OFFICIAL]) =>
  validateContributionRequest({ agent_name: "tester", contributions: [{ contribution_type: "lineage_event", payload: { lineage_id: LID, events }, source_urls: urls, note: NOTE, ...over }] });

// ============================================================
// A. 清點與 migration
// ============================================================
Deno.test("A1 migration：時間戳在一期之後；只動型別 CHECK 與票數預算候選；不碰 activity_rules、不改任何資料、不刪表欄", async () => {
  const names = await migrationNames();
  assert(MIG_NAME > "20261120120000_lineage_stances_events.sql");
  assertEquals(names.includes(MIG_NAME), true);
  const c = code(MIG).replace(/'[^']*'/g, "''");
  assertFalse(/activity_rules/i.test(c), "不碰派工規則表（硬規則 1：既有三支臂開著不動）");
  assertFalse(/^\s*UPDATE\s/im.test(c), "沒有任何 UPDATE");
  assertFalse(/^\s*(DELETE|TRUNCATE)\b/im.test(c), "沒有 DELETE／TRUNCATE");
  assertFalse(/\bDROP\s+(TABLE|COLUMN)\b/i.test(c));
  assertFalse(/FUNCTION\s+(activity_arm_names|contribution_auto_tasks_arms)/i.test(c), "2a 不新增派工臂（臂與起跑日在 2b）");
});

Deno.test("A2 DB 型別 CHECK＝TS 的 CONTRIBUTION_TYPES（現行定義以最後一支改它的 migration 為準）", async () => {
  let last = "";
  for (const n of await migrationNames()) {
    const sql = await readMig(n);
    const a = sql.lastIndexOf("ADD CONSTRAINT contributions_contribution_type_check");
    if (a >= 0) last = sql.slice(a, sql.indexOf(";", a));
  }
  const sqlTypes = [...last.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals([...sqlTypes].sort(), [...CONTRIBUTION_TYPES].sort());
  assert(sqlTypes.includes("lineage_stance") && sqlTypes.includes("lineage_event"));
});

Deno.test("A3 票數預算候選清單＝最後一版加兩個型別（其餘一個字不改）", async () => {
  const prev = fnText(await readMig("20261105200000_lineage_status.sql"), "system_one_vote_budget_candidates");
  const now = fnText(MIG, "system_one_vote_budget_candidates");
  assertEquals(now.replace(",\n                                'lineage_stance', 'lineage_event')", ")"), prev);
  for (const t of ["lineage_stance", "lineage_event"]) assert(VOTE_DIMENSIONS[t]?.length >= 1, `${t} 要有票數預算的風險維度`);
});

Deno.test("A5b 二期把一期的 A5「沒有」改成「有且對得上」：型別、任務型別、做法、落庫分支、標籤、協議說明都在", async () => {
  for (const t of ["lineage_stance", "lineage_event"]) assert((CONTRIBUTION_TYPES as readonly string[]).includes(t), t);
  for (const t of ["lineage_stance_missing", "lineage_event_missing"]) {
    assert((TASK_TYPES as readonly string[]).includes(t), t);
    assert(hasGuidance(t), `${t} 要有做法`);
  }
  assertEquals(SUGGESTED_TYPE.lineage_stance_missing, "lineage_stance");
  assertEquals(SUGGESTED_TYPE.lineage_event_missing, "lineage_event");
  assert(PAYLOAD_SHAPE.lineage_stance && PAYLOAD_SHAPE.lineage_event);
  const apply = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  assertStringIncludes(apply, 'case "lineage_stance": return await applyLineageStances');
  assertStringIncludes(apply, 'case "lineage_event": return await applyLineageEvents');
  const lib = async (f: string) => await Deno.readTextFile(new URL(`../../../lib/${f}`, import.meta.url));
  for (const [file, key] of [["task-labels.ts", "lineage_stance_missing"], ["task-labels.ts", "lineage_event_missing"], ["model-quality.ts", "lineage_stance"], ["model-quality.ts", "lineage_event"]]) {
    const label = (await lib(file)).match(new RegExp(`\\b${key}:\\s*'([^']*)'`))?.[1] ?? "";
    assert(label && !/[A-Za-z]/.test(label), `${file} 的 ${key} 中文名稱要有且不夾英文字母`);
  }
  const skill = await readSkillWithTypes();
  for (const t of ["`lineage_stance`", "`lineage_event`", "lineage_stance_missing", "lineage_event_missing", "date_outside_elected_term", "second_source_url"]) assertStringIncludes(skill, t);
  assert(typeSpecForTask("lineage_stance_missing", "lineage_stance")?.includes("補脈絡立場"));
  assert(typeSpecForTask("lineage_event_missing", "lineage_event")?.includes("補脈絡事件"));
});

Deno.test("A6 協議版號：skill.md 檔頭與 protocol.ts 一致、不低於 1.139.0", async () => {
  const head = (await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url))).match(/\*\*版本\*\*：(\d+\.\d+\.\d+)/)?.[1];
  assertEquals(head, PROTOCOL_VERSION);
  const [maj, min] = PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 1 || min >= 139);
});

// ============================================================
// B. 交件驗證
// ============================================================
Deno.test("B1 合法的立場／事件過（含有條件、拿掉一項、第二來源、日期精度）", () => {
  assertEquals(sendStances([stance()]).errors, []);
  assertEquals(sendStances([stance({ stance: "conditional", condition: "要等中央補助核定後才能動工" })]).errors, []);
  assertEquals(sendStances([stance({ date_precision: "month", policy_id: u(7), note: "質詢時當場表示" })]).errors, []);
  assertEquals(sendStances([{ politician_id: P1, stated_on: "2026-03-01", quote: "藍線第一階段一定要在任內動工", remove: true }]).errors, [], "拿掉一項只要能指到那一列");
  assertEquals(sendStances([stance({ source_url: NEWS_A, second_source_url: NEWS_B })], {}, [NEWS_A, NEWS_B]).errors, []);
  assertEquals(sendEvents([event()]).errors, []);
  assertEquals(sendEvents([event({ level: "county", region: "台中市", initiator_politician_id: P1, initiator_note: "縣府提案" })]).errors, []);
  assertEquals(sendEvents([{ event_type: "approved", occurred_on: "2026-03-01", decided_by: "行政院", remove: true }]).errors, []);
});

Deno.test("B2 立場的欄位檢查：人、立場值、有條件互依、日期（不能是未來）、原文長度、重複項、一筆上限", () => {
  const bad = (over: Record<string, unknown>, path: string) => assert(sendStances([stance(over)]).errors.some((e) => e.path.startsWith(path)), `${path}：${JSON.stringify(over)}`);
  bad({ politician_id: "x" }, "payload.stances[0].politician_id");
  bad({ stance: "maybe" }, "payload.stances[0].stance");
  bad({ stance: "conditional" }, "payload.stances[0].condition");
  bad({ stance: "conditional", condition: "太短" }, "payload.stances[0].condition");
  bad({ condition: "支持卻帶條件，不行" }, "payload.stances[0].condition");
  bad({ stated_on: "2026-13-40" }, "payload.stances[0].stated_on");
  bad({ stated_on: "2999-01-01" }, "payload.stances[0].stated_on");
  bad({ quote: "太短" }, "payload.stances[0].quote");
  bad({ quote: "字".repeat(301) }, "payload.stances[0].quote");
  bad({ date_precision: "hour" }, "payload.stances[0].date_precision");
  bad({ policy_id: "x" }, "payload.stances[0].policy_id");
  bad({ source_locator: "" }, "payload.stances[0].source_locator");
  bad({ source_url: "ftp://x" }, "payload.stances[0].source_url");
  bad({ note: "字".repeat(201) }, "payload.stances[0].note");
  assert(sendStances([stance(), stance()]).errors.some((e) => e.path === "payload.stances[1].quote"), "同人同天同句重複");
  assertEquals(sendStances([stance(), stance({ quote: "同一天的另一句：先做第二階段規劃" })]).errors, [], "同一天不同句各自一項");
  assert(sendStances([]).errors.some((e) => e.path === "payload.stances"));
  const many = Array.from({ length: MAX_STANCES + 1 }, (_, i) => stance({ quote: `第 ${i} 句：藍線一定要在任內動工` }));
  assert(sendStances(many).errors.some((e) => e.path === "payload.stances"), "超過 10 項");
  assertEquals(sendStances(many.slice(0, MAX_STANCES)).errors, []);
  assert(validateContributionRequest({ agent_name: "tester", contributions: [{ contribution_type: "lineage_stance", payload: { stances: [stance()] }, source_urls: [OFFICIAL], note: NOTE }] }).errors.some((e) => e.path === "payload.lineage_id"));
});

Deno.test("B3 事件的欄位檢查：型態、日期、機關、描述、地方（層級對得上）、推動者備註互依、重複鍵、一筆上限", () => {
  const bad = (over: Record<string, unknown>, path: string) => assert(sendEvents([event(over)]).errors.some((e) => e.path.startsWith(path)), `${path}：${JSON.stringify(over)}`);
  bad({ event_type: "voted" }, "payload.events[0].event_type");
  bad({ occurred_on: "2999-01-01" }, "payload.events[0].occurred_on");
  bad({ decided_by: "行" }, "payload.events[0].decided_by");
  bad({ description: "太短" }, "payload.events[0].description");
  bad({ level: "galaxy" }, "payload.events[0].level");
  bad({ level: "county" }, "payload.events[0].region");
  bad({ level: "township", region: "台中市" }, "payload.events[0].sub_region");
  bad({ level: "national", region: "台中市" }, "payload.events[0].region");
  bad({ initiator_note: "縣府提案" }, "payload.events[0].initiator_note");
  bad({ initiator_politician_id: "x" }, "payload.events[0].initiator_politician_id");
  assert(sendEvents([event(), event()]).errors.some((e) => e.path === "payload.events[1].decided_by"), "同一天同機關同型態重複");
  assertEquals(sendEvents([event(), event({ event_type: "budget_added" })]).errors, []);
  const many = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => event({ decided_by: `機關第${i}`, occurred_on: "2026-03-01" }));
  assert(sendEvents(many).errors.some((e) => e.path === "payload.events"));
});

Deno.test("B4 外層交件說明（note 20～300 字）：頂層或 payload.note 都收；太短、沒填、太長都擋；項目備註是另一個欄位", () => {
  const send = (note: unknown, inPayload = false) => validateContributionRequest({
    agent_name: "tester",
    contributions: [{ contribution_type: "lineage_stance", payload: { lineage_id: LID, stances: [stance()], ...(inPayload ? { note } : {}) }, source_urls: [OFFICIAL], ...(inPayload || note === undefined ? {} : { note }) }],
  }).errors;
  assertEquals(send(NOTE), []);
  assertEquals(send(NOTE, true), []);
  assert(send("太短").some((e) => e.path === "note"));
  assert(send(undefined).some((e) => e.path === "note"));
  assert(send("字".repeat(301)).some((e) => e.path === "note"));
  assert(sendEvents([event()], { note: "太短" }).errors.some((e) => e.path === "note"));
});

Deno.test("B5 出處：項目的 source_url／second_source_url 要在 source_urls 裡；讀不到的社群不收", () => {
  assert(sendStances([stance({ source_url: "https://other.example.com/x" })]).errors.some((e) => e.path === "payload.stances[0].source_url"));
  assert(sendStances([stance({ second_source_url: NEWS_B })]).errors.some((e) => e.path === "payload.stances[0].second_source_url"), "第二來源沒列在 source_urls");
  assert(sendStances([stance({ source_url: "https://www.facebook.com/x/posts/1" })], {}, ["https://www.facebook.com/x/posts/1"]).errors.some((e) => e.path === "payload.stances[0].source_url"), "臉書讀不到");
  assert(sendEvents([event({ second_source_url: "https://www.facebook.com/x/posts/2" })], {}, [OFFICIAL, "https://www.facebook.com/x/posts/2"]).errors.some((e) => e.path === "payload.events[0].second_source_url"));
  assertEquals(sendStances([{ politician_id: P1, stated_on: "2026-03-01", quote: "藍線第一階段一定要在任內動工", remove: true, source_url: "https://other.example.com/x" }]).errors, [], "拿掉的項目不查出處");
});

// ============================================================
// C. 唯一出處（逐項）
// ============================================================
const solo = (type: "lineage_stance" | "lineage_event", items: unknown[], urls: string[]) =>
  soleSourceProblems([{ contribution_type: type, payload: { lineage_id: LID, [type === "lineage_stance" ? "stances" : "events"]: items }, source_urls: urls }]);

Deno.test("C1 兩型別進了守門清單；官方過；媒體單一來源被擋，中文稱謂是「立場」「事件」不是「政見進度」", () => {
  assert((SOLE_SOURCE_GUARDED_TYPES as readonly string[]).includes("lineage_stance") && (SOLE_SOURCE_GUARDED_TYPES as readonly string[]).includes("lineage_event"));
  assertEquals(solo("lineage_stance", [stance()], [OFFICIAL]), []);
  const s = solo("lineage_stance", [stance({ source_url: NEWS_A })], [NEWS_A]);
  assertEquals(s.length, 1);
  assertStringIncludes(s[0].message, "（立場）");
  assertFalse(s[0].message.includes("政見進度"));
  const e = solo("lineage_event", [event({ source_url: NEWS_A })], [NEWS_A]);
  assertStringIncludes(e[0].message, "（事件）");
});

Deno.test("C2 逐項：項目 A 只引媒體 1、項目 B 只引媒體 2 的整筆被擋（外層有兩個網站也不算）；補上第二來源才過", () => {
  const items = [stance({ source_url: NEWS_A }), stance({ quote: "第二項的另一句：藍線要先做第二階段", source_url: NEWS_B })];
  const blocked = solo("lineage_stance", items, [NEWS_A, NEWS_B]);
  assertEquals(blocked.length, 1, "外層看起來有兩個網站，每一項其實都是單一媒體");
  assertStringIncludes(blocked[0].message, "第 1、2 項");
  const fixed = [stance({ source_url: NEWS_A, second_source_url: NEWS_B }), stance({ quote: "第二項的另一句：藍線要先做第二階段", source_url: NEWS_B, second_source_url: NEWS_A })];
  assertEquals(solo("lineage_stance", fixed, [NEWS_A, NEWS_B]), []);
  // 第二來源要是不同網站：同一網站不同網址不算
  const same = [stance({ source_url: NEWS_A, second_source_url: "https://news.example-a.com/other/2" })];
  assertEquals(solo("lineage_stance", same, [NEWS_A, "https://news.example-a.com/other/2"]).length, 1);
  // 只有一項沒補：訊息只點那一項
  const half = solo("lineage_event", [event({ source_url: NEWS_A, second_source_url: NEWS_B }), event({ event_type: "budget_added", source_url: NEWS_A })], [NEWS_A, NEWS_B]);
  assertStringIncludes(half[0].message, "第 2 項");
  assertFalse(half[0].message.includes("第 1、2 項"));
});

Deno.test("C3 拿掉的項目不檢查；第二來源本身是官方就過；既有型別的檢查沒變（現況、交接仍照外層網站數）", () => {
  assertEquals(solo("lineage_stance", [{ politician_id: P1, stated_on: "2026-03-01", quote: "藍線第一階段一定要在任內動工", remove: true }], [NEWS_A]), []);
  assertEquals(solo("lineage_stance", [stance({ source_url: NEWS_A, second_source_url: OFFICIAL })], [NEWS_A, OFFICIAL]), []);
  assertEquals(soleSourceProblems([{ contribution_type: "lineage_status", payload: {}, source_urls: [NEWS_A] }]).length, 1);
  assertEquals(soleSourceProblems([{ contribution_type: "lineage_status", payload: {}, source_urls: [NEWS_A, NEWS_B] }]).length, 0);
});

Deno.test("C4 還原驗證：把逐項檢查退回只看外層，C2 的跨項引用案例就不會被擋（守門測試真的有牙）", async () => {
  const src = await Deno.readTextFile(new URL("./sole-source-guard.ts", import.meta.url));
  assertStringIncludes(src, "soleSourceItemProblem(i, it.contribution_type, it.payload");
  // 退回外層檢查的壞版本：外層有兩個網站就放行
  const outerOnly = (urls: string[]) => new Set(urls.map((x) => new URL(x).hostname)).size >= 2;
  assert(outerOnly([NEWS_A, NEWS_B]), "壞版本會放行 C2 的跨項案例");
  assertEquals(solo("lineage_stance", [stance({ source_url: NEWS_A }), stance({ quote: "第二項的另一句：藍線要先做第二階段", source_url: NEWS_B })], [NEWS_A, NEWS_B]).length, 1, "好版本擋住");
});

// ============================================================
// D. 前置檢查與承諾防線
// ============================================================
const rpc = (stanceWithin: (a: Record<string, unknown>) => boolean, eventWithin: (a: Record<string, unknown>) => boolean = stanceWithin) => ({
  lineage_stance_within_elected_term: (a: Record<string, unknown>) => stanceWithin(a),
  lineage_event_within_elected_term: (a: Record<string, unknown>) => eventWithin(a),
});
const seed = () => ({
  lineages: [{ id: LID, title: "台中捷運藍線", level: "county", region: "台中市", sub_region: null }],
  politicians: [{ id: P1, name: "王小明", merged_into: null }, { id: P2, name: "林小華", merged_into: null }, { id: POL, name: "合併掉的人", merged_into: P1 }],
  policies: [{ id: u(7), removed_at: null }, { id: u(8), removed_at: "2026-01-01" }],
  regions: [{ id: 1, region: "台中市", sub_region: null, village: null, admin_code: "66000" }],
  lineage_stances: [] as Array<Record<string, unknown>>,
  lineage_events: [] as Array<Record<string, unknown>>,
  edit_history: [] as Array<Record<string, unknown>>,
  source_refs: [],
});
const pre = (fake: ReturnType<typeof createFakeSupabase>, type: string, payload: Record<string, unknown>) =>
  precheckApplyTargets(fake.client, [{ contribution_type: type, payload }], new Set());
const stancePayload = (items: unknown[]) => ({ lineage_id: LID, stances: items });
const eventPayload = (items: unknown[]) => ({ lineage_id: LID, events: items });

Deno.test("D1 前置檢查：脈絡、人物（含已合併）、掛的政見（含已移除）不對 → 整批 400 的 target_not_found／apply_would_fail", async () => {
  const fake = createFakeSupabase(seed(), rpc(() => true));
  assertEquals(await pre(fake, "lineage_stance", stancePayload([stance()])), []);
  assertEquals((await pre(fake, "lineage_stance", { lineage_id: u(999), stances: [stance()] })).map((p) => [p.code, p.path]), [["target_not_found", "payload.lineage_id"]]);
  assertEquals((await pre(fake, "lineage_stance", stancePayload([stance({ politician_id: u(998) })]))).map((p) => [p.code, p.path]), [["target_not_found", "payload.stances[0].politician_id"]]);
  assertEquals((await pre(fake, "lineage_stance", stancePayload([stance({ politician_id: POL })]))).map((p) => [p.code, p.path]), [["apply_would_fail", "payload.stances[0].politician_id"]]);
  assertEquals((await pre(fake, "lineage_stance", stancePayload([stance({ policy_id: u(8) })]))).map((p) => [p.code, p.path]), [["apply_would_fail", "payload.stances[0].policy_id"]]);
  assertEquals(await pre(fake, "lineage_stance", stancePayload([stance({ policy_id: u(7) })])), []);
  assertEquals((await pre(fake, "lineage_event", eventPayload([event({ initiator_politician_id: u(998) })]))).map((p) => [p.code, p.path]), [["target_not_found", "payload.events[0].initiator_politician_id"]]);
  assertEquals((await pre(fake, "lineage_event", eventPayload([event({ level: "county", region: "不存在市" })]))).map((p) => p.code), ["target_not_found"]);
  assertEquals(await pre(fake, "lineage_event", eventPayload([event({ level: "county", region: "台中市" })])), []);
});

Deno.test("D2 承諾不進脈絡（內容側）：選前日期的立場、事件交件被擋（date_outside_elected_term）；任期內的過；拿掉的項目不判", async () => {
  // 假任期：王小明 2025-12-25 起任期；選前日期（2026-03-01 之前 → 這裡用 < 2025-12-25）不在
  const inTerm = (a: Record<string, unknown>) => String(a.p_date) >= "2025-12-25";
  const fake = createFakeSupabase(seed(), rpc(inTerm));
  assertEquals(await pre(fake, "lineage_stance", stancePayload([stance({ stated_on: "2026-03-01" })])), []);
  const s = await pre(fake, "lineage_stance", stancePayload([stance({ stated_on: "2025-06-01" })]));
  assertEquals(s.map((p) => [p.code, p.path]), [["date_outside_elected_term", "payload.stances[0].stated_on"]]);
  assertStringIncludes(s[0].message, "承諾");
  const e = await pre(fake, "lineage_event", eventPayload([event({ occurred_on: "2025-06-01" })]));
  assertEquals(e.map((p) => [p.code, p.path]), [["date_outside_elected_term", "payload.events[0].occurred_on"]]);
  assertEquals(await pre(fake, "lineage_event", eventPayload([event({ occurred_on: "2026-03-01" })])), []);
  assertEquals(await pre(fake, "lineage_stance", stancePayload([{ politician_id: P1, stated_on: "2025-06-01", quote: "藍線第一階段一定要在任內動工", remove: true }])), [], "拿掉不需要在任期內");
  // 沒填推動者時傳 null 給函式（函式改看涉及的人）；有填就傳推動者
  let seen: Record<string, unknown> = {};
  const spy = createFakeSupabase(seed(), rpc(() => true, (a) => { seen = a; return true; }));
  await pre(spy, "lineage_event", eventPayload([event()]));
  assertEquals([seen.p_lineage_id, seen.p_initiator_politician_id, seen.p_date], [LID, null, "2026-03-01"]);
  await pre(spy, "lineage_event", eventPayload([event({ initiator_politician_id: P2 })]));
  assertEquals(seen.p_initiator_politician_id, P2);
});

Deno.test("D3 還原驗證：把任期函式改成恆真，選前日期就放行——D2 的案例會紅（守門真的在判任期）", async () => {
  const always = createFakeSupabase(seed(), rpc(() => true));
  const real = createFakeSupabase(seed(), rpc((a) => String(a.p_date) >= "2025-12-25"));
  const guardHolds = async (f: ReturnType<typeof createFakeSupabase>) =>
    (await pre(f, "lineage_stance", stancePayload([stance({ stated_on: "2025-06-01" })]))).some((p) => p.code === "date_outside_elected_term")
    && (await pre(f, "lineage_event", eventPayload([event({ occurred_on: "2025-06-01" })]))).some((p) => p.code === "date_outside_elected_term");
  assertEquals(await guardHolds(real), true);
  assertEquals(await guardHolds(always), false, "恆真的壞版本守不住");
});

Deno.test("D4 整個交件路徑：POST /contribute 選前日期的立場 → 400 date_outside_elected_term，什麼都沒寫；事件同", async () => {
  const run = async (type: string, payload: Record<string, unknown>) => {
    const fake = createFakeSupabase(seed(), rpc((a) => String(a.p_date) >= "2025-12-25"));
    const res = await handleContribute(fake.client, "https://x", { agent_name: "tester", contribution_type: type, payload, source_urls: [OFFICIAL], note: NOTE }, "ip-1", () => Promise.resolve({ status: 403, body: { error: "self_vote" } }));
    return { res, fake };
  };
  const a = await run("lineage_stance", stancePayload([stance({ stated_on: "2025-06-01" })]));
  assertEquals(a.res.status, 400);
  const body = a.res.body as { error: string; errors: Array<{ code: string; path: string }> };
  assertEquals(body.error, "date_outside_elected_term");
  assertEquals(body.errors.map((e) => [e.code, e.path]), [["date_outside_elected_term", "payload.stances[0].stated_on"]]);
  assertEquals(a.fake.db.contributions ?? [], [], "擋下就不落任何交件");
  const b = await run("lineage_event", eventPayload([event({ occurred_on: "2025-06-01" })]));
  assertEquals((b.res.body as { error: string }).error, "date_outside_elected_term");
  assertEquals(b.fake.db.contributions ?? [], []);
});

Deno.test("D5 政見側仍由 policy_is_elected_term 一處判斷：立場與事件不讀政見分類（不碰 Campaign Pledge／NOT listed）；policy_id 只追溯、不改政見歸屬", async () => {
  const apply = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  const a = apply.slice(apply.indexOf("async function applyLineageStances"), apply.indexOf("async function applyLineageLink"));
  for (const bad of ["Campaign Pledge", "NOT listed", "policy_is_elected_term", "lineage_id: lineageId }).eq(\"id\"", "from(\"policies\").update"]) assertFalse(a.includes(bad), `立場／事件落庫不該碰：${bad}`);
  const pre2 = await Deno.readTextFile(new URL("./apply-precheck.ts", import.meta.url));
  const p = pre2.slice(pre2.indexOf('case "lineage_stance": {'), pre2.indexOf('case "lineage_status": {'));
  assertFalse(/Campaign Pledge|NOT listed/.test(p));
  const lineageCase = pre2.slice(pre2.indexOf('case "lineage": {'), pre2.indexOf('case "lineage_participants": {', pre2.indexOf('case "lineage": {', pre2.indexOf("for (const { item, i } of entries) {", pre2.indexOf("const checkLineage")))));
  assert(pre2.includes("lineageIneligiblePolicies"), "歸入政見仍走既有的資格檢查（#677）");
  void lineageCase;
});

// ============================================================
// E. 落庫
// ============================================================
const row = (type: "lineage_stance" | "lineage_event", payload: Record<string, unknown>, id = "c-1", urls: string[] = [OFFICIAL]) => ({
  id, contribution_type: type as (typeof CONTRIBUTION_TYPES)[number], payload, source_urls: urls, note: NOTE, agent_name: "tester", contributor_url: null,
});

Deno.test("E1 立場落庫：新增一列（帶 contribution_id）、整列記履歷；合併過的人搬到保留者", async () => {
  const fake = createFakeSupabase(seed(), rpc(() => true));
  const out = await applyContribution(fake.client, row("lineage_stance", stancePayload([stance()])));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.lineage_stances.length, 1);
  const r = fake.db.lineage_stances[0];
  assertEquals([r.lineage_id, r.politician_id, r.stance, r.stated_on, r.date_precision, r.source_url, r.contribution_id, r.condition_text], [LID, P1, "support", "2026-03-01", "day", OFFICIAL, "c-1", null]);
  assert(fake.db.edit_history.some((e) => e.table_name === "lineage_stances" && e.field === "*" && e.new_value));
  const merged = createFakeSupabase(seed(), rpc(() => true));
  const out2 = await applyContribution(merged.client, row("lineage_stance", stancePayload([stance({ politician_id: POL })])));
  assertEquals(out2.status, "applied", out2.message);
  assertEquals(merged.db.lineage_stances[0].politician_id, P1, "被合併的人落在保留者名下");
});

Deno.test("E2 立場：同人同天同句重交＝覆蓋並逐欄記履歷；完全一樣 → superseded；同天不同句各自一列", async () => {
  const fake = createFakeSupabase(seed(), rpc(() => true));
  await applyContribution(fake.client, row("lineage_stance", stancePayload([stance()])));
  const same = await applyContribution(fake.client, row("lineage_stance", stancePayload([stance()]), "c-2"));
  assertEquals(same.status, "superseded", same.message);
  const changed = await applyContribution(fake.client, row("lineage_stance", stancePayload([stance({ stance: "conditional", condition: "要等中央補助核定後才能動工" })]), "c-3"));
  assertEquals(changed.status, "applied", changed.message);
  assertEquals(fake.db.lineage_stances.length, 1, "覆蓋不新增");
  assertEquals([fake.db.lineage_stances[0].stance, fake.db.lineage_stances[0].condition_text, fake.db.lineage_stances[0].contribution_id], ["conditional", "要等中央補助核定後才能動工", "c-3"]);
  const fields = fake.db.edit_history.filter((e) => e.contribution_id === "c-3").map((e) => e.field).sort();
  assertEquals(fields, ["condition_text", "stance"]);
  const other = await applyContribution(fake.client, row("lineage_stance", stancePayload([stance({ quote: "同一天的另一句：先做第二階段規劃" })]), "c-4"));
  assertEquals(other.status, "applied", other.message);
  assertEquals(fake.db.lineage_stances.length, 2, "同一天不同句各自一列、不互蓋");
});

Deno.test("E3 立場 remove：軟刪除（填 removed_at、不刪列、履歷記 removed_at）；本來就沒有 → superseded；下架後同一句重交＝新開一列（唯一鍵只管沒下架的）", async () => {
  const fake = createFakeSupabase(seed(), rpc(() => true));
  await applyContribution(fake.client, row("lineage_stance", stancePayload([stance()])));
  const rm = { politician_id: P1, stated_on: "2026-03-01", quote: "藍線第一階段一定要在任內動工", remove: true };
  const out = await applyContribution(fake.client, row("lineage_stance", stancePayload([rm]), "c-2"));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.lineage_stances.length, 1, "不刪列");
  assert(typeof fake.db.lineage_stances[0].removed_at === "string");
  const h = fake.db.edit_history.find((e) => e.contribution_id === "c-2");
  assertEquals([h?.table_name, h?.field, h?.old_value], ["lineage_stances", "removed_at", null], "履歷記 removed_at，還原＝清掉");
  const again = await applyContribution(fake.client, row("lineage_stance", stancePayload([rm]), "c-3"));
  assertEquals(again.status, "superseded", again.message);
  const redo = await applyContribution(fake.client, row("lineage_stance", stancePayload([stance()]), "c-4"));
  assertEquals(redo.status, "applied", redo.message);
  assertEquals(fake.db.lineage_stances.length, 2, "重交＝新開一列");
  assertEquals(fake.db.lineage_stances.filter((r) => r.removed_at === null || r.removed_at === undefined).length, 1);
});

Deno.test("E4 立場落庫再判一次承諾防線：表態日不在任期內 → failed（訊息帶 date_outside_elected_term）、什麼都不寫；任期資料變了就收", async () => {
  let within = false;
  const fake = createFakeSupabase(seed(), rpc(() => within));
  const out = await applyContribution(fake.client, row("lineage_stance", stancePayload([stance()])));
  assertEquals(out.status, "failed");
  assertStringIncludes(out.message, "date_outside_elected_term");
  assertEquals(fake.db.lineage_stances.length, 0);
  assertEquals(fake.db.edit_history.length, 0);
  within = true;
  assertEquals((await applyContribution(fake.client, row("lineage_stance", stancePayload([stance()]), "c-2"))).status, "applied");
});

Deno.test("E5 立場落庫：脈絡或人物不存在 → failed、不寫", async () => {
  const fake = createFakeSupabase(seed(), rpc(() => true));
  assertEquals((await applyContribution(fake.client, row("lineage_stance", { lineage_id: u(999), stances: [stance()] }))).status, "failed");
  assertEquals((await applyContribution(fake.client, row("lineage_stance", stancePayload([stance({ politician_id: u(998) })])))).status, "failed");
  assertEquals(fake.db.lineage_stances.length, 0);
});

Deno.test("E6 事件落庫：新增（補地方官方代碼）、覆蓋逐欄記履歷、同日同機關同型態互蓋、不同型態各一列", async () => {
  const fake = createFakeSupabase(seed(), rpc(() => true));
  const out = await applyContribution(fake.client, row("lineage_event", eventPayload([event({ level: "county", region: "台中市", initiator_politician_id: P1, initiator_note: "縣府提案" })])));
  assertEquals(out.status, "applied", out.message);
  const r = fake.db.lineage_events[0];
  assertEquals([r.level, r.region, r.admin_code, r.initiator_politician_id, r.initiator_note, r.contribution_id], ["county", "台中市", "66000", P1, "縣府提案", "c-1"]);
  const same = await applyContribution(fake.client, row("lineage_event", eventPayload([event({ level: "county", region: "台中市", initiator_politician_id: P1, initiator_note: "縣府提案" })]), "c-2"));
  assertEquals(same.status, "superseded", same.message);
  const changed = await applyContribution(fake.client, row("lineage_event", eventPayload([event({ level: "county", region: "台中市", initiator_politician_id: P1, initiator_note: "縣府提案", description: "行政院核定藍線第一階段綜合規劃報告（含修正）。" })]), "c-3"));
  assertEquals(changed.status, "applied", changed.message);
  assertEquals(fake.db.lineage_events.length, 1, "同日同機關同型態＝覆蓋");
  assertEquals(fake.db.edit_history.filter((e) => e.contribution_id === "c-3").map((e) => e.field), ["description"]);
  await applyContribution(fake.client, row("lineage_event", eventPayload([event({ level: "county", region: "台中市", event_type: "budget_added" })]), "c-4"));
  assertEquals(fake.db.lineage_events.length, 2);
});

Deno.test("E7 事件 remove 軟刪除、下架後重交新開一列；地方對不到行政區 → failed；決定日不在任期內 → failed", async () => {
  const fake = createFakeSupabase(seed(), rpc(() => true));
  await applyContribution(fake.client, row("lineage_event", eventPayload([event()])));
  const rm = { event_type: "approved", occurred_on: "2026-03-01", decided_by: "行政院", remove: true };
  assertEquals((await applyContribution(fake.client, row("lineage_event", eventPayload([rm]), "c-2"))).status, "applied");
  assertEquals(fake.db.lineage_events.length, 1);
  assert(typeof fake.db.lineage_events[0].removed_at === "string");
  assertEquals((await applyContribution(fake.client, row("lineage_event", eventPayload([rm]), "c-3"))).status, "superseded");
  assertEquals((await applyContribution(fake.client, row("lineage_event", eventPayload([event()]), "c-4"))).status, "applied");
  assertEquals(fake.db.lineage_events.length, 2, "重交＝新開一列");
  const badPlace = await applyContribution(fake.client, row("lineage_event", eventPayload([event({ level: "county", region: "不存在市", decided_by: "市議會" })]), "c-5"));
  assertEquals(badPlace.status, "failed");
  const outside = createFakeSupabase(seed(), rpc(() => false));
  const o = await applyContribution(outside.client, row("lineage_event", eventPayload([event()])));
  assertEquals(o.status, "failed");
  assertStringIncludes(o.message, "date_outside_elected_term");
  assertEquals(outside.db.lineage_events.length, 0);
});

// ============================================================
// F. /next 與 /report 接線
// ============================================================
Deno.test("F1 /next 驗證票：型別段落（type_spec）隨票送出；驗證提示逐項核、選前日期投 disagree", () => {
  for (const t of ["lineage_stance", "lineage_event"]) {
    const spec = typeSpecForVerify(t);
    assert(spec && spec.includes(`\`${t}\``), `${t} 的 type_spec`);
    assert(LINEAGE_VERIFY_HINT[t].includes("每一項各自核"), `${t} 的驗證提示要講逐項`);
    const cur = shapeVerifyCurrent(t, { lineage_id: LID }, { lineages: [], lineage_policies: [], politicians: [] } as never);
    assertEquals(cur.hint, LINEAGE_VERIFY_HINT[t]);
  }
  assertStringIncludes(LINEAGE_VERIFY_HINT.lineage_stance, "選前");
  assertStringIncludes(LINEAGE_VERIFY_HINT.lineage_stance, "一字不差");
  assertStringIncludes(LINEAGE_VERIFY_HINT.lineage_event, "已經做成的決定");
});

Deno.test("F2 /report 計分：兩型別走 normal（目標 3、不給系統票）；風險維度齊全", () => {
  for (const t of ["lineage_stance", "lineage_event"]) {
    assertEquals(riskLevel(t, {}, [OFFICIAL]), "normal");
    assertEquals(requiredAgree(t, {}, [OFFICIAL]), 3);
    assertFalse(systemVoteEligible(t));
  }
});

Deno.test("F3 /report 收件白名單：兩型別在 CONTRIBUTION_TYPES（驗證通過才收）；task_id 家族 auto:lineage_stance_missing 形狀合法", () => {
  const ok = validateContributionRequest({ agent_name: "tester", contributions: [{ contribution_type: "lineage_stance", payload: { lineage_id: LID, stances: [stance()] }, source_urls: [OFFICIAL], note: NOTE, task_id: `auto:lineage_stance_missing:${LID}:abcd1234` }] });
  assertEquals(ok.errors, []);
  assertEquals(ok.items[0].contribution_type, "lineage_stance");
});
