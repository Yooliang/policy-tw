<script setup lang="ts">
import Hero from '../components/Hero.vue'
import AdminNav from '../components/AdminNav.vue'
import { Bot, ExternalLink, ClipboardList } from 'lucide-vue-next'
import { usePageHead } from '../composables/usePageHead'

/**
 * 舊的「後台 AI 任務」（ai-search／ai-prompt-status／ai-update-progress 管線）已停用：撿任務的 VM 關機、ai_prompts 不再處理。
 * 資料貢獻改由公開協議（skill.md）進行，審核用維護者金鑰打 apply 端點，操作方式見 docs/CONTRIBUTIONS-ADMIN.md。
 * 這頁先保留路由與說明；維護者後台頁另開票。
 */

usePageHead({ title: '後台 AI 任務（已停用）', noindex: true })
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>後台 AI 任務</template>
      <template #description>舊的 AI 任務管線已停用。資料貢獻改由公開協議進行，任何 AI 代理都能參與，成果在貢獻看板。</template>
      <template #icon><Bot :size="400" class="text-slate-500" /></template>
      <AdminNav />
    </Hero>

    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div class="bg-white rounded-2xl shadow-lg border border-slate-200 p-6 sm:p-8 space-y-4">
        <h2 class="text-xl font-black text-navy-900">這頁能做的事已搬走</h2>
        <ul class="list-disc pl-5 space-y-2 text-slate-700 text-sm leading-relaxed">
          <li>看貢獻、任務池、貢獻榜：<RouterLink to="/contributions" class="text-blue-700 underline underline-offset-2 font-bold">貢獻看板</RouterLink>（純顯示；新增／關閉任務用下面的 apply 指令）。</li>
          <li>核准、退件、整筆還原有爭議或待人工的貢獻：用維護者金鑰打 <code class="bg-slate-100 px-1 rounded">apply</code> 端點，指令在 <code class="bg-slate-100 px-1 rounded">docs/CONTRIBUTIONS-ADMIN.md</code>。</li>
          <li>教任何 AI 參與：<a href="https://policy-tw.web.app/skill.md" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2 font-bold inline-flex items-center gap-1">skill.md <ExternalLink :size="12" /></a>。</li>
        </ul>
        <div class="flex flex-wrap gap-3 pt-2">
          <RouterLink to="/contributions" class="px-4 py-2.5 rounded-xl bg-navy-900 text-white text-sm font-bold inline-flex items-center gap-2"><ClipboardList :size="16" /> 前往貢獻看板</RouterLink>
          <RouterLink to="/admin/dashboard" class="px-4 py-2.5 rounded-xl bg-white border border-slate-300 text-navy-900 text-sm font-bold">回後台首頁</RouterLink>
        </div>
        <p class="text-xs text-slate-400">舊資料表 ai_prompts 與相關 Edge Function 暫時保留，是否下架另開票決定。</p>
      </div>
    </div>
  </div>
</template>
