<script setup lang="ts">
import { Star, TrendingUp, Waypoints } from 'lucide-vue-next'
import HeroAction from './HeroAction.vue'

/**
 * 「政見」這個大分頁底下的三個看法，三頁共用同一組按鈕：
 *   全部政見   ── 一條一條列（/tracking）
 *   政策脈絡 ── 一件事在某一層級、某一地方的來龍去脈：前後任、同級多人、上下級（/analysis；2026-10-06 由「市政接力」改名，#349）
 *   我的關注   ── 自己按了⭐的政見（/tracking?view=mine）
 *
 * 原本叫「市政接力」（那一頁自己的卡片上印著「市政接力 Relay」）；#349 把它擴成政策脈絡、小良哥 10-05 定名「政策脈絡」。
 * 不叫「分析」：講不出它跟旁邊那張政見列表差在哪。
 * 也刻意不用「跨任期追蹤」之類的——跟當時的「我的追蹤」撞字，掃過去分不出來（2026-09-18 已改名「我的關注」）。
 *
 * 要改文字或目的地只改這裡。
 */
export type PolicyView = 'list' | 'relay' | 'mine'

defineProps<{ current: PolicyView }>()

const ITEMS: Array<{ key: PolicyView; to: string; label: string; icon: typeof Star }> = [
  { key: 'list', to: '/tracking', label: '全部政見', icon: TrendingUp },
  { key: 'relay', to: '/analysis', label: '政策脈絡', icon: Waypoints },
  { key: 'mine', to: '/tracking?view=mine', label: '我的關注', icon: Star },
]
</script>

<template>
  <!-- 三顆在 400px 寬的手機上要擠在同一排，不要換行。尺寸是 HeroAction 的預設，這裡不特別指定。 -->
  <HeroAction v-for="item in ITEMS" :key="item.key" :to="item.key === current ? undefined : item.to" :active="item.key === current">
    <component :is="item.icon" :size="16" /> {{ item.label }}
  </HeroAction>
</template>
