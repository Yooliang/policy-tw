import { PolicyStatus, type Policy } from '../types'
import { policySortDate } from './policy-date'

/**
 * 「這條政見的同一條脈絡裡還有哪些政見」與「進度過半的政見」（#349 第二階段 A，2026-10-06）。
 *
 * 以前政見之間的關聯靠 `related_policies` 互指（政見頁的「市政接力」、/analysis/:policyId 的接力鏈）：
 * 那張表線上 0 列、沒有任何寫入者。政策脈絡取代它——兩條政見是同一件事，就是歸入同一條脈絡
 * （`policies.lineage_id`，視圖 policies_with_logs.lineage 帶出來）。互指是對稱、可傳遞的鏈，
 * 脈絡是「一條政見只屬於一條脈絡」的分組，所以這裡不需要走訪，同一個 lineage id 就是同一組。
 *
 * 預渲染（lib/ssg/page-data.ts）、邊緣渲染（lib/ssr/loaders.ts）與頁面元件共用這一份，
 * 切片裡嵌了哪些政見跟頁面畫了哪些政見才不會各算各的。
 */

type WithLineage = Pick<Policy, 'id' | 'lineage'>

/** 這條政見所屬脈絡裡的政見 id（含它自己）；沒歸入脈絡就只有它自己 */
export function lineageMateIds(policy: WithLineage, policies: readonly WithLineage[]): Set<string> {
  const ids = new Set<string>([String(policy.id)])
  const lineageId = policy.lineage?.id
  if (!lineageId) return ids
  for (const p of policies) if (p.lineage?.id === lineageId) ids.add(String(p.id))
  return ids
}

/** 起點是政見 id 的版本（預渲染切片用）：找不到那條政見就只有它的 id */
export function lineageMateIdsOf(startId: string, policies: readonly WithLineage[]): Set<string> {
  const start = policies.find((p) => String(p.id) === String(startId))
  return start ? lineageMateIds(start, policies) : new Set([String(startId)])
}

/**
 * 同一條脈絡的政見，照提出時間排（含它自己；沒歸入脈絡只有它自己）。
 * 同一時間的照 id 排，排序不看黨派、不看政見多寡。
 */
export function lineageChain<T extends Pick<Policy, 'id' | 'lineage' | 'proposedDate' | 'lastUpdated'>>(policy: T | undefined, policies: readonly T[]): T[] {
  if (!policy) return []
  const ids = lineageMateIds(policy, policies)
  const chain = policies.filter((p) => ids.has(String(p.id)))
  if (!chain.some((p) => String(p.id) === String(policy.id))) chain.push(policy)
  return chain.sort((a, b) => policySortDate(a) - policySortDate(b) || String(a.id).localeCompare(String(b.id)))
}

/**
 * /analysis 下半「進度過半的政見」每一張卡對應一條政見：已經不是競選承諾、進度過半。
 * 預渲染的 /analysis/:policyId 就是這些政見（lib/ssg/page-data.ts 的 analysisListedPolicyIds），
 * 頁面與預渲染共用這一支，不會一邊多一張、另一邊沒有網址。
 */
export function isProgressCase(policy: Pick<Policy, 'status' | 'progress'>): boolean {
  return policy.status !== PolicyStatus.CAMPAIGN && policy.progress > 50
}
