<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { House, TrendingUp, Vote, Milestone } from 'lucide-vue-next'
import { electionPath } from '../lib/election-regions'
import { electionSegment } from '../lib/election-route'
import { useSupabase } from '../composables/useSupabase'

// 手機版底部分頁列（X 式版面，md 以下）：原本在頂部的主選單搬到這裡，圖示加短字，避開 iPhone 的 home 條（safe-area）。
const route = useRoute()
const { getActiveElection } = useSupabase()
const activeElection = computed(() => getActiveElection())

const items = computed(() => {
  const list = [
    { name: '首頁', path: '/', icon: House, exact: true },
    { name: '政見', path: '/tracking', icon: TrendingUp, exact: false },
  ]
  if (activeElection.value) list.push({ name: '選舉', path: electionPath(electionSegment(activeElection.value)), icon: Vote, exact: false })
  list.push({ name: '參與', path: '/stats', icon: Milestone, exact: false })
  return list
})
const isActive = (item: { path: string; exact: boolean }) => item.exact ? route.path === item.path : route.path === item.path || route.path.startsWith(item.path + '/')
</script>

<template>
  <nav
    class="md:hidden fixed inset-x-0 bottom-0 z-40 flex border-t border-slate-200 bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
    aria-label="主選單"
    data-testid="mobile-tab-bar"
  >
    <RouterLink
      v-for="item in items"
      :key="item.name"
      :to="item.path"
      class="flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-bold transition-colors"
      :class="isActive(item) ? 'text-blue-600' : 'text-slate-500'"
      :aria-current="isActive(item) ? 'page' : undefined"
    >
      <component :is="item.icon" :size="22" :stroke-width="isActive(item) ? 2.6 : 2" />
      <span>{{ item.name }}</span>
    </RouterLink>
  </nav>
</template>
