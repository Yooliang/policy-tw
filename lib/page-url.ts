/**
 * 每頁的 canonical／og:url 怎麼算（composables/usePageHead.ts 用；純函式，deno 直接測）。
 * 預設用路由的 path；關係圖頁這類「不收錄、canonical 要指別頁」的給站內路徑覆蓋（#675 第四期）。
 */

/** 路由 path → canonical 用的路徑：去尾斜線、非 ASCII 字元 percent-encode（已編碼的不重複編碼） */
export function canonicalPath(path: string): string {
  if (path === '/' || path === '') return '/'
  let decoded = path
  try { decoded = decodeURI(path) } catch { /* 原樣 */ }
  return encodeURI(decoded).replace(/\/$/, '')
}

/** 這一頁的 canonical 網址：有給 canonical（站內路徑）就用它，否則是路由 path；canonical 不是站內路徑（不以 / 開頭、或 // 開頭）就退回路由 path */
export function pageUrlOf(siteUrl: string, routePath: string, canonical?: string | null): string {
  const own = typeof canonical === 'string' && canonical.startsWith('/') && !canonical.startsWith('//') ? canonical : routePath
  return `${siteUrl}${canonicalPath(own)}`
}
