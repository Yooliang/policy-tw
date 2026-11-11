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

/** 一次取一整段，同時最多 4 個請求 */
async function fetchSlices(scope: Scope, slices: Array<[number, number]>): Promise<{ rows: TraceEvent[]; truncated: boolean }> {
  const rows: TraceEvent[] = []
  let truncated = false
  for (let i = 0; i < slices.length; i += 4) {
    const batch = await Promise.all(slices.slice(i, i + 4).map(([a, b]) => fetchSlice(scope, a, b, scope.by)))
    for (const part of batch) {
      if (part.length >= PAGE_ROWS) truncated = true
      rows.push(...part)
    }
  }
  return { rows: dedupe(rows), truncated }
}

/** 全站近 4 小時：切 30 分鐘一段 */
export async function fetchWindow(hours = 4, now = Date.now()): Promise<TraceResult> {
  const since = now - hours * HOUR
  const until = now + 60_000
  try {
    const r = await fetchSlices({ by: 'all' }, timeSlices(since, until, HOUR / 2))
    return { ...r, unavailable: false, since, until }
  } catch (e) {
    if (isMissingFunction(e)) return { rows: [], truncated: false, unavailable: true, since, until }
    throw e
  }
}

/** 指定對象：近 14 天，切 3 天一段 */
export async function fetchScoped(scope: Exclude<Scope, { by: 'all' }>, now = Date.now()): Promise<TraceResult> {
  const since = now - 14 * DAY
  const until = now + 60_000
  try {
    const r = await fetchSlices(scope, timeSlices(since, until, 3 * DAY))
    return { ...r, unavailable: false, since, until }
  } catch (e) {
    if (isMissingFunction(e)) return { rows: [], truncated: false, unavailable: true, since, until }
    throw e
  }
}

/** 一個 uuid 可能是任務、交件或人物：各問一筆看哪個有事件（任務優先，再交件，再人物） */
export async function probeUuid(id: string, now = Date.now()): Promise<Exclude<Scope, { by: 'all' }> | null> {
  const since = now - 14 * DAY
  const until = now + 60_000
  const scopes: Array<Exclude<Scope, { by: 'all' }>> = [{ by: 'task', id }, { by: 'contribution', id }, { by: 'person', id }]
  const hits = await Promise.all(scopes.map(async (s) => {
    const { data } = await withTimeoutAndRetry(`trace probe ${s.by}`, (signal) =>
      supabasePublic.rpc('trace_events', { ...params(s, since, until), p_limit: 1 }).abortSignal(signal).throwOnError())
    return Array.isArray(data) && data.length > 0
  }))
  const i = hits.findIndex(Boolean)
  return i < 0 ? null : scopes[i]
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
