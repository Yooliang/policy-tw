/**
 * 政策脈絡（#349，2026-10-06）的顯示規則。網站上叫「政策脈絡」，簡稱「脈絡」。
 *
 * 一條脈絡＝一件事在某一層級、某一地方的來龍去脈（比照日本站 keifu 的 lineages／handovers），三個方向：
 *   前後任：脈絡內的交接（接手／轉向／縮小／中止／重新開始）
 *   同級多人：脈絡內的參與者與角色（提案／共同提案／連署／主張推動）；**角色以官方紀錄為準，本人自述只標「本人宣稱」**
 *   上下級：不同的脈絡互相關聯（上級立法或補助 → 下級執行；下級爭取 → 上級採納）
 * 資料在視圖 lineages_full（脈絡頁、脈絡一覽）與 policies_with_logs.lineage（政見頁「所屬脈絡」）。
 * 中文標籤跟後端 supabase/functions/_shared/lineage.ts 同一份，lib/lineage.test.ts 盯兩邊一致。
 *
 * 零執行期依賴（只有型別），能被 deno 直接測。
 */
import type {
  HandoverType, Lineage, LineageHandover, LineageLevel, LineageLink, LineageLinkType, LineageParticipant, LineageSource,
  LineageSummary, ParticipantBasis, ParticipantRole, Policy, PolicyOrigin, RawLineage, RawLineageSource, RawLineageSummary,
} from '../types'
import { isElectedTerm, isElectionVoted, taipeiToday } from './policy-stage'

export const LINEAGE_NAME = '政策脈絡'
export const LINEAGE_SHORT_NAME = '脈絡'

export const LEVEL_LABEL: Readonly<Record<LineageLevel, string>> = { national: '中央', county: '縣市', township: '鄉鎮市區' }
export const HANDOVER_LABEL: Readonly<Record<HandoverType, string>> = { keep: '接手', pivot: '轉向', shrink: '縮小', stop: '中止', resume: '重新開始' }
export const HANDOVER_HINT: Readonly<Record<HandoverType, string>> = {
  keep: '後任原樣延續',
  pivot: '目的不變，做法變了',
  shrink: '規模或預算縮水，但沒有停',
  stop: '後任停掉了',
  resume: '曾經停掉，後來又重啟',
}
export const ROLE_LABEL: Readonly<Record<ParticipantRole, string>> = { proposer: '提案', co_proposer: '共同提案', cosigner: '連署', advocate: '主張推動' }
export const BASIS_LABEL: Readonly<Record<ParticipantBasis, string>> = { official_record: '官方紀錄', self_claim: '本人宣稱' }
export const LINK_LABEL: Readonly<Record<LineageLinkType, string>> = { top_down: '上級立法或補助，下級執行', bottom_up: '下級爭取，上級採納' }
export const ORIGIN_LABEL: Readonly<Record<PolicyOrigin, string>> = { pledge: '競選承諾', policy_address: '施政報告', assembly: '議會提案', budget: '預算' }

/** 交接型態的樣式：中止紅、縮小琥珀、轉向紫、接手與重新開始綠（深色模式由 styles/main.css 統一換色） */
export const HANDOVER_BADGE: Readonly<Record<HandoverType, string>> = {
  keep: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  pivot: 'bg-violet-50 text-violet-700 border border-violet-200',
  shrink: 'bg-amber-50 text-amber-800 border border-amber-200',
  stop: 'bg-red-50 text-red-700 border border-red-200',
  resume: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
}

export function lineagePath(id: string): string {
  return `/lineage/${id}`
}

/** 脈絡的地方怎麼念：全國／台中市／台中市大雅區 */
export function lineagePlace(l: { level: LineageLevel; region: string | null; subRegion: string | null }): string {
  if (l.level === 'national') return '全國'
  return `${l.region ?? ''}${l.level === 'township' ? l.subRegion ?? '' : ''}` || '（地方未填）'
}

const isLevel = (v: unknown): v is LineageLevel => v === 'national' || v === 'county' || v === 'township'
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function mapSource(s: RawLineageSource | null | undefined, fallbackUrl?: string | null): LineageSource | null {
  if (s && typeof s.url === 'string' && s.url) return { url: s.url, title: s.title ?? null, publisher: s.publisher ?? null, kind: s.kind ?? null, archiveUrl: s.archive_url ?? null }
  return fallbackUrl ? { url: fallbackUrl } : null
}

/** policies_with_logs.lineage → 摘要；格式不對（舊視圖沒有這一欄）就是 null */
export function mapLineageSummary(row: RawLineageSummary | null | undefined): LineageSummary | null {
  if (!row || typeof row.id !== 'string' || typeof row.title !== 'string' || !isLevel(row.level)) return null
  return {
    id: row.id,
    title: row.title,
    level: row.level,
    region: str(row.region),
    subRegion: str(row.sub_region),
    category: str(row.category),
    summary: str(row.summary),
  }
}

const ROLES = new Set(['proposer', 'co_proposer', 'cosigner', 'advocate'])
const BASES = new Set(['official_record', 'self_claim'])
const HANDOVERS = new Set(['keep', 'pivot', 'shrink', 'stop', 'resume'])
const LINKS = new Set(['top_down', 'bottom_up'])

/** lineages_full 一列 → 前端型別；認不得的角色、型態丟掉（不讓它冒充值域裡的一個） */
export function mapLineage(row: RawLineage): Lineage | null {
  const base = mapLineageSummary(row)
  if (!base) return null
  const participants: LineageParticipant[] = (row.participants ?? [])
    .filter((p) => ROLES.has(p.role) && BASES.has(p.basis))
    .map((p) => ({
      id: p.id, politicianId: p.politician_id, name: p.name ?? '', role: p.role as ParticipantRole, basis: p.basis as ParticipantBasis,
      sourceUrl: p.source_url, sourceLocator: p.source_locator, note: str(p.note), source: mapSource(p.source, p.source_url),
    }))
  const handovers: LineageHandover[] = (row.handovers ?? [])
    .filter((h) => HANDOVERS.has(h.handover_type))
    .map((h) => ({
      id: h.id,
      fromPoliticianId: h.from_politician_id, fromName: h.from_name ?? '', fromElectionId: h.from_election_id ?? null,
      toPoliticianId: h.to_politician_id, toName: h.to_name ?? '', toElectionId: h.to_election_id ?? null,
      handoverType: h.handover_type as HandoverType, decidedOn: str(h.decided_on), note: h.note,
      sourceUrl: h.source_url, sourceLocator: h.source_locator, source: mapSource(h.source, h.source_url),
    }))
  const links: LineageLink[] = (row.links ?? [])
    .filter((k) => LINKS.has(k.link_type) && (k.direction === 'upper' || k.direction === 'lower') && isLevel(k.level))
    .map((k) => ({
      id: k.id, direction: k.direction as 'upper' | 'lower', lineageId: k.lineage_id, title: k.title, level: k.level as LineageLevel,
      region: str(k.region), subRegion: str(k.sub_region), linkType: k.link_type as LineageLinkType, note: k.note,
      sourceUrl: k.source_url, sourceLocator: k.source_locator, source: mapSource(k.source, k.source_url),
    }))
  return {
    ...base,
    policyIds: (row.policy_ids ?? []).filter((x): x is string => typeof x === 'string'),
    participants,
    handovers,
    links,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function sourceLabel(source: LineageSource | null | undefined): string {
  if (!source) return ''
  if (source.title) return source.title
  if (source.publisher) return source.publisher
  try { return new URL(source.url).hostname.replace(/^www\./, '') } catch { return source.url }
}

// ── 時間軸（前後任）────────────────────────────────────────────────────────

/** 時間軸上的一任：某人某一屆在這件事上的政見 */
export interface TimelineTerm {
  kind: 'term'
  key: string
  politicianId: string
  electionId: number | null
  /** 那一屆的投票日（排序用）；不知道是 null */
  electionDate: string | null
  year: number | null
  policies: Policy[]
}
/** 時間軸上的一段交接：放在後任那一任的前面 */
export interface TimelineHandover {
  kind: 'handover'
  key: string
  handover: LineageHandover
}
export type TimelineItem = TimelineTerm | TimelineHandover

/**
 * 時間軸：政見照「人＋屆別」分成一任一任，照投票日排（同一屆照提出者 id 排，不看政見多寡、不看黨派）；
 * 交接放在後任那一任的前面。後任那一任在這條脈絡裡沒有政見（例：後任停掉了，自己沒提這件事）的，
 * 交接照交接的判定日期排在對應的位置，不會因為沒有政見就消失。
 */
export function buildTimeline(
  policies: readonly Policy[],
  handovers: readonly LineageHandover[],
  electionDates: ReadonlyMap<number, string>,
): TimelineItem[] {
  const terms = new Map<string, TimelineTerm>()
  for (const p of policies) {
    const eid = typeof p.electionId === 'number' ? p.electionId : null
    const key = `${p.politicianId}|${eid ?? ''}`
    let t = terms.get(key)
    if (!t) {
      const date = eid !== null ? electionDates.get(eid) ?? null : null
      t = { kind: 'term', key, politicianId: String(p.politicianId), electionId: eid, electionDate: date, year: date ? Number(date.slice(0, 4)) : null, policies: [] }
      terms.set(key, t)
    }
    t.policies.push(p)
  }
  const sortKey = (date: string | null) => date ?? '9999-12-31'
  const ordered = [...terms.values()].sort((a, b) =>
    sortKey(a.electionDate).localeCompare(sortKey(b.electionDate)) || a.politicianId.localeCompare(b.politicianId))

  const items: TimelineItem[] = []
  const placed = new Set<string>()
  const handoverDate = (h: LineageHandover): string | null => {
    const toDate = h.toElectionId === null ? undefined : electionDates.get(h.toElectionId)
    return toDate ?? h.decidedOn
  }
  for (const term of ordered) {
    for (const h of handovers) {
      if (placed.has(h.id)) continue
      const intoThisTerm = h.toPoliticianId === term.politicianId && (h.toElectionId === null || h.toElectionId === term.electionId)
      // 後任在脈絡裡沒有政見：照日期插在第一個比它晚的那一任前面
      const lands = handoverDate(h)
      const before = !terms.has(`${h.toPoliticianId}|${h.toElectionId ?? ''}`) && !intoThisTerm && lands !== null && term.electionDate !== null && lands <= term.electionDate
      if (intoThisTerm || before) {
        items.push({ kind: 'handover', key: `handover:${h.id}`, handover: h })
        placed.add(h.id)
      }
    }
    items.push(term)
  }
  for (const h of handovers) if (!placed.has(h.id)) items.push({ kind: 'handover', key: `handover:${h.id}`, handover: h })
  return items
}

/**
 * 時間軸上那一任寫什麼職位：那一屆已投票而且參選紀錄標當選，寫職位本身，例「縣市長」；
 * 沒當選、還沒投票的寫「縣市長參選人」——職稱只能從當選來（2026-10-04 裁決），不能把參選人寫成首長。
 * 「當選」跟全站同一個判斷（lib/policy-stage.ts 的 isElectedTerm，#672 R6）：只認 candidacy_status＝elected 且投票日早於台北今天，
 * 不看現任公職（現任公職是任期表的事，不是這一屆的結果）。投票日從 electionDates 或參選紀錄自帶的 electionDate 取，兩邊都沒有就當還沒投票。
 */
export function termRoleLabel(
  person: { elections?: Array<{ electionId: number; electionType?: string; candidacyStatus?: string; electionDate?: string }> } | undefined,
  electionId: number | null,
  electionDates: ReadonlyMap<number, string> = new Map(),
  today: string = taipeiToday(),
): string {
  if (!person || electionId === null) return ''
  const records = (person.elections ?? []).filter((e) => e.electionId === electionId)
  const rec = records[0]
  if (!rec?.electionType) return ''
  const date = electionDates.get(electionId) ?? records.find((r) => r.electionDate)?.electionDate ?? null
  const elected = isElectedTerm({ election_date: date, candidacy_statuses: records.map((r) => r.candidacyStatus ?? null) }, today)
  return elected ? rec.electionType : `${rec.electionType}參選人`
}

// ── 什麼時候該有交接、誰算民意代表（跟派工同一個條件）──────────────────────────

/** 行政首長的三種職位：這一任卸任後才該有交接（跟 contribution_auto_tasks_handover_missing 同一份） */
export const EXECUTIVE_OFFICE_TYPES: readonly string[] = ['縣市長', '鄉鎮市長', '直轄市山地原住民區長']
/** 民意代表的四種職位：當過才有「脈絡裡的角色」可查（跟 contribution_auto_tasks_lineage_roles 同一份） */
export const REPRESENTATIVE_OFFICE_TYPES: readonly string[] = ['立法委員', '縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表']

/** 判斷用的人物：只要參選紀錄（Politician 的子集，lib 維持零執行期依賴） */
export interface PersonElections {
  elections?: Array<{ electionId: number; electionType?: string; candidacyStatus?: string; electionDate?: string }>
}

/**
 * 卸任日（任期最後一天，ISO 日期）：任期四年，最後一天＝四年後那一屆就任日的前一天——
 * 地方公職 12/24、立委 1/31、總統副總統 5/19。跟資料庫的 office_term_end 同一個算法
 * （elections.end_date 存的是投票日，不能拿來當這個）。
 */
export function officeTermEnd(electionYear: number, electionType: string): string {
  const year = electionYear + 4
  if (electionType === '總統副總統') return `${year}-05-19`
  if (electionType === '立法委員') return `${year}-01-31`
  return `${year}-12-24`
}

const electionDateOf = (rec: { electionId: number; electionDate?: string }, electionDates: ReadonlyMap<number, string>): string | null =>
  electionDates.get(rec.electionId) ?? rec.electionDate ?? null

/**
 * 這位持有人在那一屆（electionId）當選、職位是行政首長、而且那一任已卸任？
 * 派 handover_missing 的條件之一：只看「當選」（candidacy_status = elected），參選、落選都不算，也不看現在在不在任。
 * today 是 ISO 日期（YYYY-MM-DD），由呼叫端給，函式本身不讀時鐘。
 */
export function isRetiredExecutive(
  person: PersonElections | undefined,
  electionId: number | null,
  electionDates: ReadonlyMap<number, string>,
  today: string,
): boolean {
  if (!person || electionId === null) return false
  return (person.elections ?? []).some((rec) => {
    if (rec.electionId !== electionId || rec.candidacyStatus !== 'elected') return false
    if (!rec.electionType || !EXECUTIVE_OFFICE_TYPES.includes(rec.electionType)) return false
    const year = Number((electionDateOf(rec, electionDates) ?? '').slice(0, 4))
    return Number.isInteger(year) && year > 0 && officeTermEnd(year, rec.electionType) < today
  })
}

/**
 * 這條脈絡該不該有交接區：脈絡裡有某條政見的持有人是在那一屆當選的行政首長、而且那一任已卸任
 * （跟 contribution_auto_tasks_handover_missing 同一個條件，只是少了「後任是誰」——後任要換人才有，畫面不必等）。
 * 選前的承諾（候選人）、民意代表的提案、還在任的首長都不成立。
 */
export function needsHandoverRecord(
  policies: ReadonlyArray<Pick<Policy, 'politicianId' | 'electionId'>>,
  personOf: (politicianId: string) => PersonElections | undefined,
  electionDates: ReadonlyMap<number, string>,
  today: string,
): boolean {
  return policies.some((p) => isRetiredExecutive(
    personOf(String(p.politicianId)),
    typeof p.electionId === 'number' ? p.electionId : null,
    electionDates,
    today,
  ))
}

/**
 * 當過民意代表（立委、縣市議員、鄉鎮市民代表、原住民區民代表）：任何一屆當選、投票日已過。
 * 只有這些人，官方紀錄（議事系統、議會網站）才有他在某件事裡的角色可查；行政首長與候選人沒有。
 */
export function hasBeenRepresentative(
  person: PersonElections | undefined,
  electionDates: ReadonlyMap<number, string>,
  today: string,
): boolean {
  return (person?.elections ?? []).some((rec) => {
    if (rec.candidacyStatus !== 'elected' || !rec.electionType || !REPRESENTATIVE_OFFICE_TYPES.includes(rec.electionType)) return false
    const date = electionDateOf(rec, electionDates)
    return isElectionVoted(date, today)
  })
}

/** 時間軸上一條政見的小字：政見從哪裡來＋目前進度；「競選承諾」本身是來源不是進度，不重複印 */
export function policyMeta(p: Pick<Policy, 'origin' | 'status'>, statusLabel: (s: string) => string): string {
  const parts: string[] = []
  if (p.origin) parts.push(ORIGIN_LABEL[p.origin])
  if (String(p.status) !== 'Campaign Pledge' || !p.origin) parts.push(statusLabel(String(p.status)))
  return [...new Set(parts)].join('・')
}

// ── 參與者（同級多人）──────────────────────────────────────────────────────

/** 一個人在這條脈絡裡的角色：官方紀錄的角色與本人宣稱分開列，政見提出者（沒有官方角色的）另外標 */
export interface ParticipantRow {
  politicianId: string
  name: string
  official: LineageParticipant | null
  claim: LineageParticipant | null
  /** 這個人在這條脈絡裡有幾條政見 */
  policyCount: number
  /** 當過民意代表（hasBeenRepresentative）：只有他們的「官方紀錄裡的角色」才查得到，沒有紀錄才有「還沒有」可講 */
  representative: boolean
}

const ROLE_ORDER: readonly ParticipantRole[] = ['proposer', 'co_proposer', 'cosigner', 'advocate']

/**
 * 參與者清單：有官方角色的照 提案 → 共同提案 → 連署 → 主張推動 排；只有本人宣稱的排在後面；
 * 只提了政見、還沒有任何角色紀錄的排最後（標「政見提出者」，不是角色）。同一層照姓名筆畫排（不看黨派、不看政見數）。
 */
export function participantRows(
  participants: readonly LineageParticipant[],
  policies: readonly Policy[],
  nameOf: (politicianId: string) => string | undefined,
  isRepresentative: (politicianId: string) => boolean = () => false,
): ParticipantRow[] {
  const rows = new Map<string, ParticipantRow>()
  const get = (pid: string, name: string) => {
    let r = rows.get(pid)
    if (!r) { r = { politicianId: pid, name, official: null, claim: null, policyCount: 0, representative: isRepresentative(pid) }; rows.set(pid, r) }
    return r
  }
  for (const p of participants) {
    const r = get(p.politicianId, p.name || nameOf(p.politicianId) || '')
    if (p.basis === 'official_record') r.official = p
    else r.claim = p
  }
  for (const pol of policies) {
    const pid = String(pol.politicianId)
    get(pid, nameOf(pid) ?? '').policyCount++
  }
  const rank = (r: ParticipantRow) => r.official ? ROLE_ORDER.indexOf(r.official.role) : r.claim ? ROLE_ORDER.length : ROLE_ORDER.length + 1
  return [...rows.values()]
    .map((r) => ({ ...r, name: r.name || nameOf(r.politicianId) || '（姓名待查）' }))
    .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length || a.name.localeCompare(b.name, 'zh-Hant-TW-u-co-stroke') || a.politicianId.localeCompare(b.politicianId))
}

/** 一條脈絡的數字（清單卡片用）：幾條政見、幾個人、幾筆交接、幾條上下級 */
export function lineageCounts(l: Lineage): { policies: number; people: number; handovers: number; links: number } {
  const people = new Set<string>(l.participants.map((p) => p.politicianId))
  return { policies: l.policyIds.length, people: people.size, handovers: l.handovers.length, links: l.links.length }
}

/**
 * 這條脈絡要不要公開列出（脈絡一覽、網站地圖）：一條政見都沒有的空脈絡不列。
 * 起因（2026-10-19，協議 1.99.0）：脈絡只收那一屆已投票且當選的政見，已在脈絡裡才變得不合格的政見，讀取端不算（lineages_full.policy_ids
 * 只帶合格的、資料不動），有些脈絡會因此剩 0 條。**資料列不刪**（lineages_full 照常回那一列），舊網址 /lineage/:id 照常能開（不能 404），只是頁面標 noindex、不進網站地圖與一覽。
 */
export function isLineageListed(l: { policyIds?: readonly string[] | null }): boolean {
  return !Array.isArray(l.policyIds) || l.policyIds.length > 0
}

/** 清單篩選：縣市（「All」不篩；中央層級在每個縣市都列）、分類、關鍵字（標題與摘要） */
export function filterLineages(list: readonly Lineage[], opts: { region?: string; category?: string; q?: string }): Lineage[] {
  const q = (opts.q ?? '').trim().toLowerCase()
  const norm = (s: string | null | undefined) => (s ?? '').replace(/臺/g, '台')
  return list.filter((l) =>
    (!opts.region || opts.region === 'All' || l.level === 'national' || norm(l.region) === norm(opts.region))
    && (!opts.category || opts.category === 'All' || l.category === opts.category)
    && (!q || l.title.toLowerCase().includes(q) || (l.summary ?? '').toLowerCase().includes(q)))
}
