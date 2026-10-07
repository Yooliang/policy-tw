/**
 * 政見矩陣抽屜的 .md 預覽：front matter 不當正文、連結新分頁開、資料庫來的內容不能夾帶 HTML／危險網址。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { renderPage } from "./format.ts";
import { renderMdPreview, safeHref, splitFrontMatter } from "./html.ts";

const sample = renderPage({
  title: "台南市　交通",
  htmlPath: null,
  dataAsOf: "2026-10-06T10:00:00+08:00",
  scope: "2026 年　5 筆",
  preface: [],
  body: ["## 賴清德", "", "- [興建捷運](https://example.com/a?x=1&y=2)　出處待補", "", "| 欄 | 值 |", "| --- | --- |", "| a | 1 |"],
  rowCount: 1,
}, "/data/2026/台南市/交通.md", Date.parse("2026-10-07T00:00:00+08:00"));

Deno.test("front matter 拆掉：不出現在 HTML、只取資料更新日、開頭 H1 拿掉", () => {
  const { fields, body } = splitFrontMatter(sample);
  assertEquals(fields.title, "台南市　交通");
  assert(!body.startsWith("---"));
  const out = renderMdPreview(sample);
  assertEquals(out.dataAsOf, "2026-10-06");
  assert(!out.html.includes("format_version"));
  assert(!out.html.includes("<h1"));
  assertStringIncludes(out.html, "<h2");
  assertStringIncludes(out.html, "<table");
  assertStringIncludes(out.html, "<blockquote");
  assertStringIncludes(out.html, "<li>");
});

Deno.test("連結一律新分頁開、帶 noopener", () => {
  const out = renderMdPreview(sample);
  assertStringIncludes(out.html, '<a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">');
});

Deno.test("沒有 front matter 就整份當本文", () => {
  const out = renderMdPreview("## 標題\n\n內文");
  assertEquals(out.dataAsOf, null);
  assertStringIncludes(out.html, "<h2");
});

Deno.test("原始 HTML 跳脫、危險網址拿掉、圖片不載入", () => {
  const out = renderMdPreview([
    "<script>alert(1)</script>",
    "",
    "行內 <img src=x onerror=alert(1)> 與 [點我](javascript:alert(1)) 與 [tab](java\tscript:alert(1))",
    "",
    "![圖](https://evil.example/p.png)",
    "",
    "<javascript:alert(1)>",
  ].join("\n"));
  assert(!out.html.includes("<script"));
  assert(!out.html.includes("<img"));
  assert(!/href="javascript/i.test(out.html));
  assertStringIncludes(out.html, "&lt;script&gt;");
  assertStringIncludes(out.html, "點我");
});

Deno.test("safeHref：只放 http／https／mailto 與站內路徑", () => {
  assertEquals(safeHref("https://a.tw/x"), "https://a.tw/x");
  assertEquals(safeHref("mailto:a@b.tw"), "mailto:a@b.tw");
  assertEquals(safeHref("/election/2026"), "/election/2026");
  assertEquals(safeHref("//evil.example"), null);
  assertEquals(safeHref("javascript:alert(1)"), null);
  assertEquals(safeHref("data:text/html,x"), null);
  assertEquals(safeHref(""), null);
});
