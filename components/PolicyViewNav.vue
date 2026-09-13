<script setup lang="ts">
import { Star, TrendingUp, GitBranch } from 'lucide-vue-next'
import HeroAction from './HeroAction.vue'

/**
 * 「政見」這個大分頁底下的三個看法，三頁共用同一組按鈕：
 *   全部政見   ── 一條一條列（/tracking）
 *   市政接力 ── 同一個建設案跨任期、跨黨派串成一條線（/analysis）
 *   我的追蹤   ── 自己標記的檢核點（/tracking?view=mine）
 *
 * 為什麼是「市政接力」不是「分析」：那一頁自己的卡片上就印著「市政接力 Relay」，
 * 沿用既有詞彙比另造一個好；而「分析」講不出它跟旁邊那張政見列表差在哪。
 * 也刻意不用「跨任期追蹤」之類的——跟「我的追蹤」撞字，掃過去分不出來。
 *
 * 要改文字或目的地只改這裡。
 */
export type PolicyView = 'list' | 'relay' | 'mine'

defineProps<{ current: PolicyView }>()

const ITEMS: Array<{ key: PolicyView; to: string; label: string; icon: typeof Star }> = [
  { key: 'list', to: '/tracking', label: '全部政見', icon: TrendingUp },
  { key: 'relay', to: '/analysis', label: '市政接力', icon: GitBranch },
  { key: 'mine', to: '/tracking?view=mine', label: '我的追蹤', icon: Star },
]
</script>

<template>
  <!-- compact：三顆在 400px 寬的手機上要擠在同一排，不要換行 -->
  <HeroAction v-for="item in ITEMS" :key="item.key" compact :to="item.key === current ? undefined : item.to" :active="item.key === current">
    <component :is="item.icon" :size="16" /> {{ item.label }}
  </HeroAction>
</template>
