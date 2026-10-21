import { assertEquals } from "jsr:@std/assert@1";
import { agentPlanRows, type AgentPlan } from './agent-plans.ts'

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
