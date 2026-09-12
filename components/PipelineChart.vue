<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { usePipelineSnapshots } from '../composables/usePipelineSnapshots'

/**
 * 機制健康度圖表：資料庫每 4 小時寫入一筆採樣，用來讓讀者確認「AI 查證機制真的在跑」。
 * 採樣還太少畫不出走勢時（<3 筆）改顯示目前數值，避免一張看起來像壞掉的空折線圖。
 */
const METRICS = [
  { key: 'tasksOpen', label: '待查任務', color: '#ea580c' },
  { key: 'pending', label: '待驗證貢獻', color: '#2563eb' },
  { key: 'applied', label: '已上線累計', color: '#059669' },
  { key: 'votesTotal', label: '驗證票累計', color: '#7c3aed' },
] as const
type MetricKey = (typeof METRICS)[number]['key']

const SAMPLE_INTERVAL_HOURS = 4
const MIN_POINTS_FOR_CHART = 3

const { snapshots, loading, error, fetchSnapshots } = usePipelineSnapshots()

// 預設只勾「待查任務／待驗證貢獻」：兩者數值量級相近，一起看才看得出「池子有沒有在消化」；
// 「已上線累計」「驗證票累計」是只增不減的總數，混在一起畫會把前兩條線壓成一直線，讓使用者自己選要不要疊加。
const visible = ref<Set<MetricKey>>(new Set(['tasksOpen', 'pending']))

function toggleMetric(key: MetricKey) {
  const next = new Set(visible.value)
  if (next.has(key)) {
    if (next.size > 1) next.delete(key) // 至少留一條線，不然圖會整個消失、讀者以為壞了
  } else {
    next.add(key)
  }
  visible.value = next
}

const latest = computed(() => snapshots.value[snapshots.value.length - 1] ?? null)
const pointsNeeded = computed(() => Math.max(0, MIN_POINTS_FOR_CHART - snapshots.value.length))

const visibleMetrics = computed(() => METRICS.filter(m => visible.value.has(m.key)))

const chartSeries = computed(() =>
  visibleMetrics.value.map(m => ({
    name: m.label,
    data: snapshots.value.map(s => [new Date(s.takenAt).getTime(), s[m.key]]),
  }))
)

const chartOptions = computed(() => ({
  chart: { type: 'line' as const, toolbar: { show: false }, zoom: { enabled: false } },
  colors: visibleMetrics.value.map(m => m.color),
  stroke: { width: 2, curve: 'smooth' as const },
  xaxis: {
    type: 'datetime' as const,
    labels: { style: { colors: '#94a3b8', fontSize: '11px' }, datetimeUTC: false },
    axisBorder: { show: false },
    axisTicks: { show: false },
  },
  yaxis: { labels: { style: { colors: '#94a3b8', fontSize: '11px' } }, forceNiceScale: true, min: 0 },
  grid: { strokeDashArray: 3, borderColor: '#f1f5f9' },
  legend: { show: false },
  markers: { size: 0 },
  tooltip: { x: { format: 'MM/dd HH:mm' } },
}))

onMounted(fetchSnapshots)
</script>

<template>
  <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-6" data-testid="pipeline-chart">
    <h3 class="font-black text-navy-900 mb-1">機制運作狀態</h3>
    <p class="text-xs text-slate-400 mb-4">每 4 小時採樣一次，追蹤 AI 查證機制的運作情形</p>

    <p v-if="error" class="text-sm text-red-600">運作狀態暫時讀不到</p>

    <div v-else-if="loading" class="flex items-center gap-2 text-sm text-slate-400 py-6">
      <Loader2 :size="16" class="animate-spin" />載入中
    </div>

    <p v-else-if="snapshots.length === 0" class="text-sm text-slate-400">
      還沒有採樣資料，機制上線後會在這裡累積走勢。
    </p>

    <template v-else-if="snapshots.length < MIN_POINTS_FOR_CHART">
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <div v-for="m in METRICS" :key="m.key" class="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
          <p class="text-2xl font-black text-navy-900">{{ latest?.[m.key].toLocaleString() ?? '–' }}</p>
          <p class="text-[11px] font-bold text-slate-400 mt-1">{{ m.label }}</p>
        </div>
      </div>
      <p class="text-xs text-slate-400">
        目前累積 {{ snapshots.length }} 筆採樣，每 4 小時新增一筆；再過約 {{ pointsNeeded * SAMPLE_INTERVAL_HOURS }} 小時就能看到走勢圖。
      </p>
    </template>

    <template v-else>
      <div class="flex flex-wrap gap-1.5 mb-3">
        <button v-for="m in METRICS" :key="m.key" type="button"
          :class="['px-3 py-1 rounded-full text-xs font-bold border transition-colors', visible.has(m.key) ? 'text-white border-transparent' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400']"
          :style="visible.has(m.key) ? { backgroundColor: m.color } : undefined"
          @click="toggleMetric(m.key)">
          {{ m.label }}
        </button>
      </div>
      <div class="h-64">
        <ClientOnly><apexchart type="line" height="100%" :options="chartOptions" :series="chartSeries" /></ClientOnly>
      </div>
    </template>
  </section>
</template>
