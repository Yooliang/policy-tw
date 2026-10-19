/**
 * 參選地圖（/stats/map，#680）的純邏輯：層級切換、點陣與人數合併、顏色分段、連結。
 *
 * 三層：全國（縣市形狀）→ 縣市（鄉鎮市區形狀）→ 鄉鎮市區（村里形狀）。
 * 形狀是預先把真實邊界點陣化的靜態檔（scripts/build-tw-raster.ts → data/tw-raster/，點陣化的純函式在 lib/raster-grid.ts），
 * 人數來自資料庫函式
 * candidacy_map（supabase/migrations/20261019090000_candidacy_map.sql）。畫面只在 pages/StatsMap.vue。
 */
import type { DecodedRaster } from './raster-grid'
import { electionPath } from './election-regions'

export type MapLevel = 'county' | 'town' | 'village'

/** 目前看的是哪一層、哪個縣市、哪個鄉鎮市區 */
export interface MapView {
  level: MapLevel
  countyCode?: string
  townCode?: string
}

export const NATIONAL_VIEW: MapView = { level: 'county' }

/** candidacy_map() 回傳的一列（bigint／integer 經 PostgREST 可能是字串，先過 normalizeRows） */
export interface CountRow {
  code: string
  name: string
  parent_code: string | null
  candidates: number
  registered: number | null
  seats: number | null
}

export interface MapUnit {
  code: string
  name: string
  /** 在點陣裡的序號（格值）；資料庫有、點陣沒有的行政區是 -1（只出現在清單） */
  idx: number
  candidates: number
  /** 中選會登記人數；沒有對得上的列＝null（畫面不顯示） */
  registered: number | null
  /** 應選席次；沒有查證過的名額＝null（畫面不顯示） */
  seats: number | null
}

export interface BuiltMap {
  /** 點陣裡的行政區，依序號排（units[i].idx === i） */
  units: MapUnit[]
  /** 資料庫有、點陣沒有的行政區（官方清單與圖資不同步時才會有），只列在清單 */
  unshaped: MapUnit[]
  /** 這一層人數最大值（顏色分段的上界） */
  max: number
}

/** 往下鑽一層：縣市格 → 該縣市的鄉鎮市區；鄉鎮市區格 → 該鄉鎮的村里；村里是最底層，原地不動 */
export function drillDown(view: MapView, code: string): MapView {
  if (view.level === 'county') return { level: 'town', countyCode: code }
  if (view.level === 'town') return { level: 'village', countyCode: view.countyCode, townCode: code }
  return view
}

/** 回上一層（全國再回就還是全國） */
export function drillUp(view: MapView): MapView {
  if (view.level === 'village') return { level: 'town', countyCode: view.countyCode }
  if (view.level === 'town') return NATIONAL_VIEW
  return view
}

/** 查資料庫時的 p_parent：全國層不帶、鄉鎮市區層帶縣市代碼、村里層帶鄉鎮市區代碼 */
export function parentCodeOf(view: MapView): string | null {
  if (view.level === 'town') return view.countyCode ?? null
  if (view.level === 'village') return view.townCode ?? null
  return null
}

/** 這一層的格子可不可以再往下鑽 */
export function canDrill(view: MapView): boolean {
  return view.level !== 'village'
}

export function viewKey(view: MapView): string {
  return `${view.level}:${parentCodeOf(view) ?? ''}`
}

/** 麵包屑：全國 → 縣市 → 鄉鎮市區；給每一段代碼，點了回到那一層 */
export interface Crumb {
  label: string
  view: MapView
}
export function breadcrumbs(view: MapView, nameOf: (code: string) => string | undefined): Crumb[] {
  const out: Crumb[] = [{ label: '全國', view: NATIONAL_VIEW }]
  if (view.countyCode && view.level !== 'county') {
    out.push({ label: nameOf(view.countyCode) ?? view.countyCode, view: { level: 'town', countyCode: view.countyCode } })
  }
  if (view.townCode && view.level === 'village') {
    out.push({ label: nameOf(view.townCode) ?? view.townCode, view })
  }
  return out
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v))

export function normalizeRows(rows: ReadonlyArray<Record<string, unknown>>): CountRow[] {
  return rows.map((r) => ({
    code: String(r.code),
    name: String(r.name ?? ''),
    parent_code: r.parent_code == null ? null : String(r.parent_code),
    candidates: num(r.candidates),
    registered: numOrNull(r.registered),
    seats: numOrNull(r.seats),
  }))
}

/**
 * 把點陣與人數合起來。
 * - 名稱與人數以資料庫為準（官方現行行政區與寫法）；點陣有、資料庫沒有的代碼人數當 0、名稱用代碼。
 * - 資料庫有、點陣沒有的，放進 unshaped，不畫格子。
 */
export function buildMap(raster: Pick<DecodedRaster, 'codes'>, counts: ReadonlyArray<CountRow>): BuiltMap {
  const byCode = new Map(counts.map((c) => [c.code, c]))
  const unit = (code: string, idx: number): MapUnit => {
    const row = byCode.get(code)
    return { code, name: row?.name || code, idx, candidates: row?.candidates ?? 0, registered: row?.registered ?? null, seats: row?.seats ?? null }
  }
  const units = raster.codes.map((code, idx) => unit(code, idx))
  const have = new Set(raster.codes)
  const unshaped = counts.filter((c) => !have.has(c.code)).map((c) => unit(c.code, -1))
  const max = [...units, ...unshaped].reduce((m, u) => Math.max(m, u.candidates), 0)
  return { units, unshaped, max }
}

/**
 * 人數 → 顏色段（0～4）。0 人固定第 0 段（灰）；1 人以上依「占最大值的比例」開根號分成 4 段，
 * 讓一兩人的小格子也看得出跟 0 人不同、又不被少數大格子壓扁。
 */
export function rampIndex(value: number, max: number): number {
  if (!(value > 0)) return 0
  if (max <= 1) return 4
  const t = Math.min(1, value / max)
  return 1 + Math.min(3, Math.floor(Math.sqrt(t) * 4))
}

/**
 * 格子連到既有的選舉頁：縣市格＝縣市頁、鄉鎮市區格＝鄉鎮頁、村里格連到所在的鄉鎮頁（沒有村里頁）。
 * 網址規則在 lib/election-regions.ts（縣市名用「台」）。
 */
export function unitHref(electionId: number | string, view: MapView, unit: { name: string; code: string }, names: { county?: string; town?: string }): string {
  if (view.level === 'county') return electionPath(electionId, unit.name)
  if (view.level === 'town') return electionPath(electionId, names.county, unit.name)
  return electionPath(electionId, names.county, names.town)
}

/** 提示框的各行（只放標籤與數字；沒有資料的欄不出現） */
export function tooltipLines(u: MapUnit): Array<{ label: string; value: string }> {
  const lines = [{ label: '收錄參選人', value: `${u.candidates} 人` }]
  if (u.registered !== null) lines.push({ label: '中選會登記', value: `${u.registered} 人` })
  if (u.seats !== null) lines.push({ label: '應選席次', value: `${u.seats} 席` })
  return lines
}
