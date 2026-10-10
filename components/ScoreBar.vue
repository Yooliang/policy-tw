<script setup lang="ts">
import { computed } from 'vue'
import { scoreBarTitle, scorePercent } from '../lib/score-bar'

/**
 * 分數拉鋸條（使用者 2026-09-21）：不是按讚數，是兩邊角力——左端 −目標＝退件、右端 ＋目標＝通過，
 * 標記在現在的分數。從中線往右填綠、往左填紅。貢獻看板與查核履歷共用，兩邊的畫面要一樣。
 * 純模板、沒有任何只有瀏覽器才有的東西，預渲染與邊緣渲染都能直接用。
 * 目標分數不是正數（舊資料沒帶）就整條不畫。
 */
const props = defineProps<{
  score: number | null | undefined
  target: number | null | undefined
  /** 三種票數，只用來寫進滑過去的說明，不畫在條上 */
  agree?: number
  disagree?: number
  unsure?: number
  /** 窄版（任務頁，維護者 2026-10-10「寬度小一些」） */
  narrow?: boolean
}>()

const s = computed(() => props.score ?? 0)
const t = computed(() => props.target ?? 0)
const pct = computed(() => scorePercent(props.score, props.target))
const title = computed(() => scoreBarTitle(s.value, t.value, { agree: props.agree, disagree: props.disagree, unsure: props.unsure }))
const fillStyle = computed(() => (s.value >= 0 ? { left: '50%', width: `${pct.value - 50}%` } : { left: `${pct.value}%`, width: `${50 - pct.value}%` }))
</script>

<template>
  <span v-if="t > 0" class="inline-flex items-center gap-1 text-xs tabular-nums text-slate-400" :title="title" data-testid="score-bar">
    <span class="text-red-500">−{{ t }}</span>
    <span class="relative inline-block h-2 rounded-full bg-slate-200 overflow-hidden" :class="narrow ? 'w-14' : 'w-24'">
      <span class="absolute top-0 bottom-0 left-1/2 w-px bg-slate-400"></span>
      <span class="absolute top-0 bottom-0" :class="s >= 0 ? 'bg-emerald-500' : 'bg-red-500'" :style="fillStyle"></span>
      <span class="score-bar-tick absolute -top-0.5 w-1 h-3 rounded-sm bg-navy-900" :style="{ left: `calc(${pct}% - 2px)` }"></span>
    </span>
    <span class="text-emerald-600">+{{ t }}</span>
  </span>
</template>
