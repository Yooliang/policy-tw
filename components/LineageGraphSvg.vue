<script setup lang="ts">
/**
 * 完整關係圖的 SVG（桌機，#675 第四期）：只負責畫——座標、泳道、任期條、標籤、箭頭都是 lib/lineage-graph.ts 算好的。
 * 點任何標籤或箭頭 → select（id 與時序清單的項目相同）。字全取自 lib/lineage-page-labels.ts。
 */
import type { GraphModel, GraphMark } from '../lib/lineage-graph-types'
import { EVENT_COLOR, LAYOUT, TONE_COLOR } from '../lib/lineage-graph-types'
import { PAGE_LABELS as T } from '../lib/lineage-page-labels'

defineProps<{ model: GraphModel; selectedId: string | null }>()
const emit = defineEmits<{ select: [id: string] }>()

const colorOf = (m: GraphMark): string => (m.kind === 'event' ? EVENT_COLOR : TONE_COLOR[m.tone] ?? '#64748b')
const BAR_FILL = { current: '#3b82f6', past: '#cbd5e1', next: 'none' } as const
const BAR_TEXT = { current: '#ffffff', past: '#334155', next: '#475569' } as const
const half = (m: GraphMark): number => LAYOUT.markWidth[m.kind] / 2
</script>

<template>
  <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="lineage-graph-svg">
    <svg :viewBox="`0 0 ${model.width} ${model.height}`" :width="model.width" :height="model.height" role="img" :aria-label="T.graph" class="block max-w-none">
      <defs>
        <clipPath id="lg-label-clip"><rect x="0" y="0" :width="model.labelWidth - 6" :height="model.height" /></clipPath>
      </defs>

      <!-- 泳道底色與名稱 -->
      <g v-for="(lane, i) in model.lanes" :key="lane.key" :data-lane="lane.key">
        <rect :x="0" :y="lane.y" :width="model.width" :height="lane.h" :fill="i % 2 === 0 ? '#f8fafc' : '#ffffff'" />
        <text x="8" :y="lane.y + 20" font-size="12" font-weight="700" fill="#334155" clip-path="url(#lg-label-clip)">{{ lane.label }}</text>
      </g>

      <!-- 時間軸：每兩年一格 -->
      <g v-for="t in model.ticks" :key="t.label">
        <line :x1="t.x" :x2="t.x" :y1="LAYOUT.axisHeight - 4" :y2="model.height" stroke="#e2e8f0" stroke-width="1" />
        <text :x="t.x + 3" y="18" font-size="11" fill="#64748b">{{ t.label }}</text>
      </g>

      <!-- 任期條：現任實色、卸任灰、下一任虛線框 -->
      <svg v-for="b in model.bars" :key="b.id" :x="b.x" :y="b.y" :width="b.w" :height="b.h" :data-status="b.status" data-testid="lineage-graph-bar">
        <rect x="0" y="0" :width="b.w" :height="b.h" rx="4" :fill="BAR_FILL[b.status]" :stroke="b.status === 'next' ? '#64748b' : 'none'" :stroke-dasharray="b.status === 'next' ? '5 3' : undefined" stroke-width="1.5" />
        <text x="6" :y="b.h / 2 + 4" font-size="11" font-weight="700" :fill="BAR_TEXT[b.status]">{{ b.name }}</text>
      </svg>

      <!-- 推動者 → 事件的虛線箭頭 -->
      <g v-for="a in model.arrows" :key="a.id" class="cursor-pointer" @click="emit('select', a.eventId)">
        <line :x1="a.x1" :x2="a.x2" :y1="a.y1" :y2="a.y2" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4 3" />
        <polygon :points="`${a.x2 - 4},${a.y2 + 12} ${a.x2 + 4},${a.y2 + 12} ${a.x2},${a.y2 + 4}`" fill="#64748b" />
        <title v-if="a.note">{{ a.note }}</title>
      </g>

      <!-- 標籤：政見點、立場、交接（含尚未記錄）、事件 -->
      <g
        v-for="m in model.marks" :key="m.id" role="button" tabindex="0" class="cursor-pointer" :data-kind="m.kind" :data-mark-id="m.id"
        :aria-label="`${m.label}`" @click="emit('select', m.id)" @keydown.enter="emit('select', m.id)" @keydown.space.prevent="emit('select', m.id)"
      >
        <title>{{ m.label }}</title>
        <template v-if="m.kind === 'policy'">
          <circle :cx="m.x" :cy="m.y" r="6" :fill="colorOf(m)" :stroke="selectedId === m.id ? '#0f172a' : '#ffffff'" stroke-width="2" />
        </template>
        <template v-else-if="m.kind === 'event'">
          <polygon :points="`${m.x},${m.y - 8} ${m.x + 8},${m.y} ${m.x},${m.y + 8} ${m.x - 8},${m.y}`" :fill="colorOf(m)" :stroke="selectedId === m.id ? '#0f172a' : '#ffffff'" stroke-width="2" />
          <text :x="m.x + 12" :y="m.y + 4" font-size="11" fill="#334155">{{ m.label }}</text>
        </template>
        <template v-else>
          <rect
            :x="m.x - half(m)" :y="m.y - 9" :width="LAYOUT.markWidth[m.kind]" height="18" rx="9" :fill="m.kind === 'gap' ? '#ffffff' : colorOf(m)"
            :stroke="selectedId === m.id ? '#0f172a' : colorOf(m)" :stroke-dasharray="m.kind === 'gap' || m.disputed ? '3 2' : undefined" stroke-width="1.5"
          />
          <text :x="m.x" :y="m.y + 4" font-size="11" font-weight="700" text-anchor="middle" :fill="m.kind === 'gap' ? '#64748b' : '#ffffff'">{{ m.label }}</text>
        </template>
      </g>

      <!-- 今天 -->
      <g v-if="model.todayX !== null">
        <line :x1="model.todayX" :x2="model.todayX" :y1="LAYOUT.axisHeight - 4" :y2="model.height" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 3" />
        <text :x="model.todayX + 3" y="18" font-size="11" font-weight="700" fill="#dc2626">{{ T.today }}</text>
      </g>
    </svg>
  </div>
</template>
