<script setup lang="ts">
import { computed } from 'vue'
import { lineageStatsByCounty, normRegion, timelineLineages, timelineYears, type RegionalDataSet } from '../../lib/regional-overview'
import RegionalPending from './RegionalPending.vue'

/**
 * ④ 脈絡接力：各縣市脈絡數、平均跨任期數、交接數的小表，加一張任期示意時間軸（用真實脈絡挑幾條，跨 2 屆以上才畫）。
 */
const props = defineProps<{ data: RegionalDataSet; region: string }>()
const emit = defineEmits<{ (e: 'pick', region: string): void }>()

const stats = computed(() => lineageStatsByCounty(props.data.lineage))
const picked = computed(() => timelineLineages(props.data.lineage, props.region, 6))
const years = computed(() => timelineYears(picked.value))
const isOn = (name: string) => props.region !== 'All' && normRegion(props.region) === normRegion(name)

const PALETTE = ['#2563eb', '#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#0ea5e9']
const W = 640
const LEFT = 90
const RIGHT = 70
const ROW_H = 46
const colX = (y: number) => {
  const ys = years.value
  return ys.length <= 1 ? W / 2 : LEFT + ((y - ys[0]) / (ys[ys.length - 1] - ys[0] || 1)) * (W - LEFT - RIGHT)
}
const height = computed(() => 60 + picked.value.length * ROW_H)
const lines = computed(() => picked.value.map((l, i) => {
  const ys = [...(l.term_years ?? [])].sort((a, b) => a - b)
  const label = `${l.region === '全國' ? '中央' : l.region}${l.category ? ` · ${l.category}` : ''}`
  return { id: l.lineage_id, y: 76 + i * ROW_H, color: PALETTE[i % PALETTE.length], from: colX(ys[0]), to: colX(ys[ys.length - 1]), dots: ys.map(colX), label }
}))
</script>

<template>
  <div class="grid grid-cols-1 lg:grid-cols-5 gap-6" data-testid="regional-lineage">
    <div class="lg:col-span-2 bg-white p-5 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
      <h3 class="text-xl font-black text-navy-900 mb-4">各縣市脈絡</h3>
      <RegionalPending v-if="stats.length === 0" title="跨任期的脈絡" :have="0" unit="條" />
      <table v-else class="w-full">
        <thead>
          <tr class="text-[11px] font-bold text-slate-400 border-b border-slate-200">
            <th class="text-left pb-2">縣市</th><th class="text-right pb-2">脈絡（條）</th><th class="text-right pb-2">平均跨任期（屆）</th><th class="text-right pb-2">交接（次）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in stats" :key="s.region" :class="['border-b border-slate-100', isOn(s.region) ? 'bg-blue-50' : '']">
            <td class="py-2.5"><button type="button" class="text-sm font-bold text-navy-900 hover:text-blue-600" @click="emit('pick', s.region)">{{ s.region }}</button></td>
            <td class="text-right text-sm font-black tabular-nums">{{ s.count }}</td>
            <td class="text-right text-sm tabular-nums text-slate-600">{{ s.avgTerms === null ? '—' : s.avgTerms.toFixed(1) }}</td>
            <td class="text-right text-sm tabular-nums text-slate-600">{{ s.handovers }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="lg:col-span-3 self-start bg-white p-5 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
      <h3 class="text-xl font-black text-navy-900 mb-2">跨任期示意<span v-if="region !== 'All'" class="ml-2 text-sm font-bold text-slate-400">{{ region }}</span></h3>
      <RegionalPending v-if="picked.length === 0" title="跨兩屆以上的脈絡" :have="0" unit="條" />
      <svg v-else :viewBox="`0 0 ${W} ${height}`" class="w-full" font-family="inherit" role="img" aria-label="脈絡跨任期示意">
        <g v-for="y in years" :key="y">
          <line :x1="colX(y)" :x2="colX(y)" y1="44" :y2="height - 6" stroke="#e2e8f0" stroke-dasharray="3 4" />
          <rect :x="colX(y) - 34" y="6" width="68" height="26" rx="13" fill="#0f172a" />
          <text :x="colX(y)" y="24" text-anchor="middle" font-size="13" font-weight="900" fill="#fff">{{ y }}</text>
        </g>
        <g v-for="l in lines" :key="l.id">
          <line :x1="l.from" :x2="l.to" :y1="l.y" :y2="l.y" :stroke="l.color" stroke-width="4" stroke-linecap="round" opacity=".5" />
          <circle v-for="(x, i) in l.dots" :key="i" :cx="x" :cy="l.y" r="8" :fill="l.color" stroke="#fff" stroke-width="3" />
          <text :x="l.from" :y="l.y - 14" font-size="12" font-weight="700" fill="#334155">{{ l.label }}</text>
        </g>
      </svg>
    </div>
  </div>
</template>
