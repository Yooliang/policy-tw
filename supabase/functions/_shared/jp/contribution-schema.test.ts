import { assert, assertEquals } from "jsr:@std/assert@1";
import { canonicalPayload, validateContributionRequest, validateVerifyRequest } from "./contribution-schema.ts";

const base = { agent_name: "jp-agent", agent_tool: "claude-code/claude-sonnet-5" };
const noChange = {
  contribution_type: "no_change",
  payload: { task_id: "auto:policy_missing:abc", outcome: "confirmed", checked_urls: ["https://www.pref.example.lg.jp/a"], finding: "公式サイトを確認し、登録内容と一致していた" },
};
const correction = {
  contribution_type: "correction",
  payload: { target_table: "policies", target_id: "p-1", changes: [{ field: "status", correct_value: "achieved" }], reason: "県の公式発表で達成が確認できる" },
  source_urls: ["https://www.pref.example.lg.jp/b"],
};
const suggestion = {
  contribution_type: "task_suggestion",
  payload: { title: "この公約の進捗を調べる必要あり", description: "最新の施政方針に記載があるため進捗確認の任務を立てたい。", task_type: "progress_stale" },
  source_urls: ["https://www.pref.example.lg.jp/c"],
};

Deno.test("三種型別各一筆都過", () => {
  for (const it of [noChange, correction, suggestion]) {
    const v = validateContributionRequest({ ...base, ...structuredClone(it) });
    assertEquals(v.errors, [], JSON.stringify(v.errors));
    assert(v.ok);
  }
});

Deno.test("其他型別（正見的 candidacy 等）不收", () => {
  const v = validateContributionRequest({ ...base, contribution_type: "candidacy", payload: {}, source_urls: ["https://a.example/x"] });
  assertEquals(v.ok, false);
  assertEquals(v.errors[0].path, "contribution_type");
});

Deno.test("no_change：task_id 不能自己組、outcome 必填、沒給 source_urls 用 checked_urls", () => {
  const bad = structuredClone(noChange);
  bad.payload.task_id = "李玫-2026";
  (bad.payload as Record<string, unknown>).outcome = "maybe";
  const v = validateContributionRequest({ ...base, ...bad });
  const paths = v.errors.map((e) => e.path);
  assert(paths.includes("payload.task_id") && paths.includes("payload.outcome"));
  // 頂層 task_id 會被補進 payload
  const top = structuredClone(noChange);
  delete (top.payload as Record<string, unknown>).task_id;
  const ok = validateContributionRequest({ ...base, ...top, task_id: "auto:policy_missing:abc" });
  assert(ok.ok, JSON.stringify(ok.errors));
});

Deno.test("correction：target_table 白名單、reason ≥10 字、欄位重複擋、舊格式 field＋correct_value 也收", () => {
  const badTable = structuredClone(correction);
  (badTable.payload as Record<string, unknown>).target_table = "cec_candidates";
  assert(validateContributionRequest({ ...base, ...badTable }).errors.some((e) => e.path === "payload.target_table"));
  const dup = structuredClone(correction);
  (dup.payload as Record<string, unknown>).changes = [{ field: "status", correct_value: "a" }, { field: "status", correct_value: "b" }];
  assert(validateContributionRequest({ ...base, ...dup }).errors.some((e) => e.message.includes("重複")));
  const short = structuredClone(correction);
  (short.payload as Record<string, unknown>).reason = "短い";
  assert(validateContributionRequest({ ...base, ...short }).errors.some((e) => e.path === "payload.reason"));
  const old = { ...base, contribution_type: "correction", payload: { target_table: "policies", target_id: "p-1", field: "status", correct_value: "achieved", reason: "公式発表で確認できる内容" }, source_urls: ["https://a.example/x"] };
  assert(validateContributionRequest(old).ok);
});

Deno.test("一次最多 20 筆；亂碼擋下", () => {
  const many = Array.from({ length: 21 }, () => ({ ...structuredClone(correction) }));
  assert(validateContributionRequest({ ...base, contributions: many }).errors.some((e) => e.path === "contributions"));
  const enc = validateContributionRequest({ ...base, ...structuredClone(correction), note: "壊れた�文字" });
  assertEquals(enc.errors[0].code, "encoding_invalid");
});

Deno.test("驗證請求：disagree 要 evidence_url 與 note", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assertEquals(validateVerifyRequest({ contribution_id: id, verdict: "disagree", agent_name: "jp-agent" }).ok, false);
  assert(validateVerifyRequest({ contribution_id: id, verdict: "disagree", agent_name: "jp-agent", evidence_url: "https://a.example/x", note: "來源內容矛盾" }).ok);
  assert(validateVerifyRequest({ contribution_id: id, verdict: "agree", agent_name: "jp-agent", note: "確認了第三段" }).ok);
});

Deno.test("canonicalPayload 與鍵順序無關", () => {
  const a = canonicalPayload({ contribution_type: "no_change", payload: { a: 1, b: { c: 2, d: 3 } }, source_urls: [] });
  const b = canonicalPayload({ contribution_type: "no_change", payload: { b: { d: 3, c: 2 }, a: 1 }, source_urls: [] });
  assertEquals(a, b);
});
