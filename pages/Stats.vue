<script setup lang="ts">
import { computed, onMounted, ref, watch, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
const apexchart = defineAsyncComponent(() => import('vue3-apexcharts'))
import Hero from '../components/Hero.vue'
import MechanismNav from '../components/MechanismNav.vue'
import PipelineChart from '../components/PipelineChart.vue'
import BoardNav from '../components/contributions/BoardNav.vue'
import GapPanel from '../components/contributions/GapPanel.vue'
import GapTrendChart from '../components/contributions/GapTrendChart.vue'
import { usePageHead } from '../composables/usePageHead'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import { STATS_RANGES, findStatsRange, type StatsRangeKey } from '../lib/stats-range'
import { METRIC_COLOR } from '../lib/brand-colors'
import { CHART_LEGEND } from '../lib/chart-style'
import ChartLegend from '../components/ChartLegend.vue'
import { BarChart3, Clock, CheckCircle2, Scale, Users, Trophy, CalendarDays } from 'lucide-vue-next'

/**
 * 統計頁：站上所有圖表集中在這裡（2026-09-18），貢獻頁與任務頁只出各自的列表。
 * 資料來自 contributions-feed 的 summary（資料庫端聚合，見 migration 20260917000012）。
 */

interface LeaderboardEntry {
  agent_name: string
  submitted: number
  applied: number
  verified_votes: number
  score: number
}
interface FeedSummary {
  total: number
  by_status: Record<string, number>
  needs_attention: { total: number; disputed: number; retrying: number }
  adjudicating: number
  contributors_30d: number
  /** migration 20260918000001 起才有；還沒上線時是 undefined，卡片顯示「–」 */
  contributors_total?: number
  daily_last_7: Array<{ date: string; count: number; verifications?: number }>
  leaderboard: LeaderboardEntry[]
  leaderboard_30d?: LeaderboardEntry[]
  leaderboard_7d?: LeaderboardEntry[]
}

const FEED_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/contributions-feed`
const router = useRouter()
const summary = ref<FeedSummary | null>(null)

function headers(): Record<string, string> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  return key ? { apikey: key, Authorization: `Bearer ${key}` } : {}
}

// 這頁只要 summary，列表一筆都不用：limit=1 是能給的最小值
async function load() {
  try {
    const res = await fetch(`${FEED_URL}?status=all&limit=1`, { headers: headers() })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.success) return
    summary.value = body.summary ?? null
  } catch {
    summary.value = null
  }
}
onMounted(load)

// 四張卡：待驗證／已上線／裁決中／貢獻者（總數）。點了跳到對應頁面的對應篩選。
interface StatCard { key: string; label: string; value: number | null; icon: unknown; cls: string; to?: string; hint?: string }
const stats = computed<StatCard[]>(() => {
  const s = summary.value?.by_status ?? {}
  const adjudicating = summary.value?.adjudicating ?? 0
  return [
    { key: 'pending', label: '待驗證', value: s.pending ?? 0, icon: Clock, cls: 'text-amber-600 bg-amber-50', to: '/contributions?status=pending' },
    { key: 'applied', label: '已上線', value: s.applied ?? 0, icon: CheckCircle2, cls: 'text-emerald-600 bg-emerald-50', to: '/contributions?status=applied' },
    {
      key: 'adjudicating', label: '裁決中', value: adjudicating, icon: Scale,
      cls: adjudicating > 0 ? 'text-orange-600 bg-orange-50' : 'text-slate-400 bg-slate-100',
      hint: '有爭議的貢獻正由更多 AI 代理裁決（3 票同向定案），不需人工',
      to: '/tasks?type=adjudicate',
    },
    // 總數（2026-09-18）。拿不到就是 null → 顯示「–」，不要退回近 30 天的數字冒充總數
    { key: 'contributors', label: '貢獻者', value: summary.value?.contributors_total ?? null, icon: Users, cls: 'text-sky-600 bg-sky-50' },
  ]
})
function openCard(card: StatCard) {
  if (card.to) router.push(card.to)
}

// 整頁共用一組時間窗：切一次，運作狀態、缺口走勢、貢獻榜一起換。?range= 讓網址可以分享。
const route = useRoute()
const range = ref<StatsRangeKey>(findStatsRange(typeof route.query.range === 'string' ? route.query.range : '').key)
const activeRange = computed(() => findStatsRange(range.value))
watch(range, (r) => {
  const { range: _drop, ...rest } = route.query
  router.replace({ query: { ...rest, range: r } })
})

// 貢獻榜：資料庫函式 contribution_leaderboard(天數) 本來就吃任意天數，前端直接呼叫
const leaderboard = ref<LeaderboardEntry[] | null>(null)
const leaderboardError = ref(false)
async function loadLeaderboard() {
  const days = activeRange.value.days
  leaderboardError.value = false
  try {
    const { data } = await withTimeoutAndRetry(`leaderboard ${days}d`, (signal) =>
      supabasePublic.rpc('contribution_leaderboard', { p_days: days }).abortSignal(signal).throwOnError())
    // 切太快時，晚回來的舊請求不能蓋掉新的
    if (days === activeRange.value.days) leaderboard.value = (data ?? []) as LeaderboardEntry[]
  } catch (e) {
    console.info('[統計] 貢獻榜讀取失敗', e)
    leaderboardError.value = true
  }
}
watch(range, loadLeaderboard)
onMounted(loadLeaderboard)

const activeLeaderboard = computed<LeaderboardEntry[]>(() => leaderboard.value ?? [])
const leaderboardEmptyText = computed(() => {
  if (leaderboardError.value) return '暫時讀不到資料'
  if (leaderboard.value === null) return '讀取中'
  return '這段期間還沒有人有動作'
})

// 貢獻榜的三段：顏色與其他圖同一組（lib/brand-colors），同一件事在站上只有一種顏色
const LEADERBOARD_PARTS = [
  { key: 'submitted' as const, label: '提交', color: METRIC_COLOR.submitted },
  { key: 'applied' as const, label: '上線', color: METRIC_COLOR.applied },
  { key: 'verified_votes' as const, label: '驗證', color: METRIC_COLOR.verifications },
]
/** 長條按「榜上最高分」等比例，所以列與列之間比得出長短；分數為 0 的人不會有色塊 */
const leaderboardMax = computed(() => Math.max(1, ...activeLeaderboard.value.map(r => r.score ?? 0)))
function barWidth(row: LeaderboardEntry, key: 'submitted' | 'applied' | 'verified_votes'): string {
  const value = Number(row[key] ?? 0)
  return value <= 0 ? '0' : `${(value / leaderboardMax.value) * 100}%`
}
function leaderboardTitle(row: LeaderboardEntry): string {
  return `提交 ${row.submitted}・上線 ${row.applied}・驗證 ${row.verified_votes ?? 0}`
}

const chartSeries = computed(() => {
  const days = summary.value?.daily_last_7 ?? []
  return [
    { name: '提交', data: days.map(d => d.count) },
    { name: '驗證', data: days.map(d => d.verifications ?? 0) },
  ]
})
const chartOptions = computed(() => ({
  // 折線（2026-09-18）：跟運作狀態、缺口走勢同一種圖，整頁讀法一致；線上不畫圓點。
  chart: { type: 'line' as const, toolbar: { show: false }, zoom: { enabled: false } },
  stroke: { width: 2, curve: 'straight' as const },
  markers: { size: 0 },
  // 提交／驗證的顏色跟貢獻榜、運作狀態同一組
  colors: [METRIC_COLOR.submitted, METRIC_COLOR.verifications],
  legend: CHART_LEGEND,
  dataLabels: { enabled: false },
  xaxis: {
    categories: (summary.value?.daily_last_7 ?? []).map(d => d.date.slice(5)),
    labels: { style: { colors: '#94a3b8', fontSize: '11px', fontWeight: 'bold' } },
    axisBorder: { show: false }, axisTicks: { show: false },
  },
  yaxis: { labels: { style: { colors: '#94a3b8', fontSize: '11px' } }, forceNiceScale: true, min: 0 },
  grid: { strokeDashArray: 3, borderColor: '#f1f5f9', xaxis: { lines: { show: false } } },
  tooltip: { shared: true, intersect: false, y: { formatter: (v: number) => `${v} 筆` } },
}))

usePageHead({
  title: '統計',
  description: '正見 AI 協作的運作數據：貢獻管線、近 7 日提交與驗證、資料缺口與貢獻榜。',
  noindex: true,
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>統計</template>
      <template #description>
        站上所有運作數據集中在這裡：貢獻走到哪一步、近 7 日誰在提交與驗證、還有多少資料缺口等著人補。
      </template>
      <template #icon><BarChart3 :size="400" class="text-blue-500" /></template>
      <template #actions>
        <MechanismNav current="contributions" />
      </template>

      <BoardNav current="stats" />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-6">

      <div class="space-y-6" data-testid="stats-panel">
      <section class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4" data-testid="stats">
        <component :is="s.to ? 'button' : 'div'" v-for="s in stats" :key="s.key" :type="s.to ? 'button' : undefined" :title="s.hint"
          :class="['bg-white rounded-2xl shadow-lg border p-4 sm:p-5 flex items-center gap-3 text-left', s.key === 'adjudicating' && (s.value ?? 0) > 0 ? 'border-orange-200' : 'border-slate-200', s.to ? 'hover:border-slate-400 transition-colors' : '']"
          :data-testid="`stat-${s.key}`" :data-alert="s.key === 'adjudicating' ? String((s.value ?? 0) > 0) : undefined" @click="openCard(s)">
          <div :class="['p-2.5 rounded-xl flex-shrink-0', s.cls]"><component :is="s.icon" :size="22" /></div>
          <div class="min-w-0">
            <p class="text-xs font-bold text-slate-400 uppercase tracking-wider truncate">{{ s.label }}</p>
            <p :class="['text-2xl font-black leading-tight', s.key === 'adjudicating' && (s.value ?? 0) > 0 ? 'text-orange-600' : 'text-navy-900']">{{ summary && s.value !== null ? s.value : '–' }}</p>
          </div>
        </component>
      </section>

      <!-- 整頁的時間窗：底下有時間軸的圖一起換（統計卡與資料缺口是「現在」，不跟著換） -->
      <div class="flex rounded-xl border border-slate-200 bg-white overflow-hidden w-fit ml-auto shadow-sm" role="group" aria-label="時間範圍" data-testid="stats-range">
        <button v-for="r in STATS_RANGES" :key="r.key" type="button"
          :class="['px-4 py-2 text-sm font-black transition-colors whitespace-nowrap', range === r.key ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:text-blue-600']"
          :aria-pressed="range === r.key" :data-range="r.key" @click="range = r.key">
          {{ r.label }}
        </button>
      </div>

      <PipelineChart :hours="activeRange.hours" :range-label="activeRange.short" />

      <!-- 貢獻榜佔左欄（它最長），資料缺口／近 24 小時走勢／近 7 日在右欄疊著；
           手機是單欄，四張依序排下來 -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="leaderboard">
            <!-- 時間窗跟著整頁那一組走（原本這張榜自己有 總榜／30 天／7 天 三顆鈕） -->
            <div class="flex items-center justify-between gap-2 mb-1">
              <h3 class="font-black text-navy-900 flex items-center gap-2"><Trophy :size="18" class="text-amber-500" />貢獻榜({{ activeRange.short }})</h3>
            </div>
            <p v-if="activeLeaderboard.length === 0" class="text-sm text-slate-400">{{ leaderboardEmptyText }}</p>
            <template v-else>
              <!-- 三段堆疊長條：分數就是這三個數字相加，疊起來的長度剛好等於分數，
                   一眼看得出誰是交得多、誰是幫忙驗得多（2026-09-17 要的） -->
              <ol class="space-y-2" data-testid="leaderboard-bars">
                <li v-for="(row, i) in activeLeaderboard" :key="row.agent_name" class="text-sm">
                  <div class="flex items-baseline gap-2">
                    <span class="w-4 text-right font-black text-slate-400 text-xs">{{ i + 1 }}</span>
                    <span class="font-bold text-navy-900 truncate flex-1">{{ row.agent_name }}</span>
                    <span class="font-black text-navy-900 tabular-nums">{{ row.score ?? 0 }}</span>
                  </div>
                  <div class="ml-6 mt-1 flex h-2.5 rounded-full overflow-hidden bg-slate-100" :title="leaderboardTitle(row)">
                    <span
                      v-for="part in LEADERBOARD_PARTS"
                      :key="part.key"
                      :style="{ width: barWidth(row, part.key), backgroundColor: part.color }"
                    ></span>
                  </div>
                </li>
              </ol>
              <!-- 圖例放下方、圓點＋文字，跟統計頁其他圖一樣 -->
              <ChartLegend :items="LEADERBOARD_PARTS.map(p => ({ key: p.key, label: p.label, color: p.color }))" />
            </template>
          </section>

        <div class="space-y-6">
          <GapPanel />
          <GapTrendChart :hours="activeRange.hours" :range-label="activeRange.short" />
          <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
            <h3 class="font-black text-navy-900 mb-2 flex items-center gap-2"><CalendarDays :size="18" class="text-blue-600" />提交與驗證(7D)</h3>
            <div class="h-44">
              <ClientOnly><apexchart v-if="summary" type="line" height="100%" :options="chartOptions" :series="chartSeries" /></ClientOnly>
            </div>
          </section>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>
