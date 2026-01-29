<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import StatusBadge from '../components/StatusBadge.vue'
import Avatar from '../components/Avatar.vue'
import { useSupabase } from '../composables/useSupabase'
import {
  MessageSquare, ThumbsUp, Eye, ArrowLeft, Bookmark,
  Clock, TrendingUp, ChevronDown, ChevronUp, Loader2
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const { discussions, policies, loading } = useSupabase()


const discussionId = computed(() => Number(route.params.discussionId))
const discussion = computed(() => discussions.value.find(d => d.id === discussionId.value))
const policy = computed(() => policies.value.find(p => p.id === discussion.value?.policyId))
const relatedDiscussions = computed(() =>
  discussions.value.filter(d => d.policyId === discussion.value?.policyId && d.id !== discussion.value?.id)
)

const commentSort = ref<'latest' | 'hot'>('latest')

const sortedComments = computed(() => {
  if (!discussion.value) return []
  const list = [...discussion.value.comments]
  if (commentSort.value === 'hot') {
    list.sort((a, b) => b.likes - a.likes)
  }
  return list
})

const totalCommentCount = computed(() => {
  if (!discussion.value) return 0
  return discussion.value.comments.reduce((sum, c) => sum + 1 + c.replies.length, 0)
})

// localStorage likes
const LS_DISC = 'zhengjian_discussion_likes'
const LS_COMM = 'zhengjian_comment_likes'

const likedDiscussions = ref<number[]>([])
const likedComments = ref<number[]>([])

onMounted(() => {
  try {
    const sd = localStorage.getItem(LS_DISC)
    if (sd) likedDiscussions.value = JSON.parse(sd)
  } catch { /* ignore */ }
  try {
    const sc = localStorage.getItem(LS_COMM)
    if (sc) likedComments.value = JSON.parse(sc)
  } catch { /* ignore */ }
})

function toggleDiscussionLike() {
  if (!discussion.value) return
  const id = discussion.value.id
  const idx = likedDiscussions.value.indexOf(id)
  if (idx >= 0) likedDiscussions.value.splice(idx, 1)
  else likedDiscussions.value.push(id)
  localStorage.setItem(LS_DISC, JSON.stringify(likedDiscussions.value))
}

function isDiscussionLiked() {
  return discussion.value ? likedDiscussions.value.includes(discussion.value.id) : false
}

function toggleCommentLike(id: number) {
  const idx = likedComments.value.indexOf(id)
  if (idx >= 0) likedComments.value.splice(idx, 1)
  else likedComments.value.push(id)
  localStorage.setItem(LS_COMM, JSON.stringify(likedComments.value))
}

function isCommentLiked(id: number) {
  return likedComments.value.includes(id)
}

function getCommentLikeCount(baseLikes: number, id: number) {
  return baseLikes + (isCommentLiked(id) ? 1 : 0)
}

function getDiscussionLikeCount() {
  if (!discussion.value) return 0
  return discussion.value.likes + (isDiscussionLiked() ? 1 : 0)
}

// collapse state for replies
const collapsedComments = ref<Set<number>>(new Set())
function toggleReplies(commentId: number) {
  if (collapsedComments.value.has(commentId)) {
    collapsedComments.value.delete(commentId)
  } else {
    collapsedComments.value.add(commentId)
  }
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <template v-if="discussion">
      <Hero :backAction="() => router.push('/community')">
        <template #badge>公民討論</template>
        <template #title>{{ discussion.title }}</template>
        <template #description>
          針對：<button @click="router.push('/policy/' + discussion.policyId)" class="underline hover:text-blue-300 transition-colors">{{ discussion.policyTitle }}</button>
        </template>
        <template #icon><MessageSquare :size="400" class="text-blue-500" /></template>

        <div class="flex flex-wrap items-center gap-4 text-sm">
          <span v-for="tag in discussion.tags" :key="tag" class="px-3 py-1 bg-white/10 rounded-full text-white/80 text-xs border border-white/20">{{ tag }}</span>
          <div class="flex items-center gap-6 text-white/60 ml-auto">
            <span class="flex items-center gap-1.5"><ThumbsUp :size="14" /> {{ getDiscussionLikeCount() }}</span>
            <span class="flex items-center gap-1.5"><MessageSquare :size="14" /> {{ totalCommentCount }}</span>
            <span class="flex items-center gap-1.5"><Eye :size="14" /> {{ discussion.viewCount }}</span>
          </div>
        </div>
      </Hero>

      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left">

          <!-- Main content -->
          <div class="lg:col-span-2 space-y-8">
            <!-- Discussion body -->
            <div class="bg-white p-8 rounded-xl border border-slate-200 shadow-sm">
              <div class="flex items-center gap-4 mb-6">
                <Avatar :src="discussion.author.avatarUrl" :name="discussion.author.name" size="md" class="border-2 border-slate-100" />
                <div>
                  <p class="font-bold text-slate-800">{{ discussion.author.name }}</p>
                  <p class="text-slate-400 text-xs flex items-center gap-1"><Clock :size="12" /> {{ discussion.createdAt }}</p>
                </div>
              </div>
              <div class="prose prose-slate max-w-none mb-6">
                <p v-for="(paragraph, i) in discussion.content.split('\n').filter(Boolean)" :key="i" class="text-slate-700 leading-relaxed mb-3">{{ paragraph }}</p>
              </div>
              <div class="flex flex-wrap gap-2 mb-6">
                <span v-for="tag in discussion.tags" :key="tag" class="px-3 py-1 bg-slate-50 text-slate-500 text-xs rounded-full border border-slate-100">{{ tag }}</span>
              </div>
              <div class="flex items-center gap-4 pt-4 border-t border-slate-100">
                <button
                  @click="toggleDiscussionLike"
                  :class="['flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all', isDiscussionLiked() ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-slate-50 text-slate-500 hover:bg-blue-50 hover:text-blue-600 border border-slate-200']"
                >
                  <ThumbsUp :size="16" :fill="isDiscussionLiked() ? 'currentColor' : 'none'" />
                  {{ getDiscussionLikeCount() }}
                </button>
                <button class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-slate-50 text-slate-500 hover:bg-amber-50 hover:text-amber-600 border border-slate-200 transition-all">
                  <Bookmark :size="16" /> 收藏
                </button>
              </div>
            </div>

            <!-- Comments section -->
            <div class="bg-white p-8 rounded-xl border border-slate-200 shadow-sm">
              <div class="flex items-center justify-between mb-6">
                <h2 class="text-lg font-bold text-navy-900">留言 ({{ totalCommentCount }})</h2>
                <div class="flex gap-2">
                  <button
                    @click="commentSort = 'latest'"
                    :class="['px-3 py-1 rounded-lg text-xs font-bold transition-all', commentSort === 'latest' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:text-blue-500']"
                  >最新</button>
                  <button
                    @click="commentSort = 'hot'"
                    :class="['px-3 py-1 rounded-lg text-xs font-bold transition-all', commentSort === 'hot' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:text-blue-500']"
                  >最熱門</button>
                </div>
              </div>

              <div class="space-y-6">
                <div v-for="comment in sortedComments" :key="comment.id">
                  <!-- Comment -->
                  <div class="flex gap-4">
                    <Avatar :src="comment.author.avatarUrl" :name="comment.author.name" size="sm" class="border border-slate-100 shrink-0" />
                    <div class="flex-1">
                      <div class="flex items-center gap-2 mb-1">
                        <span class="font-bold text-sm text-slate-800">{{ comment.author.name }}</span>
                        <span class="text-slate-400 text-xs">{{ comment.createdAt }}</span>
                      </div>
                      <p class="text-slate-600 text-sm leading-relaxed mb-2">{{ comment.content }}</p>
                      <div class="flex items-center gap-4 text-xs text-slate-400">
                        <button
                          @click="toggleCommentLike(comment.id)"
                          :class="['flex items-center gap-1 transition-colors', isCommentLiked(comment.id) ? 'text-blue-500' : 'hover:text-blue-500']"
                        >
                          <ThumbsUp :size="12" :fill="isCommentLiked(comment.id) ? 'currentColor' : 'none'" />
                          {{ getCommentLikeCount(comment.likes, comment.id) }}
                        </button>
                        <button
                          v-if="comment.replies.length > 0"
                          @click="toggleReplies(comment.id)"
                          class="flex items-center gap-1 hover:text-blue-500 transition-colors"
                        >
                          <component :is="collapsedComments.has(comment.id) ? ChevronDown : ChevronUp" :size="12" />
                          {{ comment.replies.length }} 則回覆
                        </button>
                        <span v-else class="text-slate-300">0 則回覆</span>
                      </div>

                      <!-- Replies -->
                      <div v-if="comment.replies.length > 0 && !collapsedComments.has(comment.id)" class="ml-8 mt-4 space-y-4 border-l-2 border-slate-100 pl-4">
                        <div v-for="reply in comment.replies" :key="reply.id" class="flex gap-3">
                          <Avatar :src="reply.author.avatarUrl" :name="reply.author.name" class="w-8 h-8 border border-slate-100 shrink-0" />
                          <div class="flex-1">
                            <div class="flex items-center gap-2 mb-1">
                              <span class="font-bold text-xs text-slate-800">{{ reply.author.name }}</span>
                              <span class="text-slate-400 text-[10px]">{{ reply.createdAt }}</span>
                            </div>
                            <p class="text-slate-600 text-xs leading-relaxed mb-1">{{ reply.content }}</p>
                            <button
                              @click="toggleCommentLike(reply.id)"
                              :class="['flex items-center gap-1 text-[10px] transition-colors', isCommentLiked(reply.id) ? 'text-blue-500' : 'text-slate-400 hover:text-blue-500']"
                            >
                              <ThumbsUp :size="10" :fill="isCommentLiked(reply.id) ? 'currentColor' : 'none'" />
                              {{ getCommentLikeCount(reply.likes, reply.id) }}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Login placeholder -->
              <div class="mt-8 p-4 bg-slate-50 rounded-xl border border-dashed border-slate-200 text-center">
                <p class="text-slate-400 text-sm">登入後即可留言參與討論</p>
              </div>
            </div>
          </div>

          <!-- Sidebar -->
          <div class="lg:col-span-1 space-y-6">
            <!-- Related policy -->
            <div v-if="policy" class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 class="font-bold text-navy-900 mb-4">相關政見</h3>
              <div
                @click="router.push('/policy/' + policy.id)"
                class="cursor-pointer group"
              >
                <div class="flex items-center justify-between mb-2">
                  <h4 class="font-bold text-sm text-slate-800 group-hover:text-blue-600 transition-colors line-clamp-2">{{ policy.title }}</h4>
                  <StatusBadge :status="policy.status" />
                </div>
                <div class="w-full bg-slate-100 rounded-full h-2 mb-2">
                  <div class="bg-blue-500 h-2 rounded-full transition-all" :style="{ width: policy.progress + '%' }"></div>
                </div>
                <p class="text-slate-400 text-xs">進度 {{ policy.progress }}%</p>
              </div>
            </div>

            <!-- Other discussions on same policy -->
            <div v-if="relatedDiscussions.length > 0" class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 class="font-bold text-navy-900 mb-4">同政見討論</h3>
              <ul class="space-y-3">
                <li v-for="rd in relatedDiscussions" :key="rd.id">
                  <a
                    @click.prevent="router.push('/community/' + rd.id)"
                    href="#"
                    class="text-sm text-slate-600 hover:text-blue-600 transition-colors line-clamp-2 block cursor-pointer"
                  >{{ rd.title }}</a>
                  <div class="flex items-center gap-3 text-[10px] text-slate-400 mt-1">
                    <span class="flex items-center gap-1"><ThumbsUp :size="10" /> {{ rd.likes }}</span>
                    <span class="flex items-center gap-1"><MessageSquare :size="10" /> {{ rd.comments.length }}</span>
                  </div>
                </li>
              </ul>
            </div>

            <!-- Discussion stats -->
            <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 class="font-bold text-navy-900 mb-4 flex items-center gap-2"><TrendingUp :size="18" class="text-blue-500" /> 討論統計</h3>
              <div class="space-y-3">
                <div class="flex items-center justify-between text-sm">
                  <span class="text-slate-500 flex items-center gap-2"><Eye :size="14" /> 觀看數</span>
                  <span class="font-bold text-slate-800">{{ discussion.viewCount.toLocaleString() }}</span>
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span class="text-slate-500 flex items-center gap-2"><ThumbsUp :size="14" /> 讚數</span>
                  <span class="font-bold text-slate-800">{{ getDiscussionLikeCount() }}</span>
                </div>
                <div class="flex items-center justify-between text-sm">
                  <span class="text-slate-500 flex items-center gap-2"><MessageSquare :size="14" /> 留言數</span>
                  <span class="font-bold text-slate-800">{{ totalCommentCount }}</span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </template>

    <!-- Loading -->
    <template v-else-if="loading">
      <div class="flex flex-col items-center justify-center min-h-screen text-slate-400">
        <Loader2 :size="48" class="mb-4 text-blue-500 animate-spin" />
        <p class="text-slate-500">載入中...</p>
      </div>
    </template>

    <!-- Not found -->
    <template v-else>

      <div class="flex flex-col items-center justify-center min-h-[60vh] text-slate-400">
        <MessageSquare :size="64" class="mb-4 opacity-30" />
        <p class="text-xl font-bold mb-2">找不到此討論</p>
        <button @click="router.push('/community')" class="flex items-center gap-2 text-blue-500 hover:text-blue-600 mt-4">
          <ArrowLeft :size="16" /> 回到討論列表
        </button>
      </div>
    </template>
  </div>
</template>
