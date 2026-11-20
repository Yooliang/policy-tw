// 脈絡完整關係圖（/lineage/<id>/graph，#675 第四期）不進網站地圖：postbuild-ssg.mjs 與 lib/lineage-graph-routes.test.ts 共用。
// postbuild 對 /lineage/ 開頭一律分進 sitemap-policies.xml，所以光靠「清單裡沒有」不夠：
//   1. 群組比對排除 /graph（lineageSitemapMatch）
//   2. 建置檢查：任何網站地圖網址以 /graph 結尾就讓 build 紅（graphUrlsIn）

/** 路徑是不是關係圖頁（以 /graph 結尾，容許尾斜線與查詢字串） */
export function isGraphRoute(route) {
  return /\/graph\/?(?:[?#].*)?$/.test(String(route))
}

/** sitemap-policies.xml 收的脈絡頁：/lineage/ 開頭、而且不是關係圖 */
export function lineageSitemapMatch(route) {
  return String(route).startsWith('/lineage/') && !isGraphRoute(route)
}

/** 清單（路徑或完整網址）裡的關係圖網址；要是非空，build 要紅 */
export function graphUrlsIn(urls) {
  return [...urls].filter((u) => isGraphRoute(u))
}
