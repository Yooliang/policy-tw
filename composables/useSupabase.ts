import { ref } from 'vue'
import { supabase } from '../lib/supabase'
import type { Election, Politician, Policy, Discussion, TrackingLog, PoliticianElectionData } from '../types'
import { ElectionType } from '../types'
import { useIndexedDB } from './useIndexedDB'

const { getFromCache, setToCache, getCacheTimestamp, CACHE_DURATION } = useIndexedDB()

// Cache keys
const CACHE_KEY_PREFIX_ELECTION = 'politicians_election_'  // 按選舉快取

// Global shared state
const elections = ref<Election[]>([])
const politicians = ref<Politician[]>([])  // 目前已載入的候選人（可能來自多個選舉）
const policies = ref<Policy[]>([])
const discussions = ref<Discussion[]>([])
const categories = ref<string[]>([])
const locations = ref<string[]>([])
const regionStats = ref<any[]>([])
const electoralDistrictAreas = ref<any[]>([])
const loading = ref(false)
const loaded = ref(false)
const loadedElections = ref<Set<number>>(new Set())  // 已載入的選舉 ID

// Pagination helper to fetch all rows from a table/view (bypasses 1000 row limit)
async function fetchAllRows(tableName: string, selectStr: string = '*') {
  let allData: any[] = []
  let from = 0
  let to = 999
  let finished = false

  while (!finished) {
    const { data, error } = await supabase
      .from(tableName)
      .select(selectStr)
      .range(from, to)
    
    if (error) throw error
    if (!data || data.length < 1000) finished = true
    
    allData = [...allData, ...data]
    from += 1000
    to += 1000
  }
  return allData
}

// snake_case → camelCase mapping helpers

function mapElection(row: any): Election {
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

function mapPolitician(row: any): Politician {
  // Map elections array from the view (election-specific data)
  const elections: PoliticianElectionData[] = (row.elections || []).map((e: any) => ({
    electionId: e.electionId,
    position: e.position || '',
    slogan: e.slogan || undefined,
    electionType: e.electionType || undefined,
    regionId: e.regionId || undefined,
    region: e.region || '',
    subRegion: e.subRegion || undefined,
    village: e.village || undefined,
  }));

  return {
    id: row.id,
    name: row.name,
    party: row.party,
    status: row.status,
    electionType: row.election_type,
    position: row.position || '',
    currentPosition: row.current_position || undefined,
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
    // New: election-specific data array
    elections,
  }
}

// Helper function to get election-specific data for a politician
function getPoliticianElectionData(
  politician: Politician,
  electionId: number
): PoliticianElectionData | undefined {
  return politician.elections?.find(e => e.electionId === electionId);
}


function mapPolicy(row: any): Policy {
  return {
    id: row.id,
    politicianId: row.politician_id,
    electionId: row.election_id || undefined,
    title: row.title,
    description: row.description,
    category: row.category,
    status: row.status,
    proposedDate: row.proposed_date,
    lastUpdated: row.last_updated,
    progress: row.progress,
    tags: row.tags || [],
    aiAnalysis: row.ai_analysis || undefined,
    supportCount: row.support_count || undefined,
    logs: ((row.logs || []) as any[]).map((l: any) => ({
      id: l.id,
      date: l.date,
      event: l.event,
      description: l.description || undefined,
    })),
    relatedPolicyIds: (row.related_policy_ids || []).filter((id: any) => typeof id === 'string'),
  }
}

function mapDiscussion(row: any): Discussion {
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
    comments: ((row.comments || []) as any[]).map((c: any) => ({
      id: c.id,
      author: c.author,
      content: c.content,
      likes: c.likes,
      createdAt: c.createdAt,
      replies: (c.replies || []).map((r: any) => ({
        id: r.id,
        author: r.author,
        content: r.content,
        likes: r.likes,
        createdAt: r.createdAt,
      })),
    })),
  }
}

async function fetchAll() {
  if (loaded.value || loading.value) return
  loading.value = true

  try {
    // 只載入基本 metadata（不載入候選人，由 ElectionPage 按需載入）
    const [
      electionsData,
      electionTypesData,
      categoriesRes,
      locationsRes,
      regionStatsData,
      electoralDistrictAreasData,
      policiesData,
      discussionsData,
    ] = await Promise.all([
      fetchAllRows('elections'),
      fetchAllRows('election_types', 'election_id, type'),
      supabase.from('categories').select('name'),
      supabase.from('locations').select('name'),
      supabase.from('regions').select('*'),
      supabase.from('electoral_district_areas').select('*'),
      fetchAllRows('policies_with_logs'),
      fetchAllRows('discussions_full'),
    ])

    // Map elections
    const typesByElection: Record<number, string[]> = {}
    for (const row of electionTypesData || []) {
      if (!typesByElection[row.election_id]) typesByElection[row.election_id] = []
      typesByElection[row.election_id].push(row.type)
    }
    elections.value = (electionsData || []).map(row =>
      mapElection({ ...row, types: typesByElection[row.id] || [] })
    )
    categories.value = (categoriesRes.data || []).map(r => r.name)
    locations.value = (locationsRes.data || []).map(r => r.name)
    regionStats.value = regionStatsData.data || []
    electoralDistrictAreas.value = electoralDistrictAreasData.data || []
    policies.value = (policiesData || []).map(mapPolicy)
    discussions.value = (discussionsData || []).map(mapDiscussion)

    // 候選人不在這裡載入，改由 ElectionPage 呼叫 loadPoliticiansByElection()
    loaded.value = true
    loading.value = false
    console.log('[fetchAll] 基本資料載入完成，候選人將按需載入')

  } catch (err) {
    console.error('Failed to fetch data from Supabase:', err)
    loading.value = false
  }
}


// Helper functions (same API as constants.ts)
function getElectionById(id: number): Election | undefined {
  return elections.value.find(e => e.id === id)
}

function getActiveElection(): Election {
  const today = new Date().toISOString().slice(0, 10)
  const active = elections.value
    .filter(e => e.startDate <= today && today <= e.endDate)
    .sort((a, b) => a.electionDate.localeCompare(b.electionDate))
  return active[0] || elections.value[0]
}

// 按選舉載入候選人（按需載入，不一次載入全部）
async function loadPoliticiansByElection(electionId: number): Promise<Politician[]> {
  // 已經載入過就跳過
  if (loadedElections.value.has(electionId)) {
    console.log(`[loadByElection] 選舉 ${electionId} 已載入，跳過`)
    return politicians.value.filter(p => p.electionIds?.includes(electionId))
  }

  const cacheKey = `${CACHE_KEY_PREFIX_ELECTION}${electionId}`
  console.log(`[loadByElection] 載入選舉 ${electionId} 的候選人...`)

  try {
    // 1. 先查快取
    const cached = await getFromCache<Politician[]>(cacheKey)
    if (cached && cached.length > 0) {
      console.log(`[loadByElection] 從快取載入 ${cached.length} 位候選人`)
      // 合併到全域 state（避免重複）
      const existingIds = new Set(politicians.value.map(p => p.id))
      const newPols = cached.filter(p => !existingIds.has(p.id))
      politicians.value = [...politicians.value, ...newPols]
      loadedElections.value.add(electionId)
      return cached
    }

    // 2. 從資料庫載入（只取該選舉的候選人）
    // 先從 politician_elections 取得該選舉的 politician_id 列表
    const { data: peData, error: peError } = await supabase
      .from('politician_elections')
      .select('politician_id')
      .eq('election_id', electionId)

    if (peError) throw peError

    const politicianIds = (peData || []).map(pe => pe.politician_id)
    if (politicianIds.length === 0) {
      console.log(`[loadByElection] 選舉 ${electionId} 無候選人`)
      loadedElections.value.add(electionId)
      return []
    }

    // 再從 view 取得完整資料
    const { data, error } = await supabase
      .from('politicians_with_elections')
      .select('*')
      .in('id', politicianIds)

    if (error) throw error

    const pols = (data || []).map(mapPolitician)
    console.log(`[loadByElection] 從資料庫載入 ${pols.length} 位候選人`)

    // 3. 存入快取
    await setToCache(cacheKey, pols)

    // 4. 合併到全域 state
    const existingIds = new Set(politicians.value.map(p => p.id))
    const newPols = pols.filter(p => !existingIds.has(p.id))
    politicians.value = [...politicians.value, ...newPols]
    loadedElections.value.add(electionId)

    return pols
  } catch (err) {
    console.error(`[loadByElection] 載入選舉 ${electionId} 失敗:`, err)
    throw err
  }
}

// Force refresh politicians for a specific election
async function refreshPoliticiansByElection(electionId: number) {
  const cacheKey = `${CACHE_KEY_PREFIX_ELECTION}${electionId}`
  loadedElections.value.delete(electionId)

  // 清除該選舉的快取
  await setToCache(cacheKey, null)

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

export function useSupabase() {
  // Trigger fetch on first use
  if (!loaded.value && !loading.value) {
    fetchAll()
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
    loadedElections,

    fetchAll,
    getElectionById,
    getActiveElection,
    loadPoliticiansByElection,  // 新增：按選舉載入
    refreshPoliticiansByElection,  // 新增：重新整理特定選舉
    refreshPoliticians,
    getPoliticianElectionData,
    getElectoralDistrictByTownship,
    getTownshipsByElectoralDistrict,
  }
}
