import { ref } from 'vue'
import { supabase } from '../lib/supabase'
import type { Election, Politician, Policy, Discussion, TrackingLog } from '../types'
import { ElectionType } from '../types'

// Global shared state (loaded once, shared across components)
const elections = ref<Election[]>([])
const politicians = ref<Politician[]>([])
const policies = ref<Policy[]>([])
const discussions = ref<Discussion[]>([])
const categories = ref<string[]>([])
const locations = ref<string[]>([])
const regionStats = ref<any[]>([]) // New state for region stats
const loading = ref(false)
const loaded = ref(false)

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
  return {
    id: row.id,
    name: row.name,
    party: row.party,
    status: row.status,
    electionType: row.election_type,
    position: row.position,
    region: row.region,
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
  }
}


function mapPolicy(row: any): Policy {
  return {
    id: row.id,
    politicianId: row.politician_id,
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
    // 1. First fetch lightweight metadata and elections
    const [
      electionsData,
      electionTypesData,
      categoriesRes,
      locationsRes,
      regionStatsData,
    ] = await Promise.all([
      fetchAllRows('elections'),
      fetchAllRows('election_types', 'election_id, type'),
      supabase.from('categories').select('name'),
      supabase.from('locations').select('name'),
      supabase.from('politician_stats_by_region').select('*')
    ])

    // Map elections immediately
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

    // 2. Determine target election (latest active)
    const today = new Date().toISOString().slice(0, 10)
    const activeElection = elections.value
      .filter(e => e.startDate <= today && today <= e.endDate)
      .sort((a, b) => b.electionDate.localeCompare(a.electionDate))[0] 
      || elections.value.sort((a, b) => b.electionDate.localeCompare(a.electionDate))[0]

    // 3. Fetch Priority Politicians (President, Mayor, Legislator from target election)
    // We join with politician_elections to filter by election_id
    const priorityTypes = ['總統副總統', '立法委員', '縣市長']
    
    // Fetch priority IDs first
    const { data: priorityIds } = await supabase
      .from('politician_elections')
      .select('politician_id')
      .eq('election_id', activeElection?.id || 1) // Default to 1 (2026) if not found

    const targetIds = (priorityIds || []).map((p: any) => p.politician_id)

    // Fetch the actual politicians
    let priorityPols: any[] = []
    if (targetIds.length > 0) {
      const { data } = await supabase
        .from('politicians')
        .select('*')
        .in('id', targetIds)
        .in('election_type', priorityTypes)
      
      priorityPols = data || []
      politicians.value = priorityPols.map(mapPolitician)
    }

    // 4. Fetch related data for priority politicians (policies, discussions)
    // Note: Ideally we should filter these too, but for simplicity we might fetch all or filter by pol ID
    // For performance, let's fetch all policies/discussions for NOW as they are smaller tables compared to all politicians
    // Or better: filter by priority politicians if possible. 
    // Given the constraints, let's fetch ALL policies/discussions as they are critical for the UI.
    const [policiesData, discussionsData] = await Promise.all([
      fetchAllRows('policies_with_logs'),
      fetchAllRows('discussions_full'),
    ])
    policies.value = (policiesData || []).map(mapPolicy)
    discussions.value = (discussionsData || []).map(mapDiscussion)

    // Mark as loaded so UI renders the critical data
    loaded.value = true
    loading.value = false

    // 5. Lazy load the rest (Background Fetch)
    // Fetch ALL politicians_with_elections to get the full list
    // This might take time, but the UI is already responsive
    console.log('Background loading remaining politicians...')
    const allPolsData = await fetchAllRows('politicians_with_elections')
    
    // Merge logic: Create a map of existing IDs to avoid duplicates/overwrite
    const existingIds = new Set(politicians.value.map(p => p.id))
    const newPols = (allPolsData || []).map(mapPolitician).filter(p => !existingIds.has(p.id))
    
    politicians.value = [...politicians.value, ...newPols]
    console.log(`Background load complete. Total politicians: ${politicians.value.length}`)

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
    loading,

    loaded,
    fetchAll,
    getElectionById,
    getActiveElection,
  }
}
