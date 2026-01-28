<script setup lang="ts">
import { computed } from 'vue'
import { CANDIDATES } from '../../constants'
import { ElectionType, type Policy } from '../../types'
import { ArrowDown } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

const props = defineProps<{
  tag: string
  policies: Policy[]
}>()

const router = useRouter()

const getPoliciesByLevel = (type: ElectionType) =>
  props.policies.filter(p =>
    p.tags.includes(props.tag) &&
    CANDIDATES.find(c => c.id === p.candidateId)?.electionType === type
  )

const mayors = computed(() => getPoliciesByLevel(ElectionType.MAYOR))
const councilors = computed(() => getPoliciesByLevel(ElectionType.COUNCILOR))
const adminLevel = computed(() => [
  ...getPoliciesByLevel(ElectionType.TOWNSHIP_MAYOR),
  ...getPoliciesByLevel(ElectionType.INDIGENOUS_DISTRICT_CHIEF)
])
const commLevel = computed(() => [
  ...getPoliciesByLevel(ElectionType.REPRESENTATIVE),
  ...getPoliciesByLevel(ElectionType.INDIGENOUS_DISTRICT_REP)
])
const chiefs = computed(() => getPoliciesByLevel(ElectionType.CHIEF))

const levels = computed(() => [
  { label: '縣市長', colorBorder: 'border-red-400', colorBg: 'bg-red-100 text-red-700', items: mayors.value, cols: 'grid-cols-1', emptyMsg: '縣市長層級尚未針對此議題表態。' },
  { label: '議員', colorBorder: 'border-blue-400', colorBg: 'bg-blue-100 text-blue-700', items: councilors.value, cols: 'grid-cols-1 md:grid-cols-2', emptyMsg: '尚無議員針對此議題提出質詢或預算案。' },
  { label: '鄉長/區長', colorBorder: 'border-indigo-400', colorBg: 'bg-indigo-100 text-indigo-700', items: adminLevel.value, cols: 'grid-cols-1 md:grid-cols-3', emptyMsg: '尚無行政首長層級的規劃。' },
  { label: '代表', colorBorder: 'border-green-400', colorBg: 'bg-green-100 text-green-700', items: commLevel.value, cols: 'grid-cols-1 md:grid-cols-3', emptyMsg: '尚無地方代表層級的具體建議。' },
  { label: '里長', colorBorder: 'border-amber-400', colorBg: 'bg-amber-100 text-amber-700', items: chiefs.value, cols: 'grid-cols-1 md:grid-cols-3', emptyMsg: '尚無里長層級的具體建議。' },
])
</script>

<template>
  <div class="border border-slate-200 rounded-2xl bg-white shadow-sm overflow-hidden animate-fade-in">
    <div class="bg-slate-50 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="text-2xl font-bold text-navy-900">#{{ tag }}</span>
        <span class="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs font-bold">議題垂直分析</span>
      </div>
    </div>

    <div class="p-6 grid gap-6 relative">
      <div class="absolute left-12 top-6 bottom-6 w-1 bg-slate-100 -z-10 hidden md:block"></div>

      <template v-for="(level, levelIdx) in levels" :key="level.label">
        <div v-if="levelIdx > 0" class="hidden md:flex text-slate-300"><div class="w-32 shrink-0 flex justify-center"><ArrowDown :size="24" /></div></div>
        <div class="flex flex-col md:flex-row gap-6">
          <div class="w-full md:w-32 shrink-0 flex flex-col items-center justify-center">
            <span :class="`${level.colorBg} px-3 py-1 rounded-full text-xs font-bold block w-full text-center`">{{ level.label }}</span>
          </div>
          <div :class="`flex-1 grid ${level.cols} gap-4 text-left`">
            <template v-if="level.items.length > 0">
              <div
                v-for="p in level.items"
                :key="p.id"
                @click="router.push(`/policy/${p.id}`)"
                :class="`bg-white border-l-4 ${level.colorBorder} shadow-sm border-y border-r border-slate-100 p-4 rounded-r-lg hover:shadow-md cursor-pointer transition-all`"
              >
                <div class="flex items-center gap-2 mb-2">
                  <img :src="CANDIDATES.find(can => can.id === p.candidateId)?.avatarUrl" class="w-6 h-6 rounded-full" />
                  <span class="text-sm font-bold text-navy-900">{{ CANDIDATES.find(can => can.id === p.candidateId)?.name }}</span>
                </div>
                <h4 class="font-bold text-sm text-navy-900 line-clamp-2">{{ p.title }}</h4>
              </div>
            </template>
            <div v-else class="text-slate-400 text-sm italic py-4">{{ level.emptyMsg }}</div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
