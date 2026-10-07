/**
 * 分類、縣市×分類 Markdown 與矩陣收哪些人（docs/PLAN-markdown-views.md 第 4 節；維護者 2026-10-07：只算該屆參選人的政見）：
 * **最新一屆定期選舉的在選候選人**（退選的不算），職位限縣市頁那一層與下一層（縣市長、縣市議員、立法委員、鄉鎮市長、原住民區長——跟
 * 縣市頁 .md、網頁縣市頁同一份職位表 lib/election-levels.ts），名下沒被移除的政見全部算。每個人歸一個縣市：參選紀錄的縣市；
 * 不是縣市層級的（總統、不分區立委）歸「全國」。
 * 矩陣頁（/election/<屆>/matrix）、分類 .md、縣市×分類 .md 讀同一份，格子數字與 .md 筆數才會一致。
 */
import type { Election, Politician, PoliticianElectionData } from '../../types'
import { isRunningCandidate } from '../candidate-status'
import { isCounty } from '../election-regions'
import { positionsToLoad } from '../election-levels'
import { participationLabel } from '../participation-label'
import { candidacyNote } from '../politician-office'
import { normalizeRegionName } from '../region-name'

export const NATIONAL = '全國'

/** 縣市頁那一層與下一層的職位（直轄市與縣都算，聯集） */
const PAGE_TYPES: ReadonlySet<string> = new Set([
  ...positionsToLoad({ region: '台南市', subRegion: 'All', isSpecialMunicipality: true }),
  ...positionsToLoad({ region: '嘉義縣', subRegion: 'All', isSpecialMunicipality: false }),
])

export interface ScopedPerson {
  politician: Politician
  /** 22 縣市之一，或「全國」 */
  region: string
  /** 一行說明：「2026 台南市議員・已登記」 */
  label: string
}

export const regionOfRecord = (r: string | undefined): string => {
  const n = normalizeRegionName(r)
  return isCounty(n) ? n : NATIONAL
}

/** 這個人在這一屆的在選參選紀錄（職位限縣市頁那一層與下一層）；沒有（或已退選）回 undefined */
export function runningRecord(p: Pick<Politician, 'elections'>, electionId: number): PoliticianElectionData | undefined {
  return p.elections?.find((e) => e.electionId === electionId && isRunningCandidate(e.candidacyStatus) && PAGE_TYPES.has(e.electionType ?? ''))
}

export function scopeOf(p: Politician, election: Election, today: string): ScopedPerson | null {
  if (p.mergedInto) return null
  const rec = runningRecord(p, election.id)
  if (!rec) return null
  const note = candidacyNote(rec, election.electionDate < today)
  const what = participationLabel(rec) || rec.position || '參選'
  return { politician: p, region: regionOfRecord(rec.region), label: `${election.electionDate.slice(0, 4)} ${what}${note ? `・${note}` : ''}` }
}

/** 一批人 → 收錄的人（去重） */
export function scopePeople(people: readonly Politician[], election: Election, today: string): ScopedPerson[] {
  const seen = new Set<string>()
  const out: ScopedPerson[] = []
  for (const p of people) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const s = scopeOf(p, election, today)
    if (s) out.push(s)
  }
  return out
}

/**
 * 「最新一屆」：投票日最新、而且選的是縣市長與縣市議員的那一場（定期地方選舉）。
 * 補選、重行選舉只選一個職位、一個地方，不拿來當整份分類的基準。看投票日，不從 id 推年份。
 */
export function latestLocalElection(elections: readonly Election[]): Election | undefined {
  return [...elections]
    .filter((e) => e.types.map(String).includes('縣市長') && e.types.map(String).includes('縣市議員'))
    .sort((a, b) => b.electionDate.localeCompare(a.electionDate))[0]
}
