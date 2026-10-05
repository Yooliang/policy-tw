<script setup lang="ts">
/**
 * 政見頁「所屬脈絡」（#349）：這條政見講的事在哪一條政策脈絡裡，一個真連結點過去看前後任、參與者與上下級。
 * 資料是視圖 policies_with_logs.lineage（政見頁的預渲染／邊緣渲染快照本來就帶），不另外撈。
 */
import { RouterLink } from 'vue-router'
import { ArrowRight, Waypoints } from 'lucide-vue-next'
import type { LineageSummary } from '../types'
import { LEVEL_LABEL, LINEAGE_NAME, lineagePath, lineagePlace } from '../lib/lineage'

defineProps<{ lineage: LineageSummary }>()
</script>

<template>
  <section class="bg-white p-6 sm:p-8 rounded-xl border border-slate-200 shadow-sm" data-testid="policy-lineage-card">
    <h2 class="text-xl font-bold text-navy-900 mb-2 flex items-center gap-2"><Waypoints class="text-slate-400" :size="22" />所屬脈絡</h2>
    <p class="text-sm text-slate-500 leading-relaxed mb-4">
      這條政見講的事，在{{ lineagePlace(lineage) }}有一條{{ LINEAGE_NAME }}：前後任怎麼交接、還有哪些人提案或推動、跟上下級政府的哪件事有關，都在脈絡頁。
    </p>
    <RouterLink :to="lineagePath(lineage.id)" class="group block rounded-lg border border-blue-200 bg-blue-50 p-4 hover:border-blue-300 transition-colors">
      <span class="block text-xs font-bold text-blue-700 mb-1">
        {{ LINEAGE_NAME }}・{{ LEVEL_LABEL[lineage.level] }}・{{ lineagePlace(lineage) }}<template v-if="lineage.category">・{{ lineage.category }}</template>
      </span>
      <span class="block text-lg font-bold text-navy-900 group-hover:underline break-words">{{ lineage.title }}</span>
      <span v-if="lineage.summary" class="block text-sm text-slate-600 mt-1 break-words">{{ lineage.summary }}</span>
      <span class="mt-2 inline-flex items-center gap-1 text-sm font-bold text-blue-700">看這條脈絡 <ArrowRight :size="14" /></span>
    </RouterLink>
  </section>
</template>
