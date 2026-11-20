/**
 * 政策脈絡主頁（#675 第三期）的守門測試。
 *   1. 白名單：lib/lineage-page-labels.ts 每個字串都是短標籤；LineagePage.vue 模板沒有任何靜態中文，用字都從白名單取
 *   2. 立場表：每人最新一筆、曾變、「提出政見」推導列不計入筆數且被正式表態取代、排序
 *   3. 下架不顯示、有爭議帶標示；舊視圖缺欄不炸；空脈絡不報錯
 *   4. 承諾不進政見清單；主頁沒有指向 /graph 的連結、每個站內連結都解析得到已註冊的路由
 *   5. 邊緣渲染與預渲染吃同一份資料（同一支 mapLineage、同一支 lineagePeople）
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { LABEL_MAX_LENGTH, PAGE_LABELS, STATUS_PHASE_LABEL } from './lineage-page-labels.ts'
import {
  buildChronicle, buildStanceRows, CHRONICLE_HEAD, coveragePlaces, formatStatedDate, lineagePeople, pageCounts, personLevel, statusHeadline, statusPhaseLabel,
} from './lineage-page.ts'
import { isLineageListed, mapLineage } from './lineage.ts'
import * as shared from '../supabase/functions/_shared/lineage.ts'
import type { Lineage, LineageEvent, LineageHandover, LineageStance, Policy, RawLineage } from '../types.ts'

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url)).then((s) => s.replace(/\r\n/g, '\n'))

// ── 1. 白名單 ──────────────────────────────────────────────────────────────

const SYSTEM_WORDS = ['表名', '臂', '派工', '起跑', '開發中', '尚未上線', '第三期', '第四期', 'lineage_', 'TDengine']

Deno.test('白名單：每個字串都是短標籤，沒有句號、沒有系統詞', () => {
  for (const [key, value] of Object.entries(PAGE_LABELS)) {
    assert(value.length > 0 && value.length <= LABEL_MAX_LENGTH, `${key}「${value}」超過 ${LABEL_MAX_LENGTH} 字，不是標籤了`)
    assert(!/[。！？；，,.!?;]/.test(value), `${key}「${value}」帶了句子的標點`)
    for (const w of SYSTEM_WORDS) assert(!value.includes(w), `${key}「${value}」出現系統詞 ${w}`)
  }
})

Deno.test('白名單：現況階段標籤跟後端同一份', () => {
  assertEquals({ ...STATUS_PHASE_LABEL }, { ...shared.STATUS_PHASE_LABEL })
})

async function templateOf(): Promise<string> {
  const page = await read('../pages/LineagePage.vue')
  const start = page.indexOf('<template>')
  assert(start > 0, '找不到模板')
  return page.slice(start)
}

Deno.test('模板：沒有任何靜態中文或英文字（多放一句說明就紅），用字全從白名單取', async () => {
  const tpl = await templateOf()
  const stripped = tpl.replace(/<!--[\s\S]*?-->/g, '').replace(/\{\{[\s\S]*?\}\}/g, '')
  // 標籤之間的文字節點
  const texts = [...stripped.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean)
  for (const t of texts) assert(!/[一-鿿A-Za-z]/.test(t), `模板有靜態文字：「${t}」，請放進 lib/lineage-page-labels.ts 再用 T.xxx`)
  // 屬性裡的靜態文字（aria-label、title、alt、placeholder）
  const attrs = [...stripped.matchAll(/\s(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map((m) => m[1])
  for (const a of attrs) assert(!/[一-鿿A-Za-z]/.test(a), `模板屬性有靜態文字：「${a}」`)
})

Deno.test('白名單裡的每個標籤都有被模板用到（不留沒人用的字）', async () => {
  const page = await read('../pages/LineagePage.vue')
  const source = await read('../components/LineageSourceLink.vue')
  for (const key of Object.keys(PAGE_LABELS)) {
    assert(new RegExp(`\\bT\\.${key}\\b`).test(page) || new RegExp(`\\bT\\.${key}\\b`).test(source), `標籤 ${key} 沒有任何地方用到`)
  }
})

// ── 4. 連結 ───────────────────────────────────────────────────────────────

Deno.test('主頁沒有任何指向 /graph 的連結（關係圖路由第四期才有）', async () => {
  const page = await read('../pages/LineagePage.vue')
  assert(!/graph/i.test(page.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), '第三期主頁不得有 graph 連結')
})

Deno.test('主頁的站內連結逐一解析：每一個都對到已註冊的路由，而且不是找不到頁', async () => {
  const tpl = await templateOf()
  const router = await read('../router/index.ts')
  const patterns = [...router.matchAll(/path: '([^']+)'/g)].map((m) => m[1]).filter((p) => !p.includes('pathMatch'))
    .map((p) => new RegExp(`^${p.replace(/:[A-Za-z]+\?/g, '(?:[^/]+)?').replace(/:[A-Za-z]+/g, '[^/]+')}$`))
  const targets = [...tpl.matchAll(/:?to="([^"]+)"/g)].map((m) => m[1])
  assert(targets.length >= 5, '應該抓得到站內連結')
  for (const raw of targets) {
    const path = raw.replace(/lineagePath\([^)]*\)/g, '`/lineage/x`').replace(/\$\{[^}]*\}/g, 'x').replace(/^[`'"]|[`'"]$/g, '')
    assert(path.startsWith('/'), `連結不是站內路徑：${raw}`)
    assert(patterns.some((re) => re.test(path)), `連結 ${raw}（${path}）對不到任何已註冊的路由`)
  }
})

// ── 資料與型別 ─────────────────────────────────────────────────────────────

const stance = (id: string, politicianId: string, kind: LineageStance['stance'], statedOn: string, extra: Partial<LineageStance> = {}): LineageStance => ({
  id, politicianId, name: politicianId, stance: kind, condition: null, statedOn, datePrecision: 'day', quote: '原文', note: null, disputed: false,
  sourceUrl: `https://x.gov.tw/${id}`, sourceLocator: 'p.1', source: null, ...extra,
})
const pol = (id: string, politicianId: string, electionId: number, proposedDate: string | null = null): Policy => ({
  id, politicianId, electionId, title: id, description: '', category: '交通建設', status: 'In Progress' as Policy['status'], proposedDate,
  lastUpdated: '2026-01-01', progress: 0, tags: [], logs: [], stanceSupport: 0, stanceOppose: 0, stancePriority: 0,
})
const person = (type: string, region = '台中市') => ({ region, elections: [{ electionId: 2022, electionType: type, candidacyStatus: 'elected', electionDate: '2022-11-26' }] })
const PEOPLE: Record<string, ReturnType<typeof person>> = {
  nat: person('立法委員', 'All'), cty: person('縣市長'), cty2: person('縣市長', '高雄市'), cty3: person('縣市議員'), twn: person('鄉鎮市長'),
}
const DATES = new Map([[2022, '2022-11-26']])
const rows = (stances: LineageStance[], policies: Policy[] = []) =>
  buildStanceRows({ stances, policies, personOf: (id) => PEOPLE[id], nameOf: (id) => id, electionDates: DATES })

Deno.test('立場表：每人取最新一筆；立場變過標「曾變」；沒變過不標', () => {
  const r = rows([
    stance('a1', 'cty', 'support', '2023-01-01'), stance('a2', 'cty', 'oppose', '2024-05-01'),
    stance('b1', 'cty2', 'support', '2023-01-01'), stance('b2', 'cty2', 'support', '2024-01-01'),
  ])
  assertEquals(r.length, 2)
  const a = r.find((x) => x.politicianId === 'cty')!
  assertEquals([a.stance, a.date, a.changed], ['oppose', '2024-05-01', true])
  const b = r.find((x) => x.politicianId === 'cty2')!
  assertEquals([b.stance, b.changed], ['support', false])
})

Deno.test('立場表排序：中央 → 縣市 → 鄉鎮 → 看不出層級；同層依地區、再日期新到舊', () => {
  const r = rows([
    stance('1', 'twn', 'support', '2024-01-01'), stance('2', 'cty', 'support', '2024-01-01'), stance('3', 'nat', 'oppose', '2024-01-01'),
    stance('4', 'ghost', 'support', '2024-01-01'), stance('5', 'cty3', 'support', '2025-01-01'),
  ])
  assertEquals(r.map((x) => x.politicianId), ['nat', 'cty3', 'cty', 'twn', 'ghost'])
})

Deno.test('「提出政見」推導列：沒有表態紀錄的政見持有人補一列、不算進立場筆數；有正式表態就由正式那列取代、不重複', () => {
  const policies = [pol('p1', 'cty', 2022, '2022-12-01'), pol('p2', 'twn', 2022)]
  const withDerived = rows([], policies)
  assertEquals(withDerived.map((x) => [x.politicianId, x.kind, x.stance, x.date]), [['cty', 'derived', null, '2022-12-01'], ['twn', 'derived', null, '2022-11-26']])
  assertEquals(withDerived[0].policyId, 'p1')
  // 筆數只算正式立場，推導列不計
  assertEquals(pageCounts({ policyIds: ['p1', 'p2'], handovers: [], events: [], stances: [] }).stances, 0)
  // cty 之後有了正式表態：只剩一列、是正式的
  const replaced = rows([stance('s1', 'cty', 'support', '2024-01-01')], policies)
  assertEquals(replaced.filter((x) => x.politicianId === 'cty').map((x) => x.kind), ['recorded'])
  assertEquals(replaced.map((x) => x.kind).sort(), ['derived', 'recorded'])
})

Deno.test('立場表：有爭議的列帶標示；日期精度只印到該印的那一段', () => {
  const r = rows([stance('d', 'cty', 'conditional', '2024-05-01', { disputed: true, condition: '財源到位', datePrecision: 'month' })])
  assertEquals([r[0].disputed, r[0].condition], [true, '財源到位'])
  assertEquals(formatStatedDate('2024-05-01', 'month'), '2024-05')
  assertEquals(formatStatedDate('2024-05-01', 'year'), '2024')
  assertEquals(formatStatedDate('2024-05-01'), '2024-05-01')
  assertEquals(formatStatedDate(null), '')
})

Deno.test('層級判斷：看最近當選的職位；沒有參選紀錄是 null', () => {
  assertEquals(personLevel(PEOPLE.nat), { level: 'national', region: null })
  assertEquals(personLevel(PEOPLE.cty), { level: 'county', region: '台中市' })
  assertEquals(personLevel(PEOPLE.twn).level, 'township')
  assertEquals(personLevel(undefined), { level: null, region: null })
})

const RAW: RawLineage = {
  id: 'l1', title: '台中捷運藍線', level: 'county', region: '台中市', sub_region: null, category: '交通建設', summary: '一句摘要',
  policy_ids: [], participants: [], handovers: [], links: [],
  stances: [
    { id: 's1', politician_id: 'x', name: '甲', stance: 'support', stated_on: '2024-01-01', quote: '原文', source_url: 'https://a.tw', source_locator: 'p.1' },
    { id: 's2', removed_at: '2025-01-01T00:00:00Z', politician_id: 'y', name: '乙', stance: 'oppose', stated_on: '2024-02-01', quote: '原文', source_url: 'https://a.tw', source_locator: 'p.1' },
    { id: 's3', disputed_at: '2025-01-01T00:00:00Z', politician_id: 'z', name: '丙', stance: 'oppose', stated_on: '2024-03-01', quote: '原文', source_url: 'https://a.tw', source_locator: 'p.1' },
  ],
  events: [
    { id: 'e1', event_type: 'approved', occurred_on: '2025-03-01', level: 'county', decided_by: '市議會', description: '三讀通過', source_url: 'https://a.tw', source_locator: 'p.1' },
    { id: 'e2', removed_at: '2025-01-01T00:00:00Z', event_type: 'approved', occurred_on: '2025-04-01', level: 'county', decided_by: '市議會', description: '下架的', source_url: 'https://a.tw', source_locator: 'p.1' },
    { id: 'e3', disputed_at: '2025-01-01T00:00:00Z', event_type: 'paused', occurred_on: '2025-05-01', level: 'county', decided_by: '市政府', description: '有爭議的', source_url: 'https://a.tw', source_locator: 'p.1' },
  ],
}

Deno.test('下架的立場與事件不顯示；有爭議的照顯示並帶旗標', () => {
  const l = mapLineage(RAW)!
  assertEquals((l.stances ?? []).map((s) => [s.id, s.disputed]), [['s1', false], ['s3', true]])
  assertEquals((l.events ?? []).map((e) => [e.id, e.disputed]), [['e1', false], ['e3', true]])
})

Deno.test('舊視圖缺新欄不炸：立場、事件、現況、出處都當空；空脈絡各區塊函式都給得出空值', () => {
  const old = mapLineage({ id: 'o', title: '舊', level: 'national', policy_ids: [], participants: [], handovers: [], links: [] } as RawLineage)!
  assertEquals([old.stances, old.events, old.sources, old.status], [[], [], [], null])
  assertEquals(buildStanceRows({ stances: [], policies: [], personOf: () => undefined, nameOf: () => undefined, electionDates: new Map() }), [])
  assertEquals(buildChronicle([], [], new Map()), [])
  assertEquals(pageCounts(old), { policies: 0, handovers: 0, events: 0, stances: 0 })
  assertEquals(statusHeadline(old), '')
  assertEquals(coveragePlaces(undefined), [])
  assertEquals(isLineageListed(old), false, '合格政見 0 條的脈絡：照常開、標 noindex、不進網站地圖')
})

Deno.test('主頁對合格政見 0 條不讀 policyIds[0]；noindex 條件還在', async () => {
  const page = await read('../pages/LineagePage.vue')
  assert(!/policyIds\[0\]/.test(page))
  assert(page.includes('isLineageListed(lineage.value)') && page.includes('noindex:'))
})

// ── 大事記、現況、涵蓋 ─────────────────────────────────────────────────────

const ev = (id: string, occurredOn: string): LineageEvent => ({
  id, eventType: 'approved', occurredOn, datePrecision: 'day', level: 'county', region: '台中市', subRegion: null, decidedBy: '市議會', description: 'x',
  initiator: null, disputed: false, sourceUrl: 'https://a.tw', sourceLocator: 'p', source: null,
})
const ho = (id: string, decidedOn: string | null, toElectionId: number | null = null): LineageHandover => ({
  id, fromPoliticianId: 'a', fromName: 'a', fromElectionId: null, toPoliticianId: 'b', toName: 'b', toElectionId, handoverType: 'keep', decidedOn,
  note: 'x', sourceUrl: 'https://a.tw', sourceLocator: 'p', source: null,
})

Deno.test('大事記：事件與交接合併、新到舊；沒日期的排最後；交接沒判定日就用後任那一屆投票日', () => {
  const items = buildChronicle([ev('e1', '2024-01-01'), ev('e2', '2025-06-01')], [ho('h1', '2025-01-01'), ho('h2', null, 2022), ho('h3', null)], DATES)
  assertEquals(items.map((i) => i.key), ['event:e2', 'handover:h1', 'event:e1', 'handover:h2', 'handover:h3'])
  assertEquals(CHRONICLE_HEAD, 4)
})

Deno.test('現況句：帶階段與截至日；認不得的階段不印', () => {
  const base = { phase: 'approved', text: '已完成環評，等待動工。', asOf: '2026-11-01', sourceUrl: 'https://a.tw', source: null }
  assertEquals(statusHeadline({ status: base }), '已核定：已完成環評，等待動工。（2026-11-01）')
  assertEquals(statusHeadline({ status: { ...base, phase: 'weird' } }), '已完成環評，等待動工。（2026-11-01）')
  assertEquals(statusPhaseLabel(''), '')
  assertEquals(statusHeadline({ status: null }), '')
})

Deno.test('涵蓋的地名：去重、保留順序', () => {
  assertEquals(coveragePlaces([
    { level: 'county', region: '台中市', subRegion: null, policyCount: 1 }, { level: 'county', region: '台中市', subRegion: null, policyCount: 2 },
    { level: 'county', region: '高雄市', subRegion: null, policyCount: 1 },
  ]), ['台中市', '高雄市'])
})

// ── 承諾與政見分開 ─────────────────────────────────────────────────────────

Deno.test('承諾不進政見清單：頁面的政見只取視圖的 policy_ids（只收當選後的政見），自己不再另算', async () => {
  const page = await read('../pages/LineagePage.vue')
  assert(/l\.policyIds\.map\(\(id\) => byId\.get\(id\)\)/.test(page), '政見清單要由 lineage.policyIds 取')
  const migration = await read('../supabase/migrations/20261120120000_lineage_stances_events.sql')
  assert(/policy_ids[\s\S]{0,400}policy_is_elected_term/.test(migration) || /policy_is_elected_term\(pl\.id\)\)/.test(migration), '視圖的 policy_ids 要濾 policy_is_elected_term')
})

// ── 5. 邊緣渲染與預渲染同一份資料 ──────────────────────────────────────────

Deno.test('邊緣渲染與預渲染：同一支 mapLineage、同一支 lineagePeople；立場表態者與事件推動者都在人物清單裡', async () => {
  const loaders = await read('./ssr/loaders.ts')
  const pageData = await read('./ssg/page-data.ts')
  const serverData = await read('./ssg/server-data.ts')
  assert(loaders.includes("select('*').eq('id', id)") && loaders.includes('lineagePeople(lineage, policies)'), '邊緣載入器：整列 lineages_full＋lineagePeople')
  assert(pageData.includes('lineagePeople(lineage, policies)'), '預渲染切片：lineagePeople')
  assert(serverData.includes("fetchAllRows<RawLineage>('lineages_full', '*', 'id')") && serverData.includes('mapLineage'), '預渲染：同一支視圖、同一支 mapLineage')
  const l = mapLineage({ ...RAW, stances: [{ ...RAW.stances![0], politician_id: 'stancer' }], events: [{ ...RAW.events![0], initiator: { politician_id: 'pusher', name: '丁' } }] })!
  const people = lineagePeople(l as Lineage, [pol('p1', 'holder', 2022)])
  for (const id of ['holder', 'stancer', 'pusher']) assert(people.includes(id), `人物清單少了 ${id}`)
})
