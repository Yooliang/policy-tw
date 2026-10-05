import { assertEquals } from "jsr:@std/assert@1";
import { scoreBarTitle, scorePercent } from "./score-bar.ts";

Deno.test("scorePercent：−目標在最左、0 在正中、＋目標在最右", () => {
  assertEquals(scorePercent(-3, 3), 0);
  assertEquals(scorePercent(0, 3), 50);
  assertEquals(scorePercent(3, 3), 100);
  assertEquals(scorePercent(1, 3), 67);
  assertEquals(scorePercent(-1, 3), 33);
});

Deno.test("scorePercent：超出範圍夾在兩端（已上線的分數常高過目標、退件的低過 −目標）", () => {
  assertEquals(scorePercent(7, 3), 100);
  assertEquals(scorePercent(-9, 3), 0);
});

Deno.test("scorePercent：沒有分數當 0、目標至少 1（不除以零）", () => {
  assertEquals(scorePercent(null, 3), 50);
  assertEquals(scorePercent(undefined, undefined), 50);
  assertEquals(scorePercent(1, 0), 100);
});

Deno.test("scoreBarTitle：寫明分數與兩端門檻；三種票數都給了才附票數", () => {
  assertEquals(scoreBarTitle(2, 3), "分數 2／通過 3、退件 −3");
  assertEquals(scoreBarTitle(-1, 4, { agree: 1, disagree: 2, unsure: 0 }), "分數 -1／通過 4、退件 −4（同意 1・反對 2・存疑 0）");
  assertEquals(scoreBarTitle(2, 3, { agree: 2 }), "分數 2／通過 3、退件 −3");
});
