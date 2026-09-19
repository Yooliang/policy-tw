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

/**
 * 內文裡的網址也只留網域（2026-09-19：「有時內文也會出現網址，弄個統一的過濾器吧」）。
 * 只動 http(s):// 開頭的那一串，其餘文字原樣；解析不出來的照 hostOf 的規矩原樣留著。
 * 給 {{ }} 純文字用，所以不會變成連結——要連結的地方用 hostOf 當顯示字、href 保留完整網址。
 */
export function shortUrlsIn(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(/https?:\/\/[^\s<>"'）)】」》\]。，、；：！？]+/g, (m) => hostOf(m))
}
