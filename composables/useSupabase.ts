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
const loading = ref(false)
const loaded = ref(false)

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
    avatarUrl: row.avatar_url,
    slogan: row.slogan || undefined,
    bio: row.bio || undefined,
    education: row.education || undefined,
    experience: row.experience || undefined,
    electionIds: row.election_ids || [],
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
    relatedPolicyIds: (row.related_policy_ids || []).filter((id: any) => typeof id === 'number'),
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
    const [
      electionsRes,
      electionTypesRes,
      politiciansRes,
      policiesRes,
      discussionsRes,
      categoriesRes,
      locationsRes,
    ] = await Promise.all([
      supabase.from('elections').select('*'),
      supabase.from('election_types').select('election_id, type'),
      supabase.from('politicians_with_elections').select('*'),
      supabase.from('policies_with_logs').select('*'),
      supabase.from('discussions_full').select('*'),
      supabase.from('categories').select('name'),
      supabase.from('locations').select('name'),
    ])

    // Map elections with their types
    const typesByElection: Record<number, string[]> = {}
    for (const row of electionTypesRes.data || []) {
      if (!typesByElection[row.election_id]) typesByElection[row.election_id] = []
      typesByElection[row.election_id].push(row.type)
    }
    elections.value = (electionsRes.data || []).map(row =>
      mapElection({ ...row, types: typesByElection[row.id] || [] })
    )

    politicians.value = (politiciansRes.data || []).map(mapPolitician)
    policies.value = (policiesRes.data || []).map(mapPolicy)
    discussions.value = (discussionsRes.data || []).map(mapDiscussion)
    categories.value = (categoriesRes.data || []).map(r => r.name)
    locations.value = (locationsRes.data || []).map(r => r.name)

    loaded.value = true
  } catch (err) {
    console.error('Failed to fetch data from Supabase:', err)
  } finally {
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
    loading,
    loaded,
    fetchAll,
    getElectionById,
    getActiveElection,
  }
}
