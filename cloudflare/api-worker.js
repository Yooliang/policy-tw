/**
 * api.hustings.net：兩站協議端點的固定網址（工作單 Yooliang/policy-ops#85，維護者 2026-10-11 同意）。
 *
 *   /tw/<名稱>  → https://<專案>.supabase.co/functions/v1/<名稱>      （正見）
 *   /jp/<名稱>  → https://<專案>.supabase.co/functions/v1/jp-<名稱>   （政策の系譜）
 *
 * 是轉送（proxy），不是轉址：方法、查詢字串、內文、標頭原樣送過去，回應原樣回來（含 CORS）。只轉白名單裡的名稱，其他 404。
 * Supabase 看到的來源會變成 Cloudflare，所以 Worker 另外帶兩個標頭：
 *   x-hustings-client-ip     真實來源 IP（cf-connecting-ip）
 *   x-hustings-proxy-secret  共用密鑰（wrangler secret HUSTINGS_PROXY_SECRET；Supabase secrets 同名同值）
 * 函式端只在密鑰對時才採信 x-hustings-client-ip（_shared/ip-network.ts 的 clientIpFrom），所以直接打 Supabase 偽造這兩個標頭沒有用。
 * 用戶端自己帶來的這兩個標頭一律先拿掉。密鑰不寫在程式碼裡（repo 公開）；沒設密鑰時照樣轉送、但不帶 IP 標頭（函式退回原本的來源判斷）。
 */

export const API_ORIGIN = 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1'
export const PROXY_SECRET_HEADER = 'x-hustings-proxy-secret'
export const PROXY_CLIENT_IP_HEADER = 'x-hustings-client-ip'

/** 正見的協議端點（跟 正見.tw Worker 的 API_ONLY／API_ALSO_PAGE 同一批，system-one 不對外） */
export const TW_FUNCTIONS = new Set([
  'next', 'report', 'contribute', 'verify', 'apply', 'apply-verified', 'ask', 'tasks', 'request-task', 'history', 'verifications',
  'contribution-status', 'contributions-feed', 'policy-stance', 'question-stance', 'boost', 'sources',
])
/** 日本站的協議端點（網址上不寫 jp- 前綴） */
export const JP_FUNCTIONS = new Set(['next', 'report', 'contributions-feed', 'history', 'boost'])

/** 網址 → 要轉去的 Supabase 網址；不認得回 null */
export function targetOf(url) {
  const m = url.pathname.match(/^\/(tw|jp)\/([a-z-]+)\/?$/)
  if (!m) return null
  const [, site, name] = m
  if (site === 'tw' && TW_FUNCTIONS.has(name)) return `${API_ORIGIN}/${name}${url.search}`
  if (site === 'jp' && JP_FUNCTIONS.has(name)) return `${API_ORIGIN}/jp-${name}${url.search}`
  return null
}

const DROP_REQUEST_HEADERS = ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'x-real-ip', PROXY_SECRET_HEADER, PROXY_CLIENT_IP_HEADER]

/** 組要送給 Supabase 的請求（純函式，測試直接呼叫） */
export function upstreamRequest(request, target, secret) {
  const headers = new Headers(request.headers)
  for (const h of DROP_REQUEST_HEADERS) headers.delete(h)
  const ip = request.headers.get('cf-connecting-ip')
  if (secret && ip) {
    headers.set(PROXY_CLIENT_IP_HEADER, ip)
    headers.set(PROXY_SECRET_HEADER, secret)
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  return new Request(target, { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' })
}

function notFound(url) {
  const body = JSON.stringify({
    success: false,
    error: 'not_found',
    message: `api.hustings.net 只轉協議端點：/tw/<端點>（正見）或 /jp/<端點>（政策の系譜）。${url.pathname} 不在清單裡。`,
    tw: [...TW_FUNCTIONS],
    jp: [...JP_FUNCTIONS],
  })
  return new Response(body, { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/__health') {
      return new Response(JSON.stringify({ ok: true, proxy_secret: !!(env && env.HUSTINGS_PROXY_SECRET) }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      })
    }
    const target = targetOf(url)
    if (!target) return notFound(url)
    const res = await fetch(upstreamRequest(request, target, env && env.HUSTINGS_PROXY_SECRET))
    const out = new Response(res.body, res)
    out.headers.set('X-Served-Via', 'api.hustings.net')
    return out
  },
}
