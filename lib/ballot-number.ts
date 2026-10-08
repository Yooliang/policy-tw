/**
 * 號次的呈現（#460「選前時點內容」第一批）：徽章文字、標題與摘要、同一場選舉內的排序。
 *
 * 號次是中選會抽籤後才有（2026 縣市長、議員 10-23 抽籤），之前一律是空的：
 * 沒有號次就什麼都不顯示，不放「未抽籤」「待公告」這類說明（維護者裁決：讓資料自己說話）。
 * 純函式，不依賴 Vue，頁面、標題、預渲染都用這一份，deno 直接測。
 */
import { pkGroupLabel, type ComparePerson } from './policy-compare'

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
