/**
 * 依 id（uuid）一頁頁撈到底的 keyset 分頁，可選「切成 N 段並行」。
 *
 * 為什麼：整份政見 14,700 筆、一頁 1,000 筆、循序要 15 趟（2026-11-19 實測約 11.6 秒）。
 * id 是 uuid，隨機分佈，用第一個十六進位字元切 16 段，每段各自從頭往後讀（每段約一到兩頁），
 * 16 段同時發，等於把 15 趟的串行等待壓成最慢那一段的 1～2 趟。
 *
 * 全序仍成立：uuid 在 Postgres 是逐位元組比大小，等同十六進位字串的字典序，
 * 所以「0… 段」整段都小於「1… 段」，各段依序串起來就是跟循序版一樣的順序、一樣的集合。
 *
 * 純函式、不碰網路：實際查詢由呼叫端的 fetchPage 提供（useSupabase.fetchAllRows）。
 */

/** PostgREST 一頁最多拿得到幾列 */
export const KEYSET_PAGE_SIZE = 1000

/** 一段 id 範圍：gte／lt 為 null 代表那一側不設界 */
export interface IdSegment {
  gte: string | null
  lt: string | null
}

/** 一次查詢：after 不是 null＝接著上一頁最後一個 id 往後讀；否則從該段起點讀 */
export interface KeysetQuery extends IdSegment {
  after: string | null
}

const HEX = '0123456789abcdef'
const bound = (i: number): string => `${HEX[i]}0000000-0000-0000-0000-000000000000`

/** 把 uuid 空間切成 n 段（n 取 1、2、4、8、16 之一；其他值當 1）。第一段不設下界、最後一段不設上界，所以不會有漏網的 id */
export function uuidSegments(n: number): IdSegment[] {
  const count = [1, 2, 4, 8, 16].includes(n) ? n : 1
  const step = 16 / count
  return Array.from({ length: count }, (_, i) => ({
    gte: i === 0 ? null : bound(i * step),
    lt: i === count - 1 ? null : bound((i + 1) * step),
  }))
}

async function readSegment<T extends { id: unknown }>(
  segment: IdSegment,
  fetchPage: (q: KeysetQuery) => Promise<T[]>,
  pageSize: number,
): Promise<T[]> {
  const out: T[] = []
  let after: string | null = null
  for (;;) {
    const rows: T[] = await fetchPage({ ...segment, after })
    out.push(...rows)
    if (rows.length < pageSize) return out
    after = String(rows[rows.length - 1].id)
  }
}

/** 撈完整份。parallel＝1 就是原本的循序版；其他值切段並行，結果的集合與順序都與循序版相同 */
export async function fetchKeysetAll<T extends { id: unknown }>(
  fetchPage: (q: KeysetQuery) => Promise<T[]>,
  parallel = 1,
  pageSize = KEYSET_PAGE_SIZE,
): Promise<T[]> {
  const parts = await Promise.all(uuidSegments(parallel).map((s) => readSegment(s, fetchPage, pageSize)))
  return parts.flat()
}
