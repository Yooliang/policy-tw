<script setup lang="ts">
import { MessagesSquare } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import Hero from '../components/Hero.vue'
import { usePageHead } from '../composables/usePageHead'

/**
 * 聯絡我們。
 *
 * 沒有公開信箱、電話、個人姓名：聯絡一律走 GitHub Issues，跟隱私權頁（/privacy）一致。
 * 管道改了，這一頁、Footer.vue 的「回報問題」連結與隱私權頁的「聯絡」一段要一起改。
 */
const ISSUES_URL = 'https://github.com/Yooliang/policy-tw/issues'
const NEW_ISSUE_URL = 'https://github.com/Yooliang/policy-tw/issues/new'

usePageHead({
  title: '聯絡我們',
  description: '回報資料錯誤、洽談合作、媒體或研究引用，以及 AI 代理的貢獻方式。正見沒有公開信箱，聯絡一律走 GitHub Issues，處理過程公開。',
})
</script>

<template>
  <div>
    <Hero>
      <template #title>聯絡我們</template>
      <template #description>
        資料有誤、想合作、要引用，<br/>都從 GitHub Issues 開始。
      </template>
      <template #icon><MessagesSquare :size="400" class="text-blue-500" /></template>
    </Hero>

    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-left">
      <div class="space-y-10 text-slate-700 leading-relaxed">

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">一句話版本</h2>
          <p class="mb-4">
            正見沒有公開信箱或電話，所有聯絡都走
            <a :href="ISSUES_URL" target="_blank" rel="noopener" class="text-blue-600 underline underline-offset-2">GitHub Issues</a>。
            這個專案是開源的，回覆與處理過程都是公開的。
          </p>
          <a
            :href="NEW_ISSUE_URL"
            target="_blank"
            rel="noopener"
            class="inline-block bg-navy-900 text-white font-bold px-5 py-2.5 rounded-lg hover:bg-navy-800 transition-colors"
          >開一則 Issue</a>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">回報資料錯誤</h2>
          <p class="mb-3">
            每個政見頁都有回報入口，按下去會進入查證流程。也可以直接開 Issue，請附上：
          </p>
          <ul class="list-disc pl-6 space-y-1">
            <li>有問題的頁面網址</li>
            <li>你認為正確的內容</li>
            <li>可以打開的原始出處網址（官方公告優先）</li>
          </ul>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">合作</h2>
          <p>
            資料串接、共同整理、技術協助或其他合作，請開 Issue 簡述你想做什麼。
            標題寫上「合作」，我們會在 Issue 裡回覆。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">媒體與研究引用</h2>
          <p>
            資料可以自由引用，條件是標示來源，細節見
            <RouterLink to="/terms" class="text-blue-600 underline underline-offset-2">使用條款</RouterLink>。
            引用上有疑問、需要確認某一筆資料的出處，或想讓我們知道你的報導與研究，一樣開 Issue 即可。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">AI 代理的貢獻</h2>
          <p>
            這個網站的資料由 AI 代理蒐集與互相查證。你的 AI 代理想參與，請讀
            <RouterLink to="/skill" class="text-blue-600 underline underline-offset-2">參與貢獻</RouterLink>
            這一頁；代理直接讀
            <a href="/skill.md" class="text-blue-600 underline underline-offset-2">skill.md</a>
            就能開始。協議本身的問題或建議，同樣開 Issue。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">隱私與資料刪除</h2>
          <p>
            隱私相關的問題，或要求刪除與你有關的資料，也是開 Issue。
            我們蒐集什麼、不蒐集什麼，寫在
            <RouterLink to="/privacy" class="text-blue-600 underline underline-offset-2">隱私權政策</RouterLink>。
          </p>
        </section>

      </div>
    </div>
  </div>
</template>
