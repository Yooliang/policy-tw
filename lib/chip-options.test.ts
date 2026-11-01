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

import { cachedCountySet, cachedTownSet, cachedVillageSet, resolvePopulated, type ChipCountCache } from "./chip-options.ts";

const CACHE: ChipCountCache = {
  election: 2026,
  county: { "A": { "縣市長": 3 }, "B": { "縣市長": 0, "縣市議員": 5 } },
  town: { "A1": { "鄉鎮市長": 2 }, "A2": { "鄉鎮市民代表": 4 } },
  village: { "A1": ["乙村"] },
};

Deno.test("快取：縣市／鄉鎮依職位人數>0 決定亮，0 或沒有就灰", () => {
  const counties = { codes: ["A", "B"], names: ["甲縣", "乙縣"] };
  assertEquals([...cachedCountySet(CACHE, counties, ["縣市長"])!], ["甲縣"]);
  const towns = { codes: ["A1", "A2", "A3"], names: ["一鄉", "二鄉", "三鄉"] };
  assertEquals([...cachedTownSet(CACHE, towns, ["鄉鎮市長"])!], ["一鄉"]);
  assertEquals([...cachedTownSet(CACHE, towns, ["鄉鎮市長", "鄉鎮市民代表"])!], ["一鄉", "二鄉"]);
  const out = chipOptions(towns.names, cachedTownSet(CACHE, towns, ["鄉鎮市長"]));
  assertEquals(out.map((o) => o.dim), [false, true, true]);
});

Deno.test("快取：沒有快取或鄉鎮都不在快取裡＝不下判斷（null，不灰）", () => {
  assertEquals(cachedCountySet(null, { codes: ["A"], names: ["甲縣"] }, ["縣市長"]), null);
  assertEquals(cachedTownSet(CACHE, { codes: ["Z1"], names: ["某鄉"] }, ["鄉鎮市長"]), null);
  assertEquals(cachedTownSet(CACHE, null, ["鄉鎮市長"]), null);
});

Deno.test("快取：村里只灰名單上的；鄉鎮不在快取回 null", () => {
  const set = cachedVillageSet(CACHE, "A1", ["甲村", "乙村"]);
  assertEquals(chipOptions(["甲村", "乙村"], set).map((o) => o.dim), [false, true]);
  assertEquals(cachedVillageSet(CACHE, "A9", ["甲村"]), null);
  assertEquals(cachedVillageSet(CACHE, null, ["甲村"]), null);
});

Deno.test("合併：即時資料讀完以即時為準（快取說灰、即時說有人就亮；反之亦然）；未讀完用快取", () => {
  const cached = new Set(["甲"]);
  assertEquals([...resolvePopulated(new Set(["乙"]), cached)!], ["乙"]);
  assertEquals(resolvePopulated(null, cached), cached);
  assertEquals(resolvePopulated(null, null), null);
  const merged = chipOptions(["甲", "乙"], resolvePopulated(new Set(["乙"]), cached));
  assertEquals(merged.map((o) => o.dim), [true, false]);
});

Deno.test("ElectionPage：晶片列用快取＋即時合併（resolvePopulated）", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  assert(page.includes("resolvePopulated("), "晶片標灰要經 resolvePopulated 合併快取與即時");
});
