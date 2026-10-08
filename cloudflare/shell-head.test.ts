/// <reference lib="deno.ns" />
/**
 * 邊緣渲染的 head 要跟預渲染一致（#461）：殼（index.html 建出來的 app.html）寫死的首頁版 title／description／og:*／twitter:*，
 * 在 Worker 組頁時要拿掉，換成每頁自己的。沒拿掉的話爬蟲與社群爬蟲讀到第一份——首頁的標題、首頁的分享圖。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { SHELL_HEAD_OVERRIDES, stripShellHead } from "./shell-head.js";

const indexHtml = await Deno.readTextFile(new URL("../index.html", import.meta.url));
const head = indexHtml.slice(indexHtml.indexOf("<head>"), indexHtml.indexOf("</head>"));

Deno.test("殼裡的首頁版 title／description／og:*／twitter:* 全部拿掉，其餘標籤不動", () => {
  const out = stripShellHead(indexHtml);
  for (const gone of ["<title>", 'property="og:', 'name="twitter:', 'name="viewport"']) {
    assert(head.includes(gone), `前提：index.html 本來有 ${gone}`);
    assert(!out.includes(gone), `${gone} 還在`);
  }
  assert(!out.includes('name="description"'));
  // 殼裡這幾樣不是每頁 head 會輸出的，要留著
  assertStringIncludes(out, 'rel="preconnect"');
  assertStringIncludes(out, "adsbygoogle.js");
  assertStringIncludes(out, '<div id="app"></div>');
});

Deno.test("殼裡的 og:image／twitter:card／twitter:image 是拿掉的重點（以前殼只被取代 title 與 og 文字，分享圖會變兩份）", () => {
  assertStringIncludes(indexHtml, 'property="og:image"');
  assertStringIncludes(indexHtml, 'name="twitter:card"');
  const out = stripShellHead(indexHtml);
  assertEquals(out.match(/og:image/g), null);
  assertEquals(out.match(/twitter:/g), null);
});

Deno.test("拿掉的規則清單裡有分享圖那兩條（還原驗證：少一條上面的測試就紅）", () => {
  const sources = SHELL_HEAD_OVERRIDES.map((re: RegExp) => re.source);
  assert(sources.some((s: string) => s.includes("og:image")));
  assert(sources.some((s: string) => s.includes("twitter:")));
});

Deno.test("Worker 組頁真的用 stripShellHead（接線守門）", async () => {
  const src = await Deno.readTextFile(new URL("./ssr-worker.js", import.meta.url));
  assertStringIncludes(src, "import { stripShellHead } from './shell-head.js'");
  assertStringIncludes(src, "if (r.headTags) html = stripShellHead(html)");
});
