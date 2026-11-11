// /trace 的資料讀取：事件走 Edge Function `trace`（伺服器端用 service_role 呼叫 trace_events、分段合併、
// 某一段回滿 1000 列自己再切、全站模式快取 60 秒），瀏覽器不再直接打資料庫函式（匿名角色的 timeout 太短）。
// 人名搜尋走 politicians 公開讀。
import { supabasePublic } from './supabase'
import { withTimeoutAndRetry } from './retry'
import { type TraceEvent } from './trace'

export type Scope =
  | { by: 'all' }
  | { by: 'task'; id: string }
  | { by: 'contribution'; id: string }
  | { by: 'person'; id: string }

export interface TraceResult {
  rows: TraceEvent[]
  /** 有任何一段切到最小還是回滿上限，代表事件比畫面上多 */
  truncated: boolean
  /** 有幾段讀不到（其餘照常顯示） */
  partial: boolean
  /** 端點或函式還沒上線 */
  unavailable: boolean
  since: number
  until: number
}

interface TraceResponse {
  success: boolean
  rows?: TraceEvent[]
  truncated?: boolean
  partial?: boolean
  since?: number
  until?: number
  scope?: Scope['by'] | null
  error?: string
}

class UnavailableError extends Error {}

function endpoint(params: Record<string, string>): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trace?${new URLSearchParams(params)}`
}

function headers(): Record<string, string> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  return key ? { apikey: key, Authorization: `Bearer ${key}` } : {}
}

async function call(params: Record<string, string>, label: string): Promise<TraceResponse> {
  return await withTimeoutAndRetry(`trace ${label}`, async (signal) => {
    const res = await fetch(endpoint(params), { headers: headers(), signal })
    if (res.status === 404 || res.status === 503) throw new UnavailableError(`HTTP ${res.status}`)
    const body = (await res.json().catch(() => null)) as TraceResponse | null
    if (!res.ok || !body?.success) throw new Error(body?.error || `HTTP ${res.status}`)
    return body
  })
}

function toResult(b: TraceResponse, now: number): TraceResult {
  return {
    rows: b.rows ?? [],
    truncated: b.truncated === true,
    partial: b.partial === true,
    unavailable: false,
    since: b.since ?? now,
    until: b.until ?? now + 60_000,
  }
}

const unavailable = (now: number, span: number): TraceResult =>
  ({ rows: [], truncated: false, partial: false, unavailable: true, since: now - span, until: now + 60_000 })

/** 全站近 4 小時（分段、合併、快取都在伺服器端） */
export async function fetchWindow(hours = 4, now = Date.now()): Promise<TraceResult> {
  try {
    return toResult(await call({ scope: 'all', hours: String(hours) }, 'all'), now)
  } catch (e) {
    if (e instanceof UnavailableError) return unavailable(now, hours * 3_600_000)
    throw e
  }
}

/** 指定對象：近 14 天 */
export async function fetchScoped(scope: Exclude<Scope, { by: 'all' }>, now = Date.now()): Promise<TraceResult> {
  try {
    return toResult(await call({ scope: scope.by, id: scope.id }, scope.by), now)
  } catch (e) {
    if (e instanceof UnavailableError) return unavailable(now, 14 * 86_400_000)
    throw e
  }
}

/** 一個 uuid 可能是任務、交件或人物：由伺服器依序問（任務優先，再交件，再人物），有就停 */
export async function probeUuid(id: string): Promise<Exclude<Scope, { by: 'all' }> | null> {
  try {
    const b = await call({ probe: id }, 'probe')
    return b.scope && b.scope !== 'all' ? ({ by: b.scope, id } as Exclude<Scope, { by: 'all' }>) : null
  } catch (e) {
    if (e instanceof UnavailableError) return null
    throw e
  }
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
