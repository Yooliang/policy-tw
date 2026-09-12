/**
 * 公民提問：訪客發問／表態的兩支公開端點（無需登入）。
 * 讀取（citizen_questions／question_answers）走 composables/useCitizenQuestions.ts 直接查表；
 * 寫入一律走這裡的 edge functions，慣例沿用 lib/request-task.ts。
 */

export const QUESTION_MIN_LENGTH = 8
export const QUESTION_MAX_LENGTH = 300

/** 提問字數是否合格，與後端規則一致（8～300 字，掐頭去尾）。 */
export function isValidQuestion(v: string): boolean {
  const len = v.trim().length
  return len >= QUESTION_MIN_LENGTH && len <= QUESTION_MAX_LENGTH
}

export type Stance = 'up' | 'down'

export interface AskQuestionInput {
  question: string
  policyId?: string
  politicianId?: string
  region?: string
}

export interface AskQuestionResult {
  questionId: string
  message: string
}

export interface StanceResult {
  stanceUp: number
  stanceDown: number
}

function headers(): Record<string, string> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  return { 'Content-Type': 'application/json', ...(key ? { apikey: key, Authorization: `Bearer ${key}` } : {}) }
}

/** 送出一個提問，交給 AI 代理去查證作答。 */
export async function askQuestion(input: AskQuestionInput): Promise<AskQuestionResult> {
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      question: input.question.trim(),
      policy_id: input.policyId,
      politician_id: input.politicianId,
      region: input.region,
    }),
  })
  const body = await res.json().catch(() => null)
  if (res.status === 429) throw new Error(body?.message || '今天的提問次數已達上限，明天再試')
  if (!res.ok || !body?.success) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
  return { questionId: body.question_id, message: body.message }
}

/** 對一題表態贊同／不贊同，回傳伺服器算出的最新數字。 */
export async function voteStance(questionId: string, stance: Stance): Promise<StanceResult> {
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/question-stance`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ question_id: questionId, stance }),
  })
  const body = await res.json().catch(() => null)
  if (res.status === 429) throw new Error(body?.message || '今天的表態次數已達上限，明天再試')
  if (!res.ok || !body?.success) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
  return { stanceUp: body.stance_up, stanceDown: body.stance_down }
}
