<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted } from 'vue'
const apexchart = defineAsyncComponent(() => import('vue3-apexcharts'))
import { PieChart } from 'lucide-vue-next'
import { taskTypeLabel } from '../../lib/task-labels'
import { BRAND, CATEGORY_SERIES } from '../../lib/brand-colors'
import { CHART_LEGEND } from '../../lib/chart-style'
import { rankGapTypes } from '../../lib/gap-ranking'
import { usePipelineSnapshots } from '../../composables/usePipelineSnapshots'

/**
 * 資料缺口：系統自動偵測、依序派給 AI 代理的那些。回答的是「現在」，不跟統計頁的時間窗走。
 *
 * 用最新一筆採樣（pipeline_snapshots，每小時一筆），不是 /tasks 的即時數字：
 * 缺口走勢也吃這份，兩張圖同一筆資料、同一支排序（lib/gap-ranking），同一類缺口才會同色。
 * 代價是數字最多晚一小時——資料缺口是以天為單位在變的東西，一小時不影響判讀。
 */

const { snapshots, loading, error, fetchSnapshots } = usePipelineSnapshots()
const latestByType = computed<Record<string, number>>(() => snapshots.value[snapshots.value.length - 1]?.tasksByType ?? {})
const totals = computed<Record<string, number>>(() =>
  Object.fromEntries(rankGapTypes(latestByType.value).map(k => [k, Number(latestByType.value[k])])))

const autoTotal = computed(() => Object.values(totals.value).reduce((a, n) => a + n, 0))
// totals 已經是 rankGapTypes 的順序，不要在這裡另外排——兩張圖的名次要一致
const gapRows = computed(() => Object.entries(totals.value)
  .map(([type, count]) => ({ label: taskTypeLabel(type), count })))

/**
 * 圓餅圖（2026-09-17）：這裡要回答的是「缺口集中在哪一類」，比例比絕對值重要。
 * 缺口型別有十幾種，全部切成扇形會變成一圈看不懂的碎片，所以只畫前 5 大（站徽五色），
 * 其餘合併成「其他缺口」——跟下方的 24 小時趨勢圖用同一套取法。
 */
const GAP_TOP_N = CATEGORY_SERIES.length
const GAP_COLORS = [...CATEGORY_SERIES, BRAND.other]
const gapPieRows = computed(() => {
  const rows = gapRows.value
  if (rows.length <= GAP_TOP_N + 1) return rows
  const head = rows.slice(0, GAP_TOP_N)
  const rest = rows.slice(GAP_TOP_N).reduce((sum, r) => sum + r.count, 0)
  return rest > 0 ? [...head, { label: '其他缺口', count: rest }] : head
})
const gapSeries = computed(() => gapPieRows.value.map(r => r.count))
const gapOptions = computed(() => ({
  chart: { type: 'pie' as const, toolbar: { show: false } },
  labels: gapPieRows.value.map(r => r.label),
  colors: GAP_COLORS,
  stroke: { width: 2, colors: ['#ffffff'] },
  // 扇形上只標百分比，件數留給圖例與提示框：小扇形塞兩個數字會疊在一起
  dataLabels: { enabled: true, formatter: (v: number) => (v >= 6 ? `${Math.round(v)}%` : ''), style: { fontSize: '11px', fontWeight: 700 }, dropShadow: { enabled: false } },
  legend: CHART_LEGEND,
  tooltip: { y: { formatter: (v: number) => `${v} 件` } },
}))

onMounted(fetchSnapshots)
</script>

<template>
  <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="gap-counts">
    <div class="flex items-baseline gap-2 mb-1">
      <h3 class="font-black text-navy-900 flex items-center gap-2"><PieChart :size="18" class="text-orange-500" />資料缺口</h3>
      <span class="ml-auto text-sm font-bold text-navy-900 whitespace-nowrap">共 {{ loading ? '–' : autoTotal }} 件</span>
    </div>
    <p class="text-xs text-slate-400 mb-2">自動偵測，依序派給 AI 代理</p>
    <p v-if="error" class="text-sm text-slate-500 py-6 text-center">暫時讀不到資料</p>
    <p v-else-if="!loading && gapRows.length === 0" class="text-sm text-slate-400 py-6 text-center">目前沒有缺口</p>
    <div v-else class="h-72">
      <ClientOnly><apexchart v-if="gapRows.length > 0" type="pie" height="100%" :options="gapOptions" :series="gapSeries" /></ClientOnly>
    </div>
  </section>
</template>
