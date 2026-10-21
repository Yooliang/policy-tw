import { assertEquals } from "jsr:@std/assert@1";
import { agentPlanRows, amount, usageMap, usageText, type AgentPlan, type AgentUsage } from './agent-plans.ts'

const seed: AgentPlan[] = [
  { provider: 'Codex', plan: '訂閱', qty: 1, monthly_usd: 20, note: null, sort: 50 },
  { provider: 'Claude', plan: '20x 方案', qty: 3, monthly_usd: 200, note: null, sort: 10 },
  { provider: 'DeepSeek', plan: 'API', qty: 1, monthly_usd: 65, note: '約', sort: 30 },
]

Deno.test('agentPlanRows：依 sort 排序，數量大於 1 展開成每個一列並標帳號', () => {
  const r = agentPlanRows(seed)
  assertEquals(r.rows.map((x) => [x.provider, x.label]), [
    ['Claude', '帳號 A'], ['Claude', '帳號 B'], ['Claude', '帳號 C'], ['DeepSeek', null], ['Codex', null],
  ])
  assertEquals(r.rows.map((x) => x.monthly), [200, 200, 200, 65, 20])
})

Deno.test('agentPlanRows：合計＝各列相加；note 以「約」開頭才算估計值', () => {
  const r = agentPlanRows(seed)
  assertEquals(r.total, 685)
  assertEquals(r.rows.map((x) => x.approx), [false, false, false, true, false])
  assertEquals(r.approx, true)
  assertEquals(agentPlanRows([seed[0]]).approx, false)
})

Deno.test('agentPlanRows：空陣列與數量 0 合計 0', () => {
  assertEquals(agentPlanRows([]), { rows: [], total: 0, approx: false })
  assertEquals(agentPlanRows([{ ...seed[0], qty: 0 }]).rows.length, 0)
})

Deno.test('agentPlanRows：資料庫 NUMERIC 以字串回來也能算', () => {
  const r = agentPlanRows([{ provider: 'X', plan: 'p', qty: 2, monthly_usd: '12.5' as unknown as number, note: null, sort: 1 }])
  assertEquals(r.total, 25)
})

Deno.test('agentPlanRows：Jev 那一列排在最後、計入合計', () => {
  const r = agentPlanRows(seed, { usd: 3.5, usage: '本月 10 次' })
  assertEquals(r.rows.length, 6)
  assertEquals(r.rows[5].provider, 'Jev（AI 自動判定）')
  assertEquals(r.rows[5].usage, '本月 10 次')
  assertEquals(r.total, 688.5)
  assertEquals(agentPlanRows(seed, null).total, 685)
})

Deno.test('agentPlanRows：方案與月費留空的列照列出、不計入合計，用量依供應商帶入', () => {
  const r = agentPlanRows([...seed, { provider: 'Supabase', plan: null, qty: 1, monthly_usd: null, note: null, sort: 60 }], null, { Supabase: '120 MB' })
  const last = r.rows[r.rows.length - 1]
  assertEquals([last.provider, last.plan, last.monthly, last.usage], ['Supabase', null, null, '120 MB'])
  assertEquals(r.total, 685)
})

const NOW = Date.parse('2026-10-21T12:00:00Z')
const u = (o: Partial<AgentUsage> = {}): AgentUsage => ({ provider: 'Claude', account_label: '帳號 A', pct: 42.4, resets_at: '2026-10-24T02:00:00Z', captured_at: '2026-10-21T11:50:00Z', ...o })

Deno.test('usageText：本週百分比與台北日期的重置時間', () => {
  assertEquals(usageText(u(), NOW), '本週 42%（10/24 重置）')
  assertEquals(usageText(u({ resets_at: '2026-10-24T17:00:00Z' }), NOW), '本週 42%（10/25 重置）')
  assertEquals(usageText(u({ resets_at: null }), NOW), '本週 42%')
})

Deno.test('usageText：快照超過 6 小時沒更新就不顯示', () => {
  assertEquals(usageText(u({ captured_at: '2026-10-21T05:00:00Z' }), NOW), null)
})

Deno.test('agentPlanRows：Claude 三列各自帶自己帳號的用量，沒資料的帳號顯示空', () => {
  const m = usageMap([u(), u({ account_label: '帳號 C', pct: 100 })], NOW)
  const r = agentPlanRows(seed, null, m)
  assertEquals(r.rows.slice(0, 3).map((x) => x.usage), ['本週 42%（10/24 重置）', null, '本週 100%（10/24 重置）'])
  assertEquals(r.rows[3].usage, null)
})

Deno.test('amount：四捨五入到整數、不顯示小數點', () => {
  assertEquals([amount(200), amount(65), amount(3.4), amount(688.5), amount(0)], ['200', '65', '3', '689', '0'])
  // 合計用原始值加總再四捨五入：0.4＋0.4＋0.4＝1.2→1（各列先捨入會變 0）
  assertEquals(amount(agentPlanRows([{ provider: 'X', plan: 'p', qty: 3, monthly_usd: 0.4, note: null, sort: 1 }]).total), '1')
})
