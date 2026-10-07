<script setup lang="ts">
import { computed } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { Clock, Grid3x3, Layers, LayoutGrid, Megaphone, Scale } from 'lucide-vue-next'
import Hero from './Hero.vue'
import HeroAction from './HeroAction.vue'
import GlobalRegionSelector from './GlobalRegionSelector.vue'
import { VIEW_TABS, type ElectionViewMode } from '../lib/election-view-tabs'
import { electionYearOfDate } from '../lib/election-route'
import type { Election } from '../types'

/**
 * 選舉頁的頁首（標題、倒數、說明、檢視頁籤、縣市選擇器），選舉頁與政見矩陣頁共用，
 * 兩頁看起來是同一個地方的五個頁籤（維護者 2026-10-07）。
 * - view：目前頁籤；'matrix' 是政見矩陣頁
 * - viewLink：有給就把四個檢視頁籤做成連結（矩陣頁用，回選舉頁開那個檢視）；沒給就是按鈕，點了 emit select（選舉頁頁內切換）
 * - county／township：縣市頁、鄉鎮頁的標題；矩陣頁不給，就是全台的標題
 */
const props = defineProps<{
  election: Election
  electionSeg: string
  view: ElectionViewMode | 'matrix'
  hasMatrix: boolean
  region: string
  regionLink: (region: string) => RouteLocationRaw
  viewLink?: (view: ElectionViewMode) => RouteLocationRaw
  county?: string
  township?: string
}>()
defineEmits<{ select: [view: ElectionViewMode] }>()

const TAB_ICONS = { politicians: LayoutGrid, pledges: Megaphone, issues: Layers, comparison: Scale }

// 選舉年份、Hero 背景圖片（依選舉年份）
const electionYear = computed(() => electionYearOfDate(props.election.electionDate) ?? 0)
const heroImages: Record<number, string> = {
  2022: '/images/heroes/election-2022.png',
  2024: '/images/heroes/election-2024.png',
  2026: '/images/heroes/election-2026.png',
}
const heroBackgroundImage = computed(() => heroImages[electionYear.value] || '/images/heroes/election-default.png')

const timeLeft = computed(() => {
  const difference = +new Date(props.election.electionDate) - +new Date()
  return { days: difference > 0 ? Math.floor(difference / (1000 * 60 * 60 * 24)) : 0 }
})
</script>

<template>
  <Hero full-width :background-image="heroBackgroundImage">
    <template #title>
      <div class="relative w-full">
        <div v-if="county">
          {{ electionYear || election.electionDate.slice(0, 4) }} {{ county }}{{ township }}<br/><span class="text-amber-400">候選人與政見</span>
        </div>
        <div v-else>
          預見未來，<br/><span class="text-amber-400">從您居住的城市開始</span>
        </div>
        <div class="hidden md:block absolute right-0 top-1/2 -translate-y-1/2">
          <div class="bg-white/5 backdrop-blur-md border border-white/20 rounded-[32px] p-8 text-center transform rotate-2 hover:rotate-0 transition-all duration-500 shadow-2xl shadow-blue-500/10">
            <div class="text-sm text-slate-400 mb-2 flex items-center justify-center gap-2 font-medium">
              <Clock :size="18" class="text-amber-400" /> 距離投票日
            </div>
            <div class="text-7xl font-black text-white mb-1 font-mono tracking-tighter leading-none animate-pulse">
              <!-- 倒數天數依當下日期計算，建置時算的會過期，只在瀏覽器渲染 -->
              <ClientOnly>
                {{ timeLeft.days }}
                <template #placeholder>&nbsp;</template>
              </ClientOnly>
            </div>
            <div class="text-sm font-bold text-amber-400 uppercase tracking-[0.3em] pl-[0.3em]">
              Days Left
            </div>
          </div>
        </div>
      </div>
    </template>
    <template #description>不僅是縣市長，我們深入記錄議員、鄉鎮代表等基層候選人的競選承諾。</template>

    <!-- Hero Actions: View Mode Tabs -->
    <template #actions>
      <!-- 檢視切換一律走 HeroAction：尺寸與間距跟全站動作區一致；手機用兩字短標讓四顆擠進一排 -->
      <HeroAction
        v-for="v in VIEW_TABS" :key="v.key"
        :active="view === v.key"
        :to="viewLink ? viewLink(v.key) : undefined"
        @click="$emit('select', v.key)"
      >
        <component :is="TAB_ICONS[v.key]" :size="16" />
        <span class="sm:hidden">{{ v.short }}</span>
        <span class="hidden sm:inline">{{ v.label }}</span>
      </HeroAction>
      <!-- 政見矩陣（縣市×主題的政見筆數）：只有最新一屆定期選舉有，是另一個網址，不是頁內的檢視 -->
      <HeroAction v-if="hasMatrix" :to="`/election/${electionSeg}/matrix`" :active="view === 'matrix'">
        <Grid3x3 :size="16" />
        <span class="sm:hidden">矩陣</span>
        <span class="hidden sm:inline">政見矩陣</span>
      </HeroAction>
    </template>

    <!-- 縣市是真連結（/election/2026/台北市），點起來跟以前一樣切縣市，爬蟲也走得到 -->
    <GlobalRegionSelector :current="region" :link-for="regionLink" />
  </Hero>
</template>
