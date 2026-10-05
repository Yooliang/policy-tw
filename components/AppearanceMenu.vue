<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ALargeSmall } from 'lucide-vue-next'
import { useAppearance, initAppearance, THEME_OPTIONS, FONT_OPTIONS } from '../composables/useAppearance'

// 頁首的「顯示設定」：字級三段＋明暗三選。窄螢幕上頁首已經很擠，所以收成一顆按鈕、點開才出面板。
const { theme, font, setTheme, setFont } = useAppearance()
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
      <div class="text-xs font-bold text-slate-500 mb-2">文字大小</div>
      <div class="grid grid-cols-3 gap-1.5 mb-4" role="group" aria-label="文字大小">
        <button
          v-for="opt in FONT_OPTIONS"
          :key="opt.value"
          type="button"
          :aria-pressed="font === opt.value"
          :class="`py-2 rounded-lg border font-bold transition-colors ${
            font === opt.value
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
          }`"
          @click="setFont(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>

      <div class="text-xs font-bold text-slate-500 mb-2">色彩模式</div>
      <div class="grid grid-cols-3 gap-1.5" role="group" aria-label="色彩模式">
        <button
          v-for="opt in THEME_OPTIONS"
          :key="opt.value"
          type="button"
          :aria-pressed="theme === opt.value"
          :class="`py-2 rounded-lg border text-sm font-bold transition-colors ${
            theme === opt.value
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
          }`"
          @click="setTheme(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>
  </div>
</template>
