import { assertEquals } from "jsr:@std/assert@1";
import { agentPlanRows, type AgentPlan } from './agent-plans.ts'

const seed: AgentPlan[] = [
  { provider: 'Codex', plan: '訂閱', qty: 1, monthly_usd: 20, note: null, sort: 50 },
  { provider: 'Claude', plan: '20x 方案', qty: 3, monthly_usd: 200, note: null, sort: 10 },
  { provider: 'DeepSeek', plan: 'API', qty: 1, monthly_usd: 65, note: '約', sort: 30 },
]

Deno.test('agentPlanRows：依 sort 排序、小計＝單價×數量、合計相加', () => {
  const r = agentPlanRows(seed)
  assertEquals(r.rows.map((x) => x.provider), ['Claude', 'DeepSeek', 'Codex'])
  assertEquals(r.rows[0].subtotal, 600)
  assertEquals(r.total, 685)
})

Deno.test('agentPlanRows：note 以「約」開頭才算估計值，合計跟著標約', () => {
  const r = agentPlanRows(seed)
  assertEquals(r.rows.map((x) => x.approx), [false, true, false])
  assertEquals(r.approx, true)
  assertEquals(agentPlanRows([seed[0]]).approx, false)
})

Deno.test('agentPlanRows：空陣列合計 0', () => {
  assertEquals(agentPlanRows([]), { rows: [], total: 0, approx: false })
})

Deno.test('agentPlanRows：資料庫 NUMERIC 以字串回來也能算', () => {
  const r = agentPlanRows([{ provider: 'X', plan: 'p', qty: 2, monthly_usd: '12.5' as unknown as number, note: null, sort: 1 }])
  assertEquals(r.total, 25)
})
