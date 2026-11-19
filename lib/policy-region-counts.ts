/**
 * 縣市 × 分類的政見筆數（policy_region_category_counts 視圖，約 400 列）→ 方塊格上的數字。
 * 只算 listed：全部政見頁會列出的筆數（選後政見／施政），所以格子上的數字等於點進去清單的筆數。
 * 「全台」「全部分類」在前端加總；沒有分類的列只算進「全部分類」。純函式，沒有 import。
 */
export interface RegionCountRow {
  region: string
  category: string | null
  listed: number
}

const ALL = 'All'

/** 某縣市（'All'＝全台）在某分類（'All'＝全部）下的筆數 */
export function regionTotal(rows: readonly RegionCountRow[], region: string, category: string = ALL): number {
  let sum = 0
  for (const r of rows) {
    if (region !== ALL && r.region !== region) continue
    if (category !== ALL && r.category !== category) continue
    sum += r.listed
  }
  return sum
}

/** 某分類（'All'＝全部）在某縣市（'All'＝全台）範圍內的筆數 */
export function categoryTotal(rows: readonly RegionCountRow[], region: string, category: string): number {
  return regionTotal(rows, region, category)
}
