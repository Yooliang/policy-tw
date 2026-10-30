/**
 * 哪些頁不放廣告（頁尾橫幅 AdSlot 與桌面版右欄 AdRail 共用同一份）：
 * 後台、登入回呼、AI 助理、個人頁、貢獻類頁面沒有內容給讀者，也不該有廣告。
 */
export const AD_HIDDEN_PREFIXES = ['/admin', '/auth', '/contributions', '/tasks', '/stats', '/ai', '/profile']
export const AD_CLIENT = 'ca-pub-6687848895101003'
export function adHiddenPath(path: string): boolean {
  return AD_HIDDEN_PREFIXES.some((p) => path.startsWith(p))
}
