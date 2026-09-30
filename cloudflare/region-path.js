/**
 * 縣市頁的網址對應（2026-09-30）。Worker（ssr-worker.js）、scripts/postbuild-ssg.mjs、scripts/serve-dist.mjs 共用。
 *
 * 對外網址是中文：/election/2026/台北市（實際傳輸是 %E5%8F%B0%E5%8C%97%E5%B8%82）。
 * Firebase Hosting 對非 ASCII 檔名的比對行為沒有文件保證，所以預渲染檔不放中文目錄，
 * postbuild 把它搬到 ASCII 路徑 /election/2026/_r/<UTF-8 十六進位>/index.html，
 * 正見.tw 的 Worker 代理時把中文路徑換成這個 ASCII 路徑去向 web.app 拿。
 * 直接打 policy-tw.web.app 的中文網址會落到 firebase.json 的 /election/*\/* → app.html（客戶端渲染、noindex），照樣能看。
 */

export const REGION_DIR = '_r'

const REGION_PAGE_RE = /^\/election\/(\d+)\/([^/]+)\/?$/
const LEGACY_PAGE_RE = /^\/election\/(\d+)\/?$/
/** 縣市名的樣子：兩個漢字＋市／縣（22 縣市都符合）；只用來判斷要不要轉址，真正的驗證在頁面上 */
const COUNTY_LIKE_RE = /^[一-鿿]{2}[市縣]$/

function safeDecode(segment) {
  try { return decodeURIComponent(segment) } catch { return null }
}

export function toHex(text) {
  return Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 縣市頁的 ASCII 檔案路徑（不含 index.html）；region 是未編碼的中文 */
export function regionFilePath(electionId, region) {
  return `/election/${electionId}/${REGION_DIR}/${toHex(region)}`
}

/** 請求路徑 → 上游（web.app）要拿的路徑；不是縣市頁就回 null */
export function regionUpstreamPath(pathname) {
  const m = pathname.match(REGION_PAGE_RE)
  if (!m) return null
  const region = safeDecode(m[2])
  if (!region || !/[^\x00-\x7f]/.test(region)) return null
  return regionFilePath(m[1], region)
}

/**
 * 舊網址 /election/2026?region=台北市&sub=… → 新網址 /election/2026/台北市?sub=…（301）。
 * 回傳新的「路徑＋查詢字串」，不需要轉就回 null。
 */
export function legacyRegionRedirect(pathname, searchParams) {
  const m = pathname.match(LEGACY_PAGE_RE)
  if (!m) return null
  const region = (searchParams.get('region') || '').trim()
  if (!COUNTY_LIKE_RE.test(region)) return null
  const rest = new URLSearchParams(searchParams)
  rest.delete('region')
  const qs = rest.toString()
  return `/election/${m[1]}/${encodeURIComponent(region)}${qs ? `?${qs}` : ''}`
}
