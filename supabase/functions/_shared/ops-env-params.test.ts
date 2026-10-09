/**
 * Worker 快取時間與 Jev 版本改環境變數、API_ONLY 端點名單加對照（盤點 #8，2026-10-07 維護者同意）。
 *
 * 只搬「營運值」，而且預設值＝改之前寫死的值（行為不變）：
 *   - Worker：頁面快取 600 秒、邊緣最長保存 3600 秒、基礎資料 10 分鐘、上游 policy-tw.web.app
 *   - Jev：OpenRouter 退路 typesafe/jev-1.13、直連 TypeSafe jev-1.13.0
 * 值寫壞（非整數、超出範圍、不是一般的模型名稱）一律退回預設——一個設定錯誤不能讓整個站或整個系統票停擺。
 *
 * API_ONLY（cloudflare/ssr-worker.js）：代理誤把協議端點打到網站網域時，Worker 回 307 轉去 Supabase；名單與
 * supabase/functions 目錄是兩份真相，新增端點忘了登記，代理會拿到 404 而不是 307（2026-09-23 事故的形狀）。
 * 這裡要求目錄裡的每一支函式都「明確分類」：要轉的（API_ONLY／API_ALSO_PAGE）、或不轉的（附理由）。
 */
import { assert, assertEquals, assertMatch, assertNotMatch } from "jsr:@std/assert@1";
import { DEFAULTS, ENV_NAMES, parseOrigin, parseSeconds, readWorkerConfig } from "../../../cloudflare/worker-config.js";
import { askJev, JEV_MODEL, jevModelsFromEnv, TYPESAFE_MODEL } from "./system-one.ts";

const REPO = new URL("../../../", import.meta.url);
const FUNCTIONS = new URL("../", import.meta.url);
const text = async (rel: string, base = REPO) => (await Deno.readTextFile(new URL(rel, base))).replace(/\r/g, "");

// ---- Worker 快取時間與上游 ----

Deno.test("Worker 設定：沒設＝改之前寫死的值（600／3600／600 秒、policy-tw.web.app）", () => {
  const c = readWorkerConfig({});
  assertEquals(c.cacheTtlS, 600);
  assertEquals(c.staleTtlS, 3600);
  assertEquals(c.baseTtlMs, 10 * 60 * 1000);
  assertEquals(c.origin, "https://policy-tw.web.app");
  assertEquals(c.originHost, "policy-tw.web.app");
  assertEquals(readWorkerConfig(undefined), c);
  assertEquals(readWorkerConfig(null), c);
});

Deno.test("Worker 設定：環境變數有設就用（字串，wrangler [vars] 都是字串）", () => {
  const c = readWorkerConfig({ SSR_CACHE_TTL_S: "60", SSR_STALE_TTL_S: "7200", SSR_BASE_TTL_S: "30", ORIGIN: "https://other.example/" });
  assertEquals(c.cacheTtlS, 60);
  assertEquals(c.staleTtlS, 7200);
  assertEquals(c.baseTtlMs, 30_000);
  assertEquals(c.origin, "https://other.example");
  assertEquals(c.originHost, "other.example");
  // 各自獨立：一個壞了，其他照常
  const partial = readWorkerConfig({ SSR_CACHE_TTL_S: "abc", SSR_STALE_TTL_S: "120" });
  assertEquals([partial.cacheTtlS, partial.staleTtlS], [600, 120]);
});

Deno.test("Worker 設定：寫壞（非整數、小數、負數、超出範圍、網址不是 https 根）一律退回預設", () => {
  for (const bad of ["", " ", "abc", "1.5", "-5", "0", "9", "86401", "1e3", "60s", "٦٠"]) {
    assertEquals(readWorkerConfig({ SSR_CACHE_TTL_S: bad }).cacheTtlS, 600, `SSR_CACHE_TTL_S=${JSON.stringify(bad)}`);
  }
  assertEquals(readWorkerConfig({ SSR_STALE_TTL_S: "59" }).staleTtlS, 3600);
  assertEquals(readWorkerConfig({ SSR_STALE_TTL_S: "604801" }).staleTtlS, 3600);
  assertEquals(readWorkerConfig({ SSR_BASE_TTL_S: "9" }).baseTtlMs, 600_000);
  for (const bad of ["http://policy-tw.web.app", "policy-tw.web.app", "https://x.test/path", "https://x.test?q=1", "javascript:alert(1)", ""]) {
    assertEquals(readWorkerConfig({ ORIGIN: bad }).origin, DEFAULTS.origin, bad);
  }
  assertEquals(parseSeconds("600", 10, 86400), 600);
  assertEquals(parseSeconds(600, 10, 86400), 600);
  assertEquals(parseSeconds(undefined, 10, 86400), null);
  assertEquals(parseOrigin(undefined), null);
});

Deno.test("wrangler.toml 的 [vars] 與預設一致（部署後行為不變），名稱與 worker-config.js 對得上", async () => {
  const toml = await text("wrangler.toml");
  const vars = toml.slice(toml.indexOf("[vars]"), toml.indexOf("[observability]"));
  const get = (name: string) => new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(vars)?.[1];
  assertEquals(get(ENV_NAMES.cacheTtlS), String(DEFAULTS.cacheTtlS));
  assertEquals(get(ENV_NAMES.staleTtlS), String(DEFAULTS.staleTtlS));
  assertEquals(get(ENV_NAMES.baseTtlS), String(DEFAULTS.baseTtlS));
  assertEquals(get(ENV_NAMES.origin), DEFAULTS.origin);
  // 把 toml 的值餵回去＝預設
  const c = readWorkerConfig(Object.fromEntries(Object.values(ENV_NAMES).map((n) => [n, get(n)])));
  assertEquals(c, readWorkerConfig({}));
});

Deno.test("ssr-worker.js 用 readWorkerConfig(env)，不再寫死快取秒數與上游網址；基礎資料 TTL 交給 SSR 載入層", async () => {
  const w = await text("cloudflare/ssr-worker.js");
  assertNotMatch(w, /const (CACHE_TTL_S|STALE_TTL_S)\b/);
  assertNotMatch(w, /const ORIGIN(_HOST)?\s*=/);
  assertNotMatch(w, /policy-tw\.web\.app'/, "上游網址只能出現在 worker-config.js 的預設");
  assertMatch(w, /cfg = readWorkerConfig\(env\)/);
  assertMatch(w, /configureSsr\(\{ baseTtlMs: cfg\.baseTtlMs \}\)/);
  for (const k of ["cfg.cacheTtlS", "cfg.staleTtlS", "cfg.origin", "cfg.originHost"]) assert(w.includes(k), k);
  const loaders = await text("lib/ssr/loaders.ts");
  assertMatch(loaders, /export function setBaseTtlMs\(ms: number\): void/);
  assertMatch(loaders, /Date\.now\(\) - baseAt > baseTtlMs/);
  assertMatch(loaders, /const DEFAULT_BASE_TTL_MS = 10 \* 60 \* 1000/, "預設仍是 10 分鐘");
  const entry = await text("entry-server.ts");
  assertMatch(entry, /export function configureSsr\(opts: \{ baseTtlMs\?: number \}\): void/);
});

// ---- Jev 版本 ----

Deno.test("Jev 版本：沒設＝釘死的預設（行為不變）；有設就換；寫壞退回預設", () => {
  assertEquals(JEV_MODEL, "typesafe/jev-1.13");
  assertEquals(TYPESAFE_MODEL, "jev-1.13.0");
  assertEquals(jevModelsFromEnv(() => undefined), { openrouter: "typesafe/jev-1.13", typesafe: "jev-1.13.0" });
  assertEquals(jevModelsFromEnv(() => ""), { openrouter: "typesafe/jev-1.13", typesafe: "jev-1.13.0" });
  const env = (n: string) => ({ JEV_MODEL: "typesafe/jev-1.14", TYPESAFE_JEV_MODEL: " jev-1.14.0 " } as Record<string, string>)[n];
  assertEquals(jevModelsFromEnv(env), { openrouter: "typesafe/jev-1.14", typesafe: "jev-1.14.0" });
  for (const bad of ["jev 1.14", "jev;rm -rf", "../x", "x".repeat(81), "中文", "-jev"]) {
    assertEquals(jevModelsFromEnv(() => bad), { openrouter: "typesafe/jev-1.13", typesafe: "jev-1.13.0" }, bad);
  }
});

Deno.test("askJev：送出去的 model 是預設或環境變數指定的（OpenRouter 退路與直連 TypeSafe 各一）", async () => {
  const seen: Array<{ url: string; model: string }> = [];
  const fake = ((url: string, init: { body: string }) => {
    seen.push({ url: String(url), model: JSON.parse(init.body).model });
    return Promise.resolve(new Response(JSON.stringify({ model: "typesafe/jev-1.13.0", answers: { q: { type: "choice", choice: "a", probabilities: { a: 1 } } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }), { status: 200 }));
  }) as unknown as typeof fetch;
  const q = { q: { type: "choice", instructions: "x", criteria: { a: "a" } } } as never;
  await askJev({ provider: "openrouter", key: "k" }, {}, q, fake);
  await askJev({ provider: "typesafe", key: "k" }, {}, q, fake);
  assertEquals(seen.map((s) => s.model), ["typesafe/jev-1.13", "jev-1.13.0"], "沒指定＝原本寫死的兩個");
  seen.length = 0;
  const models = jevModelsFromEnv((n) => ({ JEV_MODEL: "typesafe/jev-1.14", TYPESAFE_JEV_MODEL: "jev-1.14.0" } as Record<string, string>)[n]);
  await askJev({ provider: "openrouter", key: "k" }, {}, q, fake, models);
  await askJev({ provider: "typesafe", key: "k" }, {}, q, fake, models);
  assertEquals(seen.map((s) => s.model), ["typesafe/jev-1.14", "jev-1.14.0"]);
});

// ---- API_ONLY 對照 ----

function setOf(src: string, name: string): string[] {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(src);
  assert(m, `ssr-worker.js 裡找不到 ${name}`);
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
}

// 不轉的函式：每一個都要有理由（新增函式沒歸類，測試就紅，逼人想一次「代理會不會打到網站網域」）
const NOT_REDIRECTED: Record<string, string> = {
  "fetch-cec-data": "管理員／內部查中選會資料，不是代理協議",
  "ditrust-agent": "登入者向 DiTrust 開戶（前端直接打），不是代理協議",
  "cec-sync": "排程抓取（cron 打 Supabase），不對外",
  "cec-verify": "排程查證（cron 打 Supabase），不對外",
  "moi-sync": "排程抓取，不對外",
  "news-fetch": "排程抓取，不對外",
  "console-fetch": "站務主控台的 GA4／AdSense 抓取（cron 打 Supabase，要帶憑證），不對外",
  "console-admin": "站務主控台手動調整派工開關／里程碑（主控台前端直接打 Supabase，帶 Firebase ID token），不是代理協議",
  "bulletin-watch": "偵測公報站資料夾、記下實際上網日（cron 打 Supabase，要帶憑證），不對外",
  "source-archive": "排程存檔，不對外",
  "jp-next": "日本站（policy_jp）的派工端點，代理照日本站 skill.md 直接打 Supabase 的端點根網址，不經正見.tw 的 Worker",
  "jp-report": "日本站（policy_jp）的回報端點，同 jp-next",
  "jp-contributions-feed": "日本站（policy_jp）貢獻看板的公開唯讀資料，同 jp-next",
  "jp-history": "日本站（policy_jp）查核履歷的公開唯讀資料，日本站前端直接打 Supabase，同 jp-next",
};

Deno.test("API_ONLY／API_ALSO_PAGE 與 supabase/functions 目錄對照：每支函式都明確分類，名單裡沒有不存在的端點", async () => {
  const w = await text("cloudflare/ssr-worker.js");
  const apiOnly = setOf(w, "API_ONLY");
  const alsoPage = setOf(w, "API_ALSO_PAGE");
  const dirs: string[] = [];
  for await (const e of Deno.readDir(FUNCTIONS)) if (e.isDirectory && !e.name.startsWith("_") && !e.name.startsWith(".")) dirs.push(e.name);
  dirs.sort();

  // 名單裡的都真的有這支函式（函式下架或改名了，名單沒跟著改）
  for (const n of [...apiOnly, ...alsoPage]) assert(dirs.includes(n), `ssr-worker.js 列了 ${n}，但 supabase/functions/${n} 不存在`);
  // 兩個名單不重疊
  assertEquals(apiOnly.filter((n) => alsoPage.includes(n)), []);
  // 不轉的清單裡也沒有不存在的、也沒有跟轉的重複
  for (const n of Object.keys(NOT_REDIRECTED)) {
    assert(dirs.includes(n), `NOT_REDIRECTED 列了 ${n}，但函式已不存在，請從清單拿掉`);
    assert(!apiOnly.includes(n) && !alsoPage.includes(n), `${n} 已經在轉的名單裡，請從 NOT_REDIRECTED 拿掉`);
  }
  // 每支函式都要在三處之一
  const unclassified = dirs.filter((n) => !apiOnly.includes(n) && !alsoPage.includes(n) && !(n in NOT_REDIRECTED));
  assertEquals(unclassified, [], "新函式請決定：代理會打到網站網域嗎？要轉就加進 ssr-worker.js 的 API_ONLY（或 API_ALSO_PAGE），不轉就寫進這支測試的 NOT_REDIRECTED 並附理由");
  // 目前的轉址名單（改動請連同這裡一起改）
  assertEquals(apiOnly.sort(), ["apply", "apply-verified", "ask", "boost", "contribute", "contribution-status", "contributions-feed", "history", "next", "policy-stance", "question-stance", "report", "request-task", "system-one", "verifications"]);
  assertEquals(alsoPage.sort(), ["sources", "tasks", "verify"]);
});
