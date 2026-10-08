/// <reference lib="deno.ns" />
/**
 * 邊緣 SSR 的 301／404 回應（#466：已合併的人物 54472fee 線上回 404，本該 301 到保留的 8aa6ee40）。守四件事：
 *   1. 301 帶 Location＝本站網域＋保留者的路徑，不進快取（max-age 只給瀏覽器）
 *   2. 轉向目的地只收同站路徑；`//evil`、完整網址、換行一律不轉（當 404）
 *   3. 404 不快取（no-store）：新建的人物不能被「剛才查不到」卡住
 *   4. 200／passthrough 回 null，交給原本流程
 */
import { assertEquals } from "jsr:@std/assert@1";
import { nonPageResponse, safeLocalPath, safeSearch } from "./render-status.js";

const shell = '<html><body><div id="app"></div></body></html>';
const ctx = { shell, origin: "https://xn--2lw665d.tw" };

Deno.test("301：Location 是本站網域＋保留者路徑，不快取成 200", async () => {
  const res = nonPageResponse({ status: 301, location: "/politician/8aa6ee40-231a-447a-a967-99bcf8b35d3f" }, ctx)!;
  assertEquals(res.status, 301);
  assertEquals(res.headers.get("Location"), "https://xn--2lw665d.tw/politician/8aa6ee40-231a-447a-a967-99bcf8b35d3f");
  assertEquals(await res.text(), "");
});

Deno.test("301 照帶原網址的查詢字串（?view=、?tab=、?utm_…），不帶時沒有多餘的 ?", () => {
  const to = "/politician/8aa6ee40-231a-447a-a967-99bcf8b35d3f";
  const withQ = nonPageResponse({ status: 301, location: to }, { ...ctx, search: "?tab=policies&utm_source=fb" })!;
  assertEquals(withQ.headers.get("Location"), `https://xn--2lw665d.tw${to}?tab=policies&utm_source=fb`);
  assertEquals(nonPageResponse({ status: 301, location: to }, { ...ctx, search: "" })!.headers.get("Location"), `https://xn--2lw665d.tw${to}`);
  assertEquals(nonPageResponse({ status: 301, location: to }, ctx)!.headers.get("Location"), `https://xn--2lw665d.tw${to}`);
  // 不是 ? 開頭、帶換行或空白、只有 ? → 丟掉，不拿來組標頭
  for (const bad of ["tab=1", "?a=1\r\nSet-Cookie: x=1", "?a b", "?", "#frag"]) assertEquals(safeSearch(bad), "");
});

Deno.test("301 的目的地不是同站路徑 → 當 404，不轉", () => {
  for (const bad of ["https://evil.example/x", "//evil.example/x", "politician/x", "/a\r\nSet-Cookie: x=1", "/a\\b", undefined, ""]) {
    const res = nonPageResponse({ status: 301, location: bad as string }, ctx)!;
    assertEquals(res.status, 404, `location=${JSON.stringify(bad)}`);
  }
  assertEquals(safeLocalPath("/politician/abc"), "/politician/abc");
});

Deno.test("404：殼＋空的初始狀態，不快取", async () => {
  const res = nonPageResponse({ status: 404 }, ctx)!;
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  const body = await res.text();
  assertEquals(body.includes('window.__INITIAL_STATE__="{}"'), true);
});

Deno.test("200 與 passthrough 不歸這裡管", () => {
  assertEquals(nonPageResponse({ status: 200 }, ctx), null);
  assertEquals(nonPageResponse({ status: "passthrough" }, ctx), null);
});

Deno.test("ssr-worker.js 真的把 render 結果交給 nonPageResponse（接線守門）", async () => {
  const src = await Deno.readTextFile(new URL("./ssr-worker.js", import.meta.url));
  assertEquals(/import \{ nonPageResponse \} from '\.\/render-status\.js'/.test(src), true);
  assertEquals(/const special = nonPageResponse\(r, \{ shell, origin, search \}\)/.test(src), true);
  // 查詢字串要從請求一路傳到 renderAndStore，不然 301 會丟掉 ?tab=
  assertEquals(/renderAndStore\(path, url\.origin, cacheKey, cache, url\.search\)/.test(src), true);
});
