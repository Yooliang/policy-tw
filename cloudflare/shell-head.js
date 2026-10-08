/**
 * 邊緣 SSR 的客戶端殼（app.html，由 index.html 建出來）裡寫死的 head 標籤，哪些要讓位給每頁自己的 head。
 * 從 ssr-worker.js 抽出來是為了能單獨測（ssr-worker.js 會 import 建置產物 dist-ssr）。
 *
 * 殼是首頁版：title、description、og:*、twitter:* 都是首頁的。每頁渲染出來的 head（composables/usePageHead.ts）
 * 會再輸出一份，兩份並存的話爬蟲讀到的是第一份——也就是首頁的標題與首頁的分享圖。
 * usePageHead 輸出什麼，這裡就要拿掉殼裡對應的那幾種；加了新的 meta 種類（#461 加 og:image、twitter:*）要回來補。
 */
export const SHELL_HEAD_OVERRIDES = [
  /<title>[^<]*<\/title>\s*/i,
  /<meta name="description"[^>]*>\s*/i,
  /<meta property="og:(title|description|url|type|site_name)"[^>]*>\s*/gi,
  /<meta property="og:image[^"]*"[^>]*>\s*/gi,
  /<meta name="twitter:[^"]*"[^>]*>\s*/gi,
  /<meta name="viewport"[^>]*>\s*/i,
]

/** 把殼裡會被每頁 head 取代的標籤拿掉 */
export function stripShellHead(html) {
  let out = html
  for (const re of SHELL_HEAD_OVERRIDES) out = out.replace(re, '')
  return out
}
