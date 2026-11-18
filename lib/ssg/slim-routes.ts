import type { Lineage, Policy, Politician } from '../../types'
import { recentVisiblePolicies } from '../policy-summary'

/**
 * 首頁、/tracking、/analysis 的預渲染切片（#982）：不帶整份政見（14,000 筆、12 MB）。
 * 這支只用型別與純函式，deno 測試可以直接載入（page-data.ts 會連到 supabase client，載不進 deno）。
 * 回傳的是「蓋在基底切片上的欄位」；不是這三個路由回 null。
 */
export type SlimRouteName = 'home' | 'tracking' | 'analysis'

/** 只列用到的欄位（DataSnapshot 的子集），不 import useSupabase——那會連到 supabase client，deno 載不進來 */
export interface SlimInput { policies: Policy[]; politicians: Politician[]; lineages?: Lineage[] }
export interface SlimPart { policies?: Policy[]; politicians?: Politician[]; lineages?: Lineage[]; lineagesComplete?: boolean }

function politiciansReferencedBy(policies: Policy[], all: Politician[]): Politician[] {
  const ids = new Set(policies.map((p) => String(p.politicianId)))
  return all.filter((pl) => ids.has(String(pl.id)))
}

export function slimRoutePart(name: unknown, full: SlimInput): SlimPart | null {
  switch (name) {
    case 'home': {
      // 統計數字用 stats.policySummary（建置時由全部政見算好）；卡片只列最新 3 筆，其政治人物要在場。
      // 這 3 筆的挑法與 Home.vue 一致（recentVisiblePolicies）。
      const personById = new Map(full.politicians.map((pl) => [String(pl.id), pl]))
      const recent = recentVisiblePolicies(full.policies, (p) => personById.get(String(p.politicianId)))
      return { policies: recent, politicians: politiciansReferencedBy(recent, full.politicians) }
    }
    case 'tracking':
      // 整份政見進頁後才載（ensurePolicies）；預渲染 HTML 只帶骨架
      return {}
    case 'analysis':
      // 政策脈絡一覽（#349）只用整份脈絡；「進度過半的政見」早已移到 /tracking?focus=progress
      return { lineages: full.lineages ?? [], lineagesComplete: true }
    default:
      return null
  }
}
