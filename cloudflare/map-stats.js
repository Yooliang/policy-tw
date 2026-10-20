/**
 * GET /api/map-stats?election=2026&level=county|town|village|meta&parent=<上一層代碼>（參選地圖，#680）。
 *
 * 地圖的人數資料（資料庫函式 candidacy_map，讀預先算好的統計表）經過 Worker、在邊緣快取：
 * 回應帶 Cache-Control: public, max-age=60, s-maxage=300，並用 Cloudflare Cache API 存約 5 分鐘（統計表本身每 10 分鐘才重算一次）。
 * 所以不用等開票夜、也不用每個人都打一次資料庫：同一個（屆別、層級、上一層代碼）五分鐘內只會打一次 Supabase。
 *
 *   level=county                 縣市（parent 可省）
 *   level=town                   鄉鎮市區（parent 可省＝全部；或縣市代碼）
 *   level=village                村里，一定要帶 parent（鄉鎮市區代碼）；整層 7,781 列超過 PostgREST 的 1,000 列上限
 *   level=meta                   統計時間：[{ computed_at }]（統計表全國那一列），parent 不用
 *
 * 回應內容與 RPC candidacy_map 的回傳列相同（JSON 陣列），前端失敗時直接退回呼叫 Supabase RPC。
 * 帶 CORS（Access-Control-Allow-Origin: *）：policy-tw.web.app 與本機開發也能打正見.tw 的這個路徑。
 */
export const MAP_STATS_PATH = '/api/map-stats'
export const MAP_STATS_CACHE_CONTROL = 'public, max-age=60, s-maxage=300'
const LEVELS = new Set(['county', 'town', 'village', 'meta'])
const UPSTREAM_TIMEOUT_MS = 8000

/** @param {URLSearchParams} params @returns {{ election: number, level: string, parent: string | null } | null} */
export function parseMapStatsQuery(params) {
  const election = Number(params.get('election') ?? '')
  const level = params.get('level') ?? ''
  const parent = params.get('parent') ?? ''
  if (!Number.isInteger(election) || election < 1 || election > 99999) return null
  if (!LEVELS.has(level)) return null
  if (!/^\d{0,11}$/.test(parent)) return null
  if (level === 'village' && parent === '') return null
  return { election, level, parent: level === 'meta' ? null : parent || null }
}

/** 快取鍵：參數正規化（順序、多餘的參數都不影響），同一份資料只有一個鍵 */
export function mapStatsCacheKey(origin, q) {
  return new Request(`${origin}${MAP_STATS_PATH}?election=${q.election}&level=${q.level}&parent=${q.parent ?? ''}`, { method: 'GET' })
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, 'X-Served-Via': 'cloudflare-worker', ...extra } })

/**
 * @param {Request} request
 * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
 * @param {{ supabaseUrl: string, anonKey: string, cache: { match(r: Request): Promise<Response | undefined>, put(r: Request, res: Response): Promise<void> }, fetchFn?: typeof fetch }} deps
 */
export async function handleMapStats(request, ctx, deps) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405, { 'Cache-Control': 'no-store', Allow: 'GET, HEAD, OPTIONS' })
  const url = new URL(request.url)
  const q = parseMapStatsQuery(url.searchParams)
  if (!q) return json({ error: 'bad_request' }, 400, { 'Cache-Control': 'no-store' })

  const key = mapStatsCacheKey(url.origin, q)
  const hit = await deps.cache.match(key).catch(() => undefined)
  if (hit) {
    // 命中的回應會被快取層改寫 Cache-Control：重設成跟第一次一樣
    const h = new Headers(hit.headers)
    h.set('X-Cache', 'HIT')
    h.set('Cache-Control', MAP_STATS_CACHE_CONTROL)
    return new Response(request.method === 'HEAD' ? null : hit.body, { status: hit.status, headers: h })
  }

  if (!deps.supabaseUrl || !deps.anonKey) return json({ error: 'no_upstream_config' }, 503, { 'Cache-Control': 'no-store' })
  const doFetch = deps.fetchFn ?? fetch
  const headers = { apikey: deps.anonKey, Authorization: `Bearer ${deps.anonKey}` }
  let upstream
  try {
    if (q.level === 'meta') {
      upstream = await doFetch(`${deps.supabaseUrl}/rest/v1/candidacy_map_stats?select=computed_at&election_id=eq.${q.election}&scope=eq.nation&order=computed_at.desc&limit=1`, {
        headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } else {
      upstream = await doFetch(`${deps.supabaseUrl}/rest/v1/rpc/candidacy_map`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_election_id: q.election, p_level: q.level, ...(q.parent ? { p_parent: q.parent } : {}) }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    }
  } catch {
    return json({ error: 'upstream_unreachable' }, 502, { 'Cache-Control': 'no-store' })
  }
  let rows = null
  if (upstream.ok) rows = await upstream.json().catch(() => null)
  // 失敗、或不是陣列（錯誤物件）都不快取，前端會退回直接打 Supabase
  if (!Array.isArray(rows)) return json({ error: 'upstream_failed', status: upstream.status }, 502, { 'Cache-Control': 'no-store' })

  const res = json(rows, 200, { 'Cache-Control': MAP_STATS_CACHE_CONTROL, 'X-Cache': 'MISS' })
  // 寫快取失敗（配額）不該讓已經拿到的資料變成錯誤
  ctx.waitUntil(deps.cache.put(key, res.clone()).catch(() => undefined))
  return request.method === 'HEAD' ? new Response(null, { status: 200, headers: res.headers }) : res
}
