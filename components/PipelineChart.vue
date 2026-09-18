<script setup lang="ts">
import { computed, onMounted, ref, defineAsyncComponent } from 'vue'
import { Loader2, Activity } from 'lucide-vue-next'

const apexchart = defineAsyncComponent(() => import('vue3-apexcharts'))
import { usePipelineSnapshots } from '../composables/usePipelineSnapshots'
import { withinHours } from '../lib/stats-range'
import { METRIC_COLOR } from '../lib/brand-colors'
import ChartLegend, { type LegendItem } from './ChartLegend.vue'

/**
 * 機制健康度圖表：資料庫每小時寫入一筆採樣，用來讓讀者確認「AI 查證機制真的在跑」。
 * 採樣還太少畫不出走勢時（<3 筆）改顯示目前數值，避免一張看起來像壞掉的空折線圖。
 */
const METRICS = [
  // 2026-09-16：「我是想放 資料缺口／任務清單 的總數」——原本只有一條「待查任務」，
  // 兩者加起來就是它，但混在一起看不出是缺口在長還是人在建任務。
  { key: 'gapsOpen', label: '資料缺口', color: METRIC_COLOR.gaps },
  { key: 'manualOpen', label: '任務清單', color: METRIC_COLOR.manualTasks },
  { key: 'pending', label: '待驗證貢獻', color: METRIC_COLOR.pending },
  { key: 'applied', label: '已上線累計', color: METRIC_COLOR.applied },
  { key: 'votesTotal', label: '驗證票累計', color: METRIC_COLOR.verifications },
] as const
type MetricKey = (typeof METRICS)[number]['key']

const SAMPLE_INTERVAL_HOURS = 1
// 兩個點就是一條線，畫得出來。一個點只能是數字，畫成圖跟壞掉沒兩樣。
const MIN_POINTS_FOR_CHART = 2

/** 時間窗（小時）與標題後綴。統計頁整頁共用一組，由上層傳進來；沒給就畫全部採樣 */
const props = defineProps<{ hours?: number; rangeLabel?: string }>()

const { snapshots, loading, error, fetchSnapshots } = usePipelineSnapshots()
const inRange = computed(() => (props.hours ? withinHours(snapshots.value, props.hours) : snapshots.value))

// 預設勾「待驗證貢獻／已上線累計／驗證票累計」——這三條講的是同一件事的三個階段：
// 交進來、被核對、真的上線。缺口與任務清單是另一件事（還沒進來的），要看的人自己勾。
// （量級差距已經由「每條線各自一條 Y 軸」解決，見下面 chartOptions 的 yaxis。）
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

/**
 * 兩種看法（2026-09-17 交代做成兩個按鈕）：
 *   數量＝所有線共用一條 Y 軸，可以直接比誰多、差多少；小的那幾條會貼著底。
 *   走勢＝每條線各自一條 Y 軸，看的是各自在漲多少；線之間的高低沒有意義。
 * 預設走勢：這張圖要回答的是「機制有沒有在跑」，而已上線累計 167 擺在待驗證 980
 * 旁邊時，它整整一天的成長不到一個像素。
 */
const SCALE_MODES = [
  { key: 'trend', label: '走勢', hint: '每條線各自縮放，看各自漲多少' },
  { key: 'absolute', label: '數量', hint: '共用一條刻度，直接比大小' },
] as const
type ScaleMode = (typeof SCALE_MODES)[number]['key']
const scaleMode = ref<ScaleMode>('trend')

const latest = computed(() => snapshots.value[snapshots.value.length - 1] ?? null)
const pointsNeeded = computed(() => Math.max(0, MIN_POINTS_FOR_CHART - inRange.value.length))

const visibleMetrics = computed(() => METRICS.filter(m => visible.value.has(m.key)))

// 圖例在圖的下方、圓點＋文字，跟統計頁其他圖一樣；點一下切換那條線，數字是最新一筆
const legendItems = computed<LegendItem[]>(() => METRICS.map(m => ({
  key: m.key,
  label: m.label,
  color: m.color,
  active: visible.value.has(m.key),
  value: latest.value ? latest.value[m.key].toLocaleString() : undefined,
})))

const chartSeries = computed(() =>
  visibleMetrics.value.map(m => ({
    name: m.label,
    data: inRange.value.map(s => s[m.key]),
  }))
)

/**
 * 用分類軸而不是時間軸：採樣固定一小時一次，一格就該是一次採樣。
 * 時間軸在樣本還少的時候會自己在兩點之間插出 5 分鐘一格的刻度，
 * 畫面看起來像每 5 分鐘採樣一次，跟這張圖要傳達的事實相反。
 * 標籤帶真正的採樣時刻，所以萬一某一次沒跑成，從時間跳號看得出來。
 */
const axisLabels = computed(() =>
  inRange.value.map(s => {
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
    // 採樣累積到幾十筆之後，每一格都標時間會疊成一片灰糊；只留幾個看得懂的刻度
    tickAmount: Math.min(8, axisLabels.value.length),
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
  // 數量＝一條共用的軸（從 0 起跳才比得出倍數）；走勢＝每條線一條軸、刻度只在單選時顯示，
  // 多條線共用一組刻度反而是假的，數值看標籤上的數字與提示框。
  yaxis: scaleMode.value === 'absolute'
    ? { labels: { style: { colors: '#94a3b8', fontSize: '11px' } }, forceNiceScale: true, min: 0 }
    : visibleMetrics.value.map((m, i) => ({
      seriesName: m.label,
      show: visibleMetrics.value.length === 1 && i === 0,
      labels: { style: { colors: '#94a3b8', fontSize: '11px' } },
      forceNiceScale: true,
    })),
  grid: { strokeDashArray: 3, borderColor: '#f1f5f9' },
  legend: { show: false },
  // 線上不畫圓點（2026-09-18）：整頁的折線統一只有線
  markers: { size: 0 },
  tooltip: { shared: true, intersect: false },
}))

onMounted(fetchSnapshots)
</script>

<template>
  <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-6" data-testid="pipeline-chart">
    <div class="flex items-center justify-between gap-3 mb-4">
      <h3 class="font-black text-navy-900 flex items-center gap-2"><Activity :size="18" class="text-emerald-600" />運作狀態<template v-if="rangeLabel">({{ rangeLabel }})</template></h3>
      <div v-if="inRange.length >= MIN_POINTS_FOR_CHART" class="flex rounded-lg border border-slate-200 overflow-hidden" data-testid="scale-mode">
        <button v-for="m in SCALE_MODES" :key="m.key" type="button" :title="m.hint"
          :class="['px-3 py-1 text-xs font-bold transition-colors', scaleMode === m.key ? 'bg-navy-900 text-white' : 'bg-white text-slate-500 hover:bg-slate-50']"
          :aria-pressed="scaleMode === m.key" @click="scaleMode = m.key">
          {{ m.label }}
        </button>
      </div>
    </div>

    <p v-if="error" class="text-sm text-red-600">運作狀態暫時讀不到</p>

    <div v-else-if="loading" class="flex items-center gap-2 text-sm text-slate-400 py-6">
      <Loader2 :size="16" class="animate-spin" />載入中
    </div>

    <p v-else-if="inRange.length === 0" class="text-sm text-slate-400">
      還沒有採樣資料，機制上線後會在這裡累積走勢。
    </p>

    <template v-else-if="inRange.length < MIN_POINTS_FOR_CHART">
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <div v-for="m in METRICS" :key="m.key" class="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
          <p class="text-2xl font-black text-navy-900">{{ latest?.[m.key].toLocaleString() ?? '–' }}</p>
          <p class="text-[11px] font-bold text-slate-400 mt-1">{{ m.label }}</p>
        </div>
      </div>
      <p class="text-xs text-slate-400">
        目前累積 {{ inRange.length }} 筆採樣，每小時新增一筆；再過約 {{ pointsNeeded * SAMPLE_INTERVAL_HOURS }} 小時就能看到走勢圖。
      </p>
    </template>

    <template v-else>
      <div class="h-64">
        <ClientOnly><apexchart type="line" height="100%" :options="chartOptions" :series="chartSeries" /></ClientOnly>
      </div>
      <ChartLegend :items="legendItems" clickable @toggle="(k) => toggleMetric(k as MetricKey)" />
      <p v-if="inRange.length < 6" class="text-xs text-slate-400 mt-2">
        目前累積 {{ inRange.length }} 個採樣點（每小時一個），走勢還很短；累積滿一天之後會更看得出變化。
      </p>
    </template>
  </section>
</template>
