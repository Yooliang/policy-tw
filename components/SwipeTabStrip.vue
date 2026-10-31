<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { swipeStrips } from '../composables/useSwipeTabs'
import { tabStripSignature } from '../lib/tab-strip-signature'

// 手機版的頂部分頁條（X 的「為你推薦／正在跟隨」那種）：一排文字、選中的底下一條線，放不下就橫向捲動。
// 內容區的左右滑動由 useSwipeTabs 負責；底線是一個獨立元素，拖曳時由手勢直接改它的 transform（不經 Vue 響應式），
// 放開後用同一段時間移到定位的分頁。
const props = defineProps<{
  tabs: { key: string; label: string; dim?: boolean }[]
  modelValue: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', key: string): void }>()

const strip = ref<HTMLElement | null>(null)
const bar = ref<HTMLElement | null>(null)
const BAR_W = 40
let centers: number[] = []

function measure() {
  const el = strip.value
  if (!el) return
  centers = Array.from(el.querySelectorAll<HTMLElement>('[role="tab"]')).map(b => b.offsetLeft + b.offsetWidth / 2)
}
function place(pos: number, animated = false) {
  const b = bar.value
  if (!b || centers.length === 0) return
  const p = Math.max(0, Math.min(centers.length - 1, pos))
  const lo = Math.floor(p), hi = Math.ceil(p)
  const c = centers[lo]! + (centers[hi]! - centers[lo]!) * (p - lo)
  b.style.transition = animated ? 'transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
  b.style.transform = `translate3d(${c - BAR_W / 2}px,0,0)`
  b.style.opacity = '1'
}
const currentIndex = () => Math.max(0, props.tabs.findIndex(t => t.key === props.modelValue))

let ro: ResizeObserver | null = null
onMounted(() => {
  const el = strip.value
  if (!el) return
  swipeStrips.set(el, { prepare: measure, update: place })
  measure()
  place(currentIndex())
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { measure(); place(currentIndex()) })
    ro.observe(el)
  }
})
onBeforeUnmount(() => {
  if (strip.value) swipeStrips.delete(strip.value)
  ro?.disconnect()
})

watch(() => props.modelValue, async () => {
  await nextTick()
  measure()
  place(currentIndex(), true)
  const on = strip.value?.querySelector<HTMLElement>('[aria-selected="true"]')
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  on?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: calm ? 'auto' : 'smooth' })
}, { flush: 'post' })
watch(() => tabStripSignature(props.tabs), async () => { await nextTick(); measure(); place(currentIndex()) }, { flush: 'post' })
</script>

<template>
  <div ref="strip" role="tablist" data-testid="swipe-tab-strip" class="relative flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-slate-200 bg-white">
    <button
      v-for="t in tabs"
      :key="t.key"
      type="button"
      role="tab"
      :aria-selected="t.key === modelValue"
      :data-tab="t.key"
      class="relative shrink-0 grow px-4 py-3 text-[15px] font-bold whitespace-nowrap transition-colors"
      :class="t.key === modelValue ? (t.dim ? 'text-slate-400' : 'text-navy-900') : (t.dim ? 'text-slate-300' : 'text-slate-400')"
      :data-dim="t.dim ? 'true' : undefined"
      @click="emit('update:modelValue', t.key)"
    >
      {{ t.label }}
    </button>
    <span ref="bar" data-testid="swipe-tab-bar" class="pointer-events-none absolute bottom-0 left-0 h-1 w-10 rounded-full bg-blue-600 opacity-0 will-change-transform"></span>
  </div>
</template>
