<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { User } from 'lucide-vue-next'

/**
 * 提交者、驗證者、回答者的代號收成一顆小人形圖示（2026-10-08，維護者，#475；接續 #457 的模型名 info 圖示，原 ModelInfo 泛化成這個）：
 * 政見頁與候選人頁的重點不是 AI 是誰，但這個資訊要保留，所以滑過去或點一下才看得到。
 * 代號與模型名都是值，照原樣顯示；圖示的名稱（aria-label）由 label 決定，例如「提交者」「驗證者」。
 *
 * 代號與模型合併成同一顆圖示、同一個提示框（「提交者：涼糕｜模型：claude-sonnet-5」），不分兩顆：
 * 兩者是同一個行動者的屬性，一列放兩顆小圖示太擠、手機上也很難分別點中；沒有模型時只顯示代號。
 *
 * 行為：
 * - 桌機：滑鼠移上去顯示、移開收起（只認滑鼠；觸控點一下也會送出 pointerenter，不能拿它當「開」，否則第二下收不掉）
 * - 手機／點擊：點一下顯示，再點一下或點外面或按 Esc 關閉
 * - 鍵盤：Tab 到圖示（focus-visible）就顯示，內容用 aria-describedby 掛在按鈕上
 * 這個元件常放在整列可點的區塊旁邊，所以點擊一律 stop，不會連帶展開那一列。
 * 貢獻看板與社群頁是透明度頁面，不用這顆，直接把代號寫出來。
 */
const props = withDefaults(defineProps<{ name?: string | null; model?: string | null; label?: string }>(), { name: null, model: null, label: '提交者' })

/** 提示框的內容：代號沒有就寫「不明」，模型有才接 */
const text = computed(() => `${props.label}：${props.name || '不明'}${props.model ? `｜模型：${props.model}` : ''}`)

const uid = `agent-info-${Math.random().toString(36).slice(2, 9)}`
const root = ref<HTMLElement | null>(null)
const pinned = ref(false)
const hovering = ref(false)
const focused = ref(false)
const visible = computed(() => pinned.value || hovering.value || focused.value)

function onPointerEnter(e: PointerEvent) { if (e.pointerType === 'mouse') hovering.value = true }
function onPointerLeave(e: PointerEvent) { if (e.pointerType === 'mouse') hovering.value = false }
function onFocus(e: FocusEvent) {
  // 滑鼠點下去也會 focus；只有鍵盤聚焦才用 focus 顯示，點擊的開關交給 pinned
  focused.value = (e.target as HTMLElement).matches(':focus-visible')
}
function onBlur() { focused.value = false }
function toggle() { pinned.value = !pinned.value }
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && visible.value) {
    pinned.value = false
    focused.value = false
    hovering.value = false
  }
}

function onDocPointerDown(e: Event) {
  if (root.value && !root.value.contains(e.target as Node)) pinned.value = false
}
watch(pinned, (on) => {
  if (on) document.addEventListener('pointerdown', onDocPointerDown)
  else document.removeEventListener('pointerdown', onDocPointerDown)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown))
</script>

<template>
  <span ref="root" class="relative inline-flex align-middle" data-testid="agent-info" @pointerenter="onPointerEnter" @pointerleave="onPointerLeave">
    <button
      type="button"
      class="inline-flex items-center justify-center rounded-full text-slate-400 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      :aria-label="label"
      :aria-expanded="visible"
      :aria-describedby="visible ? uid : undefined"
      @click.stop.prevent="toggle"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    >
      <User :size="13" />
    </button>
    <span
      v-show="visible"
      :id="uid"
      role="tooltip"
      class="absolute left-0 top-full z-20 mt-1 w-max max-w-[min(18rem,80vw)] rounded-md bg-navy-900 px-2 py-1 text-xs font-normal leading-snug text-white shadow-lg break-all"
      data-testid="agent-info-text"
    >{{ text }}</span>
  </span>
</template>
