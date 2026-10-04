/**
 * 一頁頁撈到底，撈不完要講。
 *
 * PostgREST 預設 max-rows = 1000。沒有分頁的查詢撈超過 1000 列時，它回前 1000 列、
 * HTTP 200、`content-range: 0-999/*`，**不報任何錯**。
 *
 * 2026-10-04 實測：高雄市 2022 有 1769 位參選人，其中村里長 1609 位。
 * 選區頁不帶型別篩選地撈，回來的那 1000 列剛好全是村里長——市長 4 位、議員 124 位、
 * 原住民區代表 32 位一個都沒載到，而畫面上只是那幾個區塊不見了，沒有任何錯誤訊息。
 *
 * 這支把「一頁頁撈到底」收成一個地方，並且在真的撈不完時回報 truncated，
 * 讓呼叫端能跟使用者說一句「名單可能不完整」，而不是靜靜地少人。
 *
 * **穩定排序是前提**：呼叫端建查詢時一定要 `.order()` 在一個「唯一」的欄位上。
 * 沒有全序的排序，PostgREST 每頁的順序不保證一致，會同一筆回兩次、另一筆一次都沒回，
 * 而且同樣不會有任何錯誤。
 */

/** PostgREST 的預設 max-rows，也就是一頁最多拿得到幾列 */
export const PAGE_SIZE = 1000

/**
 * 分頁上限：30 頁＝30,000 列。
 * 一個縣市一屆的參選人最多不到 4,000 位（新北村里長一千多個里），留的餘裕夠大；
 * 真的撈到這個數字，就不該再一頁頁撈，該改成資料庫端聚合了。
 */
export const DEFAULT_MAX_PAGES = 30

/** supabase-js 的回應形狀。只取這兩個欄位，所以這支檔案不依賴 supabase-js 的型別。 */
export interface PageResponse<T> {
  data: T[] | null
  error: { message: string } | null
}

/**
 * 給一個起訖列號、回一個查詢。
 * 呼叫端自己決定查哪張表／哪支 RPC、帶什麼條件、怎麼排序。
 */
export type PageFetcher<T> = (from: number, to: number) => PromiseLike<PageResponse<T>>

export interface FetchAllPagesResult<T> {
  /** 撈回來的所有列，依呼叫端給的排序串接 */
  rows: readonly T[]
  /** 實際發出幾次查詢 */
  pages: number
  /** true＝撈到 maxPages 還是滿頁，名單確定不完整，畫面上要講 */
  truncated: boolean
}

export interface FetchAllPagesOptions {
  /** 每頁幾列；預設 PAGE_SIZE。只有測試會需要改它。 */
  pageSize?: number
  /** 最多撈幾頁；預設 DEFAULT_MAX_PAGES */
  maxPages?: number
}

export async function fetchAllPages<T>(
  label: string,
  fetchPage: PageFetcher<T>,
  options: FetchAllPagesOptions = {},
): Promise<FetchAllPagesResult<T>> {
  const pageSize = options.pageSize ?? PAGE_SIZE
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  // 邊界檢查放在這裡而不是靠呼叫端自律：pageSize 或 maxPages 傳 0 會讓迴圈一頁都不撈，
  // 回一個空陣列加 truncated——那又是一次靜靜地少人。
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error(`fetchAllPages(${label}): pageSize 必須是正整數，收到 ${pageSize}`)
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error(`fetchAllPages(${label}): maxPages 必須是正整數，收到 ${maxPages}`)

  const pages: T[][] = []

  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const rows = data ?? []
    pages.push(rows)
    // 不滿一頁就是最後一頁。剛好滿一頁時會再撈一次拿到空頁才停，
    // 這一次多出來的查詢換到的是「確定撈完了」。
    if (rows.length < pageSize) {
      return { rows: pages.flat(), pages: pages.length, truncated: false }
    }
  }

  console.warn(`[fetch-all-pages] ${label} 撈到上限 ${maxPages * pageSize} 列還是滿頁，名單不完整`)
  return { rows: pages.flat(), pages: pages.length, truncated: true }
}
