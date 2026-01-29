<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'

import { useSupabase } from '../composables/useSupabase'
import { useGlobalState } from '../composables/useGlobalState'
import PolicyCard from '../components/PolicyCard.vue'

import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import { ArrowRight, Activity, Users, FileCheck, Vote, Star, TrendingUp, MapPin, ChevronRight } from 'lucide-vue-next'

import { RouterLink, useRouter } from 'vue-router'

const router = useRouter()
const { policies, politicians, regionStats, loading } = useSupabase()
const { globalRegion, setGlobalRegion } = useGlobalState()

const twArea = {
    '基隆市': ['仁愛區', '信義區', '中正區', '中山區', '安樂區', '暖暖區', '七堵區'],
    '台北市': ['中正區', '大同區', '中山區', '松山區', '大安區', '萬華區', '信義區', '士林區', '北投區', '內湖區', '南港區', '文山區'],
    '新北市': ['萬里區', '金山區', '板橋區', '汐止區', '深坑區', '石碇區','瑞芳區', '平溪區', '雙溪區', '貢寮區', '新店區', '坪林區','烏來區', '永和區', '中和區', '土城區', '三峽區', '樹林區','鶯歌區', '三重區', '新莊區', '泰山區', '林口區', '蘆洲區','五股區', '八里區', '淡水區', '三芝區', '石門區'],
    '宜蘭縣': ['宜蘭市', '頭城鎮', '礁溪鄉', '壯圍鄉', '員山鄉', '羅東鎮','三星鄉', '大同鄉', '五結鄉', '冬山鄉', '蘇澳鎮', '南澳鄉','釣魚台列嶼'],
    '新竹市': ['東區', '北區', '香山區'],
    '新竹縣': ['竹北市', '湖口鄉', '新豐鄉', '新埔鎮', '關西鎮', '芎林鄉','寶山鄉', '竹東鎮', '五峰鄉', '橫山鄉', '尖石鄉', '北埔鄉','峨嵋鄉'],
    '桃園市': ['中壢區', '平鎮區', '龍潭區', '楊梅區', '新屋區', '觀音區','桃園區', '龜山區', '八德區', '大溪區', '復興區', '大園區','蘆竹區'],
    '苗栗縣': ['竹南鎮', '頭份市', '三灣鄉', '南庄鄉', '獅潭鄉', '後龍鎮','通霄鎮', '苑裡鎮', '苗栗市', '造橋鄉', '頭屋鄉', '公館鄉','大湖鄉', '泰安鄉', '銅鑼鄉', '三義鄉', '西湖鄉', '卓蘭鎮'],
    '台中市': ['中區', '東區', '南區', '西區', '北區', '北屯區', '西屯區', '南屯區','太平區', '大里區', '霧峰區', '烏日區', '豐原區', '后里區','石岡區', '東勢區', '和平區', '新社區', '潭子區', '大雅區','神岡區', '大肚區', '沙鹿區', '龍井區', '梧棲區', '清水區','大甲區', '外埔區', '大安區'],
    '彰化縣': ['彰化市', '芬園鄉', '花壇鄉', '秀水鄉', '鹿港鎮', '福興鄉','線西鄉', '和美鎮', '伸港鄉', '員林市', '社頭鄉', '永靖鄉','埔心鄉', '溪湖鎮', '大村鄉', '埔鹽鄉', '田中鎮', '北斗鎮','田尾鄉', '埤頭鄉', '溪州鄉', '竹塘鄉', '二林鎮', '大城鄉','芳苑鄉', '二水鄉'],
    '南投縣': ['南投市', '中寮鄉', '草屯鎮', '國姓鄉', '埔里鎮', '仁愛鄉','名間鄉', '集集鎮', '水里鄉', '魚池鄉', '信義鄉', '竹山鎮','鹿谷鄉'],
    '嘉義市': ['東區', '西區'],
    '嘉義縣': ['番路鄉', '梅山鄉', '竹崎鄉', '阿里山', '中埔鄉', '大埔鄉','水上鄉', '鹿草鄉', '太保市', '朴子市', '東石鄉', '六腳鄉','新港鄉', '民雄鄉', '大林鎮', '溪口鄉', '義竹鄉', '布袋鎮'],
    '雲林縣': ['斗南鎮', '大埤鄉', '虎尾鎮', '土庫鎮', '褒忠鄉', '東勢鄉','臺西鄉', '崙背鄉', '麥寮鄉', '斗六市', '林內鄉', '古坑鄉','莿桐鄉', '西螺鎮', '二崙鄉', '北港鎮', '水林鄉', '口湖鄉','四湖鄉', '元長鄉'],
    '台南市': ['中西區', '東區', '南區', '北區', '安平區', '安南區','永康區', '歸仁區', '新化區', '左鎮區', '玉井區', '楠西區','南化區', '仁德區', '關廟區', '龍崎區', '官田區', '麻豆區','佳里區', '西港區', '七股區', '將軍區', '學甲區', '北門區','新營區', '後壁區', '白河區', '東山區', '六甲區', '下營區','柳營區', '鹽水區', '善化區', '大內區', '山上區', '新市區','安定區'],
    '高雄市': ['新興區', '前金區', '苓雅區', '鹽埕區', '鼓山區', '旗津區','前鎮區', '三民區', '楠梓區', '小港區', '左營區','仁武區', '大社區', '東沙群島', '南沙群島', '岡山區', '路竹區','阿蓮區', '田寮區','燕巢區', '橋頭區', '梓官區', '彌陀區', '永安區', '湖內區','鳳山區', '大寮區', '林園區', '鳥松區', '大樹區', '旗山區','美濃區', '六龜區', '內門區', '杉林區', '甲仙區', '桃源區','那瑪夏區', '茂林區', '茄萣區'],
    '屏東縣': ['屏東市', '三地門鄉', '霧臺鄉', '瑪家鄉', '九如鄉', '里港鄉','高樹鄉', '鹽埔鄉', '長治鄉', '麟洛鄉', '竹田鄉', '內埔鄉','萬丹鄉', '潮州鎮', '泰武鄉', '來義鄉', '萬巒鄉', '崁頂鄉','新埤鄉', '南州鄉', '林邊鄉', '東港鎮', '琉球鄉', '佳冬鄉','新園鄉', '枋寮鄉', '枋山鄉', '春日鄉', '獅子鄉', '車城鄉','牡丹鄉', '恆春鎮', '滿州鄉'],
    '台東縣': ['臺東市', '綠島鄉', '蘭嶼鄉', '延平鄉', '卑南鄉', '鹿野鄉','關山鎮', '海端鄉', '池上鄉', '東河鄉', '成功鎮', '長濱鄉','太麻里鄉', '金峰鄉', '大武鄉', '達仁鄉'],
    '花蓮縣': ['花蓮市', '新城鄉', '秀林鄉', '吉安鄉', '壽豐鄉', '鳳林鎮','光復鄉', '豐濱鄉', '瑞穗鄉', '萬榮鄉', '玉里鎮', '卓溪鄉','富里鄉'],
    '金門縣': ['金沙鎮', '金湖鎮', '金寧鄉', '金城鎮', '烈嶼鄉', '烏坵鄉'],
    '連江縣': ['南竿鄉', '北竿鄉', '莒光鄉', '東引鄉'],
    '澎湖縣': ['馬公市', '西嶼鄉', '望安鄉', '七美鄉', '白沙鄉', '湖西鄉']
};

const selectedHomeRegion = ref(globalRegion.value === 'All' ? '台北市' : globalRegion.value)

// Sync with global state
watch(globalRegion, (newVal) => {
  if (newVal !== 'All') {
    selectedHomeRegion.value = newVal
  }
})

watch(selectedHomeRegion, (newVal) => {
  if (globalRegion.value !== newVal) {
    setGlobalRegion(newVal)
  }
})

const regionInfo = computed(() => regionStats.value.find(s => s.region === selectedHomeRegion.value) || {
  total_politicians: 0,
  mayor_count: 0,
  councilor_count: 0,
  township_mayor_count: 0,
  village_chief_count: 0
})

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
      
      <GlobalRegionSelector />
    </Hero>

    <!-- 2026 Election Special Zone (Prominent) -->
    <section class="py-12 bg-white">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
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
                <p class="text-3xl font-black">{{ totalPoliticians.toLocaleString() }}+</p>
              </div>
              <div class="bg-white/10 p-6 rounded-3xl backdrop-blur-sm border border-white/10 text-center">
                <p class="text-blue-300 text-[10px] font-bold uppercase mb-2">更新頻率</p>
                <p class="text-3xl font-black">Daily</p>
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

    <!-- Regional Analysis Section -->
    <section class="py-20 bg-slate-50 border-y border-slate-100">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex flex-col md:flex-row justify-between items-end mb-12 gap-6">
          <div class="text-left">
            <h2 class="text-3xl font-black text-navy-900 flex items-center gap-3">
              <MapPin class="text-blue-600" :size="32" /> 全台各縣市數據分佈
            </h2>
            <p class="text-slate-500 mt-2 font-medium">即時統計各行政區的人員分佈與政見規模。</p>
          </div>
          <div class="hidden md:flex bg-white px-4 py-2 rounded-xl shadow-sm border border-slate-200 items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
            <span class="text-xs font-bold text-slate-500 uppercase tracking-widest">目前觀測：{{ selectedHomeRegion }}</span>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <!-- County Summary -->
          <div class="lg:col-span-1 space-y-6">
            <div class="bg-white p-8 rounded-[32px] border border-slate-200 shadow-xl relative overflow-hidden group">
              <div class="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-500">
                <MapPin :size="120" class="text-blue-600" />
              </div>
              <h3 class="text-2xl font-black text-navy-900 mb-1">{{ selectedHomeRegion }}</h3>
              <p class="text-slate-400 text-sm font-bold uppercase tracking-widest mb-8">行政區域總覽</p>
              
              <div class="space-y-4">
                <div class="flex items-center justify-between p-4 bg-slate-50 rounded-2xl">
                  <span class="text-sm font-bold text-slate-500">總政治人物</span>
                  <span class="text-2xl font-black text-navy-900">{{ regionInfo.total_politicians }}</span>
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div class="p-4 border border-slate-100 rounded-2xl">
                    <p class="text-[10px] font-bold text-slate-400 uppercase mb-1">縣市長</p>
                    <p class="text-xl font-black text-blue-600">{{ regionInfo.mayor_count }}</p>
                  </div>
                  <div class="p-4 border border-slate-100 rounded-2xl">
                    <p class="text-[10px] font-bold text-slate-400 uppercase mb-1">縣市議員</p>
                    <p class="text-xl font-black text-indigo-600">{{ regionInfo.councilor_count }}</p>
                  </div>
                  <div class="p-4 border border-slate-100 rounded-2xl">
                    <p class="text-[10px] font-bold text-slate-400 uppercase mb-1">鄉鎮市長</p>
                    <p class="text-xl font-black text-emerald-600">{{ regionInfo.township_mayor_count }}</p>
                  </div>
                  <div class="p-4 border border-slate-100 rounded-2xl">
                    <p class="text-[10px] font-bold text-slate-400 uppercase mb-1">村里長</p>
                    <p class="text-xl font-black text-amber-600">{{ regionInfo.village_chief_count }}</p>
                  </div>
                </div>
              </div>

              <button @click="router.push({ path: '/tracking', query: { region: selectedHomeRegion } })" class="w-full mt-8 py-4 bg-navy-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-black transition-all">
                進入 {{ selectedHomeRegion }} 追蹤頁 <ArrowRight :size="18" />
              </button>
            </div>
          </div>

          <!-- District Grid -->
          <div class="lg:col-span-2 bg-white p-8 rounded-[32px] border border-slate-200 shadow-sm">
             <div class="flex items-center justify-between mb-8">
                <h4 class="font-bold text-navy-900 flex items-center gap-2">
                   <Users :size="20" class="text-blue-500" /> 下轄行政區 ({{ twArea[selectedHomeRegion].length }})
                </h4>
             </div>
             <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                <button 
                   v-for="dist in twArea[selectedHomeRegion]" 
                   :key="dist"
                   @click="router.push({ path: '/tracking', query: { region: selectedHomeRegion, subRegion: dist } })"
                   class="p-4 bg-slate-50 hover:bg-blue-50 border border-slate-100 hover:border-blue-200 rounded-2xl text-left transition-all group"
                >
                   <p class="text-sm font-bold text-navy-900 group-hover:text-blue-700">{{ dist }}</p>
                   <p class="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                      查看資料 <ChevronRight :size="10" />
                   </p>
                </button>
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
</style>
