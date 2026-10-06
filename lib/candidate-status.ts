import type { CandidacyStatus } from '../types'

/**
 * politician_elections.candidacy_status 的顯示規則單一來源（#345 第二階段 A：取代舊的 candidate_status＋election_result 兩欄）。
 * withdrawn＝表態不參選或登記後退選（舊的 not_running，AI 推測會參選但中選會登記名單裡沒有的人也在這裡）：
 * 選舉頁與首頁統計一律排除，人物頁保留（歷史紀錄）。
 * 空值＝傳聞（不收傳聞，空值不顯示、不算在選）。
 */
export const WITHDRAWN: CandidacyStatus = 'withdrawn'

/** 在選的（考慮、表明、已登記）或已經選完的（當選、落選）；退選與空值都不算 */
export function isRunningCandidate(status: CandidacyStatus | null | undefined): boolean {
  return !!status && status !== WITHDRAWN
}

/** 選舉結果：只有當選與落選算結果，其餘（登記階段、退選、空值）都不是——查不到就是 null，不猜 */
export function electionOutcome(status: CandidacyStatus | null | undefined): 'elected' | 'not_elected' | null {
  return status === 'elected' || status === 'not_elected' ? status : null
}

/** 給 PostgREST `.in('candidacy_status', …)` 用：在選的與選完的（isRunningCandidate 的清單形式；.neq 會把空值那幾列一起濾掉，所以不用它） */
export const RUNNING_CANDIDACY_STATUSES: CandidacyStatus[] = ['considering', 'declared', 'filed', 'elected', 'not_elected']
