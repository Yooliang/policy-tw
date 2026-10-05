import type { RouteLocationNormalized } from 'vue-router'
import { withElectionData, type DataSnapshot } from '../../composables/useSupabase'
import { PolicyStatus, type Policy, type Politician } from '../../types'
import { isRunningCandidate } from '../candidate-status'
import { policySortDate } from '../policy-date'
import { isCounty, SPECIAL_MUNICIPALITIES } from '../election-regions'
import { electionPeers } from '../election-peers'
import { positionsToLoad } from '../election-levels'
import { DIRECTORY_POSITION_TYPES, type DirectoryPerson } from '../township-directory'
import { sameRegionName } from '../region-name'
import { inTownship } from '../election-townships'

/**
 * 預渲染每一頁時，全域資料狀態只放「這一頁渲染會用到」的切片。
 * 同一份切片會序列化進 HTML 的 initialState，客戶端 hydrate 前套回去，
 * 所以建置端與客戶端第一次渲染看到的資料完全相同，不會 hydration mismatch。
 * 這個模組是純函式，建置端與客戶端共用。
 */
export type PageSnapshot = DataSnapshot

/**
 * 全台頁要帶的職位：跟 useSupabase.loadPoliticiansByElection 的全台層同一份（lib/election-levels.ts 的
 * positionsToLoad）＝這一層（總統副總統）＋下一層（各縣市長）。
 *
 * 2026-10-05（#348）起直接從分層設定推，不再另抄一份——抄的那份多帶一種職位，
 * hydrate 之後畫面會先有人再消失；少帶一種，預渲染的 HTML 就少一整塊。
 */
export const NATIONAL_ELECTION_TYPES: readonly string[] = positionsToLoad({ region: 'All', subRegion: 'All', isSpecialMunicipality: false })

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
    verificationSources: [],
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
      // 2026-09-22：快照不帶政見的話，預渲染 HTML 每張候選人卡都是「0 項政見」（爬蟲與分享預覽看到的就是這份）。
      // 只塞該屆的（2026 屆 223 筆），policiesComplete 照舊 false，瀏覽器端 ensurePolicies() 仍會抓整份。
      const policies = full.policies.filter((p) => p.electionId === electionId)
      return { ...base, politicians, policies }
    }

    case 'election-region': {
      // 縣市頁：該屆該縣市「這一層＋下一層」在選的人（縣市長、立委、議員，加上鄉鎮市長／
      // 原住民區長），跟瀏覽器端 loadPoliticiansByElection(id, 縣市) 撈的是同一批。
      // 2026-10-04 起依層級切，不再把整個縣市所有層級都塞進 initialState——高雄市那是 1,769 人，
      // 而這一頁真正要顯示的是 128 人。這份清單一定要跟 positionsToLoad 的縣市層同步，
      // 多帶一種職位，hydrate 之後畫面會先有人再消失。
      // 選舉區對應表只帶這個縣市（右側鄉鎮篩選要用）
      const electionId = Number(paramString(to.params.electionId))
      const region = paramString(to.params.region)
      if (!isCounty(region)) return base
      const countyPositions = positionsToLoad({
        region,
        subRegion: 'All',
        isSpecialMunicipality: SPECIAL_MUNICIPALITIES.includes(region as typeof SPECIAL_MUNICIPALITIES[number]),
      })
      const politicians = full.politicians
        .filter((pl) => pl.elections?.some((e) =>
          e.electionId === electionId && sameRegionName(e.region, region) && isRunningCandidate(e.candidateStatus)
          && countyPositions.includes(e.electionType as typeof countyPositions[number]),
        ))
        .map((pl) => withElectionData(pl, electionId))
      // 鄉鎮市區名錄：這一頁唯一通往村里長人物頁的連結（13,338 位，爬蟲只能從這裡走到）。
      // 卡片分層之後只有「這一層＋下一層」，所以名錄要另外切一份——只帶姓名、職位、
      // 鄉鎮、村里四個欄位，塞進 initialState 的量遠小於整份人物物件。
      // 層級清單跟瀏覽器端那支輕量查詢讀同一份（lib/township-directory.ts）。
      const townshipDirectory: DirectoryPerson[] = full.politicians.flatMap((pl) => {
        const rec = (pl.elections ?? []).find((e) =>
          e.electionId === electionId && sameRegionName(e.region, region) && isRunningCandidate(e.candidateStatus)
          && DIRECTORY_POSITION_TYPES.includes(e.electionType ?? ''),
        )
        return rec
          ? [{
              politicianId: String(pl.id),
              name: pl.name,
              electionType: rec.electionType ?? '',
              subRegion: rec.subRegion ?? null,
              village: rec.village ?? null,
            }]
          : []
      })
      const ids = new Set(politicians.map((pl) => String(pl.id)))
      const policies = full.policies.filter((p) => p.electionId === electionId && ids.has(String(p.politicianId)))
      const electoralDistrictAreas = full.electoralDistrictAreas.filter((m) => m.region === region)
      return { ...base, politicians, policies, electoralDistrictAreas, electoralDistrictAreasPartial: true, townshipDirectory }
    }

    case 'election-township': {
      // 鄉鎮頁（2026-10-05）：該屆該鄉鎮「這一層＋下一層」在選的人（鄉鎮市長、代表／原住民區長、區代表，加上村里長），
      // 跟瀏覽器端 loadPoliticiansByElection(id, 縣市, 鄉鎮) 撈的是同一批：職位照 positionsToLoad 的鄉鎮層，
      // 鄉鎮比對照 get_politicians_by_level 的規則（lib/election-townships.ts 的 inTownship，原住民區代表的
      // 「那瑪夏區第01選舉區」也算那瑪夏區）。選舉區對應表帶整個縣市：右側的鄉鎮市區連結要列全縣市。
      const electionId = Number(paramString(to.params.electionId))
      const region = paramString(to.params.region)
      const township = paramString(to.params.subRegion)
      if (!isCounty(region) || !township) return base
      const townshipPositions = positionsToLoad({
        region,
        subRegion: township,
        isSpecialMunicipality: SPECIAL_MUNICIPALITIES.includes(region as typeof SPECIAL_MUNICIPALITIES[number]),
      })
      const politicians = full.politicians
        .filter((pl) => pl.elections?.some((e) =>
          e.electionId === electionId && sameRegionName(e.region, region) && isRunningCandidate(e.candidateStatus)
          && townshipPositions.includes(e.electionType as typeof townshipPositions[number])
          && inTownship(e.subRegion, township),
        ))
        .map((pl) => withElectionData(pl, electionId))
      const ids = new Set(politicians.map((pl) => String(pl.id)))
      const policies = full.policies.filter((p) => p.electionId === electionId && ids.has(String(p.politicianId)))
      const electoralDistrictAreas = full.electoralDistrictAreas.filter((m) => m.region === region)
      return { ...base, politicians, policies, electoralDistrictAreas, electoralDistrictAreasPartial: true }
    }

    case 'politician': {
      const id = paramString(to.params.politicianId)
      const self = full.politicians.filter((pl) => String(pl.id) === id)
      // 同選區其他候選人（lib/election-peers.ts；邊緣 SSR 的 loadPoliticianPage 算的是同一份）
      const politicians = [...self, ...electionPeers(self[0], full.politicians)]
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

    case 'sources':
      return { ...base, verificationSources: full.verificationSources }

    default:
      return base
  }
}
