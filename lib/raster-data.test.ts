/**
 * 預先產生的點陣檔（data/tw-raster/）的完整性守門：
 * 每個行政區至少 1 格、格子不重疊（一格只有一個序號，且序號都在清單內）、代碼跟 admin_divisions 一致。
 * 官方清單用 scripts/fixtures/admin-codes.txt（admin_divisions.code，2026-10-19 匯出）；
 * 區劃異動時：更新這份清單、重跑 scripts/build-tw-raster.ts。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { cellCounts, decodeRaster, SEA, type RasterFile } from "./raster-grid.ts";

const read = async (path: string) => JSON.parse(await Deno.readTextFile(new URL(`../data/tw-raster/${path}`, import.meta.url))) as RasterFile;
const admin = (await Deno.readTextFile(new URL("../scripts/fixtures/admin-codes.txt", import.meta.url))).split(/\r?\n/).filter(Boolean);
const level = (len: number, parent = "") => admin.filter((c) => c.length === len && c.startsWith(parent)).sort();

function check(file: RasterFile, expected: string[], what: string) {
  assertEquals([...file.codes].sort(), expected, `${what}：行政區代碼跟 admin_divisions 不一致`);
  assertEquals(new Set(file.codes).size, file.codes.length, `${what}：代碼重複`);
  const raster = decodeRaster(file);
  const counts = cellCounts(raster.cells, file.codes.length);
  counts.forEach((n, i) => assert(n >= 1, `${what}：${file.codes[i]} 一格都沒有`));
  for (const v of raster.cells) assert(v >= SEA && v < file.codes.length, `${what}：格值 ${v} 超出清單`);
  // 各塊的游程總長要剛好等於塊的面積（沒有漏格、沒有多格）
  for (const layer of file.layers) {
    let n = 0;
    for (let i = 1; i < layer.rle.length; i += 2) n += layer.rle[i];
    assertEquals(n, layer.w * layer.h, `${what}：游程長度跟塊的大小不符`);
  }
  assert(file.cellM > 0);
}

Deno.test("官方清單：縣市 22、鄉鎮市區 368、村里 7,781", () => {
  assertEquals([level(5).length, level(8).length, level(11).length], [22, 368, 7781]);
});

Deno.test("全國：22 縣市每個至少 1 格，1 公里一格，澎湖金門連江是內嵌框", async () => {
  const file = await read("national.json");
  check(file, level(5), "全國");
  assertEquals(file.cellM, 1000);
  assertEquals(file.layers.filter((l) => l.inset).length, 3);
  const land = [...decodeRaster(file).cells].filter((v) => v >= 0).length;
  assert(land > 30000 && land < 45000, `全國陸地格數 ${land} 應該約 3.6 萬`);
});

Deno.test("縣市層：每個縣市一個檔，鄉鎮市區代碼與官方一致、每區至少 1 格、1 公里一格", async () => {
  for (const county of level(5)) {
    const file = await read(`towns/${county}.json`);
    check(file, level(8, county), `縣市 ${county}`);
    assertEquals(file.cellM, 1000, `縣市 ${county} 尺度`);
  }
});

Deno.test("村里層：每個鄉鎮一個檔，村里代碼與官方一致、每里至少 1 格、尺度是 200 公尺的整數倍", async () => {
  let villages = 0;
  for (const town of level(8)) {
    const file = await read(`villages/${town}.json`);
    check(file, level(11, town), `鄉鎮 ${town}`);
    assertEquals(file.cellM % 200, 0, `鄉鎮 ${town} 尺度`);
    villages += file.codes.length;
  }
  assertEquals(villages, 7781);
});
