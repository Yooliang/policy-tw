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

/** 區域統計（region_stats）裡跟人物數有關的欄位 */
export interface RegionPeopleRow {
  region: string
  sub_region: string | null
  village: string | null
  total_politicians: number
}

/**
 * 數據分佈頁地區格上的人物數：縣市層級有統計就用它，沒有就加總該縣市的鄉鎮區（同頁面上方總覽的算法）；
 * 'All'＝全台（22 縣市加總）。還沒載入統計（rows 為空）回 null＝格子不印數字。
 */
export function regionPeopleTotal(rows: readonly RegionPeopleRow[], region: string, counties: readonly string[]): number | null {
  if (rows.length === 0) return null
  const ofCounty = (county: string): number => {
    const city = rows.find((r) => r.region === county && r.sub_region === null)
    if (city && city.total_politicians > 0) return city.total_politicians
    return rows.filter((r) => r.region === county && r.sub_region !== null && r.village === null).reduce((sum, r) => sum + (r.total_politicians || 0), 0)
  }
  return region === ALL ? counties.reduce((sum, c) => sum + ofCounty(c), 0) : ofCounty(region)
}
