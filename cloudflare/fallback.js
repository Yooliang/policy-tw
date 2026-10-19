/**
 * 邊緣渲染的時間預算與退路（policy-ops#135，2026-10-19）。純函式、沒有 import，Deno 測試與 Worker 都能讀。
 *
 * 為什麼：長尾的人物頁、政見頁、.md 在快取沒命中時要現場打資料庫；資料庫慢的時候 Worker 一直等，
 * 等到 Cloudflare 閘道逾時就是 504（近 7 天約 14%、多半是美國爬蟲；Worker 例外 17,375 次）。
 * 現在每次現場抓取有時間預算（RENDER_BUDGET_MS），逾時或出錯照這個順序退：
 *   1. 快取裡還有舊的（Cache API，stale-while-revalidate 的過期那一份）→ 回舊的，X-SSR-Fallback: stale
 *   2. 沒有舊的 → 向 Firebase 拿預渲染頁／客戶端殼，X-SSR-Fallback: shell
 *   3. 連殼都拿不到 → 503＋Retry-After（不是 504/500），X-SSR-Fallback: unavailable
 * 退路的回應一律 Cache-Control: no-store，絕不寫進快取當新鮮的。
 */

/** 現場抓資料庫／上游的時間預算（毫秒）：比閘道逾時短，退路才有時間跑 */
export const RENDER_BUDGET_MS = 5000

/** 長尾頁（人物、政見、.md）的快取新鮮期（秒）：頁多、單頁流量低，命中率靠拉長；其餘頁維持 SSR_CACHE_TTL_S */
export const LONG_TAIL_TTL_S = 3600

/** 錯誤訊息放進標頭前只留可見 ASCII：標頭值含中文會讓 Headers.set 丟 TypeError，退路自己反而炸掉 */
export function headerSafe(v, max = 200) {
  return String(v && v.message ? v.message : v).replace(/[^\x20-\x7e]/g, '?').slice(0, max)
}

/** 退路回應的標頭名稱 */
export const FALLBACK_HEADER = 'X-SSR-Fallback'

export class BudgetExceeded extends Error {
  constructor(ms) {
    super(`budget exceeded ${ms}ms`)
    this.name = 'BudgetExceeded'
  }
}

/**
 * 在時間預算內跑 fn；逾時丟 BudgetExceeded（fn 本身不會被中斷，呼叫端要的話自己接 ctx.waitUntil 讓它跑完暖快取）。
 * fn 同步丟錯或回傳被拒絕的 promise 都會變成這邊的拒絕。
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
export function withBudget(fn, ms = RENDER_BUDGET_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BudgetExceeded(ms)), ms)
    let p
    try { p = Promise.resolve(fn()) } catch (e) { clearTimeout(timer); reject(e); return }
    p.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

/** 長尾頁：/politician/<id>、/policy/<id>（含 .md）以及任何 .md */
export function isLongTailPath(pathname) {
  const p = String(pathname ?? '')
  return /^\/(politician|policy)\/[^/]+\/?$/.test(p) || /\.md$/i.test(p)
}

/** 這個路徑的快取新鮮期（秒） */
export function cacheTtlForPath(pathname, cfg) {
  return isLongTailPath(pathname) ? LONG_TAIL_TTL_S : cfg.cacheTtlS
}

/**
 * 這個路徑存進快取的 s-maxage（秒）。長尾頁新鮮期拉到 1 小時，若 s-maxage 還是 1 小時，
 * 一過新鮮期條目就消失，「回舊的」的窗口等於零；所以至少留到新鮮期的兩倍。
 */
export function sMaxAgeForPath(pathname, cfg) {
  return Math.max(cfg.staleTtlS, isLongTailPath(pathname) ? LONG_TAIL_TTL_S * 2 : 0)
}

/** 退路回應：換上 X-SSR-Fallback 與 no-store（原本的 Cache-Control、X-Cache 作廢） */
export function markFallback(res, kind, error) {
  // 已經是最後一道的 503 就不要改標成 shell／stale
  if (res.headers.get(FALLBACK_HEADER) === 'unavailable') return res
  const h = new Headers(res.headers)
  h.set(FALLBACK_HEADER, kind)
  h.set('Cache-Control', 'no-store')
  h.set('X-Cache', 'FALLBACK')
  if (error) h.set('X-SSR-Error', headerSafe(error))
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}

/** 連殼都拿不到的最後一道：503＋Retry-After，不是 504/500 */
export function unavailableResponse(error) {
  return markFallback(new Response('暫時讀不到，請稍後重試。', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30', 'X-Served-Via': 'cloudflare-worker-ssr' },
  }), 'unavailable', error)
}

/**
 * 現場產生一頁，逾時或出錯就退。
 * @param {object} o
 * @param {() => Promise<Response|null>} o.render 現場產生（回 null＝不歸這裡管，原樣回 null）
 * @param {(() => Promise<Response|null|undefined>) | null} [o.stale] 取快取裡舊的那一份；沒有就回 null／undefined
 * @param {(() => Promise<Response>) | null} [o.shell] 向上游拿預渲染頁／殼
 * @param {number} [o.budgetMs]
 * @returns {Promise<Response|null>}
 */
export async function renderOrFallback({ render, stale = null, shell = null, budgetMs = RENDER_BUDGET_MS }) {
  try {
    return await withBudget(render, budgetMs)
  } catch (e) {
    if (stale) {
      try {
        const old = await stale()
        if (old) return markFallback(old, 'stale', e)
      } catch { /* 取舊的也失敗就往下退 */ }
    }
    if (shell) {
      try { return markFallback(await withBudget(shell, budgetMs), 'shell', e) } catch { /* 往下 */ }
    }
    return unavailableResponse(e)
  }
}
