/**
 * 只在建置時算得出內容的頁面（人物一覽、政黨頁，#346）：從站內別頁點進來（客戶端換頁）時沒有那一頁的快照，
 * 就整頁載入一次，拿預渲染好的那一份。直接打開網址進來卻還是沒有（開發模式、或建置之後才出現的新政黨）就不重載，
 * 頁面自己講「這一頁還沒產生」——不然會一直重載。
 *
 * 第一次載入的路徑要在 app 一啟動就記下來（這個模組由 router 載入），不能等頁面元件的 chunk 載完才記。
 */
const FIRST_PATH: string | null = typeof window !== 'undefined' ? normalize(window.location.pathname) : null

function normalize(path: string): string {
  let p = path
  try { p = decodeURI(path) } catch { /* 原樣 */ }
  return p.length > 1 ? p.replace(/\/$/, '') : p
}

/** 換頁進來、這一頁的資料不在快照裡：整頁載入。回傳 true＝已經在重載，頁面不用再顯示什麼 */
export function reloadForPrerendered(fullPath: string): boolean {
  if (typeof window === 'undefined' || import.meta.env.DEV || FIRST_PATH === null) return false
  const target = normalize(fullPath.split('?')[0].split('#')[0])
  if (target === FIRST_PATH) return false
  window.location.replace(fullPath)
  return true
}
