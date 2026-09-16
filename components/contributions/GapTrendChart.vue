<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted } from 'vue'
import { Loader2 } from 'lucide-vue-next'
const apexchart = defineAsyncComponent(() => import('vue3-apexcharts'))
import { MANUAL_TASKS_KEY, usePipelineSnapshots } from '../../composables/usePipelineSnapshots'
import { taskTypeLabel } from '../../lib/task-labels'

/**
 * 近 24 小時各類資料缺口的走勢。
 *
 * 2026-09-16 小良哥：「資料缺口可以也加入每小時的計算嗎…也想有個地方可以看各種資料缺口的狀況」。
 * 資料本來就有：pipeline_snapshots 每小時一筆，tasks_by_type 存著當下每一種缺口的數量，
 * 這裡只是把它畫出來，不需要另外採樣。
 */
const HOURS = 24
/** 手動任務不是「資料缺口」，它在左邊的任務清單裡 */

/** 側欄很窄，線太多會糊成一團：只畫目前最多的幾種，其餘合成一條 */
const MAX_LINES = 6
const COLORS = ['#2563eb', '#ea580c', '#059669', '#7c3aed', '#db2777', '#0891b2', '#94a3b8']

const { snapshots, loading, error, fetchSnapshots } = usePipelineSnapshots()

const recent = computed(() => {
  const since = Date.now() - HOURS * 3600 * 1000
  return snapshots.value.filter(s => new Date(s.takenAt).getTime() >= since)
})

const topTypes = computed(() => {
  const last = recent.value[recent.value.length - 1]?.tasksByType ?? {}
  return Object.entries(last)
    .filter(([k]) => k !== MANUAL_TASKS_KEY)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, MAX_LINES)
    .map(([k]) => k)
})

const chartSeries = computed(() => {
  const series = topTypes.value.map(type => ({
    name: taskTypeLabel(type),
    data: recent.value.map(s => Number(s.tasksByType[type] ?? 0)),
  }))
  // 其餘缺口合成一條，總和才對得上卡片上的「共 N 件」
  const others = recent.value.map(s =>
    Object.entries(s.tasksByType)
      .filter(([k]) => k !== MANUAL_TASKS_KEY && !topTypes.value.includes(k))
      .reduce((a, [, v]) => a + Number(v ?? 0), 0))
  if (others.some(n => n > 0)) series.push({ name: '其他缺口', data: others })
  return series
})

const axisLabels = computed(() =>
  recent.value.map(s => {
    const d = new Date(s.takenAt)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  })
)

const chartOptions = computed(() => ({
  chart: { type: 'line' as const, toolbar: { show: false }, zoom: { enabled: false } },
  colors: COLORS,
  stroke: { width: 2, curve: 'straight' as const },
  dataLabels: { enabled: false },
  xaxis: {
    categories: axisLabels.value,
    labels: { style: { colors: '#94a3b8', fontSize: '10px' }, hideOverlappingLabels: true },
    axisBorder: { show: false }, axisTicks: { show: false }, tooltip: { enabled: false },
  },
  yaxis: { labels: { style: { colors: '#94a3b8', fontSize: '10px' } }, forceNiceScale: true, min: 0 },
  grid: { strokeDashArray: 3, borderColor: '#f1f5f9' },
  legend: { show: true, position: 'bottom' as const, fontSize: '11px', markers: { size: 5 }, itemMargin: { horizontal: 6, vertical: 2 } },
  markers: { size: recent.value.length <= 8 ? 3 : 0 },
  tooltip: { shared: true, intersect: false },
}))

onMounted(fetchSnapshots)
</script>

<template>
  <div class="mt-4 pt-4 border-t border-slate-100" data-testid="gap-trend">
    <div class="flex items-baseline gap-2 mb-1">
      <h4 class="text-sm font-black text-navy-900">近 {{ HOURS }} 小時走勢</h4>
      <span class="text-xs text-slate-400">每小時採樣一次</span>
    </div>

    <p v-if="error" class="text-sm text-slate-400 py-4">走勢暫時讀不到</p>
    <div v-else-if="loading" class="flex items-center gap-2 text-sm text-slate-400 py-6">
      <Loader2 :size="16" class="animate-spin" />載入中
    </div>
    <p v-else-if="recent.length < 2" class="text-sm text-slate-400 py-4">
      近 {{ HOURS }} 小時只有 {{ recent.length }} 筆採樣，還畫不出走勢；每小時會新增一筆。
    </p>
    <div v-else class="h-64">
      <ClientOnly><apexchart type="line" height="100%" :options="chartOptions" :series="chartSeries" /></ClientOnly>
    </div>
  </div>
</template>
