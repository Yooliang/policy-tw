/**
 * 這個網址是不是「搜尋結果頁」（2026-10-06，小良哥點頭）。
 *
 * 起因：a-zhen 交「查無異動」說台南安南區四草里 2022 里長吳文振查無政見，checked_urls 六個全是
 * google.com/search?q=…；實際上中選會選舉公報那一份 PDF 就列了他四條政見。搜尋結果頁只證明「搜過」，
 * 不證明「看過」：結果每次不同、驗證者打開看到的不是提交者看到的，而且頁面本身從來不寫到任何事實。
 * 所以搜尋結果頁**不是出處、也不算查過的網址**——該附的是從搜尋結果點進去、實際打開的那一頁。
 *
 * 判斷分三類（都是純字串判斷，不連網）：
 *   1. 搜尋引擎：Google（各國網域）/search、/webhp、/cse、首頁帶 q=；Bing /search；DuckDuckGo（整個網域）；
 *      Yahoo 搜尋（search.yahoo.*）；百度 /s；Naver search.naver.com；Yandex、搜狗、360 搜尋、Ecosia、Brave、
 *      Startpage、Ask；Google 新聞與學術的搜尋；YouTube /results；Perplexity /search。
 *   2. 查詢字串裡有 site:／inurl:／intitle: 這類搜尋語法：不管哪個網域，都是在叫搜尋引擎找。
 *   3. 站內搜尋：主機名有一段是 search（search.ltn.com.tw、tw.search.yahoo.com）、路徑有一段是 search
 *      （/search、Search.aspx、SearchResult.aspx、news_search、Facebook /search/top、X /search）、維基百科的
 *      Special:Search 與 index.php?search=；政府網站（*.gov.tw、gov.taipei）另外連「列表頁帶 keyword=」也算——
 *      政府網站的站內搜尋常常就是新聞列表加一個關鍵字參數。
 *
 * **不擋**（測試逐一釘住）：Google 地圖（/maps/search/… 也是地圖頁，不是搜尋結果）、Google 文件／雲端硬碟／
 * 圖書、google.com/url 轉址、YouTube 影片、Yahoo 新聞（tw.news.yahoo.com）、中選會選舉公報（?dir= 是目錄、
 * 不是關鍵字）、選舉資料庫、一般新聞與政府公告頁、路徑裡只是「含有」search 字樣的文章網址（research、searchlight）。
 *
 * web.archive.org 的存檔照原網址判斷：Google 搜尋結果頁的存檔一樣是搜尋結果頁。
 */

import { unwrapArchiveUrl } from "./sole-source-guard.ts";

export type SearchPageKind = "search_engine" | "search_operator" | "site_search";

export interface SearchPageVerdict {
  kind: SearchPageKind;
  /** 給人看的中文說明，例如「Google 搜尋結果頁」 */
  label: string;
}

/** 搜尋語法：查詢字串或 # 片段裡出現這些就是在叫搜尋引擎找 */
const OPERATOR_RE = /(^|[\s+&=?#(])-?(site|inurl|intitle|allinurl|allintitle):\S/i;

/** 主機名裡「這一段」是搜尋服務（search.ltn.com.tw、tw.search.yahoo.com、gsearch.xxx.gov.tw） */
const SEARCH_HOST_LABEL_RE = /^(g|web|site|s|full|global)?search$/;

/** 路徑裡「這一段」（去掉 .aspx 這類副檔名）是搜尋頁 */
const SEARCH_SEGMENT_RE = /^((g|web|site|full|global|adv|advanced|news|all|db|doc|query|quick|simple)[_-]?)?search(es)?([_-]?(result|results|list|page|word|query))?$|[_-]search$/;

/** 政府網站的關鍵字參數（有值才算） */
const GOV_KEYWORD_PARAMS = new Set(["q", "query", "keyword", "keywords", "kw", "searchword", "searchtext", "search", "searchkey", "key_word", "qs", "word"]);

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function hasParam(u: URL, ...keys: string[]): boolean {
  for (const [k, v] of u.searchParams) {
    if (keys.includes(k.toLowerCase()) && v.trim() !== "") return true;
  }
  // Google 有時把查詢放在 # 後面（/#q=…）
  return keys.some((k) => new RegExp(`(^#|[#&])${k}=[^&]`, "i").test(u.hash));
}

const isRootPath = (path: string) => path === "" || path === "/";

/** 搜尋引擎本身。回 null＝不是搜尋引擎的結果頁 */
function searchEngine(host: string, path: string, u: URL): string | null {
  const labels = host.split(".");
  // Google：google.com、google.com.tw、google.co.jp、news.google.com、scholar.google.com……
  if (/(^|\.)google\.(com|[a-z]{2,3})(\.[a-z]{2})?$/.test(host)) {
    const sub = labels[0]; // news／scholar／www／google
    if (/^\/maps(\/|$)/i.test(path)) return null; // Google 地圖（含 /maps/search/…）不是搜尋結果頁
    if (/^\/(search|webhp|cse|custom|scholar)(\/|$)/i.test(path)) {
      return sub === "news" ? "Google 新聞搜尋結果頁" : sub === "scholar" ? "Google 學術搜尋結果頁" : "Google 搜尋結果頁";
    }
    if (isRootPath(path) && hasParam(u, "q")) return "Google 搜尋結果頁";
    return null;
  }
  if (/(^|\.)bing\.com$/.test(host)) {
    if (/^\/((news|images|videos|shop)\/)?search(\/|$)/i.test(path) || (isRootPath(path) && hasParam(u, "q"))) return "Bing 搜尋結果頁";
    return null;
  }
  if (/(^|\.)duckduckgo\.com$/.test(host)) return "DuckDuckGo 搜尋結果頁";
  if (/(^|\.)baidu\.com$/.test(host)) {
    if (/^\/(s|baidu)(\/|$)/i.test(path) || hasParam(u, "wd", "word")) return "百度搜尋結果頁";
    return null;
  }
  if (/(^|\.)yandex\.[a-z.]+$/.test(host) && /^\/search(\/|$)/i.test(path)) return "Yandex 搜尋結果頁";
  if (/(^|\.)sogou\.com$/.test(host) && /^\/(web|sogou)(\/|$)/i.test(path)) return "搜狗搜尋結果頁";
  if (/(^|\.)so\.com$/.test(host) && /^\/s(\/|$)/i.test(path)) return "360 搜尋結果頁";
  if (/(^|\.)ask\.com$/.test(host) && /^\/web(\/|$)/i.test(path)) return "Ask 搜尋結果頁";
  if (/(^|\.)startpage\.com$/.test(host) && /\/search(\/|$)/i.test(path)) return "Startpage 搜尋結果頁";
  if (/(^|\.)youtube\.com$/.test(host) && /^\/results(\/|$)/i.test(path)) return "YouTube 搜尋結果頁";
  return null;
}

/** 政府網站（站內搜尋另外連「列表頁帶關鍵字參數」也算） */
function isGovHost(host: string): boolean {
  return /(^|\.)gov\.tw$/.test(host) || /(^|\.)gov\.taipei$/.test(host);
}

/** 純函式：這個網址是不是搜尋結果頁；是就回類別與說明，不是（或解析不出來）回 null */
export function searchPageVerdict(rawUrl: unknown): SearchPageVerdict | null {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;
  let u: URL;
  try {
    u = new URL(unwrapArchiveUrl(rawUrl.trim()));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const path = u.pathname;

  // Google 地圖（含 /maps/search/…）是地點頁，不是搜尋結果頁；下面的通用規則也不套
  if (/(^|\.)google\.(com|[a-z]{2,3})(\.[a-z]{2})?$/.test(host) && (/^\/maps(\/|$)/i.test(path) || host.startsWith("maps."))) return null;

  const engine = searchEngine(host, path, u);
  if (engine) return { kind: "search_engine", label: engine };

  // 搜尋語法：不管哪個網域
  if (OPERATOR_RE.test(decodeSafe(u.search)) || OPERATOR_RE.test(decodeSafe(u.hash))) {
    return { kind: "search_operator", label: "帶 site: 等搜尋語法的查詢頁" };
  }

  // 主機名有一段是 search（最後兩段是網域本身，不看）
  const labels = host.split(".");
  if (labels.slice(0, Math.max(0, labels.length - 2)).some((l) => SEARCH_HOST_LABEL_RE.test(l))) {
    return { kind: "site_search", label: `站內搜尋頁（${host}）` };
  }

  // 路徑有一段是搜尋頁
  const segments = path.split("/").filter(Boolean).map((s) => decodeSafe(s).toLowerCase());
  for (const seg of segments) {
    const stem = seg.replace(/\.(aspx?|php|html?|jsp|do|action|cgi|asp)$/, "");
    if (SEARCH_SEGMENT_RE.test(stem)) return { kind: "site_search", label: `站內搜尋頁（${host}）` };
    // 維基百科 Special:Search／特殊:搜索
    if (/^(special|特殊|特別):(search|搜索|搜尋|搜寻)$/i.test(stem)) return { kind: "site_search", label: "維基百科搜尋頁" };
  }
  // 維基百科 /w/index.php?search=…
  if (/(^|\.)wikipedia\.org$/.test(host) && hasParam(u, "search")) return { kind: "site_search", label: "維基百科搜尋頁" };
  // Facebook、X、Threads、Instagram 的搜尋與主題標籤頁已由路徑段 search 涵蓋；YouTube 在搜尋引擎那一段

  // 政府網站：列表頁帶關鍵字參數也是站內搜尋
  if (isGovHost(host)) {
    for (const [k, v] of u.searchParams) {
      if (GOV_KEYWORD_PARAMS.has(k.toLowerCase()) && v.trim() !== "") return { kind: "site_search", label: `政府網站站內搜尋頁（${host}）` };
    }
  }
  return null;
}

export function isSearchResultPage(url: unknown): boolean {
  return searchPageVerdict(url) !== null;
}

/** 一串網址分成「實際頁面」與「搜尋結果頁」，順序不變 */
export function splitSearchPages(urls: readonly unknown[]): { pages: string[]; search: string[] } {
  const pages: string[] = [];
  const search: string[] = [];
  for (const u of urls) {
    if (typeof u !== "string") continue;
    (isSearchResultPage(u) ? search : pages).push(u);
  }
  return { pages, search };
}

/** 給代理看的那一句（交件守門、查無守門、協議、任務說明同一句） */
export const SEARCH_PAGE_NOT_SOURCE = "搜尋結果頁不是出處，請附實際打開的頁面";
