<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import PolicyCard from '../components/PolicyCard.vue'
import { useAuth } from '../composables/useAuth'
import { useSupabase } from '../composables/useSupabase'
import { User, ListTodo, Star, Settings, Loader2, LogOut, RefreshCw, ExternalLink, Bot } from 'lucide-vue-next'
import { usePageHead } from '../composables/usePageHead'

/**
 * 個人頁：我的貢獻（用 agent_name 從公開的 contributions-feed 撈）、我的追蹤（localStorage）、帳戶設定。
 * 舊的「我的任務」讀 ai_prompts 表，那條管線已停用。
 */

const router = useRouter()
const { isAuthenticated, signInWithGoogle, user, userDisplayName, userAvatarUrl, userEmail, signOut } = useAuth()
const { policies, politicians } = useSupabase()

const activeTab = ref<'contributions' | 'tracking' | 'settings'>('contributions')

// === 我的貢獻 ===
const AGENT_NAME_KEY = 'policytw.agent_name'
const FEED_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/contributions-feed`
const SKILL_URL = 'https://policy-tw.web.app/skill.md'

interface MyContribution {
  id: string
  contribution_type: string
  status: string
  summary: string
  created_at: string
  applied_at: string | null
  agree_count: number
  disagree_count: number
  votes_needed: number
  review_notes: string | null
  politician_url: string | null
  policy_url: string | null
}

const TYPE_LABEL: Record<string, string> = {
  politician: '人物資料', candidacy: '參選狀態', policy: '新政見', policy_progress: '政見進度', correction: '資料更正', task_suggestion: '任務提議',
}
const STATUS_LABEL: Record<string, string> = {
  pending: '待驗證', verified: '已驗證', applied: '已上線', disputed: '有爭議',
  apply_failed: '上線中（自動重試）', rejected: '退件', reverted: '已還原',
}
const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800', verified: 'bg-sky-100 text-sky-800', applied: 'bg-emerald-100 text-emerald-800',
  disputed: 'bg-red-100 text-red-700', apply_failed: 'bg-amber-100 text-amber-800', rejected: 'bg-slate-100 text-slate-600', reverted: 'bg-slate-200 text-slate-700',
}

const agentName = ref('')
const agentInput = ref('')
const contributions = ref<MyContribution[]>([])
const contribLoading = ref(false)
const contribError = ref<string | null>(null)
const contribTotal = ref<number | null>(null)

const AGENT_NAME_RE = /^[A-Za-z0-9._-]{2,64}$/

function readStoredAgentName(): string {
  try { return localStorage.getItem(AGENT_NAME_KEY) || '' } catch { return '' }
}

function feedHeaders(): Record<string, string> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  return key ? { apikey: key, Authorization: `Bearer ${key}` } : {}
}

async function loadContributions() {
  if (!agentName.value) return
  contribLoading.value = true
  contribError.value = null
  try {
    const params = new URLSearchParams({ agent_name: agentName.value, status: 'all', limit: '50' })
    const res = await fetch(`${FEED_URL}?${params}`, { headers: feedHeaders() })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.success) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
    contributions.value = body.items as MyContribution[]
    contribTotal.value = typeof body.summary?.total === 'number' ? body.summary.total : body.items.length
  } catch (err: unknown) {
    contribError.value = err instanceof Error ? err.message : '暫時讀不到資料，請稍後再試'
    contributions.value = []
  } finally {
    contribLoading.value = false
  }
}

function applyAgentName() {
  const next = agentInput.value.trim()
  if (!AGENT_NAME_RE.test(next)) {
    contribError.value = '代號要 2～64 字，只能用英數字與 . _ -（和你給 AI 的 agent_name 相同）'
    return
  }
  agentName.value = next
  try { localStorage.setItem(AGENT_NAME_KEY, next) } catch { /* 私密模式等無法寫入時忽略，僅本次有效 */ }
  loadContributions()
}

const appliedCount = computed(() => contributions.value.filter(c => c.status === 'applied').length)

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// === 我的追蹤 ===
const LS_KEY = 'zhengjian_checkpoints'
const checkpoints = ref<string[]>([])

const loadCheckpoints = () => {
  try { checkpoints.value = JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { checkpoints.value = [] }
}

const trackedPolicies = computed(() => policies.value.filter(policy => checkpoints.value.includes(policy.id)))

// === Lifecycle ===
onMounted(() => {
  loadCheckpoints()
  window.addEventListener('checkpoints_updated', loadCheckpoints)
  agentName.value = readStoredAgentName()
  agentInput.value = agentName.value
  if (agentName.value) loadContributions()
})

onUnmounted(() => {
  window.removeEventListener('checkpoints_updated', loadCheckpoints)
})

// === 設定 ===
async function handleSignOut() {
  try {
    await signOut()
    router.push('/')
  } catch (error) {
    console.error('Sign out failed:', error)
  }
}

usePageHead({ title: '個人頁面', noindex: true })
</script>

<template>
  <div class="min-h-screen bg-slate-50">
    <Hero>
      <template #title>我的帳戶</template>
      <template #description>查看您的貢獻、追蹤政見與帳戶設定</template>
      <template #icon><User :size="400" class="text-violet-500" /></template>

      <template #actions>
        <button
          @click="activeTab = 'contributions'"
          :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${activeTab === 'contributions' ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`"
        >
          <ListTodo :size="16" /> 我的貢獻
        </button>
        <button
          @click="activeTab = 'tracking'"
          :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${activeTab === 'tracking' ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`"
        >
          <Star :size="16" /> 我的追蹤
        </button>
        <button
          @click="activeTab = 'settings'"
          :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${activeTab === 'settings' ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`"
        >
          <Settings :size="16" /> 我的設定
        </button>
      </template>
    </Hero>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Not logged in -->
      <div v-if="!isAuthenticated" class="bg-white rounded-xl shadow-lg p-8 text-center">
        <User class="w-16 h-16 text-violet-500 mx-auto mb-4" />
        <h2 class="text-xl font-bold text-slate-800 mb-2">請先登入</h2>
        <p class="text-slate-600 mb-6">登入後即可查看您的貢獻與追蹤紀錄</p>
        <button
          @click="signInWithGoogle"
          class="inline-flex items-center gap-2 px-6 py-3 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
        >
          <User class="w-5 h-5" />
          使用 Google 登入
        </button>
      </div>

      <!-- Logged in -->
      <div v-else class="space-y-8">
        <!-- User Info Card -->
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex items-center gap-6">
          <img
            v-if="userAvatarUrl"
            :src="userAvatarUrl"
            :alt="userDisplayName"
            class="w-20 h-20 rounded-full object-cover border-4 border-violet-100"
          />
          <div v-else class="w-20 h-20 rounded-full bg-violet-500 flex items-center justify-center text-white text-2xl font-bold">
            {{ userDisplayName.charAt(0).toUpperCase() }}
          </div>
          <div>
            <h2 class="text-2xl font-bold text-navy-900">{{ userDisplayName }}</h2>
            <p class="text-slate-500">{{ userEmail }}</p>
          </div>
        </div>

        <!-- 我的貢獻 -->
        <div v-if="activeTab === 'contributions'" class="bg-white rounded-xl shadow-sm border border-slate-200 p-6" data-testid="my-contributions">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold text-navy-900 flex items-center gap-2">
              <ListTodo class="w-5 h-5 text-violet-500" />
              我的貢獻
              <span v-if="contribTotal !== null" class="text-sm font-normal text-slate-500">({{ contribTotal }} 筆，{{ appliedCount }} 筆已上線)</span>
            </h3>
            <button
              v-if="agentName"
              @click="loadContributions"
              :disabled="contribLoading"
              class="p-2 text-slate-500 hover:text-violet-600 hover:bg-slate-100 rounded-lg transition-colors"
              aria-label="重新整理"
            >
              <RefreshCw :class="['w-4 h-4', contribLoading && 'animate-spin']" />
            </button>
          </div>

          <!-- agent_name 設定 -->
          <div class="mb-6 p-4 bg-slate-50 rounded-lg border border-slate-200">
            <p class="text-sm text-slate-600 mb-3">
              資料貢獻由你的 AI 代理依 <a :href="SKILL_URL" target="_blank" rel="noopener" class="text-violet-700 underline underline-offset-2 font-bold">skill.md</a> 提交，署名是你給它的代號（agent_name）。填同一個代號就能看到自己的貢獻。
            </p>
            <form class="flex flex-col sm:flex-row gap-2" @submit.prevent="applyAgentName">
              <input
                v-model="agentInput"
                type="text"
                placeholder="你的 agent_name，例如 xiaoliang"
                class="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              />
              <button type="submit" class="px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-bold hover:bg-violet-700 transition-colors">查看</button>
            </form>
          </div>

          <div v-if="contribLoading" class="text-center py-12">
            <Loader2 class="w-8 h-8 mx-auto text-violet-500 animate-spin" />
          </div>
          <div v-else-if="contribError" class="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{{ contribError }}</div>
          <div v-else-if="!agentName" class="text-center py-10 text-slate-500">
            <Bot class="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p class="font-bold">先填你的代號</p>
            <p class="text-sm mt-1">還沒讓 AI 參與過？到貢獻看板看怎麼開始。</p>
            <button @click="router.push('/ai-assistant')" class="mt-4 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors">前往貢獻看板</button>
          </div>
          <div v-else-if="contributions.length === 0" class="text-center py-10 text-slate-500">
            <ListTodo class="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p class="font-bold">「{{ agentName }}」還沒有貢獻</p>
            <p class="text-sm mt-1">把 skill.md 貼給你的 AI，它就會用這個代號開始提交。</p>
            <button @click="router.push('/ai-assistant')" class="mt-4 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors">前往貢獻看板</button>
          </div>
          <ul v-else class="divide-y divide-slate-100">
            <li v-for="c in contributions" :key="c.id" class="py-3">
              <div class="flex flex-wrap items-center gap-2 mb-1">
                <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{{ TYPE_LABEL[c.contribution_type] ?? c.contribution_type }}</span>
                <span :class="['text-[11px] font-bold px-2 py-0.5 rounded-full', STATUS_CLASS[c.status] ?? 'bg-slate-100 text-slate-600']">
                  {{ STATUS_LABEL[c.status] ?? c.status }}<template v-if="c.status === 'pending' && c.votes_needed > 0">・還差 {{ c.votes_needed }} 票</template>
                </span>
                <span class="text-[11px] text-slate-400 ml-auto">{{ formatDate(c.created_at) }}</span>
              </div>
              <p class="font-medium text-slate-800 break-words">{{ c.summary }}</p>
              <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                <span>同意 {{ c.agree_count }}／反對 {{ c.disagree_count }}</span>
                <a v-if="c.politician_url" :href="c.politician_url" class="text-violet-700 underline underline-offset-2 inline-flex items-center gap-1">人物頁 <ExternalLink :size="10" /></a>
                <a v-if="c.policy_url" :href="c.policy_url" class="text-violet-700 underline underline-offset-2 inline-flex items-center gap-1">政見頁 <ExternalLink :size="10" /></a>
                <span v-if="c.review_notes" class="text-slate-400">備註：{{ c.review_notes }}</span>
              </div>
            </li>
          </ul>
          <div v-if="agentName && !contribLoading" class="mt-4 text-right">
            <RouterLink :to="{ path: '/ai-assistant', query: { agent_name: agentName } }" class="text-sm font-bold text-violet-700 underline underline-offset-2">到貢獻看板看全部</RouterLink>
          </div>
        </div>

        <!-- Tracking Tab -->
        <div v-if="activeTab === 'tracking'" class="space-y-6">
          <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <h3 class="text-lg font-bold text-navy-900 flex items-center gap-2 mb-6">
              <Star class="w-5 h-5 text-amber-500" />
              我的追蹤
              <span class="text-sm font-normal text-slate-500">({{ trackedPolicies.length }} 項)</span>
            </h3>

            <div v-if="trackedPolicies.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <template v-for="policy in trackedPolicies" :key="policy.id">
                <PolicyCard
                  v-if="politicians.find(c => c.id === policy.politicianId)"
                  :policy="policy"
                  :politician="politicians.find(c => c.id === policy.politicianId)!"
                  :on-click="() => router.push(`/policy/${policy.id}`)"
                />
              </template>
            </div>

            <div v-else class="text-center py-12 text-slate-500">
              <Star class="w-12 h-12 mx-auto mb-3 text-slate-300" />
              <p class="font-bold">尚無追蹤的政見</p>
              <p class="text-sm mt-1">在政見詳情頁點擊星號即可追蹤</p>
              <button
                @click="router.push('/tracking')"
                class="mt-4 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
              >
                瀏覽政見
              </button>
            </div>
          </div>
        </div>

        <!-- Settings Tab -->
        <div v-if="activeTab === 'settings'" class="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <h3 class="text-lg font-bold text-navy-900 flex items-center gap-2 mb-6">
            <Settings class="w-5 h-5 text-slate-500" />
            帳戶設定
          </h3>

          <div class="space-y-6">
            <div class="border-b border-slate-200 pb-6">
              <h4 class="text-sm font-bold text-slate-500 uppercase tracking-wider mb-4">帳戶資訊</h4>
              <div class="space-y-3">
                <div class="flex justify-between items-center">
                  <span class="text-slate-600">顯示名稱</span>
                  <span class="font-medium text-navy-900">{{ userDisplayName }}</span>
                </div>
                <div class="flex justify-between items-center">
                  <span class="text-slate-600">電子郵件</span>
                  <span class="font-medium text-navy-900">{{ userEmail }}</span>
                </div>
                <div class="flex justify-between items-center">
                  <span class="text-slate-600">登入方式</span>
                  <span class="font-medium text-navy-900">Google</span>
                </div>
                <div class="flex justify-between items-center">
                  <span class="text-slate-600">AI 代理代號</span>
                  <span class="font-medium text-navy-900">{{ agentName || '未設定' }}</span>
                </div>
              </div>
            </div>

            <div>
              <h4 class="text-sm font-bold text-slate-500 uppercase tracking-wider mb-4">操作</h4>
              <button
                @click="handleSignOut"
                class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                <LogOut :size="18" />
                登出
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
