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
 * 這筆政見所屬那場選舉的投票年份（看 elections.election_date，不把 electionId 當年份——新增的選舉 id 不是年份，#344 第二階段 A）。
 * 沒有屆別、或清單裡找不到那場選舉回 null。
 */
export function policyElectionYear(
  policy: Pick<Policy, 'electionId'>,
  elections: readonly Pick<Election, 'id' | 'electionDate'>[] | undefined,
): string | null {
  if (policy.electionId == null || !elections) return null
  const date = elections.find((e) => e.id === policy.electionId)?.electionDate
  return date ? date.slice(0, 4) : null
}

/**
 * 顯示用的西元年份。提出日期查不到時，退回所屬選舉的投票年份（要傳 elections 清單；清單裡找不到那場選舉就不採信），
 * 再查不到就退回最後更新時間的年份；都沒有回 null，交由畫面顯示「—」或整塊不顯示。
 */
export function policyYear(
  policy: Pick<Policy, 'proposedDate' | 'electionId' | 'lastUpdated'>,
  elections?: readonly Pick<Election, 'id' | 'electionDate'>[],
): string | null {
  if (policy.proposedDate) return policy.proposedDate.slice(0, 4)
  const byElection = policyElectionYear(policy, elections)
  if (byElection) return byElection
  if (policy.lastUpdated) return policy.lastUpdated.slice(0, 4)
  return null
}

/**
 * 政見清單的預設規則（2026-10-19 維護者「至少依某個規則」）：提出日期新到舊（沒有就最後更新），同時間比 id。
 * 政見 id 是隨機 UUID，只拿來當最後的平手規則，不能單獨當排序（之前好幾個清單直接用資料庫的 id 順序，等於亂序）。
 */
export function compareByPolicyDateDesc(a: Pick<Policy, 'id' | 'proposedDate' | 'lastUpdated'>, b: Pick<Policy, 'id' | 'proposedDate' | 'lastUpdated'>): number {
  return policySortDate(b) - policySortDate(a) || String(a.id).localeCompare(String(b.id))
}
