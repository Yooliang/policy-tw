<script setup lang="ts">
import { useSupabase } from '../../composables/useSupabase'
import { PolicyStatus, type Politician } from '../../types'
import { ArrowRight, Megaphone } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

defineProps<{
  politicians: Politician[]
  title: string
}>()

const router = useRouter()
const { policies } = useSupabase()

const getPledgeCount = (politicianId: number) =>
  policies.value.filter(p => p.politicianId === politicianId && p.status === PolicyStatus.CAMPAIGN).length
</script>

<template>
  <div class="mb-12">
    <h3 class="text-xl font-bold text-navy-900 mb-6 flex items-center gap-2 border-l-4 border-blue-500 pl-3 text-left">
      <slot name="icon" /> {{ title }} ({{ politicians.length }})
    </h3>
    <div v-if="politicians.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <div
        v-for="politician in politicians"
        :key="politician.id"
        @click="router.push(`/politician/${politician.id}`)"
        class="group relative bg-white p-6 rounded-xl border border-slate-200 hover:border-violet-300 hover:shadow-lg transition-all cursor-pointer flex items-center gap-6"
      >
        <div class="relative shrink-0">
          <img :src="politician.avatarUrl" :alt="politician.name" class="w-20 h-20 rounded-full border-4 border-slate-50 group-hover:scale-105 transition-transform" />
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
              <h3 class="text-lg font-bold text-navy-900 group-hover:text-violet-700 transition-colors">{{ politician.name }}</h3>
              <div class="flex flex-col">
                <p class="text-sm text-slate-500 font-medium">{{ politician.electionType || '縣市長' }}參選人</p>
                <span v-if="politician.subRegion" class="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded mt-1 w-fit">{{ politician.subRegion }}</span>
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
    <div v-else class="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-8 text-center text-slate-400">
      尚無此區域的{{ title }}資料
    </div>
  </div>
</template>
