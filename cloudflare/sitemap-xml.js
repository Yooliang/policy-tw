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

/** 一份網站地圖的 lastmod＝裡面最晚的那個網址 lastmod；一個都沒有就 null（索引裡也不寫） */
export function newestLastmod(entries) {
  let best = null
  for (const e of entries) if (e.lastmod && (best === null || Date.parse(e.lastmod) > Date.parse(best))) best = e.lastmod
  return best
}
