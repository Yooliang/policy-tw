/// <reference lib="deno.ns" />
/**
 * 網站地圖 XML 組字（#466）。守：有 lastmod 才寫標籤、沒有就整個省略；索引的 lastmod＝該份裡最晚的網址；
 * 特殊字元要跳脫（網址有 & 不跳脫整份 XML 會壞，爬蟲整份丟掉）。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { escapeXml, newestLastmod, sitemapIndexXml, urlsetXml } from "./sitemap-xml.js";

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
