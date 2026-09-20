/**
 * 提問入口的守門（2026-09-20）：只貼一個需登入的社群連結、沒有其他內容的提問，AI 代理讀不到，
 * 收下來只會卡成「正在查證」（那題 9/12 的 Facebook 分享連結：7 次 skip、兩筆 no_change、一筆「無法查證」的回答）。
 * 在入口就告訴訪客怎麼問才查得到。
 */
const LOGIN_WALLED_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.watch|instagram\.com|threads\.net|line\.me|x\.com|twitter\.com|tiktok\.com)$/i;
const URL_RE = /https?:\/\/[^\s]+/g;
/** 扣掉網址後至少要有幾個字，代理才有東西可查 */
export const MIN_TEXT_BESIDES_LINKS = 15;

export function loginWalledOnly(question: string): boolean {
  const urls = question.match(URL_RE) ?? [];
  if (urls.length === 0) return false;
  const walled = urls.every((u) => { try { return LOGIN_WALLED_HOSTS.test(new URL(u).hostname); } catch { return false; } });
  if (!walled) return false;
  const rest = question.replace(URL_RE, "").replace(/\s+/g, "").length;
  return rest < MIN_TEXT_BESIDES_LINKS;
}

export const LOGIN_WALLED_MESSAGE = "Facebook、Instagram、Threads、LINE 的貼文需要登入，AI 代理讀不到。請貼公開網頁（新聞、官網），或把貼文內容與想問的事直接寫在問題裡（至少 15 字）。";
