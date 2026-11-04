/** 政黨分流圖的顏色：政黨色與 lib/party.ts 一致、年齡單一色相由淺到深、類別色循環、未提供與小黨為灰。 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  AGE_RAMP_DARK, AGE_RAMP_LIGHT, ageColorOf, CATEGORICAL, categoricalColorAt, NEUTRAL, PARTY_HEX, partyColorOf, TAILWIND_HEX,
} from "./party-flow-colors.ts";

Deno.test("政黨色與 lib/party.ts 的 PARTY_COLORS 逐一一致（從原始碼讀，不是複製一份）", () => {
  const src = Deno.readTextFileSync(new URL("./party.ts", import.meta.url));
  const pairs = [...src.matchAll(/\{ match: '([^']+)', color: '(bg-[a-z]+-\d+)' \}/g)].map((m) => [m[1], m[2]]);
  assert(pairs.length >= 7, "讀得到 party.ts 的對應表");
  for (const [name, cls] of pairs) {
    assert(TAILWIND_HEX[cls], `${cls} 沒有 hex 對照`);
    assertEquals(partyColorOf(name).color, TAILWIND_HEX[cls], name);
  }
  assertEquals(Object.keys(PARTY_HEX).sort(), pairs.map((p) => p[0]).sort(), "兩邊的政黨集合相同");
});

Deno.test("沒有專屬色的小黨與無黨籍同一個中性灰", () => {
  for (const n of ["無黨籍", "小民參政歐巴桑聯盟", "台灣團結聯盟", ""]) assertEquals(partyColorOf(n), NEUTRAL);
});

Deno.test("年齡：六階，年齡組 20～70 對應 0～5，超界夾住；淺色版由淺到深、深色版由暗到亮", () => {
  assertEquals([20, 30, 40, 50, 60, 70].map((a) => ageColorOf(a).color), [...AGE_RAMP_LIGHT]);
  assertEquals([20, 30, 40, 50, 60, 70].map((a) => ageColorOf(a).colorDark), [...AGE_RAMP_DARK]);
  assertEquals(ageColorOf(10).color, AGE_RAMP_LIGHT[0]);
  assertEquals(ageColorOf(90).color, AGE_RAMP_LIGHT[5]);
  const lum = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  for (let i = 1; i < 6; i++) {
    assert(lum(AGE_RAMP_LIGHT[i]) < lum(AGE_RAMP_LIGHT[i - 1]), "淺色版逐階變深");
    assert(lum(AGE_RAMP_DARK[i]) > lum(AGE_RAMP_DARK[i - 1]), "深色版逐階變亮");
  }
});

Deno.test("類別色：八色固定順序、循環時第 9 個回到第 1 個、相鄰兩個永遠不同色、不含灰", () => {
  assertEquals(CATEGORICAL.length, 8);
  assertEquals(categoricalColorAt(8), categoricalColorAt(0));
  assertEquals(categoricalColorAt(-1), categoricalColorAt(7));
  for (let i = 0; i < 30; i++) assertNotEquals(categoricalColorAt(i).color, categoricalColorAt(i + 1).color);
  assert(CATEGORICAL.every((c) => c.color !== NEUTRAL.color));
  assertEquals(new Set(CATEGORICAL.map((c) => c.color)).size, 8);
});
