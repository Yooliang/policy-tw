import type { CandidacyStatus, Policy } from '../types.ts'

/**
 * 政見階段的單一判斷（維護者 2026-10-19，issue #672「承諾→政見」，R1、R6、R7）。
 *
 * 選前叫「承諾」；開票後當選者那一屆的承諾叫「政見」；落選、退選停在「承諾」；任內提出的施政（origin 不是 pledge）也是「政見」。
 * **讀取端推導、status 不動**：結果入庫、投票日一過就自動換階段，結果被更正也自動回去，沒有任何資料被寫。
 *
 * 全站問「已投票」「當選」只問這個檔：
 *   - 已投票＝投票日早於**台北今天**；投票日當天算還沒投票（R7）。
 *   - 當選只認 candidacy_status＝elected（R6）：不看現任公職、不看有沒有任期紀錄。
 * 底層兩個函式（isElectionVoted、isElectedTerm）跟 supabase/functions/_shared/elected-term.ts 同一份規則；
 * 前端不能 import supabase/functions，所以這裡鏡像一份，lib/policy-stage.test.ts 在同一批資料、多個「今天」上逐案對齊。
 * 這個檔只 import 型別，deno 直接能測。
 */

/** 今天（台北日期，YYYY-MM-DD；台北沒有夏令時間，固定 +8 小時） */
export function taipeiToday(now: Date | number = new Date()): string {
  const ms = typeof now === 'number' ? now : now.getTime()
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 那一屆已經投票（投票日早於 today；投票日當天算還沒投票）。沒有投票日＝不知道，當成還沒 */
export function isElectionVoted(electionDate: string | null | undefined, today: string = taipeiToday()): boolean {
  return !!electionDate && electionDate.slice(0, 10) < today
}

/** 那一屆已投票，而且提出者在那一屆有當選紀錄（同一屆有幾筆紀錄，只要有一筆當選） */
export function isElectedTerm(
  f: { election_date: string | null; candidacy_statuses: ReadonlyArray<string | null | undefined> },
  today: string = taipeiToday(),
): boolean {
  return isElectionVoted(f.election_date, today) && f.candidacy_statuses.includes('elected')
}

/** 判斷用的一筆參選紀錄（Politician.elections 的子集） */
export interface StageElectionRecord {
  electionId: number
  candidacyStatus?: CandidacyStatus | string | null
  electionDate?: string
}

/**
 * 政見的階段：
 *   pledge         承諾：選前（那一屆還沒投票）、沒標屆別、查不到投票日
 *   policy         政見：任內提出的施政；或那一屆已投票且提出者當選
 *   lost_pledge    落選、退選的承諾（停在承諾）
 *   pending_result 已投票但結果還沒補上（R5：維持「承諾」，畫面印現成小標「結果待補」）
 */
export type PolicyStage = 'pledge' | 'policy' | 'lost_pledge' | 'pending_result'

/**
 * 來源是競選承諾：origin 標了 pledge；origin 沒標時看 status 是不是 Campaign Pledge（過渡期，同 lib/pledge-origin.ts）。
 * origin 標成別的（施政報告、議會提案、預算）一律不是承諾，不管 status。
 */
function isPledgeSource(p: Pick<Policy, 'status' | 'origin'>): boolean {
  if (p.origin) return p.origin === 'pledge'
  return String(p.status) === 'Campaign Pledge'
}

/**
 * @param politicianElections 提出者的參選紀錄（只用到同一屆那幾筆）
 * @param electionDateOf      投票日查詢（例：elections 清單）；沒給或查不到就用參選紀錄自帶的 electionDate
 */
export function policyStage(
  policy: Pick<Policy, 'status' | 'origin' | 'electionId'>,
  politicianElections: readonly StageElectionRecord[] | undefined,
  today: string = taipeiToday(),
  electionDateOf?: (electionId: number) => string | null | undefined,
): PolicyStage {
  if (!isPledgeSource(policy)) return 'policy'
  const eid = typeof policy.electionId === 'number' ? policy.electionId : null
  if (eid === null) return 'pledge'
  const records = (politicianElections ?? []).filter((r) => r.electionId === eid)
  const date = electionDateOf?.(eid) ?? records.find((r) => r.electionDate)?.electionDate ?? null
  if (!isElectionVoted(date, today)) return 'pledge'
  const statuses = records.map((r) => r.candidacyStatus ?? null)
  if (isElectedTerm({ election_date: date, candidacy_statuses: statuses }, today)) return 'policy'
  if (statuses.includes('not_elected') || statuses.includes('withdrawn')) return 'lost_pledge'
  return 'pending_result'
}
