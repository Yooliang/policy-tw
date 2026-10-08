/**
 * 正見.tw 的 Worker（2026-09-23，docs/PLAN-edge-ssr.md 第 1 步）。
 *
 * 路由：
 *   /politician/:id、/policy/:id、/lineage/:id → 邊緣 SSR（dist-ssr/entry-server.js）＋ Cache API（10 分鐘，過期先回舊的背景重算）
 *     人物 id 是已合併的 → 301 到保留的那位；查無此人 → 404（不快取）。建置之後才新增的人物也是現場從資料庫渲染，不依賴預渲染
 *   /election/:id/:縣市、/election/:id/:縣市/:鄉鎮 → 代理到 web.app 的 ASCII 檔案路徑（見 region-path.js）；
 *   舊的 /election/:id?region=縣市&sub=鄉鎮、/election/:id/:縣市?sub=鄉鎮 → 301 到新網址
 *   其餘全部 → 反向代理到 policy-tw.web.app（原本 cloudflare/worker.js 的行為；預渲染頁、工具頁、靜態資源都在那）
 *   /politician/:id.md、/election/:屆/:縣市.md、/category/:分類.md、/data/** → Markdown 檢視（cloudflare/markdown.js；人物讀時產生，其餘讀預產快取表 data_md_cache）
 *   POST /__purge {paths:[...]}（帶 X-Purge-Secret）→ 清掉那些頁的快取（連同它們的 .md 版）
 *   /next、/report… 等協議端點名 → 307 轉到 Supabase functions（見 apiRedirect）
 *
 * 樣板：向 web.app 拿 /app.html（客戶端 bundle 的殼，含 assets 的 script／link），去掉 noindex，把 SSR 的 HTML、
 * head 與 __INITIAL_STATE__ 塞進去。SSR bundle 與 web.app 的客戶端 bundle 都由同一次 CI 從同一個 commit 建置。
 *
 * 部署：wrangler deploy（wrangler.toml）。回滾：把 SSR_ROUTES 清空重部署，就回到純代理。
 */

import { render, configureSsr, SUPABASE_PUBLIC, markdownDeps } from '../dist-ssr/entry-server.js'
import { readWorkerConfig } from './worker-config.js'
import { classifyRead } from './ai-reads.js'
import { handleMarkdown } from './markdown.js'
import { nonPageResponse } from './render-status.js'
import { stripShellHead } from './shell-head.js'
import { legacyElectionKeyRedirect, legacyRegionRedirect, regionUpstreamPath } from './region-path.js'

/**
 * 記「誰在讀」（2026-09-23）：AI／搜尋引擎／從 AI 服務點過來的人，背景加一，不拖慢回應、失敗不影響頁面。
 * 只記每日計數（代理、類別、頁種），不記網址與 IP。
 *
 * 2026-09-24：原本每讀一次就寫一次資料庫（每小時 1,400～1,600 次），是當晚 Disk IO 額度耗盡的成因之一。
 * 改成在這個 Worker 實例的記憶體裡累加，滿一分鐘（或累積 500 次）才批次寫一次 ai_read_hits。
 * 實例被回收時沒寫出去的會遺失——這是統計數字，少幾筆可以接受。
 */
const READ_FLUSH_MS = 60_000
const READ_FLUSH_MAX = 500
const pendingReads = new Map()
let pendingTotal = 0
let lastReadFlush = Date.now()

function countRead(request, ctx) {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') return
    const url = new URL(request.url)
    const hit = classifyRead(request.headers.get('User-Agent') || '', request.headers.get('Referer') || '', url.pathname)
    if (!hit || !SUPABASE_PUBLIC.url || !SUPABASE_PUBLIC.anonKey) return
    const key = `${hit.agent}|${hit.kind}|${hit.path_type}`
    pendingReads.set(key, (pendingReads.get(key) || 0) + 1)
    pendingTotal++
    const now = Date.now()
    if (now - lastReadFlush < READ_FLUSH_MS && pendingTotal < READ_FLUSH_MAX) return
    const rows = [...pendingReads.entries()].map(([k, n]) => {
      const [agent, kind, path_type] = k.split('|')
      return { agent, kind, path_type, n }
    })
    pendingReads.clear()
    pendingTotal = 0
    lastReadFlush = now
    ctx.waitUntil(
      fetch(`${SUPABASE_PUBLIC.url}/rest/v1/rpc/ai_read_hits`, {
        method: 'POST',
        headers: { apikey: SUPABASE_PUBLIC.anonKey, Authorization: `Bearer ${SUPABASE_PUBLIC.anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_rows: rows }),
      }).catch(() => undefined),
    )
  } catch { /* 記不成就算了 */ }
}

/** 預產快取表 data_md_cache 的一列（只用 anon 讀）；表還沒建（migration 還沒套）當作沒有 */
async function fetchCacheRow(key) {
  if (!SUPABASE_PUBLIC.url || !SUPABASE_PUBLIC.anonKey) throw new Error('沒有 Supabase 連線資訊')
  const r = await fetch(`${SUPABASE_PUBLIC.url}/rest/v1/data_md_cache?path=eq.${encodeURIComponent(key)}&select=body,meta,generated_at,changed_at,content_sha,row_count&limit=1`, {
    headers: { apikey: SUPABASE_PUBLIC.anonKey, Authorization: `Bearer ${SUPABASE_PUBLIC.anonKey}` },
  })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`data_md_cache ${r.status}`)
  const rows = await r.json()
  return rows[0] ?? null
}

/** 最新一屆的選舉網址那一段（排程腳本把矩陣存在 _matrix 那一列）；每個 isolate 記一分鐘 */
let latestSegmentAt = 0
let latestSegmentValue = null
async function latestSegment() {
  if (Date.now() - latestSegmentAt < 60_000) return latestSegmentValue
  const row = await fetchCacheRow('_matrix')
  let seg = null
  try { seg = row ? JSON.parse(row.body).election.segment : null } catch { seg = null }
  latestSegmentAt = Date.now()
  latestSegmentValue = seg
  return seg
}

function markdownWorkerDeps() {
  return { ...markdownDeps, fetchCacheRow, latestSegment, cache: caches.default }
}

// 上游網址與快取時間讀環境變數（wrangler.toml 的 [vars]，worker-config.js 給預設與範圍；2026-10-07）。每個請求開頭由 fetch() 重讀一次
let cfg = readWorkerConfig({})
// /lineage/:id：政策脈絡頁（#349，2026-10-06），跟政見頁一樣現場渲染、可被收錄（canonical 指正見.tw）
const SSR_ROUTES = [/^\/politician\/[^/]+\/?$/, /^\/policy\/[^/]+\/?$/, /^\/lineage\/[^/]+\/?$/]
/**
 * 協議端點打到網站網域上（2026-09-23：代理 kin／deepseek-flash 打 正見.tw/next?agent_name=…，拿到 404 後被前端導回首頁，
 * 它只看得到首頁內容、不知道錯在哪）。端點在 Supabase，不在網站上；這裡 307 轉過去（方法與 body 照留），回應本身也講清楚。
 * tasks／verify 同時是網站頁面，只有看起來是代理的請求（帶 agent_name 等參數、或非 GET）才轉。
 */
const API_BASE = 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1'
const API_ONLY = new Set(['next', 'report', 'contribute', 'ask', 'request-task', 'history', 'verifications', 'contribution-status', 'contributions-feed', 'policy-stance', 'question-stance', 'boost', 'apply', 'apply-verified', 'system-one'])
const API_ALSO_PAGE = new Set(['tasks', 'verify'])
const AGENT_PARAMS = ['agent_name', 'agent_tool', 'contribution_id', 'api_key']

function apiRedirect(request) {
  const url = new URL(request.url)
  // 也收 /functions/v1/<名稱>（W-Policy 實測：代理把 Supabase 的路徑接在網站網域後面）；帶這個前綴一定是要打端點
  const m = url.pathname.match(/^\/(functions\/v1\/)?([a-z-]+)\/?$/)
  if (!m) return null
  const name = m[2]
  const agentish = !!m[1] || request.method !== 'GET' && request.method !== 'HEAD' || AGENT_PARAMS.some((p) => url.searchParams.has(p))
  if (!API_ONLY.has(name) && !(API_ALSO_PAGE.has(name) && agentish)) return null
  const target = `${API_BASE}/${name}${url.search}`
  const body = JSON.stringify({
    success: false,
    error: 'wrong_host',
    message: `協議端點不在網站網域上。請改打 ${target}（端點根網址 ${API_BASE}，見 skill.md「端點根網址」）。這次已用 307 轉過去，但請把之後的請求都改成正確網址。`,
    endpoint: target,
  })
  return new Response(body, { status: 307, headers: { Location: target, 'Content-Type': 'application/json; charset=utf-8', 'X-Served-Via': 'cloudflare-worker', 'Cache-Control': 'no-store' } })
}

const DROP_REQUEST_HEADERS = ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'x-forwarded-proto', 'x-real-ip']

/** 客戶端殼：每個 isolate 抓一次、10 分鐘後重抓（部署後最多 10 分鐘拿到舊 assets 清單） */
let shellPromise = null
let shellAt = 0
async function loadShell() {
  if (!shellPromise || Date.now() - shellAt > 10 * 60 * 1000) {
    shellAt = Date.now()
    shellPromise = fetch(`${cfg.origin}/app.html`, { headers: { 'User-Agent': 'policy-tw-ssr' } })
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

function assemble(shell, r) {
  let html = shell
  if (r.htmlAttrs) html = html.replace('<html', `<html ${r.htmlAttrs}`)
  if (r.bodyAttrs) html = html.replace('<body', `<body ${r.bodyAttrs}`)
  // 殼裡的靜態 title／description／og:*／twitter:*（index.html 寫死的首頁版）要讓位給每頁的 head，不然爬蟲讀到第一個 <title> 就是首頁的（cloudflare/shell-head.js）
  if (r.headTags) html = stripShellHead(html)
  html = html.replace('</head>', `${r.headTags ?? ''}\n  </head>`)
  const state = `<script>window.__INITIAL_STATE__=${escapeState(JSON.stringify(r.state ?? {}))}</script>`
  html = html.replace('<div id="app"></div>', `<div id="app">${r.html}</div>\n${state}`)
  if (r.bodyTagsOpen) html = html.replace('<body>', `<body>${r.bodyTagsOpen}`)
  if (r.bodyTags) html = html.replace('</body>', `${r.bodyTags}</body>`)
  return html
}

async function proxy(request) {
  const incoming = new URL(request.url)
  // 縣市頁、鄉鎮頁：預渲染檔放在 ASCII 路徑（中文目錄在 Firebase 上比對不保證），只有 GET／HEAD 需要
  const upstreamPath = (request.method === 'GET' || request.method === 'HEAD') ? (regionUpstreamPath(incoming.pathname) ?? incoming.pathname) : incoming.pathname
  const target = new URL(upstreamPath + incoming.search, cfg.origin)
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
      const l = new URL(location, cfg.origin)
      if (l.host === cfg.originHost) { l.protocol = 'https:'; l.host = incoming.host; out.set('Location', l.toString()) }
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
    if (Date.now() - age > cfg.cacheTtlS * 1000) ctx.waitUntil(renderAndStore(path, url.origin, cacheKey, cache, '').catch(() => undefined))
    const h = new Headers(hit.headers); h.set('X-Cache', 'HIT')
    return new Response(hit.body, { status: hit.status, headers: h })
  }
  const res = await renderAndStore(path, url.origin, cacheKey, cache, url.search)
  return res
}

async function renderAndStore(path, origin, cacheKey, cache, search = '') {
  const [shell, r] = await Promise.all([loadShell(), render(path)])
  if (r.status === 'passthrough') return null
  // 301（已合併的人物 → 保留者）與 404 的組法在 render-status.js（#466）；兩者都不進快取
  const special = nonPageResponse(r, { shell, origin, search })
  if (special) {
    // 以前是 200 的頁現在變 301／404（人物剛被合併、被移除）：舊的快取不能再當 200 發
    await cache.delete(cacheKey).catch(() => undefined)
    return special
  }
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': `public, max-age=0, s-maxage=${cfg.staleTtlS}`,
    'X-Served-Via': 'cloudflare-worker-ssr',
    'X-Rendered-At': String(Date.now()),
    'X-Cache': 'MISS',
  })
  const body = assemble(shell, r)
  const res = new Response(body, { status: 200, headers })
  await cache.put(cacheKey, res.clone())
  return res
}

export default {
  async fetch(request, env, ctx) {
    cfg = readWorkerConfig(env)
    configureSsr({ baseTtlMs: cfg.baseTtlMs })
    const url = new URL(request.url)
    countRead(request, ctx)
    if (request.method === 'POST' && url.pathname === '/__purge') {
      if (!env.PURGE_SECRET || request.headers.get('X-Purge-Secret') !== env.PURGE_SECRET) return new Response('forbidden', { status: 403 })
      const body = await request.json().catch(() => ({}))
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 200) : []
      let n = 0
      for (const p of paths) {
        const clean = String(p).replace(/\/$/, '')
        // 人物頁、縣市頁的 Markdown 版（本頁網址加 .md）一併清掉
        for (const k of [clean, `${clean}.md`]) { if (await caches.default.delete(new Request(`${url.origin}${k}`, { method: 'GET' }))) n++ }
      }
      return new Response(JSON.stringify({ purged: n }), { headers: { 'Content-Type': 'application/json' } })
    }
    // Markdown 檢視（2026-10-07）：.md 一律在這裡收掉，不退回代理——代理會把 app.html 當成 200 回給想讀 Markdown 的 AI
    const md = await handleMarkdown(request, ctx, markdownWorkerDeps())
    if (md) return md
    const api = apiRedirect(request)
    if (api) return api
    // 縣市、鄉鎮原本放在查詢字串，搜尋引擎不當獨立頁；舊連結一律 301 到路徑版（縣市 2026-09-30、鄉鎮 2026-10-05）
    if (request.method === 'GET' || request.method === 'HEAD') {
      // 舊三屆的 election_key 寫法（/election/2022-11-26_local）→ 年份寫法（/election/2022）：三屆的正式網址不變、只有一個 canonical（#344 第二階段 A）
      const keyed = legacyElectionKeyRedirect(url.pathname, url.search)
      if (keyed) return new Response(null, { status: 301, headers: { Location: `${url.origin}${keyed}`, 'X-Served-Via': 'cloudflare-worker', 'Cache-Control': 'public, max-age=3600' } })
      const moved = legacyRegionRedirect(url.pathname, url.searchParams)
      if (moved) return new Response(null, { status: 301, headers: { Location: `${url.origin}${moved}`, 'X-Served-Via': 'cloudflare-worker', 'Cache-Control': 'public, max-age=3600' } })
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
