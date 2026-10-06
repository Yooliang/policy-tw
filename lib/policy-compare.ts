/**
 * 政見 PK：同職位、同選區參選人的政見並排比較（#364 的並排比較，2026-10-06 小良哥指示併進選舉頁「政見 PK」頁籤、改成多人）。
 * 日本站 keifu 的「公約を並べて見る」同一個做法。
 *
 *   列＝政見類別，欄＝同職位同選區的參選人（預設這一組全部，可勾選增減），格子＝那個人在這一類的政見與三要素。
 *   欄的順序：有號次照號次，還沒有號次照姓名筆畫——**只並排、不排名、不打分**，不照政見數、關注度、黨派排。
 *   沒有這一類政見的格子照實寫「沒有這一類的政見」；三要素的「未說明／未調查」由 lib/policy-elements.ts 決定。
 *
 * 誰跟誰是同一場（pkGroupLabel）、PK 頁籤的網址參數（pkQuery、parsePick、buildPick）也在這裡：
 * 選舉頁每個職位區塊標題列的「政見 PK」按鈕、政見頁的「政見 PK」連結、PK 頁籤本身讀的是同一套，不會一邊改了另一邊連到不存在的組。
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

/** 依選舉區分組的職位：選區只認正式寫法（「選區待補」那些人不知道是哪一場） */
const DISTRICT_TYPES = ['縣市議員', '直轄市山地原住民區民代表', '立法委員']
/** 地名當組名的職位：組的順序照地名（先字數再筆畫）；選舉區照自然排序（第02 在第10 前面） */
const PLACE_TYPES = ['縣市長', '鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '村里長']

/**
 * 這個人在 PK 裡屬於哪一組（＝哪一場選舉）；undefined＝不知道是哪一場，或不另佔一欄（總統的副手）。
 *   總統副總統：全國一場，一組搭檔算一欄——副手不另佔一欄（政見掛在總統參選人名下）
 *   縣市長：一個縣市一場（組名＝縣市）
 *   縣市議員、原住民區代表、立法委員：一個選舉區一場（只認正式選區寫法）
 *   鄉鎮市長、鄉鎮市民代表、原住民區長：一個鄉鎮市區一場（組名＝資料上的鄉鎮或選區）
 *   村里長：一個村里一場（組名＝村里）
 * 組名就是 PK 網址的 district 參數，也是選舉頁分組標題上的名字（「縣市議員・第08選舉區」）。
 */
export function pkGroupLabel(p: Pick<ComparePerson, 'region' | 'subRegion' | 'village' | 'position'>, electionType: string): string | undefined {
  if (electionType === '總統副總統') return p.position?.includes('副') ? undefined : '全國'
  if (electionType === '縣市長') return p.region?.trim() || undefined
  const sub = p.subRegion?.trim()
  if (DISTRICT_TYPES.includes(electionType)) return sub && isFormalDistrict(sub, electionType) ? sub : undefined
  if (electionType === '村里長') return p.village?.trim() || undefined
  return sub || undefined
}

export interface CompareGroup<T> {
  /** 組名（PK 網址的 district 參數） */
  label: string
  people: T[]
}

/** 把同一職位的人分成一場一組；不知道是哪一場的人不並排。組的順序：地名先字數再筆畫、選舉區自然排序 */
export function pkGroups<T extends ComparePerson>(people: readonly T[], electionType: string): CompareGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const p of people) {
    const label = pkGroupLabel(p, electionType)
    if (!label) continue
    groups.set(label, [...(groups.get(label) ?? []), p])
  }
  const byPlace = PLACE_TYPES.includes(electionType)
  return [...groups.entries()]
    .map(([label, members]) => ({ label, people: members }))
    .sort((a, b) => byPlace ? compareRegionName(a.label, b.label) : a.label.localeCompare(b.label, 'zh-Hant-TW', { numeric: true }))
}

/** 至少兩位會出現在選票上的人才有 PK 可看（區塊標題列的「政見 PK」按鈕照這個決定給不給） */
export function hasPk<T extends ComparePerson>(group: CompareGroup<T> | undefined): boolean {
  return !!group && comparablePeople(group.people).length >= 2
}

/**
 * 網址選的那一場；沒帶組名、或帶了這一頁沒有的組名，退回第一個 prefer 成立的組（選舉頁傳「有這一場的政見」），都沒有就第一組。
 * 挑有政見的那一場：從按鈕以外的地方（PK 頁籤、舊網址）進來時，第一眼看到的不是一張空表。只影響「先看哪一場」，不影響欄的順序。
 */
export function pickGroup<T>(groups: readonly CompareGroup<T>[], label: string, prefer?: (g: CompareGroup<T>) => boolean): CompareGroup<T> | undefined {
  return groups.find((g) => g.label === label) ?? (prefer && groups.find(prefer)) ?? groups[0]
}

/** 這些人裡有沒有人在這一場選舉提過政見（belongsToElection 同一套） */
export function hasPolicies(people: readonly ComparePerson[], policies: readonly Pick<Policy, 'politicianId' | 'electionId' | 'status'>[], electionId: number): boolean {
  const ids = new Set(people.map((p) => String(p.id)))
  return policies.some((p) => ids.has(String(p.politicianId)) && belongsToElection(p, electionId))
}

/**
 * PK 頁籤的網址參數（選舉頁 useRegionQuerySync 同步的那幾個）：
 *   view=comparison   政見 PK 頁籤（舊參數，照舊）
 *   type=縣市議員     職位（舊參數，照舊；沒帶＝這一頁第一個有政見可比的職位，都沒有就第一個有人可比的）
 *   district=第08選舉區   這一場的組名（2026-10-06 新增；沒帶＝這一頁這個職位的第一組）
 *   pick=12,34,56     只比勾選的這幾位（2026-10-06 新增；人物 id 以逗號隔開；沒帶＝這一組全部）
 * 縣市、鄉鎮在路徑上（/election/2026/台北市），PK 照舊跟著頁面的縣市與鄉鎮。
 */
export const PK_VIEW = 'comparison'

/** 連到 PK 的網址參數：職位一律寫明（沒帶 type 是「自動選」，按鈕要的是這個職位） */
export function pkQuery(electionType: string, district?: string): Record<string, string> {
  const query: Record<string, string> = { view: PK_VIEW, type: electionType }
  if (district) query.district = district
  return query
}

/** pick 參數 → 這一組裡勾選的 id；沒帶、或一個都對不上（別組的、已退選的）＝全部 */
export function parsePick(raw: string, ids: readonly string[]): string[] {
  const wanted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  const picked = ids.filter((id) => wanted.has(id))
  return picked.length > 0 ? picked : [...ids]
}

/** 勾選的 id → pick 參數；全部勾選寫空字串（預設值，不寫進網址），順序照欄的順序 */
export function buildPick(picked: ReadonlySet<string>, ids: readonly string[]): string {
  const kept = ids.filter((id) => picked.has(id))
  return kept.length === ids.length || kept.length === 0 ? '' : kept.join(',')
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
