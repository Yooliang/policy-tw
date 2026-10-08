/**
 * 邊緣 SSR 的非 200 結果怎麼變成回應（2026-10-08，#466）。從 ssr-worker.js 抽出來是為了能單獨測（ssr-worker.js 會 import 建置產物 dist-ssr）。
 *
 *   301 → 轉向（已合併的人物 → 保留的那一位）。舊網址照常有用，不能 404（網址保持）；轉向本身不進快取，合併被撤銷時不會卡舊的。
 *   404 → 客戶端殼＋空狀態、狀態碼 404。**不快取**：新建的人物不能被「剛才查不到」的 404 卡住。
 */

/** 同站路徑才轉：必須是 `/` 開頭、不是 `//`（避免被當成別的網域）；不合格回 null，呼叫端當 404 */
export function safeLocalPath(location) {
  if (typeof location !== 'string' || !location.startsWith('/') || location.startsWith('//') || /[\r\n\\]/.test(location)) return null
  return location
}

/** 原網址的查詢字串（?view=、?tab=、?utm_…）轉向時照帶；不是 `?` 開頭、含換行就丟掉 */
export function safeSearch(search) {
  return typeof search === 'string' && search.startsWith('?') && search.length > 1 && !/[\r\n\s#]/.test(search) ? search : ''
}

/**
 * @param {{ status: number|string, location?: string }} r entry-server 的 RenderResult
 * @param {{ shell: string, origin: string, search?: string }} ctx 原請求的查詢字串（301 照帶）
 * @returns {Response | null} 200／passthrough 回 null（由呼叫端照原本流程組頁面）
 */
export function nonPageResponse(r, { shell, origin, search = '' }) {
  if (r.status === 301) {
    const path = safeLocalPath(r.location)
    if (path) {
      return new Response(null, {
        status: 301,
        headers: { Location: `${origin}${path}${safeSearch(search)}`, 'X-Served-Via': 'cloudflare-worker-ssr', 'Cache-Control': 'public, max-age=3600' },
      })
    }
    return notFound(shell)
  }
  if (r.status === 404) return notFound(shell)
  return null
}

function notFound(shell) {
  const body = shell.replace('<div id="app"></div>', '<div id="app"></div><script>window.__INITIAL_STATE__="{}"</script>')
  return new Response(body, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Served-Via': 'cloudflare-worker-ssr', 'X-Cache': 'MISS' },
  })
}
