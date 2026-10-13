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
 *   /tw/rest/v1/<表或視圖>?…  → https://<專案>.supabase.co/rest/v1/<表或視圖>?…  （正見的公開唯讀 REST，skill.md §7）
 *     只收 GET／HEAD／OPTIONS（其他 405）；沒帶 apikey 就補公開的 anon key（skill.md 原本就公開這把），
 *     Accept-Profile／Content-Profile 一律拿掉，只讀得到 public schema；不帶 IP 與密鑰標頭（PostgREST 用不到）。
 * 函式端只在密鑰對時才採信 x-hustings-client-ip（_shared/ip-network.ts 的 clientIpFrom），所以直接打 Supabase 偽造這兩個標頭沒有用。
 * 用戶端自己帶來的這兩個標頭一律先拿掉。密鑰不寫在程式碼裡（repo 公開）；沒設密鑰時照樣轉送、但不帶 IP 標頭（函式退回原本的來源判斷）。
 */

export const API_ORIGIN = 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1'
export const REST_ORIGIN = 'https://wiiqoaytpqvegtknlbue.supabase.co/rest/v1'
/** 公開的 anon key（RLS 只給讀；skill.md、網站前端本來就公開這把，不是密鑰） */
export const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpaXFvYXl0cHF2ZWd0a25sYnVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1OTA5MjQsImV4cCI6MjA4NTE2NjkyNH0.2YYUBQd4t3HBP6bjO8LDo-SR4pRpcYl4iTCbz1MCRMc'
export const REST_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
export const PROXY_SECRET_HEADER = 'x-hustings-proxy-secret'
export const PROXY_CLIENT_IP_HEADER = 'x-hustings-client-ip'

/** 正見的協議端點（跟 正見.tw Worker 的 API_ONLY／API_ALSO_PAGE 同一批，system-one 不對外） */
export const TW_FUNCTIONS = new Set([
  'next', 'report', 'contribute', 'verify', 'apply', 'apply-verified', 'ask', 'tasks', 'request-task', 'history', 'verifications',
  'contribution-status', 'contributions-feed', 'policy-stance', 'question-stance', 'boost', 'sources',
])
/** 日本站的協議端點（網址上不寫 jp- 前綴） */
export const JP_FUNCTIONS = new Set(['next', 'report', 'contributions-feed', 'history', 'boost'])

/** /tw/rest/v1/<名稱> → 公開唯讀 REST 網址；不是這個形狀回 null（名稱只收小寫英數與底線，一層） */
export function restTargetOf(url) {
  const m = url.pathname.match(/^\/tw\/rest\/v1\/([a-z0-9_]+)\/?$/)
  return m ? `${REST_ORIGIN}/${m[1]}${url.search}` : null
}

/** 組要送給 PostgREST 的請求：拿掉來源類標頭與 schema 切換標頭，沒帶 apikey 就補 anon key */
export function restUpstreamRequest(request, target) {
  const headers = new Headers(request.headers)
  for (const h of [...DROP_REQUEST_HEADERS, 'accept-profile', 'content-profile']) headers.delete(h)
  if (!headers.get('apikey')) {
    headers.set('apikey', ANON_KEY)
    if (!headers.get('authorization')) headers.set('authorization', `Bearer ${ANON_KEY}`)
  }
  return new Request(target, { method: request.method, headers, redirect: 'manual' })
}

/** 網址 → 要轉去的 Supabase 網址；不認得回 null */
export function targetOf(url) {
  const m = url.pathname.match(/^\/(tw|jp)\/([a-z-]+)\/?$/)
  if (!m) return null
  const [, site, name] = m
  if (site === 'tw' && TW_FUNCTIONS.has(name)) return `${API_ORIGIN}/${name}${url.search}`
  if (site === 'jp' && JP_FUNCTIONS.has(name)) return `${API_ORIGIN}/jp-${name}${url.search}`
  return null
}

// 用戶端可以自己帶的來源類標頭一律拿掉：Cloudflare 會把真實 IP「附加」在用戶帶的 x-forwarded-for 後面，
// 函式退回讀 XFF 第一個值時（密鑰沒設、太短、或兩邊對不上），用戶就能自選網段（主線審查 #580）。XFF 由下面重設成 cf-connecting-ip。
const DROP_REQUEST_HEADERS = [
  'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'x-real-ip',
  'x-forwarded-for', 'forwarded', 'true-client-ip', 'x-forwarded-host', 'x-forwarded-proto',
  PROXY_SECRET_HEADER, PROXY_CLIENT_IP_HEADER,
]

/** 組要送給 Supabase 的請求（純函式，測試直接呼叫） */
export function upstreamRequest(request, target, secret) {
  const headers = new Headers(request.headers)
  for (const h of DROP_REQUEST_HEADERS) headers.delete(h)
  const ip = (request.headers.get('cf-connecting-ip') || '').trim()
  const key = (secret || '').trim()
  if (ip) headers.set('x-forwarded-for', ip)
  if (key && ip) {
    headers.set(PROXY_CLIENT_IP_HEADER, ip)
    headers.set(PROXY_SECRET_HEADER, key)
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  return new Request(target, { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' })
}

function notFound(url) {
  const body = JSON.stringify({
    success: false,
    error: 'not_found',
    message: `api.hustings.net 只轉協議端點：/tw/<端點>（正見）、/jp/<端點>（政策の系譜）與正見的唯讀 REST /tw/rest/v1/<表>。${url.pathname} 不在清單裡。`,
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
    const restTarget = restTargetOf(url)
    if (restTarget) {
      if (!REST_METHODS.has(request.method)) {
        return new Response(JSON.stringify({ success: false, error: 'method_not_allowed', message: '/tw/rest/v1 只能讀（GET）；寫入一律走協議端點 /tw/report 等' }), {
          status: 405, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', Allow: 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' },
        })
      }
      const res = await fetch(restUpstreamRequest(request, restTarget))
      const out = new Response(res.body, res)
      out.headers.set('X-Served-Via', 'api.hustings.net')
      return out
    }
    const target = targetOf(url)
    if (!target) return notFound(url)
    const res = await fetch(upstreamRequest(request, target, env && env.HUSTINGS_PROXY_SECRET))
    const out = new Response(res.body, res)
    out.headers.set('X-Served-Via', 'api.hustings.net')
    return out
  },
}
