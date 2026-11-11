<script setup lang="ts">
import { computed } from 'vue'

// 派工日程底部的直立長條圖：長條由下往上長，數字在上、名稱在下，滑過看完整說明。
// 純顯示元件，不讀資料；數字由呼叫端算好傳進來。
const props = defineProps<{
  items: { key: string; label: string; value: number | null; title?: string; color?: string }[]
  /** 長條區的參考高度（px），只用來算最小高度，實際高度由容器決定 */
  height?: number
}>()

const h = computed(() => props.height ?? 120)
const max = computed(() => Math.max(1, ...props.items.map((i) => i.value ?? 0)))
const fmt = (n: number) => n.toLocaleString('zh-TW')
/** 長條高度＝佔容器的百分比（高度由容器決定）；有數字另設至少 2px，免得很小的值看不見 */
const barPct = (v: number | null) => (v ? (v / max.value) * 100 : 0)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden" :style="{ minHeight: `${h + 48}px` }" data-testid="dispatch-bars">
    <div class="flex min-h-0 w-full flex-1 items-stretch gap-1 sm:gap-2">
      <div v-for="i in items" :key="i.key" class="flex min-h-0 min-w-0 flex-1 flex-col items-center" :title="i.title ?? `${i.label}：${i.value == null ? '—' : fmt(i.value)}`">
        <div class="mb-1 max-w-full break-all text-center text-[11px] leading-tight tabular-nums text-slate-600">{{ i.value == null ? '—' : fmt(i.value) }}</div>
        <div class="flex min-h-0 w-full flex-1 items-end justify-center border-b border-slate-300" :style="{ minHeight: `${h * 0.6}px` }">
          <div class="w-full max-w-10 rounded-t-sm" :style="{ height: `${barPct(i.value)}%`, minHeight: i.value ? '2px' : '0', background: i.color ?? '#3b82f6' }"></div>
        </div>
        <div class="mt-1 w-full overflow-hidden break-words text-center text-[11px] leading-tight text-slate-500 [text-wrap:balance]">{{ i.label }}</div>
      </div>
    </div>
  </div>
</template>
