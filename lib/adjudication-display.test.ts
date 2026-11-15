import { assertEquals } from "jsr:@std/assert@1";
import { adjudicatedId, isAdjudication, verdictLabel } from "./adjudication-display.ts";

Deno.test("強模型裁決：只認 adjudication 這個型別", () => {
  assertEquals(isAdjudication("adjudication"), true);
  assertEquals(isAdjudication("policy"), false);
});

Deno.test("強模型裁決：裁決結果講中文，看不懂的不編", () => {
  assertEquals(verdictLabel({ verdict: "uphold" }), "原貢獻正確");
  assertEquals(verdictLabel({ verdict: "reject" }), "原貢獻有誤");
  assertEquals(verdictLabel({ verdict: "uphold_with_correction" }), "原貢獻部分修正後採用");
  assertEquals(verdictLabel({ verdict: "天外飛來" }), null);
  assertEquals(verdictLabel({}), null);
  assertEquals(verdictLabel(null), null);
});

Deno.test("強模型裁決：取被裁的原貢獻 id", () => {
  assertEquals(adjudicatedId({ contribution_id: "abc" }), "abc");
  assertEquals(adjudicatedId({ contribution_id: "" }), null);
  assertEquals(adjudicatedId({ contribution_id: 5 }), null);
  assertEquals(adjudicatedId(undefined), null);
});
