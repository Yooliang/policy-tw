<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { MessageSquareText, ListChecks, BarChart3 } from 'lucide-vue-next'

/**
 * 貢獻／任務／統計三頁共用的切換列。
 * 2026-09-18：原本這三塊擠在 /ai-assistant 一頁裡用分頁切換，拆成三個網址。
 * 樣式沿用縣市選擇器（GlobalRegionSelector）：選中是藍底白字，未選是白底灰字、hover 才透出藍。
 * 站上「一組互斥的選擇」只有一種長相。
 */

defineProps<{ current: 'contributions' | 'tasks' | 'stats' }>()

const ACTIVE = 'bg-blue-600 text-white border-blue-600 shadow-lg'
const INACTIVE = 'bg-white text-slate-500 border-slate-200 hover:border-blue-300 hover:text-blue-600'

// 統計排第一：它是「貢獻紀錄」進來的第一頁，先看整體再看單筆（2026-09-18）
const LINKS = [
  { key: 'stats', to: '/stats', label: '統計', icon: BarChart3 },
  { key: 'contributions', to: '/contributions', label: '貢獻', icon: MessageSquareText },
  { key: 'tasks', to: '/tasks', label: '任務', icon: ListChecks },
] as const
</script>

<template>
  <div class="flex flex-wrap gap-2" data-testid="board-tabs">
    <RouterLink v-for="l in LINKS" :key="l.key" :to="l.to"
      :class="['px-4 py-2 rounded-xl text-sm font-black inline-flex items-center gap-2 border transition-all', current === l.key ? ACTIVE : INACTIVE]"
      :data-testid="`tab-${l.key}`" :aria-current="current === l.key ? 'page' : undefined">
      <component :is="l.icon" :size="16" /> {{ l.label }}
    </RouterLink>
    <slot name="trailing" />
  </div>
</template>
