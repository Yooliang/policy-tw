<script setup lang="ts">
import { LayoutGrid, List } from 'lucide-vue-next'
import type { ColorMode } from '../../lib/candidacy-map'

/** 參選地圖的兩組切換：著色（收錄率／人數）、呈現（地圖／清單） */
defineProps<{ colorMode: ColorMode; mode: 'grid' | 'list' }>()
defineEmits<{ 'update:colorMode': [ColorMode]; 'update:mode': ['grid' | 'list'] }>()
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
    <div class="flex rounded-xl border border-slate-200 bg-white/95 overflow-hidden shadow-sm" role="group" aria-label="呈現方式">
      <button type="button" :aria-pressed="mode === 'grid'" data-testid="map-mode-grid"
        :class="['px-3 py-2 text-sm font-black inline-flex items-center gap-1.5', mode === 'grid' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600']"
        @click="$emit('update:mode', 'grid')"><LayoutGrid :size="14" />地圖</button>
      <button type="button" :aria-pressed="mode === 'list'" data-testid="map-mode-list"
        :class="['px-3 py-2 text-sm font-black inline-flex items-center gap-1.5', mode === 'list' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600']"
        @click="$emit('update:mode', 'list')"><List :size="14" />清單</button>
    </div>
  </div>
</template>
