<script setup lang="ts">
import { computed } from 'vue'
import {
  COUNTIES, fulfilmentRate, lineageStat, percentText, policyTotal, rateReliable, stageTotals,
  type RegionalDataSet,
} from '../../lib/regional-overview'

/**
 * 開頭：KPI 六格（全台或所選縣市）＋右側格狀縣市導航。
 * 導航每格的顏色＝兌現率（政見數不足 10 的淡化）；點格子就是切換全站的地區。
 */
const props = defineProps<{ data: RegionalDataSet; region: string }>()
const emit = defineEmits<{ (e: 'pick', region: string): void }>()

const fmt = (n: number) => n.toLocaleString('en-US')
const scopeLabel = computed(() => (props.region === 'All' ? '全台' : props.region))

const totals = computed(() => stageTotals(props.data.stage, props.region))
const rate = computed(() => fulfilmentRate(totals.value))
const lineageCount = computed(() => lineageStat(props.data.lineage, props.region).count)

const kpis = computed(() => {
  const t = totals.value
  return [
    { label: '承諾數', value: fmt(t.pledge_n), sub: scopeLabel.value, cls: 'text-navy-900' },
    { label: '政見數', value: fmt(policyTotal(t)), sub: scopeLabel.value, cls: 'text-blue-600' },
    { label: '施政中', value: fmt(t.in_progress_n), sub: `${scopeLabel.value} · 已開始執行`, cls: 'text-indigo-600' },
    { label: '已完成', value: fmt(t.achieved_n), sub: `${scopeLabel.value} · 已有成果`, cls: 'text-emerald-600' },
    { label: '脈絡數', value: fmt(lineageCount.value), sub: scopeLabel.value, cls: 'text-amber-600' },
    {
      label: '兌現率',
      value: percentText(rate.value),
      sub: rateReliable(t) || rate.value === null ? `${scopeLabel.value} · 政見中施政中或已完成` : `${t.in_progress_n + t.achieved_n}／${policyTotal(t)} 項政見`,
      cls: rateReliable(t) ? 'text-rose-600' : 'text-rose-300',
    },
  ]
})

// 格狀示意地圖：座標（欄, 列），左上為原點
const GRID: Record<string, readonly [number, number]> = {
  連江縣: [5, 0], 基隆市: [4, 1], 台北市: [3, 1], 新北市: [2, 1], 桃園市: [2, 2], 新竹市: [1, 3], 新竹縣: [2, 3],
  宜蘭縣: [4, 2], 苗栗縣: [1, 4], 台中市: [1, 5], 花蓮縣: [3, 4], 南投縣: [2, 5], 彰化縣: [0, 5], 雲林縣: [0, 6],
  嘉義市: [0, 7], 嘉義縣: [1, 7], 台南市: [0, 8], 高雄市: [1, 8], 屏東縣: [1, 9], 台東縣: [3, 7], 澎湖縣: [-1, 6], 金門縣: [-1, 2],
}
const CELL = 38
const ROW = 34
const minCol = Math.min(...Object.values(GRID).map(([c]) => c))
const mapWidth = (5 - minCol + 1) * CELL
const mapHeight = 10 * ROW

function shortName(name: string): string {
  const head = name.slice(0, 2)
  return head === '新竹' || head === '嘉義' ? `${head}${name.slice(-1)}` : head
}

const tiles = computed(() => COUNTIES.map((name) => {
  const t = stageTotals(props.data.stage, name)
  const r = fulfilmentRate(t)
  const reliable = rateReliable(t)
  // 顏色深淺＝兌現率；沒有政見是中性灰；分母不足同色系淡化
  let bg = '#e2e8f0'
  let fg = '#64748b'
  if (r !== null) {
    const strong = r >= 0.5
    const mid = r >= 0.2
    bg = strong ? '#2563eb' : mid ? '#60a5fa' : '#bfdbfe'
    fg = strong ? '#ffffff' : '#0f172a'
  }
  const [c, row] = GRID[name]
  const detail = r === null ? '尚無政見' : reliable ? `兌現率 ${percentText(r)}` : `${t.in_progress_n + t.achieved_n}／${policyTotal(t)} 項政見`
  return {
    name,
    label: shortName(name),
    style: { left: `${(c - minCol) * CELL}px`, top: `${row * ROW}px`, width: `${CELL - 2}px`, height: `${ROW - 4}px`, background: bg, color: fg, opacity: r !== null && !reliable ? 0.45 : 1 },
    title: `${name} ${detail}`,
    on: props.region === name,
  }
}))
</script>

<template>
  <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-6" data-testid="regional-kpi">
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 content-start">
      <div v-for="k in kpis" :key="k.label" class="p-4 bg-white rounded-2xl border border-slate-200 shadow-sm">
        <p class="text-sm font-bold text-slate-500 whitespace-nowrap mb-1">{{ k.label }}</p>
        <p :class="['text-3xl font-black tabular-nums', k.cls]">{{ k.value }}</p>
        <p class="text-[11px] text-slate-400 mt-1 font-bold">{{ k.sub }}</p>
      </div>
    </div>
    <div class="p-4 bg-white rounded-2xl border border-slate-200 shadow-sm">
      <div class="flex items-center justify-between mb-3">
        <p class="text-sm font-bold text-slate-500">點縣市切換範圍</p>
        <button type="button" :class="['text-[11px] font-bold px-2 py-0.5 rounded-full', region === 'All' ? 'bg-navy-900 text-white' : 'text-blue-600 hover:bg-blue-50']" :aria-pressed="region === 'All'" @click="emit('pick', 'All')">全台</button>
      </div>
      <div class="relative mx-auto" :style="{ width: `${mapWidth}px`, height: `${mapHeight}px` }">
        <button
          v-for="t in tiles"
          :key="t.name"
          type="button"
          :title="t.title"
          :aria-label="t.title"
          :aria-pressed="t.on"
          :data-testid="`regional-tile-${t.name}`"
          :class="['absolute rounded-lg flex items-center justify-center text-[10px] font-black leading-none transition', t.on ? 'ring-2 ring-offset-1 ring-navy-900' : 'hover:scale-105']"
          :style="t.style"
          @click="emit('pick', t.name)"
        >{{ t.label }}</button>
      </div>
      <div class="mt-3 flex items-center justify-center gap-3 text-[10px] font-bold text-slate-400">
        <span class="inline-flex items-center gap-1"><i class="inline-block w-2.5 h-2.5 rounded" style="background:#bfdbfe" />兌現率低</span>
        <span class="inline-flex items-center gap-1"><i class="inline-block w-2.5 h-2.5 rounded" style="background:#2563eb" />兌現率高</span>
      </div>
    </div>
  </div>
</template>
