/**
 * 參選地圖的資料快取單例（模組層，離開頁面再回來也還在）：
 * - rowsCache：candidacy_map RPC 的結果，鍵＝「層級:上層代碼」（含屆別），縮放切換細節層、來回捲動都不再重打；
 *   換屆別或使用者按重新整理才 clear()。
 * - fileCache：點陣靜態檔解開後的原始 JSON（村里層被釋放的只是解碼後的 path，原始 JSON 留著，再進視窗不用再抓）。
 */
import { createAsyncCache } from './async-cache'
import type { CountRow } from './candidacy-map'

export const rowsCache = createAsyncCache<CountRow[]>()
export const fileCache = createAsyncCache<unknown>()

/** 標籤避讓結果：依（圖層、縮放級距）快取，回到同一級不重算；名稱是靜態資料，所以不會失效 */
export const labelCache = new Map<string, Array<{ code: string; text: string; x: number; y: number; fs: number }>>()

export function rowsKey(electionId: number, level: string, parent?: string): string {
  return `${electionId}:${level}:${parent ?? ''}`
}
