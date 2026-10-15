import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { AskRejectedError, parseAskResponse } from "./ask-response.ts";

Deno.test("parseAskResponse：通過就回 questionId 與已送出提示", () => {
  assertEquals(parseAskResponse(201, { success: true, question_id: "q1", message: "已收到" }), { questionId: "q1", message: "已收到" });
});

Deno.test("parseAskResponse：off_topic／privacy 的 400 丟 AskRejectedError，message 原樣帶出", () => {
  for (const code of ["off_topic", "privacy"] as const) {
    const err = assertThrows(() => parseAskResponse(400, { success: false, error: code, message: "這題不收，可以改問政見" }), AskRejectedError);
    assertEquals(err.code, code);
    assertEquals(err.message, "這題不收，可以改問政見");
  }
});

Deno.test("parseAskResponse：其他錯誤維持原行為", () => {
  assertThrows(() => parseAskResponse(429, { message: "額度滿了" }), Error, "額度滿了");
  assertThrows(() => parseAskResponse(400, { success: false, error: "low_effort", message: "請具體一點" }), Error, "請具體一點");
  assertThrows(() => parseAskResponse(500, null), Error, "HTTP 500");
  // 沒帶 message 的 off_topic 不當成被擋（保守退回一般錯誤）
  assertThrows(() => parseAskResponse(400, { error: "off_topic" }), Error, "off_topic");
});
