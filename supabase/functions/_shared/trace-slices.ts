/**
 * /trace 端點的分段取資料（純函式，沒有網路、沒有環境變數，測試直接餵假的取段函式）。
 *
 * trace_events() 單次最多回 PostgREST 的 1000 列，所以大範圍要切成小段依序取：
 *   - 由新到舊依序取（不併發：同時打好幾段會互相搶資料庫資源）
 *   - 某一段回滿上限（可能還有更多）就把那一段對半再切，一路切到 minSpanMs；切到最小還是滿，標 truncated
 *   - 某一段失敗只標 partial、其餘照常；全部都失敗才丟錯
 *   - 各段的時間範圍互不重疊（[a, mid)、[mid, b)），另外還是用事件內容去一次重複
 */

export interface TraceRow {
  at: string
  kind: string
  task_id: string | null
  contribution_id: string | null
  agent_name: string | null
  detail: Record<string, unknown>
  [k: string]: unknown
}

/** 取 [since, until) 的事件（毫秒），最多 limit 列 */
export type SliceFetcher = (since: number, until: number) => Promise<TraceRow[]>

export interface CollectResult {
  rows: TraceRow[]
  /** 有任何一段切到最小還是回滿上限：事件比回傳的多 */
  truncated: boolean
  /** 有任何一段取不到 */
  partial: boolean
}

export interface CollectOptions {
  /** 第一層的段長（毫秒） */
  step: number
  /** 單次上限，與 trace_events 的 p_limit 一致 */
  limit?: number
  /** 再切的最小段長 */
  minSpanMs?: number
  /** 失敗時的記錄 */
  onError?: (e: unknown, since: number, until: number) => void
}

export function sliceKey(r: TraceRow): string {
  return [r.at, r.kind, r.task_id, r.contribution_id, r.agent_name, r.detail?.verdict ?? '', r.detail?.choice ?? '', r.detail?.question ?? ''].join('|')
}

export function dedupeRows(rows: readonly TraceRow[]): TraceRow[] {
  const seen = new Set<string>()
  const out: TraceRow[] = []
  for (const r of rows) {
    const k = sliceKey(r)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

/** [from, to) 切成每段 step 的小段，由新到舊 */
export function newestFirstSlices(from: number, to: number, step: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let a = from; a < to; a += step) out.push([a, Math.min(a + step, to)])
  return out.reverse()
}

export async function collectWindow(fetchSlice: SliceFetcher, since: number, until: number, opts: CollectOptions): Promise<CollectResult> {
  const limit = opts.limit ?? 1000
  const minSpan = opts.minSpanMs ?? 60_000
  const rows: TraceRow[] = []
  let truncated = false
  let failed = 0
  let attempted = 0

  async function one(a: number, b: number): Promise<void> {
    attempted++
    let part: TraceRow[]
    try {
      part = await fetchSlice(a, b)
    } catch (e) {
      failed++
      opts.onError?.(e, a, b)
      return
    }
    if (part.length >= limit) {
      if (b - a > minSpan) {
        // 回滿：把這段對半切（新的一半先取），不用這一次的結果
        attempted--
        const mid = a + Math.floor((b - a) / 2)
        await one(mid, b)
        await one(a, mid)
        return
      }
      truncated = true
    }
    rows.push(...part)
  }

  for (const [a, b] of newestFirstSlices(since, until, opts.step)) await one(a, b)
  if (attempted > 0 && failed === attempted) throw new Error('all slices failed')
  return { rows: dedupeRows(rows), truncated, partial: failed > 0 }
}

/** 全站快取：同一個鍵 ttlMs 內回同一份 */
export class TtlCache<T> {
  private store = new Map<string, { at: number; value: T }>()
  constructor(private ttlMs: number, private max = 32) {}
  get(key: string, now: number): T | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (now - hit.at >= this.ttlMs) {
      this.store.delete(key)
      return undefined
    }
    return hit.value
  }
  set(key: string, value: T, now: number): void {
    if (this.store.size >= this.max) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { at: now, value })
  }
}
