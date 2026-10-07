/**
 * 預產：把一份資料（選舉、人物、政見、各縣市候選人）組成所有「不是人物」的 Markdown 內容、機器可讀索引與矩陣（維護者 10-07：摘要定時預產、
 * 快取起來，不要每次被讀才算；人物的 .md 量大，維持 Worker 讀時產生）。
 *
 * 純函式：資料怎麼撈在 lib/ssr/md-loaders.ts，排程腳本 scripts/build-data-md.ts 把這裡的輸出寫進 data_md_cache。
 * 路徑一律是「解碼後」的站內路徑（/data/2026/台南市/交通建設.md），跟 Worker 讀快取時查的鍵同一種寫法。
 * 一次產生的全部檔案共用同一個 generatedAt（同一批換新，不會撈到一半新舊混雜）。
 */
import type { Election, Policy, Politician } from '../../types'
import { electionSegment } from '../election-route'
import { TAIWAN_COUNTIES } from '../election-regions'
import { CATEGORIES } from '../data-query'
import { latestLocalElection, regionOfRecord, runningRecord, scopePeople } from './scope'
import { buildRegionPage } from './region'
import { buildCategoryPage, buildRegionCategoryPage, categoryCount, type ListContext } from './lists'
import { buildIndexPage } from './index-page'
import { DATASET_KIND, SCOPE_VERSION, partitionPolicies } from './pledge'
import {
  FORMAT_VERSION, LICENSE, LICENSE_URL, abs, dataCategoryMdPath, dataIndexJsonPath, dataIndexMdPath, dataRegionCategoryMdPath, dataRegionMdPath,
  latestTime, taipeiIso, type MdPage,
} from './format'

export interface RegionCandidates {
  candidates: Politician[]
  truncated: boolean
}

export interface Corpus {
  elections: Election[]
  /** 名下至少有一筆政見的人物（完整的人物列，含參選紀錄） */
  people: Politician[]
  /** 全部沒被移除的政見 */
  policies: Policy[]
  /** `${選舉 id}|${縣市}` → 那一屆在那個縣市在選的候選人（含沒有政見的）；撈不到的鍵不放 */
  regionCandidates: Map<string, RegionCandidates>
  /** 今天（台北，YYYY-MM-DD） */
  today: string
}

export const regionCandidatesKey = (electionId: number, region: string) => `${electionId}|${region}`

export type PageType = 'region' | 'category' | 'region_category' | 'index'

export interface GeneratedPage {
  /** 解碼後的站內路徑（含 .md） */
  path: string
  type: PageType
  region?: string
  category?: string
  page: MdPage
}

/** 機器可讀索引（/data/<屆>/index.json）也進快取：路徑與內容字串 */
export interface GeneratedJson { path: string; body: string; rowCount: number }

/** 矩陣頁（/election/<屆>/matrix）要的數字：縣市×分類的政見筆數；只算最新一屆在選候選人名下、這一屆的競選承諾（lib/md/pledge.ts） */
export interface Matrix {
  /** 這份矩陣算的是哪一屆 */
  election: { id: number; segment: string; name: string; year: string }
  regions: string[]
  /** 分類（照網站分類順序） */
  categories: string[]
  /** counts[縣市][分類] ＝ 政見筆數（跟對應 .md 的筆數同一個算法） */
  counts: Record<string, Record<string, number>>
  regionTotals: Record<string, number>
  categoryTotals: Record<string, number>
  total: number
}

export const MATRIX_PATH = '_matrix'

/** index.json 的 changelog 裡這一次範圍改動那一行（維護者 2026-10-07：已導入 NotebookLM 的人要重新匯入） */
export const CHANGELOG_SCOPE_BY_POLICY = '2026-10-07 範圍由人改為政見'

export interface BuildOptions {
  /** 這一批的產生時間（epoch ms）：索引裡每個檔案都帶它，跟資料庫列的 generated_at 同一個值 */
  generatedAt: number
  /** 內容雜湊（排程腳本用 sha256；測試給簡單的）：索引裡每個檔案帶它，程式可以不抓檔案就知道有沒有變 */
  sha: (page: MdPage) => string
}

export interface BuildResult {
  pages: GeneratedPage[]
  json: GeneratedJson[]
  matrix: Matrix | null
}

export function buildAll(c: Corpus, opts: BuildOptions): BuildResult {
  const pages: GeneratedPage[] = []
  const json: GeneratedJson[] = []
  const latest = latestLocalElection(c.elections)

  // 縣市（某屆）：每一場選舉、每個縣市，有撈到候選人的才產
  for (const e of c.elections) {
    for (const region of TAIWAN_COUNTIES) {
      const got = c.regionCandidates.get(regionCandidatesKey(e.id, region))
      // 候選人名單用 RPC 撈（含沒有政見的人）；參選紀錄的 region_id 是空的人 RPC 撈不到（lib/ssr/loaders.ts peersOf 的註解），
      // 所以再併進「有政見而且參選紀錄的縣市就是這裡」的人——矩陣與分類 .md 算的就是這批，縣市頁一定要看得到他們
      const extra = c.people.filter((p) => { const rec = runningRecord(p, e.id); return !!rec && regionOfRecord(rec.region) === region })
      const seen = new Set<string>()
      const candidates = [...(got?.candidates ?? []), ...extra].filter((p) => !seen.has(p.id) && !!seen.add(p.id))
      if (candidates.length === 0) continue
      const ids = new Set(candidates.map((p) => p.id))
      const segment = electionSegment(e)
      pages.push({
        path: `/election/${segment}/${region}.md`,
        type: 'region',
        region,
        page: buildRegionPage({ election: e, segment, region, candidates, policies: c.policies.filter((p) => ids.has(p.politicianId)), today: c.today, truncated: got?.truncated ?? false }),
      })
    }
  }

  let matrix: Matrix | null = null
  if (latest) {
    const segment = electionSegment(latest)
    const scoped = scopePeople(c.people, latest, c.today)
    const ctx: ListContext = { election: latest, segment, scoped, policies: c.policies }
    // 每一條政見要嘛在資料集（分類檔與矩陣）裡、要嘛算進 unassigned（依原因）；兩邊加起來剛好是全部（守門：下面的筆數核對與 md.test.ts）
    const { assigned, unassigned } = partitionPolicies({ election: latest, policies: c.policies, scopedIds: new Set(scoped.map((s) => s.politician.id)), elections: c.elections })
    const counts: Matrix['counts'] = {}
    const regionTotals: Record<string, number> = {}
    const categoryTotals: Record<string, number> = {}
    for (const cat of CATEGORIES) {
      const page = buildCategoryPage(cat, ctx)
      pages.push({ path: `/data/${segment}/${cat}.md`, type: 'category', category: cat, page })
      categoryTotals[cat] = page.rowCount
      for (const region of TAIWAN_COUNTIES) {
        const rc = buildRegionCategoryPage(region, cat, ctx)
        pages.push({ path: `/data/${segment}/${region}/${cat}.md`, type: 'region_category', region, category: cat, page: rc })
        ;(counts[region] ??= {})[cat] = rc.rowCount
        regionTotals[region] = (regionTotals[region] ?? 0) + rc.rowCount
        // 格子數字與頁面筆數是同一個算法（categoryCount）：不一致就是 bug，這裡直接擋
        if (categoryCount(region, cat, ctx) !== rc.rowCount) throw new Error(`矩陣與頁面筆數不一致：${region} ${cat}`)
      }
    }
    const total = Object.values(regionTotals).reduce((a, b) => a + b, 0)
    // 分類檔的筆數加總＝資料集裡的政見數：分範圍的算法（pledge.ts）與分頁的算法（lists.ts）不一致就是 bug，這裡直接擋
    const inCategoryPages = Object.values(categoryTotals).reduce((a, b) => a + b, 0)
    if (inCategoryPages !== assigned.length) throw new Error(`分類頁筆數 ${inCategoryPages} 與資料集政見數 ${assigned.length} 不一致`)
    if (assigned.length + unassigned.total !== c.policies.length) throw new Error('資料集與 unassigned 加起來不等於全部政見')
    matrix = {
      election: { id: latest.id, segment, name: latest.name, year: latest.electionDate.slice(0, 4) },
      regions: [...TAIWAN_COUNTIES], categories: [...CATEGORIES], counts, regionTotals, categoryTotals, total,
    }

    // 機器可讀索引：每個檔案的網址、類型、縣市、分類、筆數、產生時間、內容雜湊
    const at = taipeiIso(opts.generatedAt)
    const files = [
      ...TAIWAN_COUNTIES.flatMap((region) => {
        const p = pages.find((x) => x.type === 'region' && x.region === region && x.path.startsWith(`/election/${segment}/`))
        return p ? [{ url: abs(dataRegionMdPath(segment, region)), type: 'region', region, category: null, count: p.page.rowCount, generated_at: at, sha: opts.sha(p.page) }] : []
      }),
      ...CATEGORIES.map((cat) => {
        const p = pages.find((x) => x.type === 'category' && x.category === cat)!
        return { url: abs(dataCategoryMdPath(segment, cat)), type: 'category', region: null, category: cat, count: p.page.rowCount, generated_at: at, sha: opts.sha(p.page) }
      }),
      ...pages.filter((x) => x.type === 'region_category').map((p) => ({
        url: abs(dataRegionCategoryMdPath(segment, p.region!, p.category!)), type: 'region_category', region: p.region!, category: p.category!, count: p.page.rowCount, generated_at: at, sha: opts.sha(p.page),
      })),
    ]
    const asOf = latestTime(assigned.map((p) => p.updatedAt ?? p.lastUpdated))
    const indexPage = buildIndexPage({ ctx, matrix, dataAsOf: asOf })
    pages.push({ path: `/data/${segment}/index.md`, type: 'index', page: indexPage })
    json.push({
      path: `/data/${segment}/index.json`,
      rowCount: files.length,
      body: JSON.stringify({
        format_version: FORMAT_VERSION,
        source: '正見.tw',
        index_md: abs(dataIndexMdPath(segment)),
        url: abs(dataIndexJsonPath(segment)),
        election: matrix.election,
        generated_at: at,
        data_as_of: asOf,
        license: LICENSE,
        license_url: LICENSE_URL,
        total_policies: total,
        kind: DATASET_KIND,
        scope: {
          kind: DATASET_KIND,
          version: SCOPE_VERSION,
          election: segment,
          policy_rule: '政見來源是競選承諾（origin 為 pledge，或 status 為 Campaign Pledge，兩者擇一成立即算），而且屆別（election_id）是本屆',
          owner_rule: '擁有人是本屆的在選候選人（considering、declared、filed、elected、not_elected），職位限縣市長、縣市議員、立法委員、鄉鎮市長、原住民區長；落選者的承諾保留、標「未當選」；退選與已合併的人不收',
          unit: '筆（一筆政見）',
        },
        overlaps: {},
        unassigned,
        changelog: [CHANGELOG_SCOPE_BY_POLICY],
        files,
      }, null, 1),
    })
  }
  return { pages, json, matrix }
}
