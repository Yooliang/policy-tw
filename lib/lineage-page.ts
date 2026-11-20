/**
 * 政策脈絡主頁（#675 第三期）的純函式：現況句、各方立場表、大事記、筆數列。
 * 頁面（pages/LineagePage.vue）只負責畫；怎麼取最新、怎麼排、什麼算「曾變」都在這裡，deno 直接測。
 * 資料全部來自 lineages_full 那一列（立場、事件、現況、出處都在裡面），所以邊緣渲染與預渲染拿到的是同一份。
 *
 * 零執行期依賴（只有型別與同層純函式）。
 */
import type { DatePrecision, Lineage, LineageCoverage, LineageEvent, LineageHandover, LineageLevel, LineageSource, LineageStance, Policy, StanceKind } from '../types'
import { lineagePlace, type PersonElections } from './lineage'
import { STATUS_PHASE_LABEL } from './lineage-page-labels'

/** 日期怎麼念：只到年就印年、到月印年月、到日印全日（不寫相對時間，SSR 快取與水合會對不上） */
export function formatStatedDate(date: string | null | undefined, precision: DatePrecision = 'day'): string {
  if (!date) return ''
  const d = date.slice(0, 10)
  if (precision === 'year') return d.slice(0, 4)
  if (precision === 'month') return d.slice(0, 7)
  return d
}

// ── 現況 ──────────────────────────────────────────────────────────────────

/** 現況的階段標籤；認不得的階段不印（不冒充） */
export function statusPhaseLabel(phase: string | null | undefined): string {
  return phase ? STATUS_PHASE_LABEL[phase] ?? '' : ''
}

/** `<title>` 與 description 帶的現況句：「階段：一句（截至日）」；沒有現況回空字串 */
export function statusHeadline(l: Pick<Lineage, 'status'>): string {
  const s = l.status
  if (!s) return ''
  const phase = statusPhaseLabel(s.phase)
  return `${phase ? `${phase}：` : ''}${s.text}（${s.asOf}）`
}

// ── 涵蓋的地方 ────────────────────────────────────────────────────────────

/** 涵蓋的地名（去重、保留視圖給的順序）；沒有涵蓋就是空陣列、標題列不印那一格 */
export function coveragePlaces(coverage: readonly LineageCoverage[] | undefined): string[] {
  const seen = new Set<string>()
  for (const c of coverage ?? []) {
    const name = lineagePlace(c)
    if (name) seen.add(name)
  }
  return [...seen]
}

// ── 各方立場 ──────────────────────────────────────────────────────────────

const LEVEL_RANK: Readonly<Record<LineageLevel, number>> = { national: 0, county: 1, township: 2 }
export const NATIONAL_TYPES = ['總統副總統', '立法委員']
export const TOWNSHIP_TYPES = ['鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表']

type PersonLike = PersonElections & { region?: string }

/** 這個人屬於哪一層：看他最近一次當選的職位，沒有當選過就看最近一次參選；看不出來是 null（排最後） */
export function personLevel(person: PersonLike | undefined): { level: LineageLevel | null; region: string | null } {
  const recs = (person?.elections ?? []).filter((r) => r.electionType)
  if (recs.length === 0) return { level: null, region: null }
  const newest = (list: typeof recs) => [...list].sort((a, b) => (b.electionDate ?? '').localeCompare(a.electionDate ?? '') || b.electionId - a.electionId)[0]
  const elected = recs.filter((r) => r.candidacyStatus === 'elected')
  const type = newest(elected.length > 0 ? elected : recs).electionType ?? ''
  const level: LineageLevel = NATIONAL_TYPES.includes(type) ? 'national' : TOWNSHIP_TYPES.includes(type) ? 'township' : 'county'
  const region = person?.region && person.region !== 'All' ? person.region : null
  return { level, region: level === 'national' ? null : region }
}

export interface StanceRow {
  key: string
  politicianId: string
  name: string
  level: LineageLevel | null
  region: string | null
  /** recorded＝有正式表態紀錄；derived＝只有政見、沒有表態紀錄（畫面標「提出政見」，不算筆數、不寫任何資料表） */
  kind: 'recorded' | 'derived'
  stance: StanceKind | null
  condition: string | null
  date: string | null
  datePrecision: DatePrecision
  /** 這個人的立場變過（較早的一筆跟最新一筆的立場不同）；第四期才會連到關係圖，現在只是文字標籤 */
  changed: boolean
  disputed: boolean
  source: LineageSource | null
  sourceUrl: string
  /** 推導列的出處是政見頁 */
  policyId: string | null
}

type PolicyLike = Pick<Policy, 'id' | 'politicianId' | 'proposedDate' | 'electionId'>

export interface StanceInput {
  stances: readonly LineageStance[]
  /** 脈絡裡的政見（只有那一屆已投票且當選的，視圖給的就是這些） */
  policies: readonly PolicyLike[]
  personOf: (politicianId: string) => PersonLike | undefined
  nameOf: (politicianId: string) => string | undefined
  electionDates: ReadonlyMap<number, string>
}

/**
 * 各方立場表的列：每人取最新一筆（日期新者勝、同日取後面的）；立場變過的標 changed；
 * 政見持有人沒有任何立場紀錄時補一列「提出政見」（日期＝提出日或那一屆投票日）——只在畫面算。
 * 排序：中央 → 縣市 → 鄉鎮 → 看不出層級，同層依地區，再依日期新到舊，最後依姓名。
 */
export function buildStanceRows(input: StanceInput): StanceRow[] {
  const { stances, policies, personOf, nameOf, electionDates } = input
  const byPerson = new Map<string, LineageStance[]>()
  stances.forEach((s) => { byPerson.set(s.politicianId, [...(byPerson.get(s.politicianId) ?? []), s]) })

  const rows: StanceRow[] = []
  for (const [pid, list] of byPerson) {
    // 輸入順序＝視圖順序（表態日、建立時間）；同日取後面的
    const latest = list.reduce((best, s) => (s.statedOn >= best.statedOn ? s : best), list[0])
    const { level, region } = personLevel(personOf(pid))
    rows.push({
      key: `stance:${latest.id}`, politicianId: pid, name: latest.name || nameOf(pid) || '', level, region, kind: 'recorded',
      stance: latest.stance, condition: latest.condition, date: latest.statedOn, datePrecision: latest.datePrecision,
      changed: list.some((s) => s.id !== latest.id && s.stance !== latest.stance),
      disputed: latest.disputed, source: latest.source, sourceUrl: latest.sourceUrl, policyId: null,
    })
  }

  const dateOfPolicy = (p: PolicyLike): string | null => p.proposedDate ?? (typeof p.electionId === 'number' ? electionDates.get(p.electionId) ?? null : null)
  const firstPolicyOf = new Map<string, PolicyLike>()
  for (const p of policies) {
    const pid = String(p.politicianId)
    if (byPerson.has(pid)) continue
    const cur = firstPolicyOf.get(pid)
    if (!cur || (dateOfPolicy(p) ?? '9999-12-31') < (dateOfPolicy(cur) ?? '9999-12-31')) firstPolicyOf.set(pid, p)
  }
  for (const [pid, p] of firstPolicyOf) {
    const { level, region } = personLevel(personOf(pid))
    rows.push({
      key: `derived:${pid}`, politicianId: pid, name: nameOf(pid) || '', level, region, kind: 'derived', stance: null, condition: null,
      date: dateOfPolicy(p), datePrecision: 'day', changed: false, disputed: false, source: null, sourceUrl: '', policyId: String(p.id),
    })
  }

  const rank = (r: StanceRow) => (r.level === null ? 3 : LEVEL_RANK[r.level])
  return rows.sort((a, b) =>
    rank(a) - rank(b)
    || (a.region ?? '').localeCompare(b.region ?? '', 'zh-Hant-TW')
    || (b.date ?? '').localeCompare(a.date ?? '')
    || a.name.localeCompare(b.name, 'zh-Hant-TW-u-co-stroke')
    || a.key.localeCompare(b.key))
}

// ── 大事記 ────────────────────────────────────────────────────────────────

export type ChronicleItem =
  | { kind: 'event'; key: string; date: string | null; precision: DatePrecision; event: LineageEvent }
  | { kind: 'handover'; key: string; date: string | null; precision: DatePrecision; handover: LineageHandover }

/** 大事記：事件與交接合在一起，新到舊（沒有日期的排最後），同日事件在前、交接在後 */
export function buildChronicle(
  events: readonly LineageEvent[],
  handovers: readonly LineageHandover[],
  electionDates: ReadonlyMap<number, string>,
): ChronicleItem[] {
  const items: ChronicleItem[] = [
    ...events.map((event): ChronicleItem => ({ kind: 'event', key: `event:${event.id}`, date: event.occurredOn, precision: event.datePrecision, event })),
    ...handovers.map((handover): ChronicleItem => {
      const toDate = handover.toElectionId === null ? undefined : electionDates.get(handover.toElectionId)
      return { kind: 'handover', key: `handover:${handover.id}`, date: handover.decidedOn ?? toDate ?? null, precision: 'day', handover }
    }),
  ]
  const order = (i: ChronicleItem) => (i.kind === 'event' ? 0 : 1)
  return items.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || order(a) - order(b) || a.key.localeCompare(b.key))
}

/** 大事記一開始印幾筆；其餘收在「更多」裡（仍在 HTML 內，不是點了才載入） */
export const CHRONICLE_HEAD = 4

// ── 筆數列 ────────────────────────────────────────────────────────────────

export interface PageCounts { policies: number; handovers: number; events: number; stances: number }

/** 筆數列：政見、交接、事件、立場各幾筆；「提出政見」推導列不算進立場 */
export function pageCounts(l: Pick<Lineage, 'policyIds' | 'handovers' | 'events' | 'stances'>): PageCounts {
  return { policies: l.policyIds.length, handovers: l.handovers.length, events: (l.events ?? []).length, stances: (l.stances ?? []).length }
}

// ── 頁面提到的人 ──────────────────────────────────────────────────────────

/** 政策脈絡頁提到的人（#349、#675）：政見提出者、參與者、交接的前後任、立場表態者、事件推動者。預渲染與邊緣 SSR 共用（lib/ssg/page-data.ts 轉出） */
export function lineagePeople(lineage: Lineage, policies: readonly Pick<Policy, 'politicianId'>[]): string[] {
  return [...new Set([
    ...policies.map((p) => String(p.politicianId)),
    ...lineage.participants.map((p) => p.politicianId),
    ...lineage.handovers.flatMap((h) => [h.fromPoliticianId, h.toPoliticianId]),
    ...(lineage.stances ?? []).map((s) => s.politicianId),
    ...(lineage.events ?? []).flatMap((e) => (e.initiator ? [e.initiator.politicianId] : [])),
  ])]
}
