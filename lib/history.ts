/**
 * 查核履歷（GET /functions/v1/history）：某人物／政見／單筆貢獻被誰交、誰驗、改了什麼、有沒有裁決或還原。
 */

export type HistoryTarget = 'politician' | 'policy' | 'contribution'

export interface HistoryVerifier { agent_name: string | null; agent_tool: string | null; verdict: string; note: string | null; evidence_url: string | null; resolved_politician_id: string | null; created_at: string }
export interface HistoryEdit { table: string; record_id: string; field: string; field_label: string; old_value: unknown; new_value: unknown; applied_at: string; reverted_at: string | null; reverted_by: string | null }
export interface HistoryAdjudication { contribution_id: string; task_id: string | null; task_status: string | null; verdict: string | null; reason: string | null; agent_name: string | null; status: string; checked_urls: string[]; created_at: string }
export interface HistoryEntry {
  id: string
  contribution_type: string
  type_label: string
  summary: string
  status: string
  status_label: string
  agent_name: string | null
  agent_tool: string | null
  source_urls: string[]
  note: string | null
  review_notes: string | null
  created_at: string
  applied_at: string | null
  at: string
  reverted: boolean
  agree_count: number
  disagree_count: number
  unsure_count: number
  verifiers: HistoryVerifier[]
  edits: HistoryEdit[]
  adjudications: HistoryAdjudication[]
}
export interface HistoryOrigin { kind: 'contributions' | 'imported' | 'unknown'; note: string | null; source_url?: string | null; source_notes?: string[] }
export interface HistoryResponse {
  success: boolean
  target: HistoryTarget
  id: string
  total: number
  count: number
  has_more: boolean
  next_cursor: string | null
  origin: HistoryOrigin
  entries: HistoryEntry[]
}

export const VERDICT_LABEL: Record<string, string> = { agree: '同意', disagree: '反對', unsure: '不確定' }
export const VERDICT_CLASS: Record<string, string> = {
  agree: 'bg-emerald-100 text-emerald-800', disagree: 'bg-red-100 text-red-700', unsure: 'bg-slate-100 text-slate-600',
}
export const ADJ_VERDICT_LABEL: Record<string, string> = { uphold: '維持原貢獻', reject: '原貢獻有誤' }

function headers(): Record<string, string> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  return key ? { apikey: key, Authorization: `Bearer ${key}` } : {}
}

export async function fetchHistory(target: HistoryTarget, id: string, opts: { limit?: number; cursor?: string | null } = {}): Promise<HistoryResponse> {
  const params = new URLSearchParams({ target, id, limit: String(opts.limit ?? 20) })
  if (opts.cursor) params.set('cursor', opts.cursor)
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/history?${params}`, { headers: headers() })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
  return body as HistoryResponse
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return '（整列）'
}

export function formatTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
