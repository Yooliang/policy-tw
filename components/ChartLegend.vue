<script setup lang="ts">
/**
 * 自己畫的圖例，長相對齊 ApexCharts 的底部圖例（lib/chart-style.ts 的 CHART_LEGEND）：
 * 12px 圓點（ApexCharts 的半徑 5 圓＋描邊）＋11px 文字、置中。給不是 ApexCharts 畫的圖用（運作狀態、貢獻榜）。
 *
 * 傳了 toggle 就能點：沒選的那幾項圓點變空心、字變淡，跟 ApexCharts 點掉圖例的樣子一致。
 */

export interface LegendItem {
  key: string
  label: string
  color: string
  /** 沒給＝一律當作選中（純圖例、不能點） */
  active?: boolean
  /** 圖例文字後面的數字（例如最新值）；不給就不顯示 */
  value?: string
}

const props = defineProps<{ items: readonly LegendItem[]; clickable?: boolean }>()
const emit = defineEmits<{ (e: 'toggle', key: string): void }>()

function isActive(item: LegendItem): boolean {
  return item.active ?? true
}
function onClick(item: LegendItem) {
  if (props.clickable) emit('toggle', item.key)
}
</script>

<template>
  <div class="flex flex-wrap justify-center gap-x-3 gap-y-1 mt-2" data-testid="chart-legend">
    <component :is="clickable ? 'button' : 'span'" v-for="item in items" :key="item.key"
      :type="clickable ? 'button' : undefined"
      :aria-pressed="clickable ? isActive(item) : undefined"
      :class="['inline-flex items-center gap-1.5 text-[11px] transition-opacity', isActive(item) ? 'text-slate-700' : 'text-slate-400', clickable ? 'cursor-pointer hover:opacity-80' : '']"
      @click="onClick(item)">
      <span class="w-3 h-3 rounded-full border-2 shrink-0"
        :style="{ borderColor: item.color, backgroundColor: isActive(item) ? item.color : 'transparent' }"></span>
      {{ item.label }}<span v-if="item.value" class="text-slate-400 tabular-nums">{{ item.value }}</span>
    </component>
  </div>
</template>
