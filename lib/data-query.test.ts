/**
 * 文字查詢的詞表守門（維護者 2026-10-07 裁示：「主題」就用既有分類）。
 * 詞表只有 lib/data-query.ts 一份；這裡守的是「說法指得出唯一的分類」——查詢裡的詞同時屬於兩個分類，就會悄悄轉到錯的那一個。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CATEGORIES, CATEGORY_SYNONYMS, REGIONS, REGION_ALIASES, categoryByName, findCategories, findRegions, normalizeText, parseDataQuery, regionByName,
} from "./data-query.ts";
import { TAIWAN_COUNTIES } from "./election-regions.ts";
import { POLICY_CATEGORIES } from "../supabase/functions/_shared/category-map.ts";

const norm = normalizeText;

Deno.test("分類全名跟後端、網站同一份（19 類、順序也一樣）", () => {
  assertEquals([...CATEGORIES], [...POLICY_CATEGORIES]);
  assertEquals(CATEGORIES.length, 19);
});

Deno.test("常見說法：每個分類都有一格、至少兩個字、只屬於一個分類、不得等於任何分類全名", () => {
  assertEquals(Object.keys(CATEGORY_SYNONYMS).sort(), [...CATEGORIES].sort());
  const cats = new Set<string>(CATEGORIES.map(norm));
  const owner = new Map<string, string>();
  for (const [cat, words] of Object.entries(CATEGORY_SYNONYMS)) {
    for (const w of words) {
      const n = norm(w);
      assert([...n].length >= 2, `「${w}」太短，單字會到處誤中`);
      assert(!cats.has(n), `「${w}」等於分類全名`);
      const prev = owner.get(n);
      assert(prev === undefined || prev === cat, `「${w}」同時屬於 ${prev} 與 ${cat}`);
      owner.set(n, cat);
    }
    assertEquals(new Set(words.map(norm)).size, words.length, `${cat} 的說法有重複`);
  }
});

Deno.test("縣市清單與站內的 22 縣市同一份（順序也一樣）；簡稱都指向存在的縣市", () => {
  assertEquals([...REGIONS], [...TAIWAN_COUNTIES]);
  for (const v of Object.values(REGION_ALIASES)) assert(REGIONS.includes(v), `簡稱指向不存在的縣市 ${v}`);
});

Deno.test("categoryByName：全名、常見說法、全形都認得；認不得回 undefined", () => {
  assertEquals(categoryByName("交通建設"), "交通建設");
  assertEquals(categoryByName("育兒"), "社會福利");
  assertEquals(categoryByName("捷運"), "交通建設");
  assertEquals(categoryByName("　長照 "), "社會福利");
  assertEquals(categoryByName("不存在的詞"), undefined);
  assertEquals(categoryByName(""), undefined);
});

Deno.test("regionByName：全名、簡稱、臺寫法；市縣都有的「新竹」「嘉義」不猜", () => {
  assertEquals(regionByName("台南市"), "台南市");
  assertEquals(regionByName("臺南市"), "台南市");
  assertEquals(regionByName("台南"), "台南市");
  assertEquals(regionByName("北市"), "台北市");
  assertEquals(regionByName("竹縣"), "新竹縣");
  assertEquals(regionByName("新竹"), undefined);
  assertEquals(regionByName("嘉義"), undefined);
  assertEquals(regionByName("火星"), undefined);
});

Deno.test("parseDataQuery：縣市＋分類、簡稱、全形、順序不拘、育兒／托育／長照→社會福利、捷運／公車→交通建設", () => {
  assertEquals(parseDataQuery("台南 育兒"), { region: "台南市", category: "社會福利" });
  assertEquals(parseDataQuery("育兒　臺南市"), { region: "台南市", category: "社會福利" });
  assertEquals(parseDataQuery("台南育兒"), { region: "台南市", category: "社會福利" });
  assertEquals(parseDataQuery("北市 捷運"), { region: "台北市", category: "交通建設" });
  assertEquals(parseDataQuery("新北 公車"), { region: "新北市", category: "交通建設" });
  assertEquals(parseDataQuery("高雄 長照"), { region: "高雄市", category: "社會福利" });
  assertEquals(parseDataQuery("台南 交通建設"), { region: "台南市", category: "交通建設" });
});

Deno.test("parseDataQuery：只有縣市、只有分類、都沒有", () => {
  assertEquals(parseDataQuery("高雄"), { region: "高雄市" });
  assertEquals(parseDataQuery("托嬰"), { category: "社會福利" });
  assertEquals(parseDataQuery("今天天氣"), {});
  assertEquals(parseDataQuery(""), {});
});

Deno.test("findRegions／findCategories：最長優先、不重複命中；多個看得出來", () => {
  assertEquals(findRegions("新北市 台北市 育兒"), ["新北市", "台北市"]);
  assertEquals(findRegions("新北"), ["新北市"]); // 「新北」裡的「北」不會被當成北市
  assertEquals(findCategories("教育文化"), ["教育文化"], "全名先吃掉那一段，裡面的「教育」不另算");
  assertEquals(findCategories("社會福利"), ["社會福利"]);
  assertEquals(findCategories("長照 捷運").sort(), ["交通建設", "社會福利"]);
  assertEquals(findCategories("育兒津貼 托育"), ["社會福利"], "同一個分類只算一次");
});
