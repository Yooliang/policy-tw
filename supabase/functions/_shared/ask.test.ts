import { assertEquals } from "jsr:@std/assert@1";
import { ASK_DAILY_LIMIT_PER_IP, buildAskTaskTitle, decideAsk, isValidQuestionLength } from "./ask.ts";

Deno.test("isValidQuestionLength：trim 後 8～300 字", () => {
  assertEquals(isValidQuestionLength("市長有蓋圖書館嗎？"), true);
  assertEquals(isValidQuestionLength("  市長有蓋圖書館嗎？  "), true, "前後空白不算長度");
  assertEquals(isValidQuestionLength("太短"), false);
  assertEquals(isValidQuestionLength("字".repeat(301)), false);
  assertEquals(isValidQuestionLength(123), false);
  assertEquals(isValidQuestionLength(undefined), false);
});

Deno.test("buildAskTaskTitle：取前 40 字，超過才加刪節號", () => {
  assertEquals(buildAskTaskTitle("市長有蓋圖書館嗎？"), "回答民眾提問：市長有蓋圖書館嗎？");
  const long = "字".repeat(50);
  assertEquals(buildAskTaskTitle(long), `回答民眾提問：${"字".repeat(40)}…`);
  assertEquals(buildAskTaskTitle("  前後有空白的問題  "), "回答民眾提問：前後有空白的問題", "先 trim 再截");
});

Deno.test("decideAsk：依序判斷限額 → 內容品質 → 24h 重複 → 建立", () => {
  assertEquals(decideAsk({ usedToday: ASK_DAILY_LIMIT_PER_IP, question: "市長有蓋圖書館嗎？", recentQuestions: [] }), { action: "rate_limited" });
  assertEquals(decideAsk({ usedToday: ASK_DAILY_LIMIT_PER_IP + 1, question: "市長有蓋圖書館嗎？", recentQuestions: [] }), { action: "rate_limited" }, "超過也算，不是只有剛好命中");
  assertEquals(decideAsk({ usedToday: 0, question: "你好", recentQuestions: [] }), { action: "rejected", reason: "low_effort" });
  assertEquals(decideAsk({ usedToday: 0, question: "市長有蓋圖書館嗎？", recentQuestions: ["市長有蓋圖書館嗎"] }), { action: "rejected", reason: "duplicate" });
  assertEquals(decideAsk({ usedToday: 0, question: "市長有蓋圖書館嗎？", recentQuestions: [] }), { action: "create" });
  // 限額擋在最前面：就算內容也有問題，優先回報額度用完
  assertEquals(decideAsk({ usedToday: ASK_DAILY_LIMIT_PER_IP, question: "你好", recentQuestions: [] }), { action: "rate_limited" });
});
