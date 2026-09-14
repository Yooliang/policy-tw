<script setup lang="ts">
import { computed, onMounted, ref, defineAsyncComponent } from 'vue'
import { Loader2 } from 'lucide-vue-next'

const apexchart = defineAsyncComponent(() => import('vue3-apexcharts'))
import { usePipelineSnapshots } from '../composables/usePipelineSnapshots'

/**
 * 機制健康度圖表：資料庫每小時寫入一筆採樣，用來讓讀者確認「AI 查證機制真的在跑」。
 * 採樣還太少畫不出走勢時（<3 筆）改顯示目前數值，避免一張看起來像壞掉的空折線圖。
 */
const METRICS = [
  { key: 'tasksOpen', label: '待查任務', color: '#ea580c' },
  { key: 'pending', label: '待驗證貢獻', color: '#2563eb' },
  { key: 'applied', label: '已上線累計', color: '#059669' },
  { key: 'votesTotal', label: '驗證票累計', color: '#7c3aed' },
] as const
type MetricKey = (typeof METRICS)[number]['key']

const SAMPLE_INTERVAL_HOURS = 1
// 兩個點就是一條線，畫得出來。一個點只能是數字，畫成圖跟壞掉沒兩樣。
const MIN_POINTS_FOR_CHART = 2

const { snapshots, loading, error, fetchSnapshots } = usePipelineSnapshots()

// 預設勾「待驗證貢獻／已上線累計／驗證票累計」——這三條講的是同一件事的三個階段：
// 交進來、被核對、真的上線。「待查任務」預設不勾：它現在是 842，量級比其他三條大一個
// 數量級，一起畫會把它們壓成貼著 X 軸的直線，看不出有沒有在動。要看的人自己勾。
const visible = ref<Set<MetricKey>>(new Set(['pending', 'applied', 'votesTotal']))

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
    data: snapshots.value.map(s => s[m.key]),
  }))
)

/**
 * 用分類軸而不是時間軸：採樣固定一小時一次，一格就該是一次採樣。
 * 時間軸在樣本還少的時候會自己在兩點之間插出 5 分鐘一格的刻度，
 * 畫面看起來像每 5 分鐘採樣一次，跟這張圖要傳達的事實相反。
 * 標籤帶真正的採樣時刻，所以萬一某一次沒跑成，從時間跳號看得出來。
 */
const axisLabels = computed(() =>
  snapshots.value.map(s => {
    const d = new Date(s.takenAt)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  })
)

const chartOptions = computed(() => ({
  chart: { type: 'line' as const, toolbar: { show: false }, zoom: { enabled: false } },
  colors: visibleMetrics.value.map(m => m.color),
  stroke: { width: 2, curve: 'smooth' as const },
  xaxis: {
    categories: axisLabels.value,
    labels: {
      style: { colors: '#94a3b8', fontSize: '11px' },
      rotate: -35,
      rotateAlways: false,
      hideOverlappingLabels: true,
    },
    axisBorder: { show: false },
    axisTicks: { show: false },
    tooltip: { enabled: false },
  },
  yaxis: { labels: { style: { colors: '#94a3b8', fontSize: '11px' } }, forceNiceScale: true, min: 0 },
  grid: { strokeDashArray: 3, borderColor: '#f1f5f9' },
  legend: { show: false },
  // 樣本還少的時候把採樣點畫出來，讀者才看得出這是一次次的採樣而不是連續曲線
  markers: { size: snapshots.value.length <= 8 ? 4 : 0 },
  tooltip: { shared: true, intersect: false },
}))

onMounted(fetchSnapshots)
</script>

<template>
  <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-6" data-testid="pipeline-chart">
    <h3 class="font-black text-navy-900 mb-4">機制運作狀態</h3>

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
        目前累積 {{ snapshots.length }} 筆採樣，每小時新增一筆；再過約 {{ pointsNeeded * SAMPLE_INTERVAL_HOURS }} 小時就能看到走勢圖。
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
      <p v-if="snapshots.length < 6" class="text-xs text-slate-400 mt-2">
        目前累積 {{ snapshots.length }} 個採樣點（每小時一個），走勢還很短；累積滿一天之後會更看得出變化。
      </p>
    </template>
  </section>
</template>
