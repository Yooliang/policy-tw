import { assertEquals } from "jsr:@std/assert@1";
import { isCanonicalCategory, normalizeCategory, POLICY_CATEGORIES } from "./category-map.ts";

Deno.test("分類對照：舊寫法轉正規值，正規值與未知值原樣", () => {
  assertEquals(normalizeCategory("交通"), "交通建設");
  assertEquals(normalizeCategory("社會"), "社會福利");
  assertEquals(normalizeCategory("社福"), "社會福利");
  assertEquals(normalizeCategory("經濟"), "經濟發展");
  assertEquals(normalizeCategory("環境"), "環境保護");
  assertEquals(normalizeCategory("教育"), "教育文化");
  assertEquals(normalizeCategory(" 交通 "), "交通建設", "trim 後對照");
  assertEquals(normalizeCategory("交通建設"), "交通建設");
  assertEquals(normalizeCategory("經濟補助"), "經濟補助", "不在表裡原樣保留");
  assertEquals(normalizeCategory("能源"), "能源");
  assertEquals(normalizeCategory("其他"), "其他");
  assertEquals(normalizeCategory(null), null);
  assertEquals(normalizeCategory(""), null);
  assertEquals(POLICY_CATEGORIES.length, 8);
  assertEquals(isCanonicalCategory("其他"), false);
});
