/**
 * 網站「請 AI 幫忙查」：打公開端點 request-task，把目標丟進貢獻任務池（無需登入）。
 * 舊的 ai-classify 管線已停擺，這是唯一入口。
 */

export type RequestKind = 'policy' | 'profile' | 'progress' | 'validity' | 'audit'

export interface RequestTaskResult {
  status: 'queued' | 'already_queued'
  task_id: string
  queue_position: number
  open_tasks: number
  board_url: string
  message: string
}

/** 任務看板：按鈕建的任務都列在這一頁的「任務」分頁 */
export const BOARD_PATH = '/ai-assistant?tab=tasks'

function headers(): Record<string, string> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  return { 'Content-Type': 'application/json', ...(key ? { apikey: key, Authorization: `Bearer ${key}` } : {}) }
}

export interface RequestTaskInput {
  kind: RequestKind
  politician_id?: string
  policy_id?: string
  /** kind=audit：要核對的文件網址 */
  source_url?: string
  note?: string
}

/** 訪客貼的網址是否合格（http/https、可解析）；與後端 isAuditUrl 同規則 */
export function isAuditUrl(v: string): boolean {
  if (v.length > 500) return false
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export async function requestTask(input: RequestTaskInput): Promise<RequestTaskResult> {
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/request-task`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...input, requester: 'web' }),
  })
  const body = await res.json().catch(() => null)
  if (res.status === 429) throw new Error(body?.message || '今天請求次數已達上限，明天再試')
  if (!res.ok || !body?.success) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
  return body as RequestTaskResult
}

/** 成功／已存在的一句話 */
export function requestTaskMessage(r: RequestTaskResult): string {
  return r.status === 'already_queued'
    ? `這個項目已在任務池中，AI 代理會來查；目前有 ${r.queue_position} 件任務排隊`
    : `已加入任務池，AI 代理會來查；目前有 ${r.queue_position} 件任務排隊`
}
