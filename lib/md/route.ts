/**
 * Markdown 網址的解析（純函式，不碰資料庫；docs/PLAN-markdown-views.md 第 2、5 節）。
 * Worker（cloudflare/markdown.js）把路徑與查詢字串餵進來，拿回「要做什麼」：
 *
 *   politician       /politician/<id>.md                 → Worker 讀時產生（人物不預產）
 *   cache            預產快取裡的一列（鍵＝解碼後的站內路徑）
 *                      /election/<屆>/<縣市>.md、/data/<屆>/<縣市>.md   縣市（全部分類）
 *                      /data/<屆>/<分類>.md                          分類（全部縣市）
 *                      /data/<屆>/<縣市>/<分類>.md                    縣市×分類
 *                      /data/<屆>/index.md、/data/<屆>/index.json      索引（人看、程式看）
 *   category-latest  /category/<分類>.md                 → 最新一屆的 /data/<屆>/<分類>.md 那一列（Worker 查最新一屆）
 *   latest           要先知道最新一屆才能轉：/data/<縣市>.md、/data/<縣市>/<分類>.md、/data/index.md|json、查詢式
 *   data-matrix      /data（沒帶查詢）                    → 302 到最新一屆的矩陣頁
 *   redirect         名稱換成正式寫法（臺→台、簡稱→全名、分類的常見說法→分類全名、舊三屆 key→年份）
 *   notfound         認不出來 → 404 的 Markdown（列出縣市與分類）
 *   null             不是 Markdown 檢視的網址（Worker 照舊處理）
 *
 * 「主題」就是既有分類（維護者 10-07 裁示，第二期取消）：路徑只認分類全名；文字查詢與路徑裡的常見說法（育兒→社會福利）轉到分類全名。
 */
import { LEGACY_ELECTION_KEYS } from '../election-route'
import { CATEGORIES, categoryByName, findCategories, findRegions, regionByName } from '../data-query'

export type MdRoute =
  | { kind: 'politician'; id: string }
  | { kind: 'cache'; /** 快取鍵（解碼後路徑） */ key: string; /** 請求的解碼後路徑（組文件的 url 用） */ path: string; format: 'md' | 'json' }
  | { kind: 'category-latest'; category: string }
  | { kind: 'latest'; status: 301 | 302; target: 'data' | 'election'; tail: string[] }
  | { kind: 'data-matrix' }
  | { kind: 'redirect'; status: 301 | 302; to: string }
  | { kind: 'notfound'; what: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEGMENT_RE = /^[0-9A-Za-z_-]+$/
const enc = encodeURIComponent
const MD = '.md'

const encPath = (segments: string[]) => `/${segments.map(enc).join('/')}`

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
}

/** 最新一屆的路徑（Worker 查到最新一屆的網址那一段 segment 之後組） */
export function latestPath(target: 'data' | 'election', segment: string, tail: string[]): string {
  return encPath([target, segment, ...tail])
}

/** 查詢式入口的參數：q（自由文字）、city／region（縣市）、topic／category（分類）一起併成一段文字去認 */
export function queryText(params: URLSearchParams): string {
  return ['q', 'city', 'region', 'topic', 'category'].map((k) => params.get(k) ?? '').filter(Boolean).join(' ')
}

/** 自由文字 → 轉去哪或認不出來。純規則、不靠即時 LLM（計畫 5） */
export function resolveDataQuery(text: string): MdRoute {
  const raw = text.trim()
  if (!raw) return { kind: 'notfound', what: '沒有給查詢文字（?q=…）' }
  const regions = findRegions(raw)
  if (regions.length > 1) return { kind: 'notfound', what: `「${raw}」同時指到多個縣市：${regions.join('、')}` }
  // 最長優先比對：分類全名先吃掉那一段，「教育文化」裡的「教育」不會又被當成說法
  const cats = findCategories(raw)
  if (cats.length > 1) return { kind: 'notfound', what: `「${raw}」同時指到多個分類：${cats.join('、')}；一次只能指定一個` }
  const region = regions[0]
  const category = cats[0]
  if (region && category) return { kind: 'latest', status: 302, target: 'data', tail: [region, `${category}${MD}`] }
  if (region) return { kind: 'latest', status: 302, target: 'election', tail: [`${region}${MD}`] }
  if (category) return { kind: 'redirect', status: 302, to: encPath(['category', `${category}${MD}`]) }
  return { kind: 'notfound', what: `「${raw}」沒有認出縣市或分類` }
}

export function matchMarkdownRoute(pathname: string, params: URLSearchParams = new URLSearchParams()): MdRoute | null {
  const seg = decodeSegments(pathname)
  if (!seg || seg.length === 0) return null
  const head = seg[0]

  if (head === 'data') {
    if (seg.length === 1 || (seg.length === 2 && seg[1] === 'search')) {
      const text = queryText(params)
      if (!text) return seg.length === 1 ? { kind: 'data-matrix' } : { kind: 'notfound', what: '沒有給查詢文字（?q=…）' }
      return resolveDataQuery(text)
    }
    return matchData(seg.slice(1), pathname)
  }

  const last = seg[seg.length - 1]
  if (!last.endsWith(MD)) return null
  const stem = last.slice(0, -MD.length)

  if (head === 'politician') {
    if (seg.length !== 2) return { kind: 'notfound', what: `不認得的人物網址：${pathname}` }
    return UUID_RE.test(stem) ? { kind: 'politician', id: stem.toLowerCase() } : { kind: 'notfound', what: `人物編號「${stem}」格式不對（要是人物頁網址 /politician/<編號> 的編號）` }
  }

  if (head === 'category') {
    if (seg.length !== 2) return { kind: 'notfound', what: `不認得的分類網址：${pathname}` }
    if (CATEGORIES.includes(stem)) return { kind: 'category-latest', category: stem }
    const cat = categoryByName(stem)
    return cat ? { kind: 'redirect', status: 301, to: encPath(['category', `${cat}${MD}`]) } : { kind: 'notfound', what: `沒有「${stem}」這個分類` }
  }

  if (head === 'election') {
    // /election/<屆>/<縣市>.md；全台、鄉鎮沒有 Markdown 版
    if (seg.length !== 3 || !SEGMENT_RE.test(seg[1])) return { kind: 'notfound', what: `目前只有縣市有 Markdown 版：/election/<屆>/<縣市>.md（${pathname}）` }
    const legacy = legacyYear(seg[1])
    const region = regionByName(stem)
    if (!region) return { kind: 'notfound', what: `「${stem}」不是縣市名稱` }
    if (legacy !== undefined || region !== stem) return { kind: 'redirect', status: 301, to: encPath(['election', legacy ?? seg[1], `${region}${MD}`]) }
    return { kind: 'cache', key: `/election/${seg[1]}/${region}${MD}`, path: `/election/${seg[1]}/${region}${MD}`, format: 'md' }
  }

  return null
}

function legacyYear(segment: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(LEGACY_ELECTION_KEYS, segment) ? String(LEGACY_ELECTION_KEYS[segment as keyof typeof LEGACY_ELECTION_KEYS]) : undefined
}

function matchData(rest: string[], pathname: string): MdRoute {
  const last = rest[rest.length - 1]
  const asJson = last === 'index.json'
  // 沒帶 .md 的 /data/…：補上 .md（301）
  if (!last.endsWith(MD) && !asJson) {
    if (rest.length <= 3) return { kind: 'redirect', status: 301, to: encPath(['data', ...rest.slice(0, -1), `${last}${MD}`]) }
    return { kind: 'notfound', what: `不認得的網址：${pathname}` }
  }
  const stem = asJson ? 'index' : last.slice(0, -MD.length)
  const ext = asJson ? '.json' : MD

  // 一段：/data/index.md、/data/index.json、/data/<縣市>.md（都是最新一屆的短網址）
  if (rest.length === 1) {
    if (stem === 'index') return { kind: 'latest', status: 301, target: 'data', tail: [`index${ext}`] }
    const region = regionByName(stem)
    if (!region) return { kind: 'notfound', what: `「${stem}」不是縣市名稱` }
    return region !== stem ? { kind: 'redirect', status: 301, to: encPath(['data', `${region}${MD}`]) } : { kind: 'latest', status: 301, target: 'election', tail: [`${region}${MD}`] }
  }

  const first = rest[0]
  const oldStyleRegion = regionByName(first)

  if (rest.length === 2) {
    // /data/<縣市>/<分類>.md（舊規劃網址、最新一屆的短網址）→ /data/<屆>/<縣市>/<分類>.md
    if (oldStyleRegion) {
      const category = categoryByName(stem)
      if (!category) return { kind: 'notfound', what: `「${stem}」不是分類，也不是分類的常見說法` }
      return { kind: 'latest', status: 301, target: 'data', tail: [oldStyleRegion, `${category}${MD}`] }
    }
    // /data/<屆>/index.md|json、/data/<屆>/<縣市>.md、/data/<屆>/<分類>.md
    if (!SEGMENT_RE.test(first)) return { kind: 'notfound', what: `不認得的網址：${pathname}` }
    const year = legacyYear(first)
    const seg = year ?? first
    if (stem === 'index') {
      return year ? { kind: 'redirect', status: 301, to: encPath(['data', seg, `index${ext}`]) } : { kind: 'cache', key: `/data/${seg}/index${ext}`, path: `/data/${seg}/index${ext}`, format: asJson ? 'json' : 'md' }
    }
    if (asJson) return { kind: 'notfound', what: `不認得的網址：${pathname}` }
    const region = regionByName(stem)
    if (region) {
      if (year || region !== stem) return { kind: 'redirect', status: 301, to: encPath(['data', seg, `${region}${MD}`]) }
      return { kind: 'cache', key: `/election/${seg}/${region}${MD}`, path: `/data/${seg}/${region}${MD}`, format: 'md' }
    }
    const category = categoryByName(stem)
    if (category) {
      if (year || category !== stem) return { kind: 'redirect', status: 301, to: encPath(['data', seg, `${category}${MD}`]) }
      return { kind: 'cache', key: `/data/${seg}/${category}${MD}`, path: `/data/${seg}/${category}${MD}`, format: 'md' }
    }
    return { kind: 'notfound', what: `「${stem}」不是縣市名稱，也不是分類` }
  }

  if (rest.length === 3 && !asJson) {
    // /data/<屆>/<縣市>/<分類>.md
    if (!SEGMENT_RE.test(first)) return { kind: 'notfound', what: `不認得的網址：${pathname}` }
    const year = legacyYear(first)
    const seg = year ?? first
    const region = regionByName(rest[1])
    if (!region) return { kind: 'notfound', what: `「${rest[1]}」不是縣市名稱` }
    const category = categoryByName(stem)
    if (!category) return { kind: 'notfound', what: `「${stem}」不是分類，也不是分類的常見說法` }
    if (year || region !== rest[1] || category !== stem) return { kind: 'redirect', status: 301, to: encPath(['data', seg, region, `${category}${MD}`]) }
    return { kind: 'cache', key: `/data/${seg}/${region}/${category}${MD}`, path: `/data/${seg}/${region}/${category}${MD}`, format: 'md' }
  }
  return { kind: 'notfound', what: `不認得的網址：${pathname}` }
}
