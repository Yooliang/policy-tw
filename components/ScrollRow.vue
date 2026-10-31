<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

/**
 * 可橫向捲動的列（晶片列、膠囊列）共用外殼（2026-10-31）：桌面有滑鼠（hover＋pointer: fine）時，左右兩端疊半透明圓形箭頭，
 * 只有該方向還有內容可捲才顯示，旁邊的漸層遮罩讓被切掉的晶片淡出；點箭頭捲約 80% 可視寬度（smooth，尊重 prefers-reduced-motion）；
 * 滑鼠滾輪在列上直接轉成橫向捲動（不必按 Shift；該方向捲到底就放行給頁面）。觸控裝置不畫箭頭、不攔滾輪。
 *
 * 所有 attribute（class、data-*、v-for 的內容）都落在「真正捲動的那一層」上，原本的樣式與選擇器（例如找 [data-active] 的父層）不用改。
 * fadeClass：漸層遮罩的起色要跟列後面的底色一樣（預設頁面底色 slate-50；白底的列傳 sr-fade-white）。
 */
defineOptions({ inheritAttrs: false })
withDefaults(defineProps<{ fadeClass?: string }>(), { fadeClass: '' })

const scroller = ref<HTMLElement | null>(null)
const canLeft = ref(false)
const canRight = ref(false)
const fine = ref(false)
let ro: ResizeObserver | null = null
let mo: MutationObserver | null = null
let raf = 0

function update() {
  raf = 0
  const el = scroller.value
  if (!el) return
  canLeft.value = el.scrollLeft > 1
  canRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}
function schedule() { if (!raf) raf = requestAnimationFrame(update) }

function reduced() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches }
function go(dir: -1 | 1) {
  const el = scroller.value
  if (!el) return
  el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: reduced() ? 'auto' : 'smooth' })
}
function onWheel(e: WheelEvent) {
  const el = scroller.value
  if (!el || !fine.value || e.ctrlKey || e.shiftKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
  const max = el.scrollWidth - el.clientWidth
  if (max <= 1) return
  const next = el.scrollLeft + e.deltaY
  if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return // 到頭了：交還給頁面捲動
  e.preventDefault()
  el.scrollLeft = Math.max(0, Math.min(max, next))
}

onMounted(async () => {
  fine.value = window.matchMedia('(hover: hover) and (pointer: fine)').matches
  await nextTick()
  const el = scroller.value
  if (!el) return
  update()
  el.addEventListener('scroll', schedule, { passive: true })
  el.addEventListener('wheel', onWheel, { passive: false })
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(schedule); ro.observe(el) }
  mo = new MutationObserver(schedule) // 晶片增減（換縣市、換分頁）時重算
  mo.observe(el, { childList: true, subtree: true })
})
onBeforeUnmount(() => {
  const el = scroller.value
  el?.removeEventListener('scroll', schedule)
  el?.removeEventListener('wheel', onWheel)
  ro?.disconnect()
  mo?.disconnect()
  if (raf) cancelAnimationFrame(raf)
})
</script>

<template>
  <div class="relative" data-testid="scroll-row">
    <div ref="scroller" v-bind="$attrs"><slot /></div>
    <template v-if="fine">
      <div v-if="canLeft" class="sr-fade sr-fade-l pointer-events-none absolute inset-y-0 left-0 w-12" :class="fadeClass" aria-hidden="true"></div>
      <div v-if="canRight" class="sr-fade sr-fade-r pointer-events-none absolute inset-y-0 right-0 w-12" :class="fadeClass" aria-hidden="true"></div>
      <button v-if="canLeft" type="button" aria-label="向左捲動" data-testid="scroll-row-left" class="absolute left-1 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/80 text-slate-600 shadow-md backdrop-blur-sm transition-colors hover:bg-white hover:text-navy-900" @click="go(-1)"><ChevronLeft :size="18" /></button>
      <button v-if="canRight" type="button" aria-label="向右捲動" data-testid="scroll-row-right" class="absolute right-1 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/80 text-slate-600 shadow-md backdrop-blur-sm transition-colors hover:bg-white hover:text-navy-900" @click="go(1)"><ChevronRight :size="18" /></button>
    </template>
  </div>
</template>
