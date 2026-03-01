<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import Hero from '../components/Hero.vue'
import AdminNav from '../components/AdminNav.vue'
import { useSupabase } from '../composables/useSupabase'
import { useDailyStats } from '../composables/useDailyStats'
import {
  BarChart3,
  Users,
  FileText,
  RefreshCw,
  Activity,
  DollarSign,
  CheckCircle,
  Loader2,
  TrendingUp,
  MapPin,
} from 'lucide-vue-next'

const { regionStats } = useSupabase()
const {
  dailyStats,
  monthlyTrend,
  taskTypeDistribution,
  loading,
  fetchAll,
} = useDailyStats()

const selectedDate = ref(new Date().toISOString().slice(0, 10))

onMounted(() => {
  fetchAll(selectedDate.value)
})

watch(selectedDate, (newDate) => {
  fetchAll(newDate)
})

// Task type label mapping
const taskTypeLabels: Record<string, string> = {
  candidate_search: '候選人搜尋',
  policy_search: '政見搜尋',
  policy_verify: '政見驗證',
  progress_tracking: '進度追蹤',
  policy_import: '政見匯入',
  politician_update: '候選人更新',
  user_contribution: '使用者貢獻',
  news_check: '新聞查核',
}

function getTaskTypeLabel(type: string) {
  return taskTypeLabels[type] || type
}

// Stat cards config
const statCards = computed(() => [
  {
    label: '今日新增候選人',
    value: dailyStats.value.todayCandidates,
    icon: Users,
    color: 'text-blue-600',
    bg: 'bg-blue-50',
  },
  {
    label: '今日新增政見',
    value: dailyStats.value.todayPolicies,
    icon: FileText,
    color: 'text-emerald-600',
    bg: 'bg-emerald-50',
  },
  {
    label: '今日更新筆數',
    value: dailyStats.value.todayUpdates,
    icon: RefreshCw,
    color: 'text-violet-600',
    bg: 'bg-violet-50',
  },
  {
    label: '今日執行任務',
    value: dailyStats.value.todayTasks,
    icon: Activity,
    color: 'text-amber-600',
    bg: 'bg-amber-50',
  },
  {
    label: '任務成功率',
    value: `${dailyStats.value.todaySuccessRate}%`,
    icon: CheckCircle,
    color: 'text-green-600',
    bg: 'bg-green-50',
  },
  {
    label: 'API 花費 (USD)',
    value: `$${dailyStats.value.todayCostUSD.toFixed(4)}`,
    icon: DollarSign,
    color: 'text-rose-600',
    bg: 'bg-rose-50',
  },
])

// Monthly cost trend chart options
const costChartOptions = computed(() => {
  // Aggregate by month
  const monthMap = new Map<string, number>()
  for (const item of monthlyTrend.value) {
    const monthLabel = item.month.slice(0, 7) // YYYY-MM
    monthMap.set(monthLabel, (monthMap.get(monthLabel) || 0) + item.totalCost)
  }
  const sorted = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-6)

  return {
    options: {
      chart: { type: 'line' as const, toolbar: { show: false }, fontFamily: 'inherit' },
      stroke: { curve: 'smooth' as const, width: 3 },
      colors: ['#6366f1'],
      xaxis: { categories: sorted.map(([m]) => m) },
      yaxis: {
        title: { text: 'USD' },
        labels: { formatter: (v: number) => `$${v.toFixed(2)}` },
      },
      tooltip: { y: { formatter: (v: number) => `$${v.toFixed(4)}` } },
      grid: { borderColor: '#f1f5f9' },
    },
    series: [{
      name: 'API 花費',
      data: sorted.map(([, cost]) => Number(cost.toFixed(4))),
    }],
  }
})

// Task type donut chart options
const donutChartOptions = computed(() => {
  const labels = taskTypeDistribution.value.map(d => getTaskTypeLabel(d.taskType))
  const series = taskTypeDistribution.value.map(d => d.count)

  return {
    options: {
      chart: { type: 'donut' as const, fontFamily: 'inherit' },
      labels,
      colors: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'],
      legend: { position: 'bottom' as const },
      plotOptions: {
        pie: { donut: { labels: { show: true, total: { show: true, label: '總任務數' } } } },
      },
    },
    series,
  }
})

// Region coverage table
const regionCoverage = computed(() => {
  // Only county-level stats (sub_region is null)
  return regionStats.value
    .filter(r => !r.sub_region)
    .map(r => ({
      region: r.region,
      politicians: r.total_politicians,
      policies: r.policy_count,
      mayorCount: r.mayor_count,
      councilorCount: r.councilor_count,
    }))
    .sort((a, b) => b.politicians - a.politicians)
})

const regionSortKey = ref<'politicians' | 'policies'>('politicians')

const sortedRegionCoverage = computed(() => {
  return [...regionCoverage.value].sort((a, b) =>
    b[regionSortKey.value] - a[regionSortKey.value]
  )
})
</script>

<template>
  <Hero>
    <template #icon>
      <BarChart3 :size="300" />
    </template>
    <h1 class="text-3xl md:text-4xl font-bold mb-2">統計總覽</h1>
    <p class="text-slate-300 text-lg">Policy AI 系統每日統計報表</p>
  </Hero>

  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-8 relative z-30 pb-16">
    <!-- Admin Nav -->
    <div class="mb-6">
      <AdminNav />
    </div>

    <!-- Date Picker -->
    <div class="flex items-center gap-3 mb-6">
      <label class="text-sm font-medium text-slate-600">選擇日期</label>
      <input
        v-model="selectedDate"
        type="date"
        class="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      <button
        @click="selectedDate = new Date().toISOString().slice(0, 10)"
        class="px-3 py-2 text-sm bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100 transition-colors"
      >
        今天
      </button>
      <Loader2 v-if="loading" :size="18" class="animate-spin text-slate-400" />
    </div>

    <!-- Stat Cards -->
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
      <div
        v-for="card in statCards"
        :key="card.label"
        class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm"
      >
        <div class="flex items-center gap-2 mb-2">
          <div :class="['p-2 rounded-lg', card.bg]">
            <component :is="card.icon" :size="16" :class="card.color" />
          </div>
        </div>
        <div class="text-2xl font-bold text-navy-900">{{ card.value }}</div>
        <div class="text-xs text-slate-500 mt-1">{{ card.label }}</div>
      </div>
    </div>

    <!-- Charts Row -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
      <!-- Monthly Cost Trend -->
      <div class="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <div class="flex items-center gap-2 mb-4">
          <TrendingUp :size="18" class="text-indigo-600" />
          <h3 class="text-lg font-semibold text-navy-900">月成本趨勢</h3>
        </div>
        <div v-if="costChartOptions.series[0].data.length > 0">
          <apexchart
            type="line"
            height="280"
            :options="costChartOptions.options"
            :series="costChartOptions.series"
          />
        </div>
        <div v-else class="flex items-center justify-center h-[280px] text-slate-400 text-sm">
          暫無月度數據
        </div>
      </div>

      <!-- Task Type Distribution -->
      <div class="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <div class="flex items-center gap-2 mb-4">
          <Activity :size="18" class="text-amber-600" />
          <h3 class="text-lg font-semibold text-navy-900">任務類型分佈</h3>
        </div>
        <div v-if="donutChartOptions.series.length > 0">
          <apexchart
            type="donut"
            height="280"
            :options="donutChartOptions.options"
            :series="donutChartOptions.series"
          />
        </div>
        <div v-else class="flex items-center justify-center h-[280px] text-slate-400 text-sm">
          今日暫無任務
        </div>
      </div>
    </div>

    <!-- Region Coverage Table -->
    <div class="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <MapPin :size="18" class="text-emerald-600" />
          <h3 class="text-lg font-semibold text-navy-900">各縣市資料覆蓋</h3>
        </div>
        <div class="flex gap-2">
          <button
            @click="regionSortKey = 'politicians'"
            :class="[
              'px-3 py-1 text-xs rounded-lg transition-colors',
              regionSortKey === 'politicians'
                ? 'bg-navy-800 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            ]"
          >
            依候選人排序
          </button>
          <button
            @click="regionSortKey = 'policies'"
            :class="[
              'px-3 py-1 text-xs rounded-lg transition-colors',
              regionSortKey === 'policies'
                ? 'bg-navy-800 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            ]"
          >
            依政見排序
          </button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-slate-200">
              <th class="text-left py-3 px-4 font-medium text-slate-600">縣市</th>
              <th class="text-right py-3 px-4 font-medium text-slate-600">候選人數</th>
              <th class="text-right py-3 px-4 font-medium text-slate-600">縣市長</th>
              <th class="text-right py-3 px-4 font-medium text-slate-600">縣市議員</th>
              <th class="text-right py-3 px-4 font-medium text-slate-600">政見數</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in sortedRegionCoverage"
              :key="row.region"
              class="border-b border-slate-100 hover:bg-slate-50 transition-colors"
            >
              <td class="py-3 px-4 font-medium text-navy-900">{{ row.region }}</td>
              <td class="text-right py-3 px-4">{{ row.politicians }}</td>
              <td class="text-right py-3 px-4">{{ row.mayorCount }}</td>
              <td class="text-right py-3 px-4">{{ row.councilorCount }}</td>
              <td class="text-right py-3 px-4">
                <span :class="row.policies > 0 ? 'text-emerald-600 font-medium' : 'text-slate-400'">
                  {{ row.policies }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
