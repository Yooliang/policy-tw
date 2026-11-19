<script setup lang="ts">
import { computed } from 'vue'
import { STAGE_COLORS, funnelRows, normRegion, percentText, policyTotal, type RegionalDataSet } from '../../lib/regional-overview'

/**
 * ① 各縣市階段漏斗：承諾條與政見條各自縮放；政見條內分尚未啟動／已提出／施政中／已完成／停滯；依兌現率排序。
 * 兌現率的分母（政見數）不足 10 的縣市：百分比淡化、印出「n／m」，排在有效樣本後面。
 */
const props = defineProps<{ data: RegionalDataSet; region: string }>()
const emit = defineEmits<{ (e: 'pick', region: string): void }>()

const fmt = (n: number) => n.toLocaleString('en-US')
const rows = computed(() => funnelRows(props.data.stage))
const maxPledge = computed(() => Math.max(1, ...rows.value.map((r) => r.counts.pledge_n)))
const maxPolicy = computed(() => Math.max(1, ...rows.value.map((r) => policyTotal(r.counts))))

const legend = [
  { label: '承諾', color: STAGE_COLORS.pledge },
  { label: '尚未啟動', color: STAGE_COLORS.not_started },
  { label: '已提出', color: STAGE_COLORS.proposed },
  { label: '施政中', color: STAGE_COLORS.in_progress },
  { label: '已完成', color: STAGE_COLORS.achieved },
  { label: '停滯', color: STAGE_COLORS.stalled },
]

function segments(c: { not_started_n: number; proposed_n: number; in_progress_n: number; achieved_n: number; stalled_n: number }) {
  const total = policyTotal(c as never)
  return ([
    ['尚未啟動', c.not_started_n, STAGE_COLORS.not_started],
    ['已提出', c.proposed_n, STAGE_COLORS.proposed],
    ['施政中', c.in_progress_n, STAGE_COLORS.in_progress],
    ['已完成', c.achieved_n, STAGE_COLORS.achieved],
    ['停滯', c.stalled_n, STAGE_COLORS.stalled],
  ] as const).filter(([, n]) => n > 0).map(([label, n, color]) => ({ label, n, color, pct: (n / total) * 100 }))
}
const isOn = (name: string) => props.region !== 'All' && normRegion(props.region) === normRegion(name)
</script>

<template>
  <div class="bg-white p-5 md:p-8 rounded-[32px] border border-slate-200 shadow-sm" data-testid="regional-funnel">
    <div class="flex flex-wrap items-center justify-between gap-3 mb-2">
      <h3 class="text-xl font-black text-navy-900">各縣市進度漏斗</h3>
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        <span v-for="l in legend" :key="l.label" class="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500"><i class="inline-block w-3 h-3 rounded" :style="{ background: l.color }" />{{ l.label }}</span>
      </div>
    </div>
    <div class="hidden md:grid gap-3 text-[11px] font-bold text-slate-400 py-2 border-b border-slate-200 grid-cols-[72px_1fr_1fr_64px]">
      <span>縣市</span><span>承諾（筆）</span><span>政見（筆）</span><span class="text-right">兌現率</span>
    </div>
    <div class="md:max-h-[640px] md:overflow-y-auto">
      <button
        v-for="r in rows"
        :key="r.region"
        type="button"
        :data-testid="`regional-funnel-${r.region}`"
        :class="['w-full text-left grid items-center gap-x-3 gap-y-1 py-2 px-1 border-b border-slate-100 grid-cols-[1fr_auto] md:grid-cols-[72px_1fr_1fr_64px] hover:bg-slate-50', isOn(r.region) ? 'bg-blue-50' : '']"
        @click="emit('pick', r.region)"
      >
        <span class="order-1 text-sm font-bold text-navy-900">{{ r.region }}</span>
        <span :class="['order-2 md:order-4 text-right tabular-nums', r.rate === null ? 'text-sm font-black text-slate-300' : r.reliable ? 'text-sm font-black text-navy-900' : 'text-xs font-bold text-slate-400']">
          <template v-if="r.rate === null">—</template>
          <template v-else-if="r.reliable">{{ percentText(r.rate) }}</template>
          <template v-else>{{ r.counts.in_progress_n + r.counts.achieved_n }}／{{ policyTotal(r.counts) }}</template>
        </span>
        <span class="order-3 md:order-2 col-span-2 md:col-span-1 flex items-center gap-2">
          <span class="block h-4 rounded" :style="{ width: `${(r.counts.pledge_n / maxPledge) * 80}%`, background: STAGE_COLORS.pledge }" />
          <span class="text-xs font-bold text-slate-500 tabular-nums">{{ fmt(r.counts.pledge_n) }} 筆</span>
        </span>
        <span class="order-4 md:order-3 col-span-2 md:col-span-1 flex items-center gap-2">
          <span v-if="policyTotal(r.counts) > 0" :class="['flex h-4 rounded overflow-hidden', r.reliable ? '' : 'opacity-60']" :style="{ width: `${Math.max(2, (policyTotal(r.counts) / maxPolicy) * 80)}%` }">
            <span v-for="s in segments(r.counts)" :key="s.label" class="block h-full" :style="{ width: `${s.pct}%`, background: s.color }" :title="`${s.label} ${s.n} 筆`" />
          </span>
          <span class="text-xs font-bold text-slate-500 tabular-nums">{{ fmt(policyTotal(r.counts)) }} 筆</span>
        </span>
      </button>
    </div>
  </div>
</template>
