<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { Policy, Politician, PolicyStatus } from '../types'
import StatusBadge from './StatusBadge.vue'
import { Calendar, Tag, ChevronRight, ThumbsUp, Star } from 'lucide-vue-next'

const props = defineProps<{
  policy: Policy
  politician: Politician
  onClick?: () => void
}>()

const isCampaign = props.policy.status === PolicyStatus.CAMPAIGN
const isCheckpointed = ref(false)

const loadCheckpoint = () => {
  const checkpoints = JSON.parse(localStorage.getItem('zhengjian_checkpoints') || '[]')
  isCheckpointed.value = checkpoints.includes(props.policy.id)
}

const toggleCheckpoint = (e: Event) => {
  e.stopPropagation()
  const checkpoints = JSON.parse(localStorage.getItem('zhengjian_checkpoints') || '[]')
  let newCheckpoints: number[]
  if (isCheckpointed.value) {
    newCheckpoints = checkpoints.filter((id: number) => id !== props.policy.id)
  } else {
    newCheckpoints = [...checkpoints, props.policy.id]
  }
  localStorage.setItem('zhengjian_checkpoints', JSON.stringify(newCheckpoints))
  isCheckpointed.value = !isCheckpointed.value
  window.dispatchEvent(new Event('checkpoints_updated'))
}

onMounted(() => {
  loadCheckpoint()
  window.addEventListener('checkpoints_updated', loadCheckpoint)
})

onUnmounted(() => {
  window.removeEventListener('checkpoints_updated', loadCheckpoint)
})
</script>

<template>
  <div
    :class="`bg-white rounded-2xl border shadow-sm hover:shadow-xl transition-all duration-300 cursor-pointer overflow-hidden group relative flex flex-col h-full ${isCampaign ? 'border-violet-100 hover:border-violet-300' : 'border-slate-200 hover:border-blue-300'}`"
    @click="onClick?.()"
  >
    <!-- Checkpoint Star -->
    <button
      @click.stop="toggleCheckpoint"
      :class="`absolute top-4 right-4 z-20 p-2 rounded-full transition-all border ${isCheckpointed ? 'bg-amber-50 border-amber-200 text-amber-500 shadow-sm' : 'bg-white/80 backdrop-blur-sm border-slate-100 text-slate-300 hover:text-amber-400 opacity-0 group-hover:opacity-100'}`"
      :title="isCheckpointed ? '移除檢核點' : '加入我的檢核點'"
    >
      <Star :size="18" :fill="isCheckpointed ? 'currentColor' : 'none'" :class="isCheckpointed ? 'animate-pulse' : ''" />
    </button>

    <div class="p-6 flex-1">
      <div class="flex justify-between items-start mb-4">
        <div class="flex items-center gap-3">
          <img :src="politician.avatarUrl" :alt="politician.name" class="w-10 h-10 rounded-full border-2 border-slate-50 shadow-sm" />
          <div class="text-left">
            <span class="font-bold text-navy-900 block text-sm">{{ politician.name }}</span>
            <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest">{{ politician.party }}</span>
          </div>
        </div>
        <StatusBadge :status="policy.status" />
      </div>

      <h3 :class="`text-lg font-black mb-3 leading-tight transition-colors ${isCampaign ? 'text-violet-900 group-hover:text-violet-700' : 'text-navy-900 group-hover:text-blue-600'}`">
        {{ policy.title }}
      </h3>

      <p class="text-sm text-slate-500 line-clamp-2 mb-6 h-10 leading-relaxed font-medium">
        {{ policy.description }}
      </p>

      <div class="flex items-center gap-4 text-[10px] font-black text-slate-400 mb-6 uppercase tracking-widest">
        <div class="flex items-center gap-1.5">
          <Calendar :size="12" class="text-slate-300" />
          <span>{{ isCampaign ? `${policy.proposedDate.split('-')[0]} 承諾` : `${policy.lastUpdated.split('-')[0]} 更新` }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <Tag :size="12" class="text-slate-300" />
          <span>{{ policy.category }}</span>
        </div>
      </div>

      <!-- Progress Logic -->
      <div v-if="isCampaign" class="flex items-center justify-between bg-violet-50 rounded-xl p-3 text-violet-700">
        <span class="text-[10px] font-black uppercase tracking-wider">選民期待度</span>
        <div class="flex items-center gap-1.5 text-sm font-black">
          <ThumbsUp :size="14" class="fill-current" />
          {{ policy.supportCount?.toLocaleString() }}
        </div>
      </div>
      <div v-else class="space-y-2">
        <div class="flex justify-between text-[10px] font-black text-slate-400 uppercase tracking-widest">
          <span>當前執行進度</span>
          <span>{{ policy.progress }}%</span>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
          <div
            :class="`h-full rounded-full transition-all duration-1000 ${
              policy.status === PolicyStatus.ACHIEVED ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.3)]' :
              policy.status === PolicyStatus.FAILED ? 'bg-red-500' : 'bg-blue-600 shadow-[0_0_10px_rgba(37,99,235,0.3)]'
            }`"
            :style="{ width: `${policy.progress}%` }"
          ></div>
        </div>
      </div>
    </div>

    <div :class="`${isCampaign ? 'bg-violet-50/30' : 'bg-slate-50/50'} px-6 py-4 border-t border-slate-100 flex justify-between items-center group-hover:bg-white transition-colors`">
      <span :class="`text-[10px] font-black uppercase tracking-widest ${isCampaign ? 'text-violet-500' : 'text-slate-400'}`">
        {{ isCampaign ? '查看承諾詳情' : '查看詳細歷程' }}
      </span>
      <ChevronRight :size="14" :class="`${isCampaign ? 'text-violet-300' : 'text-slate-300'} group-hover:translate-x-1 transition-transform`" />
    </div>
  </div>
</template>
