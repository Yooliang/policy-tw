<script setup lang="ts">
import { computed } from 'vue'
import { Github, Twitter, Mail } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { useSupabase } from '../composables/useSupabase'

const { getActiveElection } = useSupabase()
const activeElection = computed(() => getActiveElection())
</script>

<template>
  <footer class="bg-navy-900 text-slate-400 py-12 border-t border-navy-800">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid grid-cols-1 md:grid-cols-5 gap-8">
        <div class="col-span-1 md:col-span-2">
          <h3 class="text-white text-lg font-bold mb-4">正見</h3>
          <p class="text-sm leading-relaxed mb-4 max-w-sm">
            匯聚多元視角，智能解析政見，讓正確被看見。<br/>
            我們致力於打造一個透明、客觀的政見追蹤平台，利用數據與 AI 消除資訊不對稱。
          </p>
          <div class="flex space-x-4">
            <a href="#" class="hover:text-white transition-colors"><Github :size="20" /></a>
            <a href="#" class="hover:text-white transition-colors"><Twitter :size="20" /></a>
            <a href="#" class="hover:text-white transition-colors"><Mail :size="20" /></a>
          </div>
        </div>

        <div>
          <h4 class="text-white font-semibold mb-4">平台功能</h4>
          <ul class="space-y-2 text-sm">
            <li><RouterLink to="/tracking" class="hover:text-blue-400 transition-colors">政見追蹤</RouterLink></li>
            <li><RouterLink to="/analysis" class="hover:text-blue-400 transition-colors">AI 智能分析</RouterLink></li>
            <li><RouterLink to="/regional-data" class="hover:text-blue-400 transition-colors">縣市數據分佈</RouterLink></li>
            <li v-if="activeElection">
              <RouterLink :to="`/election/${activeElection.id}`" class="hover:text-blue-400 transition-colors">
                {{ activeElection.shortName }}
              </RouterLink>
            </li>
          </ul>
        </div>

        <div>
          <h4 class="text-white font-semibold mb-4">歷屆選舉</h4>
          <ul class="space-y-2 text-sm">
            <li><RouterLink to="/election/2024" class="hover:text-blue-400 transition-colors">2024 總統大選</RouterLink></li>
            <li><RouterLink to="/election/2022" class="hover:text-blue-400 transition-colors">2022 九合一選舉</RouterLink></li>
          </ul>
        </div>


        <div>
          <h4 class="text-white font-semibold mb-4">關於我們</h4>
          <ul class="space-y-2 text-sm">
            <li><a href="#" class="hover:text-blue-400 transition-colors">專案願景</a></li>
            <li><a href="#" class="hover:text-blue-400 transition-colors">開源貢獻</a></li>
            <li><a href="#" class="hover:text-blue-400 transition-colors">隱私權政策</a></li>
            <li><RouterLink to="/donation" class="hover:text-blue-400 transition-colors">贊助支持</RouterLink></li>
          </ul>
        </div>
      </div>
      <div class="mt-12 pt-8 border-t border-navy-800 text-center text-xs">
        <p>&copy; {{ new Date().getFullYear() }} 正見 Policy Tracker. All rights reserved.</p>
      </div>
    </div>
  </footer>
</template>
