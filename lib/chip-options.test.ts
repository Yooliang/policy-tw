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
