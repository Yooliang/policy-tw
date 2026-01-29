<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import Avatar from '../components/Avatar.vue'
import { MessageSquare, ThumbsUp, TrendingUp, Search, Filter, PenTool, Eye } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'
import { useGlobalState } from '../composables/useGlobalState'
import type { Discussion } from '../types'

const route = useRoute()
const router = useRouter()
const { discussions, politicians, policies } = useSupabase()
const { globalRegion } = useGlobalState()
const initialFilter = computed(() => (route.query.filter as string) || '')

const activeTab = ref<'hot' | 'latest'>('hot')
const searchQuery = ref('')
const activeCategory = ref('')

const COMMUNITY_TAGS = ['居住正義', '交通', '教育', '經濟', '環保']

const LS_KEY = 'zhengjian_discussion_likes'

const likedIds = ref<number[]>([])

onMounted(() => {
  try {
    const stored = localStorage.getItem(LS_KEY)
    if (stored) likedIds.value = JSON.parse(stored)
  } catch { /* ignore */ }
})

function toggleLike(id: number, e: Event) {
  e.stopPropagation()
  const idx = likedIds.value.indexOf(id)
  if (idx >= 0) {
    likedIds.value.splice(idx, 1)
  } else {
    likedIds.value.push(id)
  }
  localStorage.setItem(LS_KEY, JSON.stringify(likedIds.value))
}

function isLiked(id: number) {
  return likedIds.value.includes(id)
}

function getLikeCount(post: Discussion) {
  return post.likes + (isLiked(post.id) ? 1 : 0)
}

const filteredDiscussions = computed(() => {
  let list = [...discussions.value]

  // Region filter (from global state)
  if (globalRegion.value !== 'All') {
    // Find policies linked to discussions, then politicians linked to policies
    // This requires us to look up discussion -> policy -> politician -> region
    list = list.filter(d => {
      // Find the policy for this discussion
      const policy = policies.value.find(p => String(p.id) === String(d.policyId))
      if (!policy) return false
      
      // Find the politician for this policy
      const politician = politicians.value.find(p => String(p.id) === String(policy.politicianId))
      if (!politician) return false
      
      return politician.region === globalRegion.value
    })
  }

  // policyTitle filter from query
  if (initialFilter.value) {

    list = list.filter(d => d.policyTitle.includes(initialFilter.value))
  }

  // search
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase()
    list = list.filter(d =>
      d.title.toLowerCase().includes(q) ||
      d.content.toLowerCase().includes(q) ||
      d.tags.some(t => t.toLowerCase().includes(q))
    )
  }

  // category filter
  if (activeCategory.value) {
    list = list.filter(d => d.tags.includes(activeCategory.value))
  }

  // sort
  if (activeTab.value === 'hot') {
    list.sort((a, b) => b.likes - a.likes)
  } else {
    list.sort((a, b) => b.createdAtTs - a.createdAtTs)
  }

  return list
})

const hotDiscussions = computed(() =>
  [...discussions.value].sort((a, b) => b.likes - a.likes).slice(0, 5)
)

function setCategory(tag: string) {
  activeCategory.value = tag === '全部' ? '' : tag
}

const clearFilter = () => {
  router.push('/community')
}

function getCommentCount(post: Discussion) {
  return post.comments.reduce((sum, c) => sum + 1 + c.replies.length, 0)
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>公民發聲</template>
      <template #description>這裡不只是政見的展示架，更是公民意志的集散地。針對每一項政策提出您的見解、疑問或支持，讓改變從對話開始。</template>
      <template #icon><MessageSquare :size="400" class="text-blue-500" /></template>

        <div class="space-y-6">
          <GlobalRegionSelector />

          <div class="flex flex-col lg:flex-row gap-6 items-center border-t border-slate-100 pt-6">
            <div class="relative flex-1 w-full text-left">
              <Search class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" :size="20" />
              <input v-model="searchQuery" type="text" placeholder="搜尋討論..." class="w-full pl-12 pr-4 py-3.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-blue-500 text-navy-900 font-bold placeholder:text-slate-400" />
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
              <li v-for="(d, i) in hotDiscussions" :key="d.id" class="text-sm">
                <a @click.prevent="router.push('/community/' + d.id)" href="#" class="flex gap-2 group cursor-pointer">
                  <span class="font-mono text-slate-400 font-bold">0{{ i + 1 }}</span>
                  <span class="text-slate-600 group-hover:text-blue-600 line-clamp-1">{{ d.title }}</span>
                </a>
              </li>
            </ul>
          </div>
          <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 class="font-bold text-navy-900 mb-4 flex items-center gap-2"><Filter class="text-blue-500" :size="20" /> 篩選類別</h3>
            <div class="flex flex-wrap gap-2">
              <span
                v-for="tag in ['全部', ...COMMUNITY_TAGS]"
                :key="tag"
                @click="setCategory(tag)"
                :class="[
                  'cursor-pointer px-3 py-1 text-xs rounded-full transition-colors',
                  (tag === '全部' && !activeCategory) || activeCategory === tag
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                ]"
              >{{ tag }}</span>
            </div>
          </div>
        </div>

        <div class="lg:col-span-3">
          <div v-if="filteredDiscussions.length === 0" class="text-center py-20 text-slate-400">
            <MessageSquare :size="48" class="mx-auto mb-4 opacity-50" />
            <p class="text-lg font-bold">找不到相關討論</p>
            <p class="text-sm mt-1">試試其他關鍵字或清除篩選條件</p>
          </div>
          <div class="space-y-6">
            <div
              v-for="post in filteredDiscussions"
              :key="post.id"
              @click="router.push('/community/' + post.id)"
              class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer group"
            >
              <div class="flex items-start gap-4">
                <Avatar :src="post.author.avatarUrl" :name="post.author.name" size="sm" class="border border-slate-100" />
                <div class="flex-1">
                  <div class="flex items-center justify-between mb-2">
                    <div><span class="font-bold text-slate-800 text-sm">{{ post.author.name }}</span><span class="text-slate-400 text-xs ml-2">· {{ post.createdAt }}</span></div>
                    <span class="bg-slate-100 text-slate-500 px-2 py-0.5 rounded text-[10px] group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors">針對：{{ post.policyTitle }}</span>
                  </div>
                  <h3 class="font-bold text-lg text-navy-900 mb-2 group-hover:text-blue-600 transition-colors">{{ post.title }}</h3>
                  <p class="text-slate-600 text-sm leading-relaxed mb-3 line-clamp-2">{{ post.content }}</p>
                  <div class="flex flex-wrap gap-2 mb-3">
                    <span v-for="tag in post.tags" :key="tag" class="px-2 py-0.5 bg-slate-50 text-slate-500 text-[11px] rounded-full border border-slate-100">{{ tag }}</span>
                  </div>
                  <div class="flex items-center gap-6 text-slate-400 text-xs font-medium">
                    <button
                      @click="toggleLike(post.id, $event)"
                      :class="['flex items-center gap-1.5 transition-colors', isLiked(post.id) ? 'text-blue-500' : 'hover:text-blue-500']"
                    >
                      <ThumbsUp :size="14" :fill="isLiked(post.id) ? 'currentColor' : 'none'" /> {{ getLikeCount(post) }}
                    </button>
                    <div class="flex items-center gap-1.5 hover:text-blue-500 transition-colors"><MessageSquare :size="14" /> {{ getCommentCount(post) }} 留言</div>
                    <div class="flex items-center gap-1.5"><Eye :size="14" /> {{ post.viewCount }}</div>
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
