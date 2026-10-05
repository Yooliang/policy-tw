/**
 * 村里長名單依村里分組顯示（見 ElectionPage.vue 的 villageChiefGroups 與
 * pages/election/VillageChiefGroups.vue，2026-10-04）。直轄市的區與縣轄鄉鎮市都用這一套。
 *
 * 分組清單（availableVillages／knownVillages）來自「這個區有哪些里有候選人」，用來排順序；
 * 但候選人自己的 village 欄位不保證一定在這份清單裡——可能是空值（資料漏填），
 * 也可能是清單裡找不到的名字（行政區劃調整、里名誤植、跟清單來源對不上）。
 * 2026-10-04 審查發現：舊寫法只留「在 knownVillages 裡」的人，其餘悄悄被濾掉，
 * 一個人都不剩地從畫面消失。改成收進「未標示里別」這組，放在最後，不漏掉任何人。
 */
export const UNLABELED_VILLAGE = '未標示里別'

export interface VillageGroup<T> {
  village: string
  people: T[]
}

export function groupByVillage<T extends { village?: string | null }>(
  people: readonly T[],
  knownVillages: readonly string[],
): VillageGroup<T>[] {
  const byVillage = new Map<string, T[]>()
  for (const person of people) {
    const key = person.village && knownVillages.includes(person.village) ? person.village : UNLABELED_VILLAGE
    byVillage.set(key, [...(byVillage.get(key) ?? []), person])
  }

  const groups = knownVillages
    .filter(village => byVillage.has(village))
    .map(village => ({ village, people: byVillage.get(village)! }))

  const unlabeled = byVillage.get(UNLABELED_VILLAGE)
  if (unlabeled) groups.push({ village: UNLABELED_VILLAGE, people: unlabeled })

  return groups
}
