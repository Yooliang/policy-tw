import type { RouteLocationNormalized } from 'vue-router'
import { withElectionData, type DataSnapshot } from '../../composables/useSupabase'
import type { Lineage, Policy, Politician } from '../../types'
import { isRunningCandidate } from '../candidate-status'
import { isProgressCase, lineageMateIdsOf } from '../policy-chain'
import { trimPolicySources } from '../sources'
import { isCounty, SPECIAL_MUNICIPALITIES } from '../election-regions'
import { findElectionBySegment } from '../election-route'
import { electionPeers } from '../election-peers'
import { positionsToLoad } from '../election-levels'
import { DIRECTORY_POSITION_TYPES, type DirectoryPerson } from '../township-directory'
import { sameRegionName } from '../region-name'
import { inTownship } from '../election-townships'
import { buildDirectory, isGroupKey, type DirectoryGroup, type DirectoryGroupSummary } from '../people-directory'
import { partyList, partyPage, type PartySummary } from '../party-pages'

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

/** 政策脈絡頁提到的人（#349）：政見提出者、參與者、交接的前後任。預渲染與邊緣 SSR 共用 */
export function lineagePeople(lineage: Lineage, policies: readonly Policy[]): string[] {
  return [...new Set([
    ...policies.map((p) => String(p.politicianId)),
    ...lineage.participants.map((p) => p.politicianId),
    ...lineage.handovers.flatMap((h) => [h.fromPoliticianId, h.toPoliticianId]),
  ])]
}

function politiciansReferencedBy(policies: Policy[], all: Politician[]): Politician[] {
  const ids = new Set(policies.map((p) => String(p.politicianId)))
  return all.filter((pl) => ids.has(String(pl.id)))
}

/**
 * 分析列表實際會連到哪些 /analysis/:policyId：不是競選承諾而且進度過半的政見（lib/policy-chain.ts 的 isProgressCase，
 * PolicyAnalysis 頁面用同一支）。#349 第二階段 A 之前這裡還有一支「沿 related_policies 取接力鏈尾」，那張表線上 0 列、已拿掉。
 */
export function analysisListedPolicyIds(policies: Policy[]): string[] {
  return policies.filter(isProgressCase).map((p) => p.id)
}

/**
 * 人物一覽、政黨一覽（#346）：每一頁都要從整份名冊算，一萬六千位算一次就好——同一份 full 記住結果。
 * 建置端的 full 整個建置期間是同一個物件。
 */
const directoryMemo = new WeakMap<DataSnapshot, { index: DirectoryGroupSummary[]; groups: Map<string, DirectoryGroup> }>()
const partyListMemo = new WeakMap<DataSnapshot, PartySummary[]>()

/** 判斷「投完票了沒」用的今天：快照的建置日（台北時間），預渲染整個建置期間是同一天 */
function snapshotDay(full: DataSnapshot): string {
  return new Date((full.generatedAt ?? Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

export function directoryFor(full: DataSnapshot): { index: DirectoryGroupSummary[]; groups: Map<string, DirectoryGroup> } {
  let d = directoryMemo.get(full)
  if (!d) {
    d = buildDirectory(full.politicians, full.elections, snapshotDay(full))
    directoryMemo.set(full, d)
  }
  return d
}

/** 政黨一覽（有人屬於它的政黨）；建置端沒載到政黨表就是空的 */
export function partyListFor(full: DataSnapshot): PartySummary[] {
  if (!full.partyRegistry) return []
  let list = partyListMemo.get(full)
  if (!list) {
    list = partyList(full.politicians, full.partyRegistry)
    partyListMemo.set(full, list)
  }
  return list
}

/** 網址上的選舉那一段（舊三屆是 id、新增的選舉是 election_key）→ elections.id；找不到回 NaN（頁面會顯示找不到） */
function electionIdOfParam(full: DataSnapshot, param: string | undefined): number {
  return findElectionBySegment(full.elections, param)?.id ?? NaN
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
  return trimPolicySources(buildPageSnapshotRaw(to, full), to.name === 'policy' ? paramString(to.params.policyId) : undefined)
}

function buildPageSnapshotRaw(to: RouteLocationNormalized, full: DataSnapshot): PageSnapshot {
  const base = emptySnapshot(full)

  switch (to.name) {
    case 'home':
      // 統計數字要全部政見；卡片只列最新 3 筆，其政治人物要在場
      return { ...base, policiesComplete: true, policies: full.policies, politicians: politiciansReferencedBy(full.policies.slice(0, 3), full.politicians) }

    case 'tracking':
      return { ...base, policiesComplete: true, policies: full.policies, politicians: politiciansReferencedBy(full.policies, full.politicians) }

    case 'analysis':
      // 政策脈絡一覽（#349）：整份脈絡＋原本的「進度過半的政見」要的整份政見
      return {
        ...base, policiesComplete: true, policies: full.policies, politicians: politiciansReferencedBy(full.policies, full.politicians),
        lineages: full.lineages ?? [], lineagesComplete: true,
      }

    case 'lineage': {
      // 政策脈絡頁（#349）：那一條＋它的政見＋提到的人（邊緣 SSR 的 loadLineagePage 算的是同一份）
      const id = paramString(to.params.lineageId)
      const lineage = (full.lineages ?? []).find((l) => l.id === id)
      if (!lineage) return base
      const ids = new Set(lineage.policyIds)
      const policies = full.policies.filter((p) => ids.has(String(p.id)))
      const people = new Set(lineagePeople(lineage, policies))
      const politicians = full.politicians.filter((pl) => people.has(String(pl.id)))
      return { ...base, policies, politicians, lineages: [lineage], lineagesComplete: false }
    }

    case 'policy': {
      const id = paramString(to.params.policyId)
      const policy = full.policies.find((p) => String(p.id) === id)
      if (!policy) return base
      const keep = lineageMateIdsOf(policy.id, full.policies)
      full.policies
        .filter((p) => String(p.politicianId) === String(policy.politicianId))
        .forEach((p) => keep.add(p.id))
      const policies = full.policies.filter((p) => keep.has(p.id))
      return { ...base, policies, politicians: politiciansReferencedBy(policies, full.politicians) }
    }

    case 'analysis-detail': {
      const id = paramString(to.params.policyId)
      const chain = lineageMateIdsOf(id, full.policies)
      const policies = full.policies.filter((p) => chain.has(p.id))
      return { ...base, policies, politicians: politiciansReferencedBy(policies, full.politicians) }
    }

    case 'election': {
      const electionId = electionIdOfParam(full, paramString(to.params.electionId))
      const politicians = full.politicians
        .filter((pl) => pl.elections?.some((e) =>
          e.electionId === electionId
          && NATIONAL_ELECTION_TYPES.includes(e.electionType || '')
          && isRunningCandidate(e.candidacyStatus),
        ))
        .map((pl) => withElectionData(pl, electionId))
      // 2026-09-22：快照不帶政見的話，預渲染 HTML 每張候選人卡都是「0 項政見」（爬蟲與分享預覽看到的就是這份）。
      // 只塞該屆的（2026 屆 223 筆），policiesComplete 照舊 false，瀏覽器端 ensurePolicies() 仍會抓整份。
      const policies = full.policies.filter((p) => p.electionId === electionId)
      return { ...base, politicians, policies }
    }

    case 'election-matrix':
      // 政見矩陣頁：資料是預產快取的 _matrix 那一列，建置端撈好放在 full.policyMatrix；那一屆對不上就不帶（頁面自己顯示「沒有矩陣」）
      return full.policyMatrix && full.policyMatrix.election.segment === paramString(to.params.electionId) ? { ...base, policyMatrix: full.policyMatrix } : base

    case 'election-region': {
      // 縣市頁：該屆該縣市「這一層＋下一層」在選的人（縣市長、立委、議員，加上鄉鎮市長／
      // 原住民區長），跟瀏覽器端 loadPoliticiansByElection(id, 縣市) 撈的是同一批。
      // 2026-10-04 起依層級切，不再把整個縣市所有層級都塞進 initialState——高雄市那是 1,769 人，
      // 而這一頁真正要顯示的是 128 人。這份清單一定要跟 positionsToLoad 的縣市層同步，
      // 多帶一種職位，hydrate 之後畫面會先有人再消失。
      // 選舉區對應表只帶這個縣市（右側鄉鎮篩選要用）
      const electionId = electionIdOfParam(full, paramString(to.params.electionId))
      const region = paramString(to.params.region)
      if (!isCounty(region)) return base
      const countyPositions = positionsToLoad({
        region,
        subRegion: 'All',
        isSpecialMunicipality: SPECIAL_MUNICIPALITIES.includes(region as typeof SPECIAL_MUNICIPALITIES[number]),
      })
      const politicians = full.politicians
        .filter((pl) => pl.elections?.some((e) =>
          e.electionId === electionId && sameRegionName(e.region, region) && isRunningCandidate(e.candidacyStatus)
          && countyPositions.includes(e.electionType as typeof countyPositions[number]),
        ))
        .map((pl) => withElectionData(pl, electionId))
      // 鄉鎮市區名錄：這一頁唯一通往村里長人物頁的連結（13,338 位，爬蟲只能從這裡走到）。
      // 卡片分層之後只有「這一層＋下一層」，所以名錄要另外切一份——只帶姓名、職位、
      // 鄉鎮、村里四個欄位，塞進 initialState 的量遠小於整份人物物件。
      // 層級清單跟瀏覽器端那支輕量查詢讀同一份（lib/township-directory.ts）。
      const townshipDirectory: DirectoryPerson[] = full.politicians.flatMap((pl) => {
        const rec = (pl.elections ?? []).find((e) =>
          e.electionId === electionId && sameRegionName(e.region, region) && isRunningCandidate(e.candidacyStatus)
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
      const electionId = electionIdOfParam(full, paramString(to.params.electionId))
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
          e.electionId === electionId && sameRegionName(e.region, region) && isRunningCandidate(e.candidacyStatus)
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

    case 'politicians':
      // 人物一覽的索引：每一組（筆畫）有哪些姓、幾位
      return { ...base, peopleIndex: directoryFor(full).index }

    case 'politicians-group': {
      // 一組（例：十一畫）的名單：id、姓名、一行說明；網址的組名認不得就給基底切片（頁面顯示找不到、noindex）
      const key = paramString(to.params.group)
      const group = isGroupKey(key) ? directoryFor(full).groups.get(key) : undefined
      return group ? { ...base, peopleIndex: directoryFor(full).index, peopleGroup: group } : base
    }

    case 'parties':
      return { ...base, partyList: partyListFor(full) }

    case 'party': {
      const id = Number(paramString(to.params.partyId))
      const page = Number.isInteger(id) && full.partyRegistry ? partyPage(id, full.politicians, full.partyRegistry, full.elections, snapshotDay(full)) : null
      return page ? { ...base, partyPage: page } : base
    }

    case 'sources':
      return { ...base, verificationSources: full.verificationSources }

    default:
      return base
  }
}
