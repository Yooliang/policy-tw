<script setup lang="ts">
/**
 * 政黨分流圖（/parties/flow，policy-ops#193）：中選會名冊 政黨 → 縣市（點縣市展開鄉鎮）。
 * 資料是資料庫 party_flow_counts()（只有聚合人數）；純函式在 lib/party-flow.ts。
 * 政黨照名稱筆畫排、不依人數、不併其他，放不下就橫向捲動。客戶端渲染、noindex。
 * 網址：?type=縣市長,…（選舉別）、?party=…（政黨）、?open=台北市,…（展開的縣市）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Flag } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import SankeyChart from '../components/contributions/SankeyChart.vue'
import LoadError from '../components/LoadError.vue'
import { usePageHead } from '../composables/usePageHead'
import { usePaneActive } from '../composables/usePane'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import {
  buildPartyFlow, countyOrder, ELECTION_TYPES, filterRows, parseQuery, parseRows, partyOrder, toggle, toQuery,
  type PartyFlowRow,
} from '../lib/party-flow'

const route = useRoute()
const router = useRouter()
const paneActive = usePaneActive()

const rows = ref<PartyFlowRow[]>([])
const loading = ref(true)
const failed = ref(false)

const allParties = computed(() => partyOrder(rows.value))
const allCounties = computed(() => countyOrder(rows.value))

// 資料還沒回來時先照網址原樣收下，載入後再丟掉不認得的值
const initial = parseQuery(route.query as Record<string, unknown>)
const types = ref<string[]>(initial.types)
const parties = ref<string[]>(initial.parties)
const open = ref<string[]>(initial.open)

async function load() {
  loading.value = true
  failed.value = false
  try {
    const { data } = await withTimeoutAndRetry('政黨分流圖', (signal) =>
      supabasePublic.rpc('party_flow_counts').abortSignal(signal).throwOnError())
    rows.value = parseRows(data)
    const q = parseQuery({ type: types.value.join(','), party: parties.value.join(','), open: open.value.join(',') },
      { types: ELECTION_TYPES, parties: allParties.value, counties: allCounties.value })
    types.value = q.types; parties.value = q.parties; open.value = q.open
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)

function syncQuery() {
  if (!paneActive.value) return
  const { type: _t, party: _p, open: _o, ...rest } = route.query
  router.replace({ query: { ...rest, ...toQuery({ types: types.value, parties: parties.value, open: open.value }) } })
}
watch([types, parties, open], syncQuery)

const filtered = computed(() => filterRows(rows.value, { types: types.value, parties: parties.value }))
const graph = computed(() => buildPartyFlow(filtered.value, open.value))

// 每欄節點數最多的那一欄決定高度，每個節點留 24 單位
const minSpan = computed(() => {
  const g = graph.value
  const cols = ['p:', 'c:', 't:'].map((k) => g.nodes.filter((n) => n.id.startsWith(k)).length)
  return Math.max(...cols) * 24 + 12
})

const onPick = (id: string) => {
  if (id.startsWith('c:')) open.value = toggle(open.value, id.slice(2))
}
const nodeLabel = (label: string, raw: number) => `${label} ${raw.toLocaleString()}`
const linkLabel = (from: string, to: string, raw: number) => `${from} → ${to}：${raw.toLocaleString()} 人`

usePageHead({
  title: '政黨分流圖',
  description: '中選會名冊上各政黨的參選人，分布在哪些縣市與鄉鎮。',
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
      <LoadError v-if="failed" @retry="load" />
      <div v-else-if="loading" class="text-slate-500 text-center py-20">載入中…</div>
      <template v-else>
        <section class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
          <div>
            <div class="text-sm font-bold text-navy-900 mb-2">選舉類別</div>
            <div class="flex flex-wrap gap-2">
              <button v-for="t in ELECTION_TYPES" :key="t" type="button"
                class="px-3 py-1 rounded-full text-sm border transition"
                :class="types.includes(t) ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:border-blue-400'"
                :aria-pressed="types.includes(t)" @click="types = toggle(types, t)">{{ t }}</button>
            </div>
          </div>
          <details>
            <summary class="text-sm font-bold text-navy-900 cursor-pointer">政黨<span v-if="parties.length" class="ml-1 font-normal text-blue-600">（已選 {{ parties.length }}）</span></summary>
            <div class="flex flex-wrap gap-2 mt-2">
              <button v-for="p in allParties" :key="p" type="button"
                class="px-3 py-1 rounded-full text-sm border transition"
                :class="parties.includes(p) ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:border-blue-400'"
                :aria-pressed="parties.includes(p)" @click="parties = toggle(parties, p)">{{ p }}</button>
            </div>
          </details>
          <div class="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span data-testid="party-flow-total">共 {{ graph.total.toLocaleString() }} 人</span>
            <button v-if="types.length || parties.length" type="button" class="underline text-blue-600" @click="types = []; parties = []">清除篩選</button>
            <template v-if="open.length">
              <span class="text-slate-400">|</span>
              <span>已展開</span>
              <button v-for="c in open" :key="c" type="button" class="px-2 py-0.5 rounded-full bg-slate-100 hover:bg-slate-200" @click="open = toggle(open, c)">{{ c }} ✕</button>
            </template>
          </div>
        </section>

        <section class="bg-white rounded-xl border border-slate-200 p-4">
          <SankeyChart :graph="graph" name="政黨分流" mode="count" keep-order scroll :min-span="minSpan"
            :node-label="nodeLabel" :link-label="linkLabel" @pick="onPick" />
        </section>
        <p class="text-xs text-slate-400">資料來源：<a href="https://info.cec.gov.tw/vote2026/" target="_blank" rel="noopener" class="underline">中央選舉委員會</a></p>
      </template>
    </div>
  </div>
</template>
