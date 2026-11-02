/** 側欄「其他承諾／政見」分區（lib/other-policies.ts） */
import { assertEquals } from 'jsr:@std/assert@1'
import { splitOtherPolicies } from './other-policies.ts'
import type { PolicyStage } from './policy-stage.ts'

type T = { id: string; electionId: number; stage: PolicyStage }
const mk = (id: number | string, electionId: number, stage: PolicyStage): T => ({ id: String(id), electionId, stage })
const all = [
  mk(1, 2026, 'pledge'), mk(2, 2026, 'pledge'), mk(3, 2022, 'lost_pledge'),
  mk(4, 2022, 'policy'), mk(5, 2018, 'pending_result'), mk(6, 2022, 'policy'),
]
const run = (cur: T) => splitOtherPolicies(all, cur, cur.stage, (p) => p.stage, (a, b) => Number(b.id) - Number(a.id))
const ids = (xs: T[]) => xs.map((x) => x.id)

Deno.test('目前是承諾：其他承諾只列同一場，政見另列', () => {
  const r = run(mk(1, 2026, 'pledge'))
  assertEquals(ids(r.pledges), [2].map(String))
  assertEquals(ids(r.policies), [6, 4].map(String))
})

Deno.test('目前是政見：其他承諾不含落選那屆，同屆排前面', () => {
  const r = run(mk(4, 2022, 'policy'))
  assertEquals(ids(r.pledges), [5, 2, 1].map(String))
  assertEquals(ids(r.policies), [6].map(String))
})

Deno.test('每區上限與空區', () => {
  const r = splitOtherPolicies([mk(1, 1, 'policy')], mk(9, 1, 'pledge'), 'pledge', (p) => p.stage, () => 0)
  assertEquals(r.pledges, [])
})
