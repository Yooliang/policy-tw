import { assertEquals } from "jsr:@std/assert@1";
import { validateContributionRequest } from "./contribution-schema.ts";
import { applyContribution, type ContributionRow } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";

const CNA = "https://www.cna.com.tw/news/aipl/202609045002.aspx";
const QID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LONG_ANSWER = "根據中央社報導，市長已在施政報告中承諾三年內完成長照據點倍增計畫，目前執行進度約六成。";

function row(overrides: Partial<ContributionRow> = {}): ContributionRow {
  return {
    id: "c-q1", contribution_type: "question_answer", source_urls: [CNA], note: null,
    agent_name: "tester", agent_tool: "claude-code/opus", contributor_url: null,
    payload: { question_id: QID, answer: LONG_ANSWER },
    ...overrides,
  };
}

Deno.test("question_answer schema：question_id 要是 uuid、answer 30～4000 字，來源網址沿用通用規則", () => {
  const ok = validateContributionRequest({
    agent_name: "tester", contribution_type: "question_answer",
    payload: { question_id: QID, answer: LONG_ANSWER },
    source_urls: [CNA],
  });
  assertEquals(ok.errors, []);

  const tooShort = validateContributionRequest({
    agent_name: "tester", contribution_type: "question_answer",
    payload: { question_id: QID, answer: "太短的答案" },
    source_urls: [CNA],
  });
  assertEquals(tooShort.errors.map((e) => e.path), ["payload.answer"]);

  const tooLong = validateContributionRequest({
    agent_name: "tester", contribution_type: "question_answer",
    payload: { question_id: QID, answer: "字".repeat(4001) },
    source_urls: [CNA],
  });
  assertEquals(tooLong.errors.map((e) => e.path), ["payload.answer"]);

  const badId = validateContributionRequest({
    agent_name: "tester", contribution_type: "question_answer",
    payload: { question_id: "not-a-uuid", answer: LONG_ANSWER },
    source_urls: [CNA],
  });
  assertEquals(badId.errors.map((e) => e.path), ["payload.question_id"]);

  const noSource = validateContributionRequest({
    agent_name: "tester", contribution_type: "question_answer",
    payload: { question_id: QID, answer: LONG_ANSWER },
  });
  assertEquals(noSource.errors.map((e) => e.path), ["source_urls"], "沒有 checked_urls 特例，跟一般型別一樣必填 source_urls");
});

Deno.test("applyQuestionAnswer：正常落庫，寫 question_answers 與 edit_history", async () => {
  const fake = createFakeSupabase({ citizen_questions: [{ id: QID, status: "open" }], question_answers: [] });
  const outcome = await applyContribution(fake.client, row());
  assertEquals(outcome.status, "applied");
  assertEquals(outcome.question_id, QID);
  assertEquals(fake.db.question_answers.length, 1);
  const saved = fake.db.question_answers[0];
  assertEquals(saved.agent_name, "tester");
  assertEquals(saved.agent_tool, "claude-code/opus");
  assertEquals(saved.answer, LONG_ANSWER);
  assertEquals(saved.source_urls, [CNA]);
  assertEquals(saved.contribution_id, "c-q1");
  assertEquals(fake.log.some((l) => l.table === "edit_history" && l.op === "insert"), true);
});

Deno.test("applyQuestionAnswer：提問不存在 → failed，不是丟出例外", async () => {
  const fake = createFakeSupabase({ citizen_questions: [], question_answers: [] });
  const outcome = await applyContribution(fake.client, row());
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.message.includes("找不到提問"), true);
  assertEquals(fake.db.question_answers.length, 0);
});

Deno.test("applyQuestionAnswer：已下架的題目 → failed", async () => {
  const fake = createFakeSupabase({ citizen_questions: [{ id: QID, status: "hidden" }], question_answers: [] });
  const outcome = await applyContribution(fake.client, row());
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.message.includes("下架"), true);
});

Deno.test("applyQuestionAnswer：同代號（不分大小寫）已經答過這題 → failed，講清楚原因", async () => {
  const fake = createFakeSupabase({
    citizen_questions: [{ id: QID, status: "open" }],
    question_answers: [{ id: "qa-1", question_id: QID, agent_name: "Tester", answer: "既有答案", source_urls: [CNA] }],
  });
  const outcome = await applyContribution(fake.client, row({ agent_name: "tester" }));
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.message.includes("已經回答過這一題"), true);
  assertEquals(fake.db.question_answers.length, 1, "沒有多寫一筆");
});

Deno.test("applyQuestionAnswer：已有 3 份答案 → failed，講清楚原因", async () => {
  const fake = createFakeSupabase({
    citizen_questions: [{ id: QID, status: "open" }],
    question_answers: [
      { id: "qa-1", question_id: QID, agent_name: "a1", answer: "x", source_urls: [CNA] },
      { id: "qa-2", question_id: QID, agent_name: "a2", answer: "x", source_urls: [CNA] },
      { id: "qa-3", question_id: QID, agent_name: "a3", answer: "x", source_urls: [CNA] },
    ],
  });
  const outcome = await applyContribution(fake.client, row({ agent_name: "a4" }));
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.message.includes("已經有 3 份答案"), true);
  assertEquals(fake.db.question_answers.length, 3, "沒有多寫一筆");
});
