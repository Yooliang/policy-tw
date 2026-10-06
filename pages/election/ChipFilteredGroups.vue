<script setup lang="ts">
/**
 * 依名稱分組的參選人卡片（2026-10-04）。
 * 2026-10-06 小良哥：列表上方不再放快篩 chip——選舉區與村里的選擇都在選舉頁右側面板（沿用同一個選擇狀態），這裡只畫分組。
 *
 * 三個地方用同一塊：
 *   村里長         依村里分組（#337 原本只在直轄市的區做，分層後縣轄鄉鎮市也用）
 *   縣市議員       依選舉區分組（一個縣市上百位，攤成一長串找不到自己那一區）
 *   原住民區代表   依選舉區分組
 *
 * 分組與排序交給 lib/village-grouping.ts 與 lib/district-grouping.ts；這裡只管畫。
 * 兩支分組函式都會把「沒填」的人收進最後一組而不是濾掉，所以 groups 的人數總和
 * 就是全部的人——這個元件不會讓任何人從畫面上消失。
 *
 * 頁內錨點（2026-10-05）：整個職位的 id 由呼叫端當 attribute 傳進來（落在根元素上），每一組的 id 用
 * groups[].anchor；根元素的 scroll-mt-20 讓錨點捲到時不被置頂的導覽列蓋住。
 */
import type { RouteLocationRaw } from 'vue-router'
import PoliticianGrid from './PoliticianGrid.vue'
import type { Politician } from '../../types'

defineProps<{
  /** 每組的標籤與人；標籤就是村里名或選舉區名。anchor＝這一組標題的頁內錨點 id（人物頁麵包屑連到這裡） */
  groups: Array<{ label: string; people: Politician[]; anchor?: string }>
  /**
   * 組標題前綴，例如「縣市議員」會讓標題變成「縣市議員・第01選舉區」。
   * 村里長不需要——那一頁的標題本來就只有村里名在變。
   */
  titlePrefix?: string
  columns?: 2 | 3
  electionId?: number
  /** 每一組標題列的「政見 PK」按鈕連到哪裡（2026-10-06）；回 undefined 的組不給按鈕（選區待補、不到兩位） */
  pkLinkFor?: (group: { label: string; people: Politician[] }) => RouteLocationRaw | undefined
}>()

</script>

<template>
  <div class="scroll-mt-20">
    <PoliticianGrid
      v-for="group in groups"
      :key="group.label"
      :id="group.anchor"
      :politicians="group.people"
      :columns="columns"
      :election-id="electionId"
      :title="titlePrefix ? `${titlePrefix}・${group.label}` : group.label"
      :pk-link="pkLinkFor?.(group)"
    ><template #icon><slot name="icon" /></template></PoliticianGrid>
  </div>
</template>
