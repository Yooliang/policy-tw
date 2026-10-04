import type { RouteLocationNormalized } from 'vue-router'
import { supabasePublic } from '../supabase'
import { getDataSnapshot, mapPolicy, mapPolitician, useSupabase, type DataSnapshot } from '../../composables/useSupabase'
import type { Policy, Politician, RawPolicy, RawPolitician } from '../../types'
import { collectRelayChainIds, type PageSnapshot } from '../ssg/page-data'
import { electionPeers, primaryElection } from '../election-peers'
import { isCounty } from '../election-regions'
import { fetchAllPages } from '../fetch-all-pages'

/**
 * 邊緣 SSR 的每頁資料載入器（2026-09-23，docs/PLAN-edge-ssr.md 第 1 步）。
 *
 * 跟 lib/ssg/page-data.ts 的切片邏輯一對一，但不是從全庫快照切，而是每個請求只向 Supabase 拿那一頁需要的表：
 * 人物頁＝那個人＋他的政見；政見頁＝那一筆＋接力鏈＋同一人的政見＋被提到的人物。
 * 回的是同一個 PageSnapshot 型別，所以既有頁面元件與 applyDataSnapshot 零改動。
 */

/** 基礎資料（選舉／分類／地區）：每個 isolate 撈一次、10 分鐘後重撈；這三張表幾天才變一次 */
const BASE_TTL_MS = 10 * 60 * 1000
let basePromise: Promise<DataSnapshot> | null = null
let baseAt = 0
function loadBase(): Promise<DataSnapshot> {
  if (!basePromise || Date.now() - baseAt > BASE_TTL_MS) {
    baseAt = Date.now()
    basePromise = (async () => {
      const { fetchAll } = useSupabase()
      await fetchAll()
      const full = getDataSnapshot()
      return {
        ...full,
        policiesComplete: false,
        regionStats: [],
        electoralDistrictAreas: [],
        policies: [],
        politicians: [],
        discussions: [],
        generatedAt: Date.now(),
      }
    })().catch((e) => { basePromise = null; throw e })
  }
  return basePromise
}

async function policiesOfPoliticians(ids: string[]): Promise<Policy[]> {
  if (ids.length === 0) return []
  // query-bounds: ok — 一個人的政見最多幾十筆
  const { data, error } = await supabasePublic.from('policies_with_logs').select('*').in('politician_id', ids).order('id').limit(1000)
  if (error) throw new Error(`policies_with_logs by politician: ${error.message}`)
  return ((data ?? []) as RawPolicy[]).map(mapPolicy)
}

async function policiesByIds(ids: string[]): Promise<Policy[]> {
  if (ids.length === 0) return []
  // query-bounds: ok — 接力鏈最多幾十筆
  const { data, error } = await supabasePublic.from('policies_with_logs').select('*').in('id', ids.slice(0, 500)).order('id').limit(500)
  if (error) throw new Error(`policies_with_logs by id: ${error.message}`)
  return ((data ?? []) as RawPolicy[]).map(mapPolicy)
}

async function politiciansByIds(ids: string[]): Promise<Politician[]> {
  if (ids.length === 0) return []
  // query-bounds: ok — 一頁提到的人物是個位數
  const { data, error } = await supabasePublic.from('politicians_with_elections').select('*').in('id', ids.slice(0, 200)).order('id').limit(200)
  if (error) throw new Error(`politicians_with_elections by id: ${error.message}`)
  return ((data ?? []) as RawPolitician[]).filter((r) => !r.merged_into).map(mapPolitician)
}

/**
 * 同選區其他候選人（2026-09-30）：同屆、同選舉類型、同選區（村里長用 politician_elections.region_id；其餘用 RPC 撈全縣再比對選區）。
 * 撈回來再用 lib/election-peers.ts 的同一套規則篩＋排序＋截 20 位，跟預渲染切片、頁面元件算的一致。
 * 撈不到（查詢失敗、沒有選區）就回空陣列：這塊是加分項，不能讓整頁掛掉。
 */
async function peersOf(self: Politician): Promise<Politician[]> {
  const rec = primaryElection(self)
  if (!rec || !rec.electionType || !isCounty(rec.region)) return []
  try {
    // 村里長一個縣市上千人，只撈同一個 region_id（同村里）；其餘類型全縣撈（議員一縣最多兩百多人），
    // 用文字的縣市／選區比對——region_id 不同但選區文字相同的人也要算進來，跟縣市頁點進來時看到的一致
    if (rec.electionType !== '村里長') {
      // RPC 靠 politician_elections.region_id 對縣市，region_id 是空的參選紀錄（例：台北市第03選區的楊寶楨）撈不到；
      // 再用人物層的縣市＋選舉類型補一次，兩邊合併後交給 electionPeers 用參選紀錄的文字比對
      // （election_ids 是 json 不是 jsonb，不能用 contains 篩屆別；撈回來由 electionPeers 比對屆別）
      // 單一縣市、單一選舉類型的人物（跨屆）目前最多三四百位，但這跟
      // composables/useSupabase.ts 用的是同一支沒有上限的 RPC，靠呼叫端自律遲早會踩到
      // （人物層的 election_type 與參選紀錄層不同源，一有歪掉池子就破千）。一律分頁撈完。
      const [byRpc, byView] = await Promise.all([
        fetchAllPages<RawPolitician>(
          `同選區參選人 ${rec.electionId}/${rec.region}/${rec.electionType}`,
          (from, to) => supabasePublic
            .rpc('get_politicians_by_filters', { p_election_id: rec.electionId, p_region: rec.region, p_election_types: [rec.electionType] })
            .order('id').range(from, to),
        ),
        supabasePublic.from('politicians_with_elections').select('*')
          .eq('region', rec.region).eq('election_type', rec.electionType)
          .order('id').limit(1000),
      ])
      const rows = [...byRpc.rows, ...(byView.error ? [] : (byView.data ?? []) as RawPolitician[])]
      const seen = new Set<string>()
      const pool = rows.filter((r) => !r.merged_into && !seen.has(r.id) && !!seen.add(r.id)).map(mapPolitician)
      return electionPeers(self, pool)
    }
    if (!rec.regionId) return []
    // query-bounds: ok — 一個村里的候選人最多個位數
    const { data, error } = await supabasePublic.from('politician_elections').select('politician_id')
      .eq('election_id', rec.electionId).eq('election_type', rec.electionType).eq('region_id', rec.regionId)
      .order('politician_id').limit(100)
    if (error) throw error
    const ids = Array.from(new Set(((data ?? []) as Array<{ politician_id: string }>).map((r) => String(r.politician_id))))
      .filter((pid) => pid !== String(self.id))
    return electionPeers(self, await politiciansByIds(ids))
  } catch {
    return []
  }
}

export async function loadPoliticianPage(id: string): Promise<PageSnapshot | null> {
  const base = await loadBase()
  const [politicians, policies] = await Promise.all([politiciansByIds([id]), policiesOfPoliticians([id])])
  if (politicians.length === 0) return null
  const peers = await peersOf(politicians[0])
  return { ...base, politicians: [...politicians, ...peers], policies }
}

export async function loadPolicyPage(id: string): Promise<PageSnapshot | null> {
  const base = await loadBase()
  const [start] = await policiesByIds([id])
  if (!start) return null
  // 接力鏈：沿 relatedPolicyIds 逐跳撈，最多 4 跳；再加同一人的全部政見（page-data 的 policy case 就是這兩份）
  const pool = new Map<string, Policy>([[String(start.id), start]])
  let frontier = start.relatedPolicyIds ?? []
  for (let hop = 0; hop < 4 && frontier.length > 0; hop++) {
    const missing = frontier.filter((x) => !pool.has(String(x)))
    if (missing.length === 0) break
    const got = await policiesByIds(missing.map(String))
    frontier = []
    for (const p of got) {
      pool.set(String(p.id), p)
      for (const r of p.relatedPolicyIds ?? []) if (!pool.has(String(r))) frontier.push(String(r))
    }
  }
  for (const p of await policiesOfPoliticians([String(start.politicianId)])) pool.set(String(p.id), p)
  const all = Array.from(pool.values())
  const keep = collectRelayChainIds(String(start.id), all)
  all.filter((p) => String(p.politicianId) === String(start.politicianId)).forEach((p) => keep.add(p.id))
  const policies = all.filter((p) => keep.has(p.id))
  const politicians = await politiciansByIds(Array.from(new Set(policies.map((p) => String(p.politicianId)))))
  return { ...base, policies, politicians }
}

/** 路由 → 這一頁的快照；不是這一步負責的路由回 undefined（Worker 會退回代理 web.app） */
export async function loadPageData(to: RouteLocationNormalized): Promise<PageSnapshot | null | undefined> {
  const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
  switch (to.name) {
    case 'politician': return await loadPoliticianPage(param(to.params.politicianId as string | string[]))
    case 'policy': return await loadPolicyPage(param(to.params.policyId as string | string[]))
    default: return undefined
  }
}
