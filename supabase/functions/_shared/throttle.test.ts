// /next 節流：協議寫的數字與程式的上限必須是同一個（規則只寫在一邊，另一邊就會漂）
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isThrottled, NEXT_PER_MINUTE } from "./throttle.ts";

Deno.test("一分鐘內派滿上限就擋，未滿放行", () => {
  assertEquals(isThrottled(NEXT_PER_MINUTE - 1), false);
  assertEquals(isThrottled(NEXT_PER_MINUTE), true);
});

Deno.test("skill.md 守則第 2 條寫的每分鐘上限＝程式的 NEXT_PER_MINUTE", async () => {
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assert(skill.includes(`每分鐘最多 ${NEXT_PER_MINUTE} 次`), `skill.md 要寫「每分鐘最多 ${NEXT_PER_MINUTE} 次」`);
  const next = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assert(next.includes("isThrottled("), "/next 要真的執行節流，不能只寫在協議裡");
});
