/**
 * 資料缺口的「前 N 大」排序。資料缺口圓餅與缺口走勢共用這一支，
 * 同一類缺口在兩張圖才會是同一個顏色（顏色是依名次取的）。
 *
 * 2026-09-18 抓到過：圓餅吃 /tasks 的即時數字、走勢吃最新一筆採樣，兩份資料差一小時，
 * 第 5 名一個是「參選缺出處」一個是「參選狀態待確認」，顏色就錯開了。
 * 現在兩張圖都吃同一筆最新採樣、都用這支排序。
 */

/** 手動任務不是資料缺口，它在任務頁的清單裡（tasks_by_type 裡的鍵是 manual_open） */
export const MANUAL_TASKS_KEY = 'manual_open'

/**
 * 依數量由多到少排出缺口型別；數量相同時依型別名排，
 * 不然兩次排序遇到同分可能給出不同順序、顏色又會錯開。
 */
export function rankGapTypes(tasksByType: Record<string, number>): string[] {
  return Object.entries(tasksByType)
    .filter(([k, v]) => k !== MANUAL_TASKS_KEY && Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
    .map(([k]) => k)
}

export function topGapTypes(tasksByType: Record<string, number>, n: number): string[] {
  return rankGapTypes(tasksByType).slice(0, n)
}
