/**
 * 參選地圖（/stats/map，#680）的純邏輯：層級切換、座標與人數合併、顏色分段、連結。
 *
 * 三層：全國（縣市格）→ 縣市（鄉鎮市區格）→ 鄉鎮市區（村里格）。
 * 座標是預先產生的靜態檔（scripts/build-tw-tile-grid.ts → data/tw-grid-*.json），人數來自資料庫函式
 * candidacy_map（supabase/migrations/20261019090000_candidacy_map.sql）。畫面只在 pages/StatsMap.vue。
 */
import { appendTiles } from './tile-layout'
import { electionPath } from './election-regions'

export type MapLevel = 'county' | 'town' | 'village'

/** 目前看的是哪一層、哪個縣市、哪個鄉鎮市區 */
export interface MapView {
  level: MapLevel
  countyCode?: string
  townCode?: string
}

export const NATIONAL_VIEW: MapView = { level: 'county' }

/** 靜態座標檔的一列：[代碼, 名稱, x, y] */
export type GridRow = [string, string, number, number]

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
  x: number
  y: number
  candidates: number
  /** 中選會登記人數；沒有對得上的列＝null（畫面不顯示） */
  registered: number | null
  /** 應選席次；沒有查證過的名額＝null（畫面不顯示） */
  seats: number | null
}

export interface BuiltMap {
  units: MapUnit[]
  cols: number
  rows: number
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
 * 把座標與人數合起來。
 * - 以資料庫的名單為準（官方現行行政區）：座標檔有、資料庫沒有的（區劃已調整的舊代碼）不畫。
 * - 資料庫有、座標檔沒有的（新設的村里），補在外框的空格，沒有空格就開新的一列。
 * - 名稱優先用資料庫的（官方現行寫法），沒有才用座標檔的。
 */
export function buildMap(grid: ReadonlyArray<GridRow>, counts: ReadonlyArray<CountRow>): BuiltMap {
  const byCode = new Map(counts.map((c) => [c.code, c]))
  const known = grid.filter((g) => byCode.has(g[0]))
  const cells = known.map((g) => ({ key: g[0], x: g[2], y: g[3] }))
  const have = new Set(cells.map((c) => c.key))
  const missing = counts.filter((c) => !have.has(c.code)).map((c) => c.code)
  const laid = missing.length ? appendTiles(cells, missing) : {
    cells,
    cols: cells.reduce((m, c) => Math.max(m, c.x + 1), 0),
    rows: cells.reduce((m, c) => Math.max(m, c.y + 1), 0),
  }
  const units: MapUnit[] = laid.cells.map((c) => {
    const row = byCode.get(c.key)!
    return {
      code: c.key,
      name: row.name || known.find((g) => g[0] === c.key)?.[1] || c.key,
      x: c.x,
      y: c.y,
      candidates: row.candidates,
      registered: row.registered,
      seats: row.seats,
    }
  })
  units.sort((a, b) => a.y - b.y || a.x - b.x)
  return { units, cols: laid.cols, rows: laid.rows, max: units.reduce((m, u) => Math.max(m, u.candidates), 0) }
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
