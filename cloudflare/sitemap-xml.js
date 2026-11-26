/**
 * 網站地圖的 XML 組字（2026-10-08，#466）。scripts/postbuild-ssg.mjs 用；放這裡是為了讓 deno 測試（cloudflare/ 整夾都跑）直接測，
 * 跟 region-path.js 一樣是 node 與測試共用的純 JS。內容規則（誰進、lastmod 取哪個時間）在 lib/sitemap.ts。
 *
 * lastmod 只在有可靠時間時才寫；沒有就整個標籤省略，不用建置當天頂替。
 */

export function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

const lastmodTag = (lastmod) => (lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : '')

/** @param {Array<{ loc: string, lastmod?: string | null }>} entries */
export function urlsetXml(entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((e) => `  <url><loc>${escapeXml(e.loc)}</loc>${lastmodTag(e.lastmod)}</url>`),
    '</urlset>',
    '',
  ].join('\n')
}

/** @param {Array<{ loc: string, lastmod?: string | null }>} entries */
export function sitemapIndexXml(entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((e) => `  <sitemap><loc>${escapeXml(e.loc)}</loc>${lastmodTag(e.lastmod)}</sitemap>`),
    '</sitemapindex>',
    '',
  ].join('\n')
}

/** 網站地圖協議上限：單檔 50,000 個網址、50 MB（未壓縮） */
export const SITEMAP_MAX_URLS = 50000
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024
/** 每檔放這麼多筆，離 5 萬上限留餘裕，政見再長也不必很快又拆 */
export const SITEMAP_CHUNK_SIZE = 40000

/**
 * 一類網址切成多份網站地圖（2026-11-26：政見破 5 萬，單檔超過協議上限，守門讓整個 build 紅）。
 * 第一份沿用原檔名（Search Console 已提交，不能消失），第二份起 `<名>-2.xml`、`-3.xml`…。
 * 順序照傳入順序切（呼叫端已排序），同一個網址永遠落在同一份，直到前面的筆數增減跨過邊界。
 * @template T
 * @param {string} file 例 sitemap-policies.xml
 * @param {T[]} items
 * @param {number} [chunkSize]
 * @returns {Array<{ file: string, items: T[] }>}
 */
export function splitSitemap(file, items, chunkSize = SITEMAP_CHUNK_SIZE) {
  const out = []
  for (let i = 0; i < items.length; i += chunkSize) {
    const n = i / chunkSize + 1
    out.push({ file: n === 1 ? file : file.replace(/\.xml$/, `-${n}.xml`), items: items.slice(i, i + chunkSize) })
  }
  return out
}

/** 一份網站地圖的 lastmod＝裡面最晚的那個網址 lastmod；一個都沒有就 null（索引裡也不寫） */
export function newestLastmod(entries) {
  let best = null
  for (const e of entries) if (e.lastmod && (best === null || Date.parse(e.lastmod) > Date.parse(best))) best = e.lastmod
  return best
}
