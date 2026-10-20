<script setup lang="ts">
import type { ColorMode } from '../../lib/candidacy-map'

/** 參選地圖的著色切換（收錄率／人數） */
defineProps<{ colorMode: ColorMode }>()
defineEmits<{ 'update:colorMode': [ColorMode] }>()
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <div class="flex rounded-xl border border-slate-200 bg-white/95 overflow-hidden shadow-sm" role="group" aria-label="著色">
      <button type="button" :aria-pressed="colorMode === 'coverage'" data-testid="map-color-coverage"
        :class="['px-3 py-2 text-sm font-black', colorMode === 'coverage' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-800']"
        @click="$emit('update:colorMode', 'coverage')">收錄率</button>
      <button type="button" :aria-pressed="colorMode === 'count'" data-testid="map-color-count"
        :class="['px-3 py-2 text-sm font-black', colorMode === 'count' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-800']"
        @click="$emit('update:colorMode', 'count')">人數</button>
    </div>
  </div>
</template>
