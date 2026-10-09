<script setup lang="ts">
import { computed } from 'vue'
import { Github, Mail } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { useSupabase } from '../composables/useSupabase'
import { footerElections, taipeiDay } from '../lib/election-list'
import { FEATURED_LOCAL_ELECTION_ID, TAIWAN_COUNTIES, electionPath, electionRegionPath } from '../lib/election-regions'
import { electionSegment } from '../lib/election-route'

const { elections } = useSupabase()
// 最近要投票的一場＋過去由新到舊，最多 3 筆（lib/election-list.ts；依投票日動態判斷，不寫死屆別）
const footerList = computed(() => footerElections(elections.value, taipeiDay(Date.now())))
</script>

<template>
  <footer class="bg-navy-900 text-slate-400 py-12 border-t border-navy-800">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <!-- 手機版 2 欄（2026-10-03 維護者）：「正見」簡介佔滿一列，其餘各欄兩欄排。
           電腦版 8 欄（2026-10-06）：簡介 3 欄＋政見／選舉／一覽／貢獻／關於各 1 欄，剛好排滿 -->
      <div class="grid grid-cols-2 md:grid-cols-8 gap-8">
        <div class="col-span-2 md:col-span-3">
          <h3 class="text-white text-lg font-bold mb-4">正見</h3>
          <p class="text-sm leading-relaxed mb-4 max-w-sm">
            匯聚多元視角，智能解析政見，讓正確被看見。<br/>
            我們致力於打造一個透明、客觀的政見追蹤平台，利用數據與 AI 消除資訊不對稱。
          </p>
          <div class="flex space-x-4">
            <a href="https://github.com/Yooliang/policy-tw" target="_blank" rel="noopener" class="hover:text-white transition-colors" aria-label="GitHub 原始碼" title="GitHub 原始碼"><Github :size="20" /></a>
            <!-- 沒有 X 帳號，也沒有公開信箱：聯絡一律走 GitHub Issues（跟隱私權頁一致） -->
            <a href="https://github.com/Yooliang/policy-tw/issues" target="_blank" rel="noopener" class="hover:text-white transition-colors" aria-label="回報問題" title="回報問題"><Mail :size="20" /></a>
          </div>
        </div>

        <div>
          <h4 class="text-white font-semibold mb-4">政見</h4>
          <ul class="space-y-2 text-sm">
            <li><RouterLink to="/tracking" class="hover:text-blue-400 transition-colors">政見追蹤</RouterLink></li>
            <li><RouterLink to="/analysis" class="hover:text-blue-400 transition-colors">政策脈絡</RouterLink></li>
            <li><RouterLink to="/regional-data" class="hover:text-blue-400 transition-colors">縣市數據分佈</RouterLink></li>
          </ul>
        </div>

        <div>
          <h4 class="text-white font-semibold mb-4">選舉</h4>
          <ul class="space-y-2 text-sm">
            <!-- 最近要投票的那一場（若有）＋過去的屆別，最多 3 筆（維護者 2026-10-06）；其餘從「選舉一覽」進去 -->
            <li v-for="e in footerList" :key="e.id">
              <RouterLink :to="electionPath(electionSegment(e))" class="hover:text-blue-400 transition-colors">{{ e.shortName }}</RouterLink>
            </li>
          </ul>
        </div>

        <div>
          <h4 class="text-white font-semibold mb-4">一覽</h4>
          <ul class="space-y-2 text-sm">
            <li><RouterLink to="/elections" class="hover:text-blue-400 transition-colors">選舉一覽</RouterLink></li>
            <!-- 人物一覽、政黨一覽（#346）只在建置時產生內容：用一般連結整頁載入預渲染那一份（lib/full-load.ts） -->
            <li><a href="/politicians" class="hover:text-blue-400 transition-colors">人物一覽</a></li>
            <li><a href="/parties" class="hover:text-blue-400 transition-colors">政黨一覽</a></li>
          </ul>
        </div>

        <div>
          <h4 class="text-white font-semibold mb-4">貢獻</h4>
          <ul class="space-y-2 text-sm">
            <li><RouterLink to="/skill" class="hover:text-blue-400 transition-colors">參與貢獻</RouterLink></li>
            <li><RouterLink to="/contributions" class="hover:text-blue-400 transition-colors">貢獻看板</RouterLink></li>
            <li><RouterLink to="/queue" class="hover:text-blue-400 transition-colors">任務佇列</RouterLink></li>
            <li><RouterLink to="/sources" class="hover:text-blue-400 transition-colors">查證來源</RouterLink></li>
          </ul>
        </div>

        <div>
          <h4 class="text-white font-semibold mb-4">關於</h4>
          <ul class="space-y-2 text-sm">
            <!-- 「專案願景」改名「關於正見」（同一頁 /vision，不並存）；聯絡一律走 GitHub Issues，沒有公開信箱（跟隱私權頁一致） -->
            <li><RouterLink to="/vision" class="hover:text-blue-400 transition-colors">關於正見</RouterLink></li>
            <li><RouterLink to="/contact" class="hover:text-blue-400 transition-colors">聯絡我們</RouterLink></li>
            <li><RouterLink to="/terms" class="hover:text-blue-400 transition-colors">使用條款</RouterLink></li>
            <li><RouterLink to="/privacy" class="hover:text-blue-400 transition-colors">隱私權政策</RouterLink></li>
            <li><RouterLink to="/donation" class="hover:text-blue-400 transition-colors">贊助支持</RouterLink></li>
          </ul>
        </div>
      </div>
      <!-- 每一頁都有 22 縣市頁的連結（2026-09-30 維護者：所有的頁面都要可以互連）：任何一頁兩步內到任何候選人 -->
      <nav aria-label="各縣市候選人" class="mt-10 pt-8 border-t border-navy-800 text-left">
        <h4 class="text-white font-semibold mb-3 text-sm">{{ FEATURED_LOCAL_ELECTION_ID }} 各縣市候選人</h4>
        <ul class="flex flex-wrap gap-x-[0.8rem] gap-y-2 text-sm">
          <li v-for="county in TAIWAN_COUNTIES" :key="county">
            <RouterLink :to="electionRegionPath(FEATURED_LOCAL_ELECTION_ID, county)" class="hover:text-blue-400 transition-colors">{{ county }}</RouterLink>
          </li>
        </ul>
      </nav>
      <!-- 各站頁尾互相連結（維護者 2026-10-09；policy-ops docs/decisions/2026-10-09-各站頁尾互相連結.md）：只放站名連結 -->
      <nav aria-label="姊妹站" class="mt-8 pt-8 border-t border-navy-800 text-sm">
        <ul class="flex flex-wrap justify-center gap-x-6 gap-y-2">
          <li><span class="text-white font-semibold">姊妹站</span></li>
          <li><a href="https://hustings.net" target="_blank" rel="noopener" class="hover:text-blue-400 transition-colors">hustings.net</a></li>
          <li><a href="https://jp.hustings.net" target="_blank" rel="noopener" lang="ja" class="hover:text-blue-400 transition-colors">政策の系譜（日本）</a></li>
        </ul>
      </nav>
      <div class="mt-8 pt-8 border-t border-navy-800 text-center text-xs">
        <p>&copy; {{ new Date().getFullYear() }} 正見 Policy Tracker. All rights reserved.</p>
      </div>
    </div>
  </footer>
</template>
