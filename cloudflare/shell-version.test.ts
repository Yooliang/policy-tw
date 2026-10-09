/// <reference lib="deno.ns" />
/**
 * 殼的版本（policy-ops#37）：邊緣快取的頁跟現在的殼不同版就不能再發（舊頁指著已刪的 /assets 檔）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { sameShell, shellVersion } from "./shell-version.js";

const shell = (js: string, css: string) => `<html><head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>
<script type="module" crossorigin src="/assets/${js}"></script>
<link rel="stylesheet" crossorigin href="/assets/${css}">
</head><body><div id="app"></div></body></html>`;

Deno.test("版本＝殼載入的 /assets 檔名（排序、去重），外部 script 不算", () => {
  assertEquals(shellVersion(shell("app-BY83WJkH.js", "app-CCj9RsMV.css")), "/assets/app-BY83WJkH.js /assets/app-CCj9RsMV.css");
  assertEquals(shellVersion(shell("app-a.js", "app-b.css") + '<link rel="modulepreload" href="/assets/app-a.js">'), "/assets/app-a.js /assets/app-b.css");
});

Deno.test("重新建置（檔名換了）＝不同版；同一份＝同一版", () => {
  const before = shellVersion(shell("app-BY83WJkH.js", "app-CCj9RsMV.css"));
  assert(!sameShell(before, shellVersion(shell("app-NEW00000.js", "app-CCj9RsMV.css"))), "js 換了");
  assert(!sameShell(before, shellVersion(shell("app-BY83WJkH.js", "app-NEW00000.css"))), "css 換了");
  assert(sameShell(before, shellVersion(shell("app-BY83WJkH.js", "app-CCj9RsMV.css"))));
});

Deno.test("舊 Worker 存的頁（沒有版本標頭）一律當不同版；認不得的殼兩邊都是空字串＝同一版", () => {
  assert(!sameShell(null, "/assets/app-a.js"));
  assert(!sameShell(undefined, ""));
  assertEquals(shellVersion("<html></html>"), "");
  assert(sameShell("", shellVersion("<html></html>")));
});

Deno.test("真的 index.html 建出來的殼抓得到入口（寫法變了這條會紅）", async () => {
  const indexHtml = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  // 原始碼的 index.html 入口是 /main.ts 之類的原始檔，建置後才變成 /assets/app-*.js；這裡只確認 ASSET_RE 認得建置後的寫法
  assert(indexHtml.includes('type="module"'), "前提：index.html 用 module script 載入入口");
  assertEquals(shellVersion('<script type="module" crossorigin src="/assets/app-Ab_c-1.2.js"></script>'), "/assets/app-Ab_c-1.2.js");
});
