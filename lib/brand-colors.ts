/**
 * 站徽「正見」的五個主色，從 public/brand/logo-zhengjian@2x.png 取樣（依面積大小）：
 * 橙 21.6%、黃 20.6%、藍 14.8%、綠 11.1%、青 9.8%。
 *
 * 統計頁所有圖表共用這一組（2026-09-18），而且同一件事在每張圖都是同一個顏色——
 * 看到青色就是驗證票，不用每張圖重新對圖例。
 */

export const BRAND = {
  orange: '#de671c',
  yellow: '#dab31c',
  blue: '#244992',
  green: '#3b9944',
  teal: '#41b1b9',
  /** 「其他」合併項：刻意不用品牌色，避免被誤讀成某一個類別 */
  other: '#94a3b8',
} as const

/** 管線裡每個階段的固定顏色 */
export const METRIC_COLOR = {
  submitted: BRAND.blue,
  verifications: BRAND.teal,
  applied: BRAND.green,
  pending: BRAND.yellow,
  gaps: BRAND.orange,
  manualTasks: BRAND.blue,
} as const

/** 沒有固定語意的多類別（例如各種缺口）依序取色；超出的合併成「其他」 */
export const CATEGORY_SERIES: readonly string[] = [BRAND.blue, BRAND.orange, BRAND.green, BRAND.teal, BRAND.yellow]
