/**
 * 站內搜尋的 GA4 事件。
 *
 * GA4 內建的「站內搜尋」增強量測要網址上有查詢參數（?q=）才抓得到，
 * 但全站搜尋是跳出視窗即時查、網址不變，所以自己送 `search` 事件。
 * 帶 results_count 是為了找出搜了沒結果的詞（資料缺口的線索）。
 */

const MAX_TERM = 100
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/
const TW_ID = /[A-Z][12]\d{8}/i

/** 整理搜尋詞；空的或像個資（電郵、電話／證號）就回 null，不送 */
export function sanitizeSearchTerm(raw: string): string | null {
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TERM)
  if (!t) return null
  if (EMAIL.test(t)) return null
  if (/\d{7,}/.test(t.replace(/[\s-]/g, ''))) return null
  if (TW_ID.test(t)) return null
  return t
}

type Send = (name: string, params: Record<string, unknown>) => void

/** gtag 沒載入（被擋、離線、預渲染）就靜默略過，搜尋本身不能因此壞掉 */
function defaultSend(name: string, params: Record<string, unknown>): void {
  try {
    (globalThis as unknown as { gtag?: (...a: unknown[]) => void }).gtag?.('event', name, params)
  } catch { /* 追蹤失敗不影響使用 */ }
}

export interface SearchTrackerOptions {
  send?: Send
  settleMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

/**
 * 打字中每個中間字串都會查一次，全送會灌爆事件；
 * 所以結果出來後等 settleMs 沒有新結果才送最後一個，點結果或關閉視窗則立刻送。
 */
export function createSearchTracker(opts: SearchTrackerOptions = {}) {
  const send = opts.send ?? defaultSend
  const settleMs = opts.settleMs ?? 1500
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))

  let pending: { term: string; count: number } | null = null
  let timerId: unknown = null
  let lastSent: string | null = null

  function cancel() {
    if (timerId !== null) clearTimer(timerId)
    timerId = null
    pending = null
  }

  function flush() {
    const p = pending
    cancel()
    if (!p || p.term === lastSent) return
    lastSent = p.term
    try {
      send('search', { search_term: p.term, results_count: p.count })
    } catch { /* 追蹤失敗不影響使用 */ }
  }

  function results(term: string, count: number) {
    const t = sanitizeSearchTerm(term)
    if (t === null) { cancel(); return }
    if (timerId !== null) clearTimer(timerId)
    pending = { term: t, count }
    timerId = setTimer(flush, settleMs)
  }

  /** 關視窗後重新開始：清掉待送的與「上一次送出」的記錄 */
  function reset() {
    cancel()
    lastSent = null
  }

  return { results, flush, cancel, reset }
}
