/**
 * 人物頁圖片歸屬（#975）：Google 圖片搜尋會把頁面上的 <img> 當成這一頁的主圖。
 * 本人沒有照片時，「同選區其他候選人」卡片裡別人的官方照被收成本人的圖（現任里長的臉掛在候選人名下）。
 * 做法：別人的人像改成 CSS background-image（span role="img"），本人沒照片時再加 noimageindex。
 */

/** 本人沒有照片 → 整頁不要收圖片（資料還沒到、確定沒這個人時不加，那種情況另有 noindex） */
export function shouldNoImageIndex(person: { avatarUrl?: string | null } | null | undefined): boolean {
  return !!person && !person.avatarUrl
}

/** <meta name="robots"> 的內容；兩個旗標都沒開回 undefined（不輸出標籤） */
export function robotsContent(flags: { noindex?: boolean; noimageindex?: boolean }): string | undefined {
  const parts = [flags.noindex ? 'noindex' : '', flags.noimageindex ? 'noimageindex' : ''].filter(Boolean)
  return parts.length ? parts.join(', ') : undefined
}

/** CSS url("…")：網址裡的引號、反斜線、換行與括號先編碼，免得跳出 style 屬性 */
export function cssUrl(url: string): string {
  return `url("${url.replace(/["\\n\r()]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)))}")`
}
