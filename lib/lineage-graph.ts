/**
 * 完整關係圖（#675 第四期，計畫書 5.2）的排版純函式：脈絡、政見、任期、選舉日、今天 → 泳道、任期條、標籤、箭頭、座標、時序清單。
 * 元件（pages/LineageGraphPage.vue 與 components/LineageGraph*.vue）只負責畫；桌機的 SVG 與手機的直式時間軸吃的是同一份輸出，
 * 圖上的每個標籤都有一筆同 id 的清單項目（lib/lineage-graph.test.ts 比對兩邊的 id 集合）。
 *
 * 零執行期依賴（同層純函式與型別），deno 直接測。
 */
import type { LineageEvent, LineageHandover, LineageStance, Policy } from '../types'
import { EVENT_TYPE_LABEL, HANDOVER_LABEL, lineagePlace, STANCE_LABEL } from './lineage'
import { PAGE_LABELS as T } from './lineage-page-labels'
import { POLICY_STATUS_LABELS } from './site'
import {
  EVENTS_LANE_KEY, FOLDED_LANE_KEY, LAYOUT, OTHER_LANE_KEY,
  type GraphArrow, type GraphBar, type GraphInput, type GraphItem, type GraphLane, type GraphMark, type GraphModel, type GraphTick,
  type ItemDetail, type MarkKind, type MarkTone, type PolicyTone,
} from './lineage-graph-types'
import { addDays, compareLanes, dayNum, isDate, laneMetaOf, normalizeTerms, stackRows, yearOf, type LaneMeta, type Term } from './lineage-graph-terms'

/** 政見進度 → 點的顏色鍵：推動中藍、已實現綠、滯後琥珀、跳票紅，其餘灰 */
export function policyTone(status: string): PolicyTone {
  if (status === 'In Progress') return 'progress'
  if (status === 'Achieved') return 'achieved'
  if (status === 'Stalled') return 'stalled'
  if (status === 'Failed') return 'failed'
  return 'proposed'
}

interface RawMark {
  id: string
  kind: MarkKind
  laneKey: string
  /** 畫在哪一天（交接畫在兩任的交界，其餘等於 date） */
  anchor: string
  date: string
  tone: MarkTone
  label: string
  disputed: boolean
  item: GraphItem
  /** 事件的推動者所在泳道與列（畫箭頭用） */
  from?: { laneKey: string; row: number } | null
  note?: string | null
}

const emptyDetail = (over: Partial<ItemDetail>): ItemDetail => ({
  date: null, datePrecision: 'day', quote: null, text: null, note: null, condition: null, decidedBy: null, person: null, toPerson: null,
  initiator: null, source: null, sourceUrl: '', sourceLocator: '', policyId: null, disputed: false, ...over,
})

/** 超過上限就只留最新的（預設收合較舊的、可展開） */
function limitNewest<A>(list: readonly A[], dateOf: (a: A) => string, expand: boolean): { kept: A[]; hidden: number } {
  if (expand || list.length <= LAYOUT.historyLimit) return { kept: [...list], hidden: 0 }
  const sorted = [...list].sort((a, b) => dateOf(b).localeCompare(dateOf(a)))
  return { kept: sorted.slice(0, LAYOUT.historyLimit), hidden: list.length - LAYOUT.historyLimit }
}

export function buildGraph(input: GraphInput): GraphModel {
  const { lineage, policies, electionDates, nameOf, today } = input
  const allTerms = normalizeTerms(input.terms, today)
  const nameFor = (id: string, fallback = ''): string => nameOf(id) || fallback || T.unnamed

  const termsByPerson = new Map<string, Term[]>()
  for (const t of allTerms) termsByPerson.set(t.politicianId, [...(termsByPerson.get(t.politicianId) ?? []), t])
  const laneMeta = new Map<string, LaneMeta>()
  for (const t of allTerms) if (!laneMeta.has(t.laneKey)) laneMeta.set(t.laneKey, laneMetaOf(t))

  /** 這個人在這一天的任期（嚴格）；loose 時對不到就退到他最近一任 */
  const termAt = (pid: string, date: string, loose: boolean): Term | null => {
    const ts = termsByPerson.get(pid) ?? []
    const cover = ts.filter((t) => t.start <= date && date <= t.end).sort((a, b) => b.start.localeCompare(a.start))[0]
    if (cover) return cover
    if (!loose) return null
    return ts.filter((t) => t.start <= date).sort((a, b) => b.start.localeCompare(a.start))[0] ?? [...ts].sort((a, b) => a.start.localeCompare(b.start))[0] ?? null
  }
  const placeOfLane = (key: string): string => laneMeta.get(key)?.place ?? ''

  // ── 取要畫的資料（立場、事件超過 60 筆預設只留最新）──
  const stanceCut = limitNewest<LineageStance>(lineage.stances ?? [], (s) => s.statedOn, !!input.expandOld)
  const eventCut = limitNewest<LineageEvent>(lineage.events ?? [], (e) => e.occurredOn, !!input.expandOld)
  const policyDate = (p: GraphInput['policies'][number]): string | null => {
    if (isDate(p.proposedDate)) return p.proposedDate.slice(0, 10)
    const d = typeof p.electionId === 'number' ? electionDates.get(p.electionId) : undefined
    return isDate(d) ? d.slice(0, 10) : null
  }
  const handoverDate = (h: LineageHandover): string | null => {
    if (isDate(h.decidedOn)) return h.decidedOn.slice(0, 10)
    const d = h.toElectionId === null ? undefined : electionDates.get(h.toElectionId)
    return isDate(d) ? d.slice(0, 10) : null
  }

  const rawDates = [
    ...policies.map(policyDate), ...stanceCut.kept.map((s) => s.statedOn), ...eventCut.kept.map((e) => e.occurredOn), ...lineage.handovers.map(handoverDate),
  ].filter((d): d is string => !!d)
  const periodStart = rawDates.length > 0 ? [...rawDates].sort()[0] : addDays(today, -1461)
  const periodEnd = [today, ...rawDates].sort().slice(-1)[0]

  // ── 任期條（裁到脈絡期間；單席職位的歷任讓泳道連得起來，多席職位只留涉及的人）──
  const keptTerms = allTerms.filter((t) => t.end >= periodStart && (t.start <= periodEnd || t.status === 'next') && (t.involved || laneMeta.get(t.laneKey)?.single))
  interface BarDraft { id: string; laneKey: string; politicianId: string; name: string; start: string; end: string | null; status: GraphBar['status']; caption: string; realEnd: string }
  const draftsByLane = new Map<string, BarDraft[]>()
  const sortedTerms = [...keptTerms].sort((a, b) => a.start.localeCompare(b.start) || a.politicianId.localeCompare(b.politicianId))
  for (const t of sortedTerms) {
    draftsByLane.set(t.laneKey, [...(draftsByLane.get(t.laneKey) ?? []), {
      id: t.id, laneKey: t.laneKey, politicianId: t.politicianId, name: t.name || nameFor(t.politicianId), start: t.start, end: t.end, status: t.status, caption: '', realEnd: t.end,
    }])
  }
  // 單席職位：跟下一任重疊的部分裁掉（任期條不重疊）
  for (const [key, list] of draftsByLane) {
    if (!laneMeta.get(key)?.single) continue
    draftsByLane.set(key, list.map((b, i) => {
      const next = list[i + 1]
      return next && b.end !== null && next.start <= b.end ? { ...b, end: addDays(next.start, -1) } : b
    }))
  }
  // 下一任（還沒開票）：虛線框，由選舉日推導
  const upcoming = input.upcomingElectionDate && isDate(input.upcomingElectionDate) && input.upcomingElectionDate >= today ? input.upcomingElectionDate.slice(0, 10) : null
  let nextStartMax: string | null = null
  if (upcoming) {
    for (const [key, list] of draftsByLane) {
      if (!laneMeta.get(key)?.single || list.some((b) => b.start > today)) continue
      const last = list[list.length - 1]
      if (!last || last.status !== 'current' || last.realEnd <= upcoming) continue
      const start = addDays(last.realEnd, 1)
      const caption = `${upcoming.slice(5, 7)}/${upcoming.slice(8, 10)} ${T.afterVote}`
      draftsByLane.set(key, [...list, { id: `term:next:${key}`, laneKey: key, politicianId: '', name: caption, start, end: null, status: 'next', caption, realEnd: start }])
      if (!nextStartMax || start > nextStartMax) nextStartMax = start
    }
  }

  // ── 標籤（先決定落在哪一條泳道、畫在哪一天，座標最後算）──
  const raws: RawMark[] = []
  const undatedPolicies: GraphItem[] = []
  const lanesNeeded = new Set<string>([...draftsByLane.keys()])
  const useLane = (key: string): string => { lanesNeeded.add(key); return key }
  const rowInLane = (laneKey: string, pid: string): number => {
    if (laneMeta.get(laneKey)?.single) return 0
    const people = [...new Set((draftsByLane.get(laneKey) ?? []).map((b) => b.politicianId))]
    return Math.max(0, people.indexOf(pid))
  }

  for (const p of policies) {
    const date = policyDate(p)
    const pid = String(p.politicianId)
    const holder = date ? termAt(pid, date, true) : (termsByPerson.get(pid) ?? [])[0] ?? null
    const laneKey = useLane(holder?.laneKey ?? OTHER_LANE_KEY)
    const status = String(p.status)
    const item: GraphItem = {
      id: `policy:${p.id}`, kind: 'policy', date, laneKey, place: placeOfLane(holder?.laneKey ?? ''), person: nameFor(pid), label: p.title,
      text: POLICY_STATUS_LABELS[status] ?? status, tone: policyTone(status), disputed: false,
      detail: emptyDetail({ date, person: { id: pid, name: nameFor(pid) }, policyId: String(p.id), text: POLICY_STATUS_LABELS[status] ?? status }),
    }
    if (date) raws.push({ id: item.id, kind: 'policy', laneKey, anchor: date, date, tone: item.tone, label: p.title, disputed: false, item })
    else undatedPolicies.push(item)
  }

  for (const s of stanceCut.kept) {
    const holder = termAt(s.politicianId, s.statedOn, false)
    const laneKey = useLane(holder?.laneKey ?? OTHER_LANE_KEY)
    const name = nameFor(s.politicianId, s.name)
    const item: GraphItem = {
      id: `stance:${s.id}`, kind: 'stance', date: s.statedOn, laneKey, place: placeOfLane(holder?.laneKey ?? ''), person: name, label: STANCE_LABEL[s.stance],
      text: s.quote, tone: s.stance, disputed: s.disputed,
      detail: emptyDetail({
        date: s.statedOn, datePrecision: s.datePrecision, quote: s.quote, note: s.note, condition: s.condition, person: { id: s.politicianId, name },
        source: s.source, sourceUrl: s.sourceUrl, sourceLocator: s.sourceLocator, disputed: s.disputed,
      }),
    }
    raws.push({ id: item.id, kind: 'stance', laneKey, anchor: s.statedOn, date: s.statedOn, tone: s.stance, label: `${name.slice(0, 3)}${STANCE_LABEL[s.stance]}`, disputed: s.disputed, item })
  }

  for (const e of eventCut.kept) {
    const ini = e.initiator
    const holder = ini ? termAt(ini.politicianId, e.occurredOn, true) : null
    if (holder) useLane(holder.laneKey)
    const name = ini ? nameFor(ini.politicianId, ini.name) : ''
    const item: GraphItem = {
      id: `event:${e.id}`, kind: 'event', date: e.occurredOn, laneKey: EVENTS_LANE_KEY, place: lineagePlace(e), person: name, label: EVENT_TYPE_LABEL[e.eventType],
      text: e.description, tone: e.eventType, disputed: e.disputed,
      detail: emptyDetail({
        date: e.occurredOn, datePrecision: e.datePrecision, text: e.description, note: ini?.note ?? null, decidedBy: e.decidedBy,
        initiator: ini ? { id: ini.politicianId, name, note: ini.note } : null,
        source: e.source, sourceUrl: e.sourceUrl, sourceLocator: e.sourceLocator, disputed: e.disputed,
      }),
    }
    raws.push({
      id: item.id, kind: 'event', laneKey: EVENTS_LANE_KEY, anchor: e.occurredOn, date: e.occurredOn, tone: e.eventType, label: EVENT_TYPE_LABEL[e.eventType], disputed: e.disputed,
      item, from: holder ? { laneKey: holder.laneKey, row: rowInLane(holder.laneKey, holder.politicianId) } : null, note: ini?.note ?? null,
    })
  }

  // 交接：每個單席職位的相鄰兩任各一條交接線（有紀錄標型態、沒有紀錄標「尚未記錄」）；對不到任期的紀錄落在後任或前任的泳道
  const unused = new Set(lineage.handovers.map((h) => h.id))
  const handoverRaw = (h: LineageHandover, laneKey: string, anchor: string, date: string): void => {
    const from = nameFor(h.fromPoliticianId, h.fromName)
    const to = nameFor(h.toPoliticianId, h.toName)
    const item: GraphItem = {
      id: `handover:${h.id}`, kind: 'handover', date, laneKey, place: placeOfLane(laneKey), person: `${from}→${to}`, label: HANDOVER_LABEL[h.handoverType],
      text: h.note, tone: h.handoverType, disputed: false,
      detail: emptyDetail({
        date, note: h.note, person: { id: h.fromPoliticianId, name: from }, toPerson: { id: h.toPoliticianId, name: to },
        source: h.source, sourceUrl: h.sourceUrl, sourceLocator: h.sourceLocator,
      }),
    }
    raws.push({ id: item.id, kind: 'handover', laneKey, anchor, date, tone: h.handoverType, label: HANDOVER_LABEL[h.handoverType], disputed: false, item })
  }
  for (const [key, list] of draftsByLane) {
    if (!laneMeta.get(key)?.single) continue
    const real = list.filter((b) => b.politicianId !== '')
    for (let i = 0; i + 1 < real.length; i++) {
      const a = real[i]
      const b = real[i + 1]
      if (a.politicianId === b.politicianId) continue
      const rec = lineage.handovers.find((h) => unused.has(h.id) && h.fromPoliticianId === a.politicianId && h.toPoliticianId === b.politicianId)
      if (rec) {
        unused.delete(rec.id)
        handoverRaw(rec, key, b.start, handoverDate(rec) ?? b.start)
      } else if (b.start <= today) {
        const date = b.start
        const item: GraphItem = {
          id: `gap:${key}:${a.politicianId}>${b.politicianId}`, kind: 'gap', date, laneKey: key, place: placeOfLane(key), person: `${a.name}→${b.name}`, label: T.handoverUnrecorded,
          text: '', tone: 'unrecorded', disputed: false,
          detail: emptyDetail({ date, person: { id: a.politicianId, name: a.name }, toPerson: { id: b.politicianId, name: b.name } }),
        }
        raws.push({ id: item.id, kind: 'gap', laneKey: key, anchor: date, date, tone: 'unrecorded', label: T.handoverUnrecorded, disputed: false, item })
      }
    }
  }
  for (const h of lineage.handovers) {
    if (!unused.has(h.id)) continue
    const date = handoverDate(h)
    const holder = termAt(h.toPoliticianId, date ?? periodEnd, true) ?? termAt(h.fromPoliticianId, date ?? periodStart, true)
    const at = date ?? (termsByPerson.get(h.toPoliticianId) ?? [])[0]?.start ?? periodStart
    handoverRaw(h, useLane(holder?.laneKey ?? OTHER_LANE_KEY), at, at)
  }

  // ── 時間軸：每兩年一格 ──
  const endBase = nextStartMax && nextStartMax > periodEnd ? addDays(nextStartMax, 366) : periodEnd
  const startYear = Math.floor(yearOf(periodStart) / 2) * 2
  const endYear = Math.max(Math.floor(yearOf(endBase) / 2) * 2 + 2, startYear + 4)
  const domainStart = dayNum(`${startYear}-01-01`)
  const domainEnd = dayNum(`${endYear}-01-01`)
  const width = Math.max(LAYOUT.minWidth, LAYOUT.labelWidth + (endYear - startYear) * LAYOUT.pxPerYear + LAYOUT.rightPad)
  const inner = width - LAYOUT.labelWidth - LAYOUT.rightPad
  const xOf = (date: string): number => LAYOUT.labelWidth + (Math.min(Math.max(dayNum(date), domainStart), domainEnd) - domainStart) / (domainEnd - domainStart) * inner
  const ticks: GraphTick[] = []
  for (let y = startYear; y <= endYear; y += 2) ticks.push({ x: xOf(`${y}-01-01`), label: String(y) })

  // ── 泳道：順序、折疊 ──
  const hasMarks = new Set(raws.map((m) => m.laneKey))
  const metas = [...lanesNeeded].filter((k) => laneMeta.has(k)).map((k) => laneMeta.get(k) as LaneMeta).sort(compareLanes)
  const maxLanes = input.maxLanes ?? LAYOUT.maxLanes
  let shown = metas
  let foldedCount = 0
  if (!input.expandLanes && metas.length > maxLanes) {
    const priority = [...metas.filter((m) => hasMarks.has(m.key)), ...metas.filter((m) => !hasMarks.has(m.key))].slice(0, maxLanes)
    const keep = new Set(priority.map((m) => m.key))
    shown = metas.filter((m) => keep.has(m.key))
    foldedCount = metas.length - shown.length
  }
  const shownKeys = new Set(shown.map((m) => m.key))
  const laneOf = (key: string): string => (key === EVENTS_LANE_KEY || key === OTHER_LANE_KEY || shownKeys.has(key) ? key : FOLDED_LANE_KEY)

  const peopleRows = new Map<string, string[]>()
  for (const m of shown) peopleRows.set(m.key, [...new Set((draftsByLane.get(m.key) ?? []).map((b) => b.politicianId))])
  const finalMarks = raws.map((m) => ({ ...m, laneKey: laneOf(m.laneKey), item: { ...m.item, laneKey: laneOf(m.laneKey) } }))

  // 每條泳道上標籤疊列
  const markW = (k: MarkKind): number => LAYOUT.markWidth[k]
  const byLane = new Map<string, typeof finalMarks>()
  for (const m of finalMarks) byLane.set(m.laneKey, [...(byLane.get(m.laneKey) ?? []), m])
  const rowOf = new Map<string, number>()
  const markRowsOf = new Map<string, number>()
  for (const [key, list] of byLane) {
    const rows = stackRows(list.map((m) => ({ x: xOf(m.anchor), w: markW(m.kind) })))
    list.forEach((m, i) => rowOf.set(m.id, rows[i]))
    markRowsOf.set(key, Math.max(...rows) + 1)
  }

  interface LaneDraft { key: string; kind: GraphLane['kind']; single: boolean; label: string; place: string; level: GraphLane['level']; barRows: number }
  const drafts: LaneDraft[] = []
  if (byLane.has(EVENTS_LANE_KEY)) drafts.push({ key: EVENTS_LANE_KEY, kind: 'events', single: false, label: T.eventsLane, place: '', level: null, barRows: 0 })
  for (const m of shown) {
    drafts.push({ key: m.key, kind: 'position', single: m.single, label: m.label, place: m.place, level: m.level, barRows: m.single ? 1 : Math.max(1, (peopleRows.get(m.key) ?? []).length) })
  }
  if (foldedCount > 0 || byLane.has(FOLDED_LANE_KEY)) {
    drafts.push({ key: FOLDED_LANE_KEY, kind: 'folded', single: false, label: `${T.coverageMore} ${foldedCount} ${T.foldedSuffix}`, place: '', level: null, barRows: 0 })
  }
  if (byLane.has(OTHER_LANE_KEY)) drafts.push({ key: OTHER_LANE_KEY, kind: 'other', single: false, label: T.otherIdentity, place: '', level: null, barRows: 0 })

  const lanes: GraphLane[] = []
  let y = LAYOUT.axisHeight
  for (const d of drafts) {
    const h = LAYOUT.lanePad * 2 + d.barRows * (LAYOUT.barHeight + LAYOUT.barGap) + (markRowsOf.get(d.key) ?? 0) * LAYOUT.markHeight
    lanes.push({ ...d, y, h: Math.max(h, LAYOUT.barHeight + LAYOUT.lanePad * 2) })
    y += Math.max(h, LAYOUT.barHeight + LAYOUT.lanePad * 2)
  }
  const laneByKey = new Map(lanes.map((l) => [l.key, l]))
  const barBase = (l: GraphLane): number => l.y + LAYOUT.lanePad

  // ── 輸出：任期條、標籤、箭頭 ──
  const bars: GraphBar[] = []
  for (const l of lanes) {
    if (l.kind !== 'position') continue
    const people = peopleRows.get(l.key) ?? []
    for (const b of draftsByLane.get(l.key) ?? []) {
      const x1 = xOf(b.start)
      const x2 = b.end === null ? xOf(`${endYear}-01-01`) : xOf(b.end)
      const row = l.single ? 0 : Math.max(0, people.indexOf(b.politicianId))
      bars.push({ id: b.id, laneKey: l.key, politicianId: b.politicianId, name: b.name, start: b.start, end: b.end, status: b.status, x: x1, w: Math.max(x2 - x1, 4), y: barBase(l) + row * (LAYOUT.barHeight + LAYOUT.barGap), h: LAYOUT.barHeight, caption: b.caption })
    }
  }
  const marks: GraphMark[] = finalMarks.map((m) => {
    const lane = laneByKey.get(m.laneKey) as GraphLane
    const base = barBase(lane) + lane.barRows * (LAYOUT.barHeight + LAYOUT.barGap)
    return { id: m.id, kind: m.kind, laneKey: m.laneKey, date: m.date, x: xOf(m.anchor), y: base + (rowOf.get(m.id) ?? 0) * LAYOUT.markHeight + LAYOUT.markHeight / 2, tone: m.tone, label: m.label, disputed: m.disputed }
  }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  const markById = new Map(marks.map((m) => [m.id, m]))

  const arrows: GraphArrow[] = []
  for (const m of finalMarks) {
    if (m.kind !== 'event' || !m.from) continue
    const lane = laneByKey.get(laneOf(m.from.laneKey))
    const target = markById.get(m.id)
    if (!lane || !target) continue
    const row = lane.kind === 'position' ? Math.min(m.from.row, Math.max(0, lane.barRows - 1)) : 0
    const y1 = lane.kind === 'position' ? barBase(lane) + row * (LAYOUT.barHeight + LAYOUT.barGap) + LAYOUT.barHeight / 2 : lane.y + lane.h / 2
    arrows.push({ id: `arrow:${m.id}`, eventId: m.id, x1: target.x, y1, x2: target.x, y2: target.y, note: m.note ?? null })
  }

  const items = [...finalMarks.map((m) => m.item), ...undatedPolicies].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id))
  const participantNames = [...new Set(lineage.participants.map((p) => nameFor(p.politicianId, p.name)))]
  const todayX = dayNum(today) >= domainStart && dayNum(today) <= domainEnd ? xOf(today) : null

  return {
    width, height: y + 8, labelWidth: LAYOUT.labelWidth, lanes, bars, marks, arrows, ticks, todayX, foldedLanes: foldedCount,
    collapsed: { stances: stanceCut.hidden, events: eventCut.hidden }, items, participantNames, empty: bars.length === 0 && marks.length === 0 && items.length === 0,
  }
}
