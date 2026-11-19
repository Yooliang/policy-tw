<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import { useGlobalState } from '../composables/useGlobalState'
import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import RegionCategoryPicker from '../components/RegionCategoryPicker.vue'
import LoadError from '../components/LoadError.vue'
import RegionalKpi from '../components/regional/RegionalKpi.vue'
import StageFunnel from '../components/regional/StageFunnel.vue'
import CategoryHeatmap from '../components/regional/CategoryHeatmap.vue'
import PledgeQuality from '../components/regional/PledgeQuality.vue'
import LineageRelay from '../components/regional/LineageRelay.vue'
import DeadlineBlock from '../components/regional/DeadlineBlock.vue'
import { ArrowRight, Database, X } from 'lucide-vue-next'
import { useRouter, useRoute } from 'vue-router'
import { usePageHead } from '../composables/usePageHead'
import { useRegionQuerySync, queryField } from '../composables/useRegionQuerySync'
import { useDeskFilterPanel } from '../composables/useDeskFilterPanel'
import { regionPeopleTotal } from '../lib/policy-region-counts'
import { COUNTIES, ALL_REGIONS, stageTotals, policyTotal } from '../lib/regional-overview'
import RegionalStatsPanel from '../components/RegionalStatsPanel.vue'

const router = useRouter()
const route = useRoute()
// 右欄（AdRail）上方的統計卡落點：≥1200px 且右欄已渲染才有（同選舉頁）；否則放內容最下方
const railTarget = ref<HTMLElement | null>(null)
function syncRailTarget() {
  railTarget.value = typeof window !== 'undefined' && window.matchMedia('(min-width: 1200px)').matches ? document.getElementById('desk-rail-top') : null
}
let railTimer = 0
function syncRailSoon() { void nextTick(syncRailTarget); window.clearTimeout(railTimer); railTimer = window.setTimeout(syncRailTarget, 400) }
onMounted(() => { syncRailSoon(); window.addEventListener('resize', syncRailSoon) })
onBeforeUnmount(() => { window.removeEventListener('resize', syncRailSoon); window.clearTimeout(railTimer) })
watch(() => route.path, syncRailSoon)

const { regionStats, ensureRegionStats, regionalData, ensureRegionalData } = useSupabase()
// 這一頁才需要的資料，按需載入（見 useSupabase 的 ensure*）：預渲染的快照已帶聚合，沒帶才撈；切縣市一律用同一份、不再請求
ensureRegionStats()
const regionalFailed = ref(false)
async function loadRegional() {
  regionalFailed.value = false
  await ensureRegionalData()
  regionalFailed.value = !regionalData.value
}
void loadRegional()
const { globalRegion, setGlobalRegion, globalCategory } = useGlobalState()
const { openPanel } = useDeskFilterPanel()

// 縣市（全站共用）↔ 網址 ?region=
// 分類是全站共用狀態：本頁內容只依地區，但左欄與方塊格的分類值跟其他兩頁同一份，網址也一併帶著
useRegionQuerySync({ routeName: 'regional-data', extra: { category: queryField(globalCategory, 'All') } })

const region = computed(() => globalRegion.value)
const scopeLabel = computed(() => (region.value === ALL_REGIONS ? '全台' : region.value))
const scopeTotal = computed(() => {
  if (!regionalData.value) return null
  const t = stageTotals(regionalData.value.stage, region.value)
  return t.pledge_n + policyTotal(t)
})
const fmt = (n: number) => n.toLocaleString('en-US')
const pick = (r: string) => setGlobalRegion(r)
// 載入前的區塊標題（與載入後各區塊的標題一致）
const skeleton = [
  { label: '① 階段漏斗', titles: ['各縣市進度漏斗'] },
  { label: '② 議題結構', titles: ['縣市 × 分類', '承諾', '政見', '脈絡'] },
  { label: '③ 承諾品質', titles: ['各縣市', '各層級', '數值目標', '期限', '財源'] },
  { label: '④ 脈絡接力', titles: ['各縣市脈絡', '跨任期示意'] },
  { label: '⑤ 時間', titles: ['期限分佈', '近 30 天有進度更新'] },
]

/** 方塊格上的數字：該頁已載入的區域統計裡的政治人物數（分類格不印數字：統計不分類） */
const pickerCounter = {
  region: (r: string) => regionPeopleTotal(regionStats.value, r, COUNTIES),
  category: () => null,
  unit: '人物', suffix: '位',
}

function goTracking() {
  void router.push(region.value === ALL_REGIONS ? { path: '/tracking' } : { path: '/tracking', query: { region: region.value } })
}

usePageHead({
  title: '數據分佈',
  description: '各縣市的承諾、政見與脈絡走到哪：階段漏斗、縣市×分類熱力圖、承諾品質、脈絡接力與期限分佈。',
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20 text-left">
    <Hero>
      <template #title>數據分佈</template>
      <template #description>各縣市的承諾、政見與脈絡走到哪</template>
      <template #icon><Database :size="400" class="text-blue-500" /></template>

      <div class="space-y-6">
        <GlobalRegionSelector />
      </div>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 pt-8 md:pt-12">
      <!-- 桌面版（md 以上）：目前的縣市／分類 chip，點 chip 展開方塊格、✕ 清掉；面板由左欄「地區」「分類」開（手機維持 Hero 內的縣市選擇器） -->
      <div class="flex flex-wrap items-center gap-3 mb-6" data-testid="regional-scope">
        <span class="inline-flex items-center gap-1.5 rounded-full bg-navy-900 text-white pl-4 pr-2 py-2 text-sm font-bold">
          <button type="button" class="font-bold hidden md:inline" @click="openPanel('region')">{{ scopeLabel }}</button>
          <span class="md:hidden font-bold">{{ scopeLabel }}</span>
          <button v-if="region !== ALL_REGIONS" type="button" class="rounded-full p-1 hover:bg-white/20" aria-label="清除地區" @click="setGlobalRegion('All')"><X :size="14" /></button>
          <span v-else class="w-2" />
        </span>
        <span v-if="globalCategory !== 'All'" class="hidden md:inline-flex items-center gap-1.5 rounded-full bg-navy-900 text-white pl-4 pr-2 py-2 text-sm font-bold">
          <button type="button" class="font-bold" @click="openPanel('category')">{{ globalCategory }}</button>
          <button type="button" class="rounded-full p-1 hover:bg-white/20" aria-label="清除分類" @click="globalCategory = 'All'"><X :size="14" /></button>
        </span>
        <span v-if="scopeTotal !== null" class="text-sm font-bold text-slate-400 tabular-nums">{{ fmt(scopeTotal) }} 筆</span>
        <button type="button" class="ml-auto inline-flex items-center gap-1.5 text-sm font-bold text-blue-600 hover:text-blue-700" @click="goTracking">
          進入{{ scopeLabel }}追蹤頁 <ArrowRight :size="16" />
        </button>
      </div>
      <RegionCategoryPicker v-model:category="globalCategory" category-enabled :counter="pickerCounter" />

      <div v-if="regionalData" class="space-y-12" data-testid="regional-body">
        <RegionalKpi :data="regionalData" :region="region" @pick="pick" />
        <section>
          <p class="text-xs font-black tracking-widest text-blue-600 mb-2">① 階段漏斗</p>
          <StageFunnel :data="regionalData" :region="region" @pick="pick" />
        </section>
        <section>
          <p class="text-xs font-black tracking-widest text-blue-600 mb-2">② 議題結構</p>
          <CategoryHeatmap :data="regionalData" :region="region" :category="globalCategory" @pick="pick" />
        </section>
        <section>
          <p class="text-xs font-black tracking-widest text-blue-600 mb-2">③ 承諾品質</p>
          <PledgeQuality :data="regionalData" :region="region" @pick="pick" />
        </section>
        <section>
          <p class="text-xs font-black tracking-widest text-blue-600 mb-2">④ 脈絡接力</p>
          <LineageRelay :data="regionalData" :region="region" @pick="pick" />
        </section>
        <section>
          <p class="text-xs font-black tracking-widest text-blue-600 mb-2">⑤ 時間</p>
          <DeadlineBlock :data="regionalData" :region="region" />
        </section>
      </div>
      <LoadError v-else-if="regionalFailed" inline message="數據分佈暫時載入不了" @retry="loadRegional()" />
      <!-- 還沒拿到資料（預渲染沒帶快照、或載入中）：先把各區塊的標題擺好，載入完不跳版面 -->
      <div v-else class="space-y-12" data-testid="regional-skeleton">
        <section v-for="sec in skeleton" :key="sec.label">
          <p class="text-xs font-black tracking-widest text-blue-600 mb-2">{{ sec.label }}</p>
          <div class="bg-white p-5 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
            <h3 class="text-xl font-black text-navy-900">{{ sec.titles.join('・') }}</h3>
            <p class="mt-6 mb-4 text-center text-sm font-bold text-slate-300">資料載入中</p>
          </div>
        </section>
      </div>
    </div>
    <!-- 縣市資料卡（同選舉頁的 RegionalStatsPanel）：桌面（≥1200px）在右欄廣告位上方，手機在內容最下方 -->
    <div class="max-w-7xl mx-auto px-4"><ClientOnly><template v-if="region !== ALL_REGIONS"><Teleport v-if="railTarget" :to="railTarget"><RegionalStatsPanel :region="region" compact /></Teleport><RegionalStatsPanel v-else :region="region" compact class="mt-8 md:max-w-sm" /></template></ClientOnly></div>
  </div>
</template>
