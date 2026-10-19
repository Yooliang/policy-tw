/**
 * 參選地圖的一個「圖層」＝一張點陣檔解碼並合成好的結果（純函式，無 Vue）。
 * 解碼、合成 path（填色 d 字串與邊界線）、外框、標籤用的統計都只在第一次載入時做一次；
 * 之後縮放、平移完全不重算（頁面把它 markRaw，也不被 Vue 深層追蹤）。
 */
import { buildMap, type BuiltMap, type CountRow, type MapLevel } from './candidacy-map'
import { boundaryPath, decodeRaster, unitFillPaths, unitStats, type DecodedRaster, type RasterFile, type UnitStat } from './raster-grid'
import { layerBox } from './map-world'
import type { Box } from './map-world'

export interface Layer {
  key: string
  level: MapLevel
  raster: DecodedRaster
  /** 一格的邊長（公里）與在世界裡的位置（公里） */
  u: number
  tx: number
  ty: number
  fills: string[]
  boundary: string
  /** 人數資料回來前是空的（名稱與邊界已經能畫），回來後由 applyRows 重建 */
  built: BuiltMap
  /** 人數資料是否已經套上去（沒套上去的格子只畫中性底色，提示卡不顯示數字） */
  ready: boolean
  stats: Array<UnitStat | null>
  box: Box
  transform: string
}

export function buildLayer(key: string, level: MapLevel, file: RasterFile, rows: CountRow[]): Layer {
  const raster = decodeRaster(file)
  const u = raster.cellM / 1000
  return {
    key, level, raster, u, tx: raster.ox * u, ty: raster.oy * u,
    fills: unitFillPaths(raster), boundary: boundaryPath(raster), built: buildMap(raster, rows), ready: rows.length > 0,
    stats: unitStats(raster), box: layerBox(raster), transform: `translate(${raster.ox * u} ${raster.oy * u}) scale(${u})`,
  }
}

/** 人數資料回來：只重建各區的數字（名稱、幾何、path 都不動），畫面只重新上色 */
export function applyRows(layer: Layer, rows: CountRow[]): void {
  layer.built = buildMap(layer.raster, rows)
  layer.ready = true
}
