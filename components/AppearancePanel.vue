<script setup lang="ts">
import { useAppearance, THEME_OPTIONS, FONT_OPTIONS } from '../composables/useAppearance'

// 字級三段＋明暗三選的選項區。桌面版的 AppearanceMenu 與手機版的 MobileMenu 共用同一份，
// 狀態在 useAppearance（模組級），兩邊不會各存各的。
const { theme, font, setTheme, setFont } = useAppearance()
</script>

<template>
  <div>
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
</template>
