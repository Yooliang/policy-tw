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

/**
 * 沒有正式選區的人收在這一組，排在最後。不要靜靜濾掉：那會讓人從畫面上消失。
 * 2026-10-05 改名「選區待補」：這一組的人都有一件補選區任務在排隊（contribution_auto_tasks_region_gap）。
 */
export const UNLABELED_DISTRICT = '選區待補'

/**
 * 這個標籤是不是正式選區（2026-10-05）。
 *
 * 2026 台中市議員的快篩清單混進了「大雅區」「豐原區」「臺中市第03選區」：沒有選區的議員紀錄借了人物自己的地區
 * （里長那一筆的區、立委那一筆的選區）。分組只認正式寫法，其餘一律收進「選區待補」，不要冒出假選區：
 *   縣市議員       第NN選舉區
 *   原住民區代表   <區>第NN選舉區
 *   立法委員       <縣市>第NN選區，或不分區／平地原住民／山地原住民
 * 不給選舉別時三種寫法都認（舊呼叫端）。
 */
const COUNCIL_RE = /^第\d{2}選舉區$/
const TOWNSHIP_DISTRICT_RE = /^.+[區鄉鎮市]第\d{2}選舉區$/
const LEGISLATOR_RE = /^..[縣市]第\d{2}選區$/
const AT_LARGE = ['不分區', '平地原住民', '山地原住民']

export function isFormalDistrict(label: string, electionType?: string): boolean {
  switch (electionType) {
    case '縣市議員': return COUNCIL_RE.test(label)
    case '直轄市山地原住民區民代表':
    case '鄉鎮市民代表': return TOWNSHIP_DISTRICT_RE.test(label)
    case '立法委員': return LEGISLATOR_RE.test(label) || AT_LARGE.includes(label)
    case undefined: return COUNCIL_RE.test(label) || TOWNSHIP_DISTRICT_RE.test(label) || LEGISLATOR_RE.test(label) || AT_LARGE.includes(label)
    default: return false
  }
}

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
  electionType?: string,
): DistrictGroup<T>[] {
  const byDistrict = new Map<string, T[]>()
  for (const person of people) {
    const label = person.subRegion?.trim() ?? ''
    const key = label && isFormalDistrict(label, electionType) ? label : UNLABELED_DISTRICT
    byDistrict.set(key, [...(byDistrict.get(key) ?? []), person])
  }

  const labelled = [...byDistrict.keys()]
    .filter(district => district !== UNLABELED_DISTRICT)
    .sort(compareDistrict)
    .map(district => ({ district, people: byDistrict.get(district)! }))

  const unlabelled = byDistrict.get(UNLABELED_DISTRICT)
  return unlabelled ? [...labelled, { district: UNLABELED_DISTRICT, people: unlabelled }] : labelled
}

/** 快篩用的選區清單（已排序，只有正式選區；不含「選區待補」——那不是一個可以點的選區） */
export function districtsOf<T extends { subRegion?: string | null }>(people: readonly T[], electionType?: string): string[] {
  return groupByDistrict(people, electionType)
    .map(g => g.district)
    .filter(district => district !== UNLABELED_DISTRICT)
}
