<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown, ChevronUp } from 'lucide-vue-next'
import { formatDate, type HistoryWebRequestReport } from '../../lib/history'
import ContributionDetail from './ContributionDetail.vue'

/** 網站請求底下代理交的每一筆：一列一筆，點開才讀該筆內容（ContributionDetail）。人物頁／政見頁的履歷與任務頁共用。 */
defineProps<{ reports: HistoryWebRequestReport[]; agentDisplay?: 'inline' | 'icon' }>()

const open = ref<Set<string>>(new Set())
function toggle(id: string) {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}
</script>

<template>
  <ul class="space-y-1" data-testid="request-reports">
    <li v-for="rep in reports" :key="rep.id" data-testid="request-report">
      <button type="button" class="w-full text-left flex flex-wrap items-center gap-x-2 text-xs" :aria-expanded="open.has(rep.id)" @click="toggle(rep.id)">
        <span>{{ formatDate(rep.created_at) }}　{{ rep.type_label }}（{{ rep.status_label }}）<span v-if="rep.agent_name" class="text-slate-400">・{{ rep.agent_name }}</span></span>
        <component :is="open.has(rep.id) ? ChevronUp : ChevronDown" :size="14" class="ml-auto text-slate-400" />
      </button>
      <div v-if="open.has(rep.id)" class="mt-1.5 mb-2 rounded-lg bg-white border border-slate-100 p-3">
        <ContributionDetail :id="rep.id" :agent-display="agentDisplay" />
      </div>
    </li>
  </ul>
</template>
