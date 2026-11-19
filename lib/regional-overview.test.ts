/**
 * 數據分佈頁純函式（lib/regional-overview.ts）：兌現率、分母門檻、資料不足判定、熱力圖尺度、跨任期數；
 * 另守 migration 20261119140000 的內容（視圖都建、security_invoker、權限、listed 式子與 policies_by_region 同一份）。
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  COUNTIES,
  MIN_DEADLINE_DATED,
  MIN_ELEMENT_ROWS,
  MIN_RATE_DENOM,
  categoriesByTotal,
  datedCount,
  deadlineReady,
  deadlineTotals,
  elementRowCount,
  elementShares,
  elementsByCounty,
  elementsByLevel,
  elementsReady,
  fulfilmentRate,
  funnelRows,
  heatAlpha,
  heatMatrix,
  heatValue,
  inRegion,
  levelOf,
  lineageStat,
  lineageStatsByCounty,
  normRegion,
  percentText,
  policyTotal,
  rateReliable,
  stageBucketOf,
  stageRowsFromCategory,
  stageTotals,
  termCount,
  timelineLineages,
  timelineYears,
  type LineageSpanRow,
  type RegionCategoryStageRow,
  type RegionDeadlineRow,
  type RegionElementRow,
  type RegionStageRow,
} from './regional-overview.ts'

const stage = (region: string, p: number, pr: number, ip: number, ac: number, st: number, ns = 0): RegionStageRow =>
  ({ region, pledge_n: p, not_started_n: ns, proposed_n: pr, in_progress_n: ip, achieved_n: ac, stalled_n: st })

Deno.test('台／臺同一；全台含全國、縣市不含全國', () => {
  assertEquals(normRegion('臺北市'), '台北市')
  assert(inRegion('臺北市', '台北市'))
  assert(inRegion('全國', 'All'))
  assert(!inRegion('全國', '台北市'))
  const rows = [stage('台北市', 10, 1, 2, 0, 0), stage('全國', 3, 0, 1, 0, 0)]
  assertEquals(stageTotals(rows, 'All').pledge_n, 13)
  assertEquals(stageTotals(rows, '臺北市').pledge_n, 10)
  assertEquals(stageTotals(rows, '桃園市').pledge_n, 0)
})

Deno.test('階段格：選前／落選一律承諾；選後／施政依 status 分桶，Campaign Pledge 是尚未啟動，Failed 併入停滯', () => {
  assertEquals(stageBucketOf('Campaign Pledge', 'pledge'), 'pledge')
  assertEquals(stageBucketOf('Campaign Pledge', 'lost_pledge'), 'pledge')
  assertEquals(stageBucketOf('Campaign Pledge', 'policy'), 'not_started')
  assertEquals(stageBucketOf('Proposed', 'policy'), 'proposed')
  assertEquals(stageBucketOf('In Progress', 'governance'), 'in_progress')
  assertEquals(stageBucketOf('Achieved', 'governance'), 'achieved')
  assertEquals(stageBucketOf('Stalled', 'governance'), 'stalled')
  assertEquals(stageBucketOf('Failed', 'governance'), 'stalled')
  // 還在承諾階段（選前／落選）的任何 status 都是承諾，不進政見
  assertEquals(stageBucketOf('In Progress', 'pledge'), 'pledge')
  assertEquals(stageBucketOf('Achieved', 'lost_pledge'), 'pledge')
})

Deno.test('政見數含尚未啟動；兌現率分母也含', () => {
  const c = stage('x', 100, 4, 3, 2, 1, 10)
  assertEquals(policyTotal(c), 20)
  assertAlmostEquals(fulfilmentRate(c)!, 0.25)
})

Deno.test('縣市階段列由縣市 × 分類加總', () => {
  const rows = stageRowsFromCategory([
    { ...stage('台北市', 10, 1, 2, 0, 0, 5), category: '交通建設' },
    { ...stage('台北市', 4, 0, 0, 1, 0, 2), category: '社會福利' },
    { ...stage('新北市', 7, 0, 0, 0, 0, 0), category: '交通建設' },
  ])
  assertEquals(rows.length, 2)
  const tp = rows.find((r) => r.region === '台北市')!
  assertEquals([tp.pledge_n, tp.not_started_n, tp.proposed_n, tp.in_progress_n, tp.achieved_n], [14, 7, 1, 2, 1])
})

Deno.test('兌現率＝（施政中＋已完成）÷ 政見數；沒有政見是 null 不是 0', () => {
  const c = stage('x', 100, 4, 3, 2, 1)
  assertEquals(policyTotal(c), 10)
  assertAlmostEquals(fulfilmentRate(c)!, 0.5)
  assertEquals(fulfilmentRate(stage('x', 50, 0, 0, 0, 0)), null)
  assertEquals(percentText(0.614), '61%')
  assertEquals(percentText(null), '—')
})

Deno.test('分母門檻：政見數 < 10 不算有效樣本', () => {
  assertEquals(MIN_RATE_DENOM, 10)
  assert(!rateReliable(stage('x', 0, 4, 3, 2, 0))) // 9
  assert(rateReliable(stage('x', 0, 5, 3, 2, 0))) // 10
})

Deno.test('漏斗排序：有效樣本依兌現率、分母不足的放後面、沒有政見的最後', () => {
  const rows = [
    stage('台北市', 100, 20, 8, 2, 0), // 30 筆、33%
    stage('新北市', 100, 10, 10, 10, 0), // 30 筆、67%
    stage('基隆市', 100, 0, 3, 0, 0), // 3 筆、100%（分母不足）
    stage('桃園市', 100, 5, 5, 0, 0), // 10 筆、50%
    stage('雲林縣', 100, 0, 0, 0, 0), // 0 筆
  ]
  const order = funnelRows(rows, ['台北市', '新北市', '基隆市', '桃園市', '雲林縣']).map((r) => r.region)
  assertEquals(order, ['新北市', '桃園市', '台北市', '基隆市', '雲林縣'])
  const keelung = funnelRows(rows, ['基隆市'])[0]
  assertEquals(keelung.reliable, false)
  assertEquals(keelung.rate, 1)
})

Deno.test('熱力圖：全圖共用一個尺度，0 沒有顏色，最大值最深，單調遞增', () => {
  assertEquals(heatAlpha(0, 100), 0)
  assertEquals(heatAlpha(5, 0), 0)
  assertAlmostEquals(heatAlpha(100, 100), 1)
  assert(heatAlpha(10, 100) < heatAlpha(50, 100))
  assert(heatAlpha(50, 100) < heatAlpha(100, 100))
  assertEquals(heatAlpha(500, 100), heatAlpha(100, 100)) // 超過最大值不爆
})

const catRows: RegionCategoryStageRow[] = [
  { region: '台北市', category: '交通建設', pledge_n: 10, not_started_n: 0, proposed_n: 1, in_progress_n: 2, achieved_n: 0, stalled_n: 0 },
  { region: '台北市', category: '社會福利', pledge_n: 5, not_started_n: 0, proposed_n: 0, in_progress_n: 0, achieved_n: 0, stalled_n: 0 },
  { region: '新北市', category: '交通建設', pledge_n: 20, not_started_n: 0, proposed_n: 0, in_progress_n: 0, achieved_n: 1, stalled_n: 0 },
  { region: '全國', category: '交通建設', pledge_n: 99, not_started_n: 0, proposed_n: 0, in_progress_n: 0, achieved_n: 0, stalled_n: 0 },
]
const lin = (id: string, region: string, category: string, years: number[], handovers = 0, ids: number[] | null = null): LineageSpanRow =>
  ({ lineage_id: id, title: id, category, level: 'county', region, election_ids: ids ?? years, term_years: years, handover_n: handovers })

Deno.test('熱力圖三個頁籤：承諾／政見／脈絡；全國不進縣市矩陣', () => {
  const data = { category: catRows, lineage: [lin('a', '台北市', '交通建設', [2018, 2022]), lin('b', '全國', '交通建設', [2018, 2022])] }
  assertEquals(heatValue('pledge', '台北市', '交通建設', data), 10)
  assertEquals(heatValue('policy', '台北市', '交通建設', data), 3)
  assertEquals(heatValue('lineage', '台北市', '交通建設', data), 1)
  const m = heatMatrix('pledge', data, ['交通建設', '社會福利'], ['台北市', '新北市'])
  assertEquals(m.values, [[10, 5], [20, 0]])
  assertEquals(m.max, 20)
  assertEquals(categoriesByTotal('pledge', data, ['社會福利', '交通建設']), ['交通建設', '社會福利'])
})

const el = (region: string, type: string, t: [number, number], d: [number, number], f: [number, number]): RegionElementRow =>
  ({ region, election_type: type, target_stated: t[0], target_total: t[1], deadline_stated: d[0], deadline_total: d[1], funding_stated: f[0], funding_total: f[1] })

Deno.test('三要素：比例、調查筆數門檻、資料不足判定', () => {
  const rows = [el('台北市', '縣市長', [4, 10], [1, 10], [2, 10]), el('新北市', '縣市議員', [1, 2], [0, 2], [0, 2])]
  const s = elementShares(rows)
  assertAlmostEquals(s.target.rate!, 5 / 12)
  assertEquals(s.target.reliable, true)
  assertEquals(elementRowCount(rows), 36)
  assertEquals(MIN_ELEMENT_ROWS, 50)
  assertEquals(elementsReady(rows), false)
  assertEquals(elementsReady([el('台北市', '縣市長', [4, 20], [1, 20], [2, 20])]), true) // 60
  const byCounty = elementsByCounty(rows, ['台北市', '新北市', '桃園市'])
  assertEquals(byCounty[1].shares.target.reliable, false) // 2 筆：淡化、印 n／m
  assertEquals(byCounty[2].shares.target.rate, null)
})

Deno.test('三要素按層級：原住民區併入鄉鎮、依層級順序、範圍篩選', () => {
  assertEquals(levelOf('直轄市山地原住民區長'), '鄉鎮市長')
  const rows = [
    el('台北市', '村里長', [1, 5], [0, 5], [0, 5]),
    el('台北市', '縣市長', [3, 5], [1, 5], [1, 5]),
    el('高雄市', '直轄市山地原住民區長', [1, 2], [0, 2], [0, 2]),
    el('高雄市', '鄉鎮市長', [1, 2], [0, 2], [0, 2]),
  ]
  assertEquals(elementsByLevel(rows, 'All').map((x) => x.level), ['縣市長', '鄉鎮市長', '村里長'])
  assertEquals(elementsByLevel(rows, 'All')[1].shares.target.total, 4)
  assertEquals(elementsByLevel(rows, '台北市').map((x) => x.level), ['縣市長', '村里長'])
})

Deno.test('跨任期數：不同屆數、沒有屆別 id 時退回年份；脈絡統計與縣市排序', () => {
  assertEquals(termCount({ election_ids: [1, 1, 2], term_years: [2018, 2022] }), 2)
  assertEquals(termCount({ election_ids: null, term_years: [2018, 2018, 2022] }), 2)
  assertEquals(termCount({ election_ids: null, term_years: null }), 0)
  const rows = [
    lin('a', '台中市', '交通建設', [2018, 2022], 2),
    lin('b', '台中市', '社會福利', [2022], 1),
    lin('c', '台南市', '社會福利', [2018, 2022]),
    lin('d', '全國', '能源', [2018, 2022], 4),
  ]
  const taichung = lineageStat(rows, '台中市')
  assertEquals(taichung.count, 2)
  assertAlmostEquals(taichung.avgTerms!, 1.5)
  assertEquals(taichung.handovers, 3)
  assertEquals(lineageStat(rows, 'All').count, 4) // 全台含中央層級
  assertEquals(lineageStat(rows, '桃園市').avgTerms, null)
  assertEquals(lineageStatsByCounty(rows).map((s) => s.region), ['台中市', '台南市'])
})

Deno.test('三屆任期示意：只挑跨 2 屆以上的真實脈絡，年份欄由早到晚', () => {
  const rows = [
    lin('單屆', '台中市', '交通建設', [2022]),
    lin('兩屆', '台中市', '交通建設', [2018, 2022], 1),
    lin('三屆', '台南市', '社會福利', [2014, 2018, 2022]),
  ]
  const picked = timelineLineages(rows, 'All')
  assertEquals(picked.map((l) => l.lineage_id), ['三屆', '兩屆'])
  assertEquals(timelineYears(picked), [2014, 2018, 2022])
  assertEquals(timelineLineages(rows, '台中市').map((l) => l.lineage_id), ['兩屆'])
  assertEquals(timelineLineages(rows, '桃園市'), [])
  assertEquals(timelineLineages(rows, 'All', 1).length, 1)
})

const dl = (region: string, n: [number, number, number, number, number, number]): RegionDeadlineRow =>
  ({ region, policy_n: n[0], overdue_n: n[1], within30_n: n[2], later_n: n[3], unset_n: n[4], updated_30d_n: n[5] })

Deno.test('期限分佈：加總、有日期筆數、資料不足判定', () => {
  const rows = [dl('台北市', [30, 2, 1, 3, 24, 5]), dl('新北市', [10, 0, 0, 1, 9, 0]), dl('全國', [1, 0, 0, 0, 1, 0])]
  const all = deadlineTotals(rows, 'All')
  assertEquals(all.policy, 41)
  assertEquals(datedCount(all), 7)
  assertEquals(all.updated30d, 5)
  assertEquals(deadlineReady(all), false)
  assertEquals(MIN_DEADLINE_DATED, 20)
  assertEquals(deadlineTotals(rows, '臺北市').policy, 30)
  assertEquals(deadlineReady(deadlineTotals([dl('台北市', [100, 10, 5, 5, 80, 0])], 'All')), true) // 剛好 20
})

Deno.test('縣市列表 22 個、沒有重複', () => {
  assertEquals(COUNTIES.length, 22)
  assertEquals(new Set(COUNTIES).size, 22)
})

// ───── migration 守門 ─────
// 本機 git autocrlf 會讓檔案變 CRLF，含換行的字串比對要先正規化，CI（LF）與本機才一致
const readSql = (name: string) =>
  Deno.readTextFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url)).replace(/\r\n/g, '\n')
const sql = readSql('20261119140000_regional_data_views.sql')
const policiesByRegion = readSql('20261119120000_policies_by_region.sql')

Deno.test('migration：五支視圖都建、security_invoker、anon／authenticated 可讀', () => {
  for (const v of ['region_category_stage_counts', 'region_stage_counts', 'lineage_term_spans', 'region_element_stats', 'region_deadline_stats']) {
    assert(sql.includes(`CREATE OR REPLACE VIEW ${v} AS`), `${v} 沒建`)
    assert(sql.includes(`ALTER VIEW ${v} SET (security_invoker = on)`), `${v} 沒設 security_invoker`)
    assert(sql.includes(`GRANT SELECT ON ${v} TO anon, authenticated`), `${v} 沒給讀取權限`)
  }
})

Deno.test('migration：算政見的視圖直接讀 policies_by_region，不另抄 listed 的式子', () => {
  const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').replace(/'(?:[^']|'')*'\s*;/g, ';')
  assert(policiesByRegion.includes('AS listed'))
  assertEquals((code.match(/FROM policies_by_region pl/g) ?? []).length, 2) // 階段計數、期限分佈
  assert(!code.includes('AND EXISTS') && !code.includes("q.candidacy_status = 'elected'"), '不該再抄一份 listed 式子')
  assert(!code.includes("pl.origin = 'pledge'"))
})

Deno.test('migration：承諾＝NOT listed、政見＝listed 再依 status 分桶（尚未啟動＝Campaign Pledge）；期限分佈母體是 listed', () => {
  assert(sql.includes('count(*) FILTER (WHERE NOT pl.listed)::int AS pledge_n'))
  assert(sql.includes("count(*) FILTER (WHERE pl.listed AND pl.status = 'Campaign Pledge')::int AS not_started_n"))
  assert(sql.includes("pl.listed AND pl.status IN ('Stalled', 'Failed')"))
  assert(sql.includes('WHERE pl.listed\nGROUP BY pl.region'))
})

Deno.test('migration：脈絡只收合格政見、三要素沒有列不進分母', () => {
  assert(sql.includes('policy_is_elected_term(pl.id)'))
  assert(sql.includes('WHERE t.policy_n > 0')) // 空脈絡不列（同 isLineageListed）
  assert(sql.includes("FROM policy_elements pel")) // 只從有列的算＝未調查不在分母
})
