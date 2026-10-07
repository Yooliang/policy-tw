/**
 * 正見.tw Worker 的 Markdown 檢視（cloudflare/markdown.js）：用假的 deps 與假的 Cache 直接測請求→回應。
 *
 * 守的幾件事（docs/PLAN-markdown-views.md 5b、9、維護者 10-07）：
 *   1. 所有回應（含 301／302／304／404／503）都帶 X-Robots-Tag: noindex 與 CORS（Access-Control-Allow-Origin: *）；Content-Type：md／json 一致
 *   2. 人物：讀時產生＋Cache API 快取，第二次命中不再查資料庫，過期先回舊的背景重算；已合併的 301、查無 404
 *   3. 預產的那幾種只讀快取表；找不到回 404 的 Markdown，不即時重算；同一列可用不同網址讀（文件的 url 用請求的網址）
 *   4. 給程式批次撈：ETag（內容雜湊，排程重產但沒變時不變）、Last-Modified（內容最後變動）、X-Data-Generated-At（這一批的時間）、
 *      If-None-Match／If-Modified-Since 回 304（If-None-Match 優先）、邊緣 s-maxage 對齊每小時的排程
 *   5. 資料庫壞了回 503＋Retry-After，不退回代理（代理會回 HTML 殼冒充 .md）、不寫進快取
 *   6. 不是 Markdown 檢視的請求回 null（Worker 照舊處理）；robots.txt 不得 Disallow .md；Worker 的 purge 連 .md 一起清
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
// @ts-ignore: 純 JS 模組（Worker 用）
import { BROWSER_MAX_AGE_S, CACHE_TTL_S, PERSON_CACHE_CONTROL, ROW_CACHE_CONTROL, ROW_TTL_S, SCHEDULE_S, fnv, handleMarkdown, notModified } from "./markdown.js";
import { latestPath, matchMarkdownRoute } from "../lib/md/route.ts";
import { renderPage } from "../lib/md/format.ts";
import { buildNotFoundPage } from "../lib/md/index-page.ts";

const ID = "0000b296-7ae8-4184-b704-c69d44cb696a";
const enc = encodeURIComponent;
const ORIGIN = "https://xn--2lw665d.tw";
const SHA = "abcdef0123456789abcdef0123456789";

class FakeCache {
  store = new Map<string, Response>();
  async match(req: Request) { const r = this.store.get(req.url); return r ? r.clone() : undefined; }
  async put(req: Request, res: Response) { this.store.set(req.url, res); }
}

interface Calls { person: number; row: string[]; latest: number; waits: Promise<unknown>[] }

const ROW = { body: "## 本文\n", generated_at: "2026-10-07T02:00:00+00:00", changed_at: "2026-10-06T10:00:00+00:00", content_sha: SHA, row_count: 3, meta: { title: "台南市交通建設政見", htmlPath: null, dataAsOf: null, scope: "範圍", preface: [], rowCount: 3 } };
const JSON_ROW = { body: '{"files":[]}', generated_at: "2026-10-07T02:00:00+00:00", changed_at: "2026-10-07T02:00:00+00:00", content_sha: "jsonsha0123456789", row_count: 0, meta: { format: "json" } };

function setup(over: Record<string, unknown> = {}, nowRef = { t: Date.parse("2026-10-07T03:00:00Z") }) {
  const calls: Calls = { person: 0, row: [], latest: 0, waits: [] };
  const cache = new FakeCache();
  const deps = {
    match: matchMarkdownRoute,
    latestPath,
    loadPerson: async (id: string) => { calls.person++; return id === ID ? { kind: "ok", input: { name: "測試人" } } : { kind: "notfound" }; },
    renderPerson: (input: { name: string }) => `---\ngenerated_at: 2026-10-07T11:00:00+08:00\n---\n# 人物 ${input.name}\n`,
    fetchCacheRow: async (key: string) => {
      calls.row.push(key);
      if (key === "/data/2026/台南市/交通建設.md" || key === "/election/2026/台南市.md" || key === "/data/2026/交通建設.md") return ROW;
      if (key === "/data/2026/index.json") return JSON_ROW;
      return null;
    },
    latestSegment: async () => { calls.latest++; return "2026"; },
    renderPage,
    notFoundPage: buildNotFoundPage,
    cache,
    now: () => nowRef.t,
    ...over,
  };
  const ctx = { waitUntil: (p: Promise<unknown>) => { calls.waits.push(p); } };
  const get = (path: string, init: RequestInit = {}) => handleMarkdown(new Request(`${ORIGIN}${path}`, init), ctx, deps as never);
  return { calls, cache, get, nowRef };
}

function assertCommon(res: Response | null, status: number) {
  assert(res, "要有回應");
  assertEquals(res.status, status);
  assertEquals(res.headers.get("X-Robots-Tag"), "noindex");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*", "純公開資料，CORS 全開");
}
function assertMd(res: Response | null, status: number) {
  assertCommon(res, status);
  if (status !== 301 && status !== 302 && status !== 304) assertEquals(res!.headers.get("Content-Type"), "text/markdown; charset=utf-8");
}

const CELL = `/data/2026/${enc("台南市")}/${enc("交通建設")}.md`;

Deno.test("人物：200、標頭固定、第二次命中快取不再查資料庫", async () => {
  const { calls, get } = setup();
  const a = await get(`/politician/${ID}.md`);
  assertMd(a, 200);
  assertEquals(a!.headers.get("Cache-Control"), "public, max-age=600, s-maxage=600, stale-while-revalidate=3600");
  assertEquals(a!.headers.get("Cache-Control"), PERSON_CACHE_CONTROL);
  assertEquals(a!.headers.get("X-Cache"), "MISS");
  assert(a!.headers.get("ETag")!.startsWith('W/"p-'));
  assertEquals(a!.headers.get("X-Data-Generated-At"), "2026-10-07T03:00:00.000Z");
  assertEquals(a!.headers.get("Last-Modified"), null);
  assertStringIncludes(await a!.text(), "# 人物 測試人");
  const b = await get(`/politician/${ID}.md`);
  assertEquals(b!.headers.get("X-Cache"), "HIT");
  assertEquals(calls.person, 1);
});

Deno.test("人物：ETag 是內容雜湊，產生時間不同、內容相同時不變；If-None-Match 回 304", async () => {
  const { get, nowRef } = setup();
  const a = await get(`/politician/${ID}.md`);
  const etag = a!.headers.get("ETag")!;
  nowRef.t += (CACHE_TTL_S + 1) * 1000;
  const same = await get(`/politician/${ID}.md`, { headers: { "If-None-Match": etag } });
  assertCommon(same, 304);
  assertEquals(same!.headers.get("ETag"), etag);
  assertEquals(await same!.text(), "");
});

Deno.test("人物：過期後先回舊的、背景重算", async () => {
  const { calls, get, nowRef } = setup();
  await get(`/politician/${ID}.md`);
  nowRef.t += (CACHE_TTL_S + 1) * 1000;
  const stale = await get(`/politician/${ID}.md`);
  assertEquals(stale!.headers.get("X-Cache"), "HIT");
  await Promise.all(calls.waits);
  assertEquals(calls.person, 2, "背景重算了一次");
});

Deno.test("人物：已合併 301、查無 404（Markdown，附清單）、編號格式不對 404；404 不寫進快取", async () => {
  const merged = setup({ loadPerson: async () => ({ kind: "merged", into: "11111111-1111-4111-8111-111111111111" }) });
  const m = await merged.get(`/politician/${ID}.md`);
  assertMd(m, 301);
  assertEquals(m!.headers.get("Location"), `${ORIGIN}/politician/11111111-1111-4111-8111-111111111111.md`);
  const { get, cache } = setup();
  const nf = await get("/politician/22222222-2222-4222-8222-222222222222.md");
  assertMd(nf, 404);
  assertStringIncludes(await nf!.text(), "找不到這位人物");
  assertMd(await get("/politician/not-an-id.md"), 404);
  assertEquals(cache.store.size, 0);
});

Deno.test("預產的頁：只讀快取表；generated_at 用快取列的；ETag／Last-Modified／X-Data-Generated-At；s-maxage 對齊每小時排程", async () => {
  const { calls, get } = setup();
  const res = await get(CELL);
  assertMd(res, 200);
  const md = await res!.text();
  assertEquals(calls.row, ["/data/2026/台南市/交通建設.md"]);
  assertStringIncludes(md, "generated_at: 2026-10-07T10:00:00+08:00");
  assertStringIncludes(md, `url: ${ORIGIN}${CELL}`);
  assertStringIncludes(md, "## 本文");
  assertStringIncludes(md, "原始出處的權利歸原發布者");
  assertEquals(res!.headers.get("ETag"), `W/"${SHA.slice(0, 16)}-${fnv("/data/2026/台南市/交通建設.md")}"`);
  assertEquals(res!.headers.get("Last-Modified"), "Tue, 06 Oct 2026 10:00:00 GMT");
  assertEquals(res!.headers.get("X-Data-Generated-At"), "2026-10-07T02:00:00.000Z");
  assertEquals(res!.headers.get("Cache-Control"), `public, max-age=${BROWSER_MAX_AGE_S}, s-maxage=${SCHEDULE_S}, stale-while-revalidate=${ROW_TTL_S}`);
  assertEquals(res!.headers.get("Cache-Control"), ROW_CACHE_CONTROL);
  assertEquals(BROWSER_MAX_AGE_S, 600, "瀏覽器最多舊 10 分鐘，不能比每小時預產還長（維護者 10-07）");
  assertEquals(SCHEDULE_S, 3600);
  assert(res!.headers.get("Access-Control-Expose-Headers")!.includes("ETag"));
  assertEquals(calls.person, 0);
});

// Cloudflare 的「瀏覽器快取 TTL」區域設定會在 caches.default 命中時把 max-age 抬到 14400（線上實測：MISS 是 max-age=0、HIT 變 14400）。
// 假的 Cache 在 match 時照做同樣的事，驗證我們命中時有把 Cache-Control 蓋回來——拿掉那一行這個測試會紅。
class RewritingCache extends FakeCache {
  override async match(req: Request) {
    const r = await super.match(req);
    if (!r) return r;
    const h = new Headers(r.headers);
    h.set("Cache-Control", h.get("Cache-Control")!.replace(/max-age=\d+/, "max-age=14400"));
    return new Response(r.body, { status: r.status, headers: h });
  }
}

Deno.test("Cache API 命中時 Cloudflare 把 max-age 抬到 4 小時：回應前蓋回 600（人物、預產的頁、索引 JSON、304 都是）", async () => {
  const cache = new RewritingCache();
  const { get } = setup({ cache });
  for (const path of [`/politician/${ID}.md`, CELL, "/data/2026/index.json"]) {
    const miss = await get(path);
    assert(/(^|, )max-age=600(,|$)/.test(miss!.headers.get("Cache-Control")!), `MISS ${path}`);
    const hit = await get(path);
    assertEquals(hit!.headers.get("X-Cache"), "HIT");
    assert(/(^|, )max-age=600(,|$)/.test(hit!.headers.get("Cache-Control")!), `HIT ${path} 的 max-age 要是 600，不是 Cloudflare 抬高的 14400：${hit!.headers.get("Cache-Control")}`);
    const etag = hit!.headers.get("ETag")!;
    const nm = await get(path, { headers: { "If-None-Match": etag } });
    assertEquals(nm!.status, 304);
    assert(/(^|, )max-age=600(,|$)/.test(nm!.headers.get("Cache-Control")!), `304 ${path}`);
  }
});

Deno.test("條件請求：If-None-Match（弱比對、可多個、*）與 If-Modified-Since；If-None-Match 優先", async () => {
  const { get } = setup();
  const first = await get(CELL);
  const etag = first!.headers.get("ETag")!;
  const lm = first!.headers.get("Last-Modified")!;
  const hit = await get(CELL, { headers: { "If-None-Match": etag } });
  assertCommon(hit, 304);
  assertEquals(hit!.headers.get("ETag"), etag);
  assertEquals(hit!.headers.get("Last-Modified"), lm);
  assertEquals(hit!.headers.get("X-Data-Generated-At"), "2026-10-07T02:00:00.000Z");
  assertEquals(await hit!.text(), "");
  assertEquals((await get(CELL, { headers: { "If-None-Match": etag.replace(/^W\//, "") } }))!.status, 304, "弱比對：有沒有 W/ 都算");
  assertEquals((await get(CELL, { headers: { "If-None-Match": `"other", ${etag}` } }))!.status, 304);
  assertEquals((await get(CELL, { headers: { "If-None-Match": "*" } }))!.status, 304);
  assertEquals((await get(CELL, { headers: { "If-None-Match": 'W/"nope"' } }))!.status, 200);
  assertEquals((await get(CELL, { headers: { "If-Modified-Since": lm } }))!.status, 304);
  assertEquals((await get(CELL, { headers: { "If-Modified-Since": "Wed, 07 Oct 2026 00:00:00 GMT" } }))!.status, 304);
  assertEquals((await get(CELL, { headers: { "If-Modified-Since": "Mon, 05 Oct 2026 00:00:00 GMT" } }))!.status, 200, "內容在這之後變過就給新的");
  assertEquals((await get(CELL, { headers: { "If-None-Match": 'W/"nope"', "If-Modified-Since": lm } }))!.status, 200, "有 If-None-Match 就不看 If-Modified-Since");
  // 純函式
  const h = new Headers({ ETag: 'W/"a"', "Last-Modified": "Tue, 06 Oct 2026 10:00:00 GMT" });
  assertEquals(notModified(new Request(ORIGIN, { headers: { "If-None-Match": '"a"' } }), h)!.status, 304);
  assertEquals(notModified(new Request(ORIGIN), h), null);
});

Deno.test("排程重產但內容沒變：ETag 不變（只有 generated_at 換新）；內容變了 ETag 就變", async () => {
  const bumped = { ...ROW, generated_at: "2026-10-07T03:00:00+00:00" };
  const a = setup();
  const e1 = (await a.get(CELL))!.headers.get("ETag");
  const b = setup({ fetchCacheRow: async () => bumped });
  const e2 = (await b.get(CELL))!.headers.get("ETag");
  assertEquals(e1, e2);
  const c = setup({ fetchCacheRow: async () => ({ ...ROW, content_sha: "ffffffffffffffffffffffffffffffff" }) });
  assert((await c.get(CELL))!.headers.get("ETag") !== e1);
});

Deno.test("同一列可以用不同網址讀：縣市（全部分類）讀縣市頁那一列、/category 讀最新一屆的分類列；ETag 帶網址", async () => {
  const { calls, get } = setup();
  const a = await get(`/data/2026/${enc("台南市")}.md`);
  assertMd(a, 200);
  assertStringIncludes(await a!.text(), `url: ${ORIGIN}/data/2026/${enc("台南市")}.md`);
  const b = await get(`/election/2026/${enc("台南市")}.md`);
  assert(a!.headers.get("ETag") !== b!.headers.get("ETag"), "網址不同，內文的 url 不同，ETag 不同");
  const c = await get(`/category/${enc("交通建設")}.md`);
  assertMd(c, 200);
  assertStringIncludes(await c!.text(), `url: ${ORIGIN}/category/${enc("交通建設")}.md`);
  assertEquals(calls.row, ["/election/2026/台南市.md", "/election/2026/台南市.md", "/data/2026/交通建設.md"]);
});

Deno.test("索引 JSON：原樣回、Content-Type 是 application/json", async () => {
  const { get } = setup();
  const res = await get("/data/2026/index.json");
  assertCommon(res, 200);
  assertEquals(res!.headers.get("Content-Type"), "application/json; charset=utf-8");
  assertEquals(await res!.text(), '{"files":[]}');
  assert(res!.headers.get("ETag"));
});

Deno.test("預產的頁：快取表沒有這一列→404 的 Markdown，不即時重算、不寫快取", async () => {
  const { get, cache } = setup();
  const res = await get(`/data/2026/${enc("台南市")}/${enc("教育文化")}.md`);
  assertMd(res, 404);
  assertStringIncludes(await res!.text(), "預產還沒跑到");
  assertEquals(cache.store.size, 0);
});

Deno.test("最新一屆的短網址與矩陣頁的轉址", async () => {
  const { get, calls } = setup();
  const region = await get(`/data/${enc("台南市")}.md`);
  assertMd(region, 301);
  assertEquals(region!.headers.get("Location"), `${ORIGIN}/election/2026/${enc("台南市")}.md`);
  const cell = await get(`/data/${enc("台南市")}/${enc("育兒")}.md`);
  assertMd(cell, 301);
  assertEquals(cell!.headers.get("Location"), `${ORIGIN}/data/2026/${enc("台南市")}/${enc("社會福利")}.md`);
  const q = await get(`/data?q=${enc("台南 育兒")}`);
  assertMd(q, 302);
  assertEquals(q!.headers.get("Location"), `${ORIGIN}/data/2026/${enc("台南市")}/${enc("社會福利")}.md`);
  assertEquals((await get("/data/index.json"))!.headers.get("Location"), `${ORIGIN}/data/2026/index.json`);
  const matrix = await get("/data");
  assertMd(matrix, 302);
  assertEquals(matrix!.headers.get("Location"), `${ORIGIN}/election/2026/matrix`);
  assertEquals(calls.latest, 5);
  assertMd(await setup({ latestSegment: async () => null }).get("/data"), 404);
});

Deno.test("名稱換成正式寫法與認不出來：301／404（Markdown，列出縣市與分類）", async () => {
  const { get } = setup();
  const t = await get(`/election/2026/${enc("臺南市")}.md`);
  assertMd(t, 301);
  assertEquals(t!.headers.get("Location"), `${ORIGIN}/election/2026/${enc("台南市")}.md`);
  const unknown = await get(`/data?q=${enc("火星人")}`);
  assertMd(unknown, 404);
  const body = await unknown!.text();
  assertStringIncludes(body, "沒認出來");
  assertStringIncludes(body, "- 台南市：");
  assertStringIncludes(body, "- 交通建設：");
});

Deno.test("CORS 預檢：OPTIONS 只對 Markdown 檢視的網址回 204", async () => {
  const { get } = setup();
  const res = await get(CELL, { method: "OPTIONS" });
  assertEquals(res!.status, 204);
  assertEquals(res!.headers.get("Access-Control-Allow-Origin"), "*");
  assertStringIncludes(res!.headers.get("Access-Control-Allow-Methods")!, "GET");
  assertStringIncludes(res!.headers.get("Access-Control-Allow-Headers")!, "If-None-Match");
  assertEquals(await get("/tracking", { method: "OPTIONS" }), null);
});

Deno.test("HEAD 不回本文；非 GET／HEAD 與不是 Markdown 檢視的網址回 null", async () => {
  const { get } = setup();
  const head = await get(`/politician/${ID}.md`, { method: "HEAD" });
  assertMd(head, 200);
  assertEquals(await head!.text(), "");
  const headRow = await get(CELL, { method: "HEAD" });
  assertEquals(headRow!.status, 200);
  assert(headRow!.headers.get("ETag"));
  assertEquals(await get(`/politician/${ID}.md`, { method: "POST" }), null);
  assertEquals(await get(`/politician/${ID}`), null);
  assertEquals(await get("/skill.md"), null);
  assertEquals(await get("/llms.txt"), null);
  assertEquals(await get("/election/2026/matrix"), null);
  assertEquals(await get("/tracking"), null);
});

Deno.test("資料庫壞了：503＋Retry-After、不寫進快取、不退回代理", async () => {
  const { get, cache } = setup({ loadPerson: async () => { throw new Error("boom"); }, fetchCacheRow: async () => { throw new Error("db down"); } });
  const a = await get(`/politician/${ID}.md`);
  assertMd(a, 503);
  assertEquals(a!.headers.get("Retry-After"), "30");
  assertEquals(a!.headers.get("Cache-Control"), "no-store");
  assertMd(await get(CELL), 503);
  assertEquals(cache.store.size, 0);
});

Deno.test("Worker 接線：Markdown 先於代理、purge 連 .md 一起清、robots.txt 不擋 .md、讀的是 data_md_cache", async () => {
  const worker = await Deno.readTextFile(new URL("./ssr-worker.js", import.meta.url));
  assert(worker.includes("handleMarkdown(request, ctx, markdownWorkerDeps())"));
  assert(worker.indexOf("handleMarkdown(request") < worker.indexOf("const api = apiRedirect(request)") && worker.indexOf("handleMarkdown(request") < worker.indexOf("return proxy(request)"), "Markdown 要在 API 轉址與代理之前收掉");
  assert(worker.includes("`${clean}.md`"), "purge 要連 .md 一起清");
  assert(worker.includes("data_md_cache?path=eq."), "預產的頁只讀 data_md_cache");
  const robots = await Deno.readTextFile(new URL("../public/robots.txt", import.meta.url));
  assert(!/Disallow:.*\.md/i.test(robots) && !/Disallow:\s*\/data/i.test(robots), "robots.txt 不得 Disallow .md（爬蟲讀不到 noindex 反而可能收進索引）");
  const entry = await Deno.readTextFile(new URL("../entry-server.ts", import.meta.url));
  assert(entry.includes("export const markdownDeps"));
});
