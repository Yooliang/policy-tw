/**
 * 鄉鎮頁的兩條紅線（lib/election-townships.ts）：
 *   1. 鄉鎮比對跟 get_politicians_by_level 同一套——原住民區代表的「那瑪夏區第01選舉區」算那瑪夏區，
 *      不然預渲染的原住民區那一層整個是空的，hydrate 後瀏覽器撈回來才冒出來。
 *   2. 只有「鄉鎮頁會列出來的職位」有人在選才出頁：議員、立委、縣市長不算（他們在縣市頁），
 *      一位都沒有的鄉鎮不出空頁。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { inTownship, townshipOfSubRegion, townshipPagesOf, townshipPositions, type TownshipRecord } from "./election-townships.ts";

Deno.test("等值：里長、鄉鎮市長、代表的 sub_region 就是鄉鎮名", () => {
  assertEquals(inTownship("大林鎮", "大林鎮"), true);
  assertEquals(inTownship("三民區", "三民區"), true);
  assertEquals(inTownship("民雄鄉", "大林鎮"), false);
});

Deno.test("原住民區代表的選區（那瑪夏區第01選舉區）算那瑪夏區——跟 RPC 的 LIKE 同規則", () => {
  assertEquals(inTownship("那瑪夏區第01選舉區", "那瑪夏區"), true);
  assertEquals(inTownship("那瑪夏區第02選舉區", "那瑪夏區"), true);
  assertEquals(inTownship("烏來區第04選舉區", "烏來區"), true);
  // 桃源區的不會混進那瑪夏區；議員選區（沒有鄉鎮名開頭）不算任何鄉鎮
  assertEquals(inTownship("桃源區第01選舉區", "那瑪夏區"), false);
  assertEquals(inTownship("第01選舉區", "那瑪夏區"), false);
  // 前綴對了但尾巴不是選舉區的不算（SQL 的 LIKE 要求結尾是「選舉區」）
  assertEquals(inTownship("那瑪夏區第01選舉區附屬", "那瑪夏區"), false);
  assertEquals(inTownship("那瑪夏區第01選區", "那瑪夏區"), false);
});

Deno.test("臺與台當成同一個地方，兩邊都一樣", () => {
  assertEquals(inTownship("臺東市", "台東市"), true);
  assertEquals(inTownship("台東市", "臺東市"), true);
  assertEquals(inTownship("霧臺鄉第01選舉區", "霧台鄉"), true);
});

Deno.test("空值一律不算", () => {
  assertEquals(inTownship(null, "大林鎮"), false);
  assertEquals(inTownship(undefined, "大林鎮"), false);
  assertEquals(inTownship("大林鎮", ""), false);
});

Deno.test("sub_region 的鄉鎮名：去掉原住民區代表的選舉區；議員、立委選區不是鄉鎮", () => {
  assertEquals(townshipOfSubRegion("大林鎮"), "大林鎮");
  assertEquals(townshipOfSubRegion("那瑪夏區第01選舉區"), "那瑪夏區");
  assertEquals(townshipOfSubRegion("第01選舉區"), null);
  assertEquals(townshipOfSubRegion("臺北市第01選區"), null);
  assertEquals(townshipOfSubRegion(""), null);
  assertEquals(townshipOfSubRegion(null), null);
});

Deno.test("鄉鎮頁列的職位：縣轄鄉鎮是鄉鎮市長、代表、村里長；直轄市是原住民區長、區代表、里長", () => {
  assertEquals([...townshipPositions(false)].sort(), ["村里長", "鄉鎮市民代表", "鄉鎮市長"].sort());
  assertEquals([...townshipPositions(true)].sort(), ["村里長", "直轄市山地原住民區民代表", "直轄市山地原住民區長"].sort());
});

const COUNTIES = new Set(["嘉義縣", "高雄市", "台東縣", "台北市"]);
const isCounty = (r: string) => COUNTIES.has(r);
const isSpecial = (r: string) => r === "高雄市" || r === "台北市";
const rec = (electionId: number, region: string, subRegion: string | null, electionType: string): TownshipRecord =>
  ({ electionId, region, subRegion, electionType });

Deno.test("出頁的鄉鎮：鄉鎮層或村里長有人才出，一個鄉鎮一屆一頁", () => {
  const pages = townshipPagesOf([
    rec(2022, "嘉義縣", "大林鎮", "鄉鎮市長"),
    rec(2022, "嘉義縣", "大林鎮", "村里長"),
    rec(2022, "嘉義縣", "大林鎮", "村里長"),
    rec(2022, "高雄市", "那瑪夏區第01選舉區", "直轄市山地原住民區民代表"),
    rec(2022, "高雄市", "三民區", "村里長"),
    rec(2026, "嘉義縣", "民雄鄉", "鄉鎮市長"),
  ], isCounty, isSpecial);
  const key = (p: { electionId: number; region: string; township: string }) => `${p.electionId}/${p.region}/${p.township}`;
  assertEquals(pages.map(key).sort(), [
    "2022/嘉義縣/大林鎮",
    "2022/高雄市/三民區",
    "2022/高雄市/那瑪夏區",
    "2026/嘉義縣/民雄鄉",
  ].sort());
});

Deno.test("縣市層的人不會生出鄉鎮頁：議員選區、立委選區、縣市長", () => {
  const pages = townshipPagesOf([
    rec(2022, "嘉義縣", "第01選舉區", "縣市議員"),
    rec(2022, "嘉義縣", null, "縣市長"),
    rec(2024, "台北市", "臺北市第01選區", "立法委員"),
    // 職位對、但不在這種縣市的（直轄市沒有鄉鎮市長）也不算——頁面不會列它
    rec(2022, "高雄市", "三民區", "鄉鎮市長"),
    // 不是縣市的（全國不分區）
    rec(2024, "全國", "不分區", "立法委員"),
  ], isCounty, isSpecial);
  assertEquals(pages, []);
});

Deno.test("同一個鄉鎮的臺／台兩種寫法只出一頁，網址用先看到的寫法", () => {
  const pages = townshipPagesOf([
    rec(2022, "台東縣", "臺東市", "村里長"),
    rec(2022, "台東縣", "台東市", "鄉鎮市長"),
  ], isCounty, isSpecial);
  assertEquals(pages, [{ electionId: 2022, region: "台東縣", township: "臺東市" }]);
});
