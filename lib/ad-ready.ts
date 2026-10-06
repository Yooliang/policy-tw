/**
 * 等頁面內容載完再要廣告（components/AdSlot.vue 用，瀏覽器專用，要 DOM 型別所以跟 ad-request.ts 分開）。
 *
 * SPA 換頁時路由先變、頁面資料後到，換頁當下 <main> 常常還是空的載入畫面。
 * 那時候要廣告，AdSense 看到的是沒有內容的頁面，不填；等 <main> 有字、DOM 安靜一小段時間再要。
 */
export interface ContentReadyOptions {
  /** <main> 的文字至少這麼長才算有內容 */
  minText?: number
  /** 達標後 DOM 要安靜這麼久（毫秒）才算載完 */
  quietMs?: number
  /** 最久等多久（毫秒），到了就算好：寧可晚一點要，也不要永遠不要 */
  maxMs?: number
  /** 呼叫端已經換頁或卸載了，不用再等 */
  cancelled?: () => boolean
}

/**
 * 等 <main> 有內容而且安靜下來。沒有 root 或沒有 MutationObserver 就直接放行。
 * 回傳 true＝可以要廣告，false＝已被取消。
 */
export function whenContentReady(root: Element | null, opts: ContentReadyOptions = {}): Promise<boolean> {
  const { minText = 120, quietMs = 300, maxMs = 4000, cancelled = () => false } = opts
  return new Promise((resolve) => {
    if (!root || typeof MutationObserver === 'undefined') {
      resolve(!cancelled())
      return
    }
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let maxTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => arm())
    const finish = () => {
      clearTimeout(quietTimer)
      clearTimeout(maxTimer)
      observer.disconnect()
      resolve(!cancelled())
    }
    // 有內容才開始計「安靜」，每次 DOM 變動重計
    function arm() {
      clearTimeout(quietTimer)
      if (cancelled()) {
        finish()
        return
      }
      if ((root!.textContent || '').trim().length >= minText) quietTimer = setTimeout(finish, quietMs)
    }
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    maxTimer = setTimeout(finish, maxMs)
    arm()
  })
}
