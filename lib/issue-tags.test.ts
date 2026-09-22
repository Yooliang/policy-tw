import { assertEquals } from "jsr:@std/assert@1";
import { isJunkTag, issueTagsOf } from "./issue-tags.ts";

// 2026-09-22 小良哥：新北市議題頁的標籤出現「2026新北市長」「蘇巧慧」「2026」「中央社RSS」「務實施政」——都不是議題
const NAMES = new Set(["蘇巧慧", "李四川", "柯志恩"]);

Deno.test("候選人名、年份、屆別標籤、來源、口號、縣市名都是垃圾", () => {
  for (const t of ["蘇巧慧", "2026", "2026新北市長", "桃園市長", "中央社RSS", "務實施政", "民生優先", "高雄市", "高雄", "選戰策略"]) {
    assertEquals(isJunkTag(t, NAMES), true, t);
  }
});
Deno.test("真的議題留下", () => {
  for (const t of ["捷運", "長照", "托幼", "動物保護", "青年創業", "AI教育", "軌道建設", "敬老卡", "交通建設"]) {
    assertEquals(isJunkTag(t, NAMES), false, t);
  }
});
Deno.test("一筆政見：去垃圾、去重；一個不剩就退回類別；類別是其他就空", () => {
  assertEquals(issueTagsOf({ tags: ["蘇巧慧", "捷運", "捷運", "2026"], category: "交通建設" }, NAMES), ["捷運"]);
  assertEquals(issueTagsOf({ tags: ["蘇巧慧", "2026"], category: "交通建設" }, NAMES), ["交通建設"]);
  assertEquals(issueTagsOf({ tags: [], category: "社會福利" }, NAMES), ["社會福利"]);
  assertEquals(issueTagsOf({ tags: null, category: "其他" }, NAMES), []);
});
