<script setup lang="ts">
/**
 * 政策脈絡完整關係圖（#675 第四期，/lineage/:lineageId/graph）：泳道時間線——職位×地方一條泳道，畫任期條、政見點、立場、交接、事件與推動者箭頭。
 * 只在瀏覽器端畫（沒有伺服器端渲染、不預渲染、不進網站地圖），noindex、canonical 指主頁；資料掛載後才撈。
 * 排版全在 lib/lineage-graph.ts（純函式）；手機（≤ 640 px）不畫 SVG，改直式時間軸，吃同一份輸出。字全取自 lib/lineage-page-labels.ts。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ChevronLeft, Loader2 } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'
import { useLineageTerms } from '../composables/useLineageTerms'
import { usePageHead } from '../composables/usePageHead'
import LoadError from '../components/LoadError.vue'
import LineageGraphSvg from '../components/LineageGraphSvg.vue'
import LineageGraphList from '../components/LineageGraphList.vue'
import LineageGraphDrawer from '../components/LineageGraphDrawer.vue'
import { LINEAGE_NAME, lineagePath } from '../lib/lineage'
import { lineagePeople } from '../lib/lineage-page'
import { buildGraph } from '../lib/lineage-graph'
import { PAGE_LABELS as T } from '../lib/lineage-page-labels'
import { taipeiToday } from '../lib/policy-stage'
import type { Policy } from '../types'

const route = useRoute()
const { lineages, policies, politicians, elections, loading, error, loadLineageById, loadPoliciesByLineage, loadPoliticiansByIds } = useSupabase()
const { terms, failed: termsFailed, loadTerms } = useLineageTerms()

const lineageId = computed(() => String(route.params.lineageId ?? ''))
const lineage = computed(() => lineages.value.find((l) => l.id === lineageId.value))
const mounted = ref(false)
const lineageLoading = ref(false)
const restLoading = ref(false)
const selectedId = ref<string | null>(null)
const expandLanes = ref(false)
const expandOld = ref(false)
const isMobile = ref(false)
const today = taipeiToday()

// 掛載後才撈（這一頁不做伺服器端渲染）：先脈絡，再政見、任期、涉及的人；失敗由 useSupabase 的 error 與 <LoadError> 接住，不顯示成「找不到」
watch([mounted, lineageId], async ([ready, id]) => {
  if (!ready || !id || lineage.value) return
  lineageLoading.value = true
  try { await loadLineageById(id) } finally { lineageLoading.value = false }
}, { immediate: true })

const lineagePolicies = computed<Policy[]>(() => {
  const l = lineage.value
  if (!l) return []
  const byId = new Map(policies.value.map((p) => [String(p.id), p]))
  return l.policyIds.map((id) => byId.get(id)).filter((p): p is Policy => !!p)
})

watch([mounted, lineage], async ([ready, l]) => {
  if (!ready || !l) return
  restLoading.value = true
  try {
    await Promise.all([loadPoliciesByLineage(l.id), loadTerms(l.id)])
    await loadPoliticiansByIds(lineagePeople(l, lineagePolicies.value))
  } finally { restLoading.value = false }
}, { immediate: true })

const personName = computed(() => new Map([
  ...terms.value.map((t) => [t.politicianId, t.name] as const),
  ...politicians.value.map((p) => [String(p.id), p.name] as const),
]))
const electionDates = computed(() => new Map(elections.value.map((e) => [e.id, e.electionDate])))
/** 還沒開票的下一場選舉的投票日（今天或之後最近的一場） */
const upcomingElectionDate = computed(() => elections.value.map((e) => e.electionDate).filter((d) => !!d && d >= today).sort()[0] ?? null)

const model = computed(() => (lineage.value
  ? buildGraph({
    lineage: lineage.value, policies: lineagePolicies.value, terms: terms.value, electionDates: electionDates.value,
    nameOf: (id) => personName.value.get(id), today, upcomingElectionDate: upcomingElectionDate.value, expandLanes: expandLanes.value, expandOld: expandOld.value,
  })
  : null))
const selected = computed(() => model.value?.items.find((i) => i.id === selectedId.value) ?? null)

let mq: MediaQueryList | null = null
const onMq = (e: MediaQueryListEvent | MediaQueryList): void => { isMobile.value = e.matches }
onMounted(() => {
  mounted.value = true
  mq = window.matchMedia('(max-width: 640px)')
  onMq(mq)
  mq.addEventListener('change', onMq)
})
onBeforeUnmount(() => mq?.removeEventListener('change', onMq))

// 不收錄：noindex，canonical 與 og:url 指主頁（lib/page-url.ts）；沒有伺服器端 og 標籤，分享預覽是站名通用的
usePageHead({
  title: () => (lineage.value ? `${lineage.value.title}｜${T.graph}｜${LINEAGE_NAME}` : `${T.graph}｜${LINEAGE_NAME}`),
  description: () => (lineage.value ? `${lineage.value.title}：${T.graph}` : T.graph),
  type: 'article',
  noindex: true,
  canonical: () => lineagePath(lineageId.value),
})
</script>

<template>
  <div v-if="lineage && model && !error" class="bg-slate-50 min-h-screen" data-testid="lineage-graph-page">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <RouterLink :to="lineagePath(lineage.id)" class="inline-flex items-center gap-1 text-sm font-bold text-blue-700 hover:underline" data-testid="lineage-graph-back">
        <ChevronLeft :size="16" />{{ T.graphBack }}
      </RouterLink>
      <h1 class="mt-2 mb-4 text-2xl font-black text-navy-900 break-words">{{ lineage.title }}<span class="ml-3 text-base font-bold text-slate-500">{{ T.graph }}</span></h1>

      <LoadError v-if="termsFailed" inline :message="T.graphLoadFailed" @retry="loadTerms(lineage.id)" />
      <div v-else-if="restLoading" class="flex items-center gap-2 text-sm text-slate-500 py-6"><Loader2 :size="18" class="animate-spin" />{{ T.loading }}</div>
      <p v-else-if="model.empty" class="text-sm text-slate-500">{{ T.chronicleEmpty }}</p>
      <template v-else>
        <div v-if="!isMobile && (model.foldedLanes > 0 || expandLanes || model.collapsed.stances + model.collapsed.events > 0 || expandOld)" class="flex flex-wrap gap-2 mb-3 text-sm">
          <button v-if="model.foldedLanes > 0 || expandLanes" type="button" class="px-3 py-1 rounded-full border border-slate-300 bg-white font-bold text-slate-700" data-testid="lineage-graph-fold" @click="expandLanes = !expandLanes">
            <template v-if="expandLanes">{{ T.collapse }}</template><template v-else>{{ T.coverageMore }} {{ model.foldedLanes }} {{ T.foldedSuffix }}　{{ T.expand }}</template>
          </button>
          <button v-if="model.collapsed.stances + model.collapsed.events > 0 || expandOld" type="button" class="px-3 py-1 rounded-full border border-slate-300 bg-white font-bold text-slate-700" data-testid="lineage-graph-older" @click="expandOld = !expandOld">
            <template v-if="expandOld">{{ T.hideOlder }}</template><template v-else>{{ T.showOlder }} {{ model.collapsed.stances + model.collapsed.events }}</template>
          </button>
        </div>

        <LineageGraphList v-if="isMobile" :items="model.items" variant="main" :selected-id="selectedId" @select="selectedId = $event" />
        <template v-else>
          <ul class="flex flex-wrap gap-x-4 gap-y-1 mb-2 text-xs text-slate-600" data-testid="lineage-graph-legend">
            <li class="inline-flex items-center gap-1"><span class="inline-block w-4 h-3 rounded-sm bg-blue-500"></span>{{ T.termCurrent }}</li>
            <li class="inline-flex items-center gap-1"><span class="inline-block w-4 h-3 rounded-sm bg-slate-300"></span>{{ T.termPast }}</li>
            <li class="inline-flex items-center gap-1"><span class="inline-block w-4 h-3 rounded-sm border border-dashed border-slate-500"></span>{{ T.termNext }}</li>
          </ul>
          <LineageGraphSvg :model="model" :selected-id="selectedId" @select="selectedId = $event" />
          <LineageGraphList :items="model.items" variant="a11y" :selected-id="selectedId" @select="selectedId = $event" />
        </template>

        <p v-if="model.participantNames.length > 0" class="mt-4 text-sm text-slate-600 break-words" data-testid="lineage-graph-participants">
          <span class="font-bold">{{ T.participantsLine }}</span>　{{ model.participantNames.join('、') }}
        </p>
      </template>
    </div>
    <LineageGraphDrawer :item="selected" @close="selectedId = null" />
  </div>

  <div v-else-if="loading || lineageLoading || !mounted" class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Loader2 :size="48" class="mx-auto mb-4 text-blue-500 animate-spin" />
      <p class="text-slate-500">{{ T.loading }}</p>
    </div>
  </div>

  <LoadError v-else-if="error" />

  <div v-else class="min-h-screen flex items-center justify-center bg-slate-50">
    <div class="text-center px-4">
      <h2 class="text-2xl font-bold text-navy-900 mb-6">{{ T.notFound }}</h2>
      <RouterLink to="/analysis" class="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all">{{ T.allLineages }}</RouterLink>
    </div>
  </div>
</template>
