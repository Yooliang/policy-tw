import type { RouteLocationNormalized } from 'vue-router'
import { withElectionData, type DataSnapshot } from '../../composables/useSupabase'
import { PolicyStatus, type Policy, type Politician } from '../../types'
import { isRunningCandidate } from '../candidate-status'
import { policySortDate } from '../policy-date'

/**
 * 預渲染每一頁時，全域資料狀態只放「這一頁渲染會用到」的切片。
 * 同一份切片會序列化進 HTML 的 initialState，客戶端 hydrate 前套回去，
 * 所以建置端與客戶端第一次渲染看到的資料完全相同，不會 hydration mismatch。
 * 這個模組是純函式，建置端與客戶端共用。
 */
export type PageSnapshot = DataSnapshot

/** 與 useSupabase.loadPoliticiansByElection 全國模式一致：全台只載入這三類。 */
export const NATIONAL_ELECTION_TYPES = ['總統副總統', '立法委員', '縣市長']

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function politiciansReferencedBy(policies: Policy[], all: Politician[]): Politician[] {
  const ids = new Set(policies.map((p) => String(p.politicianId)))
  return all.filter((pl) => ids.has(String(pl.id)))
}

/** 與 PolicyDeepAnalysis.relayChain 同邏輯：沿 relatedPolicyIds 雙向走訪整條接力鏈（含起點）。 */
export function collectRelayChainIds(startId: string, policies: Policy[]): Set<string> {
  const visited = new Set<string>()
  const queue = [startId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const current = policies.find((p) => String(p.id) === String(id))
    if (!current) continue
    current.relatedPolicyIds?.forEach((rid) => { if (!visited.has(rid)) queue.push(rid) })
    policies.forEach((other) => {
      if (other.relatedPolicyIds?.includes(id) && !visited.has(other.id)) queue.push(other.id)
    })
  }
  return visited
}

/**
 * 與 PolicyAnalysis.relayCases 同邏輯：分析列表實際會連到哪些 /analysis/:policyId。
 * （有接力鏈的取鏈尾；否則非競選承諾且進度 > 50 的政見。）
 */
export function analysisListedPolicyIds(policies: Policy[]): string[] {
  const visited = new Set<string>()
  const targets: string[] = []
  for (const policy of policies) {
    if (visited.has(policy.id)) continue
    if (policy.relatedPolicyIds && policy.relatedPolicyIds.length > 0) {
      const chain = policies
        .filter((p) => p.id === policy.id || policy.relatedPolicyIds?.includes(p.id) || p.relatedPolicyIds?.includes(policy.id))
        .sort((a, b) => policySortDate(a) - policySortDate(b))
      chain.forEach((p) => visited.add(p.id))
      targets.push(chain[chain.length - 1].id)
    } else if (policy.status !== PolicyStatus.CAMPAIGN && policy.progress > 50) {
      visited.add(policy.id)
      targets.push(policy.id)
    }
  }
  return Array.from(new Set(targets))
}

function emptySnapshot(full: DataSnapshot): PageSnapshot {
  return {
    // 基底切片的 policies 是空的或只有幾筆，一律不算完整。
    // 只有下面明確塞 full.policies 的那三個路由會把它翻成 true。
    policiesComplete: false,
    generatedAt: full.generatedAt,
    elections: full.elections,
    categories: full.categories,
    locations: full.locations,
    regionStats: [],
    electoralDistrictAreas: [],
    policies: [],
    politicians: [],
    discussions: [],
    stats: full.stats,
  }
}

/** 依路由決定要嵌進頁面的資料切片。找不到對應資料時回傳基底切片，頁面自己會顯示「找不到」。 */
export function buildPageSnapshot(to: RouteLocationNormalized, full: DataSnapshot): PageSnapshot {
  const base = emptySnapshot(full)

  switch (to.name) {
    case 'home':
      // 統計數字要全部政見；卡片只列最新 3 筆，其政治人物要在場
      return { ...base, policiesComplete: true, policies: full.policies, politicians: politiciansReferencedBy(full.policies.slice(0, 3), full.politicians) }

    case 'tracking':
    case 'analysis':
      return { ...base, policiesComplete: true, policies: full.policies, politicians: politiciansReferencedBy(full.policies, full.politicians) }

    case 'policy': {
      const id = paramString(to.params.policyId)
      const policy = full.policies.find((p) => String(p.id) === id)
      if (!policy) return base
      const keep = collectRelayChainIds(policy.id, full.policies)
      full.policies
        .filter((p) => String(p.politicianId) === String(policy.politicianId))
        .forEach((p) => keep.add(p.id))
      const policies = full.policies.filter((p) => keep.has(p.id))
      return { ...base, policies, politicians: politiciansReferencedBy(policies, full.politicians) }
    }

    case 'analysis-detail': {
      const id = paramString(to.params.policyId)
      const chain = collectRelayChainIds(id, full.policies)
      const policies = full.policies.filter((p) => chain.has(p.id))
      return { ...base, policies, politicians: politiciansReferencedBy(policies, full.politicians) }
    }

    case 'election': {
      const electionId = Number(paramString(to.params.electionId))
      const politicians = full.politicians
        .filter((pl) => pl.elections?.some((e) =>
          e.electionId === electionId
          && NATIONAL_ELECTION_TYPES.includes(e.electionType || '')
          && isRunningCandidate(e.candidateStatus),
        ))
        .map((pl) => withElectionData(pl, electionId))
      return { ...base, politicians }
    }

    case 'politician': {
      const id = paramString(to.params.politicianId)
      const politicians = full.politicians.filter((pl) => String(pl.id) === id)
      const policies = full.policies.filter((p) => String(p.politicianId) === id)
      return { ...base, politicians, policies }
    }

    case 'community':
      return { ...base, discussions: full.discussions }

    case 'discussion': {
      const id = Number(paramString(to.params.discussionId))
      const discussion = full.discussions.find((d) => d.id === id)
      if (!discussion) return base
      return {
        ...base,
        discussions: full.discussions.filter((d) => d.policyId === discussion.policyId),
        policies: full.policies.filter((p) => String(p.id) === String(discussion.policyId)),
      }
    }

    case 'regional-data':
      return { ...base, regionStats: full.regionStats }

    default:
      return base
  }
}
