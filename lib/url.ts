/**
 * 畫面上顯示來源連結時只印網域（2026-09-18）。
 *
 * 完整網址動輒上百字元，排在時間軸裡會把整列擠壞；讀者要判斷的是
 * 「這是哪裡來的」，網域就夠了。解析不出來（相對路徑、怪字串）就原樣印出，
 * 不要把它吃掉——那反而讓人以為沒有來源。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
