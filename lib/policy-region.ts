import type { Policy, Politician } from '../types'

export const ALL_REGIONS = 'All'

/** 人物 id（字串）→ 人物（只用到 region）。頁面用 new Map(politicians.map(p => [String(p.id), p])) 建一次，之後每筆政見 O(1) */
export type PoliticianRegionIndex = ReadonlyMap<string, Pick<Politician, 'region'>>

/**
 * 「這條政見屬於哪個縣市」全站只有一種解釋：所屬政治人物的 region。
 * 政見追蹤頁與 AI 智能分析頁共用；選「全台」一律符合，找不到所屬政治人物（尚未載入）視為不符合。
 *
 * 第二個參數可以是人物陣列（舊寫法，每筆線性找）或 id → 人物的 Map（頁面篩 1.4 萬筆時用，
 * 以前 14.7k × 3k 次比對，每次改縣市都卡一下）。兩種寫法同一個結果。
 * 資料庫端的 policies_by_region 視圖用同一個縣市（COALESCE(regions.region, politicians.region)），按縣市載入與這裡一致。
 */
export function policyMatchesRegion(policy: Policy, politicians: readonly Politician[] | PoliticianRegionIndex, region: string): boolean {
  if (region === ALL_REGIONS) return true
  const politician = Array.isArray(politicians)
    ? (politicians as readonly Politician[]).find((c) => String(c.id) === String(policy.politicianId))
    : (politicians as PoliticianRegionIndex).get(String(policy.politicianId))
  return politician?.region === region
}
