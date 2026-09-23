import { assert, assertEquals } from "jsr:@std/assert";

// 中選會縣市代碼原本在兩個檔案各抄了一份（fetch-cec-data 與 AdminScraper.vue；後者 2026-09-23 下架），2026-09-21 發現金門／連江配反：
// 整批 2022 金門議員被存成連江、連江存成金門，electoral_district_areas 也對調。
// 這支測試盯兩份清單彼此一致，並跟這裡簽進來的正規對照一致；代碼是中選會定的、穩定不變。
// 正確對應的證據是抓回來的鄉鎮：007 回南竿北竿莒光東引（馬祖），020 回金城金寧金沙金湖烈嶼烏坵（金門）。
const CANONICAL = [
  { name: "連江縣", prv: "09", city: "007" },
  { name: "金門縣", prv: "09", city: "020" },
] as const;

function codesInEdgeFunction(src: string, name: string): { prv: string; city: string } | null {
  const i = src.indexOf(`"${name}":`);
  if (i < 0) return null;
  const m = src.slice(i, i + 80).match(/prv:\s*"(\d+)",\s*city:\s*"(\d+)"/);
  return m ? { prv: m[1], city: m[2] } : null;
}


Deno.test("fetch-cec-data 的縣市代碼：金門／連江跟正規表一致", async () => {
  const src = await Deno.readTextFile(new URL("../fetch-cec-data/index.ts", import.meta.url));
  for (const c of CANONICAL) {
    const got = codesInEdgeFunction(src, c.name);
    assert(got, `fetch-cec-data 找不到 ${c.name} 的代碼`);
    assertEquals(got, { prv: c.prv, city: c.city }, `${c.name} 的代碼配錯了`);
  }
});
