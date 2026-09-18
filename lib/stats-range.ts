/**
 * 統計頁的時間窗。整頁只有一組：切一次，所有有時間軸的圖一起換。
 *
 * 不跟著換的：四張統計卡與資料缺口圓餅——它們回答的是「現在」，不是一段期間。
 */

export type StatsRangeKey = '24h' | '7d' | '30d' | '90d'

export interface StatsRange {
  key: StatsRangeKey
  /** 按鈕上的字 */
  label: string
  /** 卡片標題後綴，統一寫成「缺口走勢(7D)」這種格式 */
  short: string
  hours: number
  /** 給以「天」為單位的資料庫函式（contribution_leaderboard） */
  days: number
}

export const STATS_RANGES: readonly StatsRange[] = [
  { key: '24h', label: '24h', short: '24h', hours: 24, days: 1 },
  { key: '7d', label: '7天', short: '7D', hours: 24 * 7, days: 7 },
  { key: '30d', label: '30天', short: '30D', hours: 24 * 30, days: 30 },
  { key: '90d', label: '90天', short: '90D', hours: 24 * 90, days: 90 },
]

export const DEFAULT_STATS_RANGE: StatsRangeKey = '7d'

export function findStatsRange(key: string): StatsRange {
  return STATS_RANGES.find(r => r.key === key) ?? STATS_RANGES.find(r => r.key === DEFAULT_STATS_RANGE)!
}

/** 取在時間窗內的採樣（採樣時間 ≥ 現在 − hours） */
export function withinHours<T extends { takenAt: string }>(rows: readonly T[], hours: number, now = Date.now()): T[] {
  const since = now - hours * 3600 * 1000
  return rows.filter(r => new Date(r.takenAt).getTime() >= since)
}
