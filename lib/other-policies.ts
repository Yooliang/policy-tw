import type { Policy } from '../types.ts'
import { isPostElectionStage, type PolicyStage } from './policy-stage.ts'

/**
 * 政見／承諾詳細頁側欄「該候選人的其他承諾」「政見」兩區的分法（小良哥 2026-11-02）。
 *   - 承諾＝階段不是 policy／governance（選前、落選退選、結果待補）；政見區＝階段是 policy 或 governance（當選那屆、任內施政），區名不變。
 *   - 目前這條是承諾：「其他承諾」只列同一場選舉（同 electionId）。
 *   - 目前這條是政見：「其他承諾」不列落選／退選那幾屆（沒當選沒意義），其餘照列，同一屆排前面。
 *   - 每區各取前 limit 筆；排序沿用 compare。
 */
export interface OtherPoliciesSplit<T> {
  pledges: T[]
  policies: T[]
}

type Item = Pick<Policy, 'id' | 'electionId'>

export function splitOtherPolicies<T extends Item>(
  candidates: readonly T[],
  current: Item,
  currentStage: PolicyStage,
  stageOf: (p: T) => PolicyStage,
  compare: (a: T, b: T) => number,
  limit = 3,
): OtherPoliciesSplit<T> {
  const pledges: T[] = []
  const policies: T[] = []
  for (const p of candidates) {
    if (p.id === current.id) continue
    const s = stageOf(p)
    if (isPostElectionStage(s)) { policies.push(p); continue }
    const sameElection = p.electionId === current.electionId
    if (!isPostElectionStage(currentStage)) {
      if (sameElection) pledges.push(p)
    } else if (s !== 'lost_pledge') {
      pledges.push(p)
    }
  }
  const sameFirst = (a: T, b: T) =>
    Number(b.electionId === current.electionId) - Number(a.electionId === current.electionId) || compare(a, b)
  return {
    pledges: pledges.sort(sameFirst).slice(0, limit),
    policies: policies.sort(compare).slice(0, limit),
  }
}
