<script setup lang="ts">
import { computed } from 'vue'
import { DEADLINE_COLORS, MIN_DEADLINE_DATED, MIN_RATE_DENOM, datedCount, deadlineReady, deadlineTotals, type RegionalDataSet } from '../../lib/regional-overview'
import RegionalPending from './RegionalPending.vue'

/**
 * ⑤ 期限分佈（已逾期／30 天內／之後／未設）＋近 30 天有進度更新的政見比例。
 * 有日期的政見不足 20 項：期限分佈顯示「資料收集中」與目前筆數，不畫圖。
 */
const props = defineProps<{ data: RegionalDataSet; region: string }>()

const totals = computed(() => deadlineTotals(props.data.deadline, props.region))
const ready = computed(() => deadlineReady(totals.value))
const dated = computed(() => datedCount(totals.value))
const fmt = (n: number) => n.toLocaleString('en-US')
const pct = (n: number, d: number) => (d === 0 ? '0%' : `${Math.round((n / d) * 100)}%`)

const parts = computed(() => {
  const t = totals.value
  return [
    { label: '已逾期', n: t.overdue, color: DEADLINE_COLORS.overdue },
    { label: '30 天內', n: t.within30, color: DEADLINE_COLORS.within30 },
    { label: '之後', n: t.later, color: DEADLINE_COLORS.later },
    { label: '未設期限', n: t.unset, color: DEADLINE_COLORS.unset },
  ]
})

// 甜甜圈（inline SVG）
const R = 64
const CIRC = 2 * Math.PI * R
const arcs = computed(() => {
  const total = totals.value.policy || 1
  let offset = 0
  return parts.value.filter((p) => p.n > 0).map((p) => {
    const len = (p.n / total) * CIRC
    const arc = { ...p, dash: `${len.toFixed(2)} ${(CIRC - len).toFixed(2)}`, offset: (-offset).toFixed(2) }
    offset += len
    return arc
  })
})

const updateRate = computed(() => (totals.value.policy === 0 ? null : totals.value.updated30d / totals.value.policy))
const updateReliable = computed(() => totals.value.policy >= MIN_RATE_DENOM)
</script>

<template>
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6" data-testid="regional-deadline">
    <div class="lg:col-span-2 bg-white p-5 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
      <h3 class="text-xl font-black text-navy-900 mb-4">期限分佈</h3>
      <RegionalPending v-if="!ready" title="有期限日期的政見" :have="dated" unit="項" :need="MIN_DEADLINE_DATED" />
      <div v-else class="flex flex-col sm:flex-row items-center gap-8">
        <svg viewBox="0 0 180 180" class="w-44 shrink-0" role="img" aria-label="政見期限分佈">
          <circle
            v-for="a in arcs"
            :key="a.label"
            cx="90" cy="90" :r="R" fill="none" stroke-width="26"
            :stroke="a.color" :stroke-dasharray="a.dash" :stroke-dashoffset="a.offset" transform="rotate(-90 90 90)"
          />
          <text x="90" y="92" text-anchor="middle" font-size="26" font-weight="900" fill="#0f172a">{{ fmt(totals.policy) }}</text>
          <text x="90" y="110" text-anchor="middle" font-size="11" font-weight="700" fill="#94a3b8">項政見</text>
        </svg>
        <div class="flex-1 w-full">
          <div v-for="p in parts" :key="p.label" class="flex items-center justify-between py-1.5 border-b border-slate-100">
            <span class="inline-flex items-center gap-2 text-sm font-bold text-slate-600"><i class="inline-block w-3 h-3 rounded" :style="{ background: p.color }" />{{ p.label }}</span>
            <span class="text-sm font-black tabular-nums text-navy-900">{{ fmt(p.n) }} 項<span class="text-xs text-slate-400 font-bold ml-2">{{ pct(p.n, totals.policy) }}</span></span>
          </div>
        </div>
      </div>
    </div>
    <div class="bg-white p-5 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
      <h3 class="text-xl font-black text-navy-900 mb-4">近 30 天有進度更新</h3>
      <template v-if="updateRate !== null">
        <p :class="['text-5xl font-black tabular-nums', updateReliable ? 'text-emerald-600' : 'text-emerald-300']">{{ Math.round(updateRate * 100) }}%</p>
        <p class="text-sm text-slate-400 font-bold mt-1">{{ fmt(totals.updated30d) }}／{{ fmt(totals.policy) }} 項政見</p>
        <div class="h-3 rounded-full bg-slate-100 mt-5 overflow-hidden"><div class="h-full rounded-full bg-emerald-500" :style="{ width: `${updateRate * 100}%`, opacity: updateReliable ? 1 : 0.4 }" /></div>
      </template>
      <RegionalPending v-else title="進度更新" :have="0" unit="項政見" />
    </div>
  </div>
</template>
