/**
 * 地名的比對與排序規則（2026-10-05）。
 *
 * 「臺」與「台」在這個資料庫裡是混用的：`regions.region` 全部寫「台」（台北市），
 * 但 2024 立委的 `regions.sub_region` 寫「臺」（臺北市第01選區）。實測：
 *   regions?region=eq.台北市        → 321 列
 *   regions?region=eq.臺北市        → 0 列
 *   regions?sub_region=like.臺北市* → 8 列
 *   regions?sub_region=like.台北市* → 0 列
 *
 * 所以任何「這個人是不是這個縣市／這個鄉鎮的」比對，兩種寫法都得當成同一個地方，
 * 否則就是靜靜地回 0 筆——畫面上看起來跟「這一區沒有人參選」一模一樣。
 *
 * 資料庫端的對應處理在 get_politicians_by_level（migration 20261005000001）：
 * 那支函式比對 region 與 sub_region 時一樣把「臺」換成「台」。兩邊的規則要一致。
 */

/** 把地名正規化成可以互相比對的形式：「臺」一律當「台」，去掉前後空白。 */
export function normalizeRegionName(name: string | null | undefined): string {
  return (name ?? '').replace(/臺/g, '台').trim()
}

/** 兩個地名指的是不是同一個地方（「臺南市」＝「台南市」）。兩邊都空算相同。 */
export function sameRegionName(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeRegionName(a) === normalizeRegionName(b)
}

/**
 * 同一個地名的「臺」「台」兩種寫法，去重後回傳。
 *
 * 給 PostgREST 的查詢用：`.eq()` 沒辦法在資料庫端做 replace，所以只能把兩種寫法
 * 都列出來用 `.in()` 查。RPC 那一端是在 SQL 裡 replace（migration 20261005000001），
 * 不需要這個。
 *
 * 不含「臺」也不含「台」的地名（嘉義縣、新北市…）只會回一個值。
 */
export function regionNameVariants(name: string | null | undefined): string[] {
  const normalized = normalizeRegionName(name)
  if (!normalized) return []
  return [...new Set([normalized, normalized.replace(/台/g, '臺')])]
}

/**
 * 地名排序：先字數、再筆畫。
 *
 * 原本寫在 ElectionPage.vue 裡（sortByLengthThenStroke）。抽出來是因為鄉鎮市區名錄
 * 的分組也要照同一個順序排——兩邊各寫一份，名錄的順序遲早會跟右側篩選對不上。
 */
export function compareRegionName(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a.localeCompare(b, 'zh-Hant-TW', { numeric: true })
}
