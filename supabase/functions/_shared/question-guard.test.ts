import { assert, assertEquals } from "jsr:@std/assert@1";
import { isDuplicateQuestion, isLowEffortQuestion, normalizeQuestionText } from "./question-guard.ts";

Deno.test("normalizeQuestionText：拿掉標點空白、轉小寫", () => {
  assertEquals(normalizeQuestionText("你好，請問一下？"), "你好請問一下");
  assertEquals(normalizeQuestionText("  Hello, World!  "), "helloworld");
});

Deno.test("isLowEffortQuestion：純問候／測試／情緒字或太短 → 擋", () => {
  assert(isLowEffortQuestion("你好"), "太短");
  assert(isLowEffortQuestion("測試"), "太短且是灌水詞");
  assert(isLowEffortQuestion("你好你好你好你好"), "重複堆疊的問候詞，拿光後沒有實質內容");
  assert(isLowEffortQuestion("哈囉哈囉，在嗎在嗎？？？"), "問候＋標點堆疊，去掉後沒有實質內容");
  assert(isLowEffortQuestion("幹！！！！！！"), "情緒字＋標點，去掉後沒有實質內容");
  assert(isLowEffortQuestion("1234567"), "去掉標點只剩 7 個字元，未達 8");
});

Deno.test("isLowEffortQuestion：帶灌水詞但還有實質內容 → 不擋", () => {
  assert(!isLowEffortQuestion("你好，請問里長的長照政見是什麼？"), "問候詞之外還有實質問題");
  assert(!isLowEffortQuestion("測試一下，市長有沒有承諾蓋圖書館？"), "測試詞之外還有實質問題");
});

Deno.test("isLowEffortQuestion：正常提問（8 字以上、非灌水詞）→ 不擋", () => {
  assert(!isLowEffortQuestion("市長候選人有沒有提到長照政策？"));
  assert(!isLowEffortQuestion("這條路什麼時候會拓寬完工？"));
});

Deno.test("isDuplicateQuestion：正規化後相同才算重複，只是主題相近不算", () => {
  const recent = ["市長候選人有沒有提到長照政策？", "請問垃圾分類新制何時上路？"];
  assert(isDuplicateQuestion("市長候選人有沒有提到長照政策", recent), "只差標點");
  assert(isDuplicateQuestion("  市長候選人有沒有提到長照政策？  ", recent), "只差前後空白");
  assert(!isDuplicateQuestion("市長候選人有沒有提到托育政策？", recent), "主題相近但內容不同");
  assertEquals(isDuplicateQuestion("隨便問一句話", []), false);
});
