import type { Election, Policy } from '../types'

/**
 * 政見清單排序用的時間戳記。優先用提出日期，查不到就退回最後更新時間；
 * 兩者都沒有（理論上不會發生，lastUpdated 是必填）就排最前面。
 */
export function policySortDate(policy: Pick<Policy, 'proposedDate' | 'lastUpdated'>): number {
  const source = policy.proposedDate ?? policy.lastUpdated
  if (!source) return 0
  const time = new Date(source).getTime()
  return Number.isNaN(time) ? 0 : time
}

/**
 * 顯示用的西元年份。提出日期查不到時，退回所屬選舉屆別
 * （`electionId` 本身就是西元年，例如 2024、2026；有傳 elections 清單時會先確認屆別存在才採信），
 * 再查不到就退回最後更新時間的年份；都沒有回 null，交由畫面顯示「—」或整塊不顯示。
 */
export function policyYear(
  policy: Pick<Policy, 'proposedDate' | 'electionId' | 'lastUpdated'>,
  elections?: Election[],
): string | null {
  if (policy.proposedDate) return policy.proposedDate.slice(0, 4)
  if (policy.electionId != null) {
    const trusted = !elections || elections.some((e) => e.id === policy.electionId)
    if (trusted) return String(policy.electionId)
  }
  if (policy.lastUpdated) return policy.lastUpdated.slice(0, 4)
  return null
}
