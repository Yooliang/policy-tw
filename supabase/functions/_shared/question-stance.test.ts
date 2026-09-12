import { assertEquals } from "jsr:@std/assert@1";
import { isStance, stanceValue, STANCE_DAILY_LIMIT_PER_IP } from "./question-stance.ts";

Deno.test("isStance：只收 up／down", () => {
  assertEquals(isStance("up"), true);
  assertEquals(isStance("down"), true);
  assertEquals(isStance("neutral"), false);
  assertEquals(isStance(1), false);
  assertEquals(isStance(undefined), false);
});

Deno.test("stanceValue：up=1、down=-1（對應 DB 的 SMALLINT CHECK）", () => {
  assertEquals(stanceValue("up"), 1);
  assertEquals(stanceValue("down"), -1);
});

Deno.test("STANCE_DAILY_LIMIT_PER_IP：有一個具名常數，不是散在端點裡的魔術數字", () => {
  assertEquals(typeof STANCE_DAILY_LIMIT_PER_IP, "number");
  assertEquals(STANCE_DAILY_LIMIT_PER_IP > 0, true);
});
