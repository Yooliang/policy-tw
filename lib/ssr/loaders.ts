import type { RouteLocationNormalized } from 'vue-router'
import { supabasePublic } from '../supabase'
import { getDataSnapshot, mapPolicy, mapPolitician, useSupabase, type DataSnapshot } from '../../composables/useSupabase'
import type { Policy, Politician, RawPolicy, RawPolitician } from '../../types'
import { collectRelayChainIds, type PageSnapshot } from '../ssg/page-data'

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

export async function loadPoliticianPage(id: string): Promise<PageSnapshot | null> {
  const base = await loadBase()
  const [politicians, policies] = await Promise.all([politiciansByIds([id]), policiesOfPoliticians([id])])
  if (politicians.length === 0) return null
  return { ...base, politicians, policies }
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
