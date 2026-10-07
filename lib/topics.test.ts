/**
 * 主題詞彙表的守門（docs/PLAN-markdown-views.md 3.2、5）。
 * 詞彙表只有 lib/topics.ts 一份；這裡守的是「同義詞指得出唯一的主題、名稱不歧義」——
 * `/data/<縣市>/<名稱>.md` 的第二段要先認分類、再認主題，名稱重了就會悄悄指到錯的那一個。
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  REGIONS,
  REGION_ALIASES,
  TOPICS,
  findRegions,
  findTopics,
  parseTopicQuery,
  regionByName,
  topicByName,
  topicCandidates,
} from "./topics.ts";
import { TAIWAN_COUNTIES } from "./election-regions.ts";
import { POLICY_CATEGORIES } from "../supabase/functions/_shared/category-map.ts";

const norm = (s: string) => s.normalize("NFKC").replace(/臺/g, "台").trim();

Deno.test("主題 key 與名稱不重複，且每個主題都有同義詞與對應分類", () => {
  assertEquals(new Set(TOPICS.map((t) => t.key)).size, TOPICS.length);
  assertEquals(new Set(TOPICS.map((t) => t.label)).size, TOPICS.length);
  for (const t of TOPICS) {
    assert(/^[a-z]+$/.test(t.key), `${t.key} 要是小寫英文`);
    assert(t.synonyms.length > 0, `${t.label} 沒有同義詞`);
    assert(t.categories.length > 0, `${t.label} 沒有對應分類`);
  }
});

Deno.test("主題草案是 16 個（計畫 3.2）", () => {
  assertEquals(TOPICS.length, 16);
});

Deno.test("對應分類都是 19 類裡的正規值", () => {
  for (const t of TOPICS) {
    for (const c of t.categories) assert((POLICY_CATEGORIES as readonly string[]).includes(c), `${t.label} 的分類「${c}」不在 19 類裡`);
  }
});

Deno.test("同義詞：至少兩個字、不得同時屬於兩個主題", () => {
  const owner = new Map<string, string>();
  for (const t of TOPICS) {
    for (const s of t.synonyms) {
      const n = norm(s);
      assert([...n].length >= 2, `「${s}」太短，單字會到處誤中`);
      const prev = owner.get(n);
      assert(prev === undefined || prev === t.key, `「${s}」同時屬於 ${prev} 與 ${t.key}`);
      owner.set(n, t.key);
    }
    assertEquals(new Set(t.synonyms.map(norm)).size, t.synonyms.length, `${t.label} 的同義詞有重複`);
  }
});

Deno.test("主題名稱與同義詞不得等於任何分類名稱（第二段要先認分類，名稱不能歧義）", () => {
  const cats = new Set<string>(POLICY_CATEGORIES.map(norm));
  for (const t of TOPICS) {
    assert(!cats.has(norm(t.label)), `主題名稱「${t.label}」跟分類重名`);
    for (const s of t.synonyms) assert(!cats.has(norm(s)), `「${t.label}」的同義詞「${s}」跟分類重名`);
  }
});

Deno.test("主題名稱不得是別的主題的同義詞", () => {
  for (const a of TOPICS) {
    for (const b of TOPICS) {
      if (a !== b) assert(!b.synonyms.map(norm).includes(norm(a.label)), `「${a.label}」是 ${b.key} 的同義詞`);
    }
  }
});

Deno.test("縣市清單與站內的 22 縣市同一份（順序也一樣）", () => {
  assertEquals([...REGIONS], [...TAIWAN_COUNTIES]);
  for (const v of Object.values(REGION_ALIASES)) assert(REGIONS.includes(v), `簡稱指向不存在的縣市 ${v}`);
});

Deno.test("topicByName：全名、同義詞、「臺」寫法都認得；認不得回 undefined", () => {
  assertEquals(topicByName("育兒")?.key, "childcare");
  assertEquals(topicByName("少子化與育兒")?.key, "childcare");
  assertEquals(topicByName("托育")?.key, "childcare");
  assertEquals(topicByName("捷運")?.key, "transit");
  assertEquals(topicByName("不存在的詞"), undefined);
  assertEquals(topicByName("交通建設"), undefined); // 分類名稱不是主題
  assertEquals(topicByName(""), undefined);
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

Deno.test("topicCandidates：標題或說明有同義詞才算；只有分類不算", () => {
  assertEquals(topicCandidates({ title: "擴大公共托育", description: "", category: "社會福利" }), ["childcare"]);
  assertEquals(topicCandidates({ title: "某某計畫", description: "增設幼兒園名額", category: "教育文化" }), ["childcare"]);
  assertEquals(topicCandidates({ title: "某某計畫", description: "沒有關鍵字", category: "社會福利" }), []);
  assertEquals(topicCandidates({ title: null, description: null, category: null }), []);
});

Deno.test("topicCandidates：標題命中比說明命中優先，分類相符加分，多個候選全回、不截斷", () => {
  const r = topicCandidates({ title: "捷運延伸並增設停車場", description: "", category: "交通建設" });
  assertEquals(r.sort(), ["roads", "transit"]);
  const t = topicCandidates({ title: "興建日照中心", description: "提供失智長者照顧；兒童遊戲場", category: "社會福利" });
  assertEquals(t[0], "elderly");
  assert(t.includes("parks"));
});

Deno.test("topicCandidates：臺／台視為同字", () => {
  assertEquals(topicCandidates({ title: "臺鐵增班", description: "", category: "交通建設" }), ["transit"]);
});

Deno.test("parseTopicQuery：縣市＋主題、簡稱、全形、順序不拘", () => {
  assertEquals(parseTopicQuery("台南 育兒"), { region: "台南市", topic: "childcare" });
  assertEquals(parseTopicQuery("育兒　臺南市"), { region: "台南市", topic: "childcare" });
  assertEquals(parseTopicQuery("台南育兒"), { region: "台南市", topic: "childcare" });
  assertEquals(parseTopicQuery("北市 捷運"), { region: "台北市", topic: "transit" });
  assertEquals(parseTopicQuery("新北 長照"), { region: "新北市", topic: "elderly" });
});

Deno.test("parseTopicQuery：只有縣市、只有主題、都沒有", () => {
  assertEquals(parseTopicQuery("高雄"), { region: "高雄市" });
  assertEquals(parseTopicQuery("托嬰"), { topic: "childcare" });
  assertEquals(parseTopicQuery("今天天氣"), {});
  assertEquals(parseTopicQuery(""), {});
});

Deno.test("findRegions／findTopics：最長優先、不重複命中；多個縣市看得出來", () => {
  assertEquals(findRegions("新北市 台北市 育兒"), ["新北市", "台北市"]);
  assertEquals(findRegions("新北"), ["新北市"]); // 「新北」裡的「北」不會被當成北市
  assertEquals(findRegions("台南市"), ["台南市"]);
  assertEquals(findTopics("育兒津貼"), ["childcare"]); // 長詞蓋掉短詞，不另外算「津貼」
  assertNotEquals(findTopics("育兒津貼").includes("welfare"), true);
  assertEquals(findTopics("長照 托育").sort(), ["childcare", "elderly"]);
});
