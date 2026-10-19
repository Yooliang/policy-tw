/**
 * 現場渲染的時間預算與退路（cloudflare/fallback.js，policy-ops#135）：
 *   逾時／出錯 → 快取裡舊的（stale）→ 上游的殼（shell）→ 503；退路的回應不快取（no-store）；長尾頁 TTL 3600、其餘照設定
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
// @ts-ignore: 純 JS 模組（Worker 用）
import { BudgetExceeded, LONG_TAIL_TTL_S, RENDER_BUDGET_MS, cacheTtlForPath, isLongTailPath, markFallback, renderOrFallback, sMaxAgeForPath, withBudget } from "./fallback.js";
// @ts-ignore: 純 JS 模組（Worker 用）
import { readWorkerConfig } from "./worker-config.js";

const never = () => new Promise<Response>(() => {});
const page = (body: string) => new Response(body, { status: 200, headers: { "Cache-Control": "public, s-maxage=3600", "X-Cache": "HIT" } });

Deno.test("預算是 5 秒、長尾 TTL 是 3600（具名常數）", () => {
  assertEquals(RENDER_BUDGET_MS, 5000);
  assertEquals(LONG_TAIL_TTL_S, 3600);
});

Deno.test("withBudget：逾時丟 BudgetExceeded；時間內回結果；錯誤原樣丟", async () => {
  await assertRejects(() => withBudget(never, 20), BudgetExceeded);
  assertEquals(await withBudget(() => Promise.resolve(7), 20), 7);
  await assertRejects(() => withBudget(() => Promise.reject(new Error("db")), 20), Error, "db");
  await assertRejects(() => withBudget(() => { throw new Error("sync"); }, 20), Error, "sync");
});

Deno.test("逾時 → 有舊的就回舊的（X-SSR-Fallback: stale、no-store）", async () => {
  const res = await renderOrFallback({ render: never, stale: async () => page("舊頁"), shell: async () => page("殼"), budgetMs: 20 });
  assert(res);
  assertEquals(await res.text(), "舊頁");
  assertEquals(res.headers.get("X-SSR-Fallback"), "stale");
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  assertEquals(res.headers.get("X-Cache"), "FALLBACK");
});

Deno.test("逾時且沒有舊的 → 回上游的殼（X-SSR-Fallback: shell）", async () => {
  for (const stale of [null, async () => null]) {
    const res = await renderOrFallback({ render: never, stale, shell: async () => page("殼"), budgetMs: 20 });
    assert(res);
    assertEquals(await res.text(), "殼");
    assertEquals(res.headers.get("X-SSR-Fallback"), "shell");
    assertEquals(res.headers.get("Cache-Control"), "no-store");
  }
});

Deno.test("出錯（不是逾時）一樣退：先舊的、再殼", async () => {
  const boom = () => Promise.reject(new Error("PostgREST 500"));
  const a = await renderOrFallback({ render: boom, stale: async () => page("舊頁"), shell: async () => page("殼"), budgetMs: 20 });
  assertEquals(a!.headers.get("X-SSR-Fallback"), "stale");
  assertEquals(a!.headers.get("X-SSR-Error"), "PostgREST 500");
  const b = await renderOrFallback({ render: boom, shell: async () => page("殼"), budgetMs: 20 });
  assertEquals(b!.headers.get("X-SSR-Fallback"), "shell");
});

Deno.test("取舊的失敗、殼逾時 → 503＋Retry-After，不是丟例外", async () => {
  const res = await renderOrFallback({ render: never, stale: async () => { throw new Error("cache"); }, shell: never, budgetMs: 20 });
  assert(res);
  assertEquals(res.status, 503);
  assertEquals(res.headers.get("Retry-After"), "30");
  assertEquals(res.headers.get("X-SSR-Fallback"), "unavailable");
  assertEquals(res.headers.get("Cache-Control"), "no-store");
});

Deno.test("上游自己回 unavailable 的 503 時不被改標成 shell", () => {
  const u = markFallback(new Response("x", { status: 503, headers: { "X-SSR-Fallback": "unavailable" } }), "shell");
  assertEquals(u.headers.get("X-SSR-Fallback"), "unavailable");
});

Deno.test("正常時原樣回（含 render 回 null＝不歸這裡管）", async () => {
  const ok = await renderOrFallback({ render: async () => page("新鮮"), stale: async () => page("舊"), budgetMs: 20 });
  assertEquals(await ok!.text(), "新鮮");
  assertEquals(ok!.headers.get("X-SSR-Fallback"), null);
  assertEquals(await renderOrFallback({ render: async () => null, budgetMs: 20 }), null);
});

Deno.test("TTL 只對人物、政見與 .md 拉長到 3600，其餘照 SSR_CACHE_TTL_S", () => {
  const cfg = readWorkerConfig({});
  assertEquals(cfg.cacheTtlS, 600);
  for (const p of ["/politician/abc", "/policy/abc", "/politician/abc/", "/politician/abc.md", "/category/交通.md", "/data/2026/index.md"]) {
    assert(isLongTailPath(p), p);
    assertEquals(cacheTtlForPath(p, cfg), 3600, p);
  }
  for (const p of ["/lineage/abc", "/election/2026", "/", "/politicians/5", "/policy/a/b"]) {
    assertEquals(isLongTailPath(p), false, p);
    assertEquals(cacheTtlForPath(p, cfg), 600, p);
  }
  // 設定值改了，非長尾頁跟著走
  assertEquals(cacheTtlForPath("/lineage/x", readWorkerConfig({ SSR_CACHE_TTL_S: "120" })), 120);
});

Deno.test("s-maxage：長尾頁至少新鮮期的兩倍（過了新鮮期還留得住舊的），其餘維持 SSR_STALE_TTL_S", () => {
  const cfg = readWorkerConfig({});
  assertEquals(sMaxAgeForPath("/politician/x", cfg), 7200);
  assertEquals(sMaxAgeForPath("/lineage/x", cfg), 3600);
  assertEquals(sMaxAgeForPath("/politician/x", readWorkerConfig({ SSR_STALE_TTL_S: "86400" })), 86400);
});

Deno.test("錯誤訊息含中文也不會讓退路自己炸掉（標頭只留 ASCII）", async () => {
  const res = await renderOrFallback({ render: () => Promise.reject(new Error("資料庫逾時")), shell: async () => page("殼"), budgetMs: 20 });
  assertEquals(res!.headers.get("X-SSR-Fallback"), "shell");
  assertEquals(res!.headers.get("X-SSR-Error"), "?????");
});

// ssr-worker.js 會 import 建置產物 dist-ssr，Deno 測不了；接線用讀原始碼守住（同 render-status.test.ts 的做法）
Deno.test("ssr-worker.js 接線：現場渲染走 renderOrFallback、上游 proxy 有預算、purge 與 md 有最後一道防線", async () => {
  const src = await Deno.readTextFile(new URL("./ssr-worker.js", import.meta.url));
  assert((src.match(/renderOrFallback\(\{ render: live\(url\.search\), stale, shell \}\)/g) ?? []).length === 2, "兩個現場渲染入口（殼換版、沒命中）都要走 renderOrFallback");
  assert(src.includes("const stale = hit ? async () => hitResponse(hit, cacheControl) : null"), "有命中時才有舊的可退");
  assert(src.includes("upstream = await withBudget(() => fetch(target.toString()"), "proxy 對上游要有時間預算");
  assert(src.includes("return unavailableResponse(e)"), "proxy 失敗回 503，不丟例外");
  assert(src.includes("const ttlS = cacheTtlForPath(path, cfg)"), "TTL 依路徑選");
  assert(src.includes("try { md = await handleMarkdown(request, ctx, markdownWorkerDeps()) } catch (e) { return unavailableResponse(e) }"), "md 最後一道");
  assert(src.includes("body && Array.isArray(body.paths)"), "purge body 為 null 不丟例外");
  assert(src.includes("catch { /* 略過 */ }"), "purge 單筆失敗略過");
  assert(src.includes("await cache.put(cacheKey, res.clone()).catch(() => undefined)"), "寫快取失敗不影響回應");
});
