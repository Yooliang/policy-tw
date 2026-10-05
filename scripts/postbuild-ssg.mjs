// 建置後：產 sitemap（索引＋按內容拆的三份）、驗證預渲染結果不是空殼。任何一項不過就讓 build 紅。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REGION_DIR, regionFilePath, regionPublicPathOfFile, townshipFilePath } from '../cloudflare/region-path.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const SITE_URL = 'https://xn--2lw665d.tw' // 2026-09-22 自有網域 正見.tw；跟 composables/usePageHead.ts 同步
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

const REGION_FILE_RE = new RegExp(`^/election/(\\d+)/${REGION_DIR}/([0-9a-f]+)$`)
const TOWNSHIP_FILE_RE = new RegExp(`^/election/(\\d+)/${REGION_DIR}/([0-9a-f]+)/([0-9a-f]+)$`)

/** dist 裡的檔案 → 不含 index.html 的路徑（縣市頁、鄉鎮頁是 ASCII 檔案路徑） */
function fileRoute(file) {
  const rel = path.relative(DIST, file).split(path.sep).join('/')
  if (rel === 'index.html') return '/'
  return `/${rel.replace(/\/index\.html$/, '')}`
}

function routeOf(file) {
  const route = fileRoute(file)
  // 縣市頁、鄉鎮頁的檔案在 ASCII 路徑，對外網址是中文（percent-encoded）
  return regionPublicPathOfFile(route) ?? route
}

function decodeSegment(name) {
  try { return decodeURIComponent(name) } catch { return name }
}

const isNonAscii = (text) => /[^\x00-\x7f]/.test(text)

/**
 * 縣市頁（2026-09-30）與鄉鎮頁（2026-10-05）：vite-ssg 照路由寫在
 *   dist/election/<屆>/<中文縣市>/index.html、dist/election/<屆>/<中文縣市>/<中文鄉鎮>/index.html，
 * 搬到 ASCII 路徑 dist/election/<屆>/_r/<縣市十六進位>/index.html、…/_r/<縣市十六進位>/<鄉鎮十六進位>/index.html
 * （原因見 cloudflare/region-path.js）。鄉鎮頁在縣市目錄底下，要先搬走才能刪縣市的中文目錄。
 */
function relocateRegionPages() {
  const electionDir = path.join(DIST, 'election')
  const moved = { region: 0, township: 0 }
  if (!fs.existsSync(electionDir)) return moved
  const move = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
  }
  for (const year of fs.readdirSync(electionDir, { withFileTypes: true })) {
    if (!year.isDirectory()) continue
    const yearDir = path.join(electionDir, year.name)
    for (const entry of fs.readdirSync(yearDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === REGION_DIR) continue
      const region = decodeSegment(entry.name)
      if (!isNonAscii(region)) continue
      const regionDir = path.join(yearDir, entry.name)
      for (const sub of fs.readdirSync(regionDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        const township = decodeSegment(sub.name)
        const from = path.join(regionDir, sub.name, 'index.html')
        if (!isNonAscii(township) || !fs.existsSync(from)) continue
        move(from, path.join(DIST, townshipFilePath(year.name, region, township).slice(1), 'index.html'))
        moved.township++
      }
      const from = path.join(regionDir, 'index.html')
      if (fs.existsSync(from)) {
        move(from, path.join(DIST, regionFilePath(year.name, region).slice(1), 'index.html'))
        moved.region++
      }
      // 只剩空目錄（或沒搬的東西——那代表路由長相不對，留著讓下面的檢查看得到）
      if (walkHtml(regionDir).length === 0) fs.rmSync(regionDir, { recursive: true, force: true })
    }
  }
  return moved
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

const relocatedRegionPages = relocateRegionPages()
const allHtml = walkHtml(DIST)
const pageFiles = allHtml.filter((f) => path.basename(f) === 'index.html')
const routes = pageFiles.map(routeOf).sort()

// 邊緣渲染頁（2026-09-24）：政治人物頁、政見頁不預渲染，由正見.tw 的 Worker 現場產生；
// 清單由 lib/ssg/server-data.ts 寫在 dist/.edge-routes.json，這裡讀來產網站地圖，讀完刪掉（不部署出去）
const EDGE_FILE = path.join(DIST, '.edge-routes.json')
const edgeRoutes = fs.existsSync(EDGE_FILE) ? JSON.parse(fs.readFileSync(EDGE_FILE, 'utf8')) : []
if (fs.existsSync(EDGE_FILE)) fs.unlinkSync(EDGE_FILE)
const edgeMode = edgeRoutes.length > 0

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
// 邊緣渲染模式下這兩類不在 dist 裡（線上由 Worker 產生、CI 部署 Worker 前後有另外的檢查），只要求清單不是空的
if (edgeMode) {
  if (!edgeRoutes.some((r) => r.startsWith('/politician/'))) fail('邊緣渲染清單裡沒有任何 /politician/ 頁')
  if (!edgeRoutes.some((r) => r.startsWith('/policy/'))) fail('邊緣渲染清單裡沒有任何 /policy/ 頁')
}
const samples = [
  spotCheck('/', '首頁'),
  samplePolitician ? spotCheck(samplePolitician, '政治人物頁') : (edgeMode ? null : (fail('沒有任何 /politician/ 頁'), null)),
  samplePolicy ? spotCheck(samplePolicy, '政見頁') : (edgeMode ? null : (fail('沒有任何 /policy/ 頁'), null)),
].filter(Boolean)

// 3b. 縣市頁（2026-09-30）與鄉鎮頁（2026-10-05）：每頁都要有候選人連結、<title> 有地名、canonical 是自己（正見.tw）；
//     單頁太大要看見。鄉鎮頁也要有通往其他鄉鎮的連結（右側鄉鎮市區），爬蟲才走得到兄弟頁。
const REGION_PAGE_WARN_BYTES = 3 * 1024 * 1024
function describeRegionPage(f) {
  const html = fs.readFileSync(f, 'utf8')
  const route = routeOf(f)
  const main = mainHtml(html)
  return {
    route: decodeURIComponent(route),
    expectedCanonical: `${SITE_URL}${route}`,
    kb: Math.round(Buffer.byteLength(html) / 1024),
    politicianLinks: (main.match(/href="\/politician\//g) || []).length,
    // 指到其他鄉鎮頁的連結（/election/屆/縣市/鄉鎮）
    townshipLinks: (main.match(/href="\/election\/\d+\/[^/"?]+\/[^/"?]+(?:\?[^"]*)?"/g) || []).length,
    title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '',
    canonical: (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || '',
    robots: (html.match(/<meta name="robots" content="([^"]*)"/) || [])[1] || '',
  }
}
function checkRegionPage(p, label) {
  const place = p.route.split('/').slice(3).join('')
  if (p.politicianLinks === 0) fail(`${label} ${p.route} 沒有任何 /politician/ 連結`)
  if (p.kb * 1024 > REGION_PAGE_WARN_BYTES) console.warn(`[postbuild-ssg] ${label} ${p.route} ${p.kb} KB，超過 3 MB`)
  if (!p.title.includes(place)) fail(`${label} ${p.route} 的 <title> 沒有地名「${place}」：${p.title}`)
  if (p.canonical !== p.expectedCanonical) fail(`${label} ${p.route} 的 canonical 不對：${p.canonical}（應為 ${p.expectedCanonical}）`)
  if (p.robots.includes('noindex')) fail(`${label} ${p.route} 帶了 noindex`)
}
const relRoute = (f) => fileRoute(f)
const regionPages = pageFiles
  .filter((f) => REGION_FILE_RE.test(relRoute(f)))
  .map(describeRegionPage)
  .sort((a, b) => a.route.localeCompare(b.route))
for (const p of regionPages) checkRegionPage(p, '縣市頁')

const townshipPages = pageFiles
  .filter((f) => TOWNSHIP_FILE_RE.test(relRoute(f)))
  .map(describeRegionPage)
  .sort((a, b) => a.route.localeCompare(b.route))
// 一頁都沒有＝鄉鎮頁整批沒產出（路由、切片或搬檔壞了），不是「這次剛好沒有」：2022 每個鄉鎮都有村里長參選人
if (townshipPages.length === 0) fail('沒有任何鄉鎮頁（/election/:id/:縣市/:鄉鎮）')
for (const p of townshipPages) {
  checkRegionPage(p, '鄉鎮頁')
  if (p.townshipLinks === 0) fail(`鄉鎮頁 ${p.route} 沒有任何通往其他鄉鎮頁的連結`)
}

// 3c. 縣市頁、鄉鎮頁不能還留在中文目錄（Firebase 對非 ASCII 檔名的比對沒有保證，見 cloudflare/region-path.js）
const leftInChinese = pageFiles.map(fileRoute).filter((r) => r.startsWith('/election/') && /[^\x00-\x7f]|%[0-9A-Fa-f]{2}/.test(r))
if (leftInChinese.length) fail(`${leftInChinese.length} 頁還在中文目錄沒搬到 ASCII 路徑，例：${leftInChinese.slice(0, 3).join(', ')}`)

// 4. 政治人物頁的 initialState 不該把整包政見塞進去（控制頁重）
const politicianSample = samples.find((s) => s.route.startsWith('/politician/'))
if (politicianSample && politicianSample.stateKb > 200) fail(`政治人物頁 initialState 過大：${politicianSample.stateKb} KB`)

// 5. sitemap：按內容拆份，sitemap.xml 是索引（2026-09-23 維護者：Search Console 才看得出哪一類沒被收錄）
//    提交的網址不變，一樣是 /sitemap.xml。2026-10-05 選舉頁（全台、縣市、鄉鎮，約上千頁）另拆一份，鄉鎮頁有沒有被收錄才看得出來。
const lastmod = taipeiDate()
const SITEMAP_GROUPS = [
  { file: 'sitemap-politicians.xml', match: (r) => r.startsWith('/politician/') },
  { file: 'sitemap-policies.xml', match: (r) => r.startsWith('/policy/') || r.startsWith('/analysis/') },
  { file: 'sitemap-elections.xml', match: (r) => r.startsWith('/election/') },
  { file: 'sitemap-pages.xml', match: () => true },
]
const grouped = new Map(SITEMAP_GROUPS.map((g) => [g.file, []]))
for (const r of [...new Set([...routes, ...edgeRoutes])].sort()) grouped.get(SITEMAP_GROUPS.find((g) => g.match(r)).file).push(r)
for (const [file, list] of grouped) {
  if (list.length === 0) fail(`${file} 是空的`)
  if (list.length > 50000) fail(`${file} 超過 50,000 個網址（${list.length}），要再拆`)
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...list.map((r) => `  <url><loc>${SITE_URL}${r}</loc><lastmod>${lastmod}</lastmod></url>`),
    '</urlset>',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(DIST, file), xml, 'utf8')
}
const indexXml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...[...grouped.keys()].map((file) => `  <sitemap><loc>${SITE_URL}/${file}</loc><lastmod>${lastmod}</lastmod></sitemap>`),
  '</sitemapindex>',
  '',
].join('\n')
fs.writeFileSync(path.join(DIST, 'sitemap.xml'), indexXml, 'utf8')

const byPrefix = routes.reduce((acc, r) => {
  const key = r === '/' ? '/' : `/${r.split('/')[1]}`
  acc[key] = (acc[key] || 0) + 1
  return acc
}, {})

const summary = {
  htmlFiles: allHtml.length,
  prerenderedPages: pageFiles.length,
  sitemapUrls: new Set([...routes, ...edgeRoutes]).size,
  edgeRendered: edgeRoutes.length,
  sitemaps: Object.fromEntries([...grouped].map(([f, l]) => [f, l.length])),
  byPrefix,
  pagesWithoutInitialState: noStatePages.length,
  relocatedRegionPages,
  regionPages,
  // 鄉鎮頁約上千頁，只印統計與幾個樣本
  townshipPages: {
    count: townshipPages.length,
    byElection: townshipPages.reduce((acc, p) => { const y = p.route.split('/')[2]; acc[y] = (acc[y] || 0) + 1; return acc }, {}),
    politicianLinks: townshipPages.length ? { min: Math.min(...townshipPages.map((p) => p.politicianLinks)), max: Math.max(...townshipPages.map((p) => p.politicianLinks)) } : null,
    maxKb: townshipPages.length ? Math.max(...townshipPages.map((p) => p.kb)) : 0,
    samples: townshipPages.filter((_, i) => i % Math.max(1, Math.floor(townshipPages.length / 5)) === 0).slice(0, 5)
      .map(({ route, kb, politicianLinks, townshipLinks, title }) => ({ route, kb, politicianLinks, townshipLinks, title })),
  },
  samples,
  failures,
}
console.log('[postbuild-ssg] ' + JSON.stringify(summary, null, 2))

if (failures.length) {
  console.error(`[postbuild-ssg] 驗證失敗 ${failures.length} 項`)
  process.exit(1)
}
