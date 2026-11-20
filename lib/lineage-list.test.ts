/**
 * 脈絡一覽（/analysis，#675 第四期、計畫書 5.4）與關係圖任期原料的守門測試。
 *   一覽讀 lineages_list（缺它退回 lineages_full 不炸）、卡片帶現況階段標籤與「政見／事件／立場」筆數、
 *   縣市篩選＝主辦是中央、主辦在該縣市、或涵蓋該縣市；空脈絡不列；lineage_terms 的列對應正確。
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { filterLineages, isLineageListed, lineageToListItem, lineageTotal, mapLineage, mapLineageListRow } from './lineage.ts'
import { mapTermRows } from './lineage-graph-terms.ts'
import type { LineageListItem, RawLineage, RawLineageListRow } from '../types.ts'

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url)).then((s) => s.replace(/\r\n/g, '\n'))

const ROW: RawLineageListRow = {
  id: 'l1', title: '台中捷運藍線', level: 'county', region: '台中市', sub_region: null, category: '交通建設', summary: '一句',
  policy_count: 3, people_count: 5, handover_count: 1, event_count: 2, stance_count: 4,
  coverage: [{ level: 'county', region: '台中市', policy_count: 2 }, { level: 'county', region: '彰化縣', policy_count: 1 }, { level: 'bogus', region: 'x' }],
  status_phase: 'approved', status_as_of: '2026-11-01T00:00:00Z',
}

Deno.test('lineages_list 一列 → 卡片：筆數、涵蓋地方、現況階段；認不得的涵蓋層級丟掉；缺欄當 0 或空', () => {
  const c = mapLineageListRow(ROW)!
  assertEquals([c.policyCount, c.peopleCount, c.handoverCount, c.eventCount, c.stanceCount], [3, 5, 1, 2, 4])
  assertEquals(c.coverage.map((x) => x.region), ['台中市', '彰化縣'])
  assertEquals([c.statusPhase, c.statusAsOf], ['approved', '2026-11-01'])
  const bare = mapLineageListRow({ id: 'o', title: '舊', level: 'national' })!
  assertEquals([bare.policyCount, bare.eventCount, bare.stanceCount, bare.coverage, bare.statusPhase], [0, 0, 0, [], null])
  assertEquals(mapLineageListRow({ id: 'x', title: 't', level: 'weird' }), null)
})

Deno.test('預渲染快照的整列脈絡也能轉成卡片（lineageToListItem）：筆數與現況階段一致', () => {
  const raw: RawLineage = {
    id: 'l2', title: '甲', level: 'county', region: '台中市', policy_ids: ['p1', 'p2'], participants: [], handovers: [], links: [],
    stances: [{ id: 's', politician_id: 'x', stance: 'support', stated_on: '2024-01-01', quote: 'q', source_url: 'https://a.tw', source_locator: 'p' }],
    events: [], status: { phase: 'planning', text: '規劃', as_of: '2026-10-01', source_url: 'https://a.tw' },
  }
  const c = lineageToListItem(mapLineage(raw)!)
  assertEquals([c.policyCount, c.stanceCount, c.eventCount, c.statusPhase, c.statusAsOf], [2, 1, 0, 'planning', '2026-10-01'])
})

Deno.test('空脈絡（合格政見 0 條）不列：卡片以 policyCount 判斷，整列脈絡以 policyIds 判斷', () => {
  assertEquals(isLineageListed({ policyCount: 0 }), false)
  assertEquals(isLineageListed({ policyCount: 2 }), true)
  assertEquals(isLineageListed({ policyIds: [] }), false)
  assertEquals(isLineageListed({}), true, '舊視圖沒有這一欄＝不濾')
})

const card = (id: string, level: LineageListItem['level'], region: string | null, coverage: string[] = [], category = '交通建設'): LineageListItem => ({
  id, title: id, level, region, subRegion: null, category, summary: null, policyCount: 1, peopleCount: 0, handoverCount: 0, eventCount: 0, stanceCount: 0,
  coverage: coverage.map((r) => ({ level: 'county' as const, region: r, subRegion: null, policyCount: 1 })), statusPhase: null, statusAsOf: null,
})

Deno.test('縣市篩選：主辦是中央、或涵蓋該縣市的都列（台／臺同一個）；主辦就在該縣市當然列；都不是就不列', () => {
  const list = [
    card('nat', 'national', null), card('host', 'county', '台中市'), card('cover', 'county', '彰化縣', ['臺中市']), card('other', 'county', '高雄市', ['屏東縣']),
  ]
  assertEquals(filterLineages(list, { region: '台中市' }).map((l) => l.id), ['nat', 'host', 'cover'])
  assertEquals(filterLineages(list, { region: '屏東縣' }).map((l) => l.id), ['nat', 'other'])
  assertEquals(filterLineages(list, { region: 'All' }).length, 4)
  assertEquals(lineageTotal(list, '台中市'), 3, '格子上的數字與清單同一套規則')
  assertEquals(filterLineages(list, { region: '台中市', category: '社會福利' }).length, 0)
})

Deno.test('一覽頁：讀 lineages_list、缺視圖退回 lineages_full、卡片有現況階段標籤與政見／事件／立場筆數；有快照就不重撈', async () => {
  const sb = await read('../composables/useSupabase.ts')
  assert(sb.includes("fetchAllRows<RawLineageListRow>('lineages_list', '*', 'id')"), '一覽讀 lineages_list')
  const fn = sb.slice(sb.indexOf('export function ensureLineageList'))
  assert(/isMissingRelation\(err\)\) throw err/.test(fn) && fn.includes("fetchAllRows<RawLineage>('lineages_full'"), 'lineages_list 缺時退回舊視圖，不炸')
  assert(fn.includes('lineagesComplete.value) return Promise.resolve()'), '預渲染快照已帶整列時不重撈')
  const page = await read('../pages/PolicyAnalysis.vue')
  assert(page.includes('ensureLineageList()'))
  assert(page.includes('statusPhaseLabel(l.statusPhase)') && page.includes('data-testid="lineage-card-phase"'), '現況階段標籤')
  for (const w of ['政見 {{ l.policyCount }} 條', '事件 {{ l.eventCount }} 筆', '立場 {{ l.stanceCount }} 筆']) assert(page.includes(w), `卡片要有「${w}」`)
})

Deno.test('lineage_terms 的列 → 任期原料：缺人或缺職位丟掉；involved 缺值當 true；視圖沒回列就是空陣列', () => {
  const rows = mapTermRows([
    { politician_id: 'a', name: '甲', election_type: '縣市長', region: '台中市', sub_region: null, start_date: '2022-12-25', scheduled_end_date: '2026-12-24', end_date: null, involved: true },
    { politician_id: 'b', election_type: '縣市議員', start_date: '2022-12-25', involved: false },
    { name: '沒有人' },
    { politician_id: 'c' },
  ])
  assertEquals(rows.map((r) => [r.politicianId, r.electionType, r.involved, r.endDate]), [['a', '縣市長', true, null], ['b', '縣市議員', false, null]])
  assertEquals(mapTermRows(undefined), [])
  assertEquals(mapTermRows(null), [])
})
