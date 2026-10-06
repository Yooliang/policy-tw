/**
 * 政見／基本資料缺口回「查無」的交件守門（維護者 2026-10-01 核准）。
 *
 * 抽 8 筆 policy_missing 的 no_change(not_found)：多半只看中選會、議會官網、中央社、自由時報，checked_urls 2～4 個，
 * 很少用搜尋引擎、沒有人查候選人臉書；另一隻代理用搜尋引擎就找到 READr 政見總覽（whoareyou.readr.tw）。
 * 「查無」是在主張不存在，要證明找過該找的地方：checked_urls 少於 5 個（去重）就 400，不算被拒，訊息講清楚要查哪些。
 * 只擋自動派的 policy_missing／profile_gap／term_policy_missing（task_id 是 auto:<型別>:<人物>[:<屆別>]）；手動任務、其他型別、其他 outcome 不擋。
 * term_policy_missing（補任期政見，2026-10-02）一併納入：同樣是在主張「這個人沒有政見」。
 * profile_detail_gap（補學經歷條列，2026-10-02）一併納入：bio 裡通常已經寫著學經歷，
 *   說「查不到」之前要真的去找支持它的來源頁，不能看一眼 bio 就放棄。
 *
 * 2026-10-04（協議 1.44.0）：查無比例異常高的模型系列另有一套較嚴的門檻（7 個網址、≥4 個不同網域），
 * 誰算「異常高」由 not-found-series.ts 依近 14 天的統計算，不綁任何模型名稱。
 *
 * 2026-10-06：搜尋結果頁不計入網址數（search-page.ts）。更正 10-01「checked_urls 至少一個是搜尋結果頁」：
 * 搜尋引擎照樣要用，但要附的是點進去實際打開的頁面；搜了哪些關鍵字寫在 finding。
 */

import { isSearchResultPage, SEARCH_PAGE_NOT_SOURCE } from "./search-page.ts";

export const NOT_FOUND_MIN_CHECKED_URLS = 5;
/** 一般門檻不看網域（0＝不檢查）：5 個網址已經上線三天，不動誠實代理現在的做法 */
export const NOT_FOUND_MIN_DOMAINS = 0;
/** 查無比例異常高的系列：網址 7 個 */
export const NOT_FOUND_ELEVATED_MIN_CHECKED_URLS = 7;
/**
 * 查無比例異常高的系列：至少 4 個不同網域。
 * 數量門檻擋不住湊數（2026-10-01 裁決自己寫了這句），「去過幾個不同的地方」才是查無該證明的事。
 * 4 個對應協議本來就要求的搜尋引擎、候選人臉書／IG、READr、地方新聞或政黨頁。
 */
export const NOT_FOUND_ELEVATED_MIN_DOMAINS = 4;

export const NOT_FOUND_SEARCH_TASK_TYPES = ["policy_missing", "profile_gap", "term_policy_missing", "profile_detail_gap"] as const;

/** 搜尋關鍵字建議：任務說明、交件守門、協議三處同一份 */
export const SEARCH_KEYWORDS: Record<(typeof NOT_FOUND_SEARCH_TASK_TYPES)[number], string> = {
  policy_missing: "「姓名 政見」「姓名 參選 2026」「姓名 臉書」（或「姓名 Facebook」）",
  profile_gap: "「姓名 參選 2026」「姓名 臉書」（或「姓名 Facebook」）「姓名 照片」",
  term_policy_missing: "「姓名 政見 屆別年份」（例如「姓名 政見 2022」）「姓名 選舉公報」「姓名 臉書」（或「姓名 Facebook」）",
  profile_detail_gap: "「姓名 學歷」「姓名 經歷」「姓名 簡介」（議會／機關個人頁、維基百科）",
};
export const NON_OFFICIAL_SOURCES = "候選人臉書／IG／YouTube、READr 政見總覽（whoareyou.readr.tw）、地方新聞、政黨候選人頁";

/** auto:<型別>:<目標> 的型別；不是自動任務回 null */
export function autoTaskType(taskId: unknown): string | null {
  if (typeof taskId !== "string" || !taskId.startsWith("auto:")) return null;
  return taskId.split(":")[1] || null;
}

/** 這筆是不是「這道守門管的查無」；是就回任務型別，否則 null。先判這個才知道要不要去查系列統計 */
export function gatedNotFoundType(taskId: unknown, payload: unknown): string | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (p.outcome !== "not_found") return null;
  const type = autoTaskType(taskId ?? p.task_id);
  if (!type || !(NOT_FOUND_SEARCH_TASK_TYPES as readonly string[]).includes(type)) return null;
  return type;
}

export interface NotFoundRequirement {
  urls: number;
  domains: number;
  elevated: boolean;
}

/** 這一筆要幾個網址、幾個網域 */
export function notFoundRequirement(elevated: boolean): NotFoundRequirement {
  return elevated
    ? { urls: NOT_FOUND_ELEVATED_MIN_CHECKED_URLS, domains: NOT_FOUND_ELEVATED_MIN_DOMAINS, elevated: true }
    : { urls: NOT_FOUND_MIN_CHECKED_URLS, domains: NOT_FOUND_MIN_DOMAINS, elevated: false };
}

/**
 * 網址正規化後去重；非 http(s) 的丟掉。
 * 搜尋結果頁不計入（2026-10-06，search-page.ts）：它只證明搜過、不證明看過，另外回傳扣掉了幾個。
 */
function checkedUrls(payload: Record<string, unknown>): { urls: string[]; searchPages: number } {
  const raw = Array.isArray(payload.checked_urls)
    ? payload.checked_urls.filter((u): u is string => typeof u === "string" && /^https?:\/\/\S+/.test(u.trim()))
    : [];
  const all = [...new Set(raw.map((u) => u.trim().replace(/\/+$/, "").toLowerCase()))];
  const pages = all.filter((u) => !isSearchResultPage(u));
  return { urls: pages, searchPages: all.length - pages.length };
}

/** 不同網域的個數：主機名去掉開頭的 www.；解析不出主機名的那一個算它自己一個 */
export function distinctDomains(urls: readonly string[]): number {
  const hosts = urls.map((u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return u;
    }
  });
  return new Set(hosts).size;
}

export interface NotFoundShortfall {
  task_type: string;
  checked: number;
  required: number;
  domains: number;
  required_domains: number;
  elevated: boolean;
  /** 扣掉、不計入的搜尋結果頁個數（去重後） */
  search_pages: number;
}

/** 純函式：這筆 no_change 是不是「查無但查得太少」；是就回缺多少，否則 null */
export function notFoundSearchShortfall(taskId: unknown, payload: unknown, elevated = false): NotFoundShortfall | null {
  const type = gatedNotFoundType(taskId, payload);
  if (!type) return null;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const { urls, searchPages } = checkedUrls(p);
  const req = notFoundRequirement(elevated);
  const domains = distinctDomains(urls);
  if (urls.length >= req.urls && domains >= req.domains) return null;
  return { task_type: type, checked: urls.length, required: req.urls, domains, required_domains: req.domains, elevated: req.elevated, search_pages: searchPages };
}

export function notFoundSearchMessage(s: NotFoundShortfall): string {
  const kw = SEARCH_KEYWORDS[s.task_type as keyof typeof SEARCH_KEYWORDS] ?? SEARCH_KEYWORDS.policy_missing;
  const domainPart = s.required_domains > 0
    ? `、而且要分布在至少 ${s.required_domains} 個不同網域（你附的 ${s.checked} 個網址只有 ${s.domains} 個網域）`
    : "";
  const searchPart = s.search_pages > 0
    ? `${SEARCH_PAGE_NOT_SOURCE}：你附的網址裡有 ${s.search_pages} 個是搜尋結果頁，不計入。`
    : "";
  return searchPart +
    `回報「查無」（not_found）要證明找過該找的地方：checked_urls 至少 ${s.required} 個不同的實際頁面${domainPart}，你附了 ${s.checked} 個（搜尋結果頁不算）。` +
    `請用搜尋引擎至少搜三組關鍵字：${kw}；並看非官方來源：${NON_OFFICIAL_SOURCES}。` +
    `checked_urls 放你從搜尋結果點進去、實際打開的頁面（候選人臉書、報導、公報、政黨頁），finding 寫出你搜了哪些關鍵字、各看到什麼。只看中選會、議會官網、一兩家媒體首頁不夠。這不算被拒，補查後再送。`;
}
