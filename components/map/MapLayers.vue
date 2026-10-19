<script setup lang="ts">
import { unitColor, type ColorMode, type MapUnit } from '../../lib/candidacy-map'
import type { Layer } from '../../lib/map-layer'

/**
 * 參選地圖的圖層與標籤（SVG 片段）。獨立成元件是為了效能：縮放、平移只改外層 svg 的 viewBox（頁面直接改屬性），
 * 這個元件的 props 不變，Vue 就不會重新比對幾百條 path；滑過、點擊、聚焦用單一事件代理（不是每條 path 一組處理函式）。
 */
export interface DrawLayer { layer: Layer; units: MapUnit[] }
export interface LabelItem { key: string; transform: string; text: string; x: number; y: number; fs: number }

defineProps<{
  layers: DrawLayer[]
  colorMode: ColorMode
  maxes: { county: number; town: number; village: number }
  labels: LabelItem[]
}>()
const emit = defineEmits<{ hover: [hit: { key: string; idx: number } | null]; pick: [hit: { key: string; idx: number }] }>()

function hitOf(el: EventTarget | null): { key: string; idx: number } | null {
  const p = (el as Element | null)?.closest?.('path[data-i]')
  return p ? { key: p.getAttribute('data-k') ?? '', idx: Number(p.getAttribute('data-i')) } : null
}
function onOver(e: MouseEvent) { emit('hover', hitOf(e.target)) }
function onOut(e: MouseEvent) { if (!hitOf(e.relatedTarget)) emit('hover', null) }
function onClick(e: MouseEvent) { const h = hitOf(e.target); if (h) emit('pick', h) }
function onKey(e: KeyboardEvent) { const h = hitOf(e.target); if (h) { e.preventDefault(); emit('pick', h) } }
</script>

<template>
  <g @mouseover="onOver" @mouseout="onOut" @click="onClick" @focusin="onOver($event as unknown as MouseEvent)" @focusout="emit('hover', null)" @keydown.enter="onKey">
    <g v-for="d in layers" :key="d.layer.key" :transform="d.layer.transform">
      <g shape-rendering="crispEdges">
        <path v-for="u in d.units" :key="u.code" :d="d.layer.fills[u.idx]" :fill="unitColor(u, colorMode, maxes[d.layer.level])"
          class="cursor-pointer" role="button" tabindex="0" :aria-label="`${u.name} ${u.candidates} 人`"
          :data-k="d.layer.key" :data-i="u.idx" :data-testid="`cell-${u.code}`" :data-count="u.candidates" />
      </g>
      <path class="map-hide-moving" :d="d.layer.boundary" fill="none" stroke="#ffffff" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linecap="square" pointer-events="none" opacity="0.85" />
    </g>
    <g class="map-hide-moving" pointer-events="none" text-anchor="middle" font-weight="800">
      <g v-for="l in labels" :key="l.key" :transform="l.transform">
        <text :x="l.x" :y="l.y + l.fs * 0.35" :font-size="l.fs" fill="#0f172a" stroke="#ffffff" :stroke-width="l.fs * 0.22" paint-order="stroke" stroke-linejoin="round" data-testid="map-label">{{ l.text }}</text>
      </g>
    </g>
  </g>
</template>
