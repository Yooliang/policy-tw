<script setup lang="ts">
import { Database, Milestone, Link as LinkIcon, MessageCircleQuestion } from 'lucide-vue-next'
import HeroAction from './HeroAction.vue'

/**
 * 智能分析／貢獻紀錄／參與協議／公民提問四頁互相切換的同一組按鈕（像分頁），四頁共用、順序與文案固定，只有本頁 active。
 * 要改文字或目的地只改這裡。
 */
export type MechanismPage = 'analysis' | 'contributions' | 'skill' | 'community'

defineProps<{ current: MechanismPage }>()

const ITEMS: Array<{ key: MechanismPage; to: string; label: string; icon: typeof Database }> = [
  { key: 'analysis', to: '/analysis', label: '智能分析', icon: Database },
  { key: 'contributions', to: '/ai-assistant', label: '貢獻紀錄', icon: Milestone },
  { key: 'skill', to: '/skill', label: '參與協議', icon: LinkIcon },
  { key: 'community', to: '/community', label: '公民提問', icon: MessageCircleQuestion },
]
</script>

<template>
  <HeroAction v-for="item in ITEMS" :key="item.key" :to="item.key === current ? undefined : item.to" :active="item.key === current">
    <component :is="item.icon" :size="16" /> {{ item.label }}
  </HeroAction>
</template>
