/**
 * 社群平台網域清單的單一來源（盤點 #6，2026-10-07 維護者同意）。
 *
 * 以前同一族網域散在四個 TS 模組，各自抄一份、內容還不一樣：
 *   lineage.ts            UNREADABLE_SOCIAL_HOSTS   5 個（臉書、IG、Threads）
 *   source-write.ts       SELF_INELIGIBLE_HOSTS     13 個（上面 5 個＋YouTube、X、LINE、TikTok、Telegram）
 *   question-intake.ts    LOGIN_WALLED_HOSTS        9 個（正規式；上面 5 個＋LINE、X、Twitter、TikTok）
 *   source-priority.ts    SOURCE_PRIORITY 的 social 5 個（臉書、IG、Threads、YouTube、X；帶標籤與等級，另一個用途）
 * 現在前三份都從這裡長出來，各自只多寫「這個用途多收哪幾個」；SQL 那邊仍是各自的函式（要 IMMUTABLE，不能讀表），
 * 由 source-domains.test.ts 與既有的 source-write／politician-careers／thresholds 測試逐個對照。
 *
 * ## 各清單的用途與對齊結果（改清單前先看用途，**守門只能收緊、不能放寬**）
 * - UNREADABLE_SOCIAL_HOSTS：要登入才看得到，驗證者與系統都打不開 → 不收當出處（#349 裁決：臉書讀不到不收）。
 *   SQL：career_source_readable()。**這條不能變鬆。**
 * - SELF_INELIGIBLE_HOSTS：不能標成「本人來源」的平台＝讀不到的那 5 個＋讀得到但不是本人官網的 8 個。SQL：source_self_eligible()。
 * - LOGIN_WALLED_HOSTS：提問只貼這些連結、沒有其他文字，代理讀不到內容 → 入口擋下、請訪客把內容寫出來。
 *   用途是「代理讀不讀得到」，所以＝讀不到的 5 個＋要登入才看得到的 LINE、X／Twitter、TikTok（含 LINE 短網址 lin.ee）。
 *   YouTube（公開影片讀得到）、Telegram（公開頻道讀得到）不算。**對齊時只補了 lin.ee**（跟 line.me 同一個服務，
 *   以前漏列＝只貼 lin.ee 連結的提問會被收下然後卡成「正在查證」）；這是收緊，沒有任何一個原本擋的網域被拿掉。
 * - SOURCE_PRIORITY 的 social（source-priority.ts）：派工排序與顯示用的「優先來源」等級，不是守門；
 *   沒有收 fb.com／fb.watch／twitter.com／youtu.be 是刻意的（改了會動到 SQL contribution_source_kind 的排序），不在這裡對齊。
 * - ai-classify 的 NEWS_DOMAINS 是 2026-02 舊管線（沒有任何排程呼叫，等下架），不動。
 */

/** 要登入才看得到的 Meta 家族：驗證者與系統都打不開，不收當出處（SQL：career_source_readable） */
export const UNREADABLE_SOCIAL_HOSTS = ["facebook.com", "fb.com", "fb.watch", "instagram.com", "threads.net"] as const;

/** 讀得到、或要看情況，但不是候選人本人官網的平台：YouTube、X／Twitter、TikTok、LINE（含短網址）、Telegram */
export const NON_OWN_SITE_PLATFORM_HOSTS = ["youtube.com", "youtu.be", "x.com", "twitter.com", "tiktok.com", "line.me", "lin.ee", "t.me"] as const;

/** 不能標成「本人來源」的平台（SQL：source_self_eligible） */
export const SELF_INELIGIBLE_HOSTS = [...UNREADABLE_SOCIAL_HOSTS, ...NON_OWN_SITE_PLATFORM_HOSTS] as const;

/** 除了 UNREADABLE 之外，另外要登入才看得到內容的平台（提問入口用） */
export const LOGIN_WALLED_EXTRA_HOSTS = ["line.me", "lin.ee", "x.com", "twitter.com", "tiktok.com"] as const;

/** 提問入口：只貼這些連結、沒有其他內容，代理讀不到 */
export const LOGIN_WALLED_HOSTS = [...UNREADABLE_SOCIAL_HOSTS, ...LOGIN_WALLED_EXTRA_HOSTS] as const;

/** host 是不是清單裡的網域或它的子網域（m.facebook.com 算 facebook.com；evilfacebook.com 不算） */
export function hostInList(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase();
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}
