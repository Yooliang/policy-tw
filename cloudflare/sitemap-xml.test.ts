/// <reference lib="deno.ns" />
/**
 * 網站地圖 XML 組字（#466）。守：有 lastmod 才寫標籤、沒有就整個省略；索引的 lastmod＝該份裡最晚的網址；
 * 特殊字元要跳脫（網址有 & 不跳脫整份 XML 會壞，爬蟲整份丟掉）。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { escapeXml, newestLastmod, SITEMAP_CHUNK_SIZE, SITEMAP_MAX_URLS, sitemapIndexXml, splitSitemap, urlsetXml } from "./sitemap-xml.js";

Deno.test("urlset：有 lastmod 才寫標籤，沒有就省略（不用建置當天頂替）", () => {
  const xml = urlsetXml([
    { loc: "https://x.tw/policy/1", lastmod: "2026-10-05T08:00:02Z" },
    { loc: "https://x.tw/elections", lastmod: null },
    { loc: "https://x.tw/tracking" },
  ]);
  assertEquals(xml.includes("<url><loc>https://x.tw/policy/1</loc><lastmod>2026-10-05T08:00:02Z</lastmod></url>"), true);
  assertEquals(xml.includes("<url><loc>https://x.tw/elections</loc></url>"), true);
  assertEquals(xml.includes("<url><loc>https://x.tw/tracking</loc></url>"), true);
  assertEquals((xml.match(/<lastmod>/g) ?? []).length, 1);
});

Deno.test("索引：每份的 lastmod＝裡面最晚的網址；一個都沒有就不寫", () => {
  const a = [{ loc: "a1", lastmod: "2026-01-01T00:00:00Z" }, { loc: "a2", lastmod: "2026-03-01T00:00:00Z" }, { loc: "a3", lastmod: null }];
  const b = [{ loc: "b1", lastmod: null }];
  assertEquals(newestLastmod(a), "2026-03-01T00:00:00Z");
  assertEquals(newestLastmod(b), null);
  const xml = sitemapIndexXml([
    { loc: "https://x.tw/sitemap-a.xml", lastmod: newestLastmod(a) },
    { loc: "https://x.tw/sitemap-b.xml", lastmod: newestLastmod(b) },
  ]);
  assertEquals(xml.includes("<sitemap><loc>https://x.tw/sitemap-a.xml</loc><lastmod>2026-03-01T00:00:00Z</lastmod></sitemap>"), true);
  assertEquals(xml.includes("<sitemap><loc>https://x.tw/sitemap-b.xml</loc></sitemap>"), true);
});

Deno.test("跳脫特殊字元", () => {
  assertEquals(escapeXml(`a&b<c>"d"'e'`), "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
  assertEquals(urlsetXml([{ loc: "https://x.tw/?a=1&b=2" }]).includes("?a=1&amp;b=2"), true);
});

// 2026-11-26：政見破 5 萬，單檔超過協議上限，守門讓整個 build 紅
Deno.test("splitSitemap：54,666 筆拆成 2 檔，第一檔名不變，每檔 ≤ 40,000", () => {
  const items = Array.from({ length: 54666 }, (_, i) => ({ loc: `https://x.tw/policy/${i}` }));
  const parts = splitSitemap("sitemap-policies.xml", items);
  assertEquals(parts.map((p) => p.file), ["sitemap-policies.xml", "sitemap-policies-2.xml"]);
  assertEquals(parts.map((p) => p.items.length), [40000, 14666]);
  assertEquals(parts.every((p) => p.items.length <= SITEMAP_CHUNK_SIZE && p.items.length <= SITEMAP_MAX_URLS), true);
  // 順序保留、不漏不重
  assertEquals(parts[0].items[0], items[0]);
  assertEquals(parts[1].items[0], items[40000]);
  assertEquals(parts[0].items.length + parts[1].items.length, items.length);
});

Deno.test("splitSitemap：沒超過就只有一檔、檔名不變；剛好整除不會多出空檔；超過兩檔依序編 -2、-3", () => {
  assertEquals(splitSitemap("sitemap-policies.xml", [{ loc: "a" }]).map((p) => p.file), ["sitemap-policies.xml"]);
  assertEquals(splitSitemap("s.xml", [1, 2, 3, 4], 2).map((p) => p.file), ["s.xml", "s-2.xml"]);
  assertEquals(splitSitemap("s.xml", [1, 2, 3, 4, 5], 2).map((p) => p.file), ["s.xml", "s-2.xml", "s-3.xml"]);
  assertEquals(splitSitemap("s.xml", [], 2), []);
});

Deno.test("索引列出全部分檔，每檔 lastmod 取該檔最大者", () => {
  const items = [
    { loc: "https://x.tw/policy/1", lastmod: "2026-03-01T00:00:00Z" },
    { loc: "https://x.tw/policy/2", lastmod: "2026-05-01T00:00:00Z" },
    { loc: "https://x.tw/policy/3", lastmod: "2026-04-01T00:00:00Z" },
  ];
  const parts = splitSitemap("sitemap-policies.xml", items, 2);
  const xml = sitemapIndexXml(parts.map((p) => ({ loc: `https://x.tw/${p.file}`, lastmod: newestLastmod(p.items) })));
  assertEquals(xml.includes("<loc>https://x.tw/sitemap-policies.xml</loc><lastmod>2026-05-01T00:00:00Z</lastmod>"), true);
  assertEquals(xml.includes("<loc>https://x.tw/sitemap-policies-2.xml</loc><lastmod>2026-04-01T00:00:00Z</lastmod>"), true);
});
