/**
 * 政見／基本資料缺口回「查無」的交件守門（維護者 2026-10-01 核准）。
 *
 * 抽 8 筆 policy_missing 的 no_change(not_found)：多半只看中選會、議會官網、中央社、自由時報，checked_urls 2～4 個，
 * 很少用搜尋引擎、沒有人查候選人臉書；另一隻代理用搜尋引擎就找到 READr 政見總覽（whoareyou.readr.tw）。
 * 「查無」是在主張不存在，要證明找過該找的地方：checked_urls 少於 5 個（去重）就 400，不算被拒，訊息講清楚要查哪些。
 * 只擋自動派的 policy_missing／profile_gap（task_id 是 auto:<型別>:<人物>）；手動任務、其他型別、其他 outcome 不擋。
 */

export const NOT_FOUND_MIN_CHECKED_URLS = 5;
export const NOT_FOUND_SEARCH_TASK_TYPES = ["policy_missing", "profile_gap"] as const;

/** 搜尋關鍵字建議：任務說明、交件守門、協議三處同一份 */
export const SEARCH_KEYWORDS: Record<(typeof NOT_FOUND_SEARCH_TASK_TYPES)[number], string> = {
  policy_missing: "「姓名 政見」「姓名 參選 2026」「姓名 臉書」（或「姓名 Facebook」）",
  profile_gap: "「姓名 參選 2026」「姓名 臉書」（或「姓名 Facebook」）「姓名 照片」",
};
export const NON_OFFICIAL_SOURCES = "候選人臉書／IG／YouTube、READr 政見總覽（whoareyou.readr.tw）、地方新聞、政黨候選人頁";

/** auto:<型別>:<目標> 的型別；不是自動任務回 null */
export function autoTaskType(taskId: unknown): string | null {
  if (typeof taskId !== "string" || !taskId.startsWith("auto:")) return null;
  return taskId.split(":")[1] || null;
}

/** 純函式：這筆 no_change 是不是「查無但查得太少」；是就回缺多少，否則 null */
export function notFoundSearchShortfall(taskId: unknown, payload: unknown): { task_type: string; checked: number; required: number } | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (p.outcome !== "not_found") return null;
  const type = autoTaskType(taskId ?? p.task_id);
  if (!type || !(NOT_FOUND_SEARCH_TASK_TYPES as readonly string[]).includes(type)) return null;
  const urls = Array.isArray(p.checked_urls) ? p.checked_urls.filter((u): u is string => typeof u === "string" && /^https?:\/\/\S+/.test(u.trim())) : [];
  const checked = new Set(urls.map((u) => u.trim().replace(/\/+$/, "").toLowerCase())).size;
  return checked < NOT_FOUND_MIN_CHECKED_URLS ? { task_type: type, checked, required: NOT_FOUND_MIN_CHECKED_URLS } : null;
}

export function notFoundSearchMessage(s: { task_type: string; checked: number; required: number }): string {
  const kw = SEARCH_KEYWORDS[s.task_type as keyof typeof SEARCH_KEYWORDS] ?? SEARCH_KEYWORDS.policy_missing;
  return `回報「查無」（not_found）要證明找過該找的地方：checked_urls 至少 ${s.required} 個不同網址，你附了 ${s.checked} 個。` +
    `請用搜尋引擎至少搜三組關鍵字：${kw}；並看非官方來源：${NON_OFFICIAL_SOURCES}。` +
    `checked_urls 至少要有一個搜尋結果頁的網址，finding 寫出你搜了哪些關鍵字、各看到什麼。只看中選會、議會官網、一兩家媒體首頁不夠。這不算被拒，補查後再送。`;
}
