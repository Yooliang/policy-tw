<script setup lang="ts">
/**
 * 政黨分流圖（/parties/flow，policy-ops#193）：某一屆中選會名單的人數，依可開關、可排序的維度連成桑基圖。
 * 資料是資料庫 party_flow_rows(屆別)（只有聚合人數，換屆才重抓、同一屆留在記憶體）；純函式在 lib/party-flow.ts。
 * 預設只畫政黨 → 縣市，點縣市展開鄉鎮。政黨照名稱筆畫排、不依人數、不併其他，放不下就橫向捲動。客戶端渲染、noindex。
 * 網址：?election=2024（預設 2026 不寫）、?type=…（選舉別，type=all 是全部）、?party=…、?dims=party,county,age（預設不寫）、?open=台北市,…（展開的縣市）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Flag } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import SankeyChart from '../components/contributions/SankeyChart.vue'
import FlowDimOrder from '../components/contributions/FlowDimOrder.vue'
import LoadError from '../components/LoadError.vue'
import { usePageHead } from '../composables/usePageHead'
import { usePaneActive } from '../composables/usePane'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import {
  availableDims, buildPartyFlow, countyOrder, defaultTypesFor, ELECTIONS, filterRows, FLOW_DIMS, MIN_DIMS, normalizeDims,
  parseQuery, parseRows, partyOrder, resolveTypes, toggle, toQuery, typeOrder, type PartyFlowRow,
} from '../lib/party-flow'

const route = useRoute()
const router = useRouter()
const paneActive = usePaneActive()

// 同一屆只抓一次（模組層快取，離開頁面再回來也還在）
const cache = (globalThis as { __partyFlowRows?: Map<number, PartyFlowRow[]> }).__partyFlowRows ??= new Map()

const rows = ref<PartyFlowRow[]>([])
const loading = ref(true)
const failed = ref(false)

const allParties = computed(() => partyOrder(rows.value))
const allCounties = computed(() => countyOrder(rows.value))
const allTypes = computed(() => typeOrder(rows.value))
const dimPool = computed(() => availableDims(rows.value))

// 資料還沒回來時先照網址原樣收下，載入後再丟掉不認得的值
const initial = parseQuery(route.query as Record<string, unknown>)
const election = ref<number>(initial.election)
const requestedTypes = ref<string[] | null>(initial.types)
const parties = ref<string[]>(initial.parties)
const open = ref<string[]>(initial.open)
const dims = ref<string[]>(initial.dims)

const types = computed(() => resolveTypes(rows.value, requestedTypes.value))

async function load() {
  const id = election.value
  failed.value = false
  const hit = cache.get(id)
  if (hit) {
    rows.value = hit
  } else {
    loading.value = true
    try {
      const { data } = await withTimeoutAndRetry(`政黨分流圖 ${id}`, (signal) =>
        supabasePublic.rpc('party_flow_rows', { p_election_id: id }).abortSignal(signal).throwOnError())
      const parsed = parseRows(data)
      cache.set(id, parsed)
      if (election.value !== id) return // 載入途中已換屆，那一屆自己會載
      rows.value = parsed
    } catch {
      if (election.value === id) { failed.value = true; loading.value = false }
      return
    }
  }
  loading.value = false
  // 換屆或載入後丟掉這一屆沒有的值（選舉別全丟光就回到該屆預設）
  const known = { types: allTypes.value, parties: allParties.value, counties: allCounties.value, dims: dimPool.value.map((d) => d.id) }
  const q = parseQuery({ party: parties.value.join(','), open: open.value.join(','), dims: dims.value.join(',') }, known)
  parties.value = q.parties; open.value = q.open; dims.value = q.dims
  if (requestedTypes.value !== null && requestedTypes.value.length) {
    const kept = requestedTypes.value.filter((t) => allTypes.value.includes(t))
    requestedTypes.value = kept.length ? kept : null
  }
}
onMounted(load)
watch(election, load)

function syncQuery() {
  if (!paneActive.value) return
  const { election: _e, type: _t, party: _p, open: _o, dims: _d, ...rest } = route.query
  router.replace({ query: { ...rest, ...toQuery({ election: election.value, types: requestedTypes.value, parties: parties.value, open: open.value, dims: dims.value }, defaultTypesFor(rows.value)) } })
}
watch([election, requestedTypes, parties, open, dims], syncQuery)

const filtered = computed(() => filterRows(rows.value, { types: types.value, parties: parties.value }))
const graph = computed(() => buildPartyFlow(filtered.value, dims.value, open.value))
const hasCounty = computed(() => dims.value.includes('county'))

// 每欄節點數最多的那一欄決定高度，每個節點留 24 單位
const minSpan = computed(() => {
  const per = new Map<number, number>()
  for (const n of graph.value.nodes) per.set(n.col ?? 0, (per.get(n.col ?? 0) ?? 0) + 1)
  return Math.max(0, ...per.values()) * 24 + 12
})

const onPick = (id: string) => {
  if (id.startsWith('county:')) open.value = toggle(open.value, id.slice('county:'.length))
}
const setDims = (v: string[]) => { dims.value = normalizeDims(v, dimPool.value.map((d) => d.id)) }
const setTypes = (v: string[]) => { requestedTypes.value = v }
const nodeLabel = (label: string, raw: number) => `${label} ${raw.toLocaleString()}`
// 帶第一維度的值：「中國國民黨：縣市長 → 30～39 歲：12 人」；第一欄出來的線本身就含第一維度，不重複
const linkLabel = (from: string, to: string, raw: number, series?: string) => `${series && series !== from ? `${series}：` : ''}${from} → ${to}：${raw.toLocaleString()} 人`
const chip = (on: boolean) => ['px-3 py-1 rounded-full text-sm border transition', on ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:border-blue-400']
const typesAreAll = computed(() => types.value.length === 0)

usePageHead({
  title: '政黨分流圖',
  description: '中選會名單上各政黨的參選人，依屆別、縣市、年齡、性別等維度的分布。',
  noindex: true,
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>政黨分流圖</template>
      <template #description>各政黨的參選人分布在哪些縣市、鄉鎮</template>
      <template #icon><Flag :size="400" class="text-blue-500" /></template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-4" data-testid="party-flow">
      <section class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <div>
          <div class="text-sm font-bold text-navy-900 mb-2">屆別</div>
          <div class="flex flex-wrap gap-2">
            <button v-for="e in ELECTIONS" :key="e.id" type="button" :class="chip(election === e.id)" :aria-pressed="election === e.id"
              :data-testid="`party-flow-election-${e.id}`" @click="election = e.id">{{ e.label }}</button>
          </div>
        </div>
        <template v-if="!failed && rows.length">
          <div>
            <div class="text-sm font-bold text-navy-900 mb-2">選舉類別</div>
            <div class="flex flex-wrap gap-2">
              <button type="button" :class="chip(typesAreAll)" :aria-pressed="typesAreAll" @click="setTypes([])">全部</button>
              <button v-for="t in allTypes" :key="t" type="button" :class="chip(types.includes(t))" :aria-pressed="types.includes(t)" @click="setTypes(toggle(types, t))">{{ t }}</button>
            </div>
          </div>
          <details>
            <summary class="text-sm font-bold text-navy-900 cursor-pointer">政黨<span v-if="parties.length" class="ml-1 font-normal text-blue-600">（已選 {{ parties.length }}）</span></summary>
            <div class="flex flex-wrap gap-2 mt-2">
              <button v-for="p in allParties" :key="p" type="button" :class="chip(parties.includes(p))" :aria-pressed="parties.includes(p)" @click="parties = toggle(parties, p)">{{ p }}</button>
            </div>
          </details>
          <div>
            <div class="text-sm font-bold text-navy-900 mb-2">維度</div>
            <FlowDimOrder :order="dims" :dims="FLOW_DIMS" :available="dimPool" :min-on="MIN_DIMS" name="政黨分流圖" @update:order="setDims" />
          </div>
          <div class="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span data-testid="party-flow-total">共 {{ graph.total.toLocaleString() }} 人</span>
            <button v-if="parties.length || requestedTypes !== null" type="button" class="underline text-blue-600" @click="requestedTypes = null; parties = []">清除篩選</button>
            <template v-if="hasCounty && open.length">
              <span class="text-slate-400">|</span>
              <span>已展開</span>
              <button v-for="c in open" :key="c" type="button" class="px-2 py-0.5 rounded-full bg-slate-100 hover:bg-slate-200" @click="open = toggle(open, c)">{{ c }} ✕</button>
            </template>
          </div>
        </template>
      </section>

      <LoadError v-if="failed" @retry="load" />
      <div v-else-if="loading" class="text-slate-500 text-center py-20">載入中…</div>
      <template v-else>
        <section class="bg-white rounded-xl border border-slate-200 p-4">
          <SankeyChart :graph="graph" name="政黨分流" mode="count" keep-order scroll :min-span="minSpan"
            :node-label="nodeLabel" :link-label="linkLabel" @pick="onPick" />
        </section>
        <p class="text-xs text-slate-400">資料來源：<a href="https://info.cec.gov.tw/" target="_blank" rel="noopener" class="underline">中央選舉委員會</a></p>
      </template>
    </div>
  </div>
</template>
