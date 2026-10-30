/**
 * data/tw-raster-index.json（選舉頁手機版晶片列用的精簡名稱索引）要跟 data/tw-raster 的縣市／鄉鎮名單一致。
 * 不一致時重跑：node scripts/build-tw-raster-index.mjs
 */
import { assertEquals } from "jsr:@std/assert@1";

const read = async (path: string) => JSON.parse(await Deno.readTextFile(new URL(`../data/${path}`, import.meta.url)));
const index = await read("tw-raster-index.json");

Deno.test("名稱索引的縣市清單跟 national.json 一致", async () => {
  const national = await read("tw-raster/national.json");
  assertEquals(index.counties, { codes: national.codes, names: national.names });
});

Deno.test("名稱索引的每個縣市都有鄉鎮清單，且跟 towns/*.json 一致", async () => {
  for (const code of index.counties.codes as string[]) {
    const t = await read(`tw-raster/towns/${code}.json`);
    assertEquals(index.towns[code], { codes: t.codes, names: t.names }, `縣市 ${code} 的鄉鎮清單不一致`);
  }
  assertEquals(Object.keys(index.towns).length, index.counties.codes.length);
});
