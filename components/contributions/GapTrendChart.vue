<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted } from 'vue'
import { Loader2, TrendingUp } from 'lucide-vue-next'
const apexchart = defineAsyncComponent(() => import('vue3-apexcharts'))
import { MANUAL_TASKS_KEY, usePipelineSnapshots } from '../../composables/usePipelineSnapshots'
import { taskTypeLabel } from '../../lib/task-labels'
import { withinHours } from '../../lib/stats-range'
import { BRAND, CATEGORY_SERIES } from '../../lib/brand-colors'
import { CHART_LEGEND } from '../../lib/chart-style'
import { topGapTypes } from '../../lib/gap-ranking'

/**
 * 各類資料缺口的走勢。時間窗由統計頁整頁共用的那一組決定（24h／7D／30D／90D）。
 *
 * 2026-09-16：「資料缺口可以也加入每小時的計算嗎…也想有個地方可以看各種資料缺口的狀況」。
 * 資料本來就有：pipeline_snapshots 每小時一筆，tasks_by_type 存著當下每一種缺口的數量，
 * 這裡只是把它畫出來，不需要另外採樣。
 */
const props = withDefaults(defineProps<{ hours?: number; rangeLabel?: string }>(), { hours: 24, rangeLabel: '24h' })
/** 手動任務不是「資料缺口」，它在任務頁的清單裡 */

/** 側欄很窄，線太多會糊成一團：只畫目前最多的幾種，其餘合成一條 */
// 取前 5 大：剛好用完站徽的五個顏色，其餘併成灰色的「其他缺口」
const MAX_LINES = CATEGORY_SERIES.length
const COLORS = [...CATEGORY_SERIES, BRAND.other]

const { snapshots, loading, error, fetchSnapshots } = usePipelineSnapshots()

const recent = computed(() => withinHours(snapshots.value, props.hours))

// 名次依「全體最新一筆」排，不是時間窗內的最後一筆：跟資料缺口圓餅同一筆、同一支排序，同一類才同色
const topTypes = computed(() => topGapTypes(snapshots.value[snapshots.value.length - 1]?.tasksByType ?? {}, MAX_LINES))

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

// 超過一天的時間窗要帶日期，不然 X 軸上一堆「14:00」分不出是哪一天
const axisLabels = computed(() =>
  recent.value.map(s => {
    const d = new Date(s.takenAt)
    const p = (n: number) => String(n).padStart(2, '0')
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
    return props.hours > 24 ? `${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}` : hm
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
  legend: CHART_LEGEND,
  markers: { size: 0 },
  tooltip: { shared: true, intersect: false },
}))

onMounted(fetchSnapshots)
</script>

<template>
  <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="gap-trend">
    <div class="flex items-baseline gap-2 mb-1">
      <h3 class="font-black text-navy-900 flex items-center gap-2"><TrendingUp :size="18" class="text-violet-600" />缺口走勢({{ rangeLabel }})</h3>
      <span class="text-xs text-slate-400">每小時採樣一次</span>
    </div>

    <p v-if="error" class="text-sm text-slate-400 py-4">走勢暫時讀不到</p>
    <div v-else-if="loading" class="flex items-center gap-2 text-sm text-slate-400 py-6">
      <Loader2 :size="16" class="animate-spin" />載入中
    </div>
    <p v-else-if="recent.length < 2" class="text-sm text-slate-400 py-4">
      這段期間只有 {{ recent.length }} 筆採樣，還畫不出走勢；每小時會新增一筆。
    </p>
    <div v-else class="h-64">
      <ClientOnly><apexchart type="line" height="100%" :options="chartOptions" :series="chartSeries" /></ClientOnly>
    </div>
  </section>
</template>
