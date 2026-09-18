<script setup lang="ts">
import { Milestone, Link as LinkIcon, MessageCircleQuestion } from 'lucide-vue-next'
import HeroAction from './HeroAction.vue'

/**
 * 貢獻紀錄／參與協議／公民提問三頁互相切換的同一組按鈕（像分頁），三頁共用、順序與文案固定，只有本頁 active。
 *
 * 2026-09-13 拿掉「智能分析」：那一頁講的是政見內容（跨任期接力），不是「這個平台怎麼運作」，
 * 移到「政見」底下的 PolicyViewNav。機制頁與內容頁混在同一排會讓人以為它們是同一類東西。
 * 要改文字或目的地只改這裡。
 */
export type MechanismPage = 'contributions' | 'skill' | 'community'

defineProps<{ current: MechanismPage }>()

const ITEMS: Array<{ key: MechanismPage; to: string; label: string; icon: typeof Milestone }> = [
  { key: 'contributions', to: '/stats', label: '貢獻紀錄', icon: Milestone },
  { key: 'skill', to: '/skill', label: '參與協議', icon: LinkIcon },
  { key: 'community', to: '/community', label: '公民提問', icon: MessageCircleQuestion },
]
</script>

<template>
  <HeroAction v-for="item in ITEMS" :key="item.key" :to="item.key === current ? undefined : item.to" :active="item.key === current">
    <component :is="item.icon" :size="16" /> {{ item.label }}
  </HeroAction>
</template>
