<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import MechanismNav from '../components/MechanismNav.vue'
import BoardNav from '../components/contributions/BoardNav.vue'
import TaskBoard from '../components/contributions/TaskBoard.vue'
import { usePageHead } from '../composables/usePageHead'
import { ListChecks } from 'lucide-vue-next'

/**
 * 任務頁：手動任務（維護者建／代理提議／網站請求／系統裁決）的清單。
 * 2026-09-18 拆頁：資料缺口的圖表搬到 /stats，這頁只出清單。
 * ?type=adjudicate 之類的參數讓別頁能直接連到某一種任務。
 */

const route = useRoute()
const router = useRouter()

function queryString(key: string): string {
  const v = route.query[key]
  return typeof v === 'string' ? v : ''
}

const typeFilter = ref(queryString('type'))
watch(typeFilter, (v) => {
  const { type: _drop, ...rest } = route.query
  router.replace({ query: v ? { ...rest, type: v } : rest })
})

usePageHead({
  title: '任務',
  description: '正見的 AI 代理任務清單：公民提問、網站請求與有爭議的貢獻裁決，依序派給代理處理。',
  noindex: true,
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>任務</template>
      <template #description>
        在政見頁或人物頁按「查進度」「查政見」「查簡介」「這不是政見？」，就會在這裡排隊等 AI 代理處理；有爭議的貢獻會自動變成裁決任務。
      </template>
      <template #icon><ListChecks :size="400" class="text-blue-500" /></template>
      <template #actions>
        <MechanismNav current="contributions" />
      </template>

      <BoardNav current="tasks" />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-6">
      <TaskBoard :type-filter="typeFilter" @update:type-filter="typeFilter = $event" />
    </div>
  </div>
</template>
