/**
 * 政見矩陣甜甜圈圖的算法：前 N 名＋其他、占比、全台／選縣市兩種範圍的原料、顏色。
 */
import { assertEquals } from 'jsr:@std/assert@1'
import type { Matrix } from './md/dataset.ts'
import { BRAND } from './brand-colors.ts'
import { MATRIX_TOP_N, OTHER_KEY, categoryItems, regionItems, sliceColors, topSlices } from './matrix-share.ts'

const items = (...vals: number[]) => vals.map((value, i) => ({ key: `k${i}`, value }))

Deno.test('不超過 N+1 項：全部列出，大到小，占比加起來是 1', () => {
  const s = topSlices(items(10, 30, 20), '其他')
  assertEquals(s.map((x) => x.key), ['k1', 'k2', 'k0'])
  assertEquals(s.map((x) => x.value), [30, 20, 10])
  assertEquals(s.map((x) => x.isOther), [false, false, false])
  assertEquals(s.map((x) => x.share), [0.5, 1 / 3, 1 / 6])
})

Deno.test('超過前 8 名：第 9 名起合成「其他」，筆數是它們的和', () => {
  // 10 項：100,90,...,10 → 前 8 = 100..30，其餘 = 20 + 10
  const s = topSlices(items(100, 90, 80, 70, 60, 50, 40, 30, 20, 10), '其他')
  assertEquals(s.length, MATRIX_TOP_N + 1)
  assertEquals(s.slice(0, 8).map((x) => x.value), [100, 90, 80, 70, 60, 50, 40, 30])
  const other = s[8]
  assertEquals(other.isOther, true)
  assertEquals(other.key, OTHER_KEY)
  assertEquals(other.label, '其他')
  assertEquals(other.value, 30)
  assertEquals(s.reduce((a, x) => a + x.value, 0), 550)
  assertEquals(s.reduce((a, x) => a + x.share, 0) > 0.999999, true)
})

Deno.test('剛好 9 項：只剩一項不合成「其他」（單項的其他不省版面又藏名字）', () => {
  const s = topSlices(items(9, 8, 7, 6, 5, 4, 3, 2, 1), '其他')
  assertEquals(s.length, 9)
  assertEquals(s.some((x) => x.isOther), false)
  assertEquals(s[8].key, 'k8')
})

Deno.test('0 筆的不畫、全是 0 回空陣列；同筆數維持輸入順序', () => {
  assertEquals(topSlices(items(0, 0), '其他'), [])
  assertEquals(topSlices([], '其他'), [])
  const s = topSlices(items(5, 0, 5, 5), '其他')
  assertEquals(s.map((x) => x.key), ['k0', 'k2', 'k3'])
})

Deno.test('真的有一個分類叫「其他」時，不會跟合併項搞混：靠旗標不靠名字', () => {
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, value: 100 - i })),
    { key: '其他', value: 1 },
  ]
  const s = topSlices(rows, '其餘分類')
  const real = s.find((x) => x.key === '其他')
  assertEquals(real, undefined) // 它排在第 10 名，被合進合併項
  assertEquals(s[8].isOther, true)
  assertEquals(s[8].label, '其餘分類')
  // 排進前 8 的「其他」分類仍是真分類、可點
  const s2 = topSlices([{ key: '其他', value: 500 }, ...rows], '其餘分類')
  const real2 = s2.find((x) => x.key === '其他')
  assertEquals(real2?.isOther, false)
  assertEquals(real2?.label, '其他')
})

const matrix = {
  election: { id: 2026, segment: '2026', name: '2026', year: '2026' },
  regions: ['甲市', '乙縣', '丙縣'],
  categories: ['教育', '交通', '其他'],
  counts: {
    甲市: { 教育: 4, 交通: 6, 其他: 0 },
    乙縣: { 教育: 1, 交通: 0, 其他: 2 },
    丙縣: { 教育: 0, 交通: 0, 其他: 0 },
  },
  regionTotals: { 甲市: 10, 乙縣: 3, 丙縣: 0 },
  categoryTotals: { 教育: 5, 交通: 6, 其他: 2 },
  total: 13,
} as Matrix

Deno.test('左圖原料：全台用 categoryTotals，選縣市用那個縣市的分類筆數，不認得的縣市當全台', () => {
  assertEquals(categoryItems(matrix, 'All'), [
    { key: '教育', value: 5 }, { key: '交通', value: 6 }, { key: '其他', value: 2 },
  ])
  assertEquals(categoryItems(matrix, '甲市'), [
    { key: '教育', value: 4 }, { key: '交通', value: 6 }, { key: '其他', value: 0 },
  ])
  assertEquals(categoryItems(matrix, '不存在市'), categoryItems(matrix, 'All'))
})

Deno.test('右圖原料：全台是各縣市總數；選縣市是「所選」與「其他縣市合計」兩塊', () => {
  assertEquals(regionItems(matrix, 'All'), [
    { key: '甲市', value: 10 }, { key: '乙縣', value: 3 }, { key: '丙縣', value: 0 },
  ])
  assertEquals(regionItems(matrix, '乙縣'), [{ key: '乙縣', value: 3 }, { key: OTHER_KEY, value: 10 }])
  // 兩塊加起來＝全台
  assertEquals(regionItems(matrix, '甲市').reduce((a, x) => a + x.value, 0), matrix.total)
  const s = topSlices(regionItems(matrix, '乙縣'), '其他縣市')
  assertEquals(s.map((x) => [x.label, x.isOther]), [['其他縣市', true], ['乙縣', false]])
  // 所選縣市沒有資料：只剩「其他縣市」一塊
  assertEquals(topSlices(regionItems(matrix, '丙縣'), '其他縣市').map((x) => x.key), [OTHER_KEY])
})

Deno.test('顏色：前幾名依序取色盤，合併項固定灰，色盤用完會循環', () => {
  const s = topSlices(items(100, 90, 80, 70, 60, 50, 40, 30, 20, 10), '其他')
  const colors = sliceColors(s)
  assertEquals(colors.length, s.length)
  assertEquals(colors[8], BRAND.other)
  assertEquals(new Set(colors.slice(0, 8)).size, 8) // 前 8 塊顏色互不相同
  assertEquals(colors.slice(0, 8).includes(BRAND.other), false)
})

Deno.test('矩陣頁接線：圖只在瀏覽器載入、預留固定高度、提示框不放百分比、用這支算法', async () => {
  const page = await Deno.readTextFile(new URL('../pages/PolicyMatrix.vue', import.meta.url))
  assertEquals(/defineAsyncComponent\(\(\) => import\('vue3-apexcharts'\)\)/.test(page), true, '非同步載入，跟 Home、Stats 同一個寫法')
  assertEquals(/<ClientOnly><apexchart [^>]*type="donut"/.test(page), true, '圖包在 ClientOnly 裡')
  assertEquals(page.includes('h-[22rem]'), true, '圖的外框有固定高度，載入前後版面不跳')
  assertEquals(page.includes("from '../lib/matrix-share'"), true)
  assertEquals(page.includes('topSlices(categoryItems('), true)
  assertEquals(page.includes('topSlices(regionItems('), true)
  assertEquals(page.includes('formatter: (v: number) => `${v} 筆`'), true, '提示框只放筆數')
  assertEquals(page.includes('toggleDataSeries: false'), true, '圖例不能隱藏切片（隱藏後中間的總數對不上）')
})
