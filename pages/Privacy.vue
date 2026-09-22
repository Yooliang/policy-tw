<script setup lang="ts">
import { ShieldCheck } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import { usePageHead } from '../composables/usePageHead'

/**
 * 隱私權政策。
 *
 * 這一頁的每一句都要對得上程式實際做的事——寫一份跟行為不符的政策，比沒有還糟。
 * 對照位置：
 *   IP 雜湊      supabase/functions/_shared/contribute-handler.ts 的 ipHashOf（SHA-256(salt|ip)）
 *   登入         composables/useAuth.ts 只有 signInWithOAuth({ provider: 'google' })
 *   帳號欄位     migration 20260131100004_user_profiles.sql（email／display_name／avatar_url）
 *   本機儲存     zhengjian_checkpoints（我的關注）
 *   GA／AdSense  index.html
 * 改了那些地方，這一頁要跟著改。
 */
const UPDATED = '2026-09-14'

usePageHead({
  title: '隱私權政策',
  description: '正見蒐集什麼、不蒐集什麼，以及第三方服務的說明。我們不儲存原始 IP，公開資料一律不需登入即可閱讀。',
})
</script>

<template>
  <div>
    <Hero>
      <template #title>隱私權政策</template>
      <template #description>
        這一頁說明「正見」會蒐集什麼、不會蒐集什麼。<br/>最後更新：{{ UPDATED }}
      </template>
      <template #icon><ShieldCheck :size="400" class="text-emerald-500" /></template>
    </Hero>

    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-left">
      <div class="space-y-10 text-slate-700 leading-relaxed">

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">一句話版本</h2>
          <p>
            瀏覽這個網站不需要登入，也不需要提供任何個人資料。我們<strong>不儲存你的原始 IP 位址</strong>；
            網站使用 Google Analytics 與 Google AdSense，它們會在你的瀏覽器放置 Cookie。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">只是閱讀的話</h2>
          <p>
            政見、人物、查核履歷這些內容全部公開，不需要登入就看得到，我們也不會為了讓你閱讀而蒐集任何東西。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">你主動做了什麼的時候</h2>
          <p class="mb-3">
            提出公民提問、對政見表態、按下「請 AI 查證」這類按鈕時，我們會把你的 IP 位址
            <strong>加上一段固定的私鑰之後做 SHA-256 雜湊</strong>，只存下那串雜湊值，不存原始 IP。
          </p>
          <p class="mb-3">它的用途只有兩個：</p>
          <ul class="list-disc pl-6 space-y-1">
            <li>每日額度限制，避免同一個來源灌爆系統</li>
            <li>去重計票——同一個來源對同一筆貢獻只能算一票，否則同儕驗證機制會失效</li>
          </ul>
          <p class="mt-3">
            雜湊值無法還原成 IP，我們也不會拿它去比對任何其他資料，或試圖識別你是誰。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">登入</h2>
          <p>
            登入是選用的，只有 Google 一種方式。登入之後我們會保存 Google 提供的
            <strong>電子郵件、顯示名稱與大頭貼網址</strong>，用來顯示你的身分。
            我們拿不到你的 Google 密碼。不登入不影響閱讀，也不影響提問或表態。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">你的公開貢獻</h2>
          <p>
            公民提問的內容、對貢獻的查核與投票紀錄，本來就是公開的——這個網站的重點就是
            每一筆資料都看得到是誰查的、依據什麼。請不要在提問內容裡寫個人資料。
            資料依 CC BY 4.0 授權，任何人都可以取用。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">留在你自己瀏覽器裡的東西</h2>
          <p>
            「我的關注」（政見旁的⭐）：沒登入時存在你瀏覽器的 localStorage（<code class="text-sm bg-slate-100 px-1.5 py-0.5 rounded">zhengjian_checkpoints</code>），
            不會傳到我們的伺服器，清掉瀏覽器資料就會消失。
            登入的話會同步到你的帳號（換裝置也看得到），並計入那條政見的「關注數」——
            公開的只有每條政見有幾個人關注，你關注了哪些不會公開。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">第三方服務</h2>
          <ul class="list-disc pl-6 space-y-2">
            <li>
              <strong>Google Analytics</strong>——了解哪些頁面有人看。它會放置 Cookie。
            </li>
            <li>
              <strong>Google AdSense</strong>——顯示廣告。Google 及其合作夥伴可能使用 Cookie
              依你先前的瀏覽行為投放廣告。你可以到
              <a href="https://myadcenter.google.com/" target="_blank" rel="noopener" class="text-blue-600 underline underline-offset-2">Google 廣告設定</a>
              關閉個人化廣告，或到
              <a href="https://www.aboutads.info/choices/" target="_blank" rel="noopener" class="text-blue-600 underline underline-offset-2">aboutads.info</a>
              管理第三方供應商的 Cookie。
            </li>
            <li>
              <strong>Converly（adotone）</strong>——聯盟連結服務：把站上的部分外部連結轉成可計算成效的連結，它可能記錄點擊並放置 Cookie。
            </li>
            <li>
              <strong>Supabase</strong>——資料庫與登入服務。<strong>Firebase Hosting</strong>——網站主機。
              兩者會在伺服器端記錄一般的連線日誌。
            </li>
          </ul>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">AI 代理的貢獻</h2>
          <p>
            外部 AI 代理透過公開協議提交資料時，同樣只會留下代號與來源 IP 的雜湊值。
            代號是它自己取的，我們不要求也不驗證它背後是誰。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">政治人物的資料</h2>
          <p>
            網站上關於政治人物的資料，全部來自公開來源——中央選舉委員會、政府網站、
            候選人自己的官方管道、新聞報導——每一筆都附得出原始網址。
            這些是公職人員與公職候選人在公共事務上的言行紀錄。
            如果你認為某一筆資料錯誤，每個政見頁都有回報入口，會進入查證流程。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">聯絡</h2>
          <p>
            有隱私相關的問題，或要求刪除與你有關的資料，請到
            <a href="https://github.com/Yooliang/policy-tw/issues" target="_blank" rel="noopener" class="text-blue-600 underline underline-offset-2">GitHub Issues</a>
            開一則。這個專案是開源的，處理過程也會公開。
          </p>
        </section>

        <section>
          <h2 class="text-2xl font-black text-navy-900 mb-3">政策變更</h2>
          <p>
            這一頁跟著程式碼一起版本控管，改動看得到歷程。有重大變更時會更新頁首的日期。
          </p>
        </section>

      </div>
    </div>
  </div>
</template>
