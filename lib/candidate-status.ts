import type { CandidateStatus } from '../types'

/**
 * politician_elections.candidate_status 的顯示規則單一來源。
 * not_running＝AI 推測會參選但中選會登記名單裡沒有的人：選舉頁與首頁統計一律排除，
 * 人物頁保留（歷史紀錄）。
 */
export const NOT_RUNNING: CandidateStatus = 'not_running'

export function isRunningCandidate(status: CandidateStatus | undefined): boolean {
  return status !== NOT_RUNNING
}
