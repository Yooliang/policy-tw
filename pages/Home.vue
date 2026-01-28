<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import PolicyCard from '../components/PolicyCard.vue'
import Hero from '../components/Hero.vue'
import { ArrowRight, Activity, Users, FileCheck, Vote, Star, TrendingUp } from 'lucide-vue-next'
import { RouterLink, useRouter } from 'vue-router'

const router = useRouter()
const { policies, politicians, loading } = useSupabase()
const checkpointIds = ref<number[]>([])

const loadCheckpoints = () => {
  checkpointIds.value = JSON.parse(localStorage.getItem('zhengjian_checkpoints') || '[]')
}

onMounted(() => {
  loadCheckpoints()
  window.addEventListener('checkpoints_updated', loadCheckpoints)
})

onUnmounted(() => {
  window.removeEventListener('checkpoints_updated', loadCheckpoints)
})

const checkpointPolicies = computed(() =>
  policies.value.filter(p => checkpointIds.value.includes(p.id)).slice(0, 3)
)

const statusData = computed(() => [
  { name: '已實現', value: policies.value.filter(p => p.status === 'Achieved').length, color: '#10b981' },
  { name: '進行中', value: policies.value.filter(p => p.status === 'In Progress').length, color: '#3b82f6' },
  { name: '滯後', value: policies.value.filter(p => p.status === 'Stalled').length, color: '#f59e0b' },
  { name: '提出', value: policies.value.filter(p => p.status === 'Proposed').length, color: '#94a3b8' },
])

const categoryData = [
  { name: '交通', count: 12 },
  { name: '都更', count: 8 },
  { name: '社福', count: 15 },
  { name: '經濟', count: 10 },
  { name: '教育', count: 7 },
]

const recentPolicies = computed(() => policies.value.slice(0, 3))

const barOptions = {
  chart: { type: 'bar' as const, toolbar: { show: false } },
  plotOptions: { bar: { borderRadius: 8, columnWidth: '48px' } },
  xaxis: {
    categories: categoryData.map(d => d.name),
    labels: { style: { colors: '#94a3b8', fontSize: '12px', fontWeight: 'bold' } },
    axisBorder: { show: false },
    axisTicks: { show: false },
  },
  yaxis: {
    labels: { style: { colors: '#94a3b8', fontSize: '12px', fontWeight: 'bold' } },
  },
  grid: { strokeDashArray: 3, borderColor: '#f1f5f9', xaxis: { lines: { show: false } } },
  colors: ['#2563eb'],
  tooltip: { theme: 'light' },
  dataLabels: { enabled: false },
}
const barSeries = [{ name: 'count', data: categoryData.map(d => d.count) }]

const donutOptions = computed(() => ({
  chart: { type: 'donut' as const },
  labels: statusData.value.map(d => d.name),
  colors: statusData.value.map(d => d.color),
  stroke: { show: false },
  legend: { show: false },
  plotOptions: { pie: { donut: { size: '70%' } } },
  dataLabels: { enabled: false },
  tooltip: { theme: 'light' },
}))
const donutSeries = computed(() => statusData.value.map(d => d.value))
</script>

<template>
  <div class="min-h-screen">
    <Hero background-image="/images/hero-background.png">
      <template #title>匯聚多元視角，智能解析政見<br /><span class="text-blue-400">讓正確被看見</span></template>
      <template #description>正見是一個超越黨派色彩的政策歷史追蹤平台。我們記錄政見的提出與執行，利用 AI 進行客觀分析，消除資訊不對稱。</template>
      <template #actions>
      </template>
    </Hero>

    <section class="py-20 bg-white">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
          <div class="bg-slate-50 p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-center justify-center text-center">
            <div class="p-4 bg-blue-100 rounded-2xl mb-4 text-blue-600"><FileCheck :size="32" /></div>
            <h3 class="text-4xl font-black text-navy-900">1,248</h3>
            <p class="text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">追蹤中政見總數</p>
          </div>
          <div class="bg-slate-50 p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-center justify-center text-center">
            <div class="p-4 bg-emerald-100 rounded-2xl mb-4 text-emerald-600"><TrendingUp :size="32" /></div>
            <h3 class="text-4xl font-black text-navy-900">42%</h3>
            <p class="text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">平均行政達成率</p>
          </div>
          <div class="bg-slate-50 p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-center justify-center text-center">
            <div class="p-4 bg-amber-100 rounded-2xl mb-4 text-amber-600"><Users :size="32" /></div>
            <h3 class="text-4xl font-black text-navy-900">85萬</h3>
            <p class="text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">公民參與稽核次數</p>
          </div>

          <div class="md:col-span-2 bg-white p-8 rounded-3xl border border-slate-200 shadow-sm h-[400px]">
            <h3 class="text-xl font-bold text-navy-900 mb-6">熱門議題稽核分佈</h3>
            <apexchart type="bar" height="85%" :options="barOptions" :series="barSeries" />
          </div>

          <div class="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm h-[400px]">
            <h3 class="text-xl font-bold text-navy-900 mb-6">政見執行狀態</h3>
            <apexchart type="donut" height="75%" :options="donutOptions" :series="donutSeries" />
            <div class="flex flex-wrap justify-center gap-4 text-[10px] font-black text-slate-400 mt-4 uppercase tracking-widest">
              <div v-for="item in statusData" :key="item.name" class="flex items-center gap-1.5">
                <div class="w-2.5 h-2.5 rounded-full" :style="{ backgroundColor: item.color }"></div>
                {{ item.name }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Checkpoints Quick View -->
    <section v-if="checkpointPolicies.length > 0" class="py-12 bg-amber-50/50 border-b border-amber-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between items-center mb-8">
        <h2 class="text-xl font-black text-navy-900 flex items-center gap-2 uppercase tracking-tight">
            <Star class="text-amber-500" fill="currentColor" :size="24" />
            我的公民檢核點 Checkpoints
        </h2>
        <RouterLink to="/tracking" class="text-amber-600 font-bold text-sm flex items-center gap-1 hover:underline">
            查看全部 <ArrowRight :size="16" />
        </RouterLink>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 text-left">
        <template v-for="p in checkpointPolicies" :key="p.id">
            <PolicyCard
            v-if="politicians.find(pol => pol.id === p.politicianId)"
            :policy="p"
            :politician="politicians.find(pol => pol.id === p.politicianId)!"
            :on-click="() => router.push(`/policy/${p.id}`)"
            />
        </template>
        </div>
    </div>
    </section>

    <section class="py-24 bg-slate-50 border-t border-slate-100">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between items-end mb-12">
          <div class="text-left">
            <h2 class="text-3xl font-black text-navy-900">最新政見動態</h2>
            <p class="text-slate-500 mt-2 font-medium">即時追蹤全台首長行政進度與歷史更新。</p>
          </div>
          <RouterLink to="/tracking" class="bg-white px-6 py-2.5 rounded-xl border border-slate-200 text-blue-600 hover:text-white hover:bg-blue-600 transition-all font-bold text-sm shadow-sm flex items-center gap-2">
            查看全部政見 <ArrowRight :size="18" />
          </RouterLink>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 text-left">
          <template v-for="policy in recentPolicies" :key="policy.id">
            <PolicyCard
              v-if="politicians.find(c => c.id === policy.politicianId)"
              :policy="policy"
              :politician="politicians.find(c => c.id === policy.politicianId)!"
              :on-click="() => router.push(`/policy/${policy.id}`)"
            />
          </template>
        </div>
      </div>
    </section>
  </div>
</template>
