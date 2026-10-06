<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ALargeSmall } from 'lucide-vue-next'
import { initAppearance } from '../composables/useAppearance'
import AppearancePanel from './AppearancePanel.vue'

// 桌面版頁首的「顯示設定」：字級三段＋明暗三選，收成一顆按鈕、點開才出面板。
// 手機版（sm 以下）改放進 MobileMenu 的下拉裡，這顆在手機上不顯示。
const open = ref(false)
const root = ref<HTMLElement | null>(null)

function onDocClick(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  initAppearance()
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="bg-slate-100 hover:bg-slate-200 text-navy-900 w-9 h-9 rounded-full flex items-center justify-center transition-colors border border-slate-200"
      aria-label="顯示設定：字級與明暗"
      title="顯示設定：字級與明暗"
      :aria-expanded="open"
      @click="open = !open"
    >
      <ALargeSmall :size="22" />
    </button>

    <div
      v-if="open"
      class="absolute right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-2xl shadow-xl p-4 z-50"
      role="dialog"
      aria-label="顯示設定"
    >
      <AppearancePanel />
    </div>
  </div>
</template>
