<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { House, TrendingUp, Milestone, Search } from 'lucide-vue-next'
import { electionPath } from '../lib/election-regions'
import { electionSegment } from '../lib/election-route'
import { useSupabase } from '../composables/useSupabase'

// 手機版底部分頁列（X 式版面，md 以下）：原本在頂部的主選單搬到這裡，圖示加短字，避開 iPhone 的 home 條（safe-area）。
// 順序：首頁｜政見｜選舉｜參與｜搜尋；「選舉」在正中，是向上凸出的圓形徽章（內嵌 SVG，深淺色都用同一組金／紅／深藍）。
const route = useRoute()
const { getActiveElection } = useSupabase()
const activeElection = computed(() => getActiveElection())

const items = computed(() => {
  const list = [
    { name: '首頁', path: '/', icon: House, exact: true, badge: false },
    { name: '政見', path: '/tracking', icon: TrendingUp, exact: false, badge: false },
  ]
  if (activeElection.value) list.push({ name: '選舉', path: electionPath(electionSegment(activeElection.value)), icon: House, exact: false, badge: true })
  list.push({ name: '參與', path: '/stats', icon: Milestone, exact: false, badge: false })
  list.push({ name: '搜尋', path: '/search', icon: Search, exact: false, badge: false })
  return list
})
const isActive = (item: { path: string; exact: boolean }) => item.exact ? route.path === item.path : route.path === item.path || route.path.startsWith(item.path + '/')
</script>

<template>
  <nav
    class="md:hidden fixed inset-x-0 bottom-0 z-40 flex border-t border-slate-200 bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
    aria-label="主選單"
    data-chrome="bottom"
    data-testid="mobile-tab-bar"
  >
    <RouterLink
      v-for="item in items"
      :key="item.name"
      :to="item.path"
      class="relative flex h-14 flex-1 flex-col items-center gap-0.5 text-[11px] font-bold transition-colors"
      :class="[isActive(item) ? 'text-blue-600' : 'text-slate-500', item.badge ? 'justify-end pb-1.5' : 'justify-center']"
      :aria-current="isActive(item) ? 'page' : undefined"
      :data-testid="item.badge ? 'mobile-tab-badge' : undefined"
    >
      <span
        v-if="item.badge"
        class="absolute left-1/2 top-[-20px] h-14 w-14 -translate-x-1/2 rounded-full bg-white p-[3px] shadow-lg shadow-slate-900/30 motion-safe:transition-[filter] motion-safe:duration-200"
        :class="isActive(item) ? '[filter:drop-shadow(0_0_6px_rgb(251_191_36/0.75))]' : ''"
        aria-hidden="true"
      >
        <svg viewBox="0 0 100 100" class="h-full w-full">
          <defs>
            <linearGradient id="tb-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a" /><stop offset="0.5" stop-color="#d4a017" /><stop offset="1" stop-color="#a16207" /></linearGradient>
            <linearGradient id="tb-red" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ef4444" /><stop offset="1" stop-color="#991b1b" /></linearGradient>
          </defs>
          <circle cx="50" cy="50" r="49" fill="url(#tb-gold)" />
          <circle cx="50" cy="50" r="45" fill="url(#tb-red)" />
          <circle cx="50" cy="50" r="38.5" fill="#fbbf24" />
          <circle cx="50" cy="50" r="37" fill="#0f2250" />
          <!-- 星點 -->
          <g fill="#fcd34d">
            <path d="M30 28 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6z" />
            <path d="M72 30 l1.2 3 3 1.2 -3 1.2 -1.2 3 -1.2 -3 -3 -1.2 3 -1.2z" />
            <path d="M26 58 l1 2.4 2.4 1 -2.4 1 -1 2.4 -1 -2.4 -2.4 -1 2.4 -1z" />
            <path d="M76 62 l1.2 3 3 1.2 -3 1.2 -1.2 3 -1.2 -3 -3 -1.2 3 -1.2z" />
            <circle cx="40" cy="22" r="1" /><circle cx="64" cy="20" r="1.2" /><circle cx="22" cy="44" r="1" /><circle cx="80" cy="46" r="1" />
          </g>
          <!-- 選票（投入中） -->
          <path d="M46 25 L60 21 L57.5 43 L45 47 Z" fill="#fff" />
          <path d="M46 25 L60 21 L59.6 25 L46.6 29 Z" fill="#e2e8f0" />
          <!-- 投票箱 -->
          <path d="M26 50 L50 41 L74 50 L50 59 Z" fill="#fcd34d" />
          <path d="M40 50 L54 45 L62 48 L48 53.5 Z" fill="#0f2250" />
          <path d="M26 50 L50 59 L50 82 L26 73 Z" fill="#b8860b" />
          <path d="M74 50 L50 59 L50 82 L74 73 Z" fill="#e0a82e" />
          <path d="M33 53.5 L41 56.5 L41 77 L33 74 Z" fill="#fff" />
          <path d="M59 56.5 L67 53.5 L67 74 L59 77 Z" fill="#fff" />
        </svg>
      </span>
      <component :is="item.icon" v-else :size="22" :stroke-width="isActive(item) ? 2.6 : 2" />
      <span>{{ item.name }}</span>
    </RouterLink>
  </nav>
</template>
