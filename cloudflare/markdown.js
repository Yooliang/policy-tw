/**
 * 正見.tw Worker 的 Markdown 檢視（docs/PLAN-markdown-views.md 5b、9；2026-10-07）。
 *
 * 這支只管「請求 → 回應」：路由解析（lib/md/route.ts）、內容組字（lib/md/*）、資料載入（lib/ssr/md-loaders.ts）都由呼叫端注入（deps），
 * 所以不 import dist-ssr、能在 Deno 測試裡用假的 deps 與假的 Cache 直接測。
 *
 * 兩種來源（維護者 10-07：摘要定時預產，不要每次被讀才算）：
 *   - 人物 /politician/<id>.md：讀時產生（一萬六千位，不預產），Cache API 快取 10 分鐘、過期先回舊的背景重算
 *   - 其餘（縣市某屆、分類、縣市×分類、索引 .md／.json）：只讀預產快取表 data_md_cache（排程腳本 scripts/build-data-md.ts 每小時重產，
 *     同一批的 generated_at 都一樣），找不到回 404 的 Markdown；Cache API 再擋一層（5 分鐘，新的一批很快就看得到）
 *
 * 給程式批次撈的（維護者 10-07）：每個 200 帶 ETag（內容雜湊，沒變就不變）、Last-Modified（內容最後變動時間）、
 * X-Data-Generated-At（這一批的產生時間）；支援 If-None-Match／If-Modified-Since 回 304；Access-Control-Allow-Origin: *（純公開資料）。
 * 所有回應：X-Robots-Tag: noindex（不跟 HTML 搶搜尋排名；robots.txt 不得 Disallow .md）。
 */

export const CACHE_TTL_S = 600
export const STALE_TTL_S = 3600
/** 預產的頁在 Worker 的快取多久重讀一次快取表（便宜的單列查詢）；比排程頻率短，新的一批很快就換上 */
export const ROW_TTL_S = 300
/** 排程每小時一次：邊緣 s-maxage 對齊它 */
export const SCHEDULE_S = 3600
/**
 * 瀏覽器端最多舊多久：10 分鐘（維護者 10-07：程式批次撈，不能拿到比一小時排程還舊的）。
 * 為什麼要明寫、而且 Cache API 命中時還要再蓋一次：Cloudflare 的「瀏覽器快取 TTL」區域設定（這個網域是 4 小時）會在 caches.default
 * 命中時把 max-age 抬到 14400，實測第一次（MISS）是 max-age=0、第二次（HIT）變 max-age=14400。回應前自己再設一次，才是我們要的值。
 */
export const BROWSER_MAX_AGE_S = 600
export const PERSON_CACHE_CONTROL = `public, max-age=${BROWSER_MAX_AGE_S}, s-maxage=${CACHE_TTL_S}, stale-while-revalidate=${STALE_TTL_S}`
export const ROW_CACHE_CONTROL = `public, max-age=${BROWSER_MAX_AGE_S}, s-maxage=${SCHEDULE_S}, stale-while-revalidate=${ROW_TTL_S}`

const TYPES = { md: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8' }
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'ETag, Last-Modified, X-Data-Generated-At, X-Cache',
}

/** @param {'md'|'json'} format @param {Record<string,string>} [extra] */
function baseHeaders(format, extra = {}) {
  return new Headers({ 'Content-Type': TYPES[format], 'X-Robots-Tag': 'noindex', 'X-Served-Via': 'cloudflare-worker-md', ...CORS, ...extra })
}

function redirect(origin, status, to) {
  return new Response(null, { status, headers: baseHeaders('md', { Location: `${origin}${to}`, 'Cache-Control': status === 301 ? 'public, max-age=3600' : 'no-store' }) })
}

/** FNV-1a 32 位元雜湊（十六進位）：給 ETag 的路徑後綴與人物頁的內容雜湊；不是安全用途 */
export function fnv(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

const stripWeak = (t) => t.trim().replace(/^W\//, '')

/**
 * 條件請求：If-None-Match 優先（弱比對）；沒有才看 If-Modified-Since。符合回 304（帶驗證用的標頭），否則 null。
 * @param {Request} request @param {Headers} headers 這個回應的標頭
 */
export function notModified(request, headers) {
  const etag = headers.get('ETag')
  const inm = request.headers.get('If-None-Match')
  let matched = false
  if (inm) {
    matched = inm.trim() === '*' || (!!etag && inm.split(',').some((t) => stripWeak(t) === stripWeak(etag)))
  } else {
    const ims = request.headers.get('If-Modified-Since')
    const lm = headers.get('Last-Modified')
    if (ims && lm) {
      const a = Date.parse(ims), b = Date.parse(lm)
      matched = !Number.isNaN(a) && !Number.isNaN(b) && b <= a
    }
  }
  if (!matched) return null
  const h = new Headers()
  for (const k of ['ETag', 'Last-Modified', 'Cache-Control', 'X-Data-Generated-At', 'X-Robots-Tag', 'X-Served-Via', ...Object.keys(CORS)]) { const v = headers.get(k); if (v) h.set(k, v) }
  return new Response(null, { status: 304, headers: h })
}

/**
 * @typedef {object} CacheRow
 * @property {string} body  本文（json 的是 JSON 字串）
 * @property {any} meta  MdPage 去掉 body
 * @property {string} generated_at  這一批的產生時間
 * @property {string} [changed_at]  這份內容最後一次變動
 * @property {string} [content_sha]
 * @property {number} row_count
 *
 * @typedef {object} Deps
 * @property {(pathname: string, params: URLSearchParams) => any} match  lib/md/route.ts 的 matchMarkdownRoute
 * @property {(target: 'data'|'election', segment: string, tail: string[]) => string} latestPath  lib/md/route.ts 的 latestPath
 * @property {(id: string) => Promise<any>} loadPerson  lib/ssr/md-loaders.ts 的 loadPoliticianMd
 * @property {(input: any) => string} renderPerson  lib/md/politician.ts 的 renderPoliticianMd
 * @property {(key: string) => Promise<CacheRow | null>} fetchCacheRow  讀 data_md_cache 一列；沒有回 null
 * @property {() => Promise<string | null>} latestSegment  最新一屆的選舉網址那一段（矩陣列裡的）
 * @property {(page: any, path: string, generatedAt: number) => string} renderPage  lib/md/format.ts 的 renderPage
 * @property {(what: string) => any} notFoundPage  lib/md/index-page.ts 的 buildNotFoundPage
 * @property {{ match: Function, put: Function }} cache  Cache API（caches.default）
 * @property {() => number} [now]
 */

/**
 * 處理一個請求。不是 Markdown 檢視的網址回 null（呼叫端照舊處理）。
 * @param {Request} request
 * @param {{ waitUntil: (p: Promise<any>) => void }} ctx
 * @param {Deps} deps
 * @returns {Promise<Response | null>}
 */
/**
 * 瀏覽器直接打開（網址列、點連結，Accept 帶 text/html）時改回 text/plain：text/markdown 瀏覽器會當成檔案下載，
 * 點矩陣的「開 .md」只會跳下載、看不到內容（維護者 10-07）。程式（fetch、curl、NotebookLM）不送 text/html，照舊拿 text/markdown。
 * 同一個網址兩種 Content-Type，所以帶 Vary: Accept，瀏覽器快取不會拿錯。
 * @param {Request} request @param {Response|null} res
 */
export function adjustForBrowser(request, res) {
  if (!res) return res
  res.headers.append('Vary', 'Accept')
  const accept = request.headers.get('Accept') || ''
  if (accept.includes('text/html') && (res.headers.get('Content-Type') || '').startsWith('text/markdown')) {
    res.headers.set('Content-Type', 'text/plain; charset=utf-8')
  }
  return res
}

export async function handleMarkdown(request, ctx, deps) {
  return adjustForBrowser(request, await handleMarkdownRaw(request, ctx, deps))
}

async function handleMarkdownRaw(request, ctx, deps) {
  const isRead = request.method === 'GET' || request.method === 'HEAD'
  if (!isRead && request.method !== 'OPTIONS') return null
  const url = new URL(request.url)
  const route = deps.match(url.pathname, url.searchParams)
  if (!route) return null
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: new Headers({ ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'If-None-Match, If-Modified-Since', 'Access-Control-Max-Age': '86400' }) })
  }
  const now = deps.now ?? Date.now
  const head = request.method === 'HEAD'
  const nf = (what) => new Response(head ? null : deps.renderPage(deps.notFoundPage(what), decodeURI(url.pathname), now()), { status: 404, headers: baseHeaders('md', { 'Cache-Control': 'public, max-age=0, s-maxage=60' }) })

  try {
    switch (route.kind) {
      case 'redirect': return redirect(url.origin, route.status, route.to)
      case 'notfound': return nf(route.what)
      case 'data-matrix': {
        const seg = await deps.latestSegment()
        return seg ? redirect(url.origin, 302, `/election/${seg}/matrix`) : nf('還沒有預產的資料')
      }
      case 'latest': {
        const seg = await deps.latestSegment()
        return seg ? redirect(url.origin, route.status, deps.latestPath(route.target, seg, route.tail)) : nf('還沒有預產的資料')
      }
      case 'politician': return await cached(request, ctx, deps, now, nf, TTL_PERSON, PERSON_CACHE_CONTROL, async () => {
        const r = await deps.loadPerson(route.id)
        if (r.kind === 'merged') return { redirectTo: `/politician/${r.into}.md` }
        if (r.kind === 'notfound') return { notFound: `找不到這位人物：${route.id}` }
        const text = deps.renderPerson(r.input)
        return { text, format: 'md', etag: `W/"p-${fnv(text.replace(/^generated_at: .*$/m, ''))}"`, generatedAt: new Date(now()).toISOString() }
      })
      case 'category-latest': {
        const seg = await deps.latestSegment()
        if (!seg) return nf('還沒有預產的資料')
        return await rowResponse(request, ctx, deps, now, nf, `/data/${seg}/${route.category}.md`, `/category/${route.category}.md`, 'md')
      }
      case 'cache': return await rowResponse(request, ctx, deps, now, nf, route.key, route.path, route.format)
      default: return null
    }
  } catch (e) {
    // 資料庫暫時讀不到：不退回代理（那會回一個 200 的 HTML 殼，冒充 .md），回 503 並請對方稍後重試
    return new Response(head ? null : `# 暫時讀不到\n\n資料庫暫時沒有回應，請稍後重試。\n`, {
      status: 503,
      headers: baseHeaders('md', { 'Retry-After': '30', 'Cache-Control': 'no-store', 'X-MD-Error': String(e && e.message ? e.message : e).slice(0, 200) }),
    })
  }
}

const TTL_PERSON = CACHE_TTL_S
const TTL_ROW = ROW_TTL_S

/** 預產的一列 → 回應（組文件用請求的網址與這一批的 generated_at）；Cache API 一層 */
function rowResponse(request, ctx, deps, now, nf, key, path, format) {
  return cached(request, ctx, deps, now, nf, TTL_ROW, ROW_CACHE_CONTROL, async () => {
    const row = await deps.fetchCacheRow(key)
    if (!row) return { notFound: `這一頁沒有資料（不存在，或預產還沒跑到）：${path}` }
    const generatedAtMs = Date.parse(row.generated_at) || now()
    const text = format === 'json' ? row.body : deps.renderPage({ ...row.meta, body: [row.body] }, path, generatedAtMs)
    return {
      text,
      format,
      // 弱 ETag：內容雜湊＋請求網址（同一列可以用不同網址讀，內文裡的 url 不同）；排程每小時只換 generated_at、內容沒變時 ETag 不變
      etag: row.content_sha ? `W/"${row.content_sha.slice(0, 16)}-${fnv(path)}"` : undefined,
      lastModified: row.changed_at ? new Date(row.changed_at).toUTCString() : undefined,
      generatedAt: new Date(generatedAtMs).toISOString(),
    }
  })
}

/**
 * Cache API 一層：命中直接回（過期先回舊的、背景重算）；沒命中就產生，成功（200）才寫入。
 * 產生函式回 { text, format, etag?, lastModified?, generatedAt } | { redirectTo } | { notFound }。
 * 條件請求（If-None-Match／If-Modified-Since）在這裡統一處理。
 */
async function cached(request, ctx, deps, now, nf, ttl, cacheControl, produce) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '') || '/'
  const cacheKey = new Request(`${url.origin}${path}`, { method: 'GET' })
  const hit = await deps.cache.match(cacheKey)
  const toResponse = (r, cache) => {
    const headers = baseHeaders(r.format, { 'Cache-Control': cacheControl, 'X-Data-Generated-At': r.generatedAt, 'X-Rendered-At': String(now()), 'X-Cache': cache })
    if (r.etag) headers.set('ETag', r.etag)
    if (r.lastModified) headers.set('Last-Modified', r.lastModified)
    return new Response(r.text, { status: 200, headers })
  }
  const store = async () => {
    const r = await produce()
    if (r.text === undefined) return r
    const res = toResponse(r, 'MISS')
    await deps.cache.put(cacheKey, res.clone())
    return { res }
  }
  const finish = (res) => {
    const nm = notModified(request, res.headers)
    if (nm) return nm
    return request.method === 'HEAD' ? new Response(null, { status: 200, headers: res.headers }) : res
  }
  if (hit) {
    const age = Number(hit.headers.get('X-Rendered-At') ?? 0)
    if (now() - age > ttl * 1000) ctx.waitUntil(store().catch(() => undefined))
    const h = new Headers(hit.headers); h.set('X-Cache', 'HIT')
    h.set('Cache-Control', cacheControl) // Cache API 命中時 Cloudflare 會把 max-age 抬到瀏覽器快取 TTL（4 小時），這裡蓋回來
    return finish(new Response(hit.body, { status: hit.status, headers: h }))
  }
  const r = await store()
  if (r.res) return finish(r.res)
  if (r.redirectTo) return redirect(url.origin, 301, r.redirectTo)
  return nf(r.notFound)
}
