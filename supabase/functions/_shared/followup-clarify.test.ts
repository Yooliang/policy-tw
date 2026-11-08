// Jev 釐清模糊跟進任務（2026-11-08）：純函式＋用假 Jev／假資料庫跑 clarifyOne，並守住「只動 contribution_tasks」
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  actionOf, ALLOWED_DELIVERABLES, buildClarifyAsk, CLARIFY_DELIVERABLES, CLARIFY_KINDS, clarifyOne, clarifyQuestions, closeDuplicates, decide,
  parseAnswers, quoteOf, rewriteText, subjectFromGapId, subjectOfContribution, targetPatch,
  type ClarifyDeps, type ClarifyInput, type FollowupTaskRow, type PersonFacts,
} from "./followup-clarify.ts";
import { QUESTIONS, type DecisionRecord, type JevResponse } from "./system-one.ts";

const PID = "11111111-1111-4111-8111-111111111111";
const PID2 = "22222222-2222-4222-8222-222222222222";
const CID = "33333333-3333-4333-8333-333333333333";
const VID = "44444444-4444-4444-8444-444444444444";
const TID = "55555555-5555-4555-8555-555555555555";

const PERSON: PersonFacts = { id: PID, name: "林小明", birth_year: 1980, party: "無黨籍", region: "台南市", sub_region: "官田區", village: "渡拔里", current_position: null, merged_into: null };

function ans(kind: [string, number], del: [string, number], res: [string, number]): JevResponse["answers"] {
  const mk = (c: [string, number]) => ({ type: "choice", choice: c[0], probabilities: { [c[0]]: c[1] } });
  return { clarify_kind: mk(kind), clarify_deliverable: mk(del), clarify_resolved: mk(res) };
}
function jev(answers: JevResponse["answers"]): JevResponse {
  return { model: "typesafe/jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 10, cost: 0.00004 } };
}

// ---- 假資料庫：任何查詢鏈都回該表的資料；rpc 全部記下來 ----
function fakeSb(tables: Record<string, unknown[]>) {
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const writes: string[] = [];
  const sb = {
    rpcs, writes,
    from(table: string) {
      const rows = tables[table] ?? [];
      // deno-lint-ignore no-explicit-any
      const b: any = {};
      for (const m of ["select", "eq", "gt", "neq", "order", "limit", "in", "is", "not"]) b[m] = () => b;
      for (const m of ["insert", "update", "upsert", "delete"]) b[m] = () => { writes.push(`${m}:${table}`); return b; };
      b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
      b.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
      return b;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      if (fn === "followup_exact_duplicates") return Promise.resolve({ data: tables.__exact ?? [], error: null });
      if (fn === "followup_duplicate_plan") return Promise.resolve({ data: tables.__plan ?? [], error: null });
      return Promise.resolve({ data: true, error: null });
    },
  };
  return sb;
}

function deps(answers: JevResponse["answers"], recorded: DecisionRecord[] = []): ClarifyDeps {
  return { ask: () => Promise.resolve(jev(answers)), record: (rows) => { recorded.push(...rows); return Promise.resolve(); }, now: () => "2026-11-08T00:00:00.000Z" };
}

const TASK: FollowupTaskRow = {
  id: TID, title: "核對這筆資料的參選紀錄（驗證者備註提到）", created_at: "2026-11-01T00:00:00Z",
  description: "驗證者 wei 在 2026-11-05 驗證另一筆資料（no_change，xxx）時順手寫下：\n「林小明在 2026 年的參選紀錄選區好像登記錯了，應該是官田區。」\n這是系統從備註裡撿出來的線索。",
  target: { followup_kind: "candidacy", followup_of_vote: VID },
};
function dbFor(taskId = "auto:candidacy_owner_mismatch:777") {
  return fakeSb({
    contribution_votes: [{ contribution_id: CID }],
    contributions: [{ id: CID, contribution_type: "no_change", status: "applied", payload: { task_id: taskId, politician_id: PID, finding: "核對過" }, task_id: taskId, applied_politician_id: PID }],
    politicians: [PERSON],
    politician_elections: [{ id: 777, election_id: 2026, election_type: "村里長", position: "里長", cand_no: 3, candidacy_status: "filed", withdrawn_after_filing: null, politician_id: PID }],
  });
}

// ---- 題目與白名單 ----

Deno.test("三題都在 QUESTIONS 白名單，migration 的 CHECK 也有", async () => {
  for (const q of Object.keys(clarifyQuestions())) assert((QUESTIONS as readonly string[]).includes(q), q);
  const mig = await Deno.readTextFile(new URL("../../migrations/20261108030000_followup_clarify.sql", import.meta.url));
  for (const q of Object.keys(clarifyQuestions())) assertStringIncludes(mig, `'${q}'`);
});

Deno.test("問題類型涵蓋九類、交件型別七種，每種類型的允許清單都是有效型別", () => {
  assertEquals(Object.keys(CLARIFY_KINDS).length, 9);
  assertEquals(Object.keys(CLARIFY_DELIVERABLES).sort(), ["candidacy", "correction", "merge_politician", "no_change", "none", "politician", "reassign_candidacy"]);
  for (const list of Object.values(ALLOWED_DELIVERABLES)) for (const d of list) assert(d in CLARIFY_DELIVERABLES);
});

Deno.test("buildClarifyAsk：事實放 state、criteria 只放選項說明（藍圖 2-1）", () => {
  const input: ClarifyInput = {
    note: "選區登記錯了", contribution: { id: CID, contribution_type: "no_change", status: "applied", payload: { task_id: "x", finding: "f" } },
    subject: { politician_id: PID, other_politician_id: null, pe_id: 777, unit: null }, person: PERSON, other_person: null,
    candidacies: [{ id: 777, election_id: 2026, election_type: "村里長", position: "里長", cand_no: 3, candidacy_status: "filed", withdrawn_after_filing: null }],
    later: [{ type: "correction", status: "applied", created_at: "2026-11-06", fields: { field: "cand_no" } }],
  };
  const { state, questions } = buildClarifyAsk(input);
  assertEquals(Object.keys(questions), ["clarify_kind", "clarify_deliverable", "clarify_resolved"]);
  assertEquals((state.person as PersonFacts).birth_year, 1980);
  assertEquals((state.later_contributions as unknown[]).length, 1);
  assert(!JSON.stringify(questions).includes("林小明"), "人名不能出現在 criteria");
});

// ---- 缺口 id 與貢獻 → 主體 ----

Deno.test("subjectFromGapId：人物、參選紀錄、配對、單位", () => {
  assertEquals(subjectFromGapId(`auto:profile_gap:${PID}`).politician_id, PID);
  assertEquals(subjectFromGapId(`auto:profile_detail_gap:sources:${PID}`).politician_id, PID);
  assertEquals(subjectFromGapId("auto:candidacy_owner_mismatch:777").pe_id, 777);
  assertEquals(subjectFromGapId("auto:candidacy_source_missing:party:888").pe_id, 888);
  const pair = subjectFromGapId(`auto:duplicate_politician:${PID}|${PID2}`);
  assertEquals([pair.politician_id, pair.other_politician_id], [PID, PID2]);
  assertEquals(subjectFromGapId("auto:candidacy_source_missing:cand_no:2026:村里長:台南市:官田區").unit, "2026 村里長 台南市 官田區");
  assertEquals(subjectFromGapId(TID).politician_id, null);
  assertEquals(subjectFromGapId(null).unit, null);
});

Deno.test("subjectOfContribution：貢獻標的人 > 缺口 id；改掛／合併帶出兩端", () => {
  const s = subjectOfContribution({ id: CID, contribution_type: "reassign_candidacy", payload: { from_politician_id: PID, politician_election_id: 9 } });
  assertEquals([s.politician_id, s.pe_id], [PID, 9]);
  const m = subjectOfContribution({ id: CID, contribution_type: "merge_politician", payload: { keep_id: PID, remove_id: PID2 } });
  assertEquals([m.politician_id, m.other_politician_id], [PID, PID2]);
});

// ---- 決策門檻 ----

Deno.test("decide：已解決／沒問題 ≥0.95 關；0.94 不關；問題類型 ≥0.85 才改寫；unclear 保持", () => {
  const a = parseAnswers(ans(["candidacy", 0.97], ["correction", 0.9], ["yes", 0.96]));
  assertEquals(decide(a).action, "close");
  assertEquals((decide(a) as { reason: string }).reason, "resolved");
  assertEquals(decide(parseAnswers(ans(["no_issue", 0.95], ["none", 0.9], ["no", 0.9]))).action, "close");
  const edge = decide(parseAnswers(ans(["no_issue", 0.94], ["none", 0.9], ["no", 0.9])));
  assertEquals(edge.action, "keep"); // 0.94 不夠關，no_issue 又不是可改寫的類型
  assertEquals(decide(parseAnswers(ans(["candidacy", 0.84], ["candidacy", 0.99], ["no", 0.99]))).action, "keep");
  assertEquals(decide(parseAnswers(ans(["unclear", 0.99], ["none", 0.99], ["unsure", 0.5]))).action, "keep");
  const rw = decide(parseAnswers(ans(["identity", 0.9], ["reassign_candidacy", 0.9], ["no", 0.8])));
  assertEquals(rw, { action: "rewrite", kind: "identity", deliverable: "reassign_candidacy", act: "reassign" });
});

Deno.test("decide：交件型別跟問題類型不搭、或沒把握，就只用通用句型（不亂指交件型別）", () => {
  const mismatch = decide(parseAnswers(ans(["duplicate", 0.99], ["candidacy", 0.99], ["no", 0.9])));
  assertEquals(mismatch, { action: "rewrite", kind: "duplicate", deliverable: null, act: null });
  const weak = decide(parseAnswers(ans(["party", 0.95], ["correction", 0.6], ["no", 0.9])));
  assertEquals((weak as { act: unknown }).act, null);
});

Deno.test("actionOf：correction 依問題類型分欄位；no_change／none 沒有動作", () => {
  assertEquals(actionOf("candidacy", "correction"), "correct_candidacy");
  assertEquals(actionOf("party", "correction"), "correct_politician");
  assertEquals(actionOf("policy_content", "correction"), "correct_policy");
  assertEquals(actionOf("duplicate", "merge_politician"), "merge");
  assertEquals(actionOf("candidacy", "no_change"), null);
  assertEquals(actionOf("candidacy", "none"), null);
});

// ---- 改寫 ----

Deno.test("rewriteText：標題有人名、動作與交件型別；說明有目前資料與原話；不超長", () => {
  const input: ClarifyInput = {
    note: "選區登記錯了", contribution: null, subject: { politician_id: PID, other_politician_id: null, pe_id: 777, unit: null },
    person: PERSON, other_person: null,
    candidacies: [{ id: 777, election_id: 2026, election_type: "村里長", position: "里長", cand_no: 3, candidacy_status: "filed", withdrawn_after_filing: null }], later: [],
  };
  const { title, description } = rewriteText({ decision: { action: "rewrite", kind: "identity", deliverable: "reassign_candidacy", act: "reassign" }, input, quote: input.note, fallbackName: null });
  assertStringIncludes(title, "林小明");
  assertStringIncludes(title, "reassign_candidacy");
  assert(title.length <= 120);
  assertStringIncludes(description, "1980 年生");
  assertStringIncludes(description, "參選紀錄 777");
  assertStringIncludes(description, "選區登記錯了");
  assert(description.length <= 2000);
});

Deno.test("rewriteText：沒有人物只有單位時，標題用單位", () => {
  const input: ClarifyInput = { note: "n", contribution: null, subject: { politician_id: null, other_politician_id: null, pe_id: null, unit: "2026 村里長 台南市 官田區" }, person: null, other_person: null, candidacies: [], later: [] };
  const { title } = rewriteText({ decision: { action: "rewrite", kind: "candidacy", deliverable: "candidacy", act: "candidacy" }, input, quote: "n", fallbackName: null });
  assertStringIncludes(title, "官田區");
});

Deno.test("targetPatch：不覆蓋原有的 id；只有一筆 2026 參選紀錄時補它；蓋章", () => {
  const input: ClarifyInput = {
    note: "n", contribution: null, subject: { politician_id: PID, other_politician_id: null, pe_id: null, unit: null }, person: PERSON, other_person: null,
    candidacies: [{ id: 9, election_id: 2026, election_type: "村里長", position: "里長", cand_no: null, candidacy_status: "filed", withdrawn_after_filing: null }], later: [],
  };
  const a = parseAnswers(ans(["candidacy", 0.9], ["candidacy", 0.9], ["no", 0.9]));
  const d = decide(a);
  const p = targetPatch({}, input.subject, input, d, a, "typesafe/jev-1.13.0", "t");
  assertEquals([p.politician_id, p.politician_election_id], [PID, 9]);
  assertEquals((p.clarify as { status: string; action: string }).status, "rewritten");
  const q = targetPatch({ politician_id: PID2 }, input.subject, input, d, a, "m", "t");
  assertEquals(q.politician_id, undefined); // 原有的不動
});

Deno.test("quoteOf 取出備註原話", () => {
  assertEquals(quoteOf(TASK.description), "林小明在 2026 年的參選紀錄選區好像登記錯了，應該是官田區。");
});

// ---- clarifyOne：假 Jev ----

Deno.test("clarifyOne：高信心已解決 → followup_close，且只呼叫 rpc、不直接寫任何表", async () => {
  const sb = dbFor(); const rec: DecisionRecord[] = [];
  const out = await clarifyOne(sb, deps(ans(["candidacy", 0.9], ["correction", 0.9], ["yes", 0.97]), rec), TASK, false);
  assertEquals(out.status, "closed");
  assertEquals(sb.rpcs.map((r) => r.fn), ["followup_close"]);
  assertEquals(sb.rpcs[0].args.p_task, TID);
  assertEquals((sb.rpcs[0].args.p_reason as { code: string }).code, "resolved");
  assertEquals(sb.writes, []);
  assertEquals(rec.length, 3);
  assertEquals(rec[0].subject_type, "vote"); // 票來的任務，判決記在票上
  assertEquals(rec[0].subject_id, VID);
  assert(rec.every((r) => r.cost_usd !== null && r.state != null));
});

Deno.test("clarifyOne：改寫 → followup_rewrite 帶新標題、補 politician_id、蓋章", async () => {
  const sb = dbFor(); const rec: DecisionRecord[] = [];
  const out = await clarifyOne(sb, deps(ans(["identity", 0.93], ["reassign_candidacy", 0.9], ["no", 0.9]), rec), TASK, false);
  assertEquals(out.status, "rewritten");
  assertEquals(out.action, "reassign");
  const call = sb.rpcs.find((r) => r.fn === "followup_rewrite")!;
  assertStringIncludes(String(call.args.p_title), "林小明");
  const patch = call.args.p_patch as Record<string, unknown>;
  assertEquals(patch.politician_id, PID);
  assertEquals(patch.politician_election_id, 777);
  assertEquals((patch.clarify as { model: string }).model, "typesafe/jev-1.13.0");
  assertEquals(sb.writes, []);
});

Deno.test("clarifyOne：沒把握 → 只蓋章（標題說明給 null 不動）", async () => {
  const sb = dbFor();
  const out = await clarifyOne(sb, deps(ans(["candidacy", 0.5], ["correction", 0.5], ["unsure", 0.5])), TASK, false);
  assertEquals(out.status, "kept");
  const call = sb.rpcs[0];
  assertEquals([call.fn, call.args.p_title, call.args.p_description], ["followup_rewrite", null, null]);
});

Deno.test("clarifyOne：dry 不寫紀錄、不呼叫任何 rpc", async () => {
  const sb = dbFor(); const rec: DecisionRecord[] = [];
  const out = await clarifyOne(sb, deps(ans(["identity", 0.93], ["reassign_candidacy", 0.9], ["no", 0.9]), rec), TASK, true);
  assertEquals(out.status, "rewritten");
  assertEquals(sb.rpcs, []);
  assertEquals(rec, []);
});

Deno.test("clarifyOne：找不到底下貢獻 → 蓋 skipped 章不問 Jev", async () => {
  const sb = fakeSb({ contribution_votes: [], contributions: [] });
  let asked = false;
  const d: ClarifyDeps = { ask: () => { asked = true; return Promise.resolve(jev({})); }, record: () => Promise.resolve(), now: () => "t" };
  const out = await clarifyOne(sb, d, { ...TASK, target: { followup_kind: "party" } }, false);
  assertEquals(out.status, "skipped");
  assertEquals(asked, false);
  assertEquals(sb.rpcs.length, 1);
});

Deno.test("clarifyOne：Jev 掛了就丟出去（不蓋章，下一輪重試）", async () => {
  const sb = dbFor();
  const d: ClarifyDeps = { ask: () => Promise.reject(new Error("503")), record: () => Promise.resolve(), now: () => "t" };
  let threw = false;
  try { await clarifyOne(sb, d, TASK, false); } catch { threw = true; }
  assert(threw);
  assertEquals(sb.rpcs, []);
});

// ---- 重複 ----

Deno.test("closeDuplicates：精確重複與對既有任務的重複都走 followup_close，理由有保留對象；dry 不關", async () => {
  const tables = { __exact: [{ task_id: "a", keep_id: "k" }], __plan: [{ task_id: "b", keep_ref: "auto:auto:profile_gap:x" }, { task_id: "a", keep_ref: "pending:c" }] };
  const sb = fakeSb(tables);
  const r = await closeDuplicates(sb, false);
  assertEquals([r.exact, r.vs_existing], [1, 1]); // a 同時在兩份計畫裡，只算一次
  const closes = sb.rpcs.filter((c) => c.fn === "followup_close");
  assertEquals(closes.map((c) => c.args.p_task), ["a", "b"]);
  assertEquals((closes[1].args.p_reason as { keep: string }).keep, "auto:auto:profile_gap:x");
  const dry = fakeSb(tables);
  await closeDuplicates(dry, true);
  assertEquals(dry.rpcs.filter((c) => c.fn === "followup_close"), []);
});

// ---- migration 守門：只動 contribution_tasks ----

Deno.test("migration：寫入只有 contribution_tasks（兩支窄函式），其他函式全是 STABLE 只讀；cron 已排", async () => {
  const mig = await Deno.readTextFile(new URL("../../migrations/20261108030000_followup_clarify.sql", import.meta.url));
  const stmts = [...mig.matchAll(/^\s*(UPDATE|INSERT INTO|DELETE FROM)\s+([a-z_]+)/gim)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert(stmts.length > 0);
  for (const s of stmts) assertEquals(s, "UPDATE contribution_tasks");
  assertEquals((mig.match(/LANGUAGE sql STABLE/g) ?? []).length, 2);
  assertStringIncludes(mig, "created_by = 'jev-followup'");
  assertStringIncludes(mig, "action=followup_clarify");
  // 重複計畫涵蓋四種對象：自動缺口、名冊分組、手動任務、待驗貢獻
  for (const src of ["'auto'", "'roster'", "'manual'", "'pending'"]) assertStringIncludes(mig, src);
  for (const t of ["profile_gap", "duplicate_politician", "candidacy_owner_mismatch", "candidacy_source_missing", "roster_group"]) assertStringIncludes(mig, t);
});

Deno.test("system-one：followup_clarify 動作存在，新開的跟進任務當場釐清", async () => {
  const src = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assertStringIncludes(src, 'action === "followup_clarify"');
  assertEquals((src.match(/await clarifyNewTask\(/g) ?? []).length, 2);
});
