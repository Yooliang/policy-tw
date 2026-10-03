<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { Bot } from 'lucide-vue-next'
import { supabasePublic } from '../../lib/supabase'
import { withTimeoutAndRetry } from '../../lib/retry'
import { BRAND, CATEGORY_SERIES } from '../../lib/brand-colors'
import { CHART_LEGEND } from '../../lib/chart-style'
const apexchart = defineAsyncComponent(() => import('vue3-apexcharts'))

/**
 * 被 AI 讀了幾次（2026-09-23）：AI 時代只看瀏覽數會低估正見的影響——AI 讀完直接回答使用者，人不一定點進來。
 * 資料是正見.tw 的 Worker 依 User-Agent／Referer 分類後的每日計數（ai_reads_daily，cloudflare/ai-reads.js）。
 * 被 Cloudflare 在邊緣擋掉的請求進不到 Worker，數不到。
 *
 * 2026-09-29 維護者：改成圖表；代理讀協議（/skill.md，多半是我們自己的貢獻代理）另外算，不混進「AI 當場來讀」。
 * 2026-10-03 維護者：代理讀協議改成列表裡的一列、只放數字（原本是表格下方一句註解）；不畫進折線圖。
 */

// 時間窗由外層頁面決定（2026-10-03 起在 /ai 頁，頁上自己一組 7／14／30 天）
const props = withDefaults(defineProps<{ days?: number; rangeLabel?: string }>(), { days: 7, rangeLabel: '7D' })

interface Row { kind: string; agent: string; hits: number }
interface DayRow { day: string; kind: string; hits: number }

const KIND_LABEL: Record<string, { label: string; hint: string }> = {
  ai_user: { label: 'AI 當場來讀', hint: '有人問 AI，AI 當場讀正見來回答' },
  ai_referral: { label: '從 AI 點進來的人', hint: '在 AI 的回答裡點了正見的連結' },
  ai_search: { label: 'AI 搜尋建索引', hint: 'AI 搜尋服務收錄正見的頁面' },
  ai_training: { label: 'AI 訓練抓取', hint: '大量抓資料訓練模型' },
  search_engine: { label: '傳統搜尋引擎', hint: 'Google、Bing 等（對照用）' },
}
const KIND_ORDER = ['ai_user', 'ai_referral', 'ai_search', 'ai_training', 'search_engine']
const COLORS = [...CATEGORY_SERIES]

const rows = ref<Row[]>([])
const series = ref<DayRow[]>([])
const failed = ref(false)
const loaded = ref(false)

async function load() {
  const days = props.days
  failed.value = false
  try {
    const [sum, daily] = await Promise.all([
      withTimeoutAndRetry(`ai_reads_summary ${days}d`, (signal) => supabasePublic.rpc('ai_reads_summary', { p_days: days }).abortSignal(signal)),
      withTimeoutAndRetry(`ai_reads_series ${days}d`, (signal) => supabasePublic.rpc('ai_reads_series', { p_days: days }).abortSignal(signal)),
    ])
    if (sum.error) throw sum.error
    if (daily.error) throw daily.error
    if (days !== props.days) return
    rows.value = ((sum.data ?? []) as Row[]).map((r) => ({ ...r, hits: Number(r.hits) }))
    series.value = ((daily.data ?? []) as DayRow[]).map((r) => ({ ...r, hits: Number(r.hits) }))
  } catch {
    failed.value = true
  } finally {
    loaded.value = true
  }
}
onMounted(load)
watch(() => props.days, load)

const totalOf = (kind: string) => rows.value.filter((r) => r.kind === kind).reduce((s, r) => s + r.hits, 0)

const byKind = computed(() => KIND_ORDER.map((kind, i) => {
  const agents = new Map<string, number>()
  for (const r of rows.value) if (r.kind === kind) agents.set(r.agent, (agents.get(r.agent) ?? 0) + r.hits)
  const top = [...agents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a} ${n}`)
  return { kind, ...KIND_LABEL[kind], total: totalOf(kind), top, color: COLORS[i] ?? BRAND.other }
}))

const protocolTotal = computed(() => totalOf('agent_protocol'))

// 沒有讀取的日子也要有點（0），線才不會跳過
const dayList = computed(() => {
  const out: string[] = []
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  for (let i = props.days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  return out
})

const chartSeries = computed(() => KIND_ORDER.map((kind) => ({
  name: KIND_LABEL[kind].label,
  data: dayList.value.map((day) => series.value.filter((r) => r.kind === kind && r.day === day).reduce((s, r) => s + r.hits, 0)),
})))

// 訓練爬蟲一天可以上萬次、當場來讀一天個位數，線性刻度下小的全貼在底部：用對數刻度
const chartOptions = computed(() => ({
  chart: { type: 'line' as const, toolbar: { show: false }, zoom: { enabled: false } },
  colors: COLORS,
  stroke: { width: 2, curve: 'straight' as const },
  dataLabels: { enabled: false },
  xaxis: {
    categories: dayList.value.map((d) => d.slice(5).replace('-', '/')),
    labels: { style: { colors: '#94a3b8', fontSize: '10px' }, hideOverlappingLabels: true },
    axisBorder: { show: false }, axisTicks: { show: false }, tooltip: { enabled: false },
  },
  yaxis: { logarithmic: true, min: 1, labels: { style: { colors: '#94a3b8', fontSize: '10px' }, formatter: (v: number) => Math.round(v).toLocaleString() } },
  grid: { strokeDashArray: 3, borderColor: '#f1f5f9' },
  legend: CHART_LEGEND,
  markers: { size: 0 },
  tooltip: { shared: true, intersect: false },
}))
</script>

<template>
  <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="ai-reads">
    <div class="flex flex-wrap items-center justify-between gap-2 mb-1">
      <h3 class="font-black text-navy-900 flex items-center gap-2"><Bot :size="18" class="text-violet-600" />AI 讀取({{ rangeLabel }})</h3>
      <slot name="actions" />
    </div>
    <p class="text-xs text-slate-500 mb-3">AI 讀完正見直接回答使用者，不一定有人點進來；這裡數的是正見.tw 被讀了幾次（每日，對數刻度）。</p>
    <p v-if="loaded && failed" class="text-sm text-slate-500">暫時讀不到統計。</p>
    <p v-else-if="loaded && rows.length === 0" class="text-sm text-slate-500">還沒有資料（2026-09-23 開始記錄）。</p>
    <template v-else-if="loaded">
      <div class="h-56">
        <ClientOnly><apexchart type="line" height="100%" :options="chartOptions" :series="chartSeries" /></ClientOnly>
      </div>
      <table class="w-full text-sm mt-2">
        <tbody>
          <tr v-for="k in byKind" :key="k.kind" class="border-t border-slate-100 first:border-t-0">
            <td class="py-1.5 pr-2">
              <div class="font-medium text-slate-800 flex items-center gap-1.5"><span class="w-2 h-2 rounded-full shrink-0" :style="{ backgroundColor: k.color }"></span>{{ k.label }}</div>
              <div class="text-xs text-slate-400 ml-3.5">{{ k.top.length ? k.top.join('、') : k.hint }}</div>
            </td>
            <td class="py-1.5 text-right font-black text-navy-900 tabular-nums">{{ k.total.toLocaleString() }}</td>
          </tr>
          <tr class="border-t border-slate-100" data-testid="ai-reads-protocol">
            <td class="py-1.5 pr-2">
              <div class="font-medium text-slate-800 flex items-center gap-1.5"><span class="w-2 h-2 shrink-0"></span>代理讀協議</div>
            </td>
            <td class="py-1.5 text-right font-black text-navy-900 tabular-nums">{{ protocolTotal.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
