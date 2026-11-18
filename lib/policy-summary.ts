import type { Policy, Politician } from '../types'
import { pledgeCounts } from './pledge-origin'
import { compareByPolicyDateDesc } from './policy-date'
import { isLostCampaignPromise } from './policy-visibility'

/**
 * 全部政見的摘要（首頁的狀態圓餅圖、競選承諾／任內政見筆數用）。
 * 建置時由完整清單算好放進預渲染的 initialState，首頁就不必為了幾個數字帶整份 12 MB 的政見（#982）。
 * 瀏覽器端政見清單載完整後，改由清單即時算，口徑完全相同。
 */
export interface PolicySummary {
  total: number
  /** 各 status 的筆數（鍵是 Policy.status 的字串） */
  byStatus: Record<string, number>
  pledge: number
  term: number
}

export function summarizePolicies(policies: ReadonlyArray<Pick<Policy, 'status' | 'origin'>>): PolicySummary {
  const byStatus: Record<string, number> = {}
  for (const p of policies) {
    const key = String(p.status)
    byStatus[key] = (byStatus[key] ?? 0) + 1
  }
  const { pledge, term } = pledgeCounts(policies)
  return { total: policies.length, byStatus, pledge, term }
}

/**
 * 首頁「最新政見動態」那幾張卡：先濾掉落選的競選承諾（lib/policy-visibility.ts），再依提出日新到舊取前 N 筆。
 * 預渲染（lib/ssg/page-data.ts）與首頁畫面（pages/Home.vue）都走這一個函式，挑出來的才會是同一批。
 */
export function recentVisiblePolicies(
  policies: ReadonlyArray<Policy>,
  politicianOf: (policy: Policy) => Pick<Politician, 'elections'> | undefined,
  limit = 3,
): Policy[] {
  return policies
    .filter((p) => !isLostCampaignPromise(p, politicianOf(p)))
    .sort(compareByPolicyDateDesc)
    .slice(0, limit)
}
