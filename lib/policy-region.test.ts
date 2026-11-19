/**
 * lib/policy-region.ts：policyMatchesRegion 的 Map 版與陣列版同一個結果。
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { ALL_REGIONS, policyMatchesRegion } from './policy-region.ts'
import type { Policy, Politician } from '../types.ts'

const people = [
  { id: 'a', region: '新北市' },
  { id: 'b', region: '台北市' },
  { id: 'c', region: '' },
  { id: 'd', region: '全國' },
] as unknown as Politician[]
const index = new Map(people.map((p) => [String(p.id), p]))
const policy = (politicianId: string | number | undefined) => ({ politicianId } as unknown as Policy)

Deno.test('Map 版與陣列版：每個人 × 每個縣市結果一致', () => {
  const regions = [ALL_REGIONS, '新北市', '台北市', '全國', '高雄市', '']
  for (const id of ['a', 'b', 'c', 'd', 'zzz', undefined]) {
    for (const region of regions) {
      assertEquals(policyMatchesRegion(policy(id), index, region), policyMatchesRegion(policy(id), people, region), `${String(id)} / ${region}`)
    }
  }
})

Deno.test('選全台一律符合；找不到所屬人物（尚未載入）不符合', () => {
  assertEquals(policyMatchesRegion(policy('zzz'), index, ALL_REGIONS), true)
  assertEquals(policyMatchesRegion(policy('zzz'), index, '新北市'), false)
  assertEquals(policyMatchesRegion(policy(undefined), index, '新北市'), false)
})

Deno.test('人物 id 是數字時也能對上（鍵一律轉字串）', () => {
  const numeric = [{ id: 7, region: '桃園市' }] as unknown as Politician[]
  const idx = new Map(numeric.map((p) => [String(p.id), p]))
  assertEquals(policyMatchesRegion(policy(7), idx, '桃園市'), true)
  assertEquals(policyMatchesRegion(policy(7), numeric, '桃園市'), true)
})
