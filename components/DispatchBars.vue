<script setup lang="ts">
import { computed } from 'vue'

// 派工日程底部的直立長條圖：長條由下往上長，數字在上、名稱在下，滑過看完整說明。
// 純顯示元件，不讀資料；數字由呼叫端算好傳進來。
const props = defineProps<{
  items: { key: string; label: string; value: number | null; title?: string; color?: string }[]
  /** 長條區高度（px） */
  height?: number
}>()

const h = computed(() => props.height ?? 120)
const max = computed(() => Math.max(1, ...props.items.map((i) => i.value ?? 0)))
const fmt = (n: number) => n.toLocaleString('zh-TW')
/** 有數字就至少 2px，免得很小的值看不見 */
const barPx = (v: number | null) => (v ? Math.max(2, Math.round((v / max.value) * h.value)) : 0)
</script>

<template>
  <div class="overflow-x-auto" data-testid="dispatch-bars">
    <div class="flex min-w-full items-end gap-2" :style="{ width: `max(100%, ${items.length * 56}px)` }">
      <div v-for="i in items" :key="i.key" class="flex min-w-0 flex-1 flex-col items-center" :title="i.title ?? `${i.label}：${i.value == null ? '—' : fmt(i.value)}`">
        <div class="mb-1 text-xs tabular-nums text-slate-600">{{ i.value == null ? '—' : fmt(i.value) }}</div>
        <div class="flex w-full items-end justify-center border-b border-slate-300" :style="{ height: `${h}px` }">
          <div class="w-full max-w-10 rounded-t-sm" :style="{ height: `${barPx(i.value)}px`, background: i.color ?? '#3b82f6' }"></div>
        </div>
        <div class="mt-1 w-full break-words text-center text-[11px] leading-tight text-slate-500">{{ i.label }}</div>
      </div>
    </div>
  </div>
</template>
