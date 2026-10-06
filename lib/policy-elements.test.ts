/**
 * 政見三要素的顯示規則與「期限已到」（#364，2026-10-05）。
 *
 * 守的核心：**沒有那一列＝未調查；有列而 stated=false＝未說明**，兩者在畫面上不能混成同一個字；
 * 原文有寫的照原文印，不補、不換算。「期限已到」的條件跟派工臂 deadline_due 同一套（SQL 在
 * migration 20261005005640，這裡另外比對 SQL 文字，免得兩邊走鐘）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  anyChecked,
  cellText,
  deadlineDue,
  dueDeadlinePolicies,
  elementCells,
  ELEMENT_KINDS,
  mapPolicyElements,
  NOT_STATED_LABEL,
  sourceLabel,
  UNCHECKED_LABEL,
  type DueContext,
} from "./policy-elements.ts";
import type { Policy, PolicyElement, RawPolicyElement } from "../types.ts";

const SRC = { url: "https://bulletin.cec.gov.tw/2026/a.pdf", title: null, publisher: null, kind: "official", archive_url: "https://web.archive.org/web/20261001000000/https://bulletin.cec.gov.tw/2026/a.pdf" };

Deno.test("三格固定順序；沒有列＝未調查、stated=false＝未說明、有寫就照原文", () => {
  const els = mapPolicyElements([
    { element: "funding", stated: false, text: null, source_locator: "公報第 2 頁全段", source: SRC },
    { element: "target", stated: true, text: " 新建社會住宅 3,000 戶 ", source_locator: "公報第 2 頁", source: SRC },
  ]);
  const cells = elementCells(els);
  assertEquals(cells.map((c) => c.kind), [...ELEMENT_KINDS]);
  assertEquals(cells.map((c) => c.state), ["stated", "unchecked", "not_stated"]);
  assertEquals(cells.map(cellText), ["新建社會住宅 3,000 戶", UNCHECKED_LABEL, NOT_STATED_LABEL]);
  assert((NOT_STATED_LABEL as string) !== (UNCHECKED_LABEL as string), "兩種「沒有內容」一定要是不同的字");
  assertEquals(cells[2].source?.archiveUrl, SRC.archive_url, "未說明也帶出處（查的是哪份原文）");
  assertEquals(cells[1].source, null, "未調查沒有出處");
});

Deno.test("視圖還沒有 elements 欄（舊快照、資料那支 PR 還沒上線）＝三個都未調查，不是未說明", () => {
  assertEquals(mapPolicyElements(undefined), undefined);
  assertEquals(elementCells(undefined).map((c) => c.state), ["unchecked", "unchecked", "unchecked"]);
  assertEquals(anyChecked(undefined), false);
  assertEquals(elementCells([]).map(cellText), [UNCHECKED_LABEL, UNCHECKED_LABEL, UNCHECKED_LABEL]);
});

Deno.test("未說明不會漏出文字；stated=true 卻沒有文字的舊資料當成未說明，不印空白冒充有內容", () => {
  const els = mapPolicyElements([
    { element: "funding", stated: false, text: "（不該出現）" },
    { element: "target", stated: true, text: "   " },
    { element: "deadline", stated: false, deadline_date: "2028-12-31" },
  ]);
  assertEquals(els!.find((e) => e.element === "funding")!.text, null, "對應進前端型別時就丟掉未說明那一列的文字");
  const cells = elementCells(els);
  assertEquals(cells.find((c) => c.kind === "funding")!.text, null);
  assertEquals(cells.find((c) => c.kind === "target")!.state, "not_stated");
  assertEquals(cells.find((c) => c.kind === "deadline")!.deadlineDate, null, "沒寫的期限沒有日期");
});

Deno.test("認不得的要素丟掉，不冒充三個之一；出處只有網址時退回網域", () => {
  const els = mapPolicyElements([{ element: "budget", stated: true, text: "x" } as RawPolicyElement, { element: "target", stated: true, text: "3 座", source_url: "https://www.example.gov.tw/p" }]);
  assertEquals(els!.length, 1);
  assertEquals(sourceLabel(els![0].source), "example.gov.tw");
  assertEquals(sourceLabel({ url: "https://x.tw", title: "公報" }), "公報");
});

// ── 期限已到 ─────────────────────────────────────────────────────────────

const deadline = (date: string, text = "2025 年底前"): PolicyElement => ({ element: "deadline", stated: true, text, deadlineDate: date, sourceLocator: "p.1", source: null });
function policy(over: Partial<Policy> = {}): Policy {
  return {
    id: "p1", politicianId: "a1", electionId: 2022, title: "托育公共化", description: "", category: "社會福利",
    status: "In Progress" as Policy["status"], proposedDate: null, lastUpdated: "2025-01-01", progress: 30, tags: [], logs: [],
    stanceSupport: 0, stanceOppose: 0, stancePriority: 0, elements: [deadline("2025-12-31")], ...over,
  };
}
const ctx = (over: Partial<DueContext> = {}): DueContext => ({
  today: "2026-10-06",
  electionDateOf: () => "2022-11-26",
  candidacyStatusOf: () => "elected",
  ...over,
});

Deno.test("期限已到：期限日期早於今天、推動中、期限後沒進度 → 列出來，算得出過了幾天", () => {
  const d = deadlineDue(policy(), ctx());
  assert(d);
  assertEquals(d!.deadlineDate, "2025-12-31");
  assertEquals(d!.deadlineText, "2025 年底前");
  assertEquals(d!.daysOver, 279);
});

Deno.test("期限已到：今天剛好是期限那天不算；未來的期限、沒寫期限、換不成日期的都不算", () => {
  assertEquals(deadlineDue(policy({ elements: [deadline("2026-10-06")] }), ctx()), null);
  assertEquals(deadlineDue(policy({ elements: [deadline("2028-12-31")] }), ctx()), null);
  assertEquals(deadlineDue(policy({ elements: [{ ...deadline("2025-12-31"), stated: false, text: null }] }), ctx()), null);
  assertEquals(deadlineDue(policy({ elements: [{ ...deadline("2025-12-31"), deadlineDate: null }] }), ctx()), null);
  assertEquals(deadlineDue(policy({ elements: undefined }), ctx()), null);
});

Deno.test("期限已到：已實現或跳票的不算；期限「之後」有進度就不算，期限之前的進度不算後續", () => {
  assertEquals(deadlineDue(policy({ status: "Achieved" as Policy["status"] }), ctx()), null);
  assertEquals(deadlineDue(policy({ status: "Failed" as Policy["status"] }), ctx()), null);
  assert(deadlineDue(policy({ logs: [{ id: 1, date: "2025-06-01", event: "期限前" }] }), ctx()), "期限之前的進度不算後續");
  assertEquals(deadlineDue(policy({ logs: [{ id: 2, date: "2026-01-15", event: "期限後" }] }), ctx()), null);
});

Deno.test("期限已到：競選承諾要等那場選舉投完票；落選、退選者的承諾不算", () => {
  const pledge = policy({ status: "Campaign Pledge" as Policy["status"], electionId: 2026 });
  assertEquals(deadlineDue(pledge, ctx({ electionDateOf: () => "2026-11-28" })), null, "還沒投票的承諾問不出做到沒有");
  assertEquals(deadlineDue(pledge, ctx({ electionDateOf: () => undefined })), null);
  assert(deadlineDue(pledge, ctx({ electionDateOf: () => "2022-11-26" })));
  assertEquals(deadlineDue(policy(), ctx({ candidacyStatusOf: () => "not_elected" })), null);
  assertEquals(deadlineDue(policy(), ctx({ candidacyStatusOf: () => "withdrawn" })), null);
  assert(deadlineDue(policy(), ctx({ candidacyStatusOf: () => undefined })), "不知道結果時照列（跟 SQL 一樣只排除明確落選、退選）");
});

Deno.test("期限已到的清單：期限早的在前", () => {
  const list = dueDeadlinePolicies([
    policy({ id: "b", title: "乙", elements: [deadline("2025-12-31")] }),
    policy({ id: "a", title: "甲", elements: [deadline("2024-12-31")] }),
    policy({ id: "c", title: "丙", elements: [deadline("2027-12-31")] }),
  ], ctx());
  assertEquals(list.map((d) => d.policy.id), ["a", "b"]);
});

Deno.test("跟派工臂 deadline_due 同一套條件（SQL 文字比對）", async () => {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  let sql = "";
  for (const n of names.sort().reverse()) {
    const t = await Deno.readTextFile(new URL(n, dir));
    if (t.includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_deadline_due()")) { sql = t; break; }
  }
  assert(sql, "找不到定義 contribution_auto_tasks_deadline_due 的 migration");
  const arm = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_deadline_due()"));
  for (const must of [
    "d.deadline_date < CURRENT_DATE",
    "NOT IN ('Achieved', 'Failed')",
    "tl.date > d.deadline_date",
    "'Campaign Pledge'",
    "candidacy_status IN ('not_elected', 'withdrawn')",
  ]) assert(arm.includes(must), `SQL 的 deadline_due 少了「${must}」——前端的 deadlineDue 跟它要同一套`);
});
