<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import { PolicyStatus } from '../types'
import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import Avatar from '../components/Avatar.vue'
import { Search, GitBranch, Sparkles, Database, Milestone, ArrowRight } from 'lucide-vue-next'
import { useRouter } from 'vue-router'


const router = useRouter()
const { policies, politicians } = useSupabase()
const searchTerm = ref('')

const relayCases = computed(() => {
  const cases: any[] = []
  const visitedPolicyIds = new Set<string>()

  policies.value.forEach(policy => {
    if (visitedPolicyIds.has(policy.id)) return
    if (policy.relatedPolicyIds && policy.relatedPolicyIds.length > 0) {
      const chain = policies.value.filter(p => p.id === policy.id || policy.relatedPolicyIds?.includes(p.id) || p.relatedPolicyIds?.includes(policy.id))
        .sort((a, b) => new Date(a.proposedDate).getTime() - new Date(b.proposedDate).getTime())
      chain.forEach(p => visitedPolicyIds.add(p.id))
      cases.push({
        id: `case-${policy.id}`,

        mainTitle: policy.title.includes('園區') ? '高屏產業聚落接力案' : policy.title,
        category: policy.category,
        policies: chain,
        involvedPoliticianIds: [...new Set(chain.map(p => p.politicianId))],
        startYear: chain[0].proposedDate.split('-')[0],
        lastYear: new Date().getFullYear().toString(),
        totalProgress: Math.round(chain.reduce((acc, p) => acc + p.progress, 0) / chain.length),
        isRelay: true
      })
    } else if (policy.status !== PolicyStatus.CAMPAIGN && policy.progress > 50) {
      visitedPolicyIds.add(policy.id)
      cases.push({
        id: `case-${policy.id}`,
        mainTitle: policy.title,
        category: policy.category,
        policies: [policy],
        involvedPoliticianIds: [policy.politicianId],
        startYear: policy.proposedDate.split('-')[0],
        lastYear: new Date().getFullYear().toString(),
        totalProgress: policy.progress,
        isRelay: false
      })
    }
  })
  return cases.filter(c => c.mainTitle.toLowerCase().includes(searchTerm.value.toLowerCase()))
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20 text-left">
    <Hero background-image="/images/heroes/ai.png">
      <template #title>AI 智能分析</template>
      <template #description>這不是單一政見的陳列。我們將跨任期、跨黨派的重大建設案進行聚合，<br class="hidden lg:block" />分析每一根治理接力棒的傳承品質，提供具備行政歷史深度的稽核數據。</template>
      <template #icon><Database :size="400" class="text-blue-500" /></template>

      <div class="space-y-2">
        <GlobalRegionSelector />

        <div class="flex flex-col lg:flex-row gap-4 items-center">
          <!-- 搜尋框 -->
          <div class="relative flex-1 w-full">
            <Search class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" :size="20" />
            <input
              v-model="searchTerm"
              type="text"
              placeholder="搜尋重大建設案（如：產業園區、捷運建設）..."
              class="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-navy-900 font-medium placeholder:text-slate-400"
            />
          </div>
        </div>
      </div>
    </Hero>


    <div class="max-w-7xl mx-auto px-4 pt-20">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div
          v-for="relayCase in relayCases"
          :key="relayCase.id"
          @click="router.push(`/analysis/${relayCase.policies[relayCase.policies.length - 1].id}`)"
          class="group bg-white rounded-[32px] border border-slate-200 shadow-sm hover:shadow-2xl hover:border-blue-400 transition-all duration-500 cursor-pointer overflow-hidden flex flex-col"
        >
          <div class="p-8 flex-1">
            <div class="flex justify-between items-start mb-8">
              <div class="flex items-center gap-2">
                <div class="p-3 bg-navy-900 text-white rounded-2xl shadow-lg"><Milestone :size="24" /></div>
                <span class="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">Case Study</span>
              </div>
              <div v-if="relayCase.isRelay" class="flex items-center gap-1.5 bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-[10px] font-black border border-blue-100 uppercase animate-pulse">
                <GitBranch :size="12" /> 市政接力 Relay
              </div>
            </div>
            <h3 class="text-2xl font-black text-navy-900 mb-4 group-hover:text-blue-600 transition-colors leading-tight">{{ relayCase.mainTitle }}</h3>
            <p class="text-slate-500 text-sm leading-relaxed mb-8 line-clamp-2 font-medium">{{ relayCase.policies[0].description }}</p>
            <div class="mb-8">
              <div class="flex justify-between text-[10px] font-black text-slate-400 mb-3 uppercase tracking-widest">
                <span>{{ relayCase.startYear }} 啟動</span>
                <span>{{ new Date().getFullYear() }} 預計願景</span>
              </div>
              <div class="h-3 w-full bg-slate-100 rounded-full overflow-hidden flex">
                <div class="h-full bg-blue-600 rounded-full shadow-lg shadow-blue-500/20 transition-all duration-1000" :style="{ width: `${relayCase.totalProgress}%` }"></div>
              </div>
            </div>
            <div class="flex items-center justify-between pt-6 border-t border-slate-50">
              <div class="flex -space-x-3">
                <Avatar
                  v-for="cid in relayCase.involvedPoliticianIds"
                  :key="cid"
                  :src="politicians.find(pol => pol.id === cid)?.avatarUrl"
                  :name="politicians.find(pol => pol.id === cid)?.name || ''"
                  size="md"
                  class="border-4 border-white shadow-md group-hover:scale-110 transition-all"
                />
              </div>
              <div class="text-right">
                <div class="text-[10px] font-black text-slate-400 uppercase tracking-tighter">參與首長</div>
                <div class="text-sm font-black text-navy-900">{{ relayCase.involvedPoliticianIds.length }} 位市政接棒者</div>
              </div>
            </div>
          </div>
          <div class="px-8 py-5 bg-slate-50 group-hover:bg-blue-600 transition-colors flex justify-between items-center border-t border-slate-100">
            <span class="text-xs font-black text-slate-500 group-hover:text-white uppercase tracking-widest">進入深度審計詳情 Deep Audit</span>
            <div class="w-8 h-8 rounded-full bg-white flex items-center justify-center text-navy-900 shadow-md group-hover:translate-x-1 transition-all"><ArrowRight :size="18" /></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
