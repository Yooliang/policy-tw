/**
 * 政見矩陣頁上方兩張甜甜圈圖的算法（維護者 2026-10-08）：只用矩陣現有的數字，不新增查詢。
 *   左：政見分類占比（全台＝categoryTotals；選了縣市＝那個縣市各分類的筆數）
 *   右：各縣市占比（全台＝22 縣市各自的總筆數；選了縣市＝「所選縣市」與「其他縣市合計」兩塊）
 * 切片多時取前 N 名、其餘合成「其他」；占比（0～1，只給排序與核對用，畫面不顯示百分比）與顏色也在這裡算，頁面只管畫與點擊。
 */
import type { Matrix } from './md/dataset'
import { BRAND, SERIES_WIDE } from './brand-colors'

export const MATRIX_TOP_N = 8
/** 合併項的 key：不會跟任何分類或縣市名撞（真的有一個分類就叫「其他」，所以合併項不能靠名字認） */
export const OTHER_KEY = '\u0000other'

export interface ShareItem {
  key: string
  value: number
}

export interface Slice {
  /** 分類名或縣市名；合併項是 OTHER_KEY */
  key: string
  /** 圖上、圖例顯示的字 */
  label: string
  value: number
  /** 占這張圖總數的比例（0～1） */
  share: number
  /** 合併項（點了沒有對應的 .md，不可點） */
  isOther: boolean
}

/**
 * 取前 topN 名、其餘合成一塊 otherLabel。
 * - 0 筆的不畫；大到小排序（同數字維持輸入順序，讓圖不會在每次重算時亂跳）
 * - 超出前 topN 名的只剩一項時不合併：一塊只裝一項的「其他」不省版面，還把名字藏起來（跟統計頁缺口圓餅同一個取法）
 * - items 裡的 OTHER_KEY 項（右圖選縣市時的「其他縣市合計」）照樣是合併項，標籤用 otherLabel
 */
export function topSlices(items: ShareItem[], otherLabel: string, topN: number = MATRIX_TOP_N): Slice[] {
  // Array.prototype.sort 是穩定排序：同筆數維持輸入順序
  const rows = items.filter((it) => it.value > 0).sort((a, b) => b.value - a.value)
  const total = rows.reduce((sum, r) => sum + r.value, 0)
  if (total === 0) return []
  const mk = (key: string, value: number): Slice => {
    const isOther = key === OTHER_KEY
    return { key, label: isOther ? otherLabel : key, value, share: value / total, isOther }
  }
  if (rows.length <= topN + 1) return rows.map((r) => mk(r.key, r.value))
  const head = rows.slice(0, topN).map((r) => mk(r.key, r.value))
  const rest = rows.slice(topN).reduce((sum, r) => sum + r.value, 0)
  return [...head, mk(OTHER_KEY, rest)]
}

/** 左圖的原料：全台＝categoryTotals，選了縣市＝counts[縣市]；順序照矩陣的分類順序 */
export function categoryItems(matrix: Matrix, region: string): ShareItem[] {
  const picked = region !== 'All' && matrix.regions.includes(region)
  return matrix.categories.map((c) => ({
    key: c,
    value: (picked ? matrix.counts[region]?.[c] : matrix.categoryTotals[c]) ?? 0,
  }))
}

/**
 * 右圖的原料：全台＝各縣市的總筆數（regionTotals）；
 * 選了縣市＝所選縣市 vs 其他縣市合計兩塊（合計用其他縣市各自的總數相加，不靠 matrix.total，兩邊才對得起來）。
 */
export function regionItems(matrix: Matrix, region: string): ShareItem[] {
  if (region === 'All' || !matrix.regions.includes(region)) {
    return matrix.regions.map((r) => ({ key: r, value: matrix.regionTotals[r] ?? 0 }))
  }
  const rest = matrix.regions.filter((r) => r !== region).reduce((sum, r) => sum + (matrix.regionTotals[r] ?? 0), 0)
  return [
    { key: region, value: matrix.regionTotals[region] ?? 0 },
    { key: OTHER_KEY, value: rest },
  ]
}

/** 每一塊的顏色：依名次取品牌色盤，合併項固定灰（刻意不用品牌色，免得被誤讀成某一類） */
export function sliceColors(slices: Slice[]): string[] {
  let n = 0
  return slices.map((s) => (s.isOther ? BRAND.other : SERIES_WIDE[n++ % SERIES_WIDE.length]))
}
