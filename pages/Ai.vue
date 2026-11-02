<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import AiReadsPanel from '../components/contributions/AiReadsPanel.vue'
import ModelQualityPanel from '../components/contributions/ModelQualityPanel.vue'
import { usePageHead } from '../composables/usePageHead'
import { onPaneShown, usePaneActive } from '../composables/usePane'
import { Bot } from 'lucide-vue-next'
import { CONTRIB_DIMS, DEFAULT_CONTRIB_ORDER, DEFAULT_VOTE_ORDER, VOTE_DIMS, parseDimOrder } from '../lib/model-flow'

/**
 * AI 頁（2026-10-03 維護者）：AI 讀取、各模型表現從統計頁搬過來，統計頁只留貢獻管線本身的數字。
 * 2026-11-02：兩組期間一律固定近 14 天（舊網址的 ?days= 直接忽略）；各模型表現改「比例／數量／表格」三選一。
 * 網址：?flow=count｜table（預設比例）、?dims=model,result,reason,type（交件分流順序）、?vdims=model,outcome,verdict（投票分流順序）。
 */

const DAYS = 14

const route = useRoute()
const router = useRouter()
const paneActive = usePaneActive()
const flow = ref<'pct' | 'count' | 'table'>(route.query.flow === 'count' || route.query.flow === 'table' ? route.query.flow : 'pct')
const dims = ref<string[]>(parseDimOrder(route.query.dims, CONTRIB_DIMS, DEFAULT_CONTRIB_ORDER))
const vdims = ref<string[]>(parseDimOrder(route.query.vdims, VOTE_DIMS, DEFAULT_VOTE_ORDER))
const same = (a: readonly string[], b: readonly string[]) => a.join() === b.join()
function syncQuery() {
  if (!paneActive.value) return
  const { flow: _f, dims: _d, vdims: _v, days: _days, ...rest } = route.query
  const q: Record<string, any> = { ...rest }
  if (flow.value !== 'pct') q.flow = flow.value
  if (!same(dims.value, DEFAULT_CONTRIB_ORDER)) q.dims = dims.value.join(',')
  if (!same(vdims.value, DEFAULT_VOTE_ORDER)) q.vdims = vdims.value.join(',')
  router.replace({ query: q })
}
watch([flow, dims, vdims], syncQuery)

usePageHead({
  title: 'AI 表現統計',
  description: '正見被 AI 讀取的次數，以及各 AI 模型在正見的交件與投票表現。',
  noindex: true,
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>AI 表現統計</template>
      <template #description>AI 讀了正見幾次，各模型交件與投票的表現</template>
      <template #icon><Bot :size="400" class="text-blue-500" /></template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-6" data-testid="ai-page">
      <AiReadsPanel :days="DAYS" range-label="近 14 天" />
      <ModelQualityPanel v-model:flow="flow" v-model:dims="dims" v-model:vdims="vdims" />
    </div>
  </div>
</template>
