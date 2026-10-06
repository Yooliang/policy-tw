/**
 * 縣市頁與鄉鎮頁的網址對應（縣市 2026-09-30、鄉鎮 2026-10-05）。Worker（ssr-worker.js）、scripts/postbuild-ssg.mjs、
 * scripts/serve-dist.mjs 共用；規則有測試（region-path.test.ts）。
 *
 * 對外網址是中文：/election/2026/台北市、/election/2022/嘉義縣/大林鎮（實際傳輸是 percent-encoded）。
 * Firebase Hosting 對非 ASCII 檔名的比對行為沒有文件保證，所以預渲染檔不放中文目錄，
 * postbuild 把它搬到 ASCII 路徑：
 *   縣市頁 /election/2026/_r/<縣市 UTF-8 十六進位>/index.html
 *   鄉鎮頁 /election/2022/_r/<縣市十六進位>/<鄉鎮十六進位>/index.html
 * 正見.tw 的 Worker 代理時把中文路徑換成這個 ASCII 路徑去向 web.app 拿。
 * 直接打 policy-tw.web.app 的中文網址會落到 firebase.json 的 rewrite → app.html（客戶端渲染、noindex），照樣能看。
 */

export const REGION_DIR = '_r'

// 選舉那一段：舊三屆是數字 id（/election/2022），新增的選舉（補選、罷免、重行選舉）是 election_key
// （/election/2022-12-18_rerun_10020）；key 只有數字、英文字母、-、_（elections_election_key_format 的 CHECK），#344 第二階段 A
const ELECTION_SEG = '([0-9A-Za-z_-]+)'
const REGION_PAGE_RE = new RegExp(`^/election/${ELECTION_SEG}/([^/]+)/?$`)
const TOWNSHIP_PAGE_RE = new RegExp(`^/election/${ELECTION_SEG}/([^/]+)/([^/]+)/?$`)
const LEGACY_PAGE_RE = new RegExp(`^/election/${ELECTION_SEG}/?$`)
const REGION_FILE_RE = new RegExp(`^/election/${ELECTION_SEG}/${REGION_DIR}/([0-9a-f]+)(?:/([0-9a-f]+))?/?$`)

/**
 * 舊三屆的 election_key 寫法 → 年份寫法（lib/election-route.ts 的 LEGACY_ELECTION_KEYS 是同一份，election-route.test.ts 盯兩邊一致）。
 * 三屆的網址保持年份寫法（/election/2022）；key 寫法（/election/2022-11-26_local）也能開，301 過去，canonical 只有一個。
 * 新增的選舉（id 不是年份）沒有年份寫法，key 就是正式網址，不在這張表。
 */
export const LEGACY_ELECTION_KEYS = {
  '2022-11-26_local': '2022',
  '2024-01-13_national': '2024',
  '2026-11-28_local': '2026',
}

/**
 * /election/<舊三屆的 key>[/縣市[/鄉鎮]] → 年份寫法（301）；不是就回 null。其餘路徑與查詢字串原樣帶著，一次轉到底。
 * 回傳新的「路徑＋查詢字串」。
 */
export function legacyElectionKeyRedirect(pathname, search = '') {
  const m = pathname.match(/^\/election\/([0-9A-Za-z_-]+)(\/.*)?$/)
  if (!m) return null
  const year = Object.prototype.hasOwnProperty.call(LEGACY_ELECTION_KEYS, m[1]) ? LEGACY_ELECTION_KEYS[m[1]] : null
  if (!year) return null
  return `/election/${year}${m[2] ?? ''}${search}`
}
/** 縣市名的樣子：兩個漢字＋市／縣（22 縣市都符合）；只用來判斷要不要轉址，真正的驗證在頁面上 */
const COUNTY_LIKE_RE = /^[一-鿿]{2}[市縣]$/
/**
 * 鄉鎮市區名的樣子：1～5 個非 ASCII 字＋鄉／鎮／市／區。內政部 368 個鄉鎮市區（admin_divisions，2026-10-05）
 * 全部符合（2～4 字，含「臺西鄉」「霧臺鄉」）；「All」、議員選區「第01選舉區」、亂打的英文都不符合，不轉址、交給頁面。
 */
const TOWNSHIP_LIKE_RE = /^[^\x00-\x7f]{1,5}[鄉鎮市區]$/
const NON_ASCII_RE = /[^\x00-\x7f]/

function safeDecode(segment) {
  try { return decodeURIComponent(segment) } catch { return null }
}

export function toHex(text) {
  return Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex) {
  const bytes = new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)))
  return new TextDecoder().decode(bytes)
}

/** 縣市頁的 ASCII 檔案路徑（不含 index.html）；region 是未編碼的中文 */
export function regionFilePath(electionId, region) {
  return `/election/${electionId}/${REGION_DIR}/${toHex(region)}`
}

/** 鄉鎮頁的 ASCII 檔案路徑（不含 index.html），放在縣市頁的目錄底下 */
export function townshipFilePath(electionId, region, township) {
  return `${regionFilePath(electionId, region)}/${toHex(township)}`
}

/** 對外網址（中文 percent-encoded，跟 lib/election-regions.ts 的 electionPath 同一種寫法） */
function publicPath(electionId, region, township) {
  return `/election/${electionId}/${encodeURIComponent(region)}${township ? `/${encodeURIComponent(township)}` : ''}`
}

/** 請求路徑 → 上游（web.app）要拿的路徑；不是縣市頁或鄉鎮頁就回 null */
export function regionUpstreamPath(pathname) {
  const t = pathname.match(TOWNSHIP_PAGE_RE)
  if (t) {
    const region = safeDecode(t[2])
    const township = safeDecode(t[3])
    // ASCII 的（例如已經是 /election/2022/_r/<十六進位>）不碰
    if (!region || !township || !NON_ASCII_RE.test(region) || !NON_ASCII_RE.test(township)) return null
    return townshipFilePath(t[1], region, township)
  }
  const m = pathname.match(REGION_PAGE_RE)
  if (!m) return null
  const region = safeDecode(m[2])
  if (!region || !NON_ASCII_RE.test(region)) return null
  return regionFilePath(m[1], region)
}

/**
 * 預渲染檔的 ASCII 路徑（不含 index.html）→ 對外網址；不是縣市頁／鄉鎮頁的檔案就回 null。
 * postbuild 產網站地圖、做空殼檢查時用（regionFilePath／townshipFilePath 的反向）。
 */
export function regionPublicPathOfFile(route) {
  const m = route.match(REGION_FILE_RE)
  if (!m) return null
  return publicPath(m[1], fromHex(m[2]), m[3] ? fromHex(m[3]) : undefined)
}

/**
 * 舊網址 → 新網址（301）。回傳新的「路徑＋查詢字串」，不需要轉就回 null。
 *   /election/2026?region=台北市&sub=信義區&view=… → /election/2026/台北市/信義區?view=…（2026-09-30 之前的寫法）
 *   /election/2022/嘉義縣?sub=大林鎮&village=…    → /election/2022/嘉義縣/大林鎮?village=…（2026-10-05 之前的寫法）
 * 一次轉到底（不會先轉到縣市頁再轉一次）；村里、頁籤等其他參數原樣帶著。
 * sub 不像鄉鎮名（All、選舉區、亂打的）就不放進路徑：舊的 ?region= 照樣轉縣市、sub 留在 query；縣市頁上的就不轉。
 */
export function legacyRegionRedirect(pathname, searchParams) {
  const rest = new URLSearchParams(searchParams)
  const sub = (rest.get('sub') || '').trim()
  const subIsTownship = TOWNSHIP_LIKE_RE.test(sub)
  let electionId
  let region
  const legacy = pathname.match(LEGACY_PAGE_RE)
  if (legacy) {
    region = (rest.get('region') || '').trim()
    if (!COUNTY_LIKE_RE.test(region)) return null
    electionId = legacy[1]
    rest.delete('region')
  } else {
    const m = pathname.match(REGION_PAGE_RE)
    if (!m || !subIsTownship) return null
    region = safeDecode(m[2])
    if (!region || !COUNTY_LIKE_RE.test(region)) return null
    electionId = m[1]
  }
  if (subIsTownship) rest.delete('sub')
  const qs = rest.toString()
  return `${publicPath(electionId, region, subIsTownship ? sub : undefined)}${qs ? `?${qs}` : ''}`
}
