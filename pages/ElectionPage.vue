<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import { PolicyStatus, ElectionType } from '../types'
import PolicyCard from '../components/PolicyCard.vue'
import PoliticianGrid from './election/PoliticianGrid.vue'
import PoliticianDropdown from './election/PoliticianDropdown.vue'
import VerticalStack from './election/VerticalStack.vue'
import Hero from '../components/Hero.vue'
import { useRouter, useRoute } from 'vue-router'
import {
  Vote, Megaphone, Flag, AlertCircle, Users, MapPin,
  Search, Layers, LayoutGrid, Clock, Scale, Swords,
  Building2, Mountain, Landmark, MessageCircle, Hash, Loader2
} from 'lucide-vue-next'

import { useGlobalState } from '../composables/useGlobalState'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'

const router = useRouter()
const route = useRoute()
const { politicians, policies, locations, categories, getElectionById, loading } = useSupabase()
const { globalRegion } = useGlobalState()

const electionId = computed(() => Number(route.params.electionId))
const election = computed(() => getElectionById(electionId.value))

const selectedRegion = ref(globalRegion.value)

// Sync with global state
watch(globalRegion, (newVal) => {
  selectedRegion.value = newVal
})

const viewMode = ref<'politicians' | 'pledges' | 'issues' | 'comparison'>('politicians')
const selectedIssueCategory = ref('All')
const selectedIssueTag = ref('')
const comparisonLevel = ref<ElectionType>(ElectionType.MAYOR)

const SIX_CAPITALS = ['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市']
const OTHER_LOCATIONS = computed(() => locations.value.filter(loc => !SIX_CAPITALS.includes(loc)))

const timeLeft = computed(() => {
  if (!election.value) return { days: 0 }
  const difference = +new Date(election.value.electionDate) - +new Date()
  return { days: difference > 0 ? Math.floor(difference / (1000 * 60 * 60 * 24)) : 0 }
})

const electionPoliticians = computed(() =>
  politicians.value.filter(c => c.electionIds?.includes(electionId.value))
)
const filteredPoliticians = computed(() =>
  selectedRegion.value === 'All' ? electionPoliticians.value : electionPoliticians.value.filter(c => c.region === selectedRegion.value)
)

const mayorPoliticians = computed(() => filteredPoliticians.value.filter(c => c.electionType === ElectionType.MAYOR || !c.electionType))
const councilorPoliticians = computed(() => filteredPoliticians.value.filter(c => c.electionType === ElectionType.COUNCILOR))
const townshipMayorPoliticians = computed(() => filteredPoliticians.value.filter(c => c.electionType === ElectionType.TOWNSHIP_MAYOR))
const indigenousChiefPoliticians = computed(() => filteredPoliticians.value.filter(c => c.electionType === ElectionType.INDIGENOUS_DISTRICT_CHIEF))
const repPoliticians = computed(() => filteredPoliticians.value.filter(c => c.electionType === ElectionType.REPRESENTATIVE))
const indigenousRepPoliticians = computed(() => filteredPoliticians.value.filter(c => c.electionType === ElectionType.INDIGENOUS_DISTRICT_REP))
const chiefPoliticians = computed(() => filteredPoliticians.value.filter(c => c.electionType === ElectionType.CHIEF))

const electionPoliticianIds = computed(() => new Set(electionPoliticians.value.map(c => c.id)))

const allCampaignPolicies = computed(() =>
  policies.value.filter(p => p.status === PolicyStatus.CAMPAIGN && electionPoliticianIds.value.has(p.politicianId) && (selectedRegion.value === 'All' || politicians.value.find(c => c.id === p.politicianId)?.region === selectedRegion.value))
)

// Issues mode
const regionPolicies = computed(() =>
  policies.value.filter(p => p.status === PolicyStatus.CAMPAIGN && electionPoliticianIds.value.has(p.politicianId) && (selectedRegion.value === 'All' || politicians.value.find(c => c.id === p.politicianId)?.region === selectedRegion.value))
)

const categoryFilteredPolicies = computed(() =>
  selectedIssueCategory.value === 'All' ? regionPolicies.value : regionPolicies.value.filter(p => p.category === selectedIssueCategory.value)
)

const tagCounts = computed(() => {
  const counts: { [key: string]: number } = {}
  categoryFilteredPolicies.value.forEach(p => {
    p.tags.forEach(tag => { counts[tag] = (counts[tag] || 0) + 1 })
  })
  return counts
})

const availableTags = computed(() =>
  Object.keys(tagCounts.value).filter(tag => tagCounts.value[tag] > 0).sort((a, b) => tagCounts.value[b] - tagCounts.value[a])
)

watch([() => selectedIssueCategory.value, () => selectedRegion.value, availableTags], () => {
  if (availableTags.value.length > 0 && (!selectedIssueTag.value || !availableTags.value.includes(selectedIssueTag.value))) {
    selectedIssueTag.value = availableTags.value[0]
  } else if (availableTags.value.length === 0) {
    selectedIssueTag.value = ''
  }
})

// Comparison mode
const comparisonPool = computed(() =>
  politicians.value.filter(c =>
    c.electionIds?.includes(electionId.value) &&
    (c.electionType === comparisonLevel.value || (!c.electionType && comparisonLevel.value === ElectionType.MAYOR)) &&
    (selectedRegion.value === 'All' || c.region === selectedRegion.value)
  )
)

const politicianAId = ref<string | number>('')
const politicianBId = ref<string | number>('')

watch([() => selectedRegion.value, () => comparisonLevel.value], () => {
  if (comparisonPool.value.length > 0) {
    politicianAId.value = comparisonPool.value[0].id
    politicianBId.value = comparisonPool.value.length > 1 ? comparisonPool.value[1].id : comparisonPool.value[0].id
  } else {
    politicianAId.value = ''
    politicianBId.value = ''
  }
}, { immediate: true })

const politicianA = computed(() => politicians.value.find(c => String(c.id) === String(politicianAId.value)))
const politicianB = computed(() => politicians.value.find(c => String(c.id) === String(politicianBId.value)))

const getPledge = (cId: string | number, category: string) =>
  policies.value.find(p => String(p.politicianId) === String(cId) && p.status === PolicyStatus.CAMPAIGN && (p.category === category || p.tags.includes(category)))


const electionLevels = [
  { type: ElectionType.MAYOR, label: '縣市長' },
  { type: ElectionType.COUNCILOR, label: '縣市議員' },
  { type: ElectionType.TOWNSHIP_MAYOR, label: '鄉鎮市長' },
  { type: ElectionType.INDIGENOUS_DISTRICT_CHIEF, label: '原民區長' },
  { type: ElectionType.REPRESENTATIVE, label: '鄉鎮市民代表' },
  { type: ElectionType.INDIGENOUS_DISTRICT_REP, label: '原民區代表' },
  { type: ElectionType.CHIEF, label: '村里長' }
]
</script>

<template>
  <div v-if="election" class="bg-slate-50 min-h-screen">

    <Hero full-width>
      <template #title>
        <div class="relative w-full">
          <div>
            預見未來，<br/><span class="text-amber-400">從您居住的城市開始</span>
          </div>
          <div class="hidden md:block absolute right-0 top-1/2 -translate-y-1/2">
            <div class="bg-white/5 backdrop-blur-md border border-white/20 rounded-[32px] p-8 text-center transform rotate-2 hover:rotate-0 transition-all duration-500 shadow-2xl shadow-blue-500/10">
              <div class="text-sm text-slate-400 mb-2 flex items-center justify-center gap-2 font-medium">
                <Clock :size="18" class="text-amber-400" /> 距離投票日
              </div>
              <div class="text-7xl font-black text-white mb-1 font-mono tracking-tighter leading-none animate-pulse">
                {{ timeLeft.days }}
              </div>
              <div class="text-sm font-bold text-amber-400 uppercase tracking-[0.3em] pl-[0.3em]">
                Days Left
              </div>
            </div>
          </div>
        </div>
      </template>
      <template #description>不僅是縣市長，我們深入記錄議員、鄉鎮代表等基層候選人的競選承諾。</template>

      <!-- View Mode Tabs in default slot (overlapping white bar) -->
      <div class="space-y-6">
        <GlobalRegionSelector />

        <div class="flex items-center justify-between gap-4 border-t border-slate-100 pt-6">
          <h2 class="text-lg font-bold text-navy-900 whitespace-nowrap shrink-0">{{ election.name }}</h2>
          <div class="flex bg-slate-100 p-1 rounded-lg shrink-0 overflow-x-auto">
            <button @click="viewMode = 'politicians'" :class="`px-4 py-2 rounded-md text-sm font-bold flex items-center gap-2 transition-all whitespace-nowrap ${viewMode === 'politicians' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`"><LayoutGrid :size="16" /> 候選人</button>
            <button @click="viewMode = 'pledges'" :class="`px-4 py-2 rounded-md text-sm font-bold flex items-center gap-2 transition-all whitespace-nowrap ${viewMode === 'pledges' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`"><Megaphone :size="16" /> 競選承諾</button>
            <button @click="viewMode = 'issues'" :class="`px-4 py-2 rounded-md text-sm font-bold flex items-center gap-2 transition-all whitespace-nowrap ${viewMode === 'issues' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`"><Layers :size="16" /> 議題串聯</button>
            <button @click="viewMode = 'comparison'" :class="`px-4 py-2 rounded-md text-sm font-bold flex items-center gap-2 transition-all whitespace-nowrap ${viewMode === 'comparison' ? 'bg-amber-100 text-amber-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`"><Scale :size="16" /> 政見 PK</button>
          </div>
        </div>
      </div>
    </Hero>


    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">

      <!-- VIEW: Politicians -->

      <div v-if="viewMode === 'politicians'" class="animate-fade-in">
        <PoliticianGrid :politicians="mayorPoliticians" title="縣市長參選人"><template #icon><Flag class="text-red-500" /></template></PoliticianGrid>
        <PoliticianGrid :politicians="councilorPoliticians" title="縣市議員參選人"><template #icon><Users class="text-blue-500" /></template></PoliticianGrid>
        <PoliticianGrid v-if="townshipMayorPoliticians.length > 0" :politicians="townshipMayorPoliticians" title="鄉鎮市長參選人"><template #icon><Building2 class="text-indigo-500" /></template></PoliticianGrid>
        <PoliticianGrid v-if="indigenousChiefPoliticians.length > 0" :politicians="indigenousChiefPoliticians" title="原住民區長參選人"><template #icon><Mountain class="text-emerald-600" /></template></PoliticianGrid>
        <PoliticianGrid v-if="repPoliticians.length > 0" :politicians="repPoliticians" title="鄉鎮市民代表參選人"><template #icon><Landmark class="text-green-500" /></template></PoliticianGrid>
        <PoliticianGrid v-if="indigenousRepPoliticians.length > 0" :politicians="indigenousRepPoliticians" title="原住民區代表參選人"><template #icon><MessageCircle class="text-teal-500" /></template></PoliticianGrid>
        <PoliticianGrid v-if="chiefPoliticians.length > 0" :politicians="chiefPoliticians" title="村里長參選人"><template #icon><MapPin class="text-amber-500" /></template></PoliticianGrid>
      </div>

      <!-- VIEW: Pledges -->
      <div v-if="viewMode === 'pledges'" class="animate-fade-in grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <PolicyCard
          v-for="policy in allCampaignPolicies"
          :key="policy.id"
          :policy="policy"
          :politician="politicians.find(c => c.id === policy.politicianId)!"
          :on-click="() => router.push(`/policy/${policy.id}`)"
        />
      </div>

      <!-- VIEW: Issues -->
      <div v-if="viewMode === 'issues'" class="space-y-8 animate-fade-in">
        <div class="flex items-center gap-2 bg-slate-100 p-1 rounded-xl overflow-x-auto no-scrollbar">
          <button @click="selectedIssueCategory = 'All'" :class="`px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap transition-all flex-shrink-0 ${selectedIssueCategory === 'All' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`">全部議題</button>
          <div class="w-px h-6 bg-slate-300 mx-1 flex-shrink-0"></div>
          <button v-for="category in categories" :key="category" @click="selectedIssueCategory = category" :class="`px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap transition-all flex-shrink-0 ${selectedIssueCategory === category ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'}`">{{ category }}</button>

        </div>

        <div v-if="selectedRegion === 'All'" class="text-center py-20 bg-white border border-dashed border-slate-300 rounded-xl">
          <Layers :size="48" class="mx-auto mb-4 text-slate-300" />
          <h3 class="text-lg font-bold text-navy-900 mb-2">請選擇特定縣市</h3>
          <p class="text-slate-500 max-w-md mx-auto">「議題串聯」功能需要針對特定行政區進行垂直分析。</p>
        </div>
        <template v-else>
          <div v-if="availableTags.length > 0" class="space-y-6">
            <div class="flex items-center gap-2 mb-2 overflow-x-auto no-scrollbar pb-2">
              <button
                v-for="tag in availableTags"
                :key="tag"
                @click="selectedIssueTag = tag"
                :class="`px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all border flex items-center gap-1 ${selectedIssueTag === tag ? 'bg-blue-600 text-white border-blue-600 shadow-md' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`"
              >
                <Hash :size="12" /> {{ tag }}
              </button>
            </div>
            <VerticalStack v-if="selectedIssueTag" :tag="selectedIssueTag" :policies="categoryFilteredPolicies" />
          </div>
          <div v-else class="text-center py-20 text-slate-400 bg-white border border-dashed border-slate-200 rounded-xl">
            <AlertCircle :size="48" class="mx-auto mb-4 opacity-50" />
            <p>此類別下尚未偵測到議題串聯。</p>
          </div>
        </template>
      </div>

      <!-- VIEW: Comparison -->
      <div v-if="viewMode === 'comparison'" class="animate-fade-in space-y-8">
        <div class="flex justify-start overflow-x-auto pb-2">
          <div class="inline-flex bg-slate-100 p-1 rounded-lg shrink-0">
            <button
              v-for="level in electionLevels"
              :key="level.type"
              @click="comparisonLevel = level.type"
              :class="`px-4 py-2 rounded-md text-sm font-bold transition-all whitespace-nowrap ${comparisonLevel === level.type ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`"
            >{{ level.label }}</button>
          </div>
        </div>

        <div class="bg-amber-50 rounded-xl border border-amber-200 p-6 flex flex-col md:flex-row items-center justify-between gap-8">
          <PoliticianDropdown v-model="politicianAId" label="候選人 A" ring-color="blue-500" :selected-region="selectedRegion" :comparison-pool="comparisonPool" />
          <div class="shrink-0 flex items-center justify-center w-12 h-12 bg-amber-500 rounded-full text-white font-black italic shadow-lg ring-4 ring-white">VS</div>
          <PoliticianDropdown v-model="politicianBId" label="候選人 B" ring-color="red-500" :selected-region="selectedRegion" :comparison-pool="comparisonPool" />
        </div>

        <div v-if="!politicianA || !politicianB || politicianAId === politicianBId" class="text-center py-20 text-slate-400 border border-dashed border-slate-300 rounded-xl">
          <Swords :size="48" class="mx-auto mb-4 opacity-50" />
          <p>請選擇兩位不同的候選人。</p>
        </div>
        <div v-else class="grid grid-cols-1 gap-6 text-left">
          <template v-for="category in categories" :key="category">
            <div v-if="getPledge(politicianAId, category) || getPledge(politicianBId, category)" class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div class="bg-slate-50 px-6 py-3 border-b border-slate-100 flex items-center gap-2">
                <span class="w-2 h-6 bg-navy-800 rounded-sm"></span>
                <h3 class="font-bold text-navy-900">{{ category }}</h3>

              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
                <div class="p-6 hover:bg-blue-50/20 transition-colors">
                  <div v-if="getPledge(politicianAId, category)" @click="router.push(`/policy/${getPledge(politicianAId, category)!.id}`)" class="cursor-pointer group">
                    <h4 class="font-bold text-lg text-navy-900 mb-2 group-hover:text-blue-600 transition-colors">{{ getPledge(politicianAId, category)!.title }}</h4>
                    <p class="text-slate-600 text-sm mb-4 line-clamp-3">{{ getPledge(politicianAId, category)!.description }}</p>
                  </div>
                  <span v-else class="text-slate-400 text-sm italic">未提出相關承諾</span>
                </div>
                <div class="p-6 hover:bg-red-50/20 transition-colors">
                  <div v-if="getPledge(politicianBId, category)" @click="router.push(`/policy/${getPledge(politicianBId, category)!.id}`)" class="cursor-pointer group">
                    <h4 class="font-bold text-lg text-navy-900 mb-2 group-hover:text-red-600 transition-colors">{{ getPledge(politicianBId, category)!.title }}</h4>
                    <p class="text-slate-600 text-sm mb-4 line-clamp-3">{{ getPledge(politicianBId, category)!.description }}</p>
                  </div>
                  <span v-else class="text-slate-400 text-sm italic">未提出相關承諾</span>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>

  <!-- Loading state -->
  <div v-else-if="loading" class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Loader2 :size="48" class="mx-auto mb-4 text-blue-500 animate-spin" />
      <p class="text-slate-500">載入中...</p>
    </div>
  </div>

  <!-- Election not found -->
  <div v-else class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Vote :size="64" class="mx-auto mb-4 text-slate-300" />
      <h2 class="text-2xl font-bold text-navy-900 mb-2">找不到此選舉</h2>
      <p class="text-slate-500">請確認網址是否正確。</p>
    </div>
  </div>
</template>
