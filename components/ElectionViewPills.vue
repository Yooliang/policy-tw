<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { VIEW_TABS, type ElectionViewMode } from '../lib/election-view-tabs'

/**
 * 手機版的檢視模式小膠囊（候選人／承諾／串聯／PK／矩陣）：取代手機上整塊深色標題區，一行、可橫向滑。
 * 有 viewLink 就是連結（矩陣頁用）；沒給就是按鈕，點了 emit select（選舉頁頁內切換）。橫向捲動區標了 data-no-swipe，不和內容區左右滑手勢衝突。
 */
const props = defineProps<{
  view: ElectionViewMode | 'matrix'
  hasMatrix: boolean
  electionSeg: string
  viewLink?: (view: ElectionViewMode) => RouteLocationRaw
  /** 放在深色標題區裡用的配色 */
  dark?: boolean
}>()
defineEmits<{ select: [view: ElectionViewMode] }>()

const BASE = 'inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-bold whitespace-nowrap'
const ON = props.dark ? 'border-transparent bg-white text-navy-900' : 'border-navy-900 bg-navy-900 text-white'
const OFF = props.dark ? 'border-white/25 bg-white/10 text-white' : 'border-slate-200 bg-white text-slate-600'
</script>

<template>
  <div class="flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-no-swipe data-testid="view-pills">
    <template v-for="v in VIEW_TABS" :key="v.key">
      <RouterLink v-if="viewLink" :to="viewLink(v.key)" :class="[BASE, view === v.key ? ON : OFF]">{{ v.short }}</RouterLink>
      <button v-else type="button" :class="[BASE, view === v.key ? ON : OFF]" :aria-pressed="view === v.key" @click="$emit('select', v.key)">{{ v.short }}</button>
    </template>
    <RouterLink v-if="hasMatrix" :to="`/election/${electionSeg}/matrix`" :class="[BASE, view === 'matrix' ? ON : OFF]">矩陣</RouterLink>
  </div>
</template>
