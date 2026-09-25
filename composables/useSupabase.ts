import { displayCurrentPosition, participationLabel } from '../lib/participation-label'
import { ref } from 'vue'
import { supabasePublic as supabase } from '../lib/supabase'
import type {
  Election, Politician, Policy, Discussion, TrackingLog, PoliticianElectionData,
  RegionStats, ElectoralDistrictArea, ElectionTypeTableRow,
  RawElection, RawPolitician, RawPoliticianElectionData,
  RawPolicy, RawTrackingLog, RawDiscussion, RawDiscussionComment, RawCommentReply,
  RawElectionTypeRow,
} from '../types'
import { ElectionType } from '../types'
import { isClientError, withTimeoutAndRetry } from '../lib/retry'

// Cache key prefix (used for in-memory tracking only, no IndexedDB)
const CACHE_KEY_PREFIX_ELECTION = 'politicians_election_'

// Global shared state
const elections = ref<Election[]>([])
const politicians = ref<Politician[]>([])  // 目前已載入的候選人（可能來自多個選舉）
const policies = ref<Policy[]>([])
const discussions = ref<Discussion[]>([])
const categories = ref<string[]>([])
const locations = ref<string[]>([])
const regionStats = ref<RegionStats[]>([])
const electoralDistrictAreas = ref<ElectoralDistrictArea[]>([])
const loading = ref(false)
const loaded = ref(false)
/**
 * 最近一次載入失敗的描述；null 表示沒有失敗。
 * 頁面用它區分「資料不存在」與「資料拿不到」——以前兩者都顯示「找不到」，
 * Supabase 暫時性 Gateway Timeout 或手機網路 403 時使用者沒有任何重試的路。
 */
const error = ref<string | null>(null)
const failedLoaders = new Set<() => Promise<void>>()

function recordFailure(label: string, err: unknown, loader: () => Promise<void>): void {
  console.error(`[${label}] 載入失敗：`, err)
  error.value = `${label}載入失敗`
  failedLoaders.add(loader)
}

/** 重跑所有失敗過的載入；成功的會自己把 error 清掉。 */
async function retry(): Promise<void> {
  const loaders = [...failedLoaders]
  failedLoaders.clear()
  error.value = null
  await Promise.all(loaders.map((run) => run()))
}
/**
 * 政見清單是不是「完整的一份」。
 *
 * 刻意不用 policies.value.length > 0 判斷，那會是個假的已載入：
 *   1. 預渲染的政見詳情頁只嵌那一條政見（與同一人、同一條接力鏈）的切片；
 *   2. loadPolicyById 查不到就把單筆 push 進 policies。
 * 兩種情況都讓 length > 0 而清單其實不完整——列表頁會只出現一張卡片，
 * 而且因為「已經有資料了」再也不會去載，畫面看起來就是資料不見了。
 */
const policiesComplete = ref(false)
const loadedElections = ref<Set<number>>(new Set())  // 已載入的選舉 ID
const currentElectionId = ref<number | null>(null)  // 目前顯示的選舉 ID（切換時清空舊資料）

/** 全站統計（建置預渲染時由完整資料算出；瀏覽器端首頁再用 DB count 覆蓋）。 */
export interface DataStats {
  totalPoliticians: number | null
  politiciansByElection: Record<string, number>
}
const stats = ref<DataStats>({ totalPoliticians: null, politiciansByElection: {} })

// Pagination helper to fetch all rows from a table/view (bypasses 1000 row limit)
// orderBy 是必填：超過 1000 筆的 view 若沒有排序，PostgREST 每頁順序不穩，會同一筆重複、另一筆漏掉，
// 而且不會有任何錯誤——只是卡片靜靜地少幾張。
export async function fetchAllRows<T = Record<string, unknown>>(tableName: string, selectStr: string, orderBy: string): Promise<T[]> {
  let allData: T[] = []
  let from = 0
  let to = 999
  let finished = false

  while (!finished) {
    // supabase-js 不會 reject，網路錯誤與中止都包在 error 裡回來；要 throwOnError 重試才看得到
    const { data } = await withTimeoutAndRetry(`${tableName} ${from}-${to}`, (signal) =>
      supabase.from(tableName).select(selectStr).order(orderBy).range(from, to).abortSignal(signal).throwOnError(),
    )

    if (!data || data.length < 1000) finished = true

    if (data) allData.push(...(data as T[]))
    from += 1000
    to += 1000
  }
  return allData
}

// snake_case → camelCase mapping helpers

function mapElection(row: RawElection): Election {
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    startDate: row.start_date,
    endDate: row.end_date,
    electionDate: row.election_date,
    types: (row.types || []) as ElectionType[],
  }
}

export function mapPolitician(row: RawPolitician): Politician {
  // Map elections array from the view (election-specific data)
  // 職稱由選舉別＋縣市組出來，不照抄存的 position（2026-09-25：「111年直轄市議員選舉」掛在 2026、議員被寫成市長）
  const elections: PoliticianElectionData[] = (row.elections || []).map((e: RawPoliticianElectionData) => ({
    electionId: e.electionId,
    position: participationLabel({ electionType: e.electionType, position: e.position, region: e.region, subRegion: e.subRegion, village: e.village }),
    slogan: e.slogan || undefined,
    electionType: e.electionType || undefined,
    regionId: e.regionId || undefined,
    region: e.region || '',
    subRegion: e.subRegion || undefined,
    village: e.village || undefined,
    candidateStatus: e.candidateStatus || undefined,
    electionResult: e.electionResult || undefined,
    sourceNote: e.sourceNote || undefined,
  }));

  // Get candidateStatus from the first election (for display purposes)
  const firstElection = elections[0];
  // 人物層的職稱：最近一屆有在選的那一列組出來的；沒有參選紀錄才用人物表存的文字
  const latest = [...elections].filter(e => e.candidateStatus !== 'not_running').sort((a, b) => b.electionId - a.electionId)[0];

  return {
    id: row.id,
    mergedInto: row.merged_into || undefined,
    name: row.name,
    party: row.party,
    status: row.status,
    electionType: row.election_type,
    position: latest?.position || row.position || '',
    currentPosition: displayCurrentPosition(row.current_position),
    // Region from view (already JOINed with regions table for backward compat)
    region: row.region || '',
    subRegion: row.sub_region || undefined,
    village: row.village || undefined,
    avatarUrl: row.avatar_url,
    slogan: row.slogan || undefined,
    bio: row.bio || undefined,
    education: row.education || undefined,
    experience: row.experience || undefined,
    electionIds: row.election_ids || [],
    birthYear: row.birth_year || undefined,
    educationLevel: row.education_level || undefined,
    candidateStatus: firstElection?.candidateStatus || undefined,
    sourceNote: firstElection?.sourceNote || undefined,
    // New: election-specific data array
    elections,
  }
}

// 覆蓋為特定選舉的資料（避免顯示舊選舉的 candidateStatus/sourceNote）
export function withElectionData(p: Politician, electionId: number): Politician {
  const currentElection = p.elections?.find(e => e.electionId === electionId)
  if (!currentElection) return p
  return {
    ...p,
    candidateStatus: currentElection.candidateStatus,
    sourceNote: currentElection.sourceNote,
    position: currentElection.position || p.position,
    electionType: currentElection.electionType || p.electionType,
    region: currentElection.region || p.region,
    subRegion: currentElection.subRegion || p.subRegion,
  }
}

// Helper function to get election-specific data for a politician
function getPoliticianElectionData(
  politician: Politician,
  electionId: number
): PoliticianElectionData | undefined {
  return politician.elections?.find(e => e.electionId === electionId);
}


export function mapPolicy(row: RawPolicy): Policy {
  return {
    id: row.id,
    politicianId: row.politician_id,
    electionId: row.election_id || undefined,
    title: row.title,
    description: row.description,
    category: row.category,
    status: row.status,
    proposedDate: row.proposed_date ?? null,
    lastUpdated: row.last_updated,
    updatedAt: row.updated_at,
    sourceUrl: row.source_url || undefined,
    progress: row.progress,
    tags: row.tags || [],
    aiAnalysis: row.ai_analysis || undefined,
    supportCount: row.support_count || undefined,
    stanceSupport: row.stance_support ?? 0,
    stanceOppose: row.stance_oppose ?? 0,
    stancePriority: row.stance_priority ?? 0,
    logs: (row.logs || []).map((l: RawTrackingLog) => ({
      id: l.id,
      date: l.date,
      event: l.event,
      description: l.description || undefined,
    })),
    relatedPolicyIds: (row.related_policy_ids || []).filter((id): id is string => typeof id === 'string'),
  }
}

function mapDiscussion(row: RawDiscussion): Discussion {
  return {
    id: row.id,
    policyId: row.policy_id,
    policyTitle: row.policy_title,
    author: {

      id: row.author_id,
      name: row.author_name,
      avatarUrl: row.author_avatar_url,
    },
    title: row.title,
    content: row.content,
    likes: row.likes,
    tags: row.tags || [],
    createdAt: row.created_at,
    createdAtTs: row.created_at_ts,
    viewCount: row.view_count,
    comments: (row.comments || []).map((c: RawDiscussionComment) => ({
      id: c.id,
      author: c.author,
      content: c.content,
      likes: c.likes,
      createdAt: c.createdAt,
      replies: (c.replies || []).map((r: RawCommentReply) => ({
        id: r.id,
        author: r.author,
        content: r.content,
        likes: r.likes,
        createdAt: r.createdAt,
      })),
    })),
  }
}

let fetchAllPromise: Promise<void> | null = null

function fetchAll(): Promise<void> {
  if (loaded.value) return Promise.resolve()
  if (fetchAllPromise) return fetchAllPromise
  fetchAllPromise = fetchAllInner().finally(() => { fetchAllPromise = null })
  return fetchAllPromise
}

async function fetchAllInner() {
  loading.value = true

  try {
    // 首屏只載「每一頁都要用」的東西。
    // regions（178 KB）、electoral_district_areas（77 KB）、discussions 改成按需載入——
    // 那 255 KB 只有區域資料頁、後台統計頁、選舉頁、討論頁會用到，
    // 卻讓每一個訪客的第一次連線都付這個成本（改之前首屏是 605 KB／9 個請求）。
    //
    // 2026-09-13 政見清單（257 KB）＋有政見的人物（91 KB）也移出去了，見 ensurePolicies。
    // 公民提問頁對這 348 KB 的全部用途是「用 id 找一個政見標題」，使用者回報載入很慢。
    const [
      electionsData,
      electionTypesData,
      categoriesRes,
      locationsRes,
    ] = await Promise.all([
      fetchAllRows<RawElection>('elections', '*', 'id'),
      fetchAllRows<ElectionTypeTableRow>('election_types', 'election_id, type', 'election_id'),
      withTimeoutAndRetry('categories', (signal) => supabase.from('categories').select('name').abortSignal(signal).throwOnError()),
      withTimeoutAndRetry('locations', (signal) => supabase.from('locations').select('name').abortSignal(signal).throwOnError()),
    ])

    // Map elections
    const typesByElection: Record<number, ElectionType[]> = {}
    for (const row of electionTypesData || []) {
      if (!typesByElection[row.election_id]) typesByElection[row.election_id] = []
      typesByElection[row.election_id].push(row.type as ElectionType)
    }
    elections.value = (electionsData || []).map(row =>
      mapElection({ ...row, types: typesByElection[row.id] || [] })
    )
    categories.value = (categoriesRes.data || []).map(r => r.name)
    locations.value = (locationsRes.data || []).map(r => r.name)
    // 軟移除的政見不進全域 state。view 重建前沒有 removed_at 這一欄，
    // 所以「明顯錯誤可以被移除」那套機制其實過濾不掉任何東西（見 migration 20260913000001）。
    loaded.value = true
    loading.value = false

  } catch (err) {
    loading.value = false
    recordFailure('基礎資料', err, fetchAll)
  }
}


// Helper functions (same API as constants.ts)
function getElectionById(id: number): Election | undefined {
  return elections.value.find(e => e.id === id)
}

function getElectionByYear(year: number): Election | undefined {
  return elections.value.find(e => e.electionDate?.startsWith(String(year)))
}

function getActiveElection(): Election {
  const today = new Date().toISOString().slice(0, 10)
  const active = elections.value
    .filter(e => e.startDate <= today && today <= e.endDate)
    .sort((a, b) => a.electionDate.localeCompare(b.electionDate))
  return active[0] || elections.value[0]
}

// ------------------------------------------------------------
// 按需載入的三塊重資料。
//
// 改之前首屏是 605 KB／9 個請求，其中 255 KB（regions 178、選舉區對應 77）只有
// 區域資料頁、後台統計、選舉頁會用到。每個只看政見或提問的訪客都在白付這個成本。
//
// 三個共通的形狀：冪等（promise 快取）、已經有資料就直接回（預渲染頁的切片會先塞好，
// 不要重打一次）、失敗清掉快取讓下一次能重試。
// ------------------------------------------------------------
let regionStatsPromise: Promise<void> | null = null
let districtsPromise: Promise<void> | null = null
let discussionsPromise: Promise<void> | null = null

/** 縣市統計：區域資料頁與後台統計頁用（178 KB） */
export function ensureRegionStats(): Promise<void> {
  if (regionStats.value.length > 0) return Promise.resolve()
  if (!regionStatsPromise) {
    regionStatsPromise = (async () => {
      // 只撈縣市和鄉鎮層級，不撈村里
      const { data } = await withTimeoutAndRetry('regions', (signal) =>
        supabase.from('regions').select('*').is('village', null).abortSignal(signal).throwOnError())
      regionStats.value = (data || []) as RegionStats[]
    })().catch((err) => { regionStatsPromise = null; recordFailure('縣市統計', err, ensureRegionStats) })
  }
  return regionStatsPromise
}

/** 選舉區對應表：選舉頁篩議員選區用（77 KB） */
export function ensureDistricts(): Promise<void> {
  if (electoralDistrictAreas.value.length > 0) return Promise.resolve()
  if (!districtsPromise) {
    districtsPromise = (async () => {
      const { data } = await withTimeoutAndRetry('electoral_district_areas', (signal) =>
        supabase.from('electoral_district_areas').select('*').abortSignal(signal).throwOnError())
      electoralDistrictAreas.value = (data || []) as ElectoralDistrictArea[]
    })().catch((err) => { districtsPromise = null; recordFailure('選舉區對應', err, ensureDistricts) })
  }
  return districtsPromise
}

/** 討論：只有討論頁用 */
export function ensureDiscussions(): Promise<void> {
  if (discussions.value.length > 0) return Promise.resolve()
  if (!discussionsPromise) {
    discussionsPromise = (async () => {
      const rows = await fetchAllRows<RawDiscussion>('discussions_full', '*', 'id')
      discussions.value = (rows || []).map(mapDiscussion)
    })().catch((err) => { discussionsPromise = null; recordFailure('討論', err, ensureDiscussions) })
  }
  return discussionsPromise
}

let policiesPromise: Promise<void> | null = null

/**
 * 政見清單（257 KB）＋有政見的人物（91 KB）。列表頁與詳情頁要，公民提問頁不要。
 *
 * 跟另外三塊 ensure* 不同的是：這一塊的判斷不能看 length。預渲染的詳情頁會先嵌
 * 一份不完整的切片，loadPolicyById 也會把單筆塞進清單——所以用 policiesComplete
 * 這個明確的旗標，只有「真的整份載完」或「切片本身就是整份」才算。
 */
export function ensurePolicies(): Promise<void> {
  if (policiesComplete.value) return Promise.resolve()
  if (!policiesPromise) {
    policiesPromise = (async () => {
      // 全台 15,000+ 位候選人不預載（選舉頁按需載入），但「有政見的那些人」一定要在，
      // 否則政見追蹤頁、首頁、AI 分析頁的卡片會被 v-if="politicians.find(…)" 整張吃掉，
      // 縣市篩選也會把每一筆政見判成不符合（lib/policy-region.ts 的 politician?.region）。
      // 兩份互不依賴，同時發；以前串行等於白付一次往返。
      const [rows] = await Promise.all([
        fetchAllRows<RawPolicy>('policies_with_logs', '*', 'id'),
        loadPoliticiansWithPolicies(),
      ])
      // 軟移除的政見不進全域 state。view 重建前沒有 removed_at 這一欄，
      // 所以「明顯錯誤可以被移除」那套機制其實過濾不掉任何東西（見 migration 20260913000001）。
      // 詳情頁可能已經用 loadPolicyById 塞了幾筆進來，整份蓋過去就好（同一個來源、較新）
      policies.value = (rows || []).filter(r => !r.removed_at).map(mapPolicy)
      policiesComplete.value = true
    })().catch((err) => { policiesPromise = null; recordFailure('政見清單', err, ensurePolicies) })
  }
  return policiesPromise
}

/** 政見卡片與縣市篩選需要的人物＝有政見的那些人。切選舉時這批不能被清掉。 */
function politicianIdsWithPolicies(): Set<string> {
  return new Set(policies.value.map(p => p.politicianId).filter((id): id is string => !!id))
}

/**
 * 把「有政見的人物」載進全域 state。fetchAllInner 在政見載完後呼叫。
 *
 * 走 politicians_with_policies 這個 view，不要自己撈 id 再 `id=in.(…)` 回頭查：
 * 那樣產生的網址是 2,941 字元，超過 2048／2083 的網址在行動網路代理與 WAF 上會被回 403
 * （2026-09-13 手機上實際踩到），而且人物越多網址越長，是會隨資料惡化的實作。
 *
 * 失敗只記 log 不丟出：少了這批頁面會退化成卡片出不來，但其他資料還是該顯示。
 */
async function loadPoliticiansWithPolicies(): Promise<void> {
  try {
    const rows = await fetchAllRows<RawPolitician>('politicians_with_policies', '*', 'id')
    const seen = new Set(politicians.value.map(p => p.id))
    const loaded = rows.map(mapPolitician).filter(p => !seen.has(p.id))
    if (loaded.length > 0) politicians.value = [...politicians.value, ...loaded]
  } catch (err) {
    recordFailure('有政見的人物', err, loadPoliticiansWithPolicies)
  }
}
// 已載入的 region 組合追蹤
const loadedRegions = ref<Set<string>>(new Set())

// 按選舉 + 地區載入候選人（按需載入，不使用 IndexedDB 快取）
async function loadPoliticiansByElection(
  electionId: number,
  region: string = 'All'
): Promise<Politician[]> {
  // 切換不同選舉時，清掉上一個選舉載進來的候選人避免無限膨脹——
  // 但「有政見的人物」要留著：全清會把 fetchAll 載進來的那批一起清掉，
  // 使用者逛完兩個選舉頁再回政見追蹤頁，卡片就又全部消失了。
  if (currentElectionId.value !== null && currentElectionId.value !== electionId) {
    const keep = politicianIdsWithPolicies()
    politicians.value = politicians.value.filter(p => keep.has(p.id))
    loadedRegions.value.clear()
    loadedElections.value.clear()
  }
  currentElectionId.value = electionId

  // 全國選 All 時載入總統/立委，選縣市時載入該縣市候選人
  const cacheKey = `${CACHE_KEY_PREFIX_ELECTION}${electionId}_${region}`

  // 已經載入過就跳過（僅內存快取，不用 IndexedDB）
  if (loadedRegions.value.has(cacheKey)) {
    return politicians.value.filter(p => p.electionIds?.includes(electionId))
  }

  try {
    // 直接從 DB 載入（不使用 IndexedDB 快取）

    // 2. 先查詢該選舉有哪些類型
    const { data: typeData } = await supabase
      .rpc('get_election_types', { p_election_id: electionId })

    const availableTypes = (typeData || []).map((t: RawElectionTypeRow) => t.election_type)

    // 3. 根據地區決定載入哪些類型
    let electionTypes: string[] | null = null
    let regionParam: string | null = null

    if (region === 'All') {
      // 全國：載入全國性類型（總統/立委/縣市長），但只載入該選舉有的
      const nationalTypes = ['總統副總統', '立法委員', '縣市長']
      electionTypes = nationalTypes.filter(t => availableTypes.includes(t))
      if (electionTypes.length === 0) {
        loadedRegions.value.add(cacheKey)
        return []
      }
    } else {
      // 特定縣市：載入該縣市的所有類型
      regionParam = region
    }

    // 3. 使用 RPC 函數載入
    const { data, error } = await supabase
      .rpc('get_politicians_by_filters', {
        p_election_id: electionId,
        p_region: regionParam,
        p_election_types: electionTypes
      })

    if (error) {
      console.error(`[loadByElection] RPC 錯誤:`, error)
      throw error
    }

    const pols = (data || []).map(mapPolitician).map(p => withElectionData(p, electionId))

    // 合併到全域 state（不存入 IndexedDB 快取）
    // 重要：更新已存在候選人的 elections 陣列，確保跨選舉資料正確
    const polsMap = new Map<string, Politician>(pols.map(p => [p.id, p]))

    politicians.value = politicians.value.map(existing => {
      const updated = polsMap.get(existing.id)
      if (updated) {
        // 合併 elections 陣列，保持完整歷史
        const mergedElections = [...(existing.elections || [])]
        for (const newElection of updated.elections || []) {
          const idx = mergedElections.findIndex(e => e.electionId === newElection.electionId)
          if (idx >= 0) {
            mergedElections[idx] = newElection  // 更新已存在的選舉資料
          } else {
            mergedElections.push(newElection)   // 新增新的選舉資料
          }
        }
        polsMap.delete(existing.id)  // 標記為已處理
        return { ...existing, elections: mergedElections }
      }
      return existing
    })

    // 新增不存在的候選人
    const newPols = Array.from(polsMap.values())
    politicians.value.push(...newPols)
    loadedRegions.value.add(cacheKey)
    loadedElections.value.add(electionId)

    return pols
  } catch (err) {
    console.error(`[loadByElection] 載入選舉 ${electionId}/${region} 失敗:`, err)
    throw err
  }
}

// Force refresh politicians for a specific election
async function refreshPoliticiansByElection(electionId: number) {
  // 清除內存中的快取記錄
  loadedElections.value.delete(electionId)

  // 清除相關的 loadedRegions
  for (const key of loadedRegions.value) {
    if (key.startsWith(`${CACHE_KEY_PREFIX_ELECTION}${electionId}`)) {
      loadedRegions.value.delete(key)
    }
  }

  // 重新載入
  return loadPoliticiansByElection(electionId)
}

// Force refresh politicians from Supabase (legacy, refreshes current election)
async function refreshPoliticians() {
  const activeElection = getActiveElection()
  if (activeElection) {
    return refreshPoliticiansByElection(activeElection.id)
  }
  return []
}

// 根據鄉鎮區查找對應的議員選舉區
function getElectoralDistrictByTownship(region: string, township: string, electionId: number): string | undefined {
  const mapping = electoralDistrictAreas.value.find(
    m => m.region === region && m.township === township && m.election_id === electionId
  )
  return mapping?.electoral_district
}

// 根據選舉區查找所有對應的鄉鎮區
function getTownshipsByElectoralDistrict(region: string, electoralDistrict: string, electionId: number): string[] {
  return electoralDistrictAreas.value
    .filter(m => m.region === region && m.electoral_district === electoralDistrict && m.election_id === electionId)
    .map(m => m.township)
}

/** 全域資料狀態的純資料快照（可 JSON 序列化）。 */
export interface DataSnapshot {
  /** 建置時間（epoch ms）。客戶端用它判斷快照夠不夠新，夠新就不再重撈基礎資料。 */
  generatedAt?: number
  /**
   * 這份切片裡的 policies 是不是完整的一份。
   * 只有首頁、政見列表、市政接力列表拿得到全部政見；詳情頁只拿那一條鏈。
   * 少了這個布林，hydrate 後 policiesComplete 就得靠猜，詳情頁的部分切片會被
   * 當成「已經載完了」，之後導到列表頁就只剩那一張卡片。
   */
  policiesComplete: boolean
  elections: Election[]
  categories: string[]
  locations: string[]
  regionStats: RegionStats[]
  electoralDistrictAreas: ElectoralDistrictArea[]
  policies: Policy[]
  politicians: Politician[]
  discussions: Discussion[]
  stats: DataStats
}

/** 取目前全域狀態的快照（SSG 建置時在 fetchAll 之後呼叫，當作切片來源）。 */
export function getDataSnapshot(): DataSnapshot {
  return {
    generatedAt: Date.now(),
    policiesComplete: policiesComplete.value,
    elections: elections.value,
    categories: categories.value,
    locations: locations.value,
    regionStats: regionStats.value,
    electoralDistrictAreas: electoralDistrictAreas.value,
    policies: policies.value,
    politicians: politicians.value,
    discussions: discussions.value,
    stats: stats.value,
  }
}

/** 快照超過這個年紀就不信它的基礎資料（選舉、分類、地區），照常重撈。CI 每次 push 都重建，實際上很少超過一天。 */
const SNAPSHOT_FRESH_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 以快照覆蓋全域狀態。
 * 快照夠新且帶了基礎資料時直接視為 loaded，省掉每頁首次連線那四個小請求
 * （elections／election_types／categories／locations，HTML 裡本來就有同一份）。
 * 重資料（政見清單等）另有 policiesComplete 等旗標決定要不要撈。
 */
export function applyDataSnapshot(snapshot: DataSnapshot): void {
  policiesComplete.value = snapshot.policiesComplete === true
  const fresh = typeof snapshot.generatedAt === 'number' && Date.now() - snapshot.generatedAt < SNAPSHOT_FRESH_MS
  if (fresh && snapshot.elections.length > 0) loaded.value = true
  elections.value = snapshot.elections
  categories.value = snapshot.categories
  locations.value = snapshot.locations
  regionStats.value = snapshot.regionStats
  electoralDistrictAreas.value = snapshot.electoralDistrictAreas
  policies.value = snapshot.policies
  politicians.value = snapshot.politicians
  discussions.value = snapshot.discussions
  stats.value = snapshot.stats
}

export function useSupabase() {
  // Trigger fetch on first use
  if (!loaded.value && !loading.value) {
    fetchAll()
  }

  // 取得特定選舉的候選人數量（不載入完整資料）
  async function getElectionPoliticianCount(electionId: number): Promise<number> {
    const { count, error } = await supabase
      .from('politician_elections')
      .select('*', { count: 'exact', head: true })
      .eq('election_id', electionId)
      .neq('candidate_status', 'not_running')  // AI 推測但未登記的人不算「已收錄人員」

    if (error) {
      console.error('Failed to get election politician count:', error)
      return 0
    }
    return count || 0
  }

  // 取得政治人物總數（不載入完整資料）
  async function getTotalPoliticianCount(): Promise<number> {
    const { count, error } = await supabase
      .from('politicians')
      .select('*', { count: 'exact', head: true })

    if (error) {
      console.error('Failed to get total politician count:', error)
      return 0
    }
    return count || 0
  }

  // 取得各分類的政見數量
  async function getPoliciesByCategory(): Promise<{ name: string; count: number }[]> {
    const { data, error } = await supabase
      .from('policies')
      .select('category')

    if (error) {
      console.error('Failed to get policies by category:', error)
      return []
    }

    // 計算每個分類的數量
    const counts: Record<string, number> = {}
    for (const row of data || []) {
      if (row.category) {
        counts[row.category] = (counts[row.category] || 0) + 1
      }
    }

    // 轉換為陣列並排序
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)  // 只取前 6 個
  }

  // 根據 ID 載入單一 politician（用於直接訪問 profile 頁面）
  async function loadPoliticianById(politicianId: string): Promise<Politician | null> {
    // 先檢查是否已在 state 中
    const existing = politicians.value.find(p => p.id === politicianId)
    if (existing) return existing

    try {
      const { data } = await withTimeoutAndRetry(`politician ${politicianId}`, (signal) =>
        supabase.from('politicians_with_elections').select('*').eq('id', politicianId).abortSignal(signal).maybeSingle().throwOnError())
      if (!data) return null

      const pol = mapPolitician(data)

      // 加入到 state（避免重複）
      const existingIds = new Set(politicians.value.map(p => p.id))
      if (!existingIds.has(pol.id)) {
        politicians.value.push(pol)
      }

      return pol
    } catch (err) {
      // id 格式錯之類的請求錯誤等於「找不到」；網路／伺服器問題才讓頁面顯示重試
      if (isClientError(err)) { console.warn(`[loadPoliticianById] ${politicianId}：`, err); return null }
      recordFailure('政治人物', err, async () => { await loadPoliticianById(politicianId) })
      return null
    }
  }

  // 根據 ID 載入單一 policy（用於直接訪問政見詳情頁面）
  async function loadPolicyById(policyId: string): Promise<Policy | null> {
    const existing = policies.value.find(p => p.id === policyId)
    if (existing) return existing

    try {
      const { data } = await withTimeoutAndRetry(`policy ${policyId}`, (signal) =>
        supabase.from('policies_with_logs').select('*').eq('id', policyId).abortSignal(signal).maybeSingle().throwOnError())
      if (!data) return null

      const mapped = mapPolicy(data as RawPolicy)

      const existingIds = new Set(policies.value.map(p => p.id))
      if (!existingIds.has(mapped.id)) {
        policies.value.push(mapped)
      }

      return mapped
    } catch (err) {
      if (isClientError(err)) { console.warn(`[loadPolicyById] ${policyId}：`, err); return null }
      recordFailure('政見', err, async () => { await loadPolicyById(policyId) })
      return null
    }
  }

  return {
    elections,
    politicians,
    policies,
    discussions,
    categories,
    locations,
    regionStats,
    electoralDistrictAreas,
    loading,
    loaded,
    error,
    retry,
    loadedElections,
    stats,

    fetchAll,
    getElectionById,
    getElectionByYear,
    getActiveElection,
    loadPoliticiansByElection,  // 新增：按選舉載入
    refreshPoliticiansByElection,  // 新增：重新整理特定選舉
    refreshPoliticians,
    getPoliticianElectionData,
    getElectoralDistrictByTownship,
    getTownshipsByElectoralDistrict,
    getElectionPoliticianCount,
    getTotalPoliticianCount,
    // 按需載入的三塊重資料：需要的頁面自己在 onMounted 呼叫
    ensureRegionStats,
    ensureDistricts,
    ensureDiscussions,
    ensurePolicies,
    policiesComplete,
    getPoliciesByCategory,
    loadPoliticianById,
    loadPolicyById,
  }
}
