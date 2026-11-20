/**
 * 完整關係圖（#675 第四期）的任期與泳道規則：日期運算、視圖 lineage_terms 的列 → 任期、職位 → 泳道。
 * 排版本體在 lib/lineage-graph.ts。零執行期依賴（同層純函式），deno 直接測。
 */
import type { LineageLevel } from '../types'
import { EXECUTIVE_OFFICE_TYPES, lineagePlace, officeTermEnd } from './lineage'
import { NATIONAL_TYPES, TOWNSHIP_TYPES } from './lineage-page'
import type { GraphTermRow, TermStatus } from './lineage-graph-types'

const DAY_MS = 86_400_000

export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)
export const dayNum = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / DAY_MS
export const addDays = (d: string, n: number): string => new Date((dayNum(d) + n) * DAY_MS).toISOString().slice(0, 10)
export const yearOf = (d: string): number => Number(d.slice(0, 4))
const normRegion = (s: string | null): string | null => (s ? s.replace(/臺/g, '台') : null)

/** 單席首長職位（一條泳道依序排任期）：縣市長、鄉鎮市長、區長，加上總統 */
export const isSingleSeat = (office: string): boolean => EXECUTIVE_OFFICE_TYPES.includes(office) || office === '總統副總統'
export const levelOfOffice = (office: string): LineageLevel => (NATIONAL_TYPES.includes(office) ? 'national' : TOWNSHIP_TYPES.includes(office) ? 'township' : 'county')

export interface Term {
  id: string
  politicianId: string
  name: string
  office: string
  region: string | null
  sub: string | null
  laneKey: string
  start: string
  /** 實際或預定的最後一天（實際卸任日優先，其次任期表的預定日，再其次由就任日推） */
  end: string
  status: TermStatus
  involved: boolean
}

export const laneKeyOf = (office: string, region: string | null, sub: string | null): string => `${office}|${region ?? ''}|${sub ?? ''}`

/** 任期表的列 → 任期；沒有就任日的畫不出來，丟掉 */
export function normalizeTerms(rows: readonly GraphTermRow[], today: string): Term[] {
  const out: Term[] = []
  for (const r of rows) {
    if (!isDate(r.startDate) || !r.electionType) continue
    const start = r.startDate.slice(0, 10)
    const sched = isDate(r.scheduledEndDate) ? r.scheduledEndDate.slice(0, 10) : officeTermEnd(yearOf(start), r.electionType)
    const end = isDate(r.endDate) ? r.endDate.slice(0, 10) : sched
    const region = normRegion(r.region)
    const sub = TOWNSHIP_TYPES.includes(r.electionType) ? r.subRegion : null
    out.push({
      id: `term:${r.politicianId}:${laneKeyOf(r.electionType, region, sub)}:${start}`,
      politicianId: r.politicianId, name: r.name, office: r.electionType, region, sub, laneKey: laneKeyOf(r.electionType, region, sub),
      start, end, status: start > today ? 'next' : end < today ? 'past' : 'current', involved: r.involved,
    })
  }
  return out
}

export interface LaneMeta { key: string; office: string; region: string | null; sub: string | null; single: boolean; level: LineageLevel; place: string; label: string }

export function laneMetaOf(t: Pick<Term, 'office' | 'region' | 'sub' | 'laneKey'>): LaneMeta {
  const level = levelOfOffice(t.office)
  const place = level === 'national' && !t.region ? lineagePlace({ level, region: null, subRegion: null }) : `${t.region ?? ''}${t.sub ?? ''}`
  return { key: t.laneKey, office: t.office, region: t.region, sub: t.sub, single: isSingleSeat(t.office), level, place, label: place ? `${t.office}　${place}` : t.office }
}

const LEVEL_RANK: Readonly<Record<LineageLevel, number>> = { national: 0, county: 1, township: 2 }

/** 泳道順序：中央 → 縣市 → 鄉鎮；同層首長先於民意代表；再依地方 */
export function compareLanes(a: LaneMeta, b: LaneMeta): number {
  return LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
    || Number(!a.single) - Number(!b.single)
    || (a.region ?? '').localeCompare(b.region ?? '', 'zh-Hant-TW')
    || (a.sub ?? '').localeCompare(b.sub ?? '', 'zh-Hant-TW')
    || a.office.localeCompare(b.office, 'zh-Hant-TW')
}

/** 疊列：位置相近的標籤排到下一列。回傳每個輸入對應的列號 */
export function stackRows(items: ReadonlyArray<{ x: number; w: number }>): number[] {
  const rows = new Array<number>(items.length).fill(0)
  const ends: number[] = []
  const order = items.map((_, i) => i).sort((a, b) => items[a].x - items[b].x || a - b)
  for (const i of order) {
    const left = items[i].x - items[i].w / 2
    let r = ends.findIndex((e) => e <= left)
    if (r < 0) { r = ends.length; ends.push(0) }
    ends[r] = items[i].x + items[i].w / 2 + 2
    rows[i] = r
  }
  return rows
}

/** 視圖 lineage_terms 的原始列（snake_case） */
export interface RawTermRow {
  politician_id?: unknown
  name?: unknown
  election_type?: unknown
  region?: unknown
  sub_region?: unknown
  start_date?: unknown
  scheduled_end_date?: unknown
  end_date?: unknown
  involved?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** lineage_terms 的列 → GraphTermRow；缺人或缺職位的丟掉（視圖還沒上線或回空就是空陣列，圖只畫標籤） */
export function mapTermRows(rows: readonly RawTermRow[] | null | undefined): GraphTermRow[] {
  const out: GraphTermRow[] = []
  for (const r of rows ?? []) {
    const politicianId = str(r.politician_id)
    const electionType = str(r.election_type)
    if (!politicianId || !electionType) continue
    out.push({
      politicianId, name: str(r.name) ?? '', electionType, region: str(r.region), subRegion: str(r.sub_region),
      startDate: str(r.start_date), scheduledEndDate: str(r.scheduled_end_date), endDate: str(r.end_date), involved: r.involved !== false,
    })
  }
  return out
}
