<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CalendarDays, ChevronRight, Vote } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import Hero from '../components/Hero.vue'
import Breadcrumbs from '../components/Breadcrumbs.vue'
import LoadError from '../components/LoadError.vue'
import { useSupabase } from '../composables/useSupabase'
import { usePageHead, PUBLISHER_LD, SITE_URL, type BreadcrumbItem } from '../composables/usePageHead'
import { daysUntil, splitElections, taipeiDay } from '../lib/election-list'
import { electionPath } from '../lib/election-regions'
import { POSITIONS, positionSpec } from '../lib/election-levels'
import type { Election } from '../types'

/**
 * 選舉一覽（#344 第一階段，2026-10-05）：正見收錄的每一場選舉，分「今後的選舉」與「過去的選舉」。
 * 日本站（政策の系譜）同一種入口；屆別變多（補選、罷免投票）以後頁尾不可能一場一場列。
 *
 * 預渲染（lib/ssg/server-data.ts 的 STATIC_CONTENT_ROUTES）＋網站地圖，canonical 指正見.tw。
 * 今後／過去依投票日切（lib/election-list.ts），不看 id：之後新增的選舉 id 不是年份。
 * 第一次渲染用資料快照的建置日（預渲染與 hydrate 一致），掛載後才換成今天。
 * 連結照舊是 /election/:id——三筆舊選舉的年份網址不變。
 */

const { elections, dataAsOf, loaded, error } = useSupabase()

const today = ref(taipeiDay(dataAsOf.value ?? Date.now()))
const mounted = ref(false)
onMounted(() => {
  today.value = taipeiDay(Date.now())
  mounted.value = true
})

const groups = computed(() => splitElections(elections.value, today.value))

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
function voteDayText(e: Election): string {
  const d = new Date(`${e.electionDate}T00:00:00Z`)
  return `${e.electionDate}（星期${WEEKDAYS[d.getUTCDay()]}）`
}

/** 職位標籤照選舉頁分層的順序（總統 → 村里長），不照資料庫回傳的順序 */
const POSITION_ORDER = new Map(POSITIONS.map((p, i) => [p.type as string, i]))
function typeLabels(e: Election): string[] {
  return [...(e.types ?? [])]
    .sort((a, b) => (POSITION_ORDER.get(a) ?? 99) - (POSITION_ORDER.get(b) ?? 99))
    .map((t) => positionSpec(t)?.label ?? t)
}

function countdownText(e: Election): string {
  const n = daysUntil(e.electionDate, today.value)
  return n === 0 ? '今天投票' : `還有 ${n} 天投票`
}

const breadcrumbs: BreadcrumbItem[] = [
  { name: '首頁', path: '/' },
  { name: '選舉一覽' },
]

usePageHead({
  title: '選舉一覽',
  description: () => {
    const names = [...groups.value.upcoming, ...groups.value.past].map((e) => e.shortName).join('、')
    return `正見收錄的每一場選舉，分今後與過去：${names}。點進去看各縣市候選人、政見與出處。`
  },
  breadcrumbs,
  jsonLd: () => ({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: '選舉一覽',
    url: `${SITE_URL}/elections`,
    publisher: PUBLISHER_LD,
    itemListElement: [...groups.value.upcoming, ...groups.value.past].map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: e.name,
      url: `${SITE_URL}${electionPath(e.id)}`,
    })),
  }),
})
</script>

<template>
  <LoadError v-if="error && elections.length === 0" />
  <div v-else class="bg-slate-50 min-h-screen pb-20">
    <Breadcrumbs :items="breadcrumbs" />
    <Hero>
      <template #title>選舉一覽</template>
      <template #description>
        正見收錄的每一場選舉。點進去看全台與各縣市的候選人、政見與出處；過去的選舉留著當選人與當時的競選承諾，之後可以對照兌現了沒。
      </template>
      <template #icon><Vote :size="400" class="text-blue-500" /></template>
    </Hero>

    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-left">
      <div v-if="elections.length === 0" class="text-slate-500 text-center py-20">
        {{ loaded ? '目前沒有收錄任何選舉' : '載入中…' }}
      </div>

      <template v-else>
        <section class="mb-12" aria-labelledby="upcoming-heading">
          <h2 id="upcoming-heading" class="text-2xl font-black text-navy-900 mb-4">今後的選舉</h2>
          <p v-if="groups.upcoming.length === 0" class="text-slate-500 bg-white rounded-xl shadow p-6">目前沒有已排定投票日的選舉。</p>
          <ul v-else class="space-y-4">
            <li v-for="e in groups.upcoming" :key="e.id">
              <RouterLink
                :to="electionPath(e.id)"
                class="group block bg-white rounded-xl shadow p-6 border-l-4 border-amber-500 hover:shadow-lg transition-shadow"
              >
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500 mb-2">
                  <span class="inline-flex items-center gap-1"><CalendarDays :size="16" class="text-amber-500" />投票日 {{ voteDayText(e) }}</span>
                  <span v-if="mounted" class="font-bold text-amber-600">{{ countdownText(e) }}</span>
                </div>
                <h3 class="text-xl font-black text-navy-900 group-hover:text-blue-700 flex items-center gap-1">
                  {{ e.shortName }}
                  <ChevronRight :size="20" class="text-slate-400 group-hover:text-blue-600 shrink-0" />
                </h3>
                <p class="text-sm text-slate-600 mt-1">{{ e.name }}</p>
                <ul v-if="typeLabels(e).length" class="flex flex-wrap gap-2 mt-3" aria-label="選舉的職位">
                  <li v-for="label in typeLabels(e)" :key="label" class="text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200 rounded-full px-2.5 py-0.5">{{ label }}</li>
                </ul>
              </RouterLink>
            </li>
          </ul>
        </section>

        <section aria-labelledby="past-heading">
          <h2 id="past-heading" class="text-2xl font-black text-navy-900 mb-4">過去的選舉</h2>
          <p v-if="groups.past.length === 0" class="text-slate-500 bg-white rounded-xl shadow p-6">還沒有投票結束的選舉。</p>
          <ul v-else class="space-y-4">
            <li v-for="e in groups.past" :key="e.id">
              <RouterLink
                :to="electionPath(e.id)"
                class="group block bg-white rounded-xl shadow p-6 border-l-4 border-slate-300 hover:shadow-lg transition-shadow"
              >
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500 mb-2">
                  <span class="inline-flex items-center gap-1"><CalendarDays :size="16" class="text-slate-400" />投票日 {{ voteDayText(e) }}</span>
                </div>
                <h3 class="text-xl font-black text-navy-900 group-hover:text-blue-700 flex items-center gap-1">
                  {{ e.shortName }}
                  <ChevronRight :size="20" class="text-slate-400 group-hover:text-blue-600 shrink-0" />
                </h3>
                <p class="text-sm text-slate-600 mt-1">{{ e.name }}</p>
                <ul v-if="typeLabels(e).length" class="flex flex-wrap gap-2 mt-3" aria-label="選舉的職位">
                  <li v-for="label in typeLabels(e)" :key="label" class="text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200 rounded-full px-2.5 py-0.5">{{ label }}</li>
                </ul>
              </RouterLink>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </div>
</template>
