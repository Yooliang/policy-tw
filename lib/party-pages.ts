/**
 * 政黨一覽與各黨頁（#346 第一階段，2026-10-06）。純函式，建置端算好放進頁面快照。
 *
 * 規則（跟日本站「政黨頁」同一個原則：不排名、不打分）：
 * - 一覽只列正見收錄的人物裡有人屬於它的政黨，依名稱筆畫排，不依人數、席次排；無黨籍不是政黨，不列。
 * - 各黨頁三塊：現職首長、現職民代（職稱只來自任期，lib/politician-office.ts 的 officeTitles）、各屆參選人（每一屆、每一種職位）。
 *   同一塊裡依地區、姓名筆畫排，不依當選與否或政見數排。
 * - **第一階段依人物目前的政黨文字**（politicians.party 經 party_aliases 對照，跟資料庫 politicians.party_id 同一條規則）——
 *   跟選舉頁卡片上的政黨同一個依據；參選紀錄的 party_id（那一次參選時的政黨）第二階段補齊後改讀它。
 */
import { buildPartyIndex, matchParty, type PartyIndex, type PartyRegistry, type PartyRow } from './parties'
import { officeTitles } from './politician-office'
import { candidacyNote } from './people-directory'
import { participationLabel } from './participation-label'
import { POSITIONS, positionSpec } from './election-levels'
import type { Election, Politician } from '../types'

export interface PartyRef {
  id: number
  name: string
}

export interface PartySummary {
  id: number
  name: string
  shortName: string | null
  moiNo: number | null
  moiStatus: string | null
  validFrom: string | null
  note: string | null
  predecessor: PartyRef | null
  successor: PartyRef | null
  evidenceUrl: string | null
}

export interface PartyPerson {
  id: string
  name: string
  /** 現職：職稱；參選人：那一次參選的職位與地區（例：台南市議員） */
  what: string
  /** 參選人才有：那一次的結果或狀態（當選、落選、已登記…） */
  status?: string
}

export interface PartyGroup {
  /** 職位（九種選舉別之一） */
  type: string
  label: string
  people: PartyPerson[]
}

export interface PartyElectionBlock {
  electionId: number
  name: string
  shortName: string
  electionDate: string
  groups: PartyGroup[]
  count: number
}

export interface PartyPageData {
  party: PartySummary
  heads: PartyGroup[]
  councils: PartyGroup[]
  elections: PartyElectionBlock[]
}

const STROKE_ORDER = new Intl.Collator('zh-Hant-TW')
const TYPE_ORDER = new Map(POSITIONS.map((p, i) => [p.type as string, i]))
const typeRank = (t: string) => TYPE_ORDER.get(t) ?? 99
const labelOf = (t: string) => positionSpec(t)?.label ?? t

/**
 * 參選那一次的職位與地區。鄉鎮層級的職位（鄉鎮市長、代表、原住民區、村里長）participationLabel 只寫鄉鎮，
 * 一份全國的名單裡要補上縣市才分得出是哪裡（例：屏東縣東港鎮長）。
 */
export function placeLabel(rec: { electionType?: string; position?: string; region?: string; subRegion?: string; village?: string }): string {
  const county = (rec.region || '').trim()
  // 縣市長、議員的地區寫成「全國」是資料還沒補縣市（補縣市任務會派），不要組出「全國長」
  if (county === '全國' && (rec.electionType === '縣市長' || rec.electionType === '縣市議員')) return labelOf(rec.electionType)
  const base = participationLabel(rec) || (rec.electionType ? labelOf(rec.electionType) : '')
  const township = positionSpec(rec.electionType ?? '')?.level === 'township' || rec.electionType === '村里長'
  return township && county && county !== '全國' && !base.startsWith(county) ? `${county}${base}` : base
}

/** 人物 → 政黨 id（照人物目前的政黨文字）。無黨籍、寫法對不到的不在任何政黨裡 */
export function membersByParty(politicians: readonly Politician[], index: PartyIndex): Map<number, Politician[]> {
  const out = new Map<number, Politician[]>()
  for (const pl of politicians) {
    if (pl.mergedInto) continue
    const m = matchParty(pl.party, index)
    if (m.kind !== 'party') continue
    const list = out.get(m.partyId)
    if (list) list.push(pl)
    else out.set(m.partyId, [pl])
  }
  return out
}

function ref(p: PartyRow | undefined): PartyRef | null {
  return p ? { id: p.id, name: p.name } : null
}

export function partySummary(p: PartyRow, registry: PartyRegistry): PartySummary {
  const byId = new Map(registry.parties.map((x) => [x.id, x]))
  const successor = registry.parties.find((x) => x.predecessor_id === p.id)
  return {
    id: p.id,
    name: p.name,
    shortName: p.short_name,
    moiNo: p.moi_no,
    moiStatus: p.moi_status,
    validFrom: p.valid_from,
    note: p.note,
    predecessor: p.predecessor_id !== null ? ref(byId.get(p.predecessor_id)) : null,
    successor: ref(successor),
    evidenceUrl: p.evidence_url ?? null,
  }
}

/** 一覽：有人屬於它的政黨，依名稱筆畫排（不依人數） */
export function partyList(politicians: readonly Politician[], registry: PartyRegistry): PartySummary[] {
  const members = membersByParty(politicians, buildPartyIndex(registry))
  return registry.parties
    .filter((p) => (members.get(p.id)?.length ?? 0) > 0)
    .map((p) => partySummary(p, registry))
    .sort((a, b) => STROKE_ORDER.compare(a.name, b.name) || a.id - b.id)
}

function byWhatThenName(a: PartyPerson, b: PartyPerson): number {
  return STROKE_ORDER.compare(a.what, b.what) || STROKE_ORDER.compare(a.name, b.name) || a.id.localeCompare(b.id)
}

function grouped(entries: Array<{ type: string; person: PartyPerson }>): PartyGroup[] {
  const map = new Map<string, PartyPerson[]>()
  for (const { type, person } of entries) {
    const list = map.get(type)
    if (list) list.push(person)
    else map.set(type, [person])
  }
  return [...map.entries()]
    .sort((a, b) => typeRank(a[0]) - typeRank(b[0]))
    .map(([type, people]) => ({ type, label: labelOf(type), people: people.sort(byWhatThenName) }))
}

/** 一個政黨的頁面資料；這個政黨沒有人（或不存在）回 null */
export function partyPage(
  partyId: number,
  politicians: readonly Politician[],
  registry: PartyRegistry,
  elections: readonly Election[],
  today: string,
): PartyPageData | null {
  const party = registry.parties.find((p) => p.id === partyId)
  if (!party) return null
  const members = membersByParty(politicians, buildPartyIndex(registry)).get(partyId) ?? []
  if (members.length === 0) return null

  // 現職：只看最近一屆的任期（officeTitles 同一條規則），首長與民代分開
  const heads: Array<{ type: string; person: PartyPerson }> = []
  const councils: Array<{ type: string; person: PartyPerson }> = []
  for (const pl of members) {
    // 有沒有現任公職照 officeTitles（職稱只來自任期）；字面另外補縣市（同 placeLabel），全國的名單才分得出是哪裡
    if (officeTitles(pl.offices).length === 0) continue
    const latest = Math.max(...(pl.offices ?? []).map((o) => o.electionId))
    const current = (pl.offices ?? [])
      .filter((o) => o.electionId === latest && o.electionType)
      .sort((a, b) => typeRank(a.electionType!) - typeRank(b.electionType!))
    const type = current[0]?.electionType
    if (!type) continue
    const what = [...new Set(current.map((o) => placeLabel(o)).filter(Boolean))].join('、')
    const person = { id: String(pl.id), name: pl.name, what }
    if (positionSpec(type)?.role === 'head') heads.push({ type, person })
    else councils.push({ type, person })
  }

  // 各屆參選人：照投票日新到舊；每一屆依職位分組
  const blocks: PartyElectionBlock[] = []
  for (const e of [...elections].sort((a, b) => b.electionDate.localeCompare(a.electionDate) || b.id - a.id)) {
    const entries: Array<{ type: string; person: PartyPerson }> = []
    for (const pl of members) {
      const rec = (pl.elections ?? []).find((r) => r.electionId === e.id)
      if (!rec || !rec.electionType) continue
      entries.push({
        type: rec.electionType,
        person: {
          id: String(pl.id),
          name: pl.name,
          what: placeLabel(rec),
          // 投完票的只講結果（結果還沒補上講「結果待補」），還沒投票的講登記階段（lib/people-directory.ts 的 candidacyNote）
          status: candidacyNote(rec, e.electionDate < today),
        },
      })
    }
    if (entries.length === 0) continue
    blocks.push({ electionId: e.id, name: e.name, shortName: e.shortName, electionDate: e.electionDate, groups: grouped(entries), count: entries.length })
  }

  return { party: partySummary(party, registry), heads: grouped(heads), councils: grouped(councils), elections: blocks }
}

/** 一組人很多時預設收合（內容照樣在 HTML 裡、連結照樣是真的，只是不把頁面拉長） */
export const OPEN_GROUP_MAX = 60
