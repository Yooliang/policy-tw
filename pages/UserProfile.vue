<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import PolicyCard from '../components/PolicyCard.vue'
import { useAuth } from '../composables/useAuth'
import { useSupabase } from '../composables/useSupabase'
import { supabase } from '../lib/supabase'
import { PolicyStatus } from '../types'
import {
  User,
  ListTodo,
  Star,
  Settings,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  ChevronRight,
  LogOut,
  RefreshCw,
  FileText,
  Search,
  Shield,
  Sparkles,
  ExternalLink,
} from 'lucide-vue-next'

const router = useRouter()
const { isAuthenticated, signInWithGoogle, user, userDisplayName, userAvatarUrl, userEmail, signOut } = useAuth()
const { policies, politicians } = useSupabase()

// Tabs
const activeTab = ref<'tasks' | 'tracking' | 'settings'>('tasks')

// === Tasks Tab ===
const tasks = ref<any[]>([])
const tasksLoading = ref(false)
const tasksPage = ref(0)
const tasksPageSize = 10
const hasMoreTasks = ref(true)

// Daily task limit
const DAILY_TASK_LIMIT = 20
const todayTaskCount = ref(0)

// Selected task result
const selectedTask = ref<any>(null)
const showResultModal = ref(false)

// Task type labels
const taskTypeLabels: Record<string, string> = {
  candidate_search: '候選人搜尋',
  policy_search: '政見搜尋',
  policy_verify: '政見驗證',
  progress_tracking: '進度追蹤',
  policy_import: '政見匯入',
  user_contribution: '使用者貢獻',
}

// Determine effective status
function getEffectiveStatus(task: any): string {
  if (task.status === 'failed' && (task.result_summary || task.result_data)) {
    return 'completed'
  }
  return task.status
}

function getStatusLabel(status: string, task?: any): string {
  const effectiveStatus = task ? getEffectiveStatus(task) : status
  switch (effectiveStatus) {
    case 'pending': return '等待中'
    case 'processing': return '處理中'
    case 'completed': return '已完成'
    case 'failed': return '失敗'
    default: return effectiveStatus
  }
}

function getStatusColor(status: string, task?: any): string {
  const effectiveStatus = task ? getEffectiveStatus(task) : status
  switch (effectiveStatus) {
    case 'completed': return 'bg-emerald-100 text-emerald-700'
    case 'processing': return 'bg-blue-100 text-blue-700'
    case 'pending': return 'bg-amber-100 text-amber-700'
    case 'failed': return 'bg-red-100 text-red-700'
    default: return 'bg-slate-100 text-slate-700'
  }
}

function getTaskIcon(taskType: string) {
  switch (taskType) {
    case 'candidate_search': return Search
    case 'policy_verify': return Shield
    case 'policy_import': return FileText
    default: return Sparkles
  }
}

async function fetchTodayTaskCount() {
  if (!user.value) return

  try {
    // Get start of today in ISO format
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayIso = today.toISOString()

    const { count, error } = await supabase
      .from('ai_prompts')
      .select('*', { count: 'exact', head: true })
      .eq('created_by', user.value.id)
      .gte('created_at', todayIso)

    if (error) throw error
    todayTaskCount.value = count || 0
  } catch (err: any) {
    console.error('Failed to fetch today task count:', err)
  }
}

async function fetchTasks(reset = false) {
  if (!user.value) return

  if (reset) {
    tasksPage.value = 0
    tasks.value = []
    // Also refresh today's count
    fetchTodayTaskCount()
  }

  tasksLoading.value = true
  try {
    const from = tasksPage.value * tasksPageSize
    const to = from + tasksPageSize - 1

    const { data, error } = await supabase
      .from('ai_prompts')
      .select('*')
      .eq('created_by', user.value.id)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    if (data.length < tasksPageSize) {
      hasMoreTasks.value = false
    }

    if (reset) {
      tasks.value = data
    } else {
      tasks.value = [...tasks.value, ...data]
    }
  } catch (err: any) {
    console.error('Failed to fetch tasks:', err)
  } finally {
    tasksLoading.value = false
  }
}

function loadMoreTasks() {
  tasksPage.value++
  fetchTasks()
}

function viewTaskResult(task: any) {
  selectedTask.value = task
  showResultModal.value = true
}

function closeResultModal() {
  showResultModal.value = false
  selectedTask.value = null
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// === Tracking Tab ===
const LS_KEY = 'zhengjian_checkpoints'
const checkpoints = ref<string[]>([])

const loadCheckpoints = () => {
  checkpoints.value = JSON.parse(localStorage.getItem(LS_KEY) || '[]')
}

const trackedPolicies = computed(() => {
  return policies.value.filter(policy => checkpoints.value.includes(policy.id))
})

// === Lifecycle ===
onMounted(() => {
  loadCheckpoints()
  window.addEventListener('checkpoints_updated', loadCheckpoints)
  if (user.value) {
    fetchTasks(true)
  }
})

onUnmounted(() => {
  window.removeEventListener('checkpoints_updated', loadCheckpoints)
})

watch(user, (newUser) => {
  if (newUser) {
    fetchTasks(true)
  }
})

// === Settings ===
async function handleSignOut() {
  try {
    await signOut()
    router.push('/')
  } catch (error) {
    console.error('Sign out failed:', error)
  }
}
</script>

<template>
  <div class="min-h-screen bg-slate-50">
    <Hero>
      <template #title>我的帳戶</template>
      <template #description>管理您的任務、追蹤政見與帳戶設定</template>
      <template #icon><User :size="400" class="text-violet-500" /></template>

      <template #actions>
        <button
          @click="activeTab = 'tasks'"
          :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${activeTab === 'tasks' ? 'bg-white text-navy-900 shadow-lg' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'}`"
        >
          <ListTodo :size="16" /> 我的任務
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
        <p class="text-slate-600 mb-6">登入後即可查看您的任務與追蹤紀錄</p>
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

        <!-- Tasks Tab -->
        <div v-if="activeTab === 'tasks'" class="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold text-navy-900 flex items-center gap-2">
              <ListTodo class="w-5 h-5 text-violet-500" />
              我的任務
            </h3>
            <button
              @click="fetchTasks(true)"
              :disabled="tasksLoading"
              class="p-2 text-slate-500 hover:text-violet-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <RefreshCw :class="['w-4 h-4', tasksLoading && 'animate-spin']" />
            </button>
          </div>

          <!-- Daily usage indicator -->
          <div class="mb-6 p-4 bg-slate-50 rounded-lg border border-slate-200">
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-medium text-slate-600">今日使用額度</span>
              <span :class="['text-sm font-bold', todayTaskCount >= DAILY_TASK_LIMIT ? 'text-red-600' : 'text-violet-600']">
                {{ todayTaskCount }} / {{ DAILY_TASK_LIMIT }}
              </span>
            </div>
            <div class="w-full bg-slate-200 rounded-full h-2">
              <div
                class="h-2 rounded-full transition-all duration-300"
                :class="todayTaskCount >= DAILY_TASK_LIMIT ? 'bg-red-500' : 'bg-violet-500'"
                :style="{ width: `${Math.min((todayTaskCount / DAILY_TASK_LIMIT) * 100, 100)}%` }"
              ></div>
            </div>
            <p v-if="todayTaskCount >= DAILY_TASK_LIMIT" class="text-xs text-red-600 mt-2">
              已達今日上限，請明天再試
            </p>
            <p v-else class="text-xs text-slate-500 mt-2">
              每位用戶每日可提交 {{ DAILY_TASK_LIMIT }} 個任務
            </p>
          </div>

          <!-- Task list -->
          <div v-if="tasks.length > 0" class="space-y-3">
            <div
              v-for="task in tasks"
              :key="task.id"
              @click="viewTaskResult(task)"
              class="flex items-center justify-between p-4 bg-slate-50 rounded-lg hover:bg-slate-100 cursor-pointer transition-colors"
            >
              <div class="flex items-center gap-3 min-w-0">
                <component :is="getTaskIcon(task.task_type)" class="w-6 h-6 text-slate-400 flex-shrink-0" />
                <div class="min-w-0">
                  <p class="font-medium text-slate-800 truncate">
                    {{ task.user_input || task.prompt_template || taskTypeLabels[task.task_type] }}
                  </p>
                  <p class="text-sm text-slate-500">
                    {{ formatDate(task.created_at) }} · {{ taskTypeLabels[task.task_type] }}
                  </p>
                </div>
              </div>

              <div class="flex items-center gap-2 flex-shrink-0">
                <span :class="['px-2 py-0.5 rounded text-xs font-medium', getStatusColor(task.status, task)]">
                  {{ getStatusLabel(task.status, task) }}
                </span>
                <ChevronRight class="w-4 h-4 text-slate-400" />
              </div>
            </div>

            <!-- Load more -->
            <button
              v-if="hasMoreTasks"
              @click="loadMoreTasks"
              :disabled="tasksLoading"
              class="w-full py-2 text-violet-600 hover:bg-violet-50 rounded-lg transition-colors"
            >
              {{ tasksLoading ? '載入中...' : '載入更多' }}
            </button>
          </div>

          <!-- Empty state -->
          <div v-else-if="!tasksLoading" class="text-center py-12 text-slate-500">
            <ListTodo class="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p class="font-bold">尚無任務記錄</p>
            <p class="text-sm mt-1">前往 AI 查核提交您的第一個任務</p>
            <button
              @click="router.push('/ai-assistant')"
              class="mt-4 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
            >
              前往 AI 查核
            </button>
          </div>

          <!-- Loading -->
          <div v-else class="text-center py-12">
            <Loader2 class="w-8 h-8 mx-auto text-violet-500 animate-spin" />
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

    <!-- Result Modal -->
    <Teleport to="body">
      <div
        v-if="showResultModal && selectedTask"
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
        @click.self="closeResultModal"
      >
        <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col">
          <!-- Modal header -->
          <div class="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <h3 class="text-lg font-bold text-slate-800">
              {{ taskTypeLabels[selectedTask.task_type] || '任務結果' }}
            </h3>
            <button @click="closeResultModal" class="p-2 hover:bg-slate-100 rounded-lg transition-colors">
              <XCircle class="w-5 h-5 text-slate-500" />
            </button>
          </div>

          <!-- Modal content -->
          <div class="p-6 overflow-y-auto flex-1">
            <!-- Task info -->
            <div class="mb-6 space-y-2">
              <div class="flex items-center gap-2">
                <span :class="['px-2 py-0.5 rounded text-xs font-medium', getStatusColor(selectedTask.status, selectedTask)]">
                  {{ getStatusLabel(selectedTask.status, selectedTask) }}
                </span>
                <span class="text-sm text-slate-500">{{ formatDate(selectedTask.created_at) }}</span>
              </div>

              <p v-if="selectedTask.user_input" class="text-slate-600">
                <strong>輸入：</strong>{{ selectedTask.user_input }}
              </p>

              <p v-if="selectedTask.source_url" class="text-slate-600">
                <strong>網址：</strong>
                <a :href="selectedTask.source_url" target="_blank" class="text-violet-600 hover:underline inline-flex items-center gap-1">
                  {{ selectedTask.source_url.substring(0, 50) }}...
                  <ExternalLink class="w-3 h-3" />
                </a>
              </p>
            </div>

            <!-- Result summary -->
            <div v-if="selectedTask.result_summary" class="mb-6">
              <h4 class="font-medium text-slate-800 mb-2">摘要</h4>
              <p class="text-slate-600 bg-slate-50 p-4 rounded-lg">{{ selectedTask.result_summary }}</p>
            </div>

            <!-- Result data -->
            <div v-if="selectedTask.result_data">
              <!-- Candidates -->
              <div v-if="selectedTask.result_data.candidates?.length" class="mb-6">
                <h4 class="font-medium text-slate-800 mb-3">候選人 ({{ selectedTask.result_data.candidates.length }})</h4>
                <div class="space-y-2">
                  <div
                    v-for="(candidate, index) in selectedTask.result_data.candidates"
                    :key="index"
                    class="p-3 bg-slate-50 rounded-lg"
                  >
                    <div class="flex items-center justify-between">
                      <span class="font-medium">{{ candidate.name }}</span>
                      <span class="text-sm text-slate-500">{{ candidate.party }}</span>
                    </div>
                    <p v-if="candidate.note" class="text-sm text-slate-600 mt-1">{{ candidate.note }}</p>
                  </div>
                </div>
              </div>

              <!-- Sources -->
              <div v-if="selectedTask.result_data.sources?.length" class="mb-6">
                <h4 class="font-medium text-slate-800 mb-2">來源</h4>
                <ul class="space-y-1">
                  <li v-for="(source, index) in selectedTask.result_data.sources" :key="index">
                    <a :href="source" target="_blank" class="text-sm text-violet-600 hover:underline inline-flex items-center gap-1">
                      {{ source.substring(0, 60) }}...
                      <ExternalLink class="w-3 h-3" />
                    </a>
                  </li>
                </ul>
              </div>
            </div>

            <!-- Error message -->
            <div v-if="selectedTask.error_message && getEffectiveStatus(selectedTask) === 'failed'" class="p-4 bg-red-50 text-red-700 rounded-lg">
              <strong>錯誤：</strong>{{ selectedTask.error_message }}
            </div>

            <!-- Pending/Processing state -->
            <div v-if="getEffectiveStatus(selectedTask) === 'pending' || getEffectiveStatus(selectedTask) === 'processing'" class="text-center py-8">
              <Loader2 class="w-12 h-12 mx-auto text-violet-500 animate-spin mb-4" />
              <p class="text-slate-600">任務處理中，請稍候...</p>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
