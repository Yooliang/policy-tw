/**
 * 左欄歸屬（lib/desk-sections.ts）：政見詳情頁看資料不看網址。
 *   承諾（選前、落選／退選、結果待補，且屬於某一屆）→ 選舉；當選後的政見、任內施政、沒標屆別 → 政見
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { overviewItemOn, sectionOfPolicy, sectionOfRoute } from './desk-sections.ts'
import { policyStage } from './policy-stage.ts'

Deno.test('承諾頁歸選舉、政見頁歸政見', () => {
  assertEquals(sectionOfPolicy('pledge', 2026), 'election')
  assertEquals(sectionOfPolicy('lost_pledge', 2022), 'election')
  assertEquals(sectionOfPolicy('pending_result', 2022), 'election')
  assertEquals(sectionOfPolicy('policy', 2022), 'policy')
  assertEquals(sectionOfPolicy('governance', 2022), 'policy', '施政留在政見區')
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

import { levelCountyLinkGroups, pledgeLevelRegion } from './desk-level-groups.ts'

Deno.test('承諾→提出者該屆參選紀錄→層級與縣市', () => {
  const recs = [{ electionId: 2022, electionType: '縣市議員', region: '高雄市' }, { electionId: 2026, electionType: '縣市長', region: '台南市' }]
  assertEquals(pledgeLevelRegion(recs, 2026, '台北市'), { type: '縣市長', county: '台南市' }, '有該屆參選紀錄就用紀錄，不用承諾自己的縣市')
  assertEquals(pledgeLevelRegion(recs, 2022, null), { type: '縣市議員', county: '高雄市' })
})

Deno.test('沒有該屆參選紀錄才退回承諾自己的縣市；非縣市當全台', () => {
  assertEquals(pledgeLevelRegion([], 2026, '台北市'), { type: '', county: '台北市' })
  assertEquals(pledgeLevelRegion(undefined, 2026, '全台'), { type: '', county: 'All' })
  assertEquals(pledgeLevelRegion([{ electionId: 2026, electionType: '不明', region: '中央' }], 2026, '台北市'), { type: '', county: 'All' })
})

Deno.test('層級／縣市連結帶正確網址參數且選中推導的項目', () => {
  const g = levelCountyLinkGroups('2026', '縣市長', '台南市')
  const items = g.flatMap(x => x.blocks.flat())
  const lvl = items.find(i => i.key === '縣市議員')!
  const cty = items.find(i => i.key === '高雄市')!
  assertEquals(decodeURI(lvl.to!).includes('/election/2026/台南市?tab='), true, '換層級留在目前縣市')
  assertEquals(decodeURI(cty.to!).includes('/election/2026/高雄市?tab=縣市長'), true, '換縣市帶目前層級')
  assertEquals(items.filter(i => i.active).map(i => i.key).sort(), ['台南市', '縣市長'].sort())
})

Deno.test('接線守門：延伸欄在承諾頁用推導出的層級／縣市，人物頁與承諾頁共用同一個產生函式', () => {
  const read = (f: string) => Deno.readTextFileSync(new URL(f, import.meta.url))
  assertEquals(/pledgeElection\.value\) return \[[^\]]*pledgeLevelGroups\.value/.test(read('../components/DeskExtNav.vue')), true)
  assertEquals(read('../composables/useDeskSection.ts').includes('levelCountyLinkGroups('), true)
  assertEquals(read('../pages/PoliticianProfile.vue').includes('levelCountyLinkGroups('), true)
})

Deno.test('政黨分流圖歸參與區，政黨一覽仍歸搜尋區', () => {
  assertEquals(sectionOfRoute('party-flow'), 'join')
  assertEquals(sectionOfRoute('parties'), 'search')
})

Deno.test('一覽組高亮：開分流圖只亮分流圖，政黨一覽不跟著亮；其他子頁行為不變', () => {
  assertEquals(overviewItemOn('/parties', '/parties/flow'), false)
  assertEquals(overviewItemOn('/parties/flow', '/parties/flow'), true)
  assertEquals(overviewItemOn('/parties', '/parties'), true)
  assertEquals(overviewItemOn('/parties', '/parties/12'), true)
  assertEquals(overviewItemOn('/politicians', '/politicians/5'), true)
  assertEquals(overviewItemOn('/politicians', '/parties'), false)
})
