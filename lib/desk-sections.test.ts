/**
 * 左欄歸屬（lib/desk-sections.ts）：政見詳情頁看資料不看網址。
 *   承諾（選前、落選／退選、結果待補，且屬於某一屆）→ 選舉；當選後的政見、任內施政、沒標屆別 → 政見
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { sectionOfPolicy, sectionOfRoute } from './desk-sections.ts'
import { policyStage } from './policy-stage.ts'

Deno.test('承諾頁歸選舉、政見頁歸政見', () => {
  assertEquals(sectionOfPolicy('pledge', 2026), 'election')
  assertEquals(sectionOfPolicy('lost_pledge', 2022), 'election')
  assertEquals(sectionOfPolicy('pending_result', 2022), 'election')
  assertEquals(sectionOfPolicy('policy', 2022), 'policy')
  assertEquals(sectionOfPolicy('pledge', null), 'policy', '沒標屆別不屬於任何一屆')
  assertEquals(sectionOfPolicy(null, 2026), 'policy')
})

Deno.test('接上真正的階段判斷：選前承諾→選舉，當選政見→政見', () => {
  const dateOf = (id: number) => (id === 2026 ? '2026-11-28' : '2022-11-26')
  const p = (electionId: number) => ({ status: 'Campaign Pledge' as never, origin: 'pledge' as never, electionId })
  const t = '2026-11-02'
  assertEquals(sectionOfPolicy(policyStage(p(2026), [{ electionId: 2026 }], t, dateOf), 2026), 'election')
  assertEquals(sectionOfPolicy(policyStage(p(2022), [{ electionId: 2022, candidacyStatus: 'elected' }], t, dateOf), 2022), 'policy')
})

Deno.test('其他路由照名稱歸區', () => {
  assertEquals(sectionOfRoute('policy'), 'policy')
  assertEquals(sectionOfRoute('election'), 'election')
})
