/**
 * 政策脈絡（#349）畫面規則的守門測試。
 *   1. 中文標籤跟後端（supabase/functions/_shared/lineage.ts）同一份——交件端講「共同提案」、畫面也要是「共同提案」
 *   2. 時間軸：一任一任照投票日排，交接放在後任前面；後任在脈絡裡沒有政見（例：停掉了）的交接也不能消失
 *   3. 參與者：官方紀錄的角色排前面，本人宣稱另外標、不當作官方角色；只提了政見的標「政見提出者」；不看黨派與政見數
 *   4. 收錄：脈絡頁走 Worker 邊緣渲染、進網站地圖、web.app 回殼檔（不 404）
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  BASIS_LABEL, buildTimeline, filterLineages, HANDOVER_LABEL, LEVEL_LABEL, LINK_LABEL, lineagePlace, mapLineage, mapLineageSummary,
  ORIGIN_LABEL, participantRows, policyMeta, ROLE_LABEL, termRoleLabel,
} from './lineage.ts'
import * as shared from '../supabase/functions/_shared/lineage.ts'
import type { Lineage, LineageHandover, LineageParticipant, Policy, RawLineage } from '../types.ts'

Deno.test('脈絡標籤：層級、角色、依據、交接型態、關聯型態、政見來源跟後端同一份', () => {
  assertEquals({ ...LEVEL_LABEL }, { ...shared.LINEAGE_LEVEL_LABEL })
  assertEquals({ ...ROLE_LABEL }, { ...shared.PARTICIPANT_ROLE_LABEL })
  assertEquals({ ...BASIS_LABEL }, { ...shared.PARTICIPANT_BASIS_LABEL })
  assertEquals({ ...HANDOVER_LABEL }, { ...shared.HANDOVER_TYPE_LABEL })
  assertEquals({ ...LINK_LABEL }, { ...shared.LINK_TYPE_LABEL })
  assertEquals({ ...ORIGIN_LABEL }, { ...shared.POLICY_ORIGIN_LABEL })
  assertEquals(BASIS_LABEL.self_claim, '本人宣稱')
})

const RAW: RawLineage = {
  id: 'l1', title: '台中捷運藍線', level: 'county', region: '台中市', sub_region: null, category: '交通建設', summary: null,
  policy_ids: ['p1', 'p2'],
  participants: [
    { id: 'a', politician_id: 'x', name: '甲', role: 'co_proposer', basis: 'official_record', source_url: 'https://www.tccc.gov.tw/1', source_locator: '提案 1' },
    { id: 'b', politician_id: 'x', name: '甲', role: 'leader', basis: 'official_record', source_url: 'https://www.tccc.gov.tw/1', source_locator: '?' },
  ],
  handovers: [{ id: 'h', from_politician_id: 'x', to_politician_id: 'y', handover_type: 'cancel', note: '不認得的型態', source_url: 'https://a.tw', source_locator: 'x' }],
  links: [],
}

Deno.test('mapLineage：認不得的角色、交接型態丟掉（不讓它冒充值域裡的一個）；出處沒有詳情就用網址', () => {
  const l = mapLineage(RAW)!
  assertEquals(l.participants.map((p) => p.role), ['co_proposer'])
  assertEquals(l.handovers.length, 0)
  assertEquals(l.participants[0].source?.url, 'https://www.tccc.gov.tw/1')
  assertEquals(mapLineageSummary({ id: 'x', title: 'y', level: 'city' }), null, '層級不在值域就不是脈絡')
  assertEquals(mapLineageSummary(null), null)
})

const pol = (id: string, politicianId: string, electionId: number): Policy => ({
  id, politicianId, electionId, title: id, description: '', category: '交通建設', status: 'In Progress' as Policy['status'], proposedDate: null,
  lastUpdated: '2026-01-01', progress: 0, tags: [], logs: [], stanceSupport: 0, stanceOppose: 0, stancePriority: 0,
})
const ho = (id: string, from: string, to: string, toElectionId: number | null, decidedOn: string | null = null): LineageHandover => ({
  id, fromPoliticianId: from, fromName: from, fromElectionId: null, toPoliticianId: to, toName: to, toElectionId,
  handoverType: 'keep', decidedOn, note: '後任延續前任的計畫，見施政報告。', sourceUrl: 'https://x.gov.tw', sourceLocator: 'p.1', source: null,
})
const DATES = new Map([[2018, '2018-11-24'], [2022, '2022-11-26'], [2026, '2026-11-28']])

Deno.test('時間軸：一任一任照投票日排，同一任的政見併在一起；交接放在後任那一任前面', () => {
  const items = buildTimeline([pol('p3', 'C', 2026), pol('p1', 'A', 2018), pol('p2', 'B', 2022), pol('p4', 'B', 2022)], [ho('h1', 'A', 'B', 2022)], DATES)
  assertEquals(items.map((i) => (i.kind === 'term' ? `${i.politicianId}${i.year}` : `→${i.handover.toPoliticianId}`)), ['A2018', '→B', 'B2022', 'C2026'])
  const b = items.find((i) => i.kind === 'term' && i.politicianId === 'B')
  assertEquals(b && b.kind === 'term' ? b.policies.map((p) => p.id) : [], ['p2', 'p4'])
})

Deno.test('時間軸：後任在脈絡裡沒有政見（例：停掉了、自己沒提）的交接照日期放，不會消失', () => {
  const items = buildTimeline([pol('p1', 'A', 2018), pol('p3', 'C', 2026)], [ho('h1', 'A', 'B', 2022)], DATES)
  assertEquals(items.map((i) => (i.kind === 'term' ? i.politicianId : `→${i.handover.toPoliticianId}`)), ['A', '→B', 'C'], '2022 的交接排在 2026 那一任前面')
  const late = buildTimeline([pol('p1', 'A', 2018)], [ho('h9', 'A', 'Z', null, null)], DATES)
  assertEquals(late.map((i) => i.kind), ['term', 'handover'], '沒有日期的交接排在最後，但要在')
})

const part = (pid: string, name: string, role: LineageParticipant['role'], basis: LineageParticipant['basis']): LineageParticipant => ({
  id: `${pid}-${basis}`, politicianId: pid, name, role, basis, sourceUrl: 'https://lis.ly.gov.tw/x', sourceLocator: '議案', note: null, source: null,
})

Deno.test('參與者：官方角色照 提案 → 共同提案 → 連署 → 主張推動；本人宣稱另外標；只提了政見的排最後，標政見提出者', () => {
  const rows = participantRows(
    [part('c', '丙', 'cosigner', 'official_record'), part('a', '甲', 'co_proposer', 'official_record'), part('a', '甲', 'proposer', 'self_claim'), part('d', '丁', 'proposer', 'self_claim'), part('b', '乙', 'proposer', 'official_record')],
    [pol('p1', 'e', 2024), pol('p2', 'e', 2024), pol('p3', 'a', 2024)],
    (id) => ({ e: '戊' } as Record<string, string>)[id],
  )
  assertEquals(rows.map((r) => r.name), ['乙', '甲', '丙', '丁', '戊'])
  const jia = rows.find((r) => r.name === '甲')!
  assertEquals([jia.official?.role, jia.claim?.role], ['co_proposer', 'proposer'], '本人說是提案、官方紀錄是共同提案：兩個都留，官方的那個才是角色')
  const wu = rows.find((r) => r.name === '戊')!
  assertEquals([wu.official, wu.claim, wu.policyCount], [null, null, 2], '只提了政見的人沒有角色')
  const ding = rows.find((r) => r.name === '丁')!
  assertEquals(ding.official, null, '只有本人宣稱的人沒有官方角色，排在有官方角色的後面')
})

Deno.test('時間軸的職位：當選才寫職位，沒當選或還沒投票寫「參選人」（職稱只能從當選來）；競選承諾不重複印', () => {
  const person = { elections: [{ electionId: 2022, electionType: '縣市長', electionResult: 'elected' }, { electionId: 2026, electionType: '縣市長' }], offices: [] }
  assertEquals(termRoleLabel(person, 2022), '縣市長')
  assertEquals(termRoleLabel(person, 2026), '縣市長參選人')
  assertEquals(termRoleLabel({ elections: [{ electionId: 2022, electionType: '縣市議員' }], offices: [{ electionId: 2022 }] }, 2022), '縣市議員', '參選紀錄沒標當選、但現任公職就是那一屆，也算當選')
  assertEquals(termRoleLabel(undefined, 2022), '')
  const label = (s: string) => ({ 'Campaign Pledge': '競選承諾', 'In Progress': '進行中' } as Record<string, string>)[s] ?? s
  assertEquals(policyMeta({ origin: 'pledge', status: 'Campaign Pledge' as Policy['status'] }, label), '競選承諾')
  assertEquals(policyMeta({ origin: 'pledge', status: 'In Progress' as Policy['status'] }, label), '競選承諾・進行中')
  assertEquals(policyMeta({ origin: null, status: 'In Progress' as Policy['status'] }, label), '進行中')
})

const L = (id: string, level: Lineage['level'], region: string | null, category = '交通建設', title = id): Lineage => ({
  id, title, level, region, subRegion: null, category, summary: null, policyIds: [], participants: [], handovers: [], links: [],
})

Deno.test('脈絡一覽篩選：中央層級在每個縣市都列；台／臺 算同一個縣市；分類與關鍵字', () => {
  const list = [L('n', 'national', null), L('t', 'county', '臺中市'), L('k', 'county', '高雄市', '社會福利', '高雄托育')]
  assertEquals(filterLineages(list, { region: '台中市' }).map((l) => l.id), ['n', 't'])
  assertEquals(filterLineages(list, { region: 'All', category: '社會福利' }).map((l) => l.id), ['k'])
  assertEquals(filterLineages(list, { q: '托育' }).map((l) => l.id), ['k'])
  assertEquals(lineagePlace({ level: 'township', region: '台中市', subRegion: '大雅區' }), '台中市大雅區')
  assertEquals(lineagePlace({ level: 'national', region: null, subRegion: null }), '全國')
})

Deno.test('收錄：脈絡頁由正見.tw 的 Worker 邊緣渲染、進網站地圖；web.app 回殼檔不 404；路由在', async () => {
  const worker = await Deno.readTextFile(new URL('../cloudflare/ssr-worker.js', import.meta.url))
  const routes = worker.match(/const SSR_ROUTES = \[([^\n]*)\]/)![1]
  assert(routes.includes('lineage'), 'SSR_ROUTES 要有 /lineage/')
  const firebase = JSON.parse(await Deno.readTextFile(new URL('../firebase.json', import.meta.url)))
  assert(firebase.hosting.rewrites.some((r: { source?: string; destination: string }) => r.source === '/lineage/**' && r.destination === '/app.html'), 'web.app 的 /lineage/** 要回殼檔（200＋noindex），不能 404')
  const server = await Deno.readTextFile(new URL('./ssg/server-data.ts', import.meta.url))
  assert(server.includes('`/lineage/${l.id}`'), '脈絡頁要進網站地圖（邊緣渲染清單）')
  const loaders = await Deno.readTextFile(new URL('./ssr/loaders.ts', import.meta.url))
  assert(/case 'lineage': return await loadLineagePage/.test(loaders), 'Worker 的載入器要認得脈絡頁')
  const router = await Deno.readTextFile(new URL('../router/index.ts', import.meta.url))
  assert(router.includes("path: '/lineage/:lineageId'") && router.includes("name: 'lineage'"))
  const postbuild = await Deno.readTextFile(new URL('../scripts/postbuild-ssg.mjs', import.meta.url))
  assert(postbuild.includes("r.startsWith('/lineage/')"), '網站地圖要把 /lineage/ 分進一份（不然掉進 sitemap-pages）')
})
