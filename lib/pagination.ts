/** 分頁的純函式（切頁、頁碼列表）。元件見 components/Pagination.vue。 */

/** 把網址上的頁碼字串轉成合法頁碼：不是正整數就回 1，超過總頁數就回最後一頁 */
export function clampPage(raw: unknown, totalPages: number): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isInteger(n) || n < 1) return 1
  return Math.min(n, Math.max(1, totalPages))
}

export function totalPagesOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/** 取第 page 頁（從 1 起算）的項目；page 超出範圍時夾回合法範圍 */
export function slicePage<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const p = clampPage(page, totalPagesOf(items.length, pageSize))
  return items.slice((p - 1) * pageSize, p * pageSize)
}

/**
 * 頁碼列：永遠含第一頁與最後一頁，目前頁前後各 siblings 頁，中間斷開處用 'gap'（省略號）；
 * 只隔一頁的缺口直接補上那一頁，不放省略號。
 */
export function pageItems(current: number, totalPages: number, siblings = 1): Array<number | 'gap'> {
  if (totalPages <= 1) return [1]
  const cur = clampPage(current, totalPages)
  const keep = new Set<number>([1, totalPages])
  for (let i = cur - siblings; i <= cur + siblings; i++) if (i >= 1 && i <= totalPages) keep.add(i)
  const sorted = [...keep].sort((a, b) => a - b)
  const out: Array<number | 'gap'> = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const diff = sorted[i] - sorted[i - 1]
      if (diff === 2) out.push(sorted[i] - 1)
      else if (diff > 2) out.push('gap')
    }
    out.push(sorted[i])
  }
  return out
}
