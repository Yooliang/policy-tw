<script setup lang="ts">
/**
 * 一排名稱快篩 chip ＋ 依該名稱分組的參選人卡片（2026-10-04）。
 *
 * 三個地方用同一塊：
 *   村里長         依村里分組（#337 原本只在直轄市的區做，分層後縣轄鄉鎮市也用）
 *   縣市議員       依選舉區分組（一個縣市上百位，攤成一長串找不到自己那一區）
 *   原住民區代表   依選舉區分組
 *
 * 分組與排序交給 lib/village-grouping.ts 與 lib/district-grouping.ts；這裡只管畫。
 * 兩支分組函式都會把「沒填」的人收進最後一組而不是濾掉，所以 groups 的人數總和
 * 就是全部的人——這個元件不會讓任何人從畫面上消失。
 */
import PoliticianGrid from './PoliticianGrid.vue'
import type { Politician } from '../../types'

defineProps<{
  /** 每組的標籤與人；標籤就是村里名或選舉區名 */
  groups: Array<{ label: string; people: Politician[] }>
  /** 可以點的快篩項（已排序，不含「沒填」那一組——那不是一個點得下去的選項） */
  chips: readonly string[]
  /** 目前選中的快篩項；'All' ＝沒有篩 */
  selected: string
  /**
   * 組標題前綴，例如「縣市議員」會讓標題變成「縣市議員・第01選舉區」。
   * 村里長不需要——那一頁的標題本來就只有村里名在變。
   */
  titlePrefix?: string
  columns?: 2 | 3
  electionId?: number
}>()

defineEmits<{ toggle: [value: string] }>()
</script>

<template>
  <div>
    <div v-if="chips.length > 1" class="flex flex-wrap gap-1.5 mb-6">
      <button
        v-for="chip in chips"
        :key="chip"
        @click="$emit('toggle', chip)"
        :class="`px-3 py-1 rounded-full text-xs font-bold transition-all border ${selected === chip ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-slate-600 border-slate-200 hover:bg-amber-50'}`"
        :aria-pressed="selected === chip"
      >{{ chip }}</button>
    </div>
    <PoliticianGrid
      v-for="group in groups"
      :key="group.label"
      :politicians="group.people"
      :columns="columns"
      :election-id="electionId"
      :title="titlePrefix ? `${titlePrefix}・${group.label}` : group.label"
    ><template #icon><slot name="icon" /></template></PoliticianGrid>
  </div>
</template>
