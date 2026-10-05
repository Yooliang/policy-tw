/**
 * 「臺」與「台」在這個資料庫裡混用（region 寫「台」、2024 立委的 sub_region 寫「臺」）。
 * 比對沒正規化就是靜靜地回 0 筆，而 0 筆在畫面上跟「這一區沒人參選」長得一樣。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { compareRegionName, normalizeRegionName, regionNameVariants, sameRegionName } from "./region-name.ts";

Deno.test("臺一律正規化成台", () => {
  assertEquals(normalizeRegionName("臺北市"), "台北市");
  assertEquals(normalizeRegionName("臺南市"), "台南市");
  assertEquals(normalizeRegionName("臺中市"), "台中市");
  assertEquals(normalizeRegionName("臺東縣"), "台東縣");
  assertEquals(normalizeRegionName("臺西鄉"), "台西鄉");
  // 一個字串裡出現兩次也要都換（2024 立委的選區格式）
  assertEquals(normalizeRegionName("臺北市第01選區"), "台北市第01選區");
});

Deno.test("本來就寫台的不動，空值回空字串", () => {
  assertEquals(normalizeRegionName("台北市"), "台北市");
  assertEquals(normalizeRegionName("嘉義縣"), "嘉義縣");
  assertEquals(normalizeRegionName(null), "");
  assertEquals(normalizeRegionName(undefined), "");
  assertEquals(normalizeRegionName(""), "");
});

Deno.test("前後空白去掉——資料裡的地名偶爾帶空白，帶著就比不中", () => {
  assertEquals(normalizeRegionName("  台北市 "), "台北市");
  assertEquals(normalizeRegionName("\t臺南市\n"), "台南市");
});

Deno.test("兩種寫法視為同一個地方", () => {
  assertEquals(sameRegionName("臺北市", "台北市"), true);
  assertEquals(sameRegionName("台南市", "臺南市"), true);
  assertEquals(sameRegionName("臺北市第01選區", "台北市第01選區"), true);
  // 不同的地方還是不同
  assertEquals(sameRegionName("台北市", "新北市"), false);
  assertEquals(sameRegionName("台西鄉", "台中市"), false);
});

Deno.test("空值之間算相同，空值跟地名不同", () => {
  assertEquals(sameRegionName(null, undefined), true);
  assertEquals(sameRegionName("", null), true);
  assertEquals(sameRegionName("台北市", null), false);
});

Deno.test("排序：先字數再筆畫", () => {
  const sorted = ["嘉義市", "大林鎮", "阿里山鄉", "民雄鄉"].sort(compareRegionName);
  // 三個字的在前（照 localeCompare），四個字的在後
  assertEquals(sorted[sorted.length - 1], "阿里山鄉");
  assertEquals(sorted.filter((s) => s.length === 3).length, 3);
});

Deno.test("排序：數字照大小不照字元（第02選舉區 在 第10選舉區 前面）", () => {
  // 兩者字數相同，走 localeCompare 的 numeric
  assertEquals(compareRegionName("第02選舉區", "第10選舉區") < 0, true);
});

Deno.test("排序穩定：同一個名字比較回 0", () => {
  assertEquals(compareRegionName("台北市", "台北市"), 0);
});

// PostgREST 的 .eq 沒辦法在資料庫端 replace，所以名錄那支查詢只能把兩種寫法都列出來查。
Deno.test("地名的兩種寫法都列出來（給 PostgREST 的 .in 用）", () => {
  assertEquals(regionNameVariants("台南市"), ["台南市", "臺南市"]);
  assertEquals(regionNameVariants("臺南市"), ["台南市", "臺南市"]);
  assertEquals(regionNameVariants("台西鄉"), ["台西鄉", "臺西鄉"]);
});

Deno.test("不含臺也不含台的地名只回一個值，不要多查一次一樣的東西", () => {
  assertEquals(regionNameVariants("嘉義縣"), ["嘉義縣"]);
  assertEquals(regionNameVariants("新北市"), ["新北市"]);
});

Deno.test("空值回空陣列——空陣列餵給 .in 會回 0 筆，而不是查到全部", () => {
  assertEquals(regionNameVariants(null), []);
  assertEquals(regionNameVariants(""), []);
  assertEquals(regionNameVariants("  "), []);
});
