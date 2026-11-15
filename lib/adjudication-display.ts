// 動態牆上「強模型裁決」那種貢獻的呈現：它不走投票，分數條與「0 分」沒有意義，
// 要給讀者看的是裁決結果，以及被裁的是哪一筆。純函式，不碰網路與 DOM。

export const ADJUDICATION_TYPE = 'adjudication'

const VERDICT_LABEL: Record<string, string> = {
  uphold: '原貢獻正確',
  reject: '原貢獻有誤',
  uphold_with_correction: '原貢獻部分修正後採用',
}

export function isAdjudication(contributionType: string): boolean {
  return contributionType === ADJUDICATION_TYPE
}

/** 裁決結果的中文；看不懂的代碼回 null，不要編一句話 */
export function verdictLabel(payload: Record<string, unknown> | null | undefined): string | null {
  const v = payload?.verdict
  return typeof v === 'string' ? VERDICT_LABEL[v] ?? null : null
}

/** 被裁決的原貢獻 id；沒帶或不是字串回 null */
export function adjudicatedId(payload: Record<string, unknown> | null | undefined): string | null {
  const id = payload?.contribution_id
  return typeof id === 'string' && id.length > 0 ? id : null
}
