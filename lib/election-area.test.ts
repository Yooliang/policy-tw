/**
 * 某一屆參選的地區不借人物的鄉鎮村里（縣市長、議員、立委、總統）；鄉鎮層級五種照舊可以退回人物的（2026-10-05）。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { COUNTY_LEVEL_ELECTION_TYPES, electionArea } from "./election-area.ts";

// 陳映辰：人物的地區是她 2022 當里長的「台中市 大雅區 上雅里」，2026 議員那一筆只到縣市
const person = { region: "台中市", subRegion: "大雅區", village: "上雅里" };

Deno.test("議員那一屆沒有選區 → 就是沒有，不借人物的區與里", () => {
  assertEquals(electionArea("縣市議員", { region: "台中市" }, person), { region: "台中市", subRegion: undefined, village: undefined });
});

Deno.test("議員那一屆有選區 → 用它", () => {
  assertEquals(electionArea("縣市議員", { region: "台中市", subRegion: "第05選舉區" }, person).subRegion, "第05選舉區");
});

Deno.test("議員那一屆的地區是借來的（視圖改好之前的舊資料）：不是正式選區就不收", () => {
  assertEquals(electionArea("縣市議員", { region: "台中市", subRegion: "大雅區", village: "上雅里" }, person).subRegion, undefined);
  assertEquals(electionArea("縣市議員", { region: "台中市", subRegion: "臺中市第03選區" }, person).subRegion, undefined);
  assertEquals(electionArea("立法委員", { region: "台中市", subRegion: "臺中市第03選區" }, person).subRegion, "臺中市第03選區");
  assertEquals(electionArea("縣市長", { region: "屏東縣", subRegion: "東勢區", village: "隆興里" }, person).village, undefined);
});

Deno.test("縣市長、立委、總統也不借；縣市沒有才退回人物的縣市", () => {
  for (const t of COUNTY_LEVEL_ELECTION_TYPES) {
    const a = electionArea(t, {}, person);
    assertEquals([a.region, a.subRegion, a.village], ["台中市", undefined, undefined], t);
  }
});

Deno.test("村里長、鄉鎮市長那一屆沒給 → 照舊退回人物的鄉鎮村里（既有行為，等 township_gap 補）", () => {
  assertEquals(electionArea("村里長", { region: "台中市" }, person), { region: "台中市", subRegion: "大雅區", village: "上雅里" });
  assertEquals(electionArea("鄉鎮市長", { region: "台中市", subRegion: "豐原區" }, person).subRegion, "豐原區");
  assertEquals(electionArea(undefined, undefined, person).subRegion, "大雅區", "不知道選舉別時照舊");
});
