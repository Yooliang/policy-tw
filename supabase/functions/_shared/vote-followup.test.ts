// Jev 讀投票備註找範圍外的問題（2026-09-23）。
// 實例：陳泓維政見的驗證票寫「原文是親民黨提名，DB 是無黨籍……留給之後的 correction 處理」——沒有任何下游接手。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildFollowupAsk, FOLLOWUP_CHOICES, followupTask, worthAsking } from "./vote-followup.ts";
import { submissionFollowupTask, submissionText, worthAskingSubmission } from "./vote-followup.ts";
import { QUESTIONS, SUBJECT_TYPES } from "./system-one.ts";

const vote = {
  id: "v-1", verdict: "agree", agent_name: "shuwei-huang", created_at: "2026-09-22T13:05:00Z",
  note: "同意。打開自由時報來源核對，與 payload 逐句吻合。附帶一提：原文寫他是「親民黨提名」參選人，但DB現有政黨欄位是無黨籍，這是欄位外的疑點，留給之後的correction處理。",
};
const contribution = {
  id: "c-1", contribution_type: "policy",
  payload: { title: "加速桃園捷運棕線主體工程並改善沿線生活機能", politician_id: "11111111-2222-3333-4444-555555555555", election_id: 2026 },
  applied_policy_id: "99999999-2222-3333-4444-555555555555",
};

Deno.test("太短的備註不問 Jev", () => {
  assertEquals(worthAsking({ ...vote, note: "同意，來源吻合" }), false);
  assertEquals(worthAsking(vote), true);
});

Deno.test("問 Jev 時要帶這次驗證的範圍，它才分得出範圍內／範圍外", () => {
  const { state, questions } = buildFollowupAsk(vote, contribution);
  const scope = (state.being_verified as { fields: Record<string, unknown> }).fields;
  assertEquals(scope.title, contribution.payload.title);
  assertEquals(Object.keys(questions.followup.criteria), Object.keys(FOLLOWUP_CHOICES));
  assert("none" in questions.followup.criteria, "一定要有「沒有」這個選項，不然每張票都會被判出問題");
});

Deno.test("任務內容引用驗證者原話，指向那個人與那條政見", () => {
  const t = followupTask(vote, contribution, "party", "陳泓維");
  assertEquals(t.title, "核對陳泓維的政黨（驗證者備註提到）");
  assert(t.description!.includes("親民黨提名"), "要引用原話，Jev 不寫字");
  assert(t.description!.includes("no_change"), "查過沒問題也要有出口");
  assertEquals(t.target_policy_id, contribution.applied_policy_id);
  assertEquals(t.target_extra?.politician_id, contribution.payload.politician_id);
  assertEquals(t.task_type, "other");
});

Deno.test("followup 要同時在 TS 的 QUESTIONS 與 DB 的 CHECK 裡；vote 要在 SUBJECT_TYPES", async () => {
  assert((QUESTIONS as readonly string[]).includes("followup"));
  assert((SUBJECT_TYPES as readonly string[]).includes("vote"));
  const sql = await Deno.readTextFile(new URL("../../migrations/20260923000012_vote_followup_and_audit_all.sql", import.meta.url));
  assert(/question IN \([^)]*'followup'/.test(sql), "migration 的 CHECK 少了 followup");
});

// 2026-09-26：提交本身的說明也撿範圍外問題（併進票數預算那次 Jev）
Deno.test("提交說明：note／finding／reason 合起來、太短不問、任務引用原話", () => {
  const c = { id: "c1", contribution_type: "correction", payload: { reason: "來源其實是他宣布棄選桃園中壢、轉戰台北市大安文山區議員的報導，桃園那筆參選紀錄應改不參選", target_table: "politicians", target_id: "p1" }, agent_name: "a-zhen", note: null };
  assertEquals(submissionText(c).includes("轉戰台北市"), true);
  assertEquals(worthAskingSubmission(c), true);
  assertEquals(worthAskingSubmission({ ...c, payload: { reason: "太短" } }), false);
  const t = submissionFollowupTask(c, "candidacy", "游智彬");
  assertEquals(t.title, "核對游智彬的參選紀錄（提交說明提到）");
  assertEquals(String(t.description).includes("轉戰台北市"), true);
  assertEquals((t.target_extra as Record<string, unknown>).followup_of_contribution, "c1");
  assertEquals((t.target_extra as Record<string, unknown>).followup_of_vote, undefined);
});
