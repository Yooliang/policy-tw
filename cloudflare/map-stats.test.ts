/// <reference lib="deno.ns" />
/**
 * GET /api/map-stats（cloudflare/map-stats.js；參選地圖人數資料的邊緣快取，#680）：
 * 參數驗證、同一個鍵第二次不再打 Supabase、失敗不快取、CORS、Worker 路由順序、前端網址跟 Worker 的解析對得上。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { MAP_STATS_CACHE_CONTROL, MAP_STATS_PATH, handleMapStats, mapStatsCacheKey, parseMapStatsQuery } from "./map-stats.js";
import { mapStatsUrl } from "../lib/map-stats-url.ts";

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
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => { const url = String(input); calls.push({ url, init }); return await handler(url, init); }) as typeof fetch;
  return { fn, calls };
}
const ROWS = [{ code: "63000010", name: "松山區", parent_code: "63000", candidates: 12, registered: 14, seats: 3 }];
const deps = (cache: ReturnType<typeof fakeCache>, f: ReturnType<typeof fakeFetch>) => ({ supabaseUrl: "https://x.supabase.co", anonKey: "anon", cache, fetchFn: f.fn });
const get = (qs: string, method = "GET") => new Request(`${SITE}${MAP_STATS_PATH}?${qs}`, { method });

Deno.test("參數驗證：屆別是正整數、層級在清單內、parent 只能是 11 碼以內的數字、村里一定要帶 parent", () => {
  const p = (qs: string) => parseMapStatsQuery(new URLSearchParams(qs));
  assertEquals(p("election=2026&level=county"), { election: 2026, level: "county", parent: null });
  assertEquals(p("election=2026&level=town&parent=63000"), { election: 2026, level: "town", parent: "63000" });
  assertEquals(p("election=2026&level=town"), { election: 2026, level: "town", parent: null });
  assertEquals(p("election=2026&level=village&parent=63000010"), { election: 2026, level: "village", parent: "63000010" });
  assertEquals(p("election=2026&level=meta&parent=123"), { election: 2026, level: "meta", parent: null }, "meta 不看 parent");
  for (const bad of ["level=county", "election=abc&level=county", "election=0&level=county", "election=2026&level=planet", "election=2026&level=village",
    "election=2026&level=town&parent=63000;drop", "election=2026&level=town&parent=1234567890123", "election=2026.5&level=county"]) {
    assertEquals(p(bad), null, bad);
  }
});

Deno.test("第一次 MISS 打 Supabase RPC、回應帶 max-age=60, s-maxage=300 與 CORS；同一個鍵第二次 HIT、不再打 Supabase", async () => {
  const cache = fakeCache();
  const f = fakeFetch(() => new Response(JSON.stringify(ROWS), { status: 200 }));
  const c = ctx();
  const r1 = await handleMapStats(get("election=2026&level=village&parent=63000010"), c, deps(cache, f));
  await c.flush();
  assertEquals(r1.status, 200);
  assertEquals(r1.headers.get("Cache-Control"), "public, max-age=60, s-maxage=300");
  assertEquals(MAP_STATS_CACHE_CONTROL, "public, max-age=60, s-maxage=300");
  assertEquals(r1.headers.get("X-Cache"), "MISS");
  assertEquals(r1.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(await r1.json(), ROWS);
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0]!.url, "https://x.supabase.co/rest/v1/rpc/candidacy_map");
  assertEquals(JSON.parse(String(f.calls[0]!.init!.body)), { p_election_id: 2026, p_level: "village", p_parent: "63000010" });
  assertEquals((f.calls[0]!.init!.headers as Record<string, string>).apikey, "anon");

  const r2 = await handleMapStats(get("election=2026&level=village&parent=63000010"), c, deps(cache, f));
  assertEquals(r2.headers.get("X-Cache"), "HIT");
  assertEquals(r2.headers.get("Cache-Control"), "public, max-age=60, s-maxage=300", "命中時重設 Cache-Control");
  assertEquals(await r2.json(), ROWS);
  assertEquals(f.calls.length, 1, "第二次不再打 Supabase");

  // 參數順序、多餘參數不影響快取鍵
  const r3 = await handleMapStats(get("parent=63000010&level=village&election=2026&utm=x"), c, deps(cache, f));
  assertEquals(r3.headers.get("X-Cache"), "HIT");
  assertEquals(f.calls.length, 1);
  // 不同的鍵各打一次
  await handleMapStats(get("election=2026&level=town"), c, deps(cache, f));
  assertEquals(f.calls.length, 2);
  assertEquals(JSON.parse(String(f.calls[1]!.init!.body)), { p_election_id: 2026, p_level: "town" }, "沒有 parent 就不帶 p_parent");
});

Deno.test("meta：讀統計表全國那一列的 computed_at，一樣快取", async () => {
  const cache = fakeCache();
  const f = fakeFetch(() => new Response(JSON.stringify([{ computed_at: "2026-10-20T06:35:00Z" }]), { status: 200 }));
  const c = ctx();
  const r = await handleMapStats(get("election=2026&level=meta"), c, deps(cache, f));
  await c.flush();
  assertEquals(await r.json(), [{ computed_at: "2026-10-20T06:35:00Z" }]);
  assertEquals(f.calls[0]!.url, "https://x.supabase.co/rest/v1/candidacy_map_stats?select=computed_at&election_id=eq.2026&scope=eq.nation&order=computed_at.desc&limit=1");
  await handleMapStats(get("election=2026&level=meta"), c, deps(cache, f));
  assertEquals(f.calls.length, 1);
});

Deno.test("上游失敗（錯誤狀態、不是陣列、連不上）回 502、不快取，下一次會再打", async () => {
  for (const make of [
    () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    () => new Response(JSON.stringify({ code: "PGRST202" }), { status: 200 }),
    () => new Response("not json", { status: 200 }),
  ]) {
    const cache = fakeCache();
    const f = fakeFetch(make);
    const c = ctx();
    const r = await handleMapStats(get("election=2026&level=county"), c, deps(cache, f));
    await c.flush();
    assertEquals(r.status, 502);
    assertEquals(r.headers.get("Cache-Control"), "no-store");
    assertEquals(cache.store.size, 0);
    await handleMapStats(get("election=2026&level=county"), c, deps(cache, f));
    assertEquals(f.calls.length, 2, "失敗的不快取");
  }
  const cache = fakeCache();
  const down = fakeFetch(() => { throw new TypeError("network"); });
  const r = await handleMapStats(get("election=2026&level=county"), ctx(), deps(cache, down));
  assertEquals(r.status, 502);
  assertEquals((await handleMapStats(get("election=2026&level=county"), ctx(), { ...deps(cache, down), supabaseUrl: "" })).status, 503);
});

Deno.test("不合法的參數 400（不打上游）、非 GET 405、OPTIONS 預檢 204 帶 CORS、HEAD 沒有內容", async () => {
  const cache = fakeCache();
  const f = fakeFetch(() => new Response(JSON.stringify(ROWS)));
  assertEquals((await handleMapStats(get("election=2026&level=village"), ctx(), deps(cache, f))).status, 400);
  assertEquals((await handleMapStats(get("level=county"), ctx(), deps(cache, f))).status, 400);
  assertEquals((await handleMapStats(get("election=2026&level=county", "POST"), ctx(), deps(cache, f))).status, 405);
  const pre = await handleMapStats(get("election=2026&level=county", "OPTIONS"), ctx(), deps(cache, f));
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("Access-Control-Allow-Origin"), "*");
  assert(pre.headers.get("Access-Control-Allow-Methods")!.includes("GET"));
  assertEquals(f.calls.length, 0);
  const head = await handleMapStats(get("election=2026&level=county", "HEAD"), ctx(), deps(cache, f));
  assertEquals(head.status, 200);
  assertEquals(await head.text(), "");
});

Deno.test("快取鍵：參數正規化、同一份資料只有一個鍵", () => {
  const k = (qs: string) => mapStatsCacheKey(SITE, parseMapStatsQuery(new URLSearchParams(qs))!).url;
  assertEquals(k("election=2026&level=town&parent=63000"), k("parent=63000&level=town&election=2026&x=1"));
  assert(k("election=2026&level=town") !== k("election=2026&level=town&parent=63000"));
  assert(k("election=2026&level=county") !== k("election=2022&level=county"));
});

Deno.test("前端組的網址（lib/map-stats-url.ts）Worker 一定解析得了，而且跟快取鍵對得上", () => {
  for (const [level, parent] of [["county", null], ["town", null], ["town", "63000"], ["village", "63000010"], ["meta", null]] as const) {
    const url = new URL(mapStatsUrl(SITE, 2026, level, parent));
    assertEquals(url.origin + url.pathname, SITE + MAP_STATS_PATH);
    const q = parseMapStatsQuery(url.searchParams);
    assertEquals(q, { election: 2026, level, parent });
  }
  // 絕對網址：policy-tw.web.app 沒有 Worker，一律指到正見.tw
  assert(mapStatsUrl("https://xn--2lw665d.tw", 2026, "county").startsWith("https://xn--2lw665d.tw/api/map-stats?"));
});

Deno.test("Worker 在協議端點轉址與頁面渲染之前接 /api/map-stats，用 Supabase 公開連線與 caches.default", async () => {
  const worker = (await Deno.readTextFile(new URL("./ssr-worker.js", import.meta.url))).replace(/\r\n/g, "\n");
  assert(worker.includes("import { MAP_STATS_PATH, handleMapStats } from './map-stats.js'"));
  const i = worker.indexOf("url.pathname === MAP_STATS_PATH");
  assert(i > 0, "ssr-worker 要接 MAP_STATS_PATH");
  assert(i > worker.indexOf("url.pathname === '/__purge'"), "在 /__purge 之後");
  assert(i < worker.indexOf("handleMarkdown(request"), "在 Markdown、協議端點轉址、頁面渲染之前");
  assert(i < worker.indexOf("const api = apiRedirect(request)"));
  const block = worker.slice(i, i + 500);
  assert(block.includes("supabaseUrl: SUPABASE_PUBLIC.url") && block.includes("anonKey: SUPABASE_PUBLIC.anonKey") && block.includes("cache: caches.default"));
  assertEquals(MAP_STATS_PATH, "/api/map-stats");
});
