<script lang="ts">
export default { name: 'ElectionPage' }
</script>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
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
  Building2, Mountain, Landmark, MessageCircle, Hash, Loader2,
  Crown, ScrollText
} from 'lucide-vue-next'

import { useGlobalState } from '../composables/useGlobalState'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'

const router = useRouter()
const route = useRoute()
const { politicians, policies, locations, categories, getElectionById, getPoliticianElectionData, loading, getElectoralDistrictByTownship, electoralDistrictAreas, loadPoliticiansByElection, loadedElections } = useSupabase()

// Helper: 取得候選人在該選舉的類型
function getElectionType(politician: any): string | undefined {
  const data = getPoliticianElectionData(politician, electionId.value)
  return data?.electionType
}

// Helper: 套用當前選舉的特定資料（解決跨選舉資料混亂問題）
function withCurrentElectionData(politician: any): any {
  const electionData = getPoliticianElectionData(politician, electionId.value)
  if (!electionData) return politician
  return {
    ...politician,
    candidateStatus: electionData.candidateStatus,
    sourceNote: electionData.sourceNote,
    position: electionData.position || politician.position,
    electionType: electionData.electionType || politician.electionType,
    region: electionData.region || politician.region,
    subRegion: electionData.subRegion || politician.subRegion,
    village: electionData.village || politician.village,
  }
}
const { globalRegion } = useGlobalState()

const electionId = computed(() => Number(route.params.electionId))
const election = computed(() => getElectionById(electionId.value))
const electionLoading = ref(false)

const selectedRegion = ref(globalRegion.value)
const selectedSubRegion = ref<string>('All')  // 鄉鎮市區
const selectedVillage = ref<string>('All')    // 村里

// Load politicians for this election + region
async function loadElectionData(id: number, region: string) {
  if (!id) return
  electionLoading.value = true
  try {
    await loadPoliticiansByElection(id, region)
  } finally {
    electionLoading.value = false
  }
}

onMounted(() => {
  if (electionId.value) {
    loadElectionData(electionId.value, selectedRegion.value)
  }
})

// 當選舉 ID 變化時重新載入
watch(electionId, (newId) => {
  if (newId) {
    loadElectionData(newId, selectedRegion.value)
  }
})

// 當地區變化時載入該地區的候選人
watch(selectedRegion, (newRegion) => {
  if (electionId.value) {
    loadElectionData(electionId.value, newRegion)
  }
})

// 選舉年份（用於選舉區對應表查詢，因為該表存的是年份而非 election ID）
const electionYear = computed(() => {
  if (!election.value?.electionDate) return 0
  return parseInt(election.value.electionDate.substring(0, 4))
})

// Hero 背景圖片（依選舉年份）
const heroImages: Record<number, string> = {
  2022: '/images/heroes/election-2022.png',
  2024: '/images/heroes/election-2024.png',
  2026: '/images/heroes/election-2026.png',
}
const heroBackgroundImage = computed(() => heroImages[electionYear.value] || '/images/heroes/election-default.png')

// Sync with global state
watch(globalRegion, (newVal) => {
  selectedRegion.value = newVal
  selectedSubRegion.value = 'All'
  selectedVillage.value = 'All'
})

// Reset filters when region changes locally
watch(selectedRegion, () => {
  selectedSubRegion.value = 'All'
  selectedVillage.value = 'All'
})

// Reset village filter when subRegion changes
watch(selectedSubRegion, () => {
  selectedVillage.value = 'All'
})

const viewMode = ref<'politicians' | 'pledges' | 'issues' | 'comparison'>('politicians')
const selectedIssueCategory = ref('All')
const selectedIssueTag = ref('')
const comparisonLevel = ref<ElectionType>(ElectionType.MAYOR)

const SIX_CAPITALS = ['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市']
const OTHER_LOCATIONS = computed(() => locations.value.filter(loc => !SIX_CAPITALS.includes(loc)))

// 判斷是否為直轄市（用於顯示「區」或「鄉鎮市區」）
const isSpecialMunicipality = computed(() => SIX_CAPITALS.includes(selectedRegion.value))
const subRegionLabel = computed(() => isSpecialMunicipality.value ? '區' : '鄉鎮市區')
const villageLabel = computed(() => isSpecialMunicipality.value ? '里' : '村里')

const timeLeft = computed(() => {
  if (!election.value) return { days: 0 }
  const difference = +new Date(election.value.electionDate) - +new Date()
  return { days: difference > 0 ? Math.floor(difference / (1000 * 60 * 60 * 24)) : 0 }
})

const electionPoliticians = computed(() =>
  politicians.value.filter(c => c.electionIds?.includes(electionId.value))
)

// 是否顯示右側篩選區（用於決定左側欄位數）
const showSidebar = computed(() => selectedRegion.value !== 'All')

// Grid 欄位數（有右側篩選時用 2 欄）
const gridColumns = computed(() => showSidebar.value ? 2 : 3)

// 排序：先照字數，再照筆畫
const sortByLengthThenStroke = (a: string, b: string) => {
  if (a.length !== b.length) return a.length - b.length
  return a.localeCompare(b, 'zh-Hant-TW', { numeric: true })
}

// 取得選定縣市的鄉鎮市區（合併所有來源）
const availableSubRegions = computed(() => {
  if (selectedRegion.value === 'All') return []
  const subRegions = new Set<string>()

  // 1. 從 politicians 取得（鄉鎮市長、代表、村里長等），排除選舉區格式
  // 套用當前選舉資料以取得正確的 subRegion
  electionPoliticians.value.map(withCurrentElectionData)
    .filter(c => {
      const type = getElectionType(c)
      return c.region === selectedRegion.value && c.subRegion &&
        type !== ElectionType.COUNCILOR &&
        type !== ElectionType.LEGISLATOR &&
        type !== ElectionType.INDIGENOUS_DISTRICT_CHIEF &&
        type !== ElectionType.INDIGENOUS_DISTRICT_REP &&
        !c.subRegion.includes('選區')
    })
    .forEach(c => subRegions.add(c.subRegion!))

  // 2. 從選舉區對應表取得（議員對應的鄉鎮區）
  // 優先使用當前選舉年份，若無則使用任何可用年份（鄉鎮區跨選舉相對穩定）
  const areasForYear = electoralDistrictAreas.value.filter(
    m => m.region === selectedRegion.value && m.election_id === electionYear.value
  )
  const areasToUse = areasForYear.length > 0
    ? areasForYear
    : electoralDistrictAreas.value.filter(m => m.region === selectedRegion.value)
  areasToUse.forEach(m => subRegions.add(m.township))

  // 過濾掉選舉區格式（如「第01選舉區」），並排序
  return Array.from(subRegions)
    .filter(s => !s.includes('選區') && !s.includes('選舉區'))
    .sort(sortByLengthThenStroke)
})

// 取得選定鄉鎮市區的村里（從村里長候選人）
const availableVillages = computed(() => {
  if (selectedSubRegion.value === 'All') return []
  const villages = new Set<string>()

  // 從村里長候選人取得村里名稱
  electionPoliticians.value.map(withCurrentElectionData)
    .filter(c => {
      const type = getElectionType(c)
      return type === ElectionType.CHIEF &&
        c.region === selectedRegion.value &&
        c.subRegion === selectedSubRegion.value &&
        c.village
    })
    .forEach(c => villages.add(c.village!))

  return Array.from(villages).sort(sortByLengthThenStroke)
})

const filteredPoliticians = computed(() => {
  // 關鍵：套用當前選舉的特定資料，確保 candidateStatus/subRegion 等欄位正確
  let result = electionPoliticians.value.map(withCurrentElectionData)
  if (selectedRegion.value !== 'All') {
    result = result.filter(c => c.region === selectedRegion.value)
  }
  // 鄉鎮市區篩選
  if (selectedSubRegion.value !== 'All') {
    result = result.filter(c => {
      const type = getElectionType(c)
      // 總統、立委、縣市長、議員不受鄉鎮篩選影響
      if (type === ElectionType.PRESIDENT ||
          type === ElectionType.LEGISLATOR ||
          type === ElectionType.MAYOR ||
          type === ElectionType.COUNCILOR) {
        return true
      }
      // 原民區長/代表：subRegion 格式是「XX區第YY選舉區」，用前綴匹配
      if (type === ElectionType.INDIGENOUS_DISTRICT_CHIEF ||
          type === ElectionType.INDIGENOUS_DISTRICT_REP) {
        return c.subRegion?.startsWith(selectedSubRegion.value)
      }
      // 其他（鄉鎮市長、代表、村里長）：完全匹配
      return c.subRegion === selectedSubRegion.value
    })
  }
  return result
})

const presidentPoliticians = computed(() =>
  filteredPoliticians.value
    .filter(c => getElectionType(c) === ElectionType.PRESIDENT)
    .sort((a, b) => {
      // 總統候選人排在副總統候選人前面
      const aIsVice = a.position?.includes('副') ? 1 : 0
      const bIsVice = b.position?.includes('副') ? 1 : 0
      return aIsVice - bIsVice
    })
)
const legislatorPoliticians = computed(() => {
  let result = electionPoliticians.value.map(withCurrentElectionData).filter(c => getElectionType(c) === ElectionType.LEGISLATOR)
  if (selectedRegion.value !== 'All') {
    result = result.filter(c => c.region === selectedRegion.value)
  }
  return result
})
const mayorPoliticians = computed(() => filteredPoliticians.value.filter(c => getElectionType(c) === ElectionType.MAYOR))
const councilorPoliticians = computed(() => {
  let result = electionPoliticians.value.map(withCurrentElectionData).filter(c => getElectionType(c) === ElectionType.COUNCILOR)
  if (selectedRegion.value !== 'All') {
    result = result.filter(c => c.region === selectedRegion.value)
  }
  // 當選擇鄉鎮市區時，透過對應表找出該鄉鎮所屬的議員選舉區
  if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All') {
    const electoralDistrict = getElectoralDistrictByTownship(
      selectedRegion.value,
      selectedSubRegion.value,
      electionYear.value
    )
    if (electoralDistrict) {
      result = result.filter(c => c.subRegion === electoralDistrict)
    }
  }
  return result
})
const townshipMayorPoliticians = computed(() => filteredPoliticians.value.filter(c => getElectionType(c) === ElectionType.TOWNSHIP_MAYOR))
const indigenousChiefPoliticians = computed(() => filteredPoliticians.value.filter(c => getElectionType(c) === ElectionType.INDIGENOUS_DISTRICT_CHIEF))
const repPoliticians = computed(() => filteredPoliticians.value.filter(c => getElectionType(c) === ElectionType.REPRESENTATIVE))
const indigenousRepPoliticians = computed(() => filteredPoliticians.value.filter(c => getElectionType(c) === ElectionType.INDIGENOUS_DISTRICT_REP))
const chiefPoliticians = computed(() => {
  let result = filteredPoliticians.value.filter(c => getElectionType(c) === ElectionType.CHIEF)
  // 村里篩選
  if (selectedVillage.value !== 'All') {
    result = result.filter(c => c.village === selectedVillage.value)
  }
  return result
})

// 檢查本次選舉是否有地方層級候選人（議員、鄉鎮市長、代表、村里長）
const hasLocalCandidates = computed(() => {
  const localTypes = [
    ElectionType.COUNCILOR,
    ElectionType.TOWNSHIP_MAYOR,
    ElectionType.INDIGENOUS_DISTRICT_CHIEF,
    ElectionType.REPRESENTATIVE,
    ElectionType.INDIGENOUS_DISTRICT_REP,
    ElectionType.CHIEF
  ]
  return electionPoliticians.value.some(c => localTypes.includes(getElectionType(c) as ElectionType))
})

const electionPoliticianIds = computed(() => new Set(electionPoliticians.value.map(c => c.id)))

const allCampaignPolicies = computed(() =>
  policies.value.filter(p => {
    if (p.status !== PolicyStatus.CAMPAIGN || !electionPoliticianIds.value.has(p.politicianId)) return false
    const politician = politicians.value.find(c => c.id === p.politicianId)
    if (!politician) return false
    if (selectedRegion.value !== 'All' && politician.region !== selectedRegion.value) return false
    // 鄉鎮市區篩選（議員透過對應表查詢選舉區）
    if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All') {
      if (getElectionType(politician) === ElectionType.COUNCILOR) {
        const electoralDistrict = getElectoralDistrictByTownship(selectedRegion.value, selectedSubRegion.value, electionYear.value)
        if (electoralDistrict && politician.subRegion !== electoralDistrict) return false
      } else {
        if (politician.subRegion !== selectedSubRegion.value) return false
      }
    }
    return true
  })
)

// Issues mode
const regionPolicies = computed(() =>
  policies.value.filter(p => {
    if (p.status !== PolicyStatus.CAMPAIGN || !electionPoliticianIds.value.has(p.politicianId)) return false
    const politician = politicians.value.find(c => c.id === p.politicianId)
    if (!politician) return false
    if (selectedRegion.value !== 'All' && politician.region !== selectedRegion.value) return false
    // 鄉鎮市區篩選（議員透過對應表查詢選舉區）
    if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All') {
      if (getElectionType(politician) === ElectionType.COUNCILOR) {
        const electoralDistrict = getElectoralDistrictByTownship(selectedRegion.value, selectedSubRegion.value, electionYear.value)
        if (electoralDistrict && politician.subRegion !== electoralDistrict) return false
      } else {
        if (politician.subRegion !== selectedSubRegion.value) return false
      }
    }
    return true
  })
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

watch([() => selectedIssueCategory.value, () => selectedRegion.value, () => selectedSubRegion.value, availableTags], () => {
  if (availableTags.value.length > 0 && (!selectedIssueTag.value || !availableTags.value.includes(selectedIssueTag.value))) {
    selectedIssueTag.value = availableTags.value[0]
  } else if (availableTags.value.length === 0) {
    selectedIssueTag.value = ''
  }
})

// Comparison mode
const comparisonPool = computed(() =>
  politicians.value.filter(c => {
    if (!c.electionIds?.includes(electionId.value)) return false
    const type = getElectionType(c)
    if (!(type === comparisonLevel.value || (!type && comparisonLevel.value === ElectionType.MAYOR))) return false
    if (selectedRegion.value !== 'All' && c.region !== selectedRegion.value) return false
    // 鄉鎮市區篩選（議員透過對應表查詢選舉區）
    if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All') {
      if (type === ElectionType.COUNCILOR) {
        const electoralDistrict = getElectoralDistrictByTownship(selectedRegion.value, selectedSubRegion.value, electionYear.value)
        if (electoralDistrict && c.subRegion !== electoralDistrict) return false
      } else {
        if (c.subRegion !== selectedSubRegion.value) return false
      }
    }
    return true
  })
)

const politicianAId = ref<string | number>('')
const politicianBId = ref<string | number>('')

watch([() => selectedRegion.value, () => selectedSubRegion.value, () => comparisonLevel.value], () => {
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
  { type: ElectionType.PRESIDENT, label: '總統' },
  { type: ElectionType.LEGISLATOR, label: '立法委員' },
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

    <Hero full-width :background-image="heroBackgroundImage">
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

      <!-- Hero Actions: View Mode Tabs -->
      <template #actions>
        <button @click="viewMode = 'politicians'" :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${viewMode === 'politicians' ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`"><LayoutGrid :size="16" /> 候選人</button>
        <button @click="viewMode = 'pledges'" :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${viewMode === 'pledges' ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`"><Megaphone :size="16" /> 競選承諾</button>
        <button @click="viewMode = 'issues'" :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${viewMode === 'issues' ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`"><Layers :size="16" /> 議題串聯</button>
        <button @click="viewMode = 'comparison'" :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${viewMode === 'comparison' ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`"><Scale :size="16" /> 政見 PK</button>
      </template>

      <GlobalRegionSelector />
    </Hero>


    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div class="flex flex-col md:flex-row gap-8">

      <!-- 左側：主要內容 -->
      <div :class="selectedRegion !== 'All' && availableSubRegions.length > 0 ? 'flex-1 md:w-2/3' : 'w-full'">

      <!-- VIEW: Politicians -->

      <div v-if="viewMode === 'politicians'" class="animate-fade-in">
        <!-- ===== 第1級：全台 ===== -->
        <template v-if="selectedRegion === 'All'">
          <PoliticianGrid v-if="presidentPoliticians.length > 0" :politicians="presidentPoliticians" :columns="gridColumns" title="總統副總統參選人"><template #icon><Crown class="text-amber-500" /></template></PoliticianGrid>
          <PoliticianGrid v-if="legislatorPoliticians.length > 0" :politicians="legislatorPoliticians" :columns="gridColumns" title="立法委員參選人"><template #icon><ScrollText class="text-purple-500" /></template></PoliticianGrid>
          <PoliticianGrid v-if="mayorPoliticians.length > 0" :politicians="mayorPoliticians" :columns="gridColumns" title="縣市長參選人"><template #icon><Flag class="text-red-500" /></template></PoliticianGrid>
        </template>

        <!-- ===== 第2級：縣市 ===== -->
        <template v-else-if="selectedSubRegion === 'All'">
          <PoliticianGrid v-if="mayorPoliticians.length > 0" :politicians="mayorPoliticians" :columns="gridColumns" title="縣市長參選人"><template #icon><Flag class="text-red-500" /></template></PoliticianGrid>
          <PoliticianGrid v-if="councilorPoliticians.length > 0" :politicians="councilorPoliticians" :columns="gridColumns" title="縣市議員參選人"><template #icon><Users class="text-blue-500" /></template></PoliticianGrid>
        </template>

        <!-- ===== 第3級：鄉鎮市區 ===== -->
        <template v-else-if="selectedVillage === 'All'">
          <!-- 直轄市的「區」是指派的，無選舉 -->
          <template v-if="isSpecialMunicipality">
            <div class="text-center py-12 bg-white border border-dashed border-slate-300 rounded-xl">
              <Building2 :size="48" class="mx-auto mb-4 text-slate-300" />
              <h3 class="text-lg font-bold text-navy-900 mb-2">直轄市的區長為官派</h3>
              <p class="text-slate-500">請選擇<span class="font-bold text-slate-700">里</span>查看里長參選人。</p>
            </div>
          </template>
          <!-- 一般縣市的鄉鎮市有選舉 -->
          <template v-else>
            <PoliticianGrid v-if="townshipMayorPoliticians.length > 0" :politicians="townshipMayorPoliticians" :columns="gridColumns" title="鄉鎮市長參選人"><template #icon><Building2 class="text-indigo-500" /></template></PoliticianGrid>
            <PoliticianGrid v-if="indigenousChiefPoliticians.length > 0" :politicians="indigenousChiefPoliticians" :columns="gridColumns" title="原住民區長參選人"><template #icon><Mountain class="text-emerald-600" /></template></PoliticianGrid>
            <PoliticianGrid v-if="repPoliticians.length > 0" :politicians="repPoliticians" :columns="gridColumns" title="鄉鎮市民代表參選人"><template #icon><Landmark class="text-green-500" /></template></PoliticianGrid>
            <PoliticianGrid v-if="indigenousRepPoliticians.length > 0" :politicians="indigenousRepPoliticians" :columns="gridColumns" title="原住民區代表參選人"><template #icon><MessageCircle class="text-teal-500" /></template></PoliticianGrid>
            <!-- 無候選人時的提示 -->
            <div v-if="!townshipMayorPoliticians.length && !indigenousChiefPoliticians.length && !repPoliticians.length && !indigenousRepPoliticians.length" class="text-center py-12 bg-white border border-dashed border-slate-300 rounded-xl">
              <Building2 :size="48" class="mx-auto mb-4 text-slate-300" />
              <h3 class="text-lg font-bold text-navy-900 mb-2">此{{ subRegionLabel }}無參選人資料</h3>
              <p class="text-slate-500">請選擇其他{{ subRegionLabel }}，或選擇{{ villageLabel }}查看{{ villageLabel }}長。</p>
            </div>
          </template>
        </template>

        <!-- ===== 第4級：村里 ===== -->
        <template v-else>
          <PoliticianGrid v-if="chiefPoliticians.length > 0" :politicians="chiefPoliticians" :columns="gridColumns" :title="`${villageLabel}長參選人`"><template #icon><MapPin class="text-amber-500" /></template></PoliticianGrid>
          <!-- 無候選人時的提示 -->
          <div v-if="!chiefPoliticians.length" class="text-center py-12 bg-white border border-dashed border-slate-300 rounded-xl">
            <MapPin :size="48" class="mx-auto mb-4 text-slate-300" />
            <h3 class="text-lg font-bold text-navy-900 mb-2">此{{ villageLabel }}無參選人資料</h3>
            <p class="text-slate-500">請選擇其他{{ villageLabel }}查看。</p>
          </div>
        </template>
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
        <div>
          <div class="flex items-center gap-2 mb-2">
            <Layers :size="16" class="text-slate-400" />
            <span class="text-sm font-medium text-slate-500">議題分類篩選</span>
          </div>
          <div class="flex gap-4 w-full bg-slate-100 p-2 rounded-xl">
            <!-- Left: 全部 -->
            <div class="shrink-0 flex items-center gap-3">
              <button @click="selectedIssueCategory = 'All'" :class="`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${selectedIssueCategory === 'All' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`">全部</button>
              <div class="w-px h-6 bg-slate-300"></div>
            </div>
            <!-- Right: Wrap -->
            <div class="flex-grow flex flex-wrap items-center gap-2">
              <button v-for="category in categories" :key="category" @click="selectedIssueCategory = category" :class="`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${selectedIssueCategory === category ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'}`">{{ category }}</button>
            </div>
          </div>
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

      </div><!-- 左側內容結束 -->

      <!-- 右側：篩選區（手機版顯示在上方） -->
      <div v-if="selectedRegion !== 'All' && availableSubRegions.length > 0" class="order-first md:order-last md:w-1/3 shrink-0">
        <div class="sticky top-4 space-y-4">
          <!-- 鄉鎮市區篩選 -->
          <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div class="flex items-center gap-2 mb-3">
              <MapPin :size="16" class="text-slate-400" />
              <span class="text-sm font-bold text-slate-700">鄉鎮市區</span>
            </div>
            <div class="flex flex-wrap gap-0.5">
              <button
                @click="selectedSubRegion = 'All'"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedSubRegion === 'All' ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`"
              >全部</button>
              <button
                v-for="subRegion in availableSubRegions"
                :key="subRegion"
                @click="selectedSubRegion = subRegion"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedSubRegion === subRegion ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`"
              >{{ subRegion }}</button>
            </div>
          </div>

          <!-- 村里篩選 -->
          <div v-if="availableVillages.length > 0" class="bg-white rounded-xl border border-amber-200 p-4 shadow-sm">
            <div class="flex items-center gap-2 mb-3">
              <MapPin :size="16" class="text-amber-500" />
              <span class="text-sm font-bold text-slate-700">村里</span>
            </div>
            <div class="flex flex-wrap gap-0.5 max-h-64 overflow-y-auto">
              <button
                @click="selectedVillage = 'All'"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedVillage === 'All' ? 'bg-amber-500 text-white shadow-sm' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`"
              >全部</button>
              <button
                v-for="village in availableVillages"
                :key="village"
                @click="selectedVillage = village"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedVillage === village ? 'bg-amber-500 text-white shadow-sm' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`"
              >{{ village }}</button>
            </div>
          </div>

          <!-- 篩選狀態摘要 -->
          <div v-if="selectedSubRegion !== 'All'" class="bg-slate-50 rounded-xl p-4 text-sm text-slate-600">
            <div class="flex items-center gap-2">
              <span class="font-medium">目前篩選：</span>
              <span class="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{{ selectedSubRegion }}</span>
              <span v-if="selectedVillage !== 'All'" class="bg-amber-100 text-amber-700 px-2 py-0.5 rounded">{{ selectedVillage }}</span>
            </div>
          </div>
        </div>
      </div>

      </div><!-- flex 結束 -->
    </div>
  </div>

  <!-- Loading state -->
  <div v-else-if="loading || electionLoading" class="bg-slate-50 min-h-screen flex items-center justify-center">
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
