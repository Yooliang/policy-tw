import fs from 'node:fs'
import path from 'node:path'
import {
  fetchAllRows,
  getDataSnapshot,
  mapPolitician,
  useSupabase,
  type DataSnapshot,
  type DataStats,
  ensureRegionStats,
  ensureDistricts,
  ensureDiscussions,
  ensurePolicies,
  ensureVerificationSources,
} from '../../composables/useSupabase'
import type { Lineage, Politician, RawLineage, RawPolitician } from '../../types'
import { mapLineage } from '../lineage'
import { isMissingRelation } from '../retry'
import { analysisListedPolicyIds } from './page-data'
import { isRunningCandidate } from '../candidate-status'
import { isCounty, SPECIAL_MUNICIPALITIES, TAIWAN_COUNTIES } from '../election-regions'
import { townshipPagesOf } from '../election-townships'
import { electionSegment, segmentOfId } from '../election-route'
import type { PartyAliasRow, PartyRegistry, PartyRow } from '../parties'
import { directoryFor, partyListFor } from './page-data'

/**
 * 建置端專用：一次撈齊全站資料（含 15,000+ 政治人物），之後每頁只切片、不再打 Supabase。
 * 只會被 main.ts 在 SSR 分支動態 import，不進客戶端 bundle。
 */

let datasetPromise: Promise<DataSnapshot> | null = null

export function ensureFullDataset(): Promise<DataSnapshot> {
  if (!datasetPromise) datasetPromise = loadFullDataset()
  return datasetPromise
}

const FETCH_ATTEMPTS = 3
const RETRY_DELAY_MS = [0, 3000, 9000]

/**
 * 建置期間的暫時性失敗要重試，不要整條 CI 紅掉。
 *
 * 2026-09-13 實際發生：`Failed to fetch data from Supabase: { message: 'Gateway Timeout' }`
 * → 建置中止 → 那次合併的改動整批沒有部署，而且畫面上看起來只是「CI 紅了」。
 * 中止本身是對的（產出空殼頁更糟），錯的是只試一次。
 *
 * 刻意只重試「拿不到資料」，不重試「資料是空的」：後者代表 Supabase 回了但內容不對，
 * 那是真的該停下來的狀況，重試只會拖長時間然後得到同一個答案。
 */
async function withRetry<T>(label: string, run: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let last: unknown = null
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (RETRY_DELAY_MS[attempt] > 0) {
      console.warn(`[ssg] ${label} 第 ${attempt} 次沒成功，${RETRY_DELAY_MS[attempt] / 1000} 秒後重試`)
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS[attempt]))
    }
    try {
      const v = await run()
      if (ok(v)) return v
      last = new Error(`${label} 回傳的內容不完整`)
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error(`[ssg] ${label} 連續 ${FETCH_ATTEMPTS} 次失敗`)
}

async function loadFullDataset(): Promise<DataSnapshot> {
  const { fetchAll, loaded } = useSupabase()
  await withRetry(
    '基礎資料（政見／選舉／分類）',
    async () => { await fetchAll(); return loaded.value },
    (ok) => ok,
  ).catch(() => {
    throw new Error('[ssg] 基礎資料（政見／選舉／分類）連續三次載入失敗，中止建置以免產出空殼頁')
  })
  // 首屏已經把政見清單／regions／選舉區對應／討論／查證來源改成按需載入，但預渲染要靠完整
  // 資料切片，所以建置端明確把五塊都補上。漏掉的話對應的頁面會預渲染成空的
  // （政見那塊漏掉更嚴重：下面的「基礎資料為空」會直接中止建置）。
  await withRetry('按需載入的五塊（政見／regions／選舉區／討論／查證來源）', async () => {
    await Promise.all([ensurePolicies(), ensureRegionStats(), ensureDistricts(), ensureDiscussions(), ensureVerificationSources()])
    return true
  }, (ok) => ok)

  const base = getDataSnapshot()
  if (base.policies.length === 0 || base.elections.length === 0) {
    throw new Error(`[ssg] 基礎資料為空（policies=${base.policies.length}, elections=${base.elections.length}），中止建置`)
  }

  // 一定要排序：這個 view 沒有 ORDER BY，分頁撈會重複／漏筆
  const rows = await withRetry(
    'politicians_with_elections',
    () => fetchAllRows<RawPolitician>('politicians_with_elections', '*', 'id'),
    (r) => r.length > 0,
  )
  // 已軟合併的人物不預渲染也不進清單：直接開舊網址會在客戶端載到 merged_into 再轉向
  const politicians = dedupeById(rows.filter((r) => !r.merged_into).map(mapPolitician))
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
  const lineages = await loadLineages()
  const partyRegistry = await loadPartyRegistry()
  console.log(`[ssg] dataset ready: policies=${base.policies.length} politicians=${politicians.length} (rows=${rows.length}) referencedPoliticians=${referenced.size} elections=${base.elections.length} discussions=${base.discussions.length} lineages=${lineages.length} parties=${partyRegistry.parties.length}`)
  return { ...base, politicians, stats, lineages, lineagesComplete: true, partyRegistry }
}

/**
 * 政黨表與寫法對照（#346）：讀資料庫的 parties／party_aliases。表還不存在（前端比 migration 早上線：CI 先建置、
 * 部署完 Hosting 才 db push）就用 lib/party-seed.json——它跟 migration 的資料段是同一份（lib/parties.test.ts 盯著），
 * 政黨頁第一次建置就有內容，不必等下一次合併。其他錯照樣重試、三次失敗中止建置。
 */
async function loadPartyRegistry(): Promise<PartyRegistry> {
  return await withRetry('parties／party_aliases', async () => {
    try {
      const [parties, aliases] = await Promise.all([
        fetchAllRows<PartyRow>('parties', 'id,name,short_name,moi_no,moi_name,moi_status,valid_from,valid_to,predecessor_id,note', 'id'),
        fetchAllRows<PartyAliasRow>('party_aliases', 'alias_key,alias,party_id,kind,note', 'alias_key'),
      ])
      // 改名的根據（內政部該政黨頁）在出處表；建置端只拿來附連結，跟 seed 那一份一樣
      const seed = readPartySeed()
      const evidence = new Map(seed.parties.filter((p) => p.evidence_url).map((p) => [p.id, p.evidence_url]))
      return { parties: parties.map((p) => ({ ...p, evidence_url: evidence.get(p.id) ?? null })), aliases }
    } catch (err) {
      if (isMissingRelation(err)) {
        console.warn('[ssg] parties／party_aliases 還不存在（migration 還沒套上），政黨先用 lib/party-seed.json')
        return readPartySeed()
      }
      throw err
    }
  }, (r) => r.parties.length > 0)
}

function readPartySeed(): PartyRegistry {
  const file = path.resolve(process.cwd(), 'lib/party-seed.json')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PartyRegistry
}

/**
 * 政策脈絡（#349）：脈絡一覽要整份、脈絡頁進網站地圖。視圖還不存在（前端比 migration 早上線）就當成還沒有脈絡；
 * 其他錯照樣重試、三次失敗中止建置（跟其他資料一樣，產出缺一塊的頁面比不建置更糟）。
 * 不走 ensureLineages：那支失敗會寫全域的 error，預渲染的每一頁都會讀到。
 */
async function loadLineages(): Promise<Lineage[]> {
  return await withRetry('lineages_full', async () => {
    try {
      const rows = await fetchAllRows<RawLineage>('lineages_full', '*', 'id')
      return rows.map(mapLineage).filter((l): l is Lineage => !!l)
    } catch (err) {
      if (isMissingRelation(err)) {
        console.warn('[ssg] lineages_full 還不存在（migration 還沒套上），政策脈絡先當成 0 條')
        return []
      }
      throw err
    }
  }, () => true)
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
    politiciansByElection[String(election.id)] = politicians
      .filter((pl) => pl.elections?.some((e) => e.electionId === election.id && isRunningCandidate(e.candidacyStatus)))
      .length
  }
  return { totalPoliticians: politicians.length, politiciansByElection }
}

/** 靜態內容頁。工具頁（/verify /contributions /tasks /stats /ai /profile /auth/callback）與 /admin/* 刻意不預渲染。 */
const STATIC_CONTENT_ROUTES = ['/', '/tracking', '/analysis', '/elections', '/community', '/regional-data', '/donation', '/skill', '/vision', '/privacy', '/sources', '/politicians', '/parties']

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

/**
 * 縣市頁（/election/:id/:縣市，2026-09-30）：每一屆、有在選候選人的縣市各一頁。
 * 路徑用未編碼的中文交給 vite-ssg（它照路由渲染、照路徑寫檔）；postbuild 再把檔案搬到 ASCII 路徑（見 cloudflare/region-path.js）。
 */
export function electionRegionRoutes(full: DataSnapshot): string[] {
  const paths: string[] = []
  for (const election of full.elections) {
    const regions = new Set<string>()
    for (const pl of full.politicians) {
      for (const e of pl.elections ?? []) {
        if (e.electionId === election.id && isRunningCandidate(e.candidacyStatus)) regions.add(e.region)
      }
    }
    // 網址那一段：舊三屆是 id、新增的選舉（補選、重行選舉）是 election_key（lib/election-route.ts）
    for (const county of TAIWAN_COUNTIES) if (regions.has(county)) paths.push(`/election/${electionSegment(election)}/${county}`)
  }
  return paths
}

/**
 * 鄉鎮頁（/election/:id/:縣市/:鄉鎮，2026-10-05）：每一屆、每個「鄉鎮頁會列出來的職位」有人在選的鄉鎮市區各一頁
 * （規則在 lib/election-townships.ts，跟頁面撈的職位同一份）。一位都沒有的鄉鎮不出頁。
 * 路徑一樣用未編碼的中文；postbuild 搬到 ASCII 路徑 election/:id/_r/<縣市十六進位>/<鄉鎮十六進位>/。
 */
export function electionTownshipRoutes(full: DataSnapshot): string[] {
  const knownElections = new Set(full.elections.map((e) => e.id))
  const records = full.politicians.flatMap((pl) => (pl.elections ?? [])
    .filter((e) => knownElections.has(e.electionId) && isRunningCandidate(e.candidacyStatus)))
  return townshipPagesOf(
    records,
    (region) => isCounty(region),
    (region) => SPECIAL_MUNICIPALITIES.includes(region as typeof SPECIAL_MUNICIPALITIES[number]),
  ).map((p) => `/election/${segmentOfId(full.elections, p.electionId)}/${p.region}/${p.township}`)
}

/** 建置時要預渲染的完整路徑清單。 */
/** 邊緣渲染頁的清單寫給 scripts/postbuild-ssg.mjs 產網站地圖（它讀完就刪，不會部署出去） */
export const EDGE_ROUTES_FILE = 'dist/.edge-routes.json'
function writeEdgeRoutes(paths: string[]): void {
  fs.mkdirSync(path.dirname(EDGE_ROUTES_FILE), { recursive: true })
  fs.writeFileSync(EDGE_ROUTES_FILE, JSON.stringify(paths), 'utf8')
}

export function collectRoutePaths(full: DataSnapshot): string[] {
  const scope = politicianScope()
  const idsWithPolicies = new Set(full.policies.map((p) => String(p.politicianId)))
  const politicians = scope === 'with-content'
    ? full.politicians.filter((pl) => hasContent(pl, idsWithPolicies))
    : full.politicians

  // 政治人物頁、政見頁由正見.tw 的 Worker 在邊緣現場渲染（cloudflare/ssr-worker.js 的 SSR_ROUTES），
  // 預渲染不再產生（2026-09-24 維護者：建置從約 4 分鐘降下來）。清單照樣交給 postbuild 產網站地圖。
  // 要退回全部預渲染：SSG_EDGE_PAGES=prerender。
  const edgePaths = [
    ...politicians.map((pl) => `/politician/${pl.id}`),
    ...full.policies.map((p) => `/policy/${p.id}`),
    // 政策脈絡頁（#349）：跟政見頁一樣由 Worker 邊緣渲染，這裡只進網站地圖
    ...(full.lineages ?? []).map((l) => `/lineage/${l.id}`),
  ]
  const prerenderEdge = process.env.SSG_EDGE_PAGES === 'prerender'
  const paths = [
    ...STATIC_CONTENT_ROUTES,
    ...full.elections.map((e) => `/election/${electionSegment(e)}`),
    ...electionRegionRoutes(full),
    ...electionTownshipRoutes(full),
    ...analysisListedPolicyIds(full.policies).map((id) => `/analysis/${id}`),
    ...full.discussions.map((d) => `/community/${d.id}`),
    // 人物一覽的各組（筆畫）、各黨頁（#346）：網址都是 ASCII（/politicians/11、/party/16）
    ...directoryFor(full).index.map((g) => `/politicians/${g.key}`),
    ...partyListFor(full).map((p) => `/party/${p.id}`),
    ...(prerenderEdge ? edgePaths : []),
  ]
  if (!prerenderEdge) writeEdgeRoutes(edgePaths)
  console.log(`[ssg] routes: ${paths.length} 預渲染＋${prerenderEdge ? 0 : edgePaths.length} 邊緣渲染 (politicians scope=${scope}: ${politicians.length}/${full.politicians.length})`)
  return paths
}
