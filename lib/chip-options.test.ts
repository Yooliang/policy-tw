/**
 * 守晶片列「選項不依賴參選人資料」：參選人讀取中（null）或讀回來是空的，全部選項都在；
 * 只有讀完之後才把沒有參選人的地區標灰，讀取中不灰。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { chipOptions } from "./chip-options.ts";

const NAMES = ["竹北市", "竹東鎮", "新埔鎮", "湖口鄉"];

Deno.test("讀取中（populated=null）：全部選項都在、都不灰", () => {
  const out = chipOptions(NAMES, null);
  assertEquals(out.map((o) => o.value), NAMES);
  assert(out.every((o) => !o.dim));
});

Deno.test("參選人資料讀完但是空的：全部選項仍在，全部標灰（仍可按）", () => {
  const out = chipOptions(NAMES, new Set());
  assertEquals(out.map((o) => o.value), NAMES);
  assert(out.every((o) => o.dim));
});

Deno.test("讀完：有參選人的不灰、沒有的標灰；臺／台寫法視為同一個", () => {
  const norm = (n: string) => n.replace(/臺/g, "台");
  const out = chipOptions(["臺北市", "新北市"], new Set(["台北市"]), norm);
  assertEquals(out.map((o) => o.dim), [false, true]);
});

Deno.test("ElectionPage：選區快取不靠 electionId（它要等選舉清單讀完才有），用網址的選舉段；晶片列用 chipOptions 標灰", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  assert(page.includes("districtCacheApplies"), "選區快取的適用判斷");
  assert(!/electionId\.value === 2026 && code \?/.test(page), "不再用 electionId 當選區快取的閘門");
  assert(page.includes("chipOptions("), "晶片列用 chipOptions");
});

import { countyPopulatedSet } from "./chip-options.ts";

Deno.test("縣市晶片：選了某縣市時不標灰（回 null），不會把其他縣市全灰", () => {
  const set = countyPopulatedSet("新竹市", true, () => ["新竹市"]);
  assertEquals(set, null);
  assert(chipOptions(["新竹市", "台北市"], set).every((o) => !o.dim));
});

Deno.test("縣市晶片：全台已讀才依參選人標灰；讀取中不標灰", () => {
  const set = countyPopulatedSet("All", true, () => ["新竹市"]);
  assertEquals(chipOptions(["新竹市", "台北市"], set).map((o) => o.dim), [false, true]);
  assertEquals(countyPopulatedSet("All", false, () => ["新竹市"]), null);
});

Deno.test("ElectionPage：縣市晶片標灰一律經 countyPopulatedSet（不得直接用目前縣市的參選人）", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  assert(/const countyPopulated = \(\)[^\n]*countyPopulatedSet\(selectedRegion\.value/.test(page));
});
