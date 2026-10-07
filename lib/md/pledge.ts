/**
 * /data 與矩陣的範圍：用「政見」的屬性劃，不用「人」劃（維護者 2026-10-07；docs/PLAN-term-progress.md 第 3.1、3.4 節）。
 *
 * 一條政見要同時滿足才算某一屆的「競選承諾」資料集：
 *   ① 是競選承諾：origin＝pledge，或 status＝Campaign Pledge（過渡期兩者擇一成立即算；status 詞彙拆分排到就任後，2027 年 1–2 月）
 *   ② election_id＝這一屆
 *   ③ 擁有人是這一屆的在選候選人（lib/md/scope.ts：五種職位、退選的不算）——落選者的承諾保留、標「未當選」
 * 不看 status 裡的進度：2022 屆當選者任內的推動中、已實現、提出（任內政見）不在這裡，下一期用 /data/term/<屆>/… 承接；
 * 在那之前，它們與其他沒地方去的政見一起算進 index.json 的 `unassigned`，依原因分類，每一筆政見要嘛在資料集裡、要嘛在那裡，不會憑空消失。
 */
import type { Election, Policy } from '../../types'
import { CATEGORIES } from '../data-query'
import { isPledge } from '../pledge-origin'
import { electionYear } from './format'

/** 範圍定義的版本。改範圍就加一：預產的內容雜湊把它算進去，上線後第一次排程整批作廢重建，不留舊範圍的列（scripts/build-data-md.ts） */
export const SCOPE_VERSION = 2

/** index.json 的 `kind`：這份資料集收哪一種政見 */
export const DATASET_KIND = 'pledge'

export { isPledge }

/** 某一屆的競選承諾（election_id 等於那一屆；不看擁有人） */
export function pledgesOf<T extends Pick<Policy, 'status' | 'origin' | 'electionId'>>(policies: readonly T[], election: Pick<Election, 'id'>): T[] {
  return policies.filter((p) => p.electionId === election.id && isPledge(p))
}

/** 沒有進資料集的政見，原因（互斥，照下面的先後判斷） */
export const UNASSIGNED_REASONS = ['no_election', 'term_policy', 'other_election_pledge', 'owner_not_in_scope', 'category_not_listed'] as const
export type UnassignedReason = (typeof UNASSIGNED_REASONS)[number]

/** 每個原因的白話（給讀 index.json 的人與程式；純中文） */
export const UNASSIGNED_LABELS: Readonly<Record<UnassignedReason, string>> = {
  no_election: '沒有屆別（election_id 空白）',
  term_policy: '任內政見（不是競選承諾；依屆別分，下一期的 /data/term/<屆> 承接）',
  other_election_pledge: '其他屆的競選承諾（見該屆縣市頁 .md；該屆的分類與矩陣下一期）',
  owner_not_in_scope: '本屆競選承諾，但擁有人不在範圍（退選、沒有這一屆的在選紀錄、職位不在五種之內、村里長）',
  category_not_listed: '本屆競選承諾，但政見類別不在 19 個分類之內（沒有類別，或類別寫法對不上）',
}

export interface Unassigned {
  /** 沒進資料集的政見總數 */
  total: number
  reasons: Record<UnassignedReason, number>
  /** 任內政見（term_policy）依屆別（投票年份；沒有屆別的在 no_election）的筆數 */
  term_policy_by_election: Record<string, number>
  /** 其他屆的競選承諾（other_election_pledge）依屆別（投票年份）的筆數 */
  other_election_pledge_by_election: Record<string, number>
  labels: Record<UnassignedReason, string>
}

const sortedByKey = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))

export interface PledgeScopeInput {
  election: Election
  /** 全部沒被移除的政見 */
  policies: readonly Policy[]
  /** 收錄的人的 id（lib/md/scope.ts 的 scopePeople） */
  scopedIds: ReadonlySet<string>
  /** 所有選舉（任內政見依屆別的年份標題用） */
  elections: readonly Election[]
}

/**
 * 每一條政見要嘛在資料集（分類 .md 與矩陣）裡、要嘛算進 unassigned：回傳「在資料集裡的」與「沒地方去的」兩份，
 * 兩份加起來剛好等於輸入（守門測試盯）。
 */
export function partitionPolicies(input: PledgeScopeInput): { assigned: Policy[]; unassigned: Unassigned } {
  const { election, scopedIds } = input
  const cats = new Set<string>(CATEGORIES)
  const yearOf = new Map(input.elections.map((e) => [e.id, electionYear(e)]))
  const reasons = Object.fromEntries(UNASSIGNED_REASONS.map((r) => [r, 0])) as Record<UnassignedReason, number>
  const termByElection: Record<string, number> = {}
  const otherPledgeByElection: Record<string, number> = {}
  const assigned: Policy[] = []
  for (const p of input.policies) {
    let reason: UnassignedReason | null
    if (p.electionId == null) reason = 'no_election'
    else if (!isPledge(p)) reason = 'term_policy'
    else if (p.electionId !== election.id) reason = 'other_election_pledge'
    else if (!scopedIds.has(p.politicianId)) reason = 'owner_not_in_scope'
    else if (!cats.has(p.category)) reason = 'category_not_listed'
    else reason = null
    if (reason === null) { assigned.push(p); continue }
    reasons[reason]++
    if (reason === 'term_policy' || reason === 'other_election_pledge') {
      const key = yearOf.get(p.electionId as number) ?? String(p.electionId)
      const by = reason === 'term_policy' ? termByElection : otherPledgeByElection
      by[key] = (by[key] ?? 0) + 1
    }
  }
  const total = UNASSIGNED_REASONS.reduce((n, r) => n + reasons[r], 0)
  return {
    assigned,
    unassigned: { total, reasons, term_policy_by_election: sortedByKey(termByElection), other_election_pledge_by_election: sortedByKey(otherPledgeByElection), labels: { ...UNASSIGNED_LABELS } },
  }
}
