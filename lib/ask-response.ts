/** 提問端點（ask）回應的解讀。純函式，不碰 import.meta.env，deno 測試可直接載入。 */

export interface AskQuestionResult {
  questionId: string
  message: string
}

/** 送出時被 Jev 先篩擋下（無關或要查私人資料）：message 是給訪客看的白話，直接顯示在表單上 */
export class AskRejectedError extends Error {
  constructor(public readonly code: 'off_topic' | 'privacy', message: string) {
    super(message)
    this.name = 'AskRejectedError'
  }
}

/** 解讀 ask 端點的回應：成功回結果，被擋丟 AskRejectedError，其他丟一般錯誤。純函式，可測。 */
export function parseAskResponse(status: number, body: any): AskQuestionResult {
  if (status === 429) throw new Error(body?.message || '今天的提問次數已達上限，明天再試')
  if (status === 400 && (body?.error === 'off_topic' || body?.error === 'privacy') && typeof body?.message === 'string' && body.message) {
    throw new AskRejectedError(body.error, body.message)
  }
  if (status < 200 || status >= 300 || !body?.success) throw new Error(body?.message || body?.error || `HTTP ${status}`)
  return { questionId: body.question_id, message: body.message }
}
