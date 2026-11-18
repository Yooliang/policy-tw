/// <reference lib="deno.ns" />
/**
 * 預渲染頁的邊緣快取（cloudflare/prerender-cache.js，#982）：
 * 首頁第二次請求命中、/skill.md 與 /assets 不快取、非 200／非 HTML／帶登入 Cookie 不快取、追蹤參數不影響快取鍵、過期先回舊的背景重抓。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PRERENDER_CACHE_CONTROL, cachedProxy, isCacheableRequest, prerenderCacheKey } from "./prerender-cache.js";

const SITE = "https://xn--2lw665d.tw";
const ctx = () => { const pending: Promise<unknown>[] = []; return { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, flush: () => Promise.all(pending) }; };
function fakeCache() {
  const store = new Map<string, Response>();
  return {
    store,
    match: (r: Request) => Promise.resolve(store.get(r.url)?.clone()),
    put: (r: Request, res: Response) => { store.set(r.url, res.clone()); return Promise.resolve(); },
  };
}
function setup(upstream: () => Response) {
  const cache = fakeCache();
  let calls = 0;
  const proxy = () => { calls++; return Promise.resolve(upstream()); };
  return { cache, calls: () => calls, deps: (now?: () => number) => ({ cache, proxy, now }) };
}
const html = () => new Response("<!doctype html><title>x</title>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", Vary: "x-fh-requested-host, accept-encoding" } });
const req = (path: string, init: RequestInit = {}) => new Request(`${SITE}${path}`, init);

Deno.test("首頁第二次請求命中快取：MISS → HIT，只打一次上游，Cache-Control 覆寫", async () => {
  const s = setup(html);
  const c = ctx();
  const r1 = await cachedProxy(req("/"), c, s.deps());
  await c.flush();
  assertEquals(r1.headers.get("X-Prerender-Cache"), "MISS");
  assertEquals(r1.headers.get("Cache-Control"), PRERENDER_CACHE_CONTROL);
  assertEquals(await r1.text(), "<!doctype html><title>x</title>");
  const r2 = await cachedProxy(req("/"), c, s.deps());
  assertEquals(r2.headers.get("X-Prerender-Cache"), "HIT");
  assertEquals(r2.headers.get("Cache-Control"), "public, max-age=0, s-maxage=300, stale-while-revalidate=600");
  assertEquals(await r2.text(), "<!doctype html><title>x</title>");
  assertEquals(s.calls(), 1);
});

Deno.test("/skill.md、/assets/**、/api/ 不快取：每次都打上游、不寫快取", async () => {
  for (const p of ["/skill.md", "/skill-types.md", "/assets/index-abc.js", "/api/map-stats?x=1", "/llms.txt"]) {
    const s = setup(() => new Response("body", { status: 200, headers: { "Content-Type": "text/html" } }));
    const c = ctx();
    await cachedProxy(req(p), c, s.deps());
    await cachedProxy(req(p), c, s.deps());
    await c.flush();
    assertEquals(s.calls(), 2, p);
    assertEquals(s.cache.store.size, 0, p);
  }
});

Deno.test("非 200、非 HTML、帶 Set-Cookie 的上游回應不快取，並標 BYPASS", async () => {
  const cases: Array<() => Response> = [
    () => new Response("nope", { status: 404, headers: { "Content-Type": "text/html" } }),
    () => new Response(null, { status: 301, headers: { Location: "/x", "Content-Type": "text/html" } }),
    () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    () => new Response("<p>", { status: 200, headers: { "Content-Type": "text/html", "Set-Cookie": "sid=1" } }),
  ];
  for (const mk of cases) {
    const s = setup(mk);
    const c = ctx();
    const r = await cachedProxy(req("/tracking"), c, s.deps());
    await c.flush();
    assertEquals(r.headers.get("X-Prerender-Cache"), "BYPASS");
    assertEquals(s.cache.store.size, 0);
  }
});

Deno.test("請求條件：只收 GET；Authorization、Range、工作階段 Cookie 不快取；分析 Cookie 可以", () => {
  assert(isCacheableRequest(req("/")));
  assert(!isCacheableRequest(req("/", { method: "HEAD" })));
  assert(!isCacheableRequest(req("/", { method: "POST" })));
  assert(!isCacheableRequest(req("/", { headers: { Authorization: "Bearer x" } })));
  assert(!isCacheableRequest(req("/", { headers: { Range: "bytes=0-10" } })));
  assert(!isCacheableRequest(req("/", { headers: { Cookie: "sb-access-token=abc" } })));
  assert(!isCacheableRequest(req("/", { headers: { Cookie: "_ga=GA1.1.1; session=zzz" } })));
  assert(isCacheableRequest(req("/", { headers: { Cookie: "_ga=GA1.1.1; _ga_ABC123=GS1; _fbp=fb.1" } })));
});

Deno.test("快取鍵：追蹤參數不進鍵、其餘參數排序保留", () => {
  assertEquals(prerenderCacheKey(`${SITE}/election/2026?utm_source=x&fbclid=1&gclid=2`).url, `${SITE}/election/2026`);
  assertEquals(prerenderCacheKey(`${SITE}/election/2026?b=2&a=1&utm_medium=m`).url, `${SITE}/election/2026?a=1&b=2`);
  assertEquals(prerenderCacheKey(`${SITE}/?utm_campaign=z`).url, `${SITE}/`);
});

Deno.test("帶追蹤參數的第二個請求命中同一份", async () => {
  const s = setup(html);
  const c = ctx();
  await cachedProxy(req("/tracking?utm_source=fb"), c, s.deps());
  await c.flush();
  const r = await cachedProxy(req("/tracking?fbclid=abc"), c, s.deps());
  assertEquals(r.headers.get("X-Prerender-Cache"), "HIT");
  assertEquals(s.calls(), 1);
});

Deno.test("過了新鮮期：先回舊的（STALE）並背景重抓，下一個請求拿到新的", async () => {
  let version = 1;
  const s = setup(() => new Response(`v${version}`, { status: 200, headers: { "Content-Type": "text/html" } }));
  const c = ctx();
  await cachedProxy(req("/analysis"), c, s.deps());
  await c.flush();
  version = 2;
  const later = () => Date.now() + 301_000;
  const r = await cachedProxy(req("/analysis"), c, s.deps(later));
  assertEquals(r.headers.get("X-Prerender-Cache"), "STALE");
  assertEquals(await r.text(), "v1");
  await c.flush();
  assertEquals(s.calls(), 2);
  const r3 = await cachedProxy(req("/analysis"), c, s.deps());
  assertEquals(r3.headers.get("X-Prerender-Cache"), "HIT");
  assertEquals(await r3.text(), "v2");
});

Deno.test("存進快取的副本不帶 Vary（合成快取鍵沒有請求標頭，帶了永遠比對不到）", async () => {
  const s = setup(html);
  const c = ctx();
  await cachedProxy(req("/"), c, s.deps());
  await c.flush();
  const stored = [...s.cache.store.values()][0];
  assertEquals(stored.headers.get("Vary"), null);
  assert(Number(stored.headers.get("X-Prerender-Cached-At")) > 0);
});

Deno.test("殼換版（部署後）：快取裡舊版的頁當沒命中、當場重抓；殼拿不到時沿用快取", async () => {
  let version = 1;
  const s = setup(() => new Response(`v${version}`, { status: 200, headers: { "Content-Type": "text/html" } }));
  const c = ctx();
  let shell: string | null = '<script src="/assets/index-aaa.js"></script>';
  const deps = () => ({ ...s.deps(), currentShell: () => Promise.resolve(shell) });
  await cachedProxy(req("/tracking"), c, deps());
  await c.flush();
  assertEquals((await cachedProxy(req("/tracking"), c, deps())).headers.get("X-Prerender-Cache"), "HIT");
  version = 2;
  shell = null;
  assertEquals(await (await cachedProxy(req("/tracking"), c, deps())).text(), "v1", "拿不到殼：沿用快取");
  shell = '<script src="/assets/index-bbb.js"></script>';
  const r = await cachedProxy(req("/tracking"), c, deps());
  await c.flush();
  assertEquals(r.headers.get("X-Prerender-Cache"), "MISS");
  assertEquals(await r.text(), "v2");
  assertEquals(s.calls(), 2);
});
