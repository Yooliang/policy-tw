/**
 * 完整關係圖（#675 第四期）排版純函式的守門測試。
 *   泳道排序、任期條不重疊、立場落在對的泳道、對不到任期落「其他」、每個職位各一條交接線、下一任虛線、
 *   手機版（時序清單）新到舊且與桌機同資料（id 集合相同）、折疊與 60 筆收合。
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { buildGraph } from './lineage-graph.ts'
import { ALL_PLACES, filterItemsByPlace, groupItemsByYear, placeChips } from './lineage-graph-list.ts'
import { FOLDED_LANE_KEY, OTHER_LANE_KEY, type GraphInput, type GraphTermRow } from './lineage-graph-types.ts'
import { PAGE_LABELS as T } from './lineage-page-labels.ts'
import type { LineageEvent, LineageHandover, LineageStance, Policy } from '../types.ts'

const TODAY = '2026-11-20'
const term = (pid: string, office: string, region: string | null, start: string, end: string | null, extra: Partial<GraphTermRow> = {}): GraphTermRow => ({
  politicianId: pid, name: `人${pid}`, electionType: office, region, subRegion: null, startDate: start, scheduledEndDate: null, endDate: end, involved: true, ...extra,
})
const stance = (id: string, pid: string, on: string, kind: LineageStance['stance'] = 'support'): LineageStance => ({
  id, politicianId: pid, name: `人${pid}`, stance: kind, condition: null, statedOn: on, datePrecision: 'day', quote: '原文', note: null, disputed: false,
  sourceUrl: 'https://a.tw', sourceLocator: 'p.1', source: null,
})
const event = (id: string, on: string, initiator: string | null = null): LineageEvent => ({
  id, eventType: 'approved', occurredOn: on, datePrecision: 'day', level: 'county', region: '台中市', subRegion: null, decidedBy: '市議會', description: '三讀',
  initiator: initiator ? { politicianId: initiator, name: `人${initiator}`, note: '提案人' } : null, disputed: false, sourceUrl: 'https://a.tw', sourceLocator: 'p', source: null,
})
const handover = (id: string, from: string, to: string, on: string | null = '2023-01-10'): LineageHandover => ({
  id, fromPoliticianId: from, fromName: `人${from}`, fromElectionId: null, toPoliticianId: to, toName: `人${to}`, toElectionId: null, handoverType: 'shrink', decidedOn: on,
  note: '縮小規模', sourceUrl: 'https://a.tw', sourceLocator: 'p', source: null,
})
const policy = (id: string, pid: string, date: string | null, electionId = 2022, status = 'In Progress'): Policy => ({
  id, politicianId: pid, electionId, title: `政見${id}`, description: '', category: '交通建設', status: status as Policy['status'], proposedDate: date,
  lastUpdated: '2026-01-01', progress: 0, tags: [], logs: [], stanceSupport: 0, stanceOppose: 0, stancePriority: 0,
})

function input(over: Partial<GraphInput> & { terms: GraphTermRow[] }): GraphInput {
  return {
    lineage: { id: 'l1', title: '捷運', stances: [], events: [], handovers: [], policyIds: [], participants: [], ...(over.lineage ?? {}) },
    policies: [], electionDates: new Map([[2018, '2018-11-24'], [2022, '2022-11-26']]), nameOf: (id) => `人${id}`, today: TODAY, ...over,
  } as GraphInput
}

const BASE_TERMS = [
  term('m1', '縣市長', '台中市', '2018-12-25', '2022-12-24'),
  term('m2', '縣市長', '臺中市', '2022-12-25', null),
  term('c1', '縣市議員', '台中市', '2022-12-25', null),
  term('c2', '縣市議員', '台中市', '2022-12-25', null),
  term('n1', '立法委員', null, '2024-02-01', null),
  term('t1', '鄉鎮市長', '台中市', '2022-12-25', null, { subRegion: '大雅區' }),
]

Deno.test('泳道排序：中央 → 縣市 → 鄉鎮；同層首長先於民意代表；多席職位同泳道依人堆疊成列', () => {
  const g = buildGraph(input({ terms: BASE_TERMS, policies: [policy('p1', 'm2', '2023-01-01')] }))
  const keys = g.lanes.filter((l) => l.kind === 'position').map((l) => l.label.split('　')[0])
  assertEquals(keys, ['立法委員', '縣市長', '縣市議員', '鄉鎮市長'])
  const council = g.lanes.find((l) => l.label.startsWith('縣市議員'))!
  assertEquals(council.barRows, 2, '兩位議員各一列')
  const ys = g.bars.filter((b) => b.laneKey === council.key).map((b) => b.y)
  assertEquals(new Set(ys).size, 2)
  assertEquals(g.lanes.find((l) => l.label.startsWith('縣市長'))!.barRows, 1, '單席職位一條')
})

Deno.test('任期條不重疊：單席職位前一任的迄日超過後一任就任日，會被裁到前一天', () => {
  const g = buildGraph(input({
    terms: [term('a', '縣市長', '台中市', '2018-12-25', '2023-06-30'), term('b', '縣市長', '台中市', '2022-12-25', null)],
    policies: [policy('p', 'b', '2023-01-01')],
  }))
  const bars = g.bars.filter((b) => b.laneKey.startsWith('縣市長')).sort((x, y) => x.x - y.x)
  assertEquals(bars.length, 2)
  assert(bars[0].x + bars[0].w <= bars[1].x + 0.001, '前一條的右緣不得超過後一條的左緣')
  assertEquals(bars[0].end, '2022-12-24')
  assertEquals(bars.map((b) => b.status), ['past', 'current'])
})

Deno.test('立場落在表態當天他的任期所屬泳道；對不到任期落「其他（身分待查）」最下一條', () => {
  const g = buildGraph(input({
    terms: BASE_TERMS,
    lineage: { id: 'l1', title: '捷運', stances: [stance('s1', 'm1', '2020-05-01'), stance('s2', 'm1', '2025-05-01'), stance('s3', 'ghost', '2024-01-01')], events: [], handovers: [], policyIds: [], participants: [] },
  }))
  const lane = (id: string) => g.marks.find((m) => m.id === id)!.laneKey
  assert(lane('stance:s1').startsWith('縣市長'), '任內的表態落在縣市長泳道')
  assertEquals(lane('stance:s2'), OTHER_LANE_KEY, '卸任後的表態對不到任期')
  assertEquals(lane('stance:s3'), OTHER_LANE_KEY)
  assertEquals(g.lanes[g.lanes.length - 1].key, OTHER_LANE_KEY)
  assertEquals(g.lanes[g.lanes.length - 1].label, T.otherIdentity)
})

Deno.test('交接：每個單席職位的相鄰兩任各一條交接線；有紀錄標型態、單席有後任沒紀錄標「尚未記錄」', () => {
  const g = buildGraph(input({
    terms: [
      term('m1', '縣市長', '台中市', '2018-12-25', '2022-12-24'), term('m2', '縣市長', '台中市', '2022-12-25', null),
      term('t1', '鄉鎮市長', '台中市', '2018-12-25', '2022-12-24', { subRegion: '大雅區' }), term('t2', '鄉鎮市長', '台中市', '2022-12-25', null, { subRegion: '大雅區' }),
    ],
    policies: [policy('p', 'm1', '2019-01-01'), policy('q', 't2', '2023-01-01')],
    lineage: { id: 'l1', title: '捷運', stances: [], events: [], handovers: [handover('h1', 'm1', 'm2')], policyIds: [], participants: [] },
  }))
  const hand = g.marks.filter((m) => m.kind === 'handover' || m.kind === 'gap')
  assertEquals(hand.length, 2, '兩個職位各一條')
  const rec = hand.find((m) => m.kind === 'handover')!
  assertEquals([rec.label, rec.tone], ['縮小', 'shrink'])
  const gap = hand.find((m) => m.kind === 'gap')!
  assertEquals(gap.label, T.handoverUnrecorded)
  assert(rec.laneKey !== gap.laneKey, '並排在各自的職位泳道')
})

Deno.test('交接紀錄對不到相鄰兩任（人不在任期表）也不消失：落在後任泳道或「其他」', () => {
  const g = buildGraph(input({
    terms: [term('m2', '縣市長', '台中市', '2022-12-25', null)],
    policies: [policy('p', 'm2', '2023-01-01')],
    lineage: { id: 'l1', title: '捷運', stances: [], events: [], handovers: [handover('h9', 'x', 'y')], policyIds: [], participants: [] },
  }))
  assert(g.marks.some((m) => m.id === 'handover:h9'))
  assertEquals(g.marks.find((m) => m.id === 'handover:h9')!.laneKey, OTHER_LANE_KEY)
})

Deno.test('下一任：選舉還沒開票、現任預定卸任晚於投票日 → 虛線框「11/28 開票後」；沒有選舉日或已開票就不畫', () => {
  const t = [term('m2', '縣市長', '台中市', '2022-12-25', null)]
  const withNext = buildGraph(input({ terms: t, policies: [policy('p', 'm2', '2023-01-01')], upcomingElectionDate: '2026-11-28' }))
  const dashed = withNext.bars.filter((b) => b.status === 'next')
  assertEquals(dashed.length, 1)
  assertEquals(dashed[0].caption, `11/28 ${T.afterVote}`)
  assertEquals(dashed[0].end, null)
  assert(dashed[0].x > withNext.bars.find((b) => b.status === 'current')!.x)
  assertEquals(buildGraph(input({ terms: t, policies: [policy('p', 'm2', '2023-01-01')] })).bars.filter((b) => b.status === 'next').length, 0)
  assertEquals(buildGraph(input({ terms: t, policies: [policy('p', 'm2', '2023-01-01')], upcomingElectionDate: '2026-11-19' })).bars.filter((b) => b.status === 'next').length, 0)
})

Deno.test('事件：獨立泳道；有推動者就畫虛線箭頭從那個人的泳道到事件；沒有就沒有箭頭', () => {
  const g = buildGraph(input({
    terms: BASE_TERMS,
    lineage: { id: 'l1', title: '捷運', stances: [], events: [event('e1', '2024-05-01', 'c1'), event('e2', '2025-05-01')], handovers: [], policyIds: [], participants: [] },
  }))
  assertEquals(g.lanes[0].kind, 'events')
  assertEquals(g.arrows.length, 1)
  assertEquals(g.arrows[0].eventId, 'event:e1')
  assertEquals(g.arrows[0].note, '提案人')
  assert(g.arrows[0].y1 > g.arrows[0].y2, '箭頭從下面的職位泳道指向上面的事件泳道')
})

Deno.test('政見點：放在提出日，沒有就用屆別投票日；都沒有的不畫、但清單保留；顏色鍵照進度', () => {
  const g = buildGraph(input({
    terms: BASE_TERMS,
    policies: [policy('a', 'm2', '2023-03-01', 2022, 'Achieved'), policy('b', 'm2', null, 2022, 'Failed'), policy('c', 'm2', null, 9999, 'Stalled')],
  }))
  assertEquals(g.marks.find((m) => m.id === 'policy:a')!.tone, 'achieved')
  assertEquals(g.marks.find((m) => m.id === 'policy:b')!.date, '2022-11-26')
  assertEquals(g.marks.find((m) => m.id === 'policy:b')!.tone, 'failed')
  assert(!g.marks.some((m) => m.id === 'policy:c'))
  assert(g.items.some((i) => i.id === 'policy:c' && i.date === null))
})

Deno.test('時間軸：每兩年一格、有「今天」線、手機清單新到舊依年分組', () => {
  const g = buildGraph(input({
    terms: BASE_TERMS,
    lineage: { id: 'l1', title: '捷運', stances: [stance('s1', 'm2', '2023-01-01'), stance('s2', 'm2', '2025-06-01')], events: [event('e1', '2024-05-01')], handovers: [], policyIds: [], participants: [] },
  }))
  assert(g.ticks.length >= 3 && g.ticks.every((t) => Number(t.label) % 2 === 0))
  assert(g.todayX !== null && g.todayX > g.labelWidth)
  const groups = groupItemsByYear(g.items)
  assertEquals(groups.map((x) => x.year), ['2025', '2024', '2023'])
  assertEquals(groups[0].items[0].id, 'stance:s2')
})

Deno.test('桌機與手機吃同一份輸出：圖上的標籤與清單項目 id 集合完全相同（事件、立場、交接、尚未記錄、政見）', () => {
  const g = buildGraph(input({
    terms: BASE_TERMS,
    policies: [policy('p1', 'm2', '2023-01-01')],
    lineage: {
      id: 'l1', title: '捷運', stances: [stance('s1', 'm2', '2023-01-01'), stance('s3', 'ghost', '2024-01-01')], events: [event('e1', '2024-05-01', 'c1')],
      handovers: [handover('h1', 'm1', 'm2')], policyIds: ['p1'], participants: [],
    },
  }))
  const svgIds = [...g.marks.map((m) => m.id)].sort()
  const listIds = [...groupItemsByYear(filterItemsByPlace(g.items, ALL_PLACES)).flatMap((x) => x.items.map((i) => i.id))].sort()
  assertEquals(svgIds, listIds)
  for (const kind of ['event', 'stance', 'handover']) assert(svgIds.some((id) => id.startsWith(`${kind}:`)), `缺 ${kind}`)
  // 晶片篩選只是把清單切開，各地方加起來還是同一組
  const chips = placeChips(g.items)
  assertEquals(chips[0].key, ALL_PLACES)
  const union = chips.slice(1).flatMap((c) => filterItemsByPlace(g.items, c.key).map((i) => i.id)).sort()
  assertEquals(union, listIds)
})

Deno.test('折疊：超過 16 條泳道，其餘折成「另 N 個職位」，被折起來的標籤仍在（落在折疊泳道）；展開後全部回來', () => {
  const terms: GraphTermRow[] = []
  for (let i = 0; i < 20; i++) terms.push(term(`p${i}`, '縣市長', `地方${String(i).padStart(2, '0')}`, '2022-12-25', null))
  const policies = terms.map((t, i) => policy(`q${i}`, t.politicianId, '2023-01-01'))
  const folded = buildGraph(input({ terms, policies }))
  assertEquals(folded.lanes.filter((l) => l.kind === 'position').length, 16)
  assertEquals(folded.foldedLanes, 4)
  assert(folded.lanes.some((l) => l.key === FOLDED_LANE_KEY && l.label.includes('4')))
  assertEquals(folded.marks.length, 20)
  const open = buildGraph(input({ terms, policies, expandLanes: true }))
  assertEquals(open.lanes.filter((l) => l.kind === 'position').length, 20)
  assertEquals(open.foldedLanes, 0)
  assertEquals(open.marks.map((m) => m.id).sort(), folded.marks.map((m) => m.id).sort(), '折疊不影響標籤集合')
})

Deno.test('超過 60 筆立場預設只留最新 60 筆（桌機與清單同一份）；展開後全部', () => {
  const stances = Array.from({ length: 70 }, (_, i) => stance(`s${i}`, 'm2', `2023-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`))
  const base = input({ terms: BASE_TERMS, lineage: { id: 'l1', title: '捷運', stances, events: [], handovers: [], policyIds: [], participants: [] } })
  const cut = buildGraph(base)
  assertEquals(cut.marks.filter((m) => m.kind === 'stance').length, 60)
  assertEquals(cut.items.filter((i) => i.kind === 'stance').length, 60)
  assertEquals(cut.collapsed.stances, 10)
  const all = buildGraph({ ...base, expandOld: true })
  assertEquals(all.marks.filter((m) => m.kind === 'stance').length, 70)
  assertEquals(all.collapsed.stances, 0)
})

Deno.test('空脈絡（沒任期、沒標籤）不炸：empty 為真', () => {
  const g = buildGraph(input({ terms: [] }))
  assertEquals([g.empty, g.lanes.length, g.marks.length], [true, 0, 0])
  assert(g.width >= 640)
})

Deno.test('一般規模的 SVG 節點數 < 300（泳道、任期條、標籤、箭頭、刻度加起來）', () => {
  const g = buildGraph(input({
    terms: BASE_TERMS,
    policies: [policy('p1', 'm2', '2023-01-01')],
    lineage: { id: 'l1', title: '捷運', stances: [stance('s1', 'm2', '2023-01-01')], events: [event('e1', '2024-05-01', 'c1')], handovers: [handover('h1', 'm1', 'm2')], policyIds: [], participants: [] },
  }))
  assert(g.lanes.length + g.bars.length + g.marks.length * 3 + g.arrows.length + g.ticks.length * 2 < 300)
})
