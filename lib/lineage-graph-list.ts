/**
 * 完整關係圖的時序清單（#675 第四期）：手機版的直式時間軸（新到舊、依年分組、晶片篩選），桌機版同一份給讀屏軟體。
 * 吃 lib/lineage-graph.ts 的 items——跟圖上的標籤同一份、id 相同。零執行期依賴，deno 直接測。
 */
import type { GraphItem, PlaceChip, YearGroup } from './lineage-graph-types'
import { PAGE_LABELS as T } from './lineage-page-labels'

export const ALL_PLACES = '__all__'

/** 依年分組，新到舊；沒有日期的放最後一組 */
export function groupItemsByYear(items: readonly GraphItem[]): YearGroup[] {
  const groups = new Map<string, GraphItem[]>()
  for (const it of [...items].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id))) {
    const year = it.date ? it.date.slice(0, 4) : ''
    groups.set(year, [...(groups.get(year) ?? []), it])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : b.localeCompare(a)))
    .map(([year, list]) => ({ year, items: list }))
}

/** 頂端晶片：全部＋各地方（沒有地方的歸在「其他（身分待查）」），依第一次出現的順序 */
export function placeChips(items: readonly GraphItem[]): PlaceChip[] {
  const counts = new Map<string, number>()
  for (const it of items) {
    const key = it.place || T.otherIdentity
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [{ key: ALL_PLACES, label: T.filterAll, count: items.length }, ...[...counts.entries()].map(([key, count]) => ({ key, label: key, count }))]
}

export function filterItemsByPlace(items: readonly GraphItem[], key: string): GraphItem[] {
  return key === ALL_PLACES ? [...items] : items.filter((it) => (it.place || T.otherIdentity) === key)
}
