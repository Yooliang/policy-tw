/**
 * 讀者對政見表態（支持／反對／更在意）。前端這一側只負責打端點與記住「我投過什麼」。
 *
 * 計數以伺服器回的為準，不在本機加一：以前那顆「我支持」按鈕就是只把畫面數字 +1、
 * 什麼都沒存，重新整理就沒了，等於對使用者說謊。
 *
 * 「我投過什麼」存 localStorage 只是為了把按鈕標成已選——真正的去重在伺服器端
 * （policy_stances 對 policy_id + 來源 IP 雜湊有 UNIQUE），清掉瀏覽器資料也不會多一票。
 */

export const POLICY_STANCES = ['support', 'oppose', 'priority'] as const
export type PolicyStance = (typeof POLICY_STANCES)[number]

export interface StanceCounts {
  stance_support: number
  stance_oppose: number
  stance_priority: number
}

export interface StanceResult extends StanceCounts {
  success: true
  policy_id: string
  stance: PolicyStance
}

const STORE_KEY = 'policy-stances'

function readStore(): Record<string, PolicyStance> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? JSON.parse(raw) as Record<string, PolicyStance> : {}
  } catch {
    return {}
  }
}

export function myStance(policyId: string): PolicyStance | null {
  return readStore()[policyId] ?? null
}

function remember(policyId: string, stance: PolicyStance): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), [policyId]: stance }))
  } catch {
    // 無痕模式或停用 storage：按鈕標不起來而已，表態本身已經存進伺服器了
  }
}

export async function castPolicyStance(policyId: string, stance: PolicyStance): Promise<StanceResult> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/policy-stance`
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { apikey: key, Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ policy_id: policyId, stance }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
  }
  remember(policyId, stance)
  return body as StanceResult
}
