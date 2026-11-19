/**
 * 建置端載入資料的重試（lib/ssg/server-data.ts 用）。純函式、不碰網路，睡眠可注入，方便測。
 *
 * 2026-11-19 兩次主線 CI 在「建置（含預渲染）」紅燈（#992、#993 都要重跑）：整份政見清單撈到
 * `canceling statement due to statement timeout`（SQLSTATE 57014），而建置端的重試完全沒起作用，兩個原因疊在一起：
 *   1. `ensurePolicies()` 等載入函式失敗時只記錄、不丟錯，這層的 ok 判斷永遠是真，重試根本沒機會跑，
 *      直到後面撞到「基礎資料為空」才中止；
 *   2. 57014 落在 `isClientError` 的 SQLSTATE 範圍，單頁層級也被當成「再試也一樣」而不重試。
 * 所以這裡的重試要看「結果是不是完整」（ok），失敗的退避也拉長到資料庫忙完一輪的量級：DB 忙的時候
 * 3 秒後再撞一次沒有意義。
 */

/** 最多試幾次（含第一次） */
export const FETCH_ATTEMPTS = 4
/** 第 n 次嘗試前等多久（毫秒）；第 0 次不等 */
export const RETRY_DELAY_MS = [0, 5_000, 15_000, 30_000]

export interface SsgRetryOptions {
  attempts?: number
  delaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
  warn?: (msg: string) => void
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 建置期間的暫時性失敗要重試，不要整條 CI 紅掉。
 *
 * 2026-09-13 實際發生：`Failed to fetch data from Supabase: { message: 'Gateway Timeout' }`
 * → 建置中止 → 那次合併的改動整批沒有部署，而且畫面上看起來只是「CI 紅了」。
 * 中止本身是對的（產出空殼頁更糟），錯的是只試一次。
 *
 * 重試的是「拿不到資料」與「回來的不完整」（ok 回 false）；用盡次數仍不行就丟出最後一個錯誤。
 */
export async function withRetry<T>(
  label: string,
  run: () => Promise<T>,
  ok: (v: T) => boolean,
  opts: SsgRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? FETCH_ATTEMPTS
  const delays = opts.delaysMs ?? RETRY_DELAY_MS
  const sleep = opts.sleep ?? realSleep
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  let last: unknown = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0
    if (attempt > 0 && delay > 0) {
      warn(`[ssg] ${label} 第 ${attempt} 次沒成功，${delay / 1000} 秒後重試`)
      await sleep(delay)
    }
    try {
      const v = await run()
      if (ok(v)) return v
      last = new Error(`${label} 回傳的內容不完整`)
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error(`[ssg] ${label} 連續 ${attempts} 次失敗`)
}
