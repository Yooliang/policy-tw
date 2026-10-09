/**
 * 殼（web.app 的 /app.html）是哪一版：取它載入的 /assets/*.js 與 *.css 檔名（vite 每次建置內容一變檔名就變）。
 *
 * 用途（policy-ops#37，2026-10-09）：邊緣渲染的頁進了 Cache API，部署之後快取裡的舊頁還指著舊的 /assets 檔，
 * 而 Firebase 部署會把舊檔刪掉（回 404）——按鈕失靈、頁面互動壞掉。Worker 存頁時把殼的版本記在 X-Shell-Version，
 * 取出時跟現在的殼比，不一樣就當沒命中、當場重算，不再「先回舊的、背景重算」。
 * 拿不到版本（殼的寫法變了、沒有 /assets）回空字串；兩邊都是空字串視為同一版（不因為認不得就每次重算）。
 */
const ASSET_RE = /\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)/g

/** @param {string} html */
export function shellVersion(html) {
  const found = String(html ?? '').match(ASSET_RE)
  return found ? [...new Set(found)].sort().join(' ') : ''
}

/** 快取裡那一頁的殼版本跟現在的殼一樣嗎（cached＝存頁時記下的 X-Shell-Version，沒有這個標頭＝舊版 Worker 存的，一律當不同） */
export function sameShell(cached, current) {
  if (cached === null || cached === undefined) return false
  return cached === current
}
