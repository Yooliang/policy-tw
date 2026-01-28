<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import { MessageSquare, ThumbsUp, TrendingUp, Search, Filter, PenTool } from 'lucide-vue-next'
import { POLICIES } from '../constants'

const route = useRoute()
const router = useRouter()
const initialFilter = computed(() => (route.query.filter as string) || '')
const activeTab = ref<'hot' | 'latest'>('hot')

const discussions = [
  { id: 1, title: "關於社宅租金八折的財源疑問", policyTitle: "社宅租金全面八折", author: "Citizen_Taiwan", avatar: "https://picsum.photos/50/50?random=10", content: "雖然這項政見聽起來很吸引人，但我很擔心市府的財政負擔。目前的社宅維護成本已經很高了，如果收入減少，會不會影響未來的社宅興建速度？有無具體的替代財源方案？", likes: 342, comments: 56, tags: ["居住正義", "財政紀律"], time: "2小時前" },
  { id: 2, title: "台北大建設都更速度真的有變快嗎？", policyTitle: "台北大建設 - 都更加速", author: "UrbanWatcher", avatar: "https://picsum.photos/50/50?random=11", content: "我家住在信義區的老公寓，雖然看到政策說要降門檻，但實際整合的時候建商態度還是很保留。有沒有人有實際參與公辦都更的經驗可以分享？", likes: 128, comments: 32, tags: ["都更", "台北市"], time: "5小時前" },
  { id: 3, title: "新竹輕軌路線規劃建議", policyTitle: "新竹輕軌立即動工", author: "TrafficGeek", avatar: "https://picsum.photos/50/50?random=12", content: "目前的路線規劃似乎沒有經過人口最密集的住宅區，主要是服務園區上班族。建議可以考慮支線延伸到竹北舊市區，這樣才能真正解決週末的交通問題。", likes: 89, comments: 15, tags: ["交通", "新竹"], time: "1天前" },
  { id: 4, title: "營養午餐免費政策的排擠效應", policyTitle: "國中小營養午餐免費", author: "Teacher_Wang", avatar: "https://picsum.photos/50/50?random=13", content: "身為一線教師，我支持減輕家長負擔。但更希望經費能用在提升食材品質，而不是全額免費但吃得很差。", likes: 210, comments: 88, tags: ["教育", "食安"], time: "1天前" }
]

const filteredDiscussions = computed(() => {
  return initialFilter.value ? discussions.filter(d => d.policyTitle.includes(initialFilter.value)) : discussions
})

const clearFilter = () => {
  router.push('/community')
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>公民發聲</template>
      <template #description>這裡不只是政見的展示架，更是公民意志的集散地。針對每一項政策提出您的見解、疑問或支持，讓改變從對話開始。</template>
      <template #icon><MessageSquare :size="400" class="text-blue-500" /></template>

        <div class="flex flex-col lg:flex-row gap-6 items-center">
          <div class="relative flex-1 w-full text-left">
            <Search class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" :size="20" />
            <input type="text" placeholder="搜尋討論..." class="w-full pl-12 pr-4 py-3.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-blue-500 text-navy-900 font-bold placeholder:text-slate-400" />
          </div>

          <div class="flex flex-wrap lg:flex-nowrap gap-3 w-full lg:w-auto">
            <button class="flex items-center gap-2 px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-blue-500 shadow-lg shadow-blue-500/20 transition-all font-bold text-sm shrink-0">
              <PenTool :size="18" />
              發起新討論
            </button>
            <button class="flex items-center gap-2 px-5 py-3 rounded-xl bg-white text-slate-500 border border-slate-200 hover:border-blue-300 hover:text-blue-500 transition-all font-bold text-sm shrink-0">
              查看熱門提案
            </button>
            <div class="flex gap-2 px-4 py-2 bg-slate-50 rounded-xl border border-slate-100">
              <button @click="activeTab = 'hot'" :class="`px-3 py-1 rounded-lg font-bold text-sm transition-all ${activeTab === 'hot' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:text-blue-500'}`">熱門討論</button>
              <button @click="activeTab = 'latest'" :class="`px-3 py-1 rounded-lg font-bold text-sm transition-all ${activeTab === 'latest' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:text-blue-500'}`">最新發表</button>
            </div>
          </div>
        </div>
        <div v-if="initialFilter" class="mt-4 bg-blue-50 text-blue-700 px-4 py-2 rounded-lg flex items-center justify-between">
          <span>篩選政見：<strong>{{ initialFilter }}</strong></span>
          <button @click="clearFilter" class="text-sm underline hover:text-blue-900">清除</button>
        </div>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div class="grid grid-cols-1 lg:grid-cols-4 gap-8 text-left">
        <div class="lg:col-span-1 space-y-6">
          <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 class="font-bold text-navy-900 mb-4 flex items-center gap-2"><TrendingUp class="text-red-500" :size="20" /> 熱門議題</h3>
            <ul class="space-y-3">
              <li v-for="(p, i) in POLICIES.slice(0, 5)" :key="p.id" class="text-sm">
                <a href="#" class="flex gap-2 group">
                  <span class="font-mono text-slate-400 font-bold">0{{ i + 1 }}</span>
                  <span class="text-slate-600 group-hover:text-blue-600 line-clamp-1">{{ p.title }}</span>
                </a>
              </li>
            </ul>
          </div>
          <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 class="font-bold text-navy-900 mb-4 flex items-center gap-2"><Filter class="text-blue-500" :size="20" /> 篩選類別</h3>
            <div class="flex flex-wrap gap-2">
              <span v-for="tag in ['全部', '居住正義', '交通', '教育', '經濟', '環保', '社福']" :key="tag" class="cursor-pointer px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs rounded-full transition-colors">{{ tag }}</span>
            </div>
          </div>
        </div>

        <div class="lg:col-span-3">
          <div class="space-y-6">
            <div v-for="post in filteredDiscussions" :key="post.id" class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer group">
              <div class="flex items-start gap-4">
                <img :src="post.avatar" :alt="post.author" class="w-10 h-10 rounded-full border border-slate-100" />
                <div class="flex-1">
                  <div class="flex items-center justify-between mb-2">
                    <div><span class="font-bold text-slate-800 text-sm">{{ post.author }}</span><span class="text-slate-400 text-xs ml-2">• {{ post.time }}</span></div>
                    <span class="bg-slate-100 text-slate-500 px-2 py-0.5 rounded text-[10px] group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors">針對：{{ post.policyTitle }}</span>
                  </div>
                  <h3 class="font-bold text-lg text-navy-900 mb-2 group-hover:text-blue-600 transition-colors">{{ post.title }}</h3>
                  <p class="text-slate-600 text-sm leading-relaxed mb-4 line-clamp-2">{{ post.content }}</p>
                  <div class="flex items-center gap-6 text-slate-400 text-xs font-medium">
                    <div class="flex items-center gap-1.5 hover:text-blue-500 transition-colors"><ThumbsUp :size="14" /> {{ post.likes }}</div>
                    <div class="flex items-center gap-1.5 hover:text-blue-500 transition-colors"><MessageSquare :size="14" /> {{ post.comments }} 留言</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
