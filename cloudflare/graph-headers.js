/**
 * 脈絡完整關係圖（/lineage/<id>/graph，#675 第四期）的回應標頭。
 *
 * 這一頁只在瀏覽器端畫、不收錄：殼檔（app.html）本來就帶 <meta name="robots" content="noindex">，那是靠 HTML 的第一道；
 * Worker 在代理回應上補 X-Robots-Tag: noindex 與 Link: <主頁>; rel="canonical"，是不用讀 HTML 就看得到的第二道。
 * 不要在 robots.txt 擋這個路徑——擋了爬蟲讀不到 noindex，反而可能只收網址。
 *
 * 這一頁不在 SSR_ROUTES（ssr-worker.js）裡，走一般代理；這支只負責補標頭。
 */

export const GRAPH_PATH = /^\/lineage\/([^/]+)\/graph\/?$/

/** 這個路徑是關係圖頁就回要補的標頭（含 origin 的主頁網址），不是就回 null */
export function graphHeaders(pathname, origin) {
  const m = GRAPH_PATH.exec(pathname)
  if (!m) return null
  return { 'X-Robots-Tag': 'noindex', Link: `<${origin}/lineage/${m[1]}>; rel="canonical"` }
}

/** 對代理回來的回應補標頭（回應可能是不可改的，所以複製一份）；其他路徑原樣回傳 */
export function withGraphHeaders(response, pathname, origin) {
  const extra = graphHeaders(pathname, origin)
  if (!extra) return response
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(extra)) headers.set(k, v)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
