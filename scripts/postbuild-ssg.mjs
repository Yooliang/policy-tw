// 建置後：產 sitemap.xml、驗證預渲染結果不是空殼。任何一項不過就讓 build 紅。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const SITE_URL = 'https://policy-tw.web.app'
const SHELL_FILES = ['404.html', 'app.html']
/** <main> 內純文字少於這個長度視為空殼（村里長頁只有姓名／政黨／選區，本來就短） */
const MIN_MAIN_TEXT = 120
const MAIN_RE = /<main[^>]*>([\s\S]*?)<\/main>/

function walkHtml(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkHtml(full, acc)
    else if (entry.name.endsWith('.html')) acc.push(full)
  }
  return acc
}

function routeOf(file) {
  const rel = path.relative(DIST, file).split(path.sep).join('/')
  if (rel === 'index.html') return '/'
  return `/${rel.replace(/\/index\.html$/, '')}`
}

function mainHtml(html) {
  return (html.match(MAIN_RE) || [])[1] || ''
}

function textOf(fragment) {
  return fragment.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

function taipeiDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

const failures = []
const fail = (msg) => failures.push(msg)

const allHtml = walkHtml(DIST)
const pageFiles = allHtml.filter((f) => path.basename(f) === 'index.html')
const routes = pageFiles.map(routeOf).sort()

// 1. 殼
for (const shell of SHELL_FILES) {
  const p = path.join(DIST, shell)
  if (!fs.existsSync(p)) { fail(`${shell} 不存在`); continue }
  const html = fs.readFileSync(p, 'utf8')
  if (!html.includes('<div id="app"></div>')) fail(`${shell} 不是空殼（#app 不是空的）`)
  if (!html.includes('name="robots" content="noindex"')) fail(`${shell} 缺 noindex`)
  if (!/<script[^>]+type="module"[^>]+src=/.test(html)) fail(`${shell} 缺入口 script`)
}

// 2. 全部 HTML 都不能再引用 Tailwind CDN；預渲染頁不能是空殼
const emptyPages = []
const cdnPages = []
const noStatePages = []
for (const file of allHtml) {
  const html = fs.readFileSync(file, 'utf8')
  if (html.includes('cdn.tailwindcss.com')) cdnPages.push(routeOf(file))
  if (path.basename(file) !== 'index.html') continue
  if (!html.includes('data-server-rendered="true"')) { emptyPages.push(routeOf(file)); continue }
  const main = mainHtml(html)
  if (textOf(main).length < MIN_MAIN_TEXT || !/<h1[\s>]/.test(main)) emptyPages.push(routeOf(file))
  if (!html.includes('window.__INITIAL_STATE__')) noStatePages.push(routeOf(file))
}
if (cdnPages.length) fail(`${cdnPages.length} 頁仍含 cdn.tailwindcss.com，例：${cdnPages.slice(0, 3).join(', ')}`)
if (emptyPages.length) fail(`${emptyPages.length} 頁預渲染是空殼（<main> 文字 < ${MIN_MAIN_TEXT} 或沒有 <h1>），例：${emptyPages.slice(0, 5).join(', ')}`)

// 3. 抽查：首頁／一位政治人物／一條政見要有 <h1> 與真實文字
function spotCheck(route, label) {
  const file = route === '/' ? path.join(DIST, 'index.html') : path.join(DIST, route.slice(1), 'index.html')
  if (!fs.existsSync(file)) { fail(`${label} ${route} 檔案不存在`); return null }
  const html = fs.readFileSync(file, 'utf8')
  const h1Text = textOf((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '')
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || ''
  if (!h1Text) fail(`${label} ${route} 沒有 <h1> 文字`)
  if (!desc) fail(`${label} ${route} 沒有 meta description`)
  const state = html.match(/window\.__INITIAL_STATE__=("[\s\S]*?")<\/script>/)
  return {
    route,
    title,
    h1: h1Text.slice(0, 60),
    descLen: desc.length,
    mainTextLen: textOf(mainHtml(html)).length,
    bytes: Buffer.byteLength(html),
    stateKb: state ? Math.round(Buffer.byteLength(state[1]) / 1024) : 0,
  }
}
const samplePolitician = routes.find((r) => r.startsWith('/politician/'))
const samplePolicy = routes.find((r) => r.startsWith('/policy/'))
const samples = [
  spotCheck('/', '首頁'),
  samplePolitician ? spotCheck(samplePolitician, '政治人物頁') : (fail('沒有任何 /politician/ 頁'), null),
  samplePolicy ? spotCheck(samplePolicy, '政見頁') : (fail('沒有任何 /policy/ 頁'), null),
].filter(Boolean)

// 4. 政治人物頁的 initialState 不該把整包政見塞進去（控制頁重）
const politicianSample = samples.find((s) => s.route.startsWith('/politician/'))
if (politicianSample && politicianSample.stateKb > 200) fail(`政治人物頁 initialState 過大：${politicianSample.stateKb} KB`)

// 5. sitemap
const lastmod = taipeiDate()
const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...routes.map((r) => `  <url><loc>${SITE_URL}${r}</loc><lastmod>${lastmod}</lastmod></url>`),
  '</urlset>',
  '',
].join('\n')
fs.writeFileSync(path.join(DIST, 'sitemap.xml'), xml, 'utf8')

const byPrefix = routes.reduce((acc, r) => {
  const key = r === '/' ? '/' : `/${r.split('/')[1]}`
  acc[key] = (acc[key] || 0) + 1
  return acc
}, {})

const summary = {
  htmlFiles: allHtml.length,
  prerenderedPages: pageFiles.length,
  sitemapUrls: routes.length,
  byPrefix,
  pagesWithoutInitialState: noStatePages.length,
  samples,
  failures,
}
console.log('[postbuild-ssg] ' + JSON.stringify(summary, null, 2))

if (failures.length) {
  console.error(`[postbuild-ssg] 驗證失敗 ${failures.length} 項`)
  process.exit(1)
}
