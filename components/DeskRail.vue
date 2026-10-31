<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { House, TrendingUp, Milestone, Search } from 'lucide-vue-next'
import { electionPath } from '../lib/election-regions'
import { electionSegment } from '../lib/election-route'
import { sectionOfRoute, type DeskSection } from '../lib/desk-sections'
import { useSupabase } from '../composables/useSupabase'
import { useDeskNav } from '../composables/useDeskNav'

/**
 * 桌面版最左窄圖示欄（md 以上，固定全高）：站徽＋主選單五項（首頁／政見／選舉／參與／搜尋）＋最下面的「關於」。
 * 圖示在上、小字在下，目前所在的區塊變主色。沿用手機底部分頁列的項目與圖示；「選舉」沿用徽章風格但縮小。
 * 搜尋不換頁，開全站搜尋視窗（GlobalSearch，跟桌面版原本的搜尋鈕同一個）。
 */
const route = useRoute()
const { drawerOpen, closeDeskDrawer } = useDeskNav()
// 抽屜開著時：點別的區＝照常導覽、抽屜內容跟著換成那一區（不關）；點目前這一區的圖示＝關抽屜
function onPick(e: Event, key: string) { if (drawerOpen.value && current.value === key) { e.preventDefault(); closeDeskDrawer() } }
const { getActiveElection } = useSupabase()
const rawSection = computed<DeskSection | null>(() => sectionOfRoute(route.name))
// 首頁與「關於」合併成同一項（2026-10-31）：關於區的頁面也讓首頁那顆亮；首頁的延伸欄顯示關於那組
const current = computed<DeskSection | null>(() => (rawSection.value === 'about' ? 'home' : rawSection.value))
const electionTo = computed(() => {
  const e = getActiveElection()
  return e ? electionPath(electionSegment(e)) : '/elections'
})
const items = computed(() => [
  { key: 'home' as const, label: '首頁', to: '/', icon: House },
  { key: 'policy' as const, label: '政見', to: '/tracking', icon: TrendingUp },
  { key: 'election' as const, label: '選舉', to: electionTo.value, icon: null },
  { key: 'join' as const, label: '參與', to: '/stats', icon: Milestone },
])
const itemClass = (on: boolean) => ['group relative flex w-14 flex-col items-center gap-1 rounded-xl py-2 text-[11px] font-bold leading-none transition-colors', on ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:bg-slate-100 hover:text-navy-900']
</script>

<template>
  <nav class="flex h-full w-[72px] flex-col items-center border-r border-slate-200 bg-white py-3" aria-label="主選單" data-testid="desk-rail">
    <RouterLink to="/" class="mb-3 flex h-10 w-14 items-center justify-center" aria-label="正見 首頁">
      <img src="/brand/logo-zhengjian.png" srcset="/brand/logo-zhengjian.png 1x, /brand/logo-zhengjian@2x.png 2x" alt="正見" width="72" height="40" class="h-8 w-auto max-w-full object-contain" />
    </RouterLink>
    <div class="flex flex-col items-center gap-1">
      <RouterLink v-for="item in items" :key="item.key" :to="item.to" @click="onPick($event, item.key)" :class="itemClass(current === item.key)" :aria-current="current === item.key ? 'page' : undefined" :data-testid="`desk-rail-${item.key}`">
        <component :is="item.icon" v-if="item.icon" :size="22" :stroke-width="current === item.key ? 2.6 : 2" />
        <!-- 選舉徽章（縮小版）：同手機底部分頁列的金／紅／深藍，id 加 dr- 前綴避免和它撞名 -->
        <svg v-else viewBox="0 0 100 100" class="h-[26px] w-[26px] shrink-0" :class="current === 'election' ? '[filter:drop-shadow(0_0_4px_rgb(251_191_36/0.8))]' : ''" aria-hidden="true">
          <defs>
            <linearGradient id="dr-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a" /><stop offset="0.5" stop-color="#d4a017" /><stop offset="1" stop-color="#a16207" /></linearGradient>
            <linearGradient id="dr-red" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ef4444" /><stop offset="1" stop-color="#991b1b" /></linearGradient>
          </defs>
          <circle cx="50" cy="50" r="49" fill="url(#dr-gold)" />
          <circle cx="50" cy="50" r="45" fill="url(#dr-red)" />
          <circle cx="50" cy="50" r="38.5" fill="#fbbf24" />
          <circle cx="50" cy="50" r="37" fill="#0f2250" />
          <g fill="#fcd34d">
            <path d="M30 28 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6z" />
            <path d="M72 30 l1.2 3 3 1.2 -3 1.2 -1.2 3 -1.2 -3 -3 -1.2 3 -1.2z" />
            <circle cx="40" cy="22" r="1" /><circle cx="64" cy="20" r="1.2" />
          </g>
          <path d="M46 25 L60 21 L57.5 43 L45 47 Z" fill="#fff" />
          <path d="M26 50 L50 41 L74 50 L50 59 Z" fill="#fcd34d" />
          <path d="M40 50 L54 45 L62 48 L48 53.5 Z" fill="#0f2250" />
          <path d="M26 50 L50 59 L50 82 L26 73 Z" fill="#b8860b" />
          <path d="M74 50 L50 59 L50 82 L74 73 Z" fill="#e0a82e" />
        </svg>
        <span>{{ item.label }}</span>
      </RouterLink>
      <RouterLink to="/search" @click="onPick($event, 'search')" :class="itemClass(current === 'search')" :aria-current="current === 'search' ? 'page' : undefined" aria-label="搜尋人物與政見" data-testid="desk-rail-search">
        <Search :size="22" />
        <span>搜尋</span>
      </RouterLink>
    </div>
  </nav>
</template>
