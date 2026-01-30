<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'

import { useSupabase } from '../composables/useSupabase'
import PolicyCard from '../components/PolicyCard.vue'

import Hero from '../components/Hero.vue'
import { ArrowRight, Users, FileCheck, Vote, Star, TrendingUp } from 'lucide-vue-next'

import { RouterLink, useRouter } from 'vue-router'

const router = useRouter()
const { policies, politicians, elections } = useSupabase()

const checkpointIds = ref<string[]>([])

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

const totalPoliticians = computed(() => politicians.value.length)

// 2026 選舉專區統計 - 只計算 2026 九合一選舉的人數
const election2026 = computed(() => elections.value.find(e => e.name.includes('2026')))
const politicians2026Count = computed(() => {
  if (!election2026.value) return politicians.value.length
  const electionId = election2026.value.id
  return politicians.value.filter(p => p.electionIds?.includes(electionId)).length
})
const totalPolicies = computed(() => policies.value.length)
const averageProgress = computed(() => {
  if (policies.value.length === 0) return 0
  const sum = policies.value.reduce((acc, p) => acc + (p.progress || 0), 0)
  return Math.round(sum / policies.value.length)
})

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
  <div class="min-h-screen pb-20">
    <Hero background-image="/images/hero-background.png">
      <template #title>匯聚多元視角，智能解析政見<br /><span class="text-blue-400">讓正確被看見</span></template>
      <template #description>正見是一個超越黨派色彩的政策歷史追蹤平台。我們記錄政見的提出與執行，利用 AI 進行客觀分析，消除資訊不對稱。</template>
    </Hero>

    <!-- 2026 Election Special Zone (Prominent) -->
    <section class="py-12 bg-transparent election-2026-section">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="election-2026-border rounded-[52px] p-[5px]">
          <div class="bg-gradient-to-br from-navy-900 to-blue-900 rounded-[48px] p-10 text-white relative overflow-hidden shadow-2xl">
            <div class="absolute top-0 right-0 p-20 opacity-10 rotate-12"><Vote :size="300" /></div>
          <div class="relative z-10 flex flex-col md:flex-row items-center justify-between gap-10">
            <div class="text-left md:w-2/3">
              <span class="inline-block bg-amber-500 text-navy-900 px-4 py-1 rounded-full text-sm font-black mb-6 tracking-widest uppercase">Election 2026</span>
              <h2 class="text-4xl font-black mb-4 leading-tight">2026 九合一選舉專區</h2>
              <p class="text-blue-100 text-lg leading-relaxed mb-8 font-medium">預見治理藍圖，追蹤每一份競選承諾。我們為您整理全台參選人的政見，讓公民參與更有力量。</p>
              <div class="flex flex-wrap gap-4">
                <RouterLink to="/election/2026" class="px-8 py-4 bg-white text-navy-900 rounded-2xl font-black text-lg shadow-xl hover:bg-amber-400 transition-all flex items-center gap-3">
                   立即進入專區 <ArrowRight :size="24" />
                </RouterLink>
              </div>
            </div>
            <div class="md:w-1/3 grid grid-cols-2 gap-4">
              <div class="bg-white/10 p-6 rounded-3xl backdrop-blur-sm border border-white/10 text-center">
                <p class="text-blue-300 text-[10px] font-bold uppercase mb-2">已收錄人員</p>
                <p class="text-3xl font-black">{{ politicians2026Count.toLocaleString() }}+</p>
              </div>
              <div class="bg-white/10 p-6 rounded-3xl backdrop-blur-sm border border-white/10 text-center">
                <p class="text-blue-300 text-[10px] font-bold uppercase mb-2">更新頻率</p>
                <p class="text-3xl font-black">Daily</p>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>
    </section>

    <!-- Overall Stats -->
    <section class="py-20 bg-white">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
          <div class="bg-slate-50 p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-center justify-center text-center">
            <div class="p-4 bg-blue-100 rounded-2xl mb-4 text-blue-600"><FileCheck :size="32" /></div>
            <h3 class="text-4xl font-black text-navy-900">{{ totalPolicies.toLocaleString() }}</h3>
            <p class="text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">追蹤中政見總數</p>
          </div>
          <div class="bg-slate-50 p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-center justify-center text-center">
            <div class="p-4 bg-emerald-100 rounded-2xl mb-4 text-emerald-600"><TrendingUp :size="32" /></div>
            <h3 class="text-4xl font-black text-navy-900">{{ averageProgress }}%</h3>
            <p class="text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">平均行政達成率</p>
          </div>
          <div class="bg-slate-50 p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-center justify-center text-center">
            <div class="p-4 bg-amber-100 rounded-2xl mb-4 text-amber-600"><Users :size="32" /></div>
            <h3 class="text-4xl font-black text-navy-900">{{ totalPoliticians.toLocaleString() }}</h3>
            <p class="text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">已建檔政治人物</p>
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

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.5s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* 2026 Election Special Zone - 侵入 Hero */
.election-2026-section {
  margin-top: -110px;
  position: relative;
  z-index: 10;
}

.election-2026-border {
  background: linear-gradient(to bottom, #ffffff 0%, #fbbf24 100%);
}

</style>
