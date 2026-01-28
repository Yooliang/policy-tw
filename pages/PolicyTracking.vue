<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import { PolicyStatus } from '../types'
import PolicyCard from '../components/PolicyCard.vue'
import Hero from '../components/Hero.vue'
import { Filter, Search, TrendingUp, Star } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

const router = useRouter()
const { policies, politicians, locations, categories } = useSupabase()
const selectedLocation = ref('All')
const selectedCategory = ref('All')
const searchTerm = ref('')
const showCheckpointsOnly = ref(false)
const checkpoints = ref<number[]>([])

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
    <Hero>
      <template #title>政見追蹤</template>
      <template #description>我們持續追蹤全台各縣市首長與民意代表的政見執行進度。<br />透過數據與時間軸，確保每一項治理承諾都在正確的軌道上。</template>
      <template #icon><TrendingUp :size="400" class="text-blue-500" /></template>

        <div class="flex flex-col lg:flex-row gap-6 items-center">
            <!-- search input -->
          <div class="relative flex-1 w-full text-left flex items-center">
            <Search class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" :size="20" />
            <input
              v-model="searchTerm"
              type="text"
              placeholder="搜尋關鍵字（如：長照、捷運、產業園區）..."
              class="w-full pl-12 pr-4 py-3.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-blue-500 text-navy-900 font-bold placeholder:text-slate-400"
            />
          </div>
          <!-- search input end -->

          <div class="flex flex-wrap lg:flex-nowrap gap-3 w-full lg:w-auto">
            <button
              @click="showCheckpointsOnly = !showCheckpointsOnly"
              :class="`flex items-center gap-2 px-5 py-3 rounded-xl border transition-all font-bold text-sm shrink-0 ${showCheckpointsOnly ? 'bg-amber-500 text-white border-amber-400 shadow-lg shadow-amber-500/20' : 'bg-white text-slate-500 border-slate-200 hover:border-amber-300 hover:text-amber-500'}`"
            >
              <Star :size="18" :fill="showCheckpointsOnly ? 'currentColor' : 'none'" />
              {{ showCheckpointsOnly ? '已顯示檢核點' : '我的檢核點' }}
            </button>

            <div class="flex items-center gap-2 px-4 py-2 bg-slate-50 rounded-xl border border-slate-100 flex-1 min-w-[140px]">
              <Filter :size="16" class="text-slate-400" />
              <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest shrink-0">地區</span>
              <select v-model="selectedLocation" class="bg-transparent border-none text-sm font-bold text-navy-900 focus:ring-0 cursor-pointer w-full">
                <option value="All">全部地區</option>
                <option v-for="loc in locations" :key="loc" :value="loc">{{ loc }}</option>
              </select>
            </div>

            <div class="flex items-center gap-2 px-4 py-2 bg-slate-50 rounded-xl border border-slate-100 flex-1 min-w-[140px]">
              <Filter :size="16" class="text-slate-400" />
              <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest shrink-0">類別</span>
              <select v-model="selectedCategory" class="bg-transparent border-none text-sm font-bold text-navy-900 focus:ring-0 cursor-pointer w-full">
                <option value="All">全部類別</option>
                <option v-for="cat in categories" :key="cat" :value="cat">{{ cat }}</option>
              </select>
            </div>
          </div>
        </div>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-24">
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
