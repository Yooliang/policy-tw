<script setup lang="ts">
import { computed } from 'vue'
import {
  ELEMENT_COLORS, ELEMENT_KEYS, ELEMENT_LABELS, MIN_ELEMENT_ROWS, elementRowCount, elementsByCounty, elementsByLevel, elementsReady,
  normRegion, percentText, type ElementKey, type ElementShare, type RegionalDataSet,
} from '../../lib/regional-overview'
import RegionalPending from './RegionalPending.vue'

/**
 * ③ 承諾品質：政見三要素（數值目標、期限、財源）有說明的比例。
 * 調查筆數不足 50 就整塊顯示「資料收集中」；單一縣市／層級的調查筆數不足 10 時淡化並印「n／m」。
 */
const props = defineProps<{ data: RegionalDataSet; region: string }>()
const emit = defineEmits<{ (e: 'pick', region: string): void }>()

const ready = computed(() => elementsReady(props.data.element))
const have = computed(() => elementRowCount(props.data.element))
const counties = computed(() => elementsByCounty(props.data.element))
const levels = computed(() => elementsByLevel(props.data.element, props.region))

const shareText = (s: ElementShare) => (s.total === 0 ? '—' : s.reliable ? percentText(s.rate) : `${s.stated}／${s.total}`)
const isOn = (name: string) => props.region !== 'All' && normRegion(props.region) === normRegion(name)

// 層級長條圖（inline SVG）：縱軸上限取資料最大值往上湊到 10% 的倍數，三個要素同一個尺度
const W = 520
const AXIS_X = 44
const PLOT_H = 170
const TOP = 16
const yMax = computed(() => {
  // 縱軸只看調查筆數夠的長條；筆數不足的長條（淡化）超過上限就截在頂端，免得 1／1 的 100% 把有效樣本壓成一條線
  const all = levels.value.flatMap((l) => ELEMENT_KEYS.map((k) => l.shares[k]))
  const solid = all.filter((x) => x.reliable)
  const max = Math.max(0.1, ...(solid.length > 0 ? solid : all).map((x) => x.rate ?? 0))
  return Math.min(1, Math.ceil(max * 10) / 10)
})
const ticks = computed(() => [0, yMax.value / 2, yMax.value])
const groupW = computed(() => (W - AXIS_X - 8) / Math.max(1, levels.value.length))
const barW = computed(() => Math.min(22, (groupW.value - 14) / 3))
const yOf = (rate: number) => TOP + PLOT_H - (rate / yMax.value) * PLOT_H
const legend = ELEMENT_KEYS.map((k) => ({ key: k, label: ELEMENT_LABELS[k], color: ELEMENT_COLORS[k] }))
const colorOf = (k: ElementKey) => ELEMENT_COLORS[k]
</script>

<template>
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6" data-testid="regional-quality">
    <div class="bg-white p-5 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
      <h3 class="text-xl font-black text-navy-900 mb-4">各縣市</h3>
      <RegionalPending v-if="!ready" title="三要素說明比例" :have="have" unit="筆調查" :need="MIN_ELEMENT_ROWS" />
      <template v-else>
        <div class="grid grid-cols-[72px_1fr_1fr_1fr] gap-3 text-[11px] font-bold pb-2 border-b border-slate-200">
          <span />
          <span v-for="k in ELEMENT_KEYS" :key="k" :style="{ color: colorOf(k) }">{{ ELEMENT_LABELS[k] }}</span>
        </div>
        <div
          v-for="c in counties"
          :key="c.region"
          :class="['grid grid-cols-[72px_1fr_1fr_1fr] items-center gap-3 py-1.5 px-1 rounded', isOn(c.region) ? 'bg-blue-50' : '']"
        >
          <button type="button" class="text-sm font-bold text-navy-900 text-left hover:text-blue-600" @click="emit('pick', c.region)">{{ c.region }}</button>
          <div v-for="k in ELEMENT_KEYS" :key="k" class="flex items-center gap-1.5">
            <div class="h-2.5 rounded bg-slate-100 flex-1 overflow-hidden">
              <div class="h-full rounded" :style="{ width: `${(c.shares[k].rate ?? 0) * 100}%`, background: colorOf(k), opacity: c.shares[k].reliable ? 1 : 0.35 }" />
            </div>
            <span :class="['w-10 text-right text-[11px] font-bold tabular-nums', c.shares[k].reliable ? 'text-slate-500' : 'text-slate-300']">{{ shareText(c.shares[k]) }}</span>
          </div>
        </div>
      </template>
    </div>

    <div class="bg-white p-5 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h3 class="text-xl font-black text-navy-900">各層級<span v-if="region !== 'All'" class="ml-2 text-sm font-bold text-slate-400">{{ region }}</span></h3>
        <div v-if="ready && levels.length > 0" class="flex gap-4">
          <span v-for="l in legend" :key="l.key" class="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500"><i class="inline-block w-3 h-3 rounded" :style="{ background: l.color }" />{{ l.label }}</span>
        </div>
      </div>
      <RegionalPending v-if="!ready" title="三要素說明比例" :have="have" unit="筆調查" :need="MIN_ELEMENT_ROWS" />
      <RegionalPending v-else-if="levels.length === 0" title="這個縣市的三要素" :have="0" unit="筆調查" />
      <svg v-else :viewBox="`0 0 ${W} ${TOP + PLOT_H + 52}`" class="w-full" font-family="inherit" role="img" aria-label="各層級政見三要素說明比例">
        <g font-size="11" fill="#64748b">
          <template v-for="t in ticks" :key="t">
            <line :x1="AXIS_X" :x2="W" :y1="yOf(t)" :y2="yOf(t)" stroke="#e2e8f0" />
            <text :x="AXIS_X - 6" :y="yOf(t) + 4" text-anchor="end">{{ Math.round(t * 100) }}%</text>
          </template>
          <g v-for="(lv, i) in levels" :key="lv.level">
            <g v-for="(k, j) in ELEMENT_KEYS" :key="k">
              <rect
                :x="AXIS_X + 8 + i * groupW + (groupW - barW * 3 - 4) / 2 + j * (barW + 2)"
                :y="yOf(Math.min(yMax, lv.shares[k].rate ?? 0))"
                :width="barW"
                :height="TOP + PLOT_H - yOf(Math.min(yMax, lv.shares[k].rate ?? 0))"
                rx="3"
                :fill="colorOf(k)"
                :opacity="lv.shares[k].reliable ? 1 : 0.35"
              ><title>{{ lv.level }} {{ ELEMENT_LABELS[k] }} {{ lv.shares[k].stated }}／{{ lv.shares[k].total }}</title></rect>
              <text
                v-if="lv.shares[k].reliable"
                :x="AXIS_X + 8 + i * groupW + (groupW - barW * 3 - 4) / 2 + j * (barW + 2) + barW / 2"
                :y="yOf(lv.shares[k].rate ?? 0) - 4"
                text-anchor="middle"
                font-weight="700"
                font-size="10"
                :fill="lv.shares[k].reliable ? '#334155' : '#94a3b8'"
              >{{ shareText(lv.shares[k]) }}</text>
            </g>
            <text :x="AXIS_X + 8 + i * groupW + groupW / 2" :y="TOP + PLOT_H + 20" text-anchor="middle" font-weight="700" font-size="11" fill="#0f172a">{{ lv.level }}</text>
          </g>
        </g>
      </svg>
    </div>
  </div>
</template>
