<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import { useGlobalState } from '../composables/useGlobalState'
import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import { ArrowRight, MapPin, Users, Database } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

const router = useRouter()
const { regionStats } = useSupabase()
const { globalRegion, setGlobalRegion } = useGlobalState()

// 所有縣市列表
const allCounties = [
  '台北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣',
  '苗栗縣', '台中市', '彰化縣', '南投縣', '雲林縣',
  '嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣',
  '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'
]

const twArea: Record<string, string[]> = {
    '全國': allCounties,  // 全國的子區域是各縣市
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
}

// 當全域選擇 "All" 時，顯示 "全國"
const selectedRegion = ref(globalRegion.value === 'All' ? '全國' : globalRegion.value)

// 是否為全國模式
const isNational = computed(() => selectedRegion.value === '全國')

// Sync with global state
watch(globalRegion, (newVal) => {
  selectedRegion.value = newVal === 'All' ? '全國' : newVal
})

watch(selectedRegion, (newVal) => {
  const globalVal = newVal === '全國' ? 'All' : newVal
  if (globalRegion.value !== globalVal) {
    setGlobalRegion(globalVal)
  }
})

// City-level stats (sub_region is null)
const regionInfo = computed(() => {
  if (isNational.value) {
    // 全國：加總所有縣市層級的統計
    const cityLevelStats = regionStats.value.filter(s => s.sub_region === null && s.region !== '全國')
    return {
      total_politicians: cityLevelStats.reduce((sum, s) => sum + (s.total_politicians || 0), 0),
      mayor_count: cityLevelStats.reduce((sum, s) => sum + (s.mayor_count || 0), 0),
      councilor_count: cityLevelStats.reduce((sum, s) => sum + (s.councilor_count || 0), 0),
      township_mayor_count: cityLevelStats.reduce((sum, s) => sum + (s.township_mayor_count || 0), 0),
      representative_count: cityLevelStats.reduce((sum, s) => sum + (s.representative_count || 0), 0),
      village_chief_count: cityLevelStats.reduce((sum, s) => sum + (s.village_chief_count || 0), 0),
      policy_count: cityLevelStats.reduce((sum, s) => sum + (s.policy_count || 0), 0),
    }
  }
  return regionStats.value.find(s =>
    s.region === selectedRegion.value && s.sub_region === null
  ) || {
    total_politicians: 0,
    mayor_count: 0,
    councilor_count: 0,
    township_mayor_count: 0,
    representative_count: 0,
    village_chief_count: 0,
    policy_count: 0
  }
})

// Get stats for each sub-region (district) from database
const getSubRegionStats = (subRegion: string) => {
  if (isNational.value) {
    // 全國模式：subRegion 是縣市名稱，取該縣市的縣市層級統計
    const stats = regionStats.value.find(s =>
      s.region === subRegion && s.sub_region === null
    )
    return {
      politicians: stats?.total_politicians || 0,
      policies: stats?.policy_count || 0
    }
  }
  // 一般模式：subRegion 是鄉鎮區名稱
  const stats = regionStats.value.find(s =>
    s.region === selectedRegion.value &&
    s.sub_region === subRegion &&
    s.village === null
  )
  return {
    politicians: stats?.total_politicians || 0,
    policies: stats?.policy_count || 0
  }
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20 text-left">
    <Hero>
      <template #title>全台各縣市數據分佈</template>
      <template #description>即時統計各行政區的人員分佈與政見規模，<br class="hidden lg:block" />深入了解各縣市的政治生態與治理脈絡。</template>
      <template #icon><Database :size="400" class="text-blue-500" /></template>

      <div class="space-y-6">
        <GlobalRegionSelector />
      </div>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 pt-20">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <!-- County Summary -->
        <div class="lg:col-span-1 space-y-6">
          <div class="bg-white p-8 rounded-[32px] border border-slate-200 shadow-xl relative overflow-hidden group">
            <div class="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-500">
              <MapPin :size="120" class="text-blue-600" />
            </div>
            <h3 class="text-2xl font-black text-navy-900 mb-1">{{ selectedRegion }}</h3>
            <p class="text-slate-400 text-sm font-bold uppercase tracking-widest mb-8">行政區域總覽</p>

            <div class="space-y-4">
              <div class="grid grid-cols-2 gap-3">
                <div class="flex items-center justify-between p-4 bg-slate-50 rounded-2xl">
                  <span class="text-sm font-bold text-slate-500">政治人物</span>
                  <span class="text-2xl font-black text-navy-900">{{ regionInfo.total_politicians }}</span>
                </div>
                <div class="flex items-center justify-between p-4 bg-blue-50 rounded-2xl">
                  <span class="text-sm font-bold text-slate-500">政見數</span>
                  <span class="text-2xl font-black text-blue-600">{{ regionInfo.policy_count || 0 }}</span>
                </div>
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

            <button v-if="!isNational" @click="router.push({ path: '/tracking', query: { region: selectedRegion } })" class="w-full mt-8 py-4 bg-navy-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-black transition-all">
              進入 {{ selectedRegion }} 追蹤頁 <ArrowRight :size="18" />
            </button>
            <button v-else @click="router.push({ path: '/tracking' })" class="w-full mt-8 py-4 bg-navy-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-black transition-all">
              進入全台追蹤頁 <ArrowRight :size="18" />
            </button>
          </div>
        </div>

        <!-- District Grid -->
        <div class="lg:col-span-2 bg-white p-8 rounded-[32px] border border-slate-200 shadow-sm">
           <div class="flex items-center justify-between mb-8">
              <h4 class="font-bold text-navy-900 flex items-center gap-2">
                 <Users :size="20" class="text-blue-500" />
                 {{ isNational ? '各縣市' : '下轄行政區' }} ({{ twArea[selectedRegion]?.length || 0 }})
              </h4>
           </div>
           <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              <button
                 v-for="dist in twArea[selectedRegion]"
                 :key="dist"
                 @click="isNational ? (selectedRegion = dist) : router.push({ path: '/tracking', query: { region: selectedRegion, subRegion: dist } })"
                 class="p-4 bg-slate-50 hover:bg-blue-50 border border-slate-100 hover:border-blue-200 rounded-2xl text-left transition-all group"
              >
                 <p class="text-sm font-bold text-navy-900 group-hover:text-blue-700">{{ dist }}</p>
                 <p class="text-[10px] text-slate-400 mt-1">
                    {{ getSubRegionStats(dist).politicians }} 人 · {{ getSubRegionStats(dist).policies }} 政見
                 </p>
              </button>
           </div>
        </div>
      </div>
    </div>
  </div>
</template>
