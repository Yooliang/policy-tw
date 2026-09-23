/**
 * 正見.tw 的 Worker（2026-09-23，docs/PLAN-edge-ssr.md 第 1 步）。
 *
 * 路由：
 *   /politician/:id、/policy/:id → 邊緣 SSR（dist-ssr/entry-server.js）＋ Cache API（10 分鐘，過期先回舊的背景重算）
 *   其餘全部 → 反向代理到 policy-tw.web.app（原本 cloudflare/worker.js 的行為；預渲染頁、工具頁、靜態資源都在那）
 *   POST /__purge {paths:[...]}（帶 X-Purge-Secret）→ 清掉那些頁的快取
 *
 * 樣板：向 web.app 拿 /app.html（客戶端 bundle 的殼，含 assets 的 script／link），去掉 noindex，把 SSR 的 HTML、
 * head 與 __INITIAL_STATE__ 塞進去。SSR bundle 與 web.app 的客戶端 bundle 都由同一次 CI 從同一個 commit 建置。
 *
 * 部署：wrangler deploy（wrangler.toml）。回滾：把 SSR_ROUTES 清空重部署，就回到純代理。
 */

import { render } from '../dist-ssr/entry-server.js'

const ORIGIN = 'https://policy-tw.web.app'
const ORIGIN_HOST = 'policy-tw.web.app'
const SSR_ROUTES = [/^\/politician\/[^/]+\/?$/, /^\/policy\/[^/]+\/?$/]
const CACHE_TTL_S = 600
const STALE_TTL_S = 3600
const DROP_REQUEST_HEADERS = ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'x-forwarded-proto', 'x-real-ip']

/** 客戶端殼：每個 isolate 抓一次、10 分鐘後重抓（部署後最多 10 分鐘拿到舊 assets 清單） */
let shellPromise = null
let shellAt = 0
async function loadShell() {
  if (!shellPromise || Date.now() - shellAt > 10 * 60 * 1000) {
    shellAt = Date.now()
    shellPromise = fetch(`${ORIGIN}/app.html`, { headers: { 'User-Agent': 'policy-tw-ssr' } })
      .then((r) => { if (!r.ok) throw new Error(`shell ${r.status}`); return r.text() })
      .then((html) => html.replace(/\s*<meta name="robots" content="noindex">/, ''))
      .catch((e) => { shellPromise = null; throw e })
  }
  return shellPromise
}

function escapeState(json) {
  // 跟 vite-ssg 一樣：字串化兩次，客戶端 JSON.parse；</script> 要拆開
  return JSON.stringify(json).replace(/<\/script/gi, '<\\/script')
}

/** 殼裡的靜態 title／description／og:*（index.html 寫死的首頁版）要讓位給每頁的 head，不然爬蟲讀到第一個 <title> 就是首頁的 */
const SHELL_HEAD_OVERRIDES = [
  /<title>[^<]*<\/title>\s*/i,
  /<meta name="description"[^>]*>\s*/i,
  /<meta property="og:(title|description|url|type|site_name)"[^>]*>\s*/gi,
  /<meta name="viewport"[^>]*>\s*/i,
]

function assemble(shell, r) {
  let html = shell
  if (r.htmlAttrs) html = html.replace('<html', `<html ${r.htmlAttrs}`)
  if (r.bodyAttrs) html = html.replace('<body', `<body ${r.bodyAttrs}`)
  if (r.headTags) for (const re of SHELL_HEAD_OVERRIDES) html = html.replace(re, '')
  html = html.replace('</head>', `${r.headTags ?? ''}\n  </head>`)
  const state = `<script>window.__INITIAL_STATE__=${escapeState(JSON.stringify(r.state ?? {}))}</script>`
  html = html.replace('<div id="app"></div>', `<div id="app">${r.html}</div>\n${state}`)
  if (r.bodyTagsOpen) html = html.replace('<body>', `<body>${r.bodyTagsOpen}`)
  if (r.bodyTags) html = html.replace('</body>', `${r.bodyTags}</body>`)
  return html
}

async function proxy(request) {
  const incoming = new URL(request.url)
  const target = new URL(incoming.pathname + incoming.search, ORIGIN)
  const headers = new Headers(request.headers)
  for (const h of DROP_REQUEST_HEADERS) headers.delete(h)
  headers.set('X-Forwarded-Host', incoming.host)
  headers.set('X-Forwarded-Proto', 'https')
  const hasBody = !['GET', 'HEAD'].includes(request.method)
  const upstream = await fetch(target.toString(), { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' })
  const out = new Headers(upstream.headers)
  const location = out.get('Location')
  if (location) {
    try {
      const l = new URL(location, ORIGIN)
      if (l.host === ORIGIN_HOST) { l.protocol = 'https:'; l.host = incoming.host; out.set('Location', l.toString()) }
    } catch { /* 原樣 */ }
  }
  out.set('X-Served-Via', 'cloudflare-worker')
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out })
}

async function renderPage(request, ctx) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '') || '/'
  const cache = caches.default
  const cacheKey = new Request(`${url.origin}${path}`, { method: 'GET' })
  const hit = await cache.match(cacheKey)
  if (hit) {
    const age = Number(hit.headers.get('X-Rendered-At') ?? 0)
    if (Date.now() - age > CACHE_TTL_S * 1000) ctx.waitUntil(renderAndStore(path, url.origin, cacheKey, cache).catch(() => undefined))
    const h = new Headers(hit.headers); h.set('X-Cache', 'HIT')
    return new Response(hit.body, { status: hit.status, headers: h })
  }
  const res = await renderAndStore(path, url.origin, cacheKey, cache)
  return res
}

async function renderAndStore(path, origin, cacheKey, cache) {
  const [shell, r] = await Promise.all([loadShell(), render(path)])
  if (r.status === 'passthrough') return null
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': `public, max-age=0, s-maxage=${STALE_TTL_S}`,
    'X-Served-Via': 'cloudflare-worker-ssr',
    'X-Rendered-At': String(Date.now()),
    'X-Cache': 'MISS',
  })
  if (r.status === 404) {
    const body = shell.replace('<div id="app"></div>', '<div id="app"></div><script>window.__INITIAL_STATE__="{}"</script>')
    return new Response(body, { status: 404, headers })
  }
  const body = assemble(shell, r)
  const res = new Response(body, { status: 200, headers })
  await cache.put(cacheKey, res.clone())
  return res
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/__purge') {
      if (!env.PURGE_SECRET || request.headers.get('X-Purge-Secret') !== env.PURGE_SECRET) return new Response('forbidden', { status: 403 })
      const body = await request.json().catch(() => ({}))
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 200) : []
      let n = 0
      for (const p of paths) { if (await caches.default.delete(new Request(`${url.origin}${String(p).replace(/\/$/, '')}`, { method: 'GET' }))) n++ }
      return new Response(JSON.stringify({ purged: n }), { headers: { 'Content-Type': 'application/json' } })
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && SSR_ROUTES.some((re) => re.test(url.pathname)) && !url.searchParams.has('__proxy')) {
      try {
        const res = await renderPage(request, ctx)
        if (res) return res
      } catch (e) {
        // SSR 壞了就退回代理（預渲染頁還在），並留痕跡
        const res = await proxy(request)
        const h = new Headers(res.headers); h.set('X-SSR-Error', String(e && e.message ? e.message : e).slice(0, 200))
        return new Response(res.body, { status: res.status, headers: h })
      }
    }
    return proxy(request)
  },
}
