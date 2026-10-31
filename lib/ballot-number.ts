/**
 * 號次的呈現（#460「選前時點內容」第一批）：徽章文字、標題與摘要、同一場選舉內的排序。
 *
 * 號次是中選會抽籤後才有（2026 縣市長、議員 10-23 抽籤），之前一律是空的：
 * 沒有號次就什麼都不顯示，不放「未抽籤」「待公告」這類說明（維護者裁決：讓資料自己說話）。
 * 純函式，不依賴 Vue，頁面、標題、預渲染都用這一份，deno 直接測。
 */
import { pkGroupLabel, type ComparePerson } from './policy-compare'
import { compareRegionName, normalizeRegionName } from './region-name'
import { comparePerson } from './person-name'

/** 合法號次：正整數；0、負數、小數、字串、null 都當成沒有號次 */
export function ballotNo(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** 徽章與列上的字：「2 號」 */
export function ballotLabel(no: unknown): string {
  const n = ballotNo(no)
  return n === undefined ? '' : `${n} 號`
}

/** 姓名帶號次：「王小明（2 號）」；沒有號次就是原姓名。標題用。 */
export function nameWithBallot(name: string, no: unknown): string {
  const label = ballotLabel(no)
  return label ? `${name}（${label}）` : name
}

/** 兩個號次的先後：有號次的在前、小的在前；兩邊都沒有號次回 0（交給穩定排序維持原順序） */
export function compareBallotNo(a: unknown, b: unknown): number {
  const an = ballotNo(a)
  const bn = ballotNo(b)
  if (an !== undefined && bn !== undefined) return an - bn
  if (an !== undefined) return -1
  if (bn !== undefined) return 1
  return 0
}

/**
 * 同一場選舉的候選人依號次排：有號次的照號次在前，沒有號次的排後面並維持原順序。
 *
 * 清單裡可能混著好幾場選舉（全台的縣市長、整個縣市的各選區議員）：只在「同一場」裡重排，
 * 而且每一場在清單裡佔的位置不動——整份清單的分組與先後（使用者選的排序）不被打亂，
 * 只是每一場裡的人換成號次順序。分不出是哪一場（group 回 undefined）的人原地不動。
 * 沒有任何人有號次的場次完全不變。
 */
export function orderByBallotNo<T>(
  list: readonly T[],
  opts: { candNo: (item: T) => unknown; group: (item: T) => string | undefined },
): T[] {
  const slots = new Map<string, number[]>()
  list.forEach((item, i) => {
    const g = opts.group(item)
    if (g === undefined) return
    const idx = slots.get(g)
    if (idx) idx.push(i)
    else slots.set(g, [i])
  })
  const out = [...list]
  for (const idx of slots.values()) {
    // Array.prototype.sort 是穩定排序：沒有號次的 compare 回 0，維持原順序
    const ordered = idx.map((i) => list[i]).sort((a, b) => compareBallotNo(opts.candNo(a), opts.candNo(b)))
    idx.forEach((slot, k) => { out[slot] = ordered[k] })
  }
  return out
}

/** 候選人清單用：「同一場」＝同職位同選區（lib/policy-compare.ts 的 pkGroupLabel，政見 PK 分組也是它） */
export function orderPeopleByBallotNo<T extends ComparePerson>(list: readonly T[]): T[] {
  return orderByBallotNo(list, {
    candNo: (p) => p.candNo,
    group: (p) => {
      if (!p.electionType) return undefined
      const label = pkGroupLabel(p, p.electionType)
      return label === undefined ? undefined : `${p.electionType}|${label}`
    },
  })
}

/** 這一組參選紀錄裡，某一屆的號次；退選的不算（沒有在選票上）。找不到或沒有號次是 undefined */
export function ballotNoOfElection(
  elections: ReadonlyArray<{ electionId: number; candNo?: number | null; candidacyStatus?: string | null }> | undefined,
  electionId: number | null | undefined,
): number | undefined {
  if (!elections || electionId == null) return undefined
  const rec = elections.find((e) => e.electionId === electionId)
  if (!rec || rec.candidacyStatus === 'withdrawn') return undefined
  return ballotNo(rec.candNo)
}

/** 清單裡有沒有任何人有號次（頁面層級：有就不給排序下拉，一律照號次） */
export function anyBallotNo(list: ReadonlyArray<{ candNo?: unknown }>): boolean {
  return list.some((p) => ballotNo(p.candNo) !== undefined)
}

/**
 * 候選人清單的號次呈現：同一場（同職位同選區）只要有人有號次，就純照號次排、沒有號次的人不列
 * （例：新竹縣 2022 縣長 1–5 號之外還有一筆沒號次的重複紀錄，不該排在後面）。
 * 退選的人不隱藏（退選的呈現照舊）；沒有任何號次的場次、分不出是哪一場的人完全不變。
 * 每一場在清單裡佔的位置不動（同 orderPeopleByBallotNo）。
 */
export function listByBallotNo<T extends ComparePerson>(list: readonly T[]): T[] {
  const groupOf = (p: T) => {
    if (!p.electionType) return undefined
    const label = pkGroupLabel(p, p.electionType)
    return label === undefined ? undefined : `${p.electionType}|${label}`
  }
  const numbered = new Set<string>()
  for (const p of list) {
    const g = groupOf(p)
    if (g !== undefined && ballotNo(p.candNo) !== undefined) numbered.add(g)
  }
  const kept = list.filter((p) => {
    const g = groupOf(p)
    return g === undefined || !numbered.has(g) || ballotNo(p.candNo) !== undefined || p.candidacyStatus === 'withdrawn'
  })
  return orderPeopleByBallotNo(kept)
}

/**
 * 跨縣市清單的號次排序（維護者 2026-10-20）：號次是每個縣市、每個選舉區各自抽的，
 * 全國清單照號次交錯排會像亂序（基隆 1 號、新竹市 1 號、桃園 1 號…基隆 2 號）。
 * 所以先依縣市（站上固定的縣市順序 `counties`，不在名單上的排最後）分組，組內依選舉區／鄉鎮（地名固定順序）、
 * 再依號次；沒有號次的放在該選區最後並依姓名筆畫。職位不同的人維持原本先後（依職位第一次出現的位置）。
 * 同樣先套 listByBallotNo（同一場有號次就不列沒號次的、退選照舊）。
 */
export function listByCountyBallot<T extends ComparePerson>(list: readonly T[], counties: readonly string[]): T[] {
  const countyIdx = new Map(counties.map((c, i) => [normalizeRegionName(c), i]))
  const typeIdx = new Map<string, number>()
  for (const p of list) {
    const t = p.electionType ?? ''
    if (!typeIdx.has(t)) typeIdx.set(t, typeIdx.size)
  }
  const rankOfCounty = (p: T) => countyIdx.get(normalizeRegionName(p.region)) ?? counties.length
  return [...listByBallotNo(list)].sort((a, b) =>
    (typeIdx.get(a.electionType ?? '') ?? 0) - (typeIdx.get(b.electionType ?? '') ?? 0) ||
    rankOfCounty(a) - rankOfCounty(b) ||
    compareRegionName(a.subRegion ?? '', b.subRegion ?? '') ||
    // 村里只對村里長有意義：其他職位的人物物件常帶著別場（2022 村里長）的 village，拿來排會讓有村里的人整批掉到同選區的最後
    //（2026-10-31，復興區原住民區代表 2,3,4,5,6,8,7,1 的根因）
    (a.electionType === '村里長' ? compareRegionName(a.village ?? '', b.village ?? '') : 0) ||
    compareBallotNo(a.candNo, b.candNo) ||
    comparePerson(a, b),
  )
}
