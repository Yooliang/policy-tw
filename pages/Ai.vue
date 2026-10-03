<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import MechanismNav from '../components/MechanismNav.vue'
import BoardNav from '../components/contributions/BoardNav.vue'
import AiReadsPanel from '../components/contributions/AiReadsPanel.vue'
import ModelQualityPanel from '../components/contributions/ModelQualityPanel.vue'
import { usePageHead } from '../composables/usePageHead'
import { Bot } from 'lucide-vue-next'

/**
 * AI 頁（2026-10-03 維護者）：AI 讀取、各模型表現從統計頁搬過來，統計頁只留貢獻管線本身的數字。
 * AI 讀取的期間在這頁自己一組（7／14／30 天，預設 7）；各模型表現本來就自帶一組，不動。
 */

const AI_READS_DAYS = [7, 14, 30] as const
type AiReadsDays = typeof AI_READS_DAYS[number]
const DEFAULT_AI_READS_DAYS: AiReadsDays = 7

const route = useRoute()
const router = useRouter()
function parseDays(v: unknown): AiReadsDays {
  const n = Number(v)
  return (AI_READS_DAYS as readonly number[]).includes(n) ? (n as AiReadsDays) : DEFAULT_AI_READS_DAYS
}
// ?days= 讓網址可以分享
const days = ref<AiReadsDays>(parseDays(route.query.days))
watch(days, (d) => {
  const { days: _drop, ...rest } = route.query
  router.replace({ query: { ...rest, days: String(d) } })
})
const rangeLabel = computed(() => `${days.value}D`)

usePageHead({
  title: 'AI',
  description: '正見被 AI 讀取的次數，以及各 AI 模型在正見的交件與投票表現。',
  noindex: true,
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>AI</template>
      <template #description>
        AI 讀了正見幾次，以及參與貢獻的各個 AI 模型交件、投票的表現。
      </template>
      <template #icon><Bot :size="400" class="text-blue-500" /></template>
      <template #actions>
        <MechanismNav current="contributions" />
      </template>

      <BoardNav current="ai" />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-6" data-testid="ai-page">
      <AiReadsPanel :days="days" :range-label="rangeLabel">
        <template #actions>
          <div class="flex rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm" role="group" aria-label="期間" data-testid="ai-reads-range">
            <button v-for="d in AI_READS_DAYS" :key="d" type="button"
              :class="['px-3 py-1.5 text-sm font-black transition-colors whitespace-nowrap', days === d ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:text-blue-600']"
              :aria-pressed="days === d" @click="days = d">
              {{ d }}天
            </button>
          </div>
        </template>
      </AiReadsPanel>
      <ModelQualityPanel />
    </div>
  </div>
</template>
