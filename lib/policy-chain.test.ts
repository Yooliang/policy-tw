/**
 * 「同一條脈絡的政見」與「進度過半的政見」（#349 第二階段 A）的守門測試。
 *   1. 同一個 lineage id ＝同一組，照提出時間排；沒歸入脈絡就只有它自己（舊的 related_policies 互指不再參與）
 *   2. 預渲染切片與頁面畫的是同一組：lib/ssg/page-data.ts、lib/ssr/loaders.ts、頁面三處都走 lib/policy-chain.ts
 *   3. 讀取端不再碰 related_policies／relatedPolicyIds／related_policy_ids
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { isProgressCase, lineageChain, lineageMateIds, lineageMateIdsOf } from './policy-chain.ts'
import { PolicyStatus, type LineageSummary, type Policy } from '../types.ts'

const L1: LineageSummary = { id: 'l1', title: '台中捷運藍線', level: 'county', region: '台中市', subRegion: null, category: '交通建設', summary: null }
const L2: LineageSummary = { id: 'l2', title: '別件事', level: 'county', region: '台中市', subRegion: null, category: '交通建設', summary: null }

const pol = (id: string, over: Partial<Policy> = {}): Policy => ({
  id, politicianId: `pol-${id}`, electionId: 2022, title: id, description: '', category: '交通建設', status: PolicyStatus.IN_PROGRESS, proposedDate: null,
  lastUpdated: '2026-01-01', progress: 0, tags: [], logs: [], stanceSupport: 0, stanceOppose: 0, stancePriority: 0, ...over,
})

Deno.test('同一個脈絡 id 就是同一組；沒歸入脈絡只有它自己', () => {
  const all = [pol('a', { lineage: L1 }), pol('b', { lineage: L1 }), pol('c', { lineage: L2 }), pol('d')]
  assertEquals([...lineageMateIds(all[0], all)].sort(), ['a', 'b'])
  assertEquals([...lineageMateIds(all[2], all)], ['c'], '別條脈絡的不算')
  assertEquals([...lineageMateIds(all[3], all)], ['d'], '沒歸入脈絡：只有它自己，不會因為別人也沒歸入就併成一組')
  assertEquals([...lineageMateIdsOf('b', all)].sort(), ['a', 'b'])
  assertEquals([...lineageMateIdsOf('zzz', all)], ['zzz'], '找不到起點的 id：只回它自己，不丟錯')
})

Deno.test('lineageChain：照提出時間排，同時間照 id；起點不在清單裡也在鏈上；沒有政見回空', () => {
  const all = [
    pol('c', { lineage: L1, proposedDate: '2026-03-01' }),
    pol('a', { lineage: L1, proposedDate: '2018-03-01' }),
    pol('b', { lineage: L1, proposedDate: '2022-03-01' }),
    pol('x', { lineage: L2, proposedDate: '2000-01-01' }),
  ]
  assertEquals(lineageChain(all[0], all).map((p) => p.id), ['a', 'b', 'c'])
  const same = [pol('m', { lineage: L1 }), pol('k', { lineage: L1 })]
  assertEquals(lineageChain(same[0], same).map((p) => p.id), ['k', 'm'])
  const lone = pol('only', { lineage: L1 })
  assertEquals(lineageChain(lone, [pol('b', { lineage: L1 })]).map((p) => p.id).sort(), ['b', 'only'], '起點還沒進清單（單筆載入）也要在鏈上')
  assertEquals(lineageChain(undefined, all), [])
})

Deno.test('進度過半的政見：不是競選承諾而且進度大於 50；不看脈絡、不看舊的互指', () => {
  assert(isProgressCase(pol('a', { progress: 51 })))
  assertFalse(isProgressCase(pol('a', { progress: 50 })), '剛好 50 不算過半')
  assertFalse(isProgressCase(pol('a', { status: PolicyStatus.CAMPAIGN, progress: 90 })), '競選承諾不算')
  assert(isProgressCase(pol('a', { progress: 80, lineage: L1 })), '歸入脈絡的政見照樣各自一張卡')
})

Deno.test('讀取端不再讀 related_policies：型別、轉換、預渲染、邊緣渲染、三張頁面都不碰互指欄位', async () => {
  const files = [
    '../types.ts', '../composables/useSupabase.ts', './ssg/page-data.ts', './ssr/loaders.ts',
    '../pages/PolicyDetail.vue', '../pages/PolicyAnalysis.vue', '../pages/PolicyDeepAnalysis.vue',
  ]
  for (const f of files) {
    const text = await Deno.readTextFile(new URL(f, import.meta.url))
    // 註解可以提到舊名字（講為什麼拿掉），程式碼不行：去掉行內與區塊註解再比對
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    assertFalse(/relatedPolicyIds|related_policy_ids|related_policies|collectRelayChainIds/.test(code), `${f} 還在讀舊的互指欄位`)
  }
  // 三處共用同一份分組規則：改一邊沒改另一邊，預渲染切片就跟頁面畫的對不上
  const page = await Deno.readTextFile(new URL('./ssg/page-data.ts', import.meta.url))
  const loaders = await Deno.readTextFile(new URL('./ssr/loaders.ts', import.meta.url))
  assert(page.includes("from '../policy-chain'") && page.includes('lineageMateIdsOf'), '預渲染的政見頁／分析頁切片要走 lib/policy-chain.ts')
  assert(page.includes('isProgressCase'), '分析列表的政見要走 isProgressCase')
  assert(loaders.includes("from '../policy-chain'") && loaders.includes('policiesOfLineage'), '邊緣渲染的政見頁要撈同一條脈絡的政見')
  for (const f of ['PolicyDetail.vue', 'PolicyDeepAnalysis.vue']) {
    assert((await Deno.readTextFile(new URL(`../pages/${f}`, import.meta.url))).includes('lineageChain'), `${f} 要用 lineageChain`)
  }
  assert((await Deno.readTextFile(new URL('../pages/PolicyAnalysis.vue', import.meta.url))).includes('isProgressCase'))
})
