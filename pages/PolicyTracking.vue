<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import { useGlobalState } from '../composables/useGlobalState'
import { PolicyStatus } from '../types'
import PolicyCard from '../components/PolicyCard.vue'
import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import { Search, TrendingUp, Star } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

const router = useRouter()
const { policies, politicians, locations, categories } = useSupabase()
const { globalRegion } = useGlobalState()

const selectedLocation = ref(globalRegion.value)
const selectedCategory = ref('All')

// Sync with global state
watch(globalRegion, (newVal) => {
  selectedLocation.value = newVal
})

watch(selectedLocation, (newVal) => {
  // If user manually changes it here, we could update global state too
  // setGlobalRegion(newVal)
})

const searchTerm = ref('')
const showCheckpointsOnly = ref(false)
const checkpoints = ref<string[]>([])


const loadCheckpoints = () => {
  checkpoints.value = JSON.parse(localStorage.getItem('zhengjian_checkpoints') || '[]')
}

onMounted(() => {
  loadCheckpoints()
  window.addEventListener('checkpoints_updated', loadCheckpoints)
})

onUnmounted(() => {
  window.removeEventListener('checkpoints_updated', loadCheckpoints)
})

const filteredPolicies = computed(() => {
  return policies.value.filter(policy => {
    const politician = politicians.value.find(c => c.id === policy.politicianId)
    const matchesLocation = selectedLocation.value === 'All' || politician?.region === selectedLocation.value
    const matchesCategory = selectedCategory.value === 'All' || policy.category === selectedCategory.value
    const matchesSearch = policy.title.toLowerCase().includes(searchTerm.value.toLowerCase()) ||
                         policy.description.toLowerCase().includes(searchTerm.value.toLowerCase())
    const matchesCheckpoints = !showCheckpointsOnly.value || checkpoints.value.includes(policy.id)
    const isNotCampaign = policy.status !== PolicyStatus.CAMPAIGN
    return matchesLocation && matchesCategory && matchesSearch && matchesCheckpoints && isNotCampaign
  })
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero background-image="/images/heroes/policy-tracking.png">
      <template #title>政見追蹤</template>
      <template #description>我們持續追蹤全台各縣市首長與民意代表的政見執行進度。<br />透過數據與時間軸，確保每一項治理承諾都在正確的軌道上。</template>
      <template #icon><TrendingUp :size="400" class="text-blue-500" /></template>

      <!-- Hero Actions: 頁籤 -->
      <template #actions>
        <button @click="showCheckpointsOnly = false" :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${!showCheckpointsOnly ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`">
          <TrendingUp :size="16" /> 政見列表
        </button>
        <button @click="showCheckpointsOnly = true" :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${showCheckpointsOnly ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`">
          <Star :size="16" /> 我的追蹤
        </button>
      </template>

      <GlobalRegionSelector />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <!-- 搜尋 -->
      <div class="mb-6">
        <div class="relative max-w-xl">
          <Search class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" :size="20" />
          <input
            v-model="searchTerm"
            type="text"
            placeholder="搜尋關鍵字（如：長照、捷運、產業園區）..."
            class="w-full pl-12 pr-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-navy-900 font-medium placeholder:text-slate-400 shadow-sm"
          />
        </div>
      </div>

      <!-- 分類篩選 -->
      <div class="flex gap-4 w-full bg-slate-100 p-2 rounded-xl mb-8">
        <!-- Left: 全部 -->
        <div class="shrink-0 flex items-center gap-3">
          <button
            @click="selectedCategory = 'All'"
            :class="[
              'px-3 py-1.5 rounded-lg text-sm font-bold transition-all',
              selectedCategory === 'All'
                ? 'bg-white text-navy-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'
            ]"
          >
            全部
          </button>
          <div class="w-px h-6 bg-slate-300"></div>
        </div>
        <!-- Right: Wrap -->
        <div class="flex-grow flex flex-wrap items-center gap-2">
          <button
            v-for="cat in categories"
            :key="cat"
            @click="selectedCategory = cat"
            :class="[
              'px-3 py-1.5 rounded-lg text-sm font-bold transition-all',
              selectedCategory === cat
                ? 'bg-white text-navy-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'
            ]"
          >
            {{ cat }}
          </button>
        </div>
      </div>
      <div v-if="showCheckpointsOnly && filteredPolicies.length > 0" class="mb-12 flex items-center gap-3 text-amber-600 font-bold bg-amber-50 p-4 rounded-2xl border border-amber-100 animate-fade-in">
        <Star :size="20" fill="currentColor" />
        <span>您正在查看個人追蹤的檢核點（共 {{ filteredPolicies.length }} 項）</span>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 text-left">
        <template v-if="filteredPolicies.length > 0">
          <template v-for="policy in filteredPolicies" :key="policy.id">
            <PolicyCard
              v-if="politicians.find(c => c.id === policy.politicianId)"
              :policy="policy"
              :politician="politicians.find(c => c.id === policy.politicianId)!"
              :on-click="() => router.push(`/policy/${policy.id}`)"
            />
          </template>
        </template>
        <div v-else class="col-span-full text-center py-32 text-slate-400 bg-white rounded-3xl border border-dashed border-slate-300">
          <template v-if="showCheckpointsOnly">
            <Star :size="48" class="mx-auto mb-4 opacity-20" />
            <p class="font-bold">目前沒有標記任何政見檢核點。</p>
            <button @click="showCheckpointsOnly = false" class="mt-4 text-blue-600 font-bold hover:underline">瀏覽全部政見</button>
          </template>
          <template v-else>
            <Search :size="48" class="mx-auto mb-4 opacity-20" />
            <p class="font-bold">沒有找到符合條件的政見。</p>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
