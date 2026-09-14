export interface RetryOptions {
  /** 每次重試前等多久；長度就是重試次數。 */
  delaysMs: number[]
  /** 單次嘗試的上限，超過就用 AbortSignal 中止再重試。 */
  timeoutMs: number
}

/**
 * 瀏覽器端 Supabase 請求的預設：15 秒沒回就中止，最多再試兩次（0.5s、2s 後）。
 * supabase-js 自己沒有 timeout，一個掛住的請求會讓整個 Promise.all 永遠不回來，
 * 使用者看到的就是永遠的轉圈或「找不到」。
 */
export const BROWSER_RETRY: RetryOptions = { delaysMs: [500, 2000], timeoutMs: 15_000 }

/**
 * 伺服器「有回、而且回的是這個請求本身有問題」：PostgreSQL SQLSTATE（如 22P02 uuid 格式錯、42501 無權限）
 * 或 PostgREST 的請求層錯誤（PGRST1xx／2xx／3xx）。這種再試幾次也是同一個答案，不重試；
 * 網路斷、timeout、Gateway Timeout 這類沒有 code 或 PGRST0xx 連線錯誤才重試。
 */
export function isClientError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code !== 'string' || code === '') return false
  return /^\d{2}[0-9A-Z]{3}$/.test(code) || /^PGRST[123]\d\d$/.test(code)
}

export async function withTimeoutAndRetry<T>(
  label: string,
  // PromiseLike：supabase-js 的 query builder 是 thenable，不是真的 Promise
  run: (signal: AbortSignal) => PromiseLike<T>,
  options: RetryOptions = BROWSER_RETRY,
): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt <= options.delaysMs.length; attempt++) {
    if (attempt > 0) {
      const delay = options.delaysMs[attempt - 1]
      console.warn(`[retry] ${label} 第 ${attempt} 次沒成功，${delay} ms 後重試`, last)
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    }
    try {
      return await run(AbortSignal.timeout(options.timeoutMs))
    } catch (err) {
      if (isClientError(err)) throw err
      last = err
    }
  }
  throw last
}
