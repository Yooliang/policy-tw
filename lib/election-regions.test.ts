/**
 * 選舉頁三層網址（全台／縣市／鄉鎮）在四個地方要講同一件事：
 *   站內連結（lib/election-regions.ts 的 electionPath）
 *   路由表（router/index.ts）——連結要落在對的那條路由、參數要解得回中文
 *   正見.tw 的 Worker（cloudflare/region-path.js）——舊網址 301 的目標也要落在同一條路由
 *   Firebase Hosting（firebase.json 的 rewrites）——沒預渲染的鄉鎮頁回 app 殼，不能 404（舊網址轉過去不能壞）
 * 任何一處改了另一處沒跟上，畫面上看不出來，只會是某一種網址打開變全台、變 404 或變空殼。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { electionPath, electionRegionPath, electionTownshipPath } from "./election-regions.ts";
import { legacyRegionRedirect, regionUpstreamPath } from "../cloudflare/region-path.js";
import { compileRewrites, rewriteFor } from "../scripts/firebase-rewrites.mjs";

const enc = encodeURIComponent;
const ROOT = new URL("..", import.meta.url);

/** 從 router/index.ts 讀出「有名字的路由」的 path 與 name（照檔案順序） */
function readRoutes(): Array<{ name: string; path: string; re: RegExp; params: string[] }> {
  const src = Deno.readTextFileSync(new URL("router/index.ts", ROOT));
  const routes = [];
  for (const m of src.matchAll(/path:\s*'([^']+)',\s*\n\s*name:\s*'([^']+)'/g)) {
    const path = m[1];
    const params = [...path.matchAll(/:(\w+)/g)].map((p) => p[1]);
    const re = new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}/?$`);
    routes.push({ name: m[2], path, re, params });
  }
  return routes;
}

/** 網址（含 percent-encoding、可帶 query）→ 落在哪條有名字的路由、參數解碼後是什麼 */
function resolve(url: string): { name: string; params: Record<string, string> } | null {
  const pathname = url.split("?")[0];
  for (const r of readRoutes()) {
    const m = pathname.match(r.re);
    if (!m) continue;
    return { name: r.name, params: Object.fromEntries(r.params.map((p, i) => [p, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

Deno.test("路由表有三層選舉頁，鄉鎮頁是 /election/:electionId/:region/:subRegion", () => {
  const election = readRoutes().filter((r) => r.path.startsWith("/election/"));
  assertEquals(election.map((r) => [r.name, r.path]), [
    ["election", "/election/:electionId"],
    // 政見矩陣（2026-10-07）：要排在縣市頁前面，否則 matrix 會被當成縣市名
    ["election-matrix", "/election/:electionId/matrix"],
    ["election-region", "/election/:electionId/:region"],
    ["election-township", "/election/:electionId/:region/:subRegion"],
  ]);
});

Deno.test("站內連結落在對的路由，參數解得回中文", () => {
  assertEquals(resolve(electionPath(2022)), { name: "election", params: { electionId: "2022" } });
  assertEquals(resolve(electionPath(2022, "嘉義縣")), { name: "election-region", params: { electionId: "2022", region: "嘉義縣" } });
  assertEquals(resolve(electionPath(2022, "嘉義縣", "大林鎮")), {
    name: "election-township",
    params: { electionId: "2022", region: "嘉義縣", subRegion: "大林鎮" },
  });
  assertEquals(resolve(electionPath(2022, "高雄市", "那瑪夏區"))?.params.subRegion, "那瑪夏區");
});

Deno.test("鄉鎮連結：「全部」與空白就是縣市頁；縣市不合法就是全台", () => {
  assertEquals(electionPath(2022, "嘉義縣", "All"), electionRegionPath(2022, "嘉義縣"));
  assertEquals(electionPath(2022, "嘉義縣", ""), electionRegionPath(2022, "嘉義縣"));
  assertEquals(electionPath(2022, "嘉義縣", null), electionRegionPath(2022, "嘉義縣"));
  assertEquals(electionPath(2022, "某某縣", "大林鎮"), "/election/2022");
  assertEquals(electionPath(2022, "All", "大林鎮"), "/election/2022");
});

Deno.test("鄉鎮連結是 percent-encoded（跟 canonical、網站地圖同一種寫法）", () => {
  assertEquals(electionTownshipPath(2022, "嘉義縣", "大林鎮"), `/election/2022/${enc("嘉義縣")}/${enc("大林鎮")}`);
  assertEquals(electionPath(2022, "嘉義縣", "大林鎮"), electionTownshipPath(2022, "嘉義縣", "大林鎮"));
});

Deno.test("Worker 把舊的 ?sub= 301 到的網址，就是站內連結、落在鄉鎮頁路由", () => {
  const moved = legacyRegionRedirect(`/election/2022/${enc("嘉義縣")}`, new URLSearchParams(`sub=${enc("大林鎮")}&view=pledges`));
  assertEquals(moved, `${electionPath(2022, "嘉義縣", "大林鎮")}?view=pledges`);
  assertEquals(resolve(moved!)?.name, "election-township");
  const older = legacyRegionRedirect("/election/2022", new URLSearchParams(`region=${enc("高雄市")}&sub=${enc("三民區")}`));
  assertEquals(older, electionPath(2022, "高雄市", "三民區"));
});

Deno.test("Firebase：沒預渲染的鄉鎮頁回 app 殼（200＋noindex），不 404；亂打的縣市照舊 404", () => {
  const config = JSON.parse(Deno.readTextFileSync(new URL("firebase.json", ROOT)));
  const rules = compileRewrites(config.hosting.rewrites);
  // 正見.tw：Worker 把鄉鎮頁換成 ASCII 路徑去拿；沒有那個檔（例如 2026 還沒人登記的鄉鎮，舊網址轉過來）→ app 殼
  const viaWorker = regionUpstreamPath(electionPath(2026, "嘉義縣", "大林鎮"))!;
  assertEquals(rewriteFor(rules, viaWorker), "/app.html");
  // policy-tw.web.app 直接打中文網址：縣市頁、鄉鎮頁都只給 app 殼（帶 noindex），canonical 由客戶端寫正見.tw
  assertEquals(rewriteFor(rules, electionPath(2022, "嘉義縣")), "/app.html");
  assertEquals(rewriteFor(rules, electionPath(2022, "嘉義縣", "大林鎮")), "/app.html");
  assertEquals(rewriteFor(rules, `${electionPath(2022, "嘉義縣", "大林鎮")}/`), "/app.html");
  // 不是縣市的中文（例：臺北市、台北縣）經 Worker 變成 _r/<十六進位>：沒有那個檔就照舊 404，不被鄉鎮頁的規則吃掉
  assertEquals(rewriteFor(rules, regionUpstreamPath(`/election/2022/${enc("台北縣")}`)!), null);
});
