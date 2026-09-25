import { assert, assertEquals } from "jsr:@std/assert";
import { CITY_CODES } from "./cec-city-codes.ts";

// 中選會縣市代碼原本在兩個檔案各抄了一份（fetch-cec-data 與 AdminScraper.vue；後者 2026-09-23 下架），2026-09-21 發現金門／連江配反：
// 整批 2022 金門議員被存成連江、連江存成金門，electoral_district_areas 也對調。
// 2026-09-26：cec-sync 也要用同一份代碼，把這份表搬進 _shared/cec-city-codes.ts 當唯一正本，
// fetch-cec-data 與 cec-sync 都從那裡 import，不再各自抄一份。這支測試改成直接驗那份正本，
// 並確認 fetch-cec-data／cec-sync 真的是 import 進去、沒有偷偷再抄一份。
// 正確對應的證據是抓回來的鄉鎮：007 回南竿北竿莒光東引（馬祖），020 回金城金寧金沙金湖烈嶼烏坵（金門）。
const CANONICAL = [
  { name: "連江縣", prv: "09", city: "007" },
  { name: "金門縣", prv: "09", city: "020" },
] as const;

Deno.test("_shared/cec-city-codes 正本：金門／連江跟正規表一致", () => {
  for (const c of CANONICAL) {
    assertEquals(CITY_CODES[c.name], { prv: c.prv, city: c.city }, `${c.name} 的代碼配錯了`);
  }
});

async function importsSharedCityCodes(relativePath: string): Promise<boolean> {
  const src = await Deno.readTextFile(new URL(relativePath, import.meta.url));
  return /from\s+["']\.\.\/_shared\/cec-city-codes\.ts["']/.test(src) && !/"連江縣":\s*\{\s*prv:/.test(src);
}

Deno.test("fetch-cec-data 吃共用版縣市代碼，沒有自己再抄一份", async () => {
  assert(await importsSharedCityCodes("../fetch-cec-data/index.ts"), "fetch-cec-data 應該 import _shared/cec-city-codes.ts，且不再內嵌一份 CITY_CODES");
});

Deno.test("cec-sync 吃共用版縣市代碼，沒有自己再抄一份", async () => {
  assert(await importsSharedCityCodes("../cec-sync/index.ts"), "cec-sync 應該 import _shared/cec-city-codes.ts，且不再內嵌一份 CITY_CODES");
});
