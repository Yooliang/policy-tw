/**
 * 政策脈絡（#349）畫面規則的守門測試。
 *   1. 中文標籤跟後端（supabase/functions/_shared/lineage.ts）同一份——交件端講「共同提案」、畫面也要是「共同提案」
 *   2. 時間軸：一任一任照投票日排，交接放在後任前面；後任在脈絡裡沒有政見（例：停掉了）的交接也不能消失
 *   3. 參與者：官方紀錄的角色排前面，本人宣稱另外標、不當作官方角色；只提了政見的標「政見提出者」；不看黨派與政見數
 *   4. 收錄：脈絡頁走 Worker 邊緣渲染、進網站地圖、web.app 回殼檔（不 404）
 *   5. 交接區與「還沒有角色」只在派工同一個條件成立時才出現（#670）：首長那一屆當選且已卸任才該有交接；當過民意代表才有官方角色可查
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  BASIS_LABEL, buildTimeline, filterLineages, HANDOVER_LABEL, hasBeenRepresentative, isLineageListed, isRetiredExecutive, LEVEL_LABEL, LINK_LABEL, lineagePlace,
  mapLineage, mapLineageSummary, needsHandoverRecord, officeTermEnd, ORIGIN_LABEL, participantRows, policyMeta, ROLE_LABEL, termRoleLabel,
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
  const person = { elections: [{ electionId: 2022, electionType: '縣市長', candidacyStatus: 'elected' }, { electionId: 2026, electionType: '縣市長' }], offices: [] }
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

Deno.test('空脈絡（政見都被拿掉了，2026-10-19）：不列在一覽與網站地圖，頁面本身仍可開（只標 noindex，由 LineagePage 讀這支）', () => {
  const withPolicy = { ...L('a', 'county', '台中市'), policyIds: ['p1'] }
  assertEquals(isLineageListed(withPolicy), true)
  assertEquals(isLineageListed(L('b', 'county', '台中市')), false, 'policyIds 空陣列＝空脈絡')
  assertEquals(isLineageListed({ policyIds: undefined }), true, '沒給＝不知道，當成有')
  assertEquals([withPolicy, L('b', 'county', '台中市')].filter(isLineageListed).map((l) => l.id), ['a'])
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

// ── 交接區與「還沒有角色」什麼時候出現（#670）──────────────────────────────

const TODAY = '2026-10-19'
const DAYS = new Map([[2018, '2018-11-24'], [2022, '2022-11-26'], [2024, '2024-01-13'], [2026, '2026-11-28']])
const who = (...elections: Array<{ electionId: number; electionType: string; candidacyStatus: string; electionDate?: string }>) => ({ elections })

Deno.test('卸任日：任期四年，地方 12/24、立委 1/31、總統副總統 5/19（跟資料庫 office_term_end 同一個算法）', () => {
  assertEquals(officeTermEnd(2022, '縣市長'), '2026-12-24')
  assertEquals(officeTermEnd(2018, '鄉鎮市長'), '2022-12-24')
  assertEquals(officeTermEnd(2024, '立法委員'), '2028-01-31')
  assertEquals(officeTermEnd(2024, '總統副總統'), '2028-05-19')
})

Deno.test('交接區：只有首長那一屆當選、而且那一任已卸任才成立（跟派 handover_missing 同一個條件）', () => {
  const mayor = (electionId: number, status: string, type = '縣市長') => who({ electionId, electionType: type, candidacyStatus: status })
  const polis = (politicianId: string, electionId: number) => [pol('p', politicianId, electionId)]
  const need = (people: Record<string, ReturnType<typeof who>>, policies: Policy[], today = TODAY) =>
    needsHandoverRecord(policies, (id) => people[id], DAYS, today)

  // 事件原樣：兩位 2026 候選人的承諾（還沒投票、沒當選）→ 不成立
  assertEquals(need({ a: mayor(2026, 'filed'), b: mayor(2026, 'declared') }, [pol('p1', 'a', 2026), pol('p2', 'b', 2026)]), false, '選前候選人沒有「前後任」')
  // 2018 當選的縣市長，2022-12-24 卸任 → 成立
  assertEquals(need({ a: mayor(2018, 'elected') }, polis('a', 2018)), true)
  assertEquals(need({ a: mayor(2018, 'elected', '鄉鎮市長') }, polis('a', 2018)), true, '鄉鎮市長也算')
  assertEquals(need({ a: mayor(2018, 'elected', '直轄市山地原住民區長') }, polis('a', 2018)), true, '區長也算')
  // 2022 當選的縣市長 2026-12-24 才卸任：今天還在任 → 不成立；卸任日當天仍在任、隔天才成立
  assertEquals(need({ a: mayor(2022, 'elected') }, polis('a', 2022)), false, '還在任的首長')
  assertEquals(need({ a: mayor(2022, 'elected') }, polis('a', 2022), '2026-12-24'), false, '卸任日當天還是他')
  assertEquals(need({ a: mayor(2022, 'elected') }, polis('a', 2022), '2026-12-25'), true)
  // 當選但不是首長（議員、立委）：派的是 lineage_roles 不是交接
  assertEquals(need({ a: mayor(2018, 'elected', '縣市議員') }, polis('a', 2018)), false)
  assertEquals(need({ a: mayor(2018, 'elected', '立法委員') }, polis('a', 2018)), false)
  // 落選、退選不算當選（不看現在在不在任，只看那一屆有沒有當選）
  assertEquals(need({ a: mayor(2018, 'not_elected') }, polis('a', 2018)), false)
  assertEquals(need({ a: mayor(2018, 'withdrawn') }, polis('a', 2018)), false)
  // 政見要掛在他當選的那一屆：2018 當選、政見掛 2022（那屆他沒當選）→ 不成立
  assertEquals(need({ a: mayor(2018, 'elected') }, polis('a', 2022)), false)
  assertEquals(need({ a: mayor(2018, 'elected') }, [{ ...pol('p', 'a', 2018), electionId: undefined }]), false, '政見沒有屆別')
  // 人物還沒載入、或沒有任何政見
  assertEquals(need({}, polis('a', 2018)), false)
  assertEquals(need({ a: mayor(2018, 'elected') }, []), false)
  // 脈絡裡只要有一條成立就成立（同一條脈絡混了候選人與卸任首長）
  assertEquals(need({ a: mayor(2026, 'filed'), b: mayor(2018, 'elected') }, [pol('p1', 'a', 2026), pol('p2', 'b', 2018)]), true)
})

Deno.test('交接區：投票日用屆別表、沒有就退回參選紀錄帶的投票日；兩邊都沒有就不成立（不猜）', () => {
  const rec = { electionId: 2018, electionType: '縣市長', candidacyStatus: 'elected' }
  assertEquals(isRetiredExecutive(who({ ...rec, electionDate: '2018-11-24' }), 2018, new Map(), TODAY), true)
  assertEquals(isRetiredExecutive(who(rec), 2018, new Map(), TODAY), false)
  assertEquals(isRetiredExecutive(who(rec), null, DAYS, TODAY), false)
  assertEquals(isRetiredExecutive(undefined, 2018, DAYS, TODAY), false)
})

Deno.test('民意代表：任何一屆當選、投票日已過的立委、議員、代表才算；首長、候選人、還沒投票的不算', () => {
  const rep = (type: string, status = 'elected', electionId = 2022) => who({ electionId, electionType: type, candidacyStatus: status })
  for (const type of ['立法委員', '縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表']) {
    assertEquals(hasBeenRepresentative(rep(type), DAYS, TODAY), true, `${type} 當選`)
  }
  assertEquals(hasBeenRepresentative(rep('縣市議員', 'elected', 2018), DAYS, TODAY), true, '前任也算，不限現任')
  assertEquals(hasBeenRepresentative(rep('縣市長'), DAYS, TODAY), false, '首長沒有議事紀錄可查')
  assertEquals(hasBeenRepresentative(rep('縣市議員', 'filed', 2026), DAYS, TODAY), false, '候選人')
  assertEquals(hasBeenRepresentative(rep('縣市議員', 'elected', 2026), DAYS, TODAY), false, '投票日還沒到（標了當選也不算）')
  assertEquals(hasBeenRepresentative(rep('縣市議員', 'not_elected'), DAYS, TODAY), false, '落選')
  assertEquals(hasBeenRepresentative(rep('縣市議員', 'elected', 1999), DAYS, TODAY), false, '查不到投票日不猜')
  assertEquals(hasBeenRepresentative(undefined, DAYS, TODAY), false)
  const won = (electionType: string) => ({ electionId: 2022, electionType, candidacyStatus: 'elected' })
  assertEquals(hasBeenRepresentative(who(won('縣市長'), won('縣市議員')), DAYS, TODAY), true, '多筆參選紀錄只要有一筆符合')
})

Deno.test('參與者：每一列帶 representative 旗標（頁面只對民意代表講「還沒有官方紀錄的角色」）', () => {
  const nameOf = (id: string) => ({ a: '甲', b: '乙' } as Record<string, string | undefined>)[id]
  const rows = participantRows([], [pol('p1', 'a', 2022), pol('p2', 'b', 2022)], nameOf, (id) => id === 'a')
  assertEquals(Object.fromEntries(rows.map((r) => [r.name, r.representative])), { 甲: true, 乙: false })
  assertEquals(participantRows([], [pol('p1', 'a', 2022)], nameOf)[0].representative, false, '沒給判斷函式一律不是（不替人多講一句沒查證的）')
})

Deno.test('脈絡頁：交接標題與「還沒有交接紀錄」掛在交接區條件上、「還沒有官方紀錄的角色」只對民意代表', async () => {
  const page = (await Deno.readTextFile(new URL('../pages/LineagePage.vue', import.meta.url))).replace(/\r\n/g, '\n')
  assert(/<h2 v-if="showHandovers"[^\n]*前後任怎麼交接/.test(page), '「前後任怎麼交接」標題只在交接區成立時才出現')
  assert(/<p v-if="showHandovers && lineage\.handovers\.length === 0"[^>]*>\s*還沒有交接紀錄/.test(page), '「還沒有交接紀錄」不能無條件顯示')
  assert(/<span v-if="row\.representative"[^>]*>還沒有官方紀錄的角色/.test(page), '「還沒有官方紀錄的角色」只對民意代表')
  assert(/needsHandoverRecord\(/.test(page) && /hasBeenRepresentative\(/.test(page), '頁面要用 lib/lineage.ts 的判斷，不是自己另寫一份')
  assertEquals(page.split('前後任怎麼交接').length - 1, 1, '交接標題只能出現一次')
})

Deno.test('別處不預設脈絡有交接：政見頁的脈絡卡不寫交接說明、脈絡一覽 0 筆交接不顯示', async () => {
  const read = async (path: string) => (await Deno.readTextFile(new URL(path, import.meta.url))).replace(/\r\n/g, '\n')
  const card = await read('../components/PolicyLineageCard.vue')
  assert(!card.includes('前後任怎麼交接') && !card.includes('都在脈絡頁'), '脈絡卡不放解釋文字（也不能預設有前後任交接）')
  const list = await read('../pages/PolicyAnalysis.vue')
  assert(/<span v-if="lineageCounts\(l\)\.handovers > 0">交接 \{\{ lineageCounts\(l\)\.handovers \}\} 筆<\/span>/.test(list), '脈絡一覽的「交接 N 筆」0 筆時不顯示')
})
