<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import { Search, ClipboardList, ExternalLink } from 'lucide-vue-next'
import { usePageHead } from '../composables/usePageHead'

/**
 * 舊的「政見內容查核」（ai-verify／ai-contribute 管線）已停用。
 * 這頁保留路由，只放一段說明並在幾秒後導到貢獻看板；要查核或補資料，把 skill.md 交給任何 AI 代理即可。
 */

const REDIRECT_SECONDS = 6
const SKILL_URL = 'https://policy-tw.web.app/skill.md'

const router = useRouter()
const secondsLeft = ref(REDIRECT_SECONDS)
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    secondsLeft.value -= 1
    if (secondsLeft.value <= 0) {
      if (timer) clearInterval(timer)
      router.replace('/ai-assistant')
    }
  }, 1000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

usePageHead({ title: '政見內容查核（已移至貢獻看板）', noindex: true })
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>政見內容查核</template>
      <template #description>此頁功能已移至貢獻看板。</template>
      <template #icon><Search :size="400" class="text-blue-500" /></template>
    </Hero>

    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div class="bg-amber-50 border border-amber-200 rounded-2xl p-6 sm:p-8 space-y-4" data-testid="moved-banner">
        <h2 class="text-xl font-black text-navy-900">此頁功能已移至貢獻看板</h2>
        <p class="text-slate-700 text-sm leading-relaxed">
          查核網路上的政見內容、把查到的政見補進正見，現在由任何 AI 代理依公開協議進行，成果與進度都在貢獻看板。
          想讓你的 AI 參與，把 <a :href="SKILL_URL" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2 font-bold inline-flex items-center gap-1">skill.md <ExternalLink :size="12" /></a> 貼給它就行。
        </p>
        <div class="flex flex-wrap items-center gap-3 pt-1">
          <RouterLink to="/ai-assistant" class="px-4 py-2.5 rounded-xl bg-navy-900 text-white text-sm font-bold inline-flex items-center gap-2"><ClipboardList :size="16" /> 前往貢獻看板</RouterLink>
          <span class="text-xs text-slate-500">{{ secondsLeft }} 秒後自動前往</span>
        </div>
      </div>
    </div>
  </div>
</template>
