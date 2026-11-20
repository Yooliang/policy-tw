/**
 * 完整關係圖頁的元件接線守門（#675 第四期；元件本身不在 deno 裡渲染，所以讀原始碼盯幾個不能掉的接線）：
 *   載入（掛載後才撈、失敗用 LoadError、不顯示成找不到）、手機與桌機吃同一份輸出、抽屜 Esc 與背景關閉、不用 ApexCharts、單檔不過長。
 */
import { assert, assertFalse } from 'jsr:@std/assert@1'

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url)).then((s) => s.replace(/\r\n/g, '\n'))

Deno.test('載入：onMounted 後才撈；脈絡與政見、任期、人物的撈取都掛在 mounted 之後；失敗用 LoadError（任期用 inline），不顯示成「找不到」', async () => {
  const page = await read('../pages/LineageGraphPage.vue')
  assert(/onMounted\(\(\) => \{\s*mounted\.value = true/.test(page))
  assert(/watch\(\[mounted, lineageId\], async \(\[ready, id\]\) => \{\s*if \(!ready \|\| !id \|\| lineage\.value\) return/.test(page), '脈絡要等 mounted')
  assert(/watch\(\[mounted, lineage\], async \(\[ready, l\]\) => \{\s*if \(!ready \|\| !l\) return/.test(page), '政見、任期、人物要等 mounted')
  assert(page.includes('<LoadError v-if="termsFailed" inline') && page.includes('<LoadError v-else-if="error" />'), '失敗用 LoadError')
  // 任一段載入失敗（政見、人物等只寫全域 error）就不畫半張圖：圖的分支要排除 error，LoadError 才接得到
  assert(page.includes('<div v-if="lineage && model && !error"'), '有 error 時不畫圖（沒有政見點、人名全是姓名待查的半張圖）')
  assert(page.indexOf('<div v-if="lineage && model && !error"') < page.indexOf('<LoadError v-else-if="error" />'))
  // 讀取失敗（error）的分支要在「找不到」之前
  assert(page.indexOf('<LoadError v-else-if="error" />') < page.indexOf('T.notFound'))
  const terms = await read('../composables/useLineageTerms.ts')
  assert(terms.includes("from('lineage_terms')") && terms.includes('isMissingRelation(err)') && terms.includes('failed.value = true'))
  assert(terms.includes(".order('start_date')"), '查詢要有 order（query-bounds）')
})

Deno.test('手機（≤ 640 px）不畫 SVG：直式時間軸是主體；桌機畫 SVG、圖下方放同內容的時序清單；兩邊吃同一個 model', async () => {
  const page = await read('../pages/LineageGraphPage.vue')
  assert(page.includes("window.matchMedia('(max-width: 640px)')"))
  assert(page.includes('<LineageGraphList v-if="isMobile" :items="model.items" variant="main"'), '手機：清單是主體')
  assert(page.includes('<LineageGraphSvg :model="model"') && page.includes('<LineageGraphList :items="model.items" variant="a11y"'), '桌機：圖＋給讀屏的清單')
  assert(/<LineageGraphList v-if="isMobile"[\s\S]*<template v-else>[\s\S]*<LineageGraphSvg/.test(page), 'SVG 只在非手機版渲染')
  const list = await read('../components/LineageGraphList.vue')
  assert(list.includes("'sr-only'") && list.includes('placeChips(props.items)') && list.includes('groupItemsByYear('), '晶片篩選、依年分組')
})

Deno.test('抽屜：Esc 與背景關閉；手機是底部抽屜、桌機是右側；點圖上標籤與清單項目都開同一個抽屜', async () => {
  const drawer = await read('../components/LineageGraphDrawer.vue')
  assert(/e\.key === 'Escape' && props\.item\) emit\('close'\)/.test(drawer), 'Esc 關閉')
  assert(/data-testid="lineage-graph-backdrop" @click="emit\('close'\)"/.test(drawer), '背景關閉')
  assert(drawer.includes('inset-x-0 bottom-0') && drawer.includes('sm:right-0'), '手機底部、桌機右側')
  assert(drawer.includes('<LineageSourceLink') && drawer.includes('T.quote') && drawer.includes('T.locator'), '原文摘句、出處、出處位置')
  const page = await read('../pages/LineageGraphPage.vue')
  assert((page.match(/@select="selectedId = \$event"/g) ?? []).length === 3, '圖與兩種清單都開同一個抽屜')
  const svg = await read('../components/LineageGraphSvg.vue')
  assert(svg.includes(`@click="emit('select', m.id)"`) && svg.includes(`@click="emit('select', a.eventId)"`), '標籤與箭頭都可點')
})

Deno.test('不用 ApexCharts；排版純函式與元件各自不過長（單檔 < 800 行）', async () => {
  for (const f of ['../pages/LineageGraphPage.vue', '../components/LineageGraphSvg.vue', '../components/LineageGraphList.vue', '../components/LineageGraphDrawer.vue', '../lib/lineage-graph.ts']) {
    const src = await read(f)
    assertFalse(/apexcharts/i.test(src), `${f} 不用 ApexCharts`)
    assert(src.split('\n').length < 800, `${f} 超過 800 行`)
  }
  const pure = await read('../lib/lineage-graph.ts') + await read('../lib/lineage-graph-terms.ts') + await read('../lib/lineage-graph-list.ts')
  assertFalse(/from 'vue'|from "vue"|document\.|window\./.test(pure), '排版純函式零執行期依賴，不碰 vue 與瀏覽器')
})
