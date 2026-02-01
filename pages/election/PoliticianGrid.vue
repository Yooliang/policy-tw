<script setup lang="ts">
import { ref } from 'vue'
import { useSupabase } from '../../composables/useSupabase'
import { PolicyStatus, type Politician, type CandidateStatus } from '../../types'
import { ArrowRight, Megaphone, ChevronDown, ChevronUp } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import Avatar from '../../components/Avatar.vue'

defineProps<{
  politicians: Politician[]
  title: string
}>()

const router = useRouter()
const { policies } = useSupabase()
const collapsed = ref(false)

const getPledgeCount = (politicianId: string | number) =>
  policies.value.filter(p => String(p.politicianId) === String(politicianId) && p.status === PolicyStatus.CAMPAIGN).length

// 參選狀態顯示
const candidateStatusLabel = (status?: CandidateStatus) => {
  switch (status) {
    case 'confirmed': return null  // 已確認參選不需特別標註
    case 'likely': return '可能參選'
    case 'rumored': return '傳聞'
    default: return null
  }
}

const candidateStatusColor = (status?: CandidateStatus) => {
  switch (status) {
    case 'likely': return 'bg-amber-100 text-amber-700 border-amber-200'
    case 'rumored': return 'bg-slate-100 text-slate-500 border-slate-200'
    default: return ''
  }
}

// 顯示備註（移除 AI搜尋匯入 前綴）
const displayNote = (note?: string) => {
  if (!note) return null
  // 移除 "AI搜尋匯入: " 或 "AI搜尋匯入" 前綴
  return note.replace(/^AI搜尋匯入[：:]?\s*/, '') || null
}

</script>

<template>
  <div class="mb-12">
    <h3 class="text-xl font-bold text-navy-900 mb-6 flex items-center gap-2 border-l-4 border-blue-500 pl-3 text-left">
      <slot name="icon" /> {{ title }} ({{ politicians.length }})
      <button
        @click="collapsed = !collapsed"
        class="ml-auto p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
        :title="collapsed ? '展開' : '收合'"
      >
        <ChevronUp v-if="!collapsed" :size="20" />
        <ChevronDown v-else :size="20" />
      </button>
    </h3>
    <div v-if="!collapsed && politicians.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <div
        v-for="politician in politicians"
        :key="politician.id"
        @click="router.push(`/politician/${politician.id}`)"
        class="group relative bg-white p-6 rounded-xl border border-slate-200 hover:border-violet-300 hover:shadow-lg transition-all cursor-pointer flex items-center gap-6"
      >
        <div class="relative shrink-0">
          <Avatar :src="politician.avatarUrl" :name="politician.name" size="xl" class="border-4 border-slate-50 group-hover:scale-105 transition-transform" />
          <span :class="`absolute -bottom-1 -right-1 w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold text-white border-2 border-white
            ${politician.party === '國民黨' ? 'bg-blue-600' :
              politician.party === '民進黨' ? 'bg-green-600' :
              politician.party === '民眾黨' ? 'bg-cyan-600' : 'bg-gray-500'}`">
            {{ politician.party[0] }}
          </span>
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex justify-between items-start">
            <div class="text-left">
              <div class="flex items-center gap-2">
                <h3 class="text-lg font-bold text-navy-900 group-hover:text-violet-700 transition-colors">{{ politician.name }}</h3>
                <span
                  v-if="candidateStatusLabel(politician.candidateStatus)"
                  :class="`text-[10px] px-1.5 py-0.5 rounded border font-bold ${candidateStatusColor(politician.candidateStatus)}`"
                >
                  {{ candidateStatusLabel(politician.candidateStatus) }}
                </span>
              </div>
              <div class="flex flex-col">
                <p class="text-sm text-slate-500 font-medium">{{ politician.position || (politician.electionType || '縣市長') + '參選人' }}</p>
                <span v-if="politician.subRegion" class="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded mt-1 w-fit">{{ politician.subRegion }}</span>
                <p v-if="displayNote(politician.sourceNote)" class="text-xs text-slate-400 mt-1 line-clamp-2">{{ displayNote(politician.sourceNote) }}</p>
              </div>
            </div>
            <ArrowRight class="text-slate-300 group-hover:text-violet-400 group-hover:translate-x-1 transition-all" :size="20" />
          </div>
          <div class="mt-3 flex items-center gap-2">
            <span class="inline-flex items-center gap-1 bg-violet-50 text-violet-700 text-xs px-2 py-1 rounded-md font-bold">
              <Megaphone :size="12" /> {{ getPledgeCount(politician.id) }} 項政見
            </span>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="!collapsed" class="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-8 text-center text-slate-400">
      尚無此區域的{{ title }}資料
    </div>
  </div>
</template>
