/// <reference lib="deno.ns" />
/**
 * 殼的版本（policy-ops#37）：邊緣快取的頁跟現在的殼不同版就不能再發（舊頁指著已刪的 /assets 檔）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createShellLoader, sameShell, shellVersion, shouldRerender } from "./shell-version.js";

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

// ---- 主線審查（#540）：拿不到殼不能當換版、抓失敗要冷卻；各附還原驗證 ----

Deno.test("拿不到殼（null）＝沿用快取，不重算；拿得到才比版本", () => {
  const v = shellVersion(shell("app-a.js", "app-b.css"));
  assertEquals(shouldRerender(v, null), false);
  assertEquals(shouldRerender(v, shell("app-a.js", "app-b.css")), false);
  assertEquals(shouldRerender(v, shell("app-NEW.js", "app-b.css")), true);
  assertEquals(shouldRerender(null, shell("app-a.js", "app-b.css")), true, "舊 Worker 存的頁");
  // 還原驗證：舊寫法把拿不到殼當成空字串來比，會判成換版
  const oldWay = (cached: string | null, current: string | null) => !sameShell(cached, shellVersion(current ?? ""));
  assertEquals(oldWay(v, null), true);
});

function fakeClockLoader(results: Array<string | Error>, o: { ttlMs?: number; failCooldownMs?: number } = {}) {
  let t = 0;
  let calls = 0;
  const loader = createShellLoader(() => {
    const r = results[Math.min(calls, results.length - 1)];
    calls++;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }, { ttlMs: o.ttlMs ?? 60_000, failCooldownMs: o.failCooldownMs ?? 10_000, now: () => t });
  return { loader, tick: (ms: number) => { t += ms; }, calls: () => calls };
}

Deno.test("殼：成功的 60 秒內不重抓，過了才重抓", async () => {
  const f = fakeClockLoader(["v1", "v2"]);
  assertEquals(await f.loader.load(), "v1");
  f.tick(59_000);
  assertEquals(await f.loader.load(), "v1");
  assertEquals(f.calls(), 1);
  f.tick(2_000);
  assertEquals(await f.loader.load(), "v2");
  assertEquals(f.calls(), 2);
});

Deno.test("殼：抓失敗後冷卻期內不重抓——有上一份就照用、沒有就丟錯；冷卻過了再試", async () => {
  const boom = new Error("shell 503");
  const f = fakeClockLoader(["v1", boom, boom, "v2"]);
  await f.loader.load();
  f.tick(61_000);
  assertEquals(await f.loader.load(), "v1", "失敗時用上一份");
  for (let i = 0; i < 5; i++) { f.tick(1_000); assertEquals(await f.loader.load(), "v1"); }
  assertEquals(f.calls(), 2, "冷卻期內每個請求都不再打 app.html");
  f.tick(6_000);
  assertEquals(await f.loader.load(), "v1", "冷卻過了重試，又失敗，照用上一份");
  assertEquals(f.calls(), 3);
  f.tick(11_000);
  assertEquals(await f.loader.load(), "v2");

  const cold = fakeClockLoader([boom, "v1"]);
  let threw = 0;
  for (let i = 0; i < 3; i++) { try { await cold.loader.load(); } catch { threw++; } cold.tick(1_000); }
  assertEquals([threw, cold.calls()], [3, 1], "沒有殼可用：丟錯，但只打一次");
  assertEquals(await cold.loader.peek(), null, "peek 拿不到回 null");
  cold.tick(10_000);
  assertEquals(await cold.loader.load(), "v1");

  // 還原驗證：沒有冷卻（0 毫秒），抖動時每個請求都重抓
  const noCool = fakeClockLoader(["v1", boom], { failCooldownMs: 0 });
  await noCool.loader.load();
  noCool.tick(61_000);
  for (let i = 0; i < 5; i++) { await noCool.loader.load(); noCool.tick(1_000); }
  assert(noCool.calls() > 2, `沒有冷卻時會一直重抓（${noCool.calls()} 次）`);
});

Deno.test("殼：同時多個請求只打一次", async () => {
  const f = fakeClockLoader(["v1"]);
  const got = await Promise.all([f.loader.load(), f.loader.load(), f.loader.load()]);
  assertEquals(got, ["v1", "v1", "v1"]);
  assertEquals(f.calls(), 1);
});
