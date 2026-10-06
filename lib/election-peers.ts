import type { Politician, PoliticianElectionData } from '../types'
import { isRunningCandidate } from './candidate-status'
import { isCounty } from './election-regions'
import { newerFirst } from './election-route'

/**
 * 人物頁的「同選區其他候選人」與麵包屑（2026-09-30）。
 * 純函式：預渲染切片（lib/ssg/page-data.ts）、邊緣 SSR 載入器（lib/ssr/loaders.ts）與頁面元件共用，
 * 三邊算出來的名單一致，hydrate 才不會對不上。
 */

export const PEER_LIMIT = 20

/** 這個人「最新一屆有在選」的參選紀錄；全部都是未登記就沒有 */
export function primaryElection(p: Politician | null | undefined): PoliticianElectionData | undefined {
  if (!p?.elections?.length) return undefined
  return [...p.elections]
    .filter((e) => isRunningCandidate(e.candidacyStatus))
    .sort(newerFirst)[0]
}

/** 指定屆別的參選紀錄（政見頁用政見所屬的屆別）；沒有就退回最新一屆 */
export function electionRecordFor(p: Politician | null | undefined, electionId?: number): PoliticianElectionData | undefined {
  if (electionId !== undefined) {
    const hit = p?.elections?.find((e) => e.electionId === electionId && isRunningCandidate(e.candidacyStatus))
    if (hit) return hit
  }
  return primaryElection(p)
}

/** 縣市長的選區就是整個縣市；其餘要同縣市＋同選區（村里長再加同村里） */
function sameDistrict(a: PoliticianElectionData, b: PoliticianElectionData): boolean {
  if (a.region !== b.region) return false
  if (b.electionType === '縣市長' || b.electionType === '總統副總統') return true
  return (a.subRegion ?? '') === (b.subRegion ?? '') && (a.village ?? '') === (b.village ?? '')
}

export function isPeerOf(candidate: Politician, target: PoliticianElectionData): boolean {
  return (candidate.elections ?? []).some((e) =>
    e.electionId === target.electionId
    && e.electionType === target.electionType
    && isRunningCandidate(e.candidacyStatus)
    && sameDistrict(e, target),
  )
}

function candNoOf(p: Politician, electionId: number): number {
  const no = p.elections?.find((e) => e.electionId === electionId)?.candNo
  return typeof no === 'number' ? no : Number.MAX_SAFE_INTEGER
}

/**
 * 同屆、同選舉類型、同選區的其他候選人：先照號次、再照姓名，最多 PEER_LIMIT 位。
 * 選區沒有縣市（例如總統）就不列——全國幾位總統候選人本來就在選舉頁上。
 */
export function electionPeers(self: Politician | null | undefined, pool: Politician[]): Politician[] {
  const target = primaryElection(self)
  if (!self || !target || !isCounty(target.region)) return []
  return pool
    .filter((c) => String(c.id) !== String(self.id) && !c.mergedInto && isPeerOf(c, target))
    .sort((a, b) => candNoOf(a, target.electionId) - candNoOf(b, target.electionId) || a.name.localeCompare(b.name, 'zh-Hant-TW'))
    .slice(0, PEER_LIMIT)
}
