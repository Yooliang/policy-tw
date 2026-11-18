/**
 * 預渲染頁的邊緣快取（#982 第 2 項）。
 *
 * 首頁、/election/*、/tracking、/analysis 等預渲染頁原本由 proxy() 原樣轉發到 Firebase Hosting，
 * 源站對 ** 一律回 Cache-Control: no-cache，所以每個訪客都從 Firebase 拿一份（首頁 1.6～3.1 MB）。
 * 這裡在 Worker 內用 Cache API 存一份：新鮮 5 分鐘，過期後最多再 10 分鐘先回舊的、背景重抓（stale-while-revalidate）。
 *
 * 只快取：GET、沒有 Range、沒有登入／工作階段類 Cookie、回應 200 且 text/html。
 * 不快取：/assets/**（本來就一年 immutable）、/skill.md 與其他 .md／.txt（協議檔要即時）、/api/、協議端點。
 * 部署之後（policy-ops#37 同一個問題）：Firebase 會刪掉舊的 /assets 檔，快取裡的舊頁指著它們就會壞掉。
 * 存頁時記下殼的版本（X-Shell-Version），取出時跟現在的殼比，不同版就當沒命中、當場重抓（shell-version.js）。
 * 純函式＋依賴注入（cache、fetch 由呼叫端給），Deno 測試可直接跑。
 */

import { shellVersion, shouldRerender } from './shell-version.js'

export const FRESH_S = 300
export const STALE_S = 600
/** 給訪客與瀏覽器看的：瀏覽器每次問邊緣，邊緣 5 分鐘內不回源 */
export const PRERENDER_CACHE_CONTROL = `public, max-age=0, s-maxage=${FRESH_S}, stale-while-revalidate=${STALE_S}`
/** 存進 Cache API 的：Cache API 不懂 stale-while-revalidate，保存期要拉到新鮮期＋舊頁期，過期判斷自己用 X-Prerender-Cached-At */
const STORE_CACHE_CONTROL = `public, max-age=${FRESH_S + STALE_S}`

/** 追蹤參數：不影響內容，不進快取鍵 */
const TRACKING_PARAM = /^(utm_[a-z0-9_]*|fbclid|gclid|gbraid|wbraid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|ref_src|ref_url)$/i
/** 分析類 Cookie（Google Analytics、Meta 像素）：預渲染頁不看它們，帶著也可以快取。其餘 Cookie 一律視為可能是工作階段 */
const ANALYTICS_COOKIE = /^(_ga(_[A-Za-z0-9]+)?|_gid|_gat(_[A-Za-z0-9_]+)?|_gcl_[a-z]+|_fbp|_fbc|__utm[a-z]|_clck|_clsk)$/
/** 這些路徑不快取：靜態資產自己有一年 immutable；協議檔與 API 要即時 */
const BYPASS_PATH = /^\/(assets\/|api\/|functions\/|__)|\.(md|txt|xml|json|js|css|map|ico|png|jpe?g|gif|svg|webp|woff2?)$/i

function hasSessionCookie(cookieHeader) {
  if (!cookieHeader) return false
  return cookieHeader.split(';').some((part) => {
    const name = part.split('=')[0].trim()
    return name !== '' && !ANALYTICS_COOKIE.test(name)
  })
}

/** 這個請求可不可以走快取 */
export function isCacheableRequest(request) {
  if (request.method !== 'GET') return false
  if (request.headers.get('Authorization')) return false
  if (request.headers.get('Range')) return false
  if (hasSessionCookie(request.headers.get('Cookie'))) return false
  const url = new URL(request.url)
  if (BYPASS_PATH.test(url.pathname)) return false
  return true
}

/** 快取鍵：只留網址路徑與非追蹤參數（排序），同一頁只有一個鍵 */
export function prerenderCacheKey(rawUrl) {
  const url = new URL(rawUrl)
  const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const qs = new URLSearchParams(kept).toString()
  return new Request(`${url.origin}${url.pathname}${qs ? `?${qs}` : ''}`, { method: 'GET' })
}

/** 上游回應可不可以存：200、text/html、沒有 Set-Cookie */
export function isCacheableResponse(res) {
  if (res.status !== 200) return false
  if (res.headers.has('Set-Cookie')) return false
  return /^text\/html\b/i.test(res.headers.get('Content-Type') ?? '')
}

function withCacheHeaders(res, state) {
  const h = new Headers(res.headers)
  h.set('Cache-Control', PRERENDER_CACHE_CONTROL)
  h.set('X-Prerender-Cache', state)
  return h
}

/**
 * 抓上游並（可存時）寫進快取。回傳 { response, stored }。
 * 內文整份讀進記憶體（首頁約 13 MB）：要同時給訪客與快取各一份，且順便判斷它是不是已解壓。
 */
async function fetchAndStore(request, key, deps, ctx) {
  const upstream = await deps.proxy(request)
  if (!isCacheableResponse(upstream)) {
    return { response: new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: withBypass(upstream.headers) }), stored: false }
  }
  const body = await upstream.arrayBuffer()
  const h = new Headers(upstream.headers)
  // 源站 Vary: accept-encoding 會讓 Cache API 拿合成的快取鍵（沒有請求標頭）比對時永遠 miss
  h.delete('Vary')
  // Worker 的 fetch 會把壓縮的回應解開；內文已是明文（以 < 開頭的 HTML）就不能再帶著 Content-Encoding／Content-Length 存，否則瀏覽器會拿明文去解壓
  const first = new Uint8Array(body, 0, Math.min(body.byteLength, 1))[0]
  if (first === 0x3c || first === 0x20 || first === 0x0a || first === 0xef) { h.delete('Content-Encoding'); h.delete('Content-Length') }
  const forVisitor = new Headers(h)
  forVisitor.set('Cache-Control', PRERENDER_CACHE_CONTROL)
  forVisitor.set('X-Prerender-Cache', 'MISS')
  const forStore = new Headers(h)
  forStore.set('Cache-Control', STORE_CACHE_CONTROL)
  forStore.set('X-Prerender-Cached-At', String(Date.now()))
  const shell = deps.currentShell ? await deps.currentShell() : null
  if (shell !== null) forStore.set('X-Shell-Version', shellVersion(shell))
  const store = deps.cache.put(key, new Response(body, { status: 200, headers: forStore })).catch(() => undefined)
  ctx.waitUntil(store)
  return { response: new Response(body, { status: 200, headers: forVisitor }), stored: true }
}

function withBypass(headers) {
  const h = new Headers(headers)
  h.set('X-Prerender-Cache', 'BYPASS')
  return h
}

/**
 * @param {Request} request
 * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
 * @param {{ cache: { match(r: Request): Promise<Response | undefined>, put(r: Request, res: Response): Promise<void> }, proxy: (r: Request) => Promise<Response>, currentShell?: () => Promise<string | null>, now?: () => number }} deps
 */
export async function cachedProxy(request, ctx, deps) {
  if (!isCacheableRequest(request)) return deps.proxy(request)
  const key = prerenderCacheKey(request.url)
  const hit = await deps.cache.match(key).catch(() => undefined)
  const currentShell = hit && deps.currentShell ? await deps.currentShell() : null
  // 殼換版了：快取裡的舊頁指著已被刪掉的 /assets 檔，當沒命中、當場重抓（拿不到殼時沿用快取）
  if (hit && !shouldRerender(hit.headers.get('X-Shell-Version'), currentShell)) {
    const now = (deps.now ?? Date.now)()
    const age = now - Number(hit.headers.get('X-Prerender-Cached-At') ?? 0)
    const stale = age > FRESH_S * 1000
    // 過了新鮮期：先回舊的，背景重抓一份換掉；重抓失敗不影響這次回應
    if (stale) ctx.waitUntil(fetchAndStore(request, key, deps, ctx).catch(() => undefined))
    return new Response(hit.body, { status: hit.status, headers: withCacheHeaders(hit, stale ? 'STALE' : 'HIT') })
  }
  return (await fetchAndStore(request, key, deps, ctx)).response
}
