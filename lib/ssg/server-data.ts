import {
  fetchAllRows,
  getDataSnapshot,
  mapPolitician,
  useSupabase,
  type DataSnapshot,
  type DataStats,
} from '../../composables/useSupabase'
import type { Politician, RawPolitician } from '../../types'
import { analysisListedPolicyIds } from './page-data'

/**
 * 建置端專用：一次撈齊全站資料（含 15,000+ 政治人物），之後每頁只切片、不再打 Supabase。
 * 只會被 main.ts 在 SSR 分支動態 import，不進客戶端 bundle。
 */

let datasetPromise: Promise<DataSnapshot> | null = null

export function ensureFullDataset(): Promise<DataSnapshot> {
  if (!datasetPromise) datasetPromise = loadFullDataset()
  return datasetPromise
}

async function loadFullDataset(): Promise<DataSnapshot> {
  const { fetchAll, loaded } = useSupabase()
  await fetchAll()
  if (!loaded.value) {
    throw new Error('[ssg] 基礎資料（政見／選舉／分類）載入失敗，中止建置以免產出空殼頁')
  }
  const base = getDataSnapshot()
  if (base.policies.length === 0 || base.elections.length === 0) {
    throw new Error(`[ssg] 基礎資料為空（policies=${base.policies.length}, elections=${base.elections.length}），中止建置`)
  }

  // 一定要排序：這個 view 沒有 ORDER BY，分頁撈會重複／漏筆
  const rows = await fetchAllRows<RawPolitician>('politicians_with_elections', '*', 'id')
  const politicians = dedupeById(rows.map(mapPolitician))
  if (politicians.length === 0) {
    throw new Error('[ssg] politicians_with_elections 回傳 0 筆，中止建置')
  }
  const referenced = new Set(base.policies.map((p) => String(p.politicianId)))
  const known = new Set(politicians.map((pl) => String(pl.id)))
  const orphanPolicies = base.policies.filter((p) => !known.has(String(p.politicianId)))
  if (orphanPolicies.length > 0) {
    console.warn(`[ssg] ${orphanPolicies.length} 筆政見的 politician_id 不在 politicians_with_elections（頁面會顯示找不到）：${[...new Set(orphanPolicies.map((p) => p.politicianId))].slice(0, 5).join(', ')}`)
  }
  const stats = computeStats(politicians, base)
  console.log(`[ssg] dataset ready: policies=${base.policies.length} politicians=${politicians.length} (rows=${rows.length}) referencedPoliticians=${referenced.size} elections=${base.elections.length} discussions=${base.discussions.length}`)
  return { ...base, politicians, stats }
}

function dedupeById(politicians: Politician[]): Politician[] {
  const seen = new Set<string>()
  return politicians.filter((pl) => {
    const id = String(pl.id)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** 首頁統計：與瀏覽器端 getTotalPoliticianCount／getElectionPoliticianCount 的口徑對齊。 */
function computeStats(politicians: Politician[], base: DataSnapshot): DataStats {
  const politiciansByElection: Record<string, number> = {}
  for (const election of base.elections) {
    politiciansByElection[String(election.id)] = politicians.filter((pl) => pl.elections?.some((e) => e.electionId === election.id)).length
  }
  return { totalPoliticians: politicians.length, politiciansByElection }
}

/** 靜態內容頁。工具頁（/verify /ai-assistant /profile /auth/callback）與 /admin/* 刻意不預渲染。 */
const STATIC_CONTENT_ROUTES = ['/', '/tracking', '/analysis', '/community', '/regional-data', '/donation', '/skill']

const VILLAGE_CHIEF = '村里長'

/** SSG_POLITICIANS=with-content 時只預渲染有實質內容的人（有簡介／口號／照片／政見，或非村里長）。預設 all。 */
function politicianScope(): 'all' | 'with-content' {
  const raw = typeof process !== 'undefined' ? process.env.SSG_POLITICIANS : undefined
  return raw === 'with-content' ? 'with-content' : 'all'
}

function hasContent(pl: Politician, politicianIdsWithPolicies: Set<string>): boolean {
  if (pl.bio || pl.slogan || pl.avatarUrl) return true
  if (politicianIdsWithPolicies.has(String(pl.id))) return true
  return (pl.elections || []).some((e) => e.electionType && e.electionType !== VILLAGE_CHIEF)
}

/** 建置時要預渲染的完整路徑清單。 */
export function collectRoutePaths(full: DataSnapshot): string[] {
  const scope = politicianScope()
  const idsWithPolicies = new Set(full.policies.map((p) => String(p.politicianId)))
  const politicians = scope === 'with-content'
    ? full.politicians.filter((pl) => hasContent(pl, idsWithPolicies))
    : full.politicians

  const paths = [
    ...STATIC_CONTENT_ROUTES,
    ...full.elections.map((e) => `/election/${e.id}`),
    ...full.policies.map((p) => `/policy/${p.id}`),
    ...analysisListedPolicyIds(full.policies).map((id) => `/analysis/${id}`),
    ...politicians.map((pl) => `/politician/${pl.id}`),
    ...full.discussions.map((d) => `/community/${d.id}`),
  ]
  console.log(`[ssg] routes: ${paths.length} (politicians scope=${scope}: ${politicians.length}/${full.politicians.length})`)
  return paths
}
