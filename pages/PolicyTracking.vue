<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useCheckpoints } from '../composables/useCheckpoints'
import { useSupabase } from '../composables/useSupabase'
import { useGlobalState } from '../composables/useGlobalState'
import { PolicyStatus } from '../types'
import PolicyCard from '../components/PolicyCard.vue'
import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import { Search, TrendingUp, Star } from 'lucide-vue-next'
import HeroAction from '../components/HeroAction.vue'
import PolicyViewNav from '../components/PolicyViewNav.vue'
import { usePageHead } from '../composables/usePageHead'
import { useRegionQuerySync, queryField } from '../composables/useRegionQuerySync'
import { policyMatchesRegion } from '../lib/policy-region'
import { dueDeadlinePolicies } from '../lib/policy-elements'
import { taipeiDay } from '../lib/election-list'
import { RouterLink } from 'vue-router'
import { CalendarClock } from 'lucide-vue-next'

const { policies, politicians, locations, categories, loading, ensurePolicies, getElectionById, dataAsOf } = useSupabase()
const { globalRegion } = useGlobalState()

const selectedLocation = ref(globalRegion.value)
const selectedCategory = ref('All')


// Sync with global state
watch(globalRegion, (newVal) => {
  selectedLocation.value = newVal
})

watch(selectedLocation, (newVal) => {
  // If user manually changes it here, we could update global state too
  // setGlobalRegion(newVal)
})

const searchTerm = ref('')
// 「我的關注」從網址進來（PolicyViewNav 指 /tracking?view=mine），不能只是本頁的 local 狀態，
// 不然從別頁點那顆按鈕會落到全部政見。
const view = ref<'all' | 'mine'>('all')
const showCheckpointsOnly = computed({
  get: () => view.value === 'mine',
  set: (v: boolean) => { view.value = v ? 'mine' : 'all' },
})

// 縣市（全站共用）與分類 ↔ 網址 ?region=&category=，區域資料頁的「進入 XX 追蹤頁」就是靠這個
useRegionQuerySync({ routeName: 'tracking', extra: {
  category: queryField(selectedCategory, 'All'),
  view: queryField(view, 'all', { allowed: ['all', 'mine'] as const }),
} })
// 我的關注改走 useCheckpoints（2026-09-17）
const { checkpoints } = useCheckpoints()



onMounted(() => {
  // 政見清單是按需載入的（257 KB，公民提問頁那類頁面不需要）。這一頁要整份。
  ensurePolicies()
})

onUnmounted(() => {
})

const filteredPolicies = computed(() => {
  return policies.value.filter(policy => {
    const matchesLocation = policyMatchesRegion(policy, politicians.value, selectedLocation.value)
    const matchesCategory = selectedCategory.value === 'All' || policy.category === selectedCategory.value
    const matchesSearch = policy.title.toLowerCase().includes(searchTerm.value.toLowerCase()) ||
                         policy.description.toLowerCase().includes(searchTerm.value.toLowerCase())
    const matchesCheckpoints = !showCheckpointsOnly.value || checkpoints.value.includes(policy.id)
    const isNotCampaign = policy.status !== PolicyStatus.CAMPAIGN
    return matchesLocation && matchesCategory && matchesSearch && matchesCheckpoints && isNotCampaign
  })
})

/**
 * 期限已到的政見（2026-10-05 #364）：原文寫的達成期限已經過了、還沒標達成或跳票、期限之後也沒有進度紀錄。
 * 條件跟派工臂 deadline_due 同一套（lib/policy-elements.ts 的 deadlineDue）——這些會派給 AI 代理去查做到沒有。
 * 只看縣市篩選（跟這一頁的縣市選擇一致），不看分類與關鍵字：這是一份待查清單，不是搜尋結果。
 * 「今天」第一次渲染用資料快照的建置日（預渲染與 hydrate 一致），掛載後才換成今天（同選舉一覽頁的做法）。
 */
const today = ref(taipeiDay(dataAsOf.value ?? Date.now()))
onMounted(() => { today.value = taipeiDay(Date.now()) })
const politicianById = computed(() => new Map(politicians.value.map(p => [String(p.id), p])))
const duePolicies = computed(() => dueDeadlinePolicies(
  policies.value.filter(p => policyMatchesRegion(p, politicians.value, selectedLocation.value)),
  {
    today: today.value,
    electionDateOf: (p) => (p.electionId != null ? getElectionById(p.electionId)?.electionDate : undefined),
    electionResultOf: (p) => politicianById.value.get(String(p.politicianId))?.elections?.find(e => e.electionId === p.electionId)?.electionResult,
  },
))
const STATUS_TEXT: Record<string, string> = {
  'Campaign Pledge': '競選承諾', Proposed: '已提出', 'In Progress': '推動中', Stalled: '滯後',
}

// 以下兩個要放在 filteredPolicies 之後：watch 會立即求值一次來源，
// 擺在前面會讀到還沒初始化的 const（暫時死區），整個 setup 拋 ReferenceError、
// 畫面全白。vue-tsc 與 SSG 建置都不會紅，只有在瀏覽器裡才看得到。
// 資料還在路上：沒有這個判斷，使用者會先看到「沒有找到符合條件的政見」再突然跳出資料，
// 看起來像壞掉。政見是跟著首屏一起載的，所以只在真的還沒有政見時才顯示骨架。
const stillLoading = computed(() => loading.value && policies.value.length === 0)

// 篩得出來、卻因為找不到所屬政治人物而渲染不了的筆數。
// 正常應該是 0（fetchAll 會把有政見的人物一起載進來）；不是 0 就要讓使用者知道，
// 不要安靜地少幾張卡片。
const unrenderablePolicies = computed(() =>
  filteredPolicies.value.filter(policy => !politicians.value.find(c => c.id === policy.politicianId))
)
// 畫面上只說「有幾筆顯示不出來」；要 debug 的人才需要 id，那進 devtools
watch(unrenderablePolicies, (list) => {
  if (list.length > 0) {
    console.info('[政見追蹤] 找不到所屬政治人物的政見：', list.map(p => ({ policyId: p.id, politicianId: p.politicianId })))
  }
})

usePageHead({
  title: '政見追蹤',
  description: '持續追蹤全台各縣市首長與民意代表的政見執行進度，依縣市、分類、關鍵字篩選，透過時間軸確認每一項治理承諾都在正確的軌道上。',
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero background-image="/images/heroes/policy-tracking.png">
      <template #title>政見</template>
      <template #description>我們持續追蹤全台各縣市首長與民意代表的政見執行進度。<br />透過數據與時間軸，確保每一項治理承諾都在正確的軌道上。</template>
      <template #icon><TrendingUp :size="400" class="text-blue-500" /></template>

      <!-- Hero Actions: 頁籤 -->
      <template #actions>
        <PolicyViewNav :current="showCheckpointsOnly ? 'mine' : 'list'" />
      </template>

      <GlobalRegionSelector />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <!-- 搜尋 -->
      <div class="mb-6">
        <div class="relative max-w-xl">
          <Search class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" :size="20" />
          <input
            v-model="searchTerm"
            type="text"
            placeholder="搜尋關鍵字（如：長照、捷運、產業園區）..."
            class="w-full pl-12 pr-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-navy-900 font-medium placeholder:text-slate-400 shadow-sm"
          />
        </div>
      </div>

      <!-- 分類篩選：手機版用下拉選單。18 個分類攤開會佔掉整個首屏，
           使用者得捲過一整面按鈕才看得到第一張政見卡。 -->
      <div class="sm:hidden mb-6">
        <label class="sr-only" for="category-select">政見分類</label>
        <select
          id="category-select"
          v-model="selectedCategory"
          class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-navy-900 font-bold shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="All">全部分類</option>
          <option v-for="cat in categories" :key="cat" :value="cat">{{ cat }}</option>
        </select>
      </div>

      <div class="hidden sm:flex gap-4 w-full bg-slate-100 p-2 rounded-xl mb-8">
        <!-- Left: 全部 -->
        <div class="shrink-0 flex items-center gap-3">
          <button
            @click="selectedCategory = 'All'"
            :class="[
              'px-3 py-1.5 rounded-lg text-sm font-bold transition-all',
              selectedCategory === 'All'
                ? 'bg-white text-navy-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'
            ]"
          >
            全部
          </button>
          <div class="w-px h-6 bg-slate-300"></div>
        </div>
        <!-- Right: Wrap -->
        <div class="flex-grow flex flex-wrap items-center gap-2">
          <button
            v-for="cat in categories"
            :key="cat"
            @click="selectedCategory = cat"
            :class="[
              'px-3 py-1.5 rounded-lg text-sm font-bold transition-all',
              selectedCategory === cat
                ? 'bg-white text-navy-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'
            ]"
          >
            {{ cat }}
          </button>
        </div>
      </div>
      <div v-if="showCheckpointsOnly && filteredPolicies.length > 0" class="mb-12 flex items-center gap-3 text-amber-600 font-bold bg-amber-50 p-4 rounded-2xl border border-amber-100 animate-fade-in">
        <Star :size="20" fill="currentColor" />
        <span>您正在查看我的關注（共 {{ filteredPolicies.length }} 項）</span>
      </div>

      <!-- 期限已到的政見（#364）：一張待查清單，表格裡的政見與人物都是真連結 -->
      <section v-if="!showCheckpointsOnly" class="mb-10 bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6 text-left" data-testid="due-policies">
        <h2 class="text-lg font-bold text-navy-900 flex items-center gap-2">
          <CalendarClock :size="20" class="text-amber-600" />期限已到的政見
          <span class="text-sm font-medium text-slate-500">（{{ duePolicies.length }}）</span>
        </h2>
        <p v-if="duePolicies.length === 0" class="mt-4 text-sm text-slate-400">目前沒有期限已到、還沒有後續的政見。</p>
        <div v-else class="mt-4 overflow-x-auto -mx-5 px-5 sm:mx-0 sm:px-0">
          <table class="w-full min-w-[36rem] text-sm text-left border-collapse">
            <thead>
              <tr class="text-xs text-slate-500">
                <th scope="col" class="py-2 pr-3 border-b border-slate-200 font-bold">政見</th>
                <th scope="col" class="py-2 pr-3 border-b border-slate-200 font-bold">提出者</th>
                <th scope="col" class="py-2 pr-3 border-b border-slate-200 font-bold">原文寫的期限</th>
                <th scope="col" class="py-2 border-b border-slate-200 font-bold">目前狀態</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in duePolicies" :key="d.policy.id" class="align-top">
                <td class="py-2 pr-3 border-b border-slate-100"><RouterLink :to="`/policy/${d.policy.id}`" class="font-bold text-navy-900 hover:text-blue-700 hover:underline">{{ d.policy.title }}</RouterLink></td>
                <td class="py-2 pr-3 border-b border-slate-100 whitespace-nowrap">
                  <RouterLink v-if="politicianById.get(String(d.policy.politicianId))" :to="`/politician/${d.policy.politicianId}`" class="text-blue-700 hover:underline">{{ politicianById.get(String(d.policy.politicianId))!.name }}</RouterLink>
                </td>
                <td class="py-2 pr-3 border-b border-slate-100">
                  <span class="text-slate-800">{{ d.deadlineText }}</span>
                  <span class="block text-xs text-slate-500">{{ d.deadlineDate }}，已過 {{ d.daysOver }} 天</span>
                </td>
                <td class="py-2 border-b border-slate-100 whitespace-nowrap text-slate-600">{{ STATUS_TEXT[d.policy.status] ?? d.policy.status }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div v-if="unrenderablePolicies.length > 0" class="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3 text-sm">
        有 {{ unrenderablePolicies.length }} 筆政見暫時顯示不出來，重新整理通常就會出現。
      </div>

      <div v-if="stillLoading" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        <div v-for="n in 6" :key="n" class="bg-white rounded-3xl border border-slate-200 p-6 animate-pulse">
          <div class="h-4 w-24 bg-slate-200 rounded mb-4"></div>
          <div class="h-5 w-full bg-slate-200 rounded mb-2"></div>
          <div class="h-5 w-2/3 bg-slate-200 rounded mb-6"></div>
          <div class="h-3 w-full bg-slate-100 rounded mb-2"></div>
          <div class="h-3 w-5/6 bg-slate-100 rounded"></div>
        </div>
      </div>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 text-left">
        <template v-if="filteredPolicies.length > 0">
          <template v-for="policy in filteredPolicies" :key="policy.id">
            <PolicyCard
              v-if="politicians.find(c => c.id === policy.politicianId)"
              :policy="policy"
              :politician="politicians.find(c => c.id === policy.politicianId)!"
            />
          </template>
        </template>
        <div v-else class="col-span-full text-center py-32 text-slate-400 bg-white rounded-3xl border border-dashed border-slate-300">
          <template v-if="showCheckpointsOnly">
            <Star :size="48" class="mx-auto mb-4 opacity-20" />
            <p class="font-bold">你還沒有關注任何政見。按政見旁的⭐就會加進來。</p>
            <button @click="showCheckpointsOnly = false" class="mt-4 text-blue-600 font-bold hover:underline">瀏覽全部政見</button>
          </template>
          <template v-else>
            <Search :size="48" class="mx-auto mb-4 opacity-20" />
            <p class="font-bold">沒有找到符合條件的政見。</p>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
