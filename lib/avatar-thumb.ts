/**
 * 頭像縮圖網址（2026-10-31 手機效能追蹤：ws.moi.gov.tw 原圖單張 8.8 MB、4.2 MB，手機頻寬被吃光）。
 * 能縮的來源才改寫、不能縮的原樣回傳（呼叫端 <img> 另用 loading=lazy，第一屏外不載）：
 * - upload.wikimedia.org 原圖 /wikipedia/commons/a/ab/X.jpg → /wikipedia/commons/thumb/a/ab/X.jpg/330px-X.jpg
 *   （330 是 Wikimedia 允許的標準寬度之一；非標準寬度會 400，不可隨意改成別的數字）。已經是 thumb 的不動。
 * - 設了 VITE_IMG_PROXY（例如 https://xn--2lw665d.tw/img）時，其餘外部原圖走 `${proxy}?u=<原圖>&w=<寬>`；沒設就不動。
 */
const WIKI_RE = /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/(?:commons|zh)\/)([0-9a-f]\/[0-9a-f]{2}\/)([^/?#]+)$/i
const PROXY = (import.meta.env?.VITE_IMG_PROXY as string | undefined) || ''
const PROXY_HOSTS = /^https:\/\/(ws\.moi\.gov\.tw|cand\.moi\.gov\.tw|elections\.olc\.tw|p\.udn\.com\.tw|pgw\.udn\.com\.tw|whoareyou-gcs\.readr\.tw)\//

export function avatarThumbUrl(src: string, width = 330): string {
  const m = WIKI_RE.exec(src)
  if (m) {
    const name = m[3]
    // SVG 在 Wikimedia 縮圖會變 PNG，檔名後面要加 .png
    const tail = /\.svg$/i.test(name) ? `${name}.png` : name
    return `${m[1]}thumb/${m[2]}${name}/${width}px-${tail}`
  }
  if (PROXY && PROXY_HOSTS.test(src)) return `${PROXY}?u=${encodeURIComponent(src)}&w=${width}`
  return src
}
