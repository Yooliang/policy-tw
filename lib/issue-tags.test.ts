import { assertEquals } from "jsr:@std/assert@1";
import { isJunkTag, issueTagsOf } from "./issue-tags.ts";

// 2026-09-22 維護者：新北市議題頁的標籤出現「2026新北市長」「蘇巧慧」「2026」「中央社RSS」「務實施政」——都不是議題
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

// 與 SQL 版 issue_tags_of 對照的案例表（議題串聯 issues_summary／issues_page 用 SQL 分組）。
// 同一張表也在 supabase/functions/_shared/issues-summary-sql.test.ts（SQL 端逐案比對）；改規則兩邊一起改。
export const SQL_PARITY_NAMES = ["王小明", "鳳山", "鳳山區"];
export const SQL_PARITY_CASES: Array<[string[] | null, string | null, string[]]> = [
  [["交通", "2026高雄市長"], "其他", ["交通"]],
  [null, "交通", ["交通"]],
  [["鳳山", "王小明"], "教育文化", ["教育文化"]],
  [["交通", "長照", "交通"], "x", ["交通", "長照"]],
  [[" 長照 "], null, ["長照"]],
  [["中央社RSS", "務實施政"], "其他", []],
  [["高雄市"], "經濟", ["經濟"]],
  [["2026"], "環境", ["環境"]],
  [["A"], "環境", ["環境"]],
  [[], "", []],
  [["高雄市長候選人"], "醫療衛生", ["醫療衛生"]],
  [["臺南"], null, []],
  [["臉書粉專貼文"], "社會福利", ["社會福利"]],
  [["預算 公共"], "  ", ["預算 公共"]],
];
Deno.test("與 SQL 版對照的案例表：issueTagsOf 的結果（排序後）符合預期", () => {
  const names = new Set(SQL_PARITY_NAMES);
  for (const [tags, cat, want] of SQL_PARITY_CASES) {
    assertEquals([...issueTagsOf({ tags, category: cat }, names)].sort(), [...want].sort(), JSON.stringify([tags, cat]));
  }
});
