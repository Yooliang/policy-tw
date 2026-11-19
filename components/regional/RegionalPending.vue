<script setup lang="ts">
/**
 * 「資料收集中」的淡色狀態：資料還不夠畫圖時用，不畫假圖，只印目前已有的筆數。
 * 例：三要素調查筆數、有期限日期的政見數。
 */
defineProps<{ title: string; have: number; unit: string; need?: number }>()
const fmt = (n: number) => n.toLocaleString('en-US')
</script>

<template>
  <div class="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center" data-testid="regional-pending">
    <p class="text-sm font-black text-slate-400">{{ title }}</p>
    <p class="mt-2 text-3xl font-black tabular-nums text-slate-300">{{ fmt(have) }}<span class="ml-1 text-sm font-bold">{{ unit }}</span></p>
    <p class="mt-1 text-xs font-bold text-slate-400">資料收集中<template v-if="need"> · 累積到 {{ fmt(need) }} {{ unit }}後呈現</template></p>
  </div>
</template>
