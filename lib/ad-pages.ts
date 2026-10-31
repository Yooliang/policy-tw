/**
 * 哪些頁不放廣告（頁尾橫幅 AdSlot 與桌面版右欄 AdRail 共用同一份）。
 * 2026-10-31 小良哥裁示：除了首頁與「關於」區，其他有內容的頁（貢獻、參與、搜尋、一覽…）都放。
 * 保留的排除：
 *   「關於」區（延伸欄「關於」那一組）：/vision 關於正見、/contact 聯絡我們、/terms 使用條款、/privacy 隱私權政策、/donation 贊助（支持正見）
 *   AdSense 政策不允許放廣告的無內容頁：/admin 後台管理、/auth 登入回呼（只是跳轉中繼頁）、/profile 帳號設定（個人設定表單）
 *   首頁 /：右欄不放（App.vue 的 showRail 判斷），頁尾橫幅照舊
 * 沒有 404 頁（不存在的網址一律導回首頁）；沒有純表單送出結果頁。
 */
export const AD_HIDDEN_PREFIXES = ['/admin', '/auth', '/profile', '/vision', '/contact', '/terms', '/privacy', '/donation']
export const AD_CLIENT = 'ca-pub-6687848895101003'
export function adHiddenPath(path: string): boolean {
  return AD_HIDDEN_PREFIXES.some((p) => path.startsWith(p))
}
