<script setup lang="ts">
import { User, FileText } from 'lucide-vue-next'
import type { useGlobalSearch } from '../composables/useGlobalSearch'

// 搜尋結果列表（人物＋政見）：視窗版（GlobalSearch）與手機搜尋頁（SearchPage）共用，邏輯在 useGlobalSearch。
const props = defineProps<{ term: string; search: ReturnType<typeof useGlobalSearch> }>()
const emit = defineEmits<{ (e: 'pick', path: string): void }>()
</script>

<template>
  <div>
  <p v-if="!props.term.trim()" class="px-4 py-6 text-sm text-slate-400">輸入姓名或政見關鍵字。</p>
  <p v-else-if="!search.loading.value && !search.hasResults.value" class="px-4 py-6 text-sm text-slate-500" data-testid="global-search-empty">找不到「{{ props.term.trim() }}」。</p>

  <div v-if="search.people.value.length" class="py-2">
    <p class="px-4 pb-1 text-xs font-bold text-slate-400 inline-flex items-center gap-1"><User :size="12" />人物</p>
    <button
      v-for="p in search.people.value"
      :key="p.id"
      type="button"
      class="w-full text-left px-4 py-2 hover:bg-slate-50 flex items-center gap-2"
      data-testid="search-person"
      @click="emit('pick', `/politician/${p.id}`)"
    >
      <span :class="['font-bold', search.isRunning(p) || p.incumbent_type ? 'text-navy-900' : 'text-slate-500']">{{ p.name }}</span>
      <!-- 這一屆有參選的標色，其餘是歷屆紀錄 -->
      <span v-if="p.running_type" class="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 shrink-0">{{ search.activeYear.value }} {{ p.running_type }}{{ search.voted.value ? '・當選' : '' }}</span>
      <span v-else-if="p.incumbent_type" class="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 shrink-0">現任{{ p.incumbent_type }}</span>
      <span class="text-xs text-slate-400 truncate">{{ [p.party, p.region, p.current_position].filter(Boolean).join('・') }}</span>
    </button>
  </div>

  <div v-if="search.policies.value.length" class="py-2 border-t border-slate-100">
    <p class="px-4 pb-1 text-xs font-bold text-slate-400 inline-flex items-center gap-1"><FileText :size="12" />政見</p>
    <button
      v-for="x in search.policies.value"
      :key="x.id"
      type="button"
      class="w-full text-left px-4 py-2 hover:bg-slate-50 flex items-center gap-2"
      data-testid="search-policy"
      @click="emit('pick', `/policy/${x.id}`)"
    >
      <!-- 競選承諾弱化：說要做的事，跟已經在做／做完的不同分量 -->
      <span v-if="x.status === 'Campaign Pledge'" class="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-400 shrink-0">承諾</span>
      <span v-else class="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 shrink-0">政見</span>
      <span :class="['truncate', x.status === 'Campaign Pledge' ? 'text-slate-500' : 'text-navy-900 font-medium']">{{ x.title }}</span>
      <span v-if="x.election_id" class="text-xs text-slate-400 shrink-0">{{ search.electionYearText(x.election_id) }}</span>
    </button>
  </div>
  </div>
</template>
