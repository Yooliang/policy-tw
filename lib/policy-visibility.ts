import { PolicyStatus, type Policy, type Politician } from '../types'

/**
 * 政見卡的第 4 種狀態（使用者 2026-09-19）：投完票**沒有當選**的競選承諾，只在那個人自己的頁面以小卡出現，
 * 混多人的清單（首頁的最新政見、我的關注）不再列出——那些承諾已經沒有兌現的可能，放在清單裡只是雜訊。
 *
 * 只有結果明確是 not_elected 才算落選；結果查不到（過去選舉九成還是空的）不猜，照舊顯示。
 * 當選的承諾會被代理改成執行中／已完成，自然走「當選後的進度」那一種。
 */
export function isLostCampaignPromise(policy: Pick<Policy, 'status' | 'electionId'>, politician: Pick<Politician, 'elections'> | undefined): boolean {
  if (policy.status !== PolicyStatus.CAMPAIGN || policy.electionId == null || !politician) return false
  return politician.elections?.find((e) => e.electionId === policy.electionId)?.electionResult === 'not_elected'
}
