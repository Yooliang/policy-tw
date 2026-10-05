/**
 * 同職位、同選區參選人的政見並排比較（#364，2026-10-05；日本站 keifu 的「公約を並べて見る」同一個做法）。
 *
 *   列＝政見類別，欄＝同職位同選區的參選人，格子＝那個人在這一類的政見與三要素。
 *   欄的順序：有號次照號次，還沒有號次照姓名筆畫——**只並排、不排名、不打分**，不照政見數、關注度、黨派排。
 *   沒有這一類政見的格子照實寫「沒有這一類的政見」；三要素的「未說明／未調查」由 lib/policy-elements.ts 決定。
 *
 * 零執行期依賴以外只用 region-name、district-grouping 兩支純函式，能被 deno 直接測。
 */
import type { Policy } from '../types'
import { compareRegionName } from './region-name'
import { isFormalDistrict } from './district-grouping'

export interface ComparePerson {
  id: string | number
  name: string
  candNo?: number
  candidateStatus?: string
  electionType?: string
  region?: string
  subRegion?: string
  village?: string
  /** 參選職位文字；總統副總統那一場用它認出副手（選舉頁的總統排序也是看這一欄有沒有「副」） */
  position?: string
}

/** 欄的順序：有號次的照號次在前；還沒有號次的照姓名筆畫（先字數再筆畫，跟選舉頁「姓名筆畫」排序同一套） */
export function compareColumnOrder(a: ComparePerson, b: ComparePerson): number {
  const an = typeof a.candNo === 'number' && a.candNo > 0 ? a.candNo : null
  const bn = typeof b.candNo === 'number' && b.candNo > 0 ? b.candNo : null
  if (an !== null && bn !== null && an !== bn) return an - bn
  if (an !== null && bn === null) return -1
  if (an === null && bn !== null) return 1
  return compareRegionName(a.name, b.name)
}

/** 會出現在選票上的人：表態不參選、退選的不並排 */
export function comparablePeople<T extends ComparePerson>(people: readonly T[]): T[] {
  return people.filter((p) => p.candidateStatus !== 'withdrawn' && p.candidateStatus !== 'not_running').sort(compareColumnOrder)
}

/**
 * 這一場選舉提的政見：屆別（policies.election_id → elections.id）相同。任內施政承諾（Proposed：當選後才宣布的）不是這場選舉的承諾，不放進來；
 * 推動中、已實現、跳票的照放——它們原本就是這場選舉的承諾，只是後來有了進度。
 */
export function belongsToElection(p: Pick<Policy, 'electionId' | 'status'>, electionId: number): boolean {
  return p.electionId === electionId && p.status !== 'Proposed'
}

export interface CompareGroup<T> {
  key: string
  /** 選區名（同一個區塊裡有好幾個選區時才需要顯示）；全國、縣市長是空字串 */
  label: string
  people: T[]
}

/**
 * 卡片排法的職位（縣市長、立委、鄉鎮市長、原住民區長…）裡，誰跟誰是同一場：
 *   總統副總統：全國一場，一組搭檔算一欄——副手不另佔一欄（政見掛在總統參選人名下）
 *   縣市長：一個縣市一場
 *   立法委員：一個選區一場（只認正式選區寫法；沒選區的不並排——不知道他跟誰同一場）
 *   其餘（鄉鎮層的首長）：一個鄉鎮市區一場；縣市頁的「下一層」會同時列好幾個鄉鎮的人，要拆開
 * 依村里、依選區分組的職位不走這裡：選舉頁已經分好組，直接拿那一組（「選區待補」那組不並排）。
 */
export function gridCompareGroups<T extends ComparePerson>(people: readonly T[], electionType: string): CompareGroup<T>[] {
  const keyOf = (p: T): { key: string; label: string } | null => {
    if (electionType === '總統副總統') return p.position?.includes('副') ? null : { key: '全國', label: '' }
    if (electionType === '縣市長') return p.region ? { key: p.region, label: '' } : null
    const sub = p.subRegion?.trim()
    if (!sub) return null
    if (electionType === '立法委員' && !isFormalDistrict(sub, '立法委員')) return null
    return { key: `${p.region ?? ''}|${sub}`, label: sub }
  }
  const groups = new Map<string, CompareGroup<T>>()
  for (const p of people) {
    const k = keyOf(p)
    if (!k) continue
    const g = groups.get(k.key) ?? { key: k.key, label: k.label, people: [] }
    g.people.push(p)
    groups.set(k.key, g)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant-TW', { numeric: true }))
}

export interface CompareRow {
  category: string
  /** 跟 columns 同一個順序；每格是那個人在這一類的政見（可能是空的） */
  cells: Policy[][]
}

export interface CompareMatrix<T> {
  columns: T[]
  rows: CompareRow[]
  /** 表裡一共幾條政見 */
  policyCount: number
}

/**
 * 組並排比較的表：只列至少一個人有政見的類別，類別順序照網站的分類表（categoryOrder），
 * 不在分類表裡的舊類別排在最後。格子裡照標題排，不照誰的政見比較多。
 */
export function compareMatrix<T extends ComparePerson>(
  people: readonly T[],
  policies: readonly Policy[],
  electionId: number,
  categoryOrder: readonly string[],
): CompareMatrix<T> {
  const columns = comparablePeople(people)
  const ids = new Set(columns.map((c) => String(c.id)))
  const mine = policies.filter((p) => ids.has(String(p.politicianId)) && belongsToElection(p, electionId))
  const categories = [...new Set(mine.map((p) => p.category || '其他'))]
  const rank = (c: string) => { const i = categoryOrder.indexOf(c); return i < 0 ? Number.MAX_SAFE_INTEGER : i }
  categories.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'zh-Hant-TW'))
  const rows = categories.map((category) => ({
    category,
    cells: columns.map((c) => mine
      .filter((p) => String(p.politicianId) === String(c.id) && (p.category || '其他') === category)
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant-TW'))),
  }))
  return { columns, rows, policyCount: mine.length }
}

/** 值得畫一張並排比較：至少兩位參選人，而且至少有一條這場選舉的政見 */
export function worthComparing<T>(m: CompareMatrix<T>): boolean {
  return m.columns.length >= 2 && m.policyCount > 0
}
