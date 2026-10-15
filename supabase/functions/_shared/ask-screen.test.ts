import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { QUESTIONS, SUBJECT_TYPES, type JevResponse } from "./system-one.ts";
import { ASK_SCREEN_MIN_PROBABILITY, ASK_SCREEN_QUESTION, ASK_SCREEN_SUBJECT, buildAskScreenAsk, screenQuestion, verdictOfAsk, withTimeout } from "./ask-screen.ts";

const reply = (choice: string, p: number): JevResponse => ({
  model: "typesafe/jev-1.13.0",
  answers: { [ASK_SCREEN_QUESTION]: { type: "choice", choice, probabilities: { [choice]: p } } },
  usage: { input_tokens: 10, output_tokens: 1, cost: 0 },
});

Deno.test("buildAskScreenAsk：一題三選一，提問放 state", () => {
  const { state, questions } = buildAskScreenAsk("  台北市長照補助有哪些？ ");
  assertEquals(state, { question: "台北市長照補助有哪些？" });
  assertEquals(Object.keys(questions[ASK_SCREEN_QUESTION].criteria).sort(), ["answerable", "off_topic", "privacy"]);
});

Deno.test("可答：放行", async () => {
  const r = await screenQuestion("台北市長照家庭照顧者有什麼補助", () => Promise.resolve(reply("answerable", 0.99)));
  assertEquals(r.verdict.action, "allow");
  assertEquals(r.error, null);
  assert(r.response);
});

Deno.test("無關且達門檻：擋，error=off_topic，message 是白話中文", async () => {
  const r = await screenQuestion("推薦週末去哪裡吃火鍋", () => Promise.resolve(reply("off_topic", 0.98)));
  assertEquals(r.verdict.action, "block");
  if (r.verdict.action === "block") {
    assertEquals(r.verdict.error, "off_topic");
    assertStringIncludes(r.verdict.message, "改問");
    assert(!/[A-Za-z]/.test(r.verdict.message), "不中英夾雜");
  }
});

Deno.test("隱私且達門檻：擋，error=privacy", async () => {
  const r = await screenQuestion("幫我查劉德華現在住在哪裡", () => Promise.resolve(reply("privacy", 0.97)));
  assertEquals(r.verdict.action, "block");
  if (r.verdict.action === "block") {
    assertEquals(r.verdict.error, "privacy");
    assert(!/[A-Za-z]/.test(r.verdict.message), "不中英夾雜");
  }
});

Deno.test("低於門檻：放行（差一點也放，剛好達標才擋）", () => {
  const a = verdictOfAsk(reply("off_topic", 0.79));
  assertEquals(a.action, "allow");
  assertEquals(a.action === "allow" && a.reason, "below_threshold");
  assertEquals(verdictOfAsk(reply("privacy", ASK_SCREEN_MIN_PROBABILITY - 0.0001)).action, "allow");
  assertEquals(verdictOfAsk(reply("privacy", ASK_SCREEN_MIN_PROBABILITY)).action, "block");
});

Deno.test("出錯、逾時、沒金鑰、回怪答案：一律放行並帶出原因", async () => {
  const boom = await screenQuestion("台北市長照家庭照顧者有什麼補助", () => Promise.reject(new Error("typesafe systemone 500")));
  assertEquals(boom.verdict.action, "allow");
  assertStringIncludes(boom.error ?? "", "500");

  const slow = await screenQuestion("台北市長照家庭照顧者有什麼補助", () => new Promise<JevResponse>(() => {}), 20);
  assertEquals(slow.verdict.action, "allow");
  assertStringIncludes(slow.error ?? "", "逾時");

  const nokey = await screenQuestion("台北市長照家庭照顧者有什麼補助", null);
  assertEquals(nokey.verdict.action, "allow");
  assertStringIncludes(nokey.error ?? "", "金鑰");

  assertEquals(verdictOfAsk(reply("something_else", 1)).action, "allow");
  assertEquals(verdictOfAsk(undefined).action, "allow");
});

Deno.test("withTimeout：正常完成會回值", async () => {
  assertEquals(await withTimeout(Promise.resolve(7), 1000), 7);
});

Deno.test("jev_decisions 的 subject_type／question 清單有擴", () => {
  assert((SUBJECT_TYPES as readonly string[]).includes(ASK_SCREEN_SUBJECT));
  assert((QUESTIONS as readonly string[]).includes(ASK_SCREEN_QUESTION));
});
