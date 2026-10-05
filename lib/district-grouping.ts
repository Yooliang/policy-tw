/**
 * 議員與原住民區代表依「選舉區」分組顯示（2026-10-04）。
 *
 * 一個縣市的議員動輒上百位（高雄市 2022 有 124 位），全部攤成一長串卡片，
 * 使用者要找「我這一區選誰」得自己一張張看選區標籤。依選區分組之後，
 * 加上一排選區名快篩，跟 #337 的里名 chip 是同一個操作習慣。
 *
 * 跟 village-grouping.ts 刻意分開：那一支的分組清單由呼叫端給（availableVillages
 * 來自右側篩選，順序要跟它一致），這一支的選區清單是從候選人自己身上蒐集的——
 * 選舉區沒有另一份來源，而且要用自然排序讓「第02選舉區」排在「第10選舉區」前面。
 */

/** 選區沒填的人收在這一組，排在最後。不要靜靜濾掉：那會讓人從畫面上消失。 */
export const UNLABELED_DISTRICT = '未標示選舉區'

export interface DistrictGroup<T> {
  district: string
  people: T[]
}

/**
 * 自然排序：第02選舉區 要排在 第10選舉區 前面。
 * 單純用字串比較會得到 第10 < 第02（字元 '1' < '2'），分組順序就亂了。
 */
function compareDistrict(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hant-TW', { numeric: true })
}

export function groupByDistrict<T extends { subRegion?: string | null }>(
  people: readonly T[],
): DistrictGroup<T>[] {
  const byDistrict = new Map<string, T[]>()
  for (const person of people) {
    const key = person.subRegion?.trim() || UNLABELED_DISTRICT
    byDistrict.set(key, [...(byDistrict.get(key) ?? []), person])
  }

  const labelled = [...byDistrict.keys()]
    .filter(district => district !== UNLABELED_DISTRICT)
    .sort(compareDistrict)
    .map(district => ({ district, people: byDistrict.get(district)! }))

  const unlabelled = byDistrict.get(UNLABELED_DISTRICT)
  return unlabelled ? [...labelled, { district: UNLABELED_DISTRICT, people: unlabelled }] : labelled
}

/** 快篩用的選區清單（已排序，不含「未標示選舉區」——那不是一個可以點的選區） */
export function districtsOf<T extends { subRegion?: string | null }>(people: readonly T[]): string[] {
  return groupByDistrict(people)
    .map(g => g.district)
    .filter(district => district !== UNLABELED_DISTRICT)
}
