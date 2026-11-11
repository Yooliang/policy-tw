// /trace 的資料讀取：只走匿名 client（supabasePublic）。
// 事件來自 SQL 函式 trace_events()；人名走 politicians 公開讀。
// PostgREST 單次最多回 1000 列，所以時間切小段分次取（每段回滿 1000 列就標「不完整」）。
import { supabasePublic } from './supabase'
import { isMissingFunction, withTimeoutAndRetry } from './retry'
import { dedupe, timeSlices, type TraceEvent } from './trace'

/** PostgREST 單次回傳上限（與伺服器 max-rows 一致） */
export const PAGE_ROWS = 1000
const HOUR = 3_600_000
const DAY = 24 * HOUR

export type Scope =
  | { by: 'all' }
  | { by: 'task'; id: string }
  | { by: 'contribution'; id: string }
  | { by: 'person'; id: string }

export interface TraceResult {
  rows: TraceEvent[]
  /** 有任何一段回滿上限，代表事件比畫面上多 */
  truncated: boolean
  /** 有幾段讀不到（其餘照常顯示） */
  partial: boolean
  /** 函式還沒上線（前端比 migration 早幾分鐘） */
  unavailable: boolean
  since: number
  until: number
}

function params(scope: Scope, since: number, until: number): Record<string, unknown> {
  return {
    p_task_id: scope.by === 'task' ? scope.id : null,
    p_contribution_id: scope.by === 'contribution' ? scope.id : null,
    p_politician_id: scope.by === 'person' ? scope.id : null,
    p_since: new Date(since).toISOString(),
    p_until: new Date(until).toISOString(),
    p_limit: PAGE_ROWS,
  }
}

async function fetchSlice(scope: Scope, since: number, until: number, label: string): Promise<TraceEvent[]> {
  const { data } = await withTimeoutAndRetry(`trace ${label}`, (signal) =>
    supabasePublic.rpc('trace_events', params(scope, since, until)).abortSignal(signal).throwOnError())
  return (data ?? []) as TraceEvent[]
}

/**
 * 依序取每一段（不併發：同時打好幾段會互相搶資料庫資源，單段反而逾時）。
 * 單一段失敗不讓整頁失敗：記為 partial，其餘照常；全部段都失敗才丟錯。
 * 每取完一段呼叫 onSlice（累計結果），讓畫面可以先畫出已經到的部分。
 */
async function fetchSlices(
  scope: Scope,
  slices: Array<[number, number]>,
  onSlice?: (rows: TraceEvent[], partial: boolean, truncated: boolean) => void,
): Promise<{ rows: TraceEvent[]; truncated: boolean; partial: boolean }> {
  let rows: TraceEvent[] = []
  let truncated = false
  let failed = 0
  let lastError: unknown = null
  for (const [a, b] of slices) {
    try {
      const part = await fetchSlice(scope, a, b, scope.by)
      if (part.length >= PAGE_ROWS) truncated = true
      rows = dedupe([...rows, ...part])
    } catch (e) {
      if (isMissingFunction(e)) throw e
      failed++
      lastError = e
      console.info('[重播] 有一段讀不到', e)
    }
    onSlice?.(rows, failed > 0, truncated)
  }
  if (failed === slices.length && failed > 0) throw lastError
  return { rows, truncated, partial: failed > 0 }
}

/** 全站近 4 小時：切 30 分鐘一段，由新到舊依序取（先到的最近時段可以先畫） */
export async function fetchWindow(hours = 4, now = Date.now(), onSlice?: (r: TraceResult) => void): Promise<TraceResult> {
  const since = now - hours * HOUR
  const until = now + 60_000
  const slices = timeSlices(since, until, HOUR / 2).reverse()
  try {
    const r = await fetchSlices({ by: 'all' }, slices, onSlice
      ? (rows, partial, truncated) => onSlice({ rows, truncated, partial, unavailable: false, since, until })
      : undefined)
    return { ...r, unavailable: false, since, until }
  } catch (e) {
    if (isMissingFunction(e)) return { rows: [], truncated: false, partial: false, unavailable: true, since, until }
    throw e
  }
}

/** 指定對象：近 14 天，切 3 天一段 */
export async function fetchScoped(scope: Exclude<Scope, { by: 'all' }>, now = Date.now()): Promise<TraceResult> {
  const since = now - 14 * DAY
  const until = now + 60_000
  try {
    const r = await fetchSlices(scope, timeSlices(since, until, 3 * DAY).reverse())
    return { ...r, unavailable: false, since, until }
  } catch (e) {
    if (isMissingFunction(e)) return { rows: [], truncated: false, partial: false, unavailable: true, since, until }
    throw e
  }
}

/** 一個 uuid 可能是任務、交件或人物：各問一筆看哪個有事件（任務優先，再交件，再人物） */
export async function probeUuid(id: string, now = Date.now()): Promise<Exclude<Scope, { by: 'all' }> | null> {
  const since = now - 14 * DAY
  const until = now + 60_000
  const scopes: Array<Exclude<Scope, { by: 'all' }>> = [{ by: 'task', id }, { by: 'contribution', id }, { by: 'person', id }]
  // 依序問（任務優先），有就停
  for (const s of scopes) {
    const { data } = await withTimeoutAndRetry(`trace probe ${s.by}`, (signal) =>
      supabasePublic.rpc('trace_events', { ...params(s, since, until), p_limit: 1 }).abortSignal(signal).throwOnError())
    if (Array.isArray(data) && data.length > 0) return s
  }
  return null
}

export interface PersonHit { id: string; name: string; party: string | null; region: string | null; current_position: string | null }

/** 逗號、百分號、底線在 ilike 裡有特殊意思，先擋掉 */
const escapeLike = (s: string): string => s.replace(/[%_\\,()]/g, (m) => `\\${m}`)

export async function searchPeople(text: string): Promise<PersonHit[]> {
  const like = `*${escapeLike(text.trim())}*`
  const { data } = await withTimeoutAndRetry('trace people', (signal) =>
    supabasePublic.from('politicians').select('id, name, party, region, current_position').ilike('name', like).limit(20).abortSignal(signal).throwOnError())
  return (data ?? []) as PersonHit[]
}

/** 人物 id → 姓名（一次最多 60 個） */
export async function fetchNames(ids: readonly string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)].slice(0, 60)
  if (unique.length === 0) return {}
  const { data } = await withTimeoutAndRetry('trace names', (signal) =>
    supabasePublic.from('politicians').select('id, name').in('id', unique).limit(60).abortSignal(signal).throwOnError())
  const out: Record<string, string> = {}
  for (const r of (data ?? []) as Array<{ id: string; name: string }>) out[r.id.toLowerCase()] = r.name
  return out
}
