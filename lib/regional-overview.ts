/**
 * 數據分佈頁（/regional-data）的純函式：階段計數、兌現率、分母門檻、資料不足判定、熱力圖尺度、脈絡跨任期。
 *
 * 口徑（維護者 2026-11-19，裁決 docs/decisions/2026-11-19-數據分佈兌現率與資料不足顯示.md；視圖在 migration 20261119140000）：
 *   政見 ＝ 選後／施政（lib/policy-stage.ts 的 isPostElectionStage；SQL 是 policies_by_region.listed，與 /tracking 同一個定義，
 *           當選那一屆狀態仍是 Campaign Pledge 的也算）；承諾 ＝ 其餘（選前、落選、退選）；
 *   政見依 status 分桶：尚未啟動（Campaign Pledge）／已提出／施政中／已完成／停滯（Stalled＋Failed）；
 *   兌現率 ＝ （施政中＋已完成）÷ 政見數；
 *   區域 ＝ policies_by_region 的 region 語意（台／臺同一；全國範圍只算進全台）。
 * 這個檔只 import 型別與 policy-stage（也只 import 型別），deno 直接能測。
 */
import { isPostElectionStage, type PolicyStage } from './policy-stage.ts'

export const ALL_REGIONS = 'All'
/** 全國範圍（中央層級）的 region 值：只算進全台，不屬於任何縣市 */
export const NATIONAL_REGION = '全國'

/** 兌現率分母（政見數）低於這個數：百分比淡化、印出「n／m」、排序放到有效樣本後面 */
export const MIN_RATE_DENOM = 10
/** 三要素有說明比例：整體調查筆數（三個要素列數加總）低於這個數就顯示「資料收集中」 */
export const MIN_ELEMENT_ROWS = 50
/** 三要素某縣市／層級的單一要素調查筆數低於這個數：淡化並印「n／m」 */
export const MIN_ELEMENT_DENOM = 10
/** 期限分佈：有日期的政見低於這個數就顯示「資料收集中」 */
export const MIN_DEADLINE_DATED = 20

/** 縣市列表（22 縣市，台／臺統一寫「台」） */
export const COUNTIES: readonly string[] = [
  '台北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣',
  '苗栗縣', '台中市', '彰化縣', '南投縣', '雲林縣',
  '嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣',
  '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣',
]

/** 一頁共用的色票：所有圖同一套 */
export const STAGE_COLORS = {
  pledge: '#bfdbfe', // 承諾：淡藍
  not_started: '#cbd5e1', // 尚未啟動：淺灰藍
  proposed: '#3b82f6', // 已提出：藍
  in_progress: '#6366f1', // 施政中：靛
  achieved: '#10b981', // 已完成：綠
  stalled: '#94a3b8', // 停滯：灰
} as const
export const ELEMENT_COLORS = { target: '#2563eb', deadline: '#6366f1', funding: '#10b981' } as const
export const DEADLINE_COLORS = { overdue: '#f43f5e', within30: '#f59e0b', later: '#2563eb', unset: '#cbd5e1' } as const

export type StageKey = keyof typeof STAGE_COLORS

/** 視圖 region_stage_counts／region_category_stage_counts 的計數欄（pledge_n＝承諾；其餘五欄加起來＝政見數） */
export interface StageCounts {
  pledge_n: number
  not_started_n: number
  proposed_n: number
  in_progress_n: number
  achieved_n: number
  stalled_n: number
}
export interface RegionStageRow extends StageCounts { region: string }
export interface RegionCategoryStageRow extends StageCounts { region: string; category: string }
export interface RegionElementRow {
  region: string
  election_type: string
  target_stated: number
  target_total: number
  deadline_stated: number
  deadline_total: number
  funding_stated: number
  funding_total: number
}
export interface RegionDeadlineRow {
  region: string
  policy_n: number
  overdue_n: number
  within30_n: number
  later_n: number
  unset_n: number
  updated_30d_n: number
}
export interface LineageSpanRow {
  lineage_id: string
  title: string
  category: string | null
  level: string | null
  region: string
  election_ids: number[] | null
  term_years: number[] | null
  handover_n: number
}
/** 這頁快照的全部資料：全台與各縣市的聚合都在裡面（合計約 700 列），切縣市不用再撈 */
export interface RegionalDataSet {
  stage: RegionStageRow[]
  category: RegionCategoryStageRow[]
  element: RegionElementRow[]
  deadline: RegionDeadlineRow[]
  lineage: LineageSpanRow[]
}

export const EMPTY_STAGE: StageCounts = { pledge_n: 0, not_started_n: 0, proposed_n: 0, in_progress_n: 0, achieved_n: 0, stalled_n: 0 }

/** 台／臺同一 */
export function normRegion(region: string | null | undefined): string {
  return (region ?? '').replace(/臺/g, '台')
}

/** 這一列算不算在選的範圍：全台＝所有列（含全國）；縣市＝只有該縣市（全國不算） */
export function inRegion(rowRegion: string | null | undefined, region: string): boolean {
  return region === ALL_REGIONS || normRegion(rowRegion) === normRegion(region)
}

/** 一條政見落在哪個階段格：選前／落選的一律是承諾；選後／施政依 status 分桶，不認得的 status 回 null。以 lib/policy-stage.ts 的階段判斷為準，SQL 是同一份規則的另一份 */
export function stageBucketOf(status: string, stage: PolicyStage): StageKey | null {
  if (!isPostElectionStage(stage)) return 'pledge'
  if (status === 'Campaign Pledge') return 'not_started'
  if (status === 'Proposed') return 'proposed'
  if (status === 'In Progress') return 'in_progress'
  if (status === 'Achieved') return 'achieved'
  if (status === 'Stalled' || status === 'Failed') return 'stalled'
  return null
}

export function addStage(a: StageCounts, b: StageCounts): StageCounts {
  return {
    pledge_n: a.pledge_n + b.pledge_n,
    not_started_n: a.not_started_n + b.not_started_n,
    proposed_n: a.proposed_n + b.proposed_n,
    in_progress_n: a.in_progress_n + b.in_progress_n,
    achieved_n: a.achieved_n + b.achieved_n,
    stalled_n: a.stalled_n + b.stalled_n,
  }
}

/** 縣市 × 分類的列加總成縣市階段列（漏斗用；不另撈一支視圖） */
export function stageRowsFromCategory(rows: readonly RegionCategoryStageRow[]): RegionStageRow[] {
  const byRegion = new Map<string, RegionStageRow>()
  for (const r of rows) {
    const prev = byRegion.get(r.region)
    byRegion.set(r.region, { ...addStage(prev ?? EMPTY_STAGE, r), region: r.region })
  }
  return [...byRegion.values()].sort((a, b) => a.region.localeCompare(b.region, 'zh-Hant'))
}

/** 某範圍（全台或縣市）的階段加總 */
export function stageTotals(rows: readonly (StageCounts & { region: string })[], region: string): StageCounts {
  return rows.reduce((acc, r) => (inRegion(r.region, region) ? addStage(acc, r) : acc), EMPTY_STAGE)
}

/** 政見數＝尚未啟動＋已提出＋施政中＋已完成＋停滯（與 /tracking 同一個定義） */
export function policyTotal(c: StageCounts): number {
  return c.not_started_n + c.proposed_n + c.in_progress_n + c.achieved_n + c.stalled_n
}

/** 兌現率（0～1）＝（施政中＋已完成）÷ 政見數；沒有政見回 null（畫面印「—」，不是 0%） */
export function fulfilmentRate(c: StageCounts): number | null {
  const n = policyTotal(c)
  return n === 0 ? null : (c.in_progress_n + c.achieved_n) / n
}

/** 分母夠不夠：政見數 ≥ MIN_RATE_DENOM 才算有效樣本 */
export function rateReliable(c: StageCounts): boolean {
  return policyTotal(c) >= MIN_RATE_DENOM
}

/** 百分比字串；null 印破折號 */
export function percentText(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

export interface FunnelRow {
  region: string
  counts: StageCounts
  rate: number | null
  reliable: boolean
}

/**
 * 階段漏斗的列：依兌現率排序（高到低）；分母不足的縣市放到有效樣本後面，沒有政見的放最後。
 * 同率時政見數多的在前，再同則依縣市列表順序。
 */
export function funnelRows(rows: readonly RegionStageRow[], counties: readonly string[] = COUNTIES): FunnelRow[] {
  const built: FunnelRow[] = counties.map((county) => {
    const counts = stageTotals(rows, county)
    return { region: county, counts, rate: fulfilmentRate(counts), reliable: rateReliable(counts) }
  })
  const group = (r: FunnelRow) => (r.rate === null ? 2 : r.reliable ? 0 : 1)
  return built
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ga = group(a.row)
      const gb = group(b.row)
      if (ga !== gb) return ga - gb
      if ((b.row.rate ?? 0) !== (a.row.rate ?? 0)) return (b.row.rate ?? 0) - (a.row.rate ?? 0)
      const pa = policyTotal(a.row.counts)
      const pb = policyTotal(b.row.counts)
      if (pb !== pa) return pb - pa
      return a.i - b.i
    })
    .map((x) => x.row)
}

/** 熱力圖的資料頁籤 */
export type HeatTab = 'pledge' | 'policy' | 'lineage'

/** 縣市 × 分類矩陣上某一格的值（脈絡頁籤用脈絡列算；中央層級的脈絡不屬於任何縣市，不在這張縣市矩陣裡） */
export function heatValue(
  tab: HeatTab,
  region: string,
  category: string,
  data: Pick<RegionalDataSet, 'category' | 'lineage'>,
): number {
  if (tab === 'lineage') {
    return data.lineage.filter((l) => normRegion(l.region) === normRegion(region) && l.category === category).length
  }
  let sum = 0
  for (const r of data.category) {
    if (normRegion(r.region) !== normRegion(region) || r.category !== category) continue
    sum += tab === 'pledge' ? r.pledge_n : policyTotal(r)
  }
  return sum
}

export interface HeatMatrix {
  regions: string[]
  categories: string[]
  values: number[][]
  max: number
}

/** 整張矩陣；縣市取列表順序、分類取給定順序（沒給就依全台該頁籤總量由大到小） */
export function heatMatrix(
  tab: HeatTab,
  data: Pick<RegionalDataSet, 'category' | 'lineage'>,
  categories: readonly string[],
  regions: readonly string[] = COUNTIES,
): HeatMatrix {
  const values = regions.map((region) => categories.map((c) => heatValue(tab, region, c, data)))
  let max = 0
  for (const row of values) for (const v of row) if (v > max) max = v
  return { regions: [...regions], categories: [...categories], values, max }
}

/** 分類依全台該頁籤的總量由大到小（同量依原順序），讓熱力圖左邊深、右邊淡 */
export function categoriesByTotal(tab: HeatTab, data: Pick<RegionalDataSet, 'category' | 'lineage'>, categories: readonly string[]): string[] {
  const total = (c: string) => COUNTIES.reduce((s, r) => s + heatValue(tab, r, c, data), 0)
  return categories
    .map((c, i) => ({ c, i, t: total(c) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.c)
}

/** 熱力圖顏色深淺：全圖共用同一個尺度（以整張矩陣最大值為 1，開 0.6 次方讓小值也看得出）；0 回 0（畫面用中性底色） */
export function heatAlpha(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  return 0.08 + 0.92 * Math.pow(Math.min(1, value / max), 0.6)
}

// ───── ③ 承諾品質：三要素有說明比例 ─────

export type ElementKey = 'target' | 'deadline' | 'funding'
export const ELEMENT_KEYS: readonly ElementKey[] = ['target', 'deadline', 'funding']
export const ELEMENT_LABELS: Record<ElementKey, string> = { target: '數值目標', deadline: '期限', funding: '財源' }

export interface ElementShare {
  stated: number
  total: number
  /** 0～1；沒有調查筆數回 null */
  rate: number | null
  /** 調查筆數夠不夠：不夠就淡化、印「n／m」 */
  reliable: boolean
}

export interface ElementShares { target: ElementShare; deadline: ElementShare; funding: ElementShare }

function share(stated: number, total: number): ElementShare {
  return { stated, total, rate: total === 0 ? null : stated / total, reliable: total >= MIN_ELEMENT_DENOM }
}

/** 一組列（已篩好範圍）的三要素比例 */
export function elementShares(rows: readonly RegionElementRow[]): ElementShares {
  const sum = (pick: (r: RegionElementRow) => number) => rows.reduce((s, r) => s + pick(r), 0)
  return {
    target: share(sum((r) => r.target_stated), sum((r) => r.target_total)),
    deadline: share(sum((r) => r.deadline_stated), sum((r) => r.deadline_total)),
    funding: share(sum((r) => r.funding_stated), sum((r) => r.funding_total)),
  }
}

/** 全部要素列數（三個要素的調查筆數加總） */
export function elementRowCount(rows: readonly RegionElementRow[]): number {
  return rows.reduce((s, r) => s + r.target_total + r.deadline_total + r.funding_total, 0)
}

/** 三要素資料夠不夠畫圖：整體調查筆數 ≥ MIN_ELEMENT_ROWS，不夠就「資料收集中」 */
export function elementsReady(rows: readonly RegionElementRow[]): boolean {
  return elementRowCount(rows) >= MIN_ELEMENT_ROWS
}

/** 各縣市的三要素比例（縣市列表順序；沒有任何調查的縣市保留空比例，畫面印「—」） */
export function elementsByCounty(rows: readonly RegionElementRow[], counties: readonly string[] = COUNTIES): { region: string; shares: ElementShares }[] {
  return counties.map((county) => ({ region: county, shares: elementShares(rows.filter((r) => inRegion(r.region, county))) }))
}

/** 層級顯示順序；原住民區長／區民代表併入鄉鎮市長／鄉鎮市民代表（同一個層級的不同寫法） */
export const LEVEL_ORDER: readonly string[] = ['總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '鄉鎮市民代表', '村里長']
const LEVEL_MERGE: Record<string, string> = { 直轄市山地原住民區長: '鄉鎮市長', 直轄市山地原住民區民代表: '鄉鎮市民代表' }

export function levelOf(electionType: string): string {
  return LEVEL_MERGE[electionType] ?? electionType
}

/** 各層級的三要素比例（範圍內；沒有調查筆數的層級不列） */
export function elementsByLevel(rows: readonly RegionElementRow[], region: string): { level: string; shares: ElementShares }[] {
  const scoped = rows.filter((r) => inRegion(r.region, region) && r.election_type !== '')
  const levels = new Set(scoped.map((r) => levelOf(r.election_type)))
  const ordered = [...LEVEL_ORDER.filter((l) => levels.has(l)), ...[...levels].filter((l) => !LEVEL_ORDER.includes(l)).sort()]
  return ordered
    .map((level) => ({ level, shares: elementShares(scoped.filter((r) => levelOf(r.election_type) === level)) }))
    .filter((x) => x.shares.target.total + x.shares.deadline.total + x.shares.funding.total > 0)
}

// ───── ④ 脈絡接力 ─────

/** 跨任期數：脈絡裡合格政見的不同屆數（優先看屆別 id，沒有才看年份） */
export function termCount(l: Pick<LineageSpanRow, 'election_ids' | 'term_years'>): number {
  if (l.election_ids && l.election_ids.length > 0) return new Set(l.election_ids).size
  return l.term_years ? new Set(l.term_years).size : 0
}

export interface LineageRegionStat {
  region: string
  count: number
  /** 平均跨任期數；沒有脈絡回 null */
  avgTerms: number | null
  handovers: number
}

/** 脈絡列在某範圍：全台＝全部（含中央層級）；縣市＝該縣市的，中央層級不算 */
export function lineagesIn(rows: readonly LineageSpanRow[], region: string): LineageSpanRow[] {
  return rows.filter((l) => inRegion(l.region, region))
}

export function lineageStat(rows: readonly LineageSpanRow[], region: string): LineageRegionStat {
  const list = lineagesIn(rows, region)
  const terms = list.reduce((s, l) => s + termCount(l), 0)
  return {
    region,
    count: list.length,
    avgTerms: list.length === 0 ? null : terms / list.length,
    handovers: list.reduce((s, l) => s + l.handover_n, 0),
  }
}

/** 各縣市脈絡統計：有脈絡的縣市，條數多的在前（同數依平均跨任期、再依縣市順序） */
export function lineageStatsByCounty(rows: readonly LineageSpanRow[], counties: readonly string[] = COUNTIES): LineageRegionStat[] {
  return counties
    .map((c, i) => ({ s: lineageStat(rows, c), i }))
    .filter((x) => x.s.count > 0)
    .sort((a, b) => b.s.count - a.s.count || (b.s.avgTerms ?? 0) - (a.s.avgTerms ?? 0) || a.i - b.i)
    .map((x) => x.s)
}

/** 三屆任期示意：挑跨 2 屆以上的真實脈絡，跨屆多的在前，最多 max 條 */
export function timelineLineages(rows: readonly LineageSpanRow[], region: string, max = 6): LineageSpanRow[] {
  return lineagesIn(rows, region)
    .filter((l) => termCount(l) >= 2 && (l.term_years?.length ?? 0) >= 2)
    .sort((a, b) => termCount(b) - termCount(a) || b.handover_n - a.handover_n || a.title.localeCompare(b.title, 'zh-Hant'))
    .slice(0, max)
}

/** 時間軸上的年份欄（被挑到的脈絡用到的屆別年份，由早到晚） */
export function timelineYears(picked: readonly LineageSpanRow[]): number[] {
  return [...new Set(picked.flatMap((l) => l.term_years ?? []))].sort((a, b) => a - b)
}

// ───── ⑤ 期限分佈與近 30 天進度 ─────

export interface DeadlineTotals {
  policy: number
  overdue: number
  within30: number
  later: number
  unset: number
  updated30d: number
}

export function deadlineTotals(rows: readonly RegionDeadlineRow[], region: string): DeadlineTotals {
  const t: DeadlineTotals = { policy: 0, overdue: 0, within30: 0, later: 0, unset: 0, updated30d: 0 }
  for (const r of rows) {
    if (!inRegion(r.region, region)) continue
    t.policy += r.policy_n
    t.overdue += r.overdue_n
    t.within30 += r.within30_n
    t.later += r.later_n
    t.unset += r.unset_n
    t.updated30d += r.updated_30d_n
  }
  return t
}

/** 有日期的政見數 */
export function datedCount(t: DeadlineTotals): number {
  return t.overdue + t.within30 + t.later
}

/** 期限分佈夠不夠畫：有日期的政見 ≥ MIN_DEADLINE_DATED，不夠就「資料收集中」 */
export function deadlineReady(t: DeadlineTotals): boolean {
  return datedCount(t) >= MIN_DEADLINE_DATED
}
