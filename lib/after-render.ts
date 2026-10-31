/**
 * 等畫面先畫完再做的事（2026-10-31，載入順序優化）。
 *
 * 次要資料（政見清單 257 KB、選舉區對應、地方基本統計）以前在頁面掛載當下就發，
 * 跟首屏的候選人請求搶行動網路頻寬——第一張卡片因此晚到。呼叫端先等第一批卡片載完，
 * 再交給這裡：nextTick 讓 Vue 把卡片畫上去，之後等瀏覽器閒下來（requestIdleCallback，
 * 沒有的瀏覽器退回 setTimeout）才執行。timeout 保證最慢也會執行，不會因為一直不閒而永遠不抓。
 */
export function runAfterRender(fn: () => void, nextTick: () => Promise<void>, timeoutMs = 2000): void {
  void nextTick().then(() => {
    const w = globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    }
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => fn(), { timeout: timeoutMs })
    else setTimeout(fn, 200)
  })
}
