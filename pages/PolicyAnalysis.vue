<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import Avatar from '../components/Avatar.vue'
import { Search, Waypoints, ArrowRight, Activity } from 'lucide-vue-next'
import PolicyViewNav from '../components/PolicyViewNav.vue'
import { usePageHead } from '../composables/usePageHead'
import { useRegionQuerySync, queryField } from '../composables/useRegionQuerySync'
import { useGlobalState } from '../composables/useGlobalState'
import { policyMatchesRegion } from '../lib/policy-region'
import { policyYear } from '../lib/policy-date'
import { isProgressCase } from '../lib/policy-chain'
import { filterLineages, LEVEL_LABEL, LINEAGE_NAME, lineageCounts, lineagePath, lineagePlace } from '../lib/lineage'

/**
 * /analysis：政策脈絡一覽（#349，2026-10-06；原本叫「市政接力」，網址不變）。
 * 上半是政策脈絡（一件事在某一層級、某一地方的來龍去脈，點進 /lineage/:id）；
 * 下半保留原本的「進度過半的政見」卡片，連到 /analysis/:policyId——那些網址已經被收錄，要繼續有站內連結。
 */
const { policies, politicians, categories, elections, ensurePolicies, lineages, ensureLineages } = useSupabase()
const { globalRegion } = useGlobalState()
const searchTerm = ref('')
const selectedCategory = ref('All')

// 縣市（全站共用，本頁只影響選擇器顯示）與分類 ↔ 網址 ?region=&category=
useRegionQuerySync({ routeName: 'analysis', extra: { category: queryField(selectedCategory, 'All') } })

/** 脈絡：中央層級的在每個縣市都列（全國的事每個縣市都受影響）；照層級（中央 → 縣市 → 鄉鎮）、地方、標題排 */
const LEVEL_ORDER = { national: 0, county: 1, township: 2 } as const
const lineageList = computed(() =>
  filterLineages(lineages.value, { region: globalRegion.value, category: selectedCategory.value, q: searchTerm.value })
    .slice()
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
      || (a.region ?? '').localeCompare(b.region ?? '', 'zh-Hant-TW')
      || a.title.localeCompare(b.title, 'zh-Hant-TW')))

// 縣市過濾：與政見追蹤頁同一套判斷（政見所屬政治人物的 region）；選了縣市而 0 筆就顯示空狀態
const regionPolicies = computed(() =>
  policies.value.filter(policy => policyMatchesRegion(policy, politicians.value, globalRegion.value))
)

/**
 * 進度過半的政見（原本的「市政接力」卡片）：每一張卡一條政見——不是競選承諾、進度過半（lib/policy-chain.ts 的 isProgressCase，
 * lib/ssg/page-data.ts 的 analysisListedPolicyIds 用同一支，預渲染的 /analysis/:policyId 就是這些）。
 * #349 第二階段 A 拿掉了原本沿 related_policies 把接力鏈併成一張卡的那一支（那張表線上 0 列）；同一件事的關聯看上面的政策脈絡。
 */
const progressCases = computed(() => {
  let result = regionPolicies.value.filter(isProgressCase).map(policy => ({
    id: `case-${policy.id}`, targetId: policy.id, title: policy.title, category: policy.category, description: policy.description,
    politicianIds: [policy.politicianId], startYear: policyYear(policy, elections.value), progress: policy.progress,
  }))
  if (selectedCategory.value !== 'All') result = result.filter(c => c.category === selectedCategory.value)
  if (searchTerm.value.trim()) result = result.filter(c => c.title.toLowerCase().includes(searchTerm.value.toLowerCase()))
  return result
})

usePageHead({
  title: LINEAGE_NAME,
  description: '政策脈絡：一件事在某一層級、某一地方的來龍去脈。',
})
// 政見清單與脈絡都是按需載入的；這一頁兩份都要整份
onMounted(() => { ensurePolicies(); ensureLineages() })
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20 text-left">
    <Hero background-image="/images/heroes/ai.png">
      <template #title>{{ LINEAGE_NAME }}</template>
      <template #icon><Waypoints :size="400" class="text-blue-500" /></template>

      <template #actions>
        <PolicyViewNav current="relay" />
      </template>

      <GlobalRegionSelector />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <!-- 搜尋框 -->
      <div class="mb-6">
        <div class="relative max-w-xl">
          <Search class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" :size="20" />
          <input
            v-model="searchTerm"
            type="text"
            placeholder="搜尋政策脈絡或政見（如：捷運、社會住宅）..."
            class="w-full pl-12 pr-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-navy-900 font-medium placeholder:text-slate-400 shadow-sm"
          />
        </div>
      </div>

      <!-- 分類篩選：手機版用下拉選單（同 PolicyTracking，18 個分類攤開會佔掉整個首屏） -->
      <div class="sm:hidden mb-6">
        <label class="sr-only" for="analysis-category-select">政見分類</label>
        <select
          id="analysis-category-select"
          v-model="selectedCategory"
          class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-navy-900 font-bold shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="All">全部分類</option>
          <option v-for="cat in categories" :key="cat" :value="cat">{{ cat }}</option>
        </select>
      </div>

      <div class="hidden sm:flex gap-4 w-full bg-slate-100 p-2 rounded-xl mb-8">
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

      <!-- 政策脈絡 -->
      <section class="mb-14" data-testid="lineage-list">
        <h2 class="text-2xl font-black text-navy-900 mb-6 flex items-center gap-2"><Waypoints class="text-blue-600" :size="24" />{{ LINEAGE_NAME }}<span class="text-base font-bold text-slate-400">{{ lineageList.length }} 條</span></h2>
        <div v-if="lineageList.length === 0" class="text-center py-16 px-6 text-slate-500 bg-white rounded-2xl border border-dashed border-slate-300">
          <Waypoints :size="40" class="mx-auto mb-3 opacity-30" />
          <p class="font-bold text-slate-600">還沒有脈絡。</p>
        </div>
        <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <router-link
            v-for="l in lineageList"
            :key="l.id"
            :to="lineagePath(l.id)"
            class="group bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-lg hover:border-blue-400 transition-all p-6 flex flex-col"
            data-testid="lineage-card"
          >
            <span class="text-xs font-bold text-blue-700 mb-2">{{ LEVEL_LABEL[l.level] }}・{{ lineagePlace(l) }}<template v-if="l.category">・{{ l.category }}</template></span>
            <span class="text-xl font-black text-navy-900 group-hover:text-blue-700 leading-snug break-words">{{ l.title }}</span>
            <span v-if="l.summary" class="text-sm text-slate-600 mt-2 line-clamp-2">{{ l.summary }}</span>
            <span class="mt-4 pt-4 border-t border-slate-100 text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
              <span>政見 {{ lineageCounts(l).policies }} 條</span>
              <span>參與者 {{ lineageCounts(l).people }} 位</span>
              <span>交接 {{ lineageCounts(l).handovers }} 筆</span>
              <span>上下級 {{ lineageCounts(l).links }} 條</span>
            </span>
          </router-link>
        </div>
      </section>

      <!-- 進度過半的政見（原本的卡片，連到 /analysis/:policyId，網址照舊） -->
      <section data-testid="progress-cases">
        <h2 class="text-2xl font-black text-navy-900 mb-6 flex items-center gap-2"><Activity class="text-emerald-600" :size="24" />進度過半的政見</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div v-if="progressCases.length === 0" class="col-span-full text-center py-16 text-slate-400 bg-white rounded-2xl border border-dashed border-slate-300">
            <Search :size="40" class="mx-auto mb-3 opacity-20" />
            <p class="font-bold">沒有找到符合條件的政見。</p>
            <p class="text-sm mt-1">試試其他縣市或分類。</p>
          </div>
          <router-link
            v-for="c in progressCases"
            :key="c.id"
            :to="`/analysis/${c.targetId}`"
            class="group bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-lg hover:border-blue-400 transition-all p-6 flex flex-col"
          >
            <span class="text-xs font-bold text-slate-500 mb-2">{{ c.category }}<template v-if="c.startYear">・{{ c.startYear }} 起</template></span>
            <span class="text-xl font-black text-navy-900 group-hover:text-blue-700 leading-snug break-words">{{ c.title }}</span>
            <span class="text-sm text-slate-600 mt-2 line-clamp-2">{{ c.description }}</span>
            <span class="mt-4 h-2 w-full bg-slate-100 rounded-full overflow-hidden block">
              <span class="block h-full bg-blue-600 rounded-full" :style="{ width: `${c.progress}%` }"></span>
            </span>
            <span class="mt-4 pt-4 border-t border-slate-100 flex items-center justify-between">
              <span class="flex -space-x-2">
                <Avatar
                  v-for="pid in c.politicianIds"
                  :key="pid"
                  :src="politicians.find(pol => pol.id === pid)?.avatarUrl"
                  :name="politicians.find(pol => pol.id === pid)?.name || ''"
                  size="sm"
                  class="border-2 border-white"
                />
              </span>
              <span class="text-sm font-bold text-blue-700 inline-flex items-center gap-1">看深度分析 <ArrowRight :size="16" /></span>
            </span>
          </router-link>
        </div>
      </section>
    </div>
  </div>
</template>
