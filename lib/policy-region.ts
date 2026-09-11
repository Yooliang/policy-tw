import type { Policy, Politician } from '../types'

export const ALL_REGIONS = 'All'

/**
 * 「這條政見屬於哪個縣市」全站只有一種解釋：所屬政治人物的 region。
 * 政見追蹤頁與 AI 智能分析頁共用；選「全台」一律符合，找不到所屬政治人物（尚未載入）視為不符合。
 */
export function policyMatchesRegion(policy: Policy, politicians: Politician[], region: string): boolean {
  if (region === ALL_REGIONS) return true
  const politician = politicians.find((c) => String(c.id) === String(policy.politicianId))
  return politician?.region === region
}
