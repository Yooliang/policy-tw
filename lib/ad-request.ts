/**
 * AdSense 要廣告的小工具（components/AdSlot.vue 用）。
 *
 * pushAd：一個 <ins> 只能 push 一次。載入器還沒到時 push 只是排進陣列，連續換頁會排好幾個，
 * 載入器一到就對同一個 <ins> 重複處理，丟「All 'ins' elements ... already have ads」。
 * 這裡記下推過的 <ins>（WeakSet），推過、已經有狀態、不在 DOM 裡的都不再推。
 *
 * 不碰 window／document（元素由呼叫端傳進來），deno test 可以直接測。
 * 等頁面內容載完再要的 whenContentReady 要 DOM 型別，放在 lib/ad-ready.ts。
 */

/** 只用到 <ins> 的這幾個成員，測試時可以丟假物件 */
export interface AdInsLike {
  isConnected: boolean
  getAttribute(name: string): string | null
}

const pushed = new WeakSet<object>()

export type PushResult = 'pushed' | 'no-element' | 'detached' | 'already-pushed' | 'already-filled'

/** 對這個 <ins> 要一次廣告。`queue` 是 window.adsbygoogle（由呼叫端建好傳進來）。 */
export function pushAd(ins: AdInsLike | null | undefined, queue: unknown[]): PushResult {
  if (!ins) return 'no-element'
  if (!ins.isConnected) return 'detached'
  if (pushed.has(ins)) return 'already-pushed'
  // 載入器處理過的 <ins> 會被標上這個屬性（done／filled／unfilled）
  if (ins.getAttribute('data-adsbygoogle-status')) return 'already-filled'
  pushed.add(ins)
  queue.push({})
  return 'pushed'
}
