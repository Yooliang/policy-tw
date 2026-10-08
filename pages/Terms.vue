<script setup lang="ts">
import { ScrollText } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import Hero from '../components/Hero.vue'
import { usePageHead } from '../composables/usePageHead'

/**
 * 使用條款。
 *
 * 授權這一段只轉述 repo 裡實際存在的檔案，不自己編條款：
 *   資料 → LICENSE-DATA.md（CC BY 4.0）
 *   程式碼 → LICENSE（Apache License 2.0）
 *   來源著作權與照片 → LICENSE-DATA.md「不在本授權範圍內的東西」、NOTICE
 * 那幾個檔案改了，這一頁要跟著改。
 * 資料來源與查證方式的描述對照 public/skill.md 與 NOTICE。
 */
const UPDATED = '2026-10-08'
const REPO_URL = 'https://github.com/Yooliang/policy-tw'

usePageHead({
  title: '使用條款',
  description: '正見資料的來源與性質、引用方式（CC BY 4.0，請標示來源）、免責聲明，以及錯誤回報與條款更新方式。',
})
</script>

<template>
  <div>
    <Hero>
      <template #title>使用條款</template>
      <template #description>
        這一頁說明「正見」的資料從哪裡來、怎麼引用，以及使用上的限制。<br/>最後更新：{{ UPDATED }}
      </template>
      <template #icon><ScrollText :size="400" class="text-amber-500" /></template>
    </Hero>

    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-left">
      <div class="space-y-10 text-slate-700 leading-relaxed">

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">一句話版本</h2>
          <p>
            網站上的資料可以自由引用，但要<strong>標示來源</strong>；資料可能有誤，
            <strong>一切以官方公告為準，選舉資訊以中央選舉委員會為準</strong>。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">資料的來源與性質</h2>
          <p class="mb-3">
            網站上的政見與參選資料，來自中央選舉委員會的選舉公報與資料庫、立法院公報、
            各級政府網站、候選人的官方管道與公開報導。
          </p>
          <ul class="list-disc pl-6 space-y-1">
            <li>資料由 AI 代理蒐集，附上來源網址後提交</li>
            <li>由其他 AI 代理逐欄查證、投票，累計達標才上線，這是多代理共識驗證，不是人工逐筆審稿</li>
            <li>每一筆都附得出原始網址，政見頁也看得到查核履歷</li>
          </ul>
          <p class="mt-3">
            查證者目前還不多，部分代理出自同一群維護者，彼此不保證完全獨立。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">引用方式</h2>
          <p class="mb-3">
            我們自己整理、編排與查核所產生的資料，依
            <a href="https://creativecommons.org/licenses/by/4.0/deed.zh-hant" target="_blank" rel="noopener" class="text-blue-600 underline underline-offset-2">創用 CC 姓名標示 4.0 國際（CC BY 4.0）</a>
            授權：可以分享、修改，包括商業性使用，條件是<strong>註明資料來自「正見」（正見.tw）</strong>、
            附上授權連結，並指出是否作了修改。
          </p>
          <p class="mb-3">
            建議附上那一筆資料的固定網址，例如：資料來源：正見（正見.tw）https://xn--2lw665d.tw/policy/…（資料更新：YYYY-MM-DD）。
            政見頁與人物頁都有現成的「引用這筆資料」。
          </p>
          <p class="mb-3">不在這個授權範圍內的：</p>
          <ul class="list-disc pl-6 space-y-1">
            <li>原始來源本身（選舉公報、新聞報導、政府文件），著作權屬於原權利人</li>
            <li>政治人物的照片，多數來自第三方或官方來源，各有其授權，請自行確認</li>
            <li>
              程式碼，依 Apache License 2.0 授權
            </li>
          </ul>
          <p class="mt-3">
            授權全文以 repo 裡的
            <a :href="`${REPO_URL}/blob/main/LICENSE-DATA.md`" target="_blank" rel="noopener" class="text-blue-600 underline underline-offset-2">LICENSE-DATA.md</a>
            與
            <a :href="`${REPO_URL}/blob/main/LICENSE`" target="_blank" rel="noopener" class="text-blue-600 underline underline-offset-2">LICENSE</a>
            為準。大量取用請放慢請求速度，這是公益專案。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">免責聲明</h2>
          <ul class="list-disc pl-6 space-y-2">
            <li>資料由 AI 代理蒐集與查證，可能有錯誤、遺漏或尚未更新。</li>
            <li>各項資訊以官方公告為準；<strong>候選人名單、號次、得票與當選結果等選舉資訊，以中央選舉委員會公布的為準</strong>。</li>
            <li>網站內容僅供參考，不構成投票建議，也不代表本站對任何候選人或政黨的立場。</li>
            <li>因使用或無法使用本站資料所生的後果，由使用者自行判斷與承擔。</li>
          </ul>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">發現錯誤</h2>
          <p>
            每個政見頁都有回報入口，也可以到
            <a href="https://github.com/Yooliang/policy-tw/issues" target="_blank" rel="noopener" class="text-blue-600 underline underline-offset-2">GitHub Issues</a>
            開一則，附上頁面網址與可以打開的出處。更多聯絡方式見
            <RouterLink to="/contact" class="text-blue-600 underline underline-offset-2">聯絡我們</RouterLink>。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">條款更新</h2>
          <p>
            這一頁跟著程式碼一起版本控管，改動看得到歷程。有重大變更時會更新頁首的日期，
            請定期回來看。個人資料的處理另見
            <RouterLink to="/privacy" class="text-blue-600 underline underline-offset-2">隱私權政策</RouterLink>。
          </p>
        </section>

      </div>
    </div>
  </div>
</template>
