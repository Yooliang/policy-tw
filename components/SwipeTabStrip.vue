<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

// 手機版的頂部分頁條（X 的「為你推薦／正在跟隨」那種）：一排文字、選中的底下一條線，放不下就橫向捲動。
// 內容區的左右滑動由 useSwipeTabs 負責，這裡只畫條並在選中的分頁變了時把它捲進畫面。
const props = defineProps<{
  tabs: { key: string; label: string }[]
  modelValue: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', key: string): void }>()

const strip = ref<HTMLElement | null>(null)
watch(() => props.modelValue, async () => {
  await nextTick()
  const on = strip.value?.querySelector<HTMLElement>('[aria-selected="true"]')
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  on?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: calm ? 'auto' : 'smooth' })
}, { flush: 'post' })
</script>

<template>
  <div ref="strip" role="tablist" data-testid="swipe-tab-strip" class="flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-slate-200 bg-white">
    <button
      v-for="t in tabs"
      :key="t.key"
      type="button"
      role="tab"
      :aria-selected="t.key === modelValue"
      :data-tab="t.key"
      class="relative shrink-0 grow px-4 py-3 text-[15px] font-bold whitespace-nowrap transition-colors"
      :class="t.key === modelValue ? 'text-navy-900' : 'text-slate-400'"
      @click="emit('update:modelValue', t.key)"
    >
      {{ t.label }}
      <span v-if="t.key === modelValue" class="absolute bottom-0 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-blue-600"></span>
    </button>
  </div>
</template>
