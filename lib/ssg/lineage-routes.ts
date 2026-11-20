/**
 * 脈絡頁進預渲染／網站地圖清單的路徑（lib/ssg/server-data.ts 的 collectRoutePaths 用；純函式，deno 直接測）。
 * 只有主頁 /lineage/<id>。完整關係圖 /lineage/<id>/graph（#675 第四期）只在瀏覽器端畫、noindex，
 * 不預渲染、不進網站地圖——沒有列在清單裡的動態路由 vite-ssg 不會預渲染。
 */
export function lineageEdgePaths(lineages: ReadonlyArray<{ id: string }>): string[] {
  return lineages.map((l) => `/lineage/${l.id}`)
}
