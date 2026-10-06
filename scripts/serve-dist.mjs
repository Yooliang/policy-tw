// 本機模擬 Firebase Hosting 行為來驗證 dist：cleanUrls、firebase.json rewrites、找不到就回 404.html（HTTP 404）。
// `vite preview` 無法模擬 rewrites 與 404.html 殼，所以另寫這支。
// 用法：node scripts/serve-dist.mjs [port]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacyElectionKeyRedirect, legacyRegionRedirect, regionUpstreamPath } from '../cloudflare/region-path.js'
import { compileRewrites, rewriteFor } from './firebase-rewrites.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 4180)
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'))
const rewrites = firebaseConfig.hosting.rewrites || []

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// firebase.json 的 rewrite（glob 與 regex 兩種）比對規則跟測試共用一份（scripts/firebase-rewrites.mjs）
const rewriteRules = compileRewrites(rewrites)

function safeJoin(urlPath) {
  const normalized = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '')
  return path.join(DIST, normalized)
}

function resolveFile(urlPath) {
  const candidates = [safeJoin(urlPath)]
  if (urlPath.endsWith('/')) candidates.push(safeJoin(`${urlPath}index.html`))
  else {
    candidates.push(safeJoin(`${urlPath}/index.html`))
    candidates.push(safeJoin(`${urlPath}.html`)) // cleanUrls
  }
  return candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile())
}

function send(res, status, file) {
  res.writeHead(status, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}

// 加 --no-worker 只模擬 Firebase；預設連正見.tw Worker 的縣市頁／鄉鎮頁規則一起模擬（ASCII 檔案路徑、舊 ?region=／?sub= 的 301）
const SIMULATE_WORKER = !process.argv.includes('--no-worker')

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (SIMULATE_WORKER) {
    const keyed = legacyElectionKeyRedirect(url.pathname, url.search)
    if (keyed) { res.writeHead(301, { Location: keyed }); return res.end() }
    const moved = legacyRegionRedirect(url.pathname, url.searchParams)
    if (moved) { res.writeHead(301, { Location: moved }); return res.end() }
  }
  const urlPath = (SIMULATE_WORKER && regionUpstreamPath(url.pathname)) || url.pathname
  const file = resolveFile(urlPath)
  if (file) return send(res, 200, file)
  const destination = rewriteFor(rewriteRules, urlPath)
  if (destination) return send(res, 200, path.join(DIST, destination))
  const notFound = path.join(DIST, '404.html')
  if (fs.existsSync(notFound)) return send(res, 404, notFound)
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
}).listen(PORT, () => console.log(`[serve-dist] http://localhost:${PORT}  (dist=${DIST})`))
