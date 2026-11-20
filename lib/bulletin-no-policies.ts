/**
 * 公報未填政見（2026-11-20）：人物頁某一屆的政見區塊要不要多寫一句「公報未填政見」。
 * 參選紀錄標了 noPoliciesAt（選舉公報上他的政見欄沒有任何政策條目）才有；沒標就是 null，畫面照舊。
 * 同一人同一屆有多筆職位時，任何一筆有標就算；出處取第一筆有網址的。
 */

export interface NoPoliciesElection {
  electionId: number
  noPoliciesAt?: string | null
  noPoliciesSourceUrl?: string | null
}

export interface NoPoliciesNote {
  /** 公報網址（出處）；只放 http(s)，其餘當沒有 */
  url: string | null
}

export function noPoliciesNoteOf(
  elections: ReadonlyArray<NoPoliciesElection> | null | undefined,
  electionId: number | null,
): NoPoliciesNote | null {
  if (electionId === null) return null
  const marked = (elections ?? []).filter(e => e.electionId === electionId && !!e.noPoliciesAt)
  if (marked.length === 0) return null
  const url = marked.map(e => e.noPoliciesSourceUrl ?? '').find(u => /^https?:\/\//.test(u)) ?? null
  return { url }
}

export const NO_POLICIES_TEXT = '公報未填政見'
