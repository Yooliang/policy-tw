<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import { useAuth } from '../composables/useAuth'
import { supabase } from '../lib/supabase'
import {
  Sparkles,
  Send,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  History,
  ChevronRight,
  ExternalLink,
  User,
  FileText,
  Search,
  Shield,
  RefreshCw,
  Database,
  BarChart3,
  Activity,
  Trash2,
} from 'lucide-vue-next'

const router = useRouter()
const route = useRoute()

const { isAuthenticated, signInWithGoogle, userEmail, user, session } = useAuth()

// Input state
const userInput = ref('')
const submitting = ref(false)
const submitError = ref<string | null>(null)
const submitSuccess = ref<string | null>(null)

// URL extraction from text
function extractUrl(text: string): string | null {
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi
  const matches = text.match(urlPattern)
  return matches ? matches[0] : null
}

// Current task state
const currentTask = ref<any>(null)

// Task history state
const tasks = ref<any[]>([])
const tasksLoading = ref(false)
const tasksPage = ref(0)
const tasksPageSize = 10
const hasMoreTasks = ref(true)

// Statistics
const stats = ref({
  total: 0,
  completed: 0,
  processing: 0,
  pending: 0,
  failed: 0,
})

// Selected task result
const selectedTask = ref<any>(null)
const showResultModal = ref(false)

// Task type labels
const taskTypeLabels: Record<string, string> = {
  candidate_search: '候選人搜尋',
  politician_update: '個人資料更新',
  policy_search: '政見搜尋',
  policy_verify: '政見驗證',
  progress_tracking: '進度追蹤',
  policy_import: '政見匯入',
  user_contribution: '使用者貢獻',
}

// Determine effective status - if has results, treat as completed despite timeout errors
function getEffectiveStatus(task: any): string {
  // If marked as failed but has valid results, treat as completed
  if (task.status === 'failed' && (task.result_summary || task.result_data)) {
    return 'completed'
  }
  return task.status
}

// Status labels and colors
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

// Fetch statistics
async function fetchStats() {
  try {
    // Get counts by status (include result_summary for effective status calculation)
    const { data, error } = await supabase
      .from('ai_prompts')
      .select('status, result_summary, result_data')

    if (error) throw error

    const counts = {
      total: data.length,
      completed: 0,
      processing: 0,
      pending: 0,
      failed: 0,
    }

    data.forEach((item: any) => {
      // Use effective status logic (same as getEffectiveStatus)
      const hasResults = item.result_summary || item.result_data
      const effectiveStatus = (item.status === 'failed' && hasResults) ? 'completed' : item.status
      switch (effectiveStatus) {
        case 'completed': counts.completed++; break
        case 'processing': counts.processing++; break
        case 'pending': counts.pending++; break
        case 'failed': counts.failed++; break
      }
    })

    stats.value = counts
  } catch (err: any) {
    console.error('Failed to fetch stats:', err)
  }
}

// Fetch all tasks (not just user's)
async function fetchTasks(reset = false) {
  if (reset) {
    tasksPage.value = 0
    tasks.value = []
    hasMoreTasks.value = true
  }

  tasksLoading.value = true
  try {
    const from = tasksPage.value * tasksPageSize
    const to = from + tasksPageSize - 1

    const { data, error } = await supabase
      .from('ai_prompts')
      .select('*')
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

    // Also refresh stats
    fetchStats()
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

// Submit task
async function handleSubmit() {
  if (!userInput.value.trim()) return

  submitting.value = true
  submitError.value = null
  submitSuccess.value = null
  currentTask.value = null

  try {
    const inputText = userInput.value.trim()
    const extractedUrl = extractUrl(inputText)

    // Debug: check session
    console.log('Session:', session.value)
    console.log('Access token:', session.value?.access_token?.substring(0, 20) + '...')

    const response = await supabase.functions.invoke('ai-classify', {
      body: {
        input: inputText,
        url: extractedUrl || undefined,
      },
    })

    console.log('Response:', response)

    if (response.error) {
      throw new Error(response.error.message || JSON.stringify(response.error))
    }

    const data = response.data
    if (!data.success) {
      throw new Error(data.message || '提交失敗')
    }

    submitSuccess.value = '任務已開始，將在背景運行。請稍後回來查看結果。'
    currentTask.value = {
      id: data.prompt_id,
      task_type: data.task_type,
      status: 'pending',
      requires_review: data.requires_review,
      confidence: data.confidence,
    }

    // Clear input
    userInput.value = ''

    // Refresh task list
    fetchTasks(true)
  } catch (err: any) {
    console.error('Submit error:', err)
    submitError.value = err.message || '提交失敗，請稍後再試'
  } finally {
    submitting.value = false
  }
}

// View task result
function viewTaskResult(task: any) {
  selectedTask.value = task
  showResultModal.value = true
}

function closeResultModal() {
  showResultModal.value = false
  selectedTask.value = null
}

// Format date
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

// Example inputs
const examples = [
  { text: '請幫我找 2026 年台北市長候選人', type: 'search' },
  { text: '高雄市議員有哪些人參選？', type: 'search' },
  { text: '蔣萬安說要蓋捷運到內湖，這是真的嗎？', type: 'verify' },
]

function useExample(text: string) {
  userInput.value = text
}

// Deduplication
const deduplicating = ref(false)
const dedupeResult = ref<any>(null)

async function handleDeduplicate(dryRun = true) {
  deduplicating.value = true
  dedupeResult.value = null

  try {
    const response = await supabase.functions.invoke('ai-action', {
      body: {
        api_key: 'policy-ai-2026',
        action: 'deduplicate_candidates',
        election_year: 2026,
        dry_run: dryRun,
      },
    })

    if (response.error) {
      throw new Error(response.error.message)
    }

    dedupeResult.value = response.data

    // If not dry run, refresh tasks
    if (!dryRun) {
      fetchTasks(true)
    }
  } catch (err: any) {
    console.error('Deduplicate error:', err)
    dedupeResult.value = { success: false, error: err.message }
  } finally {
    deduplicating.value = false
  }
}

// Lifecycle
onMounted(() => {
  // Always fetch tasks (public view)
  fetchTasks(true)
})

watch(user, (newUser) => {
  if (newUser) {
    // Refresh when user logs in
    fetchTasks(true)
  }
})
</script>

<template>
    <div class="min-h-screen bg-slate-50">
      <Hero background-image="/images/heroes/ai.png">
        <template #title>AI 查核</template>
        <template #description>提交選舉資訊、搜尋候選人、驗證政見真偽</template>
        <template #icon><Database :size="400" class="text-blue-500" /></template>

        <template #actions>
          <button @click="router.push('/analysis')" :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all bg-white/10 text-white hover:bg-white/20 border border-white/20`">
            <Database :size="16" /> 分析列表
          </button>
          <button :class="`px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all bg-white text-navy-900 shadow-lg`">
            <Sparkles :size="16" /> 提交查核
          </button>
        </template>

        <GlobalRegionSelector />
      </Hero>


      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <main class="max-w-4xl mx-auto px-4 py-8 -mt-8 relative z-10">
        <!-- Login prompt -->
        <div v-if="!isAuthenticated" class="bg-white rounded-xl shadow-lg p-8 text-center">
          <Sparkles class="w-16 h-16 text-indigo-500 mx-auto mb-4" />
          <h2 class="text-xl font-bold text-slate-800 mb-2">登入使用 AI 查核</h2>
          <p class="text-slate-600 mb-6">登入後即可提交資訊、搜尋候選人、驗證政見</p>
          <button
            @click="signInWithGoogle"
            class="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <User class="w-5 h-5" />
            使用 Google 登入
          </button>
        </div>

        <!-- Main content -->
        <div v-else class="space-y-6">
          <!-- Input section -->
          <div class="bg-white rounded-xl shadow-lg p-6">
            <h2 class="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Sparkles class="w-5 h-5 text-indigo-500" />
              提交新任務
            </h2>

            <!-- Examples -->
            <div class="mb-4">
              <p class="text-sm text-slate-500 mb-2">範例：</p>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="example in examples"
                  :key="example.text"
                  @click="useExample(example.text)"
                  class="text-sm px-3 py-1.5 bg-slate-100 text-slate-600 rounded-full hover:bg-slate-200 transition-colors"
                >
                  {{ example.text.substring(0, 20) }}...
                </button>
              </div>
            </div>

            <!-- Input form -->
            <form @submit.prevent="handleSubmit" class="space-y-4">
              <div>
                <textarea
                  v-model="userInput"
                  placeholder="輸入您的請求或貼上網址，例如：&#10;• 請幫我找 2026 年台北市長候選人&#10;• 這是政見新聞：https://news.example.com/..."
                  rows="4"
                  class="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-none"
                  :disabled="submitting"
                />
                <p class="mt-1 text-xs text-slate-500">可直接在文字中貼上網址，系統會自動偵測</p>
              </div>

              <div class="flex justify-end">
                <button
                  type="submit"
                  :disabled="submitting || !userInput.trim()"
                  class="px-6 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                >
                  <Loader2 v-if="submitting" class="w-4 h-4 animate-spin" />
                  <Send v-else class="w-4 h-4" />
                  提交
                </button>
              </div>
            </form>

            <!-- Submit status -->
            <div v-if="submitError" class="mt-4 p-3 bg-red-50 text-red-700 rounded-lg flex items-center gap-2">
              <XCircle class="w-5 h-5 flex-shrink-0" />
              {{ submitError }}
            </div>

            <div v-if="submitSuccess" class="mt-4 p-3 bg-emerald-50 text-emerald-700 rounded-lg flex items-center gap-2">
              <CheckCircle class="w-5 h-5 flex-shrink-0" />
              {{ submitSuccess }}
            </div>
          </div>

          <!-- Current task status -->
          <div v-if="currentTask" class="bg-white rounded-xl shadow-lg p-6">
            <h3 class="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Clock class="w-5 h-5 text-indigo-500" />
              目前任務
            </h3>

            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <component :is="getTaskIcon(currentTask.task_type)" class="w-8 h-8 text-indigo-500" />
                <div>
                  <p class="font-medium text-slate-800">{{ taskTypeLabels[currentTask.task_type] || currentTask.task_type }}</p>
                  <p class="text-sm text-slate-500">信心度: {{ Math.round((currentTask.confidence || 0) * 100) }}%</p>
                </div>
              </div>

              <div class="flex items-center gap-3">
                <span :class="['px-3 py-1 rounded-full text-sm font-medium', getStatusColor(currentTask.status, currentTask)]">
                  {{ getStatusLabel(currentTask.status, currentTask) }}
                </span>

                <Loader2 v-if="getEffectiveStatus(currentTask) === 'pending' || getEffectiveStatus(currentTask) === 'processing'" class="w-5 h-5 text-indigo-500 animate-spin" />
                <CheckCircle v-else-if="getEffectiveStatus(currentTask) === 'completed'" class="w-5 h-5 text-emerald-500" />
                <XCircle v-else-if="getEffectiveStatus(currentTask) === 'failed'" class="w-5 h-5 text-red-500" />
              </div>
            </div>

            <!-- Review notice -->
            <div v-if="currentTask.requires_review" class="mt-4 p-3 bg-amber-50 text-amber-700 rounded-lg flex items-center gap-2">
              <AlertCircle class="w-5 h-5 flex-shrink-0" />
              此任務需要審核，審核通過後將自動處理
            </div>

            <!-- Error message (only show if task truly failed, not if it has results) -->
            <div v-if="currentTask.error_message && getEffectiveStatus(currentTask) === 'failed'" class="mt-4 p-3 bg-red-50 text-red-700 rounded-lg">
              {{ currentTask.error_message }}
            </div>

            <!-- View result button (show if completed or has results) -->
            <button
              v-if="getEffectiveStatus(currentTask) === 'completed'"
              @click="viewTaskResult(currentTask)"
              class="mt-4 w-full py-2 bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors flex items-center justify-center gap-2"
            >
              <FileText class="w-4 h-4" />
              查看結果
            </button>
          </div>

          <!-- Task history -->
          <div class="bg-white rounded-xl shadow-lg p-6">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-lg font-bold text-slate-800 flex items-center gap-2">
                <Activity class="w-5 h-5 text-indigo-500" />
                任務總覽
              </h3>

              <button
                @click="fetchTasks(true)"
                :disabled="tasksLoading"
                class="p-2 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                <RefreshCw :class="['w-4 h-4', tasksLoading && 'animate-spin']" />
              </button>
            </div>

            <!-- Statistics -->
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
              <div class="bg-slate-50 rounded-lg p-3 text-center">
                <div class="text-2xl font-bold text-slate-700">{{ stats.total }}</div>
                <div class="text-xs text-slate-500">全部任務</div>
              </div>
              <div class="bg-emerald-50 rounded-lg p-3 text-center">
                <div class="text-2xl font-bold text-emerald-600">{{ stats.completed }}</div>
                <div class="text-xs text-emerald-600">已完成</div>
              </div>
              <div class="bg-blue-50 rounded-lg p-3 text-center">
                <div class="text-2xl font-bold text-blue-600">{{ stats.processing }}</div>
                <div class="text-xs text-blue-600">處理中</div>
              </div>
              <div class="bg-amber-50 rounded-lg p-3 text-center">
                <div class="text-2xl font-bold text-amber-600">{{ stats.pending }}</div>
                <div class="text-xs text-amber-600">等待中</div>
              </div>
              <div class="bg-red-50 rounded-lg p-3 text-center">
                <div class="text-2xl font-bold text-red-600">{{ stats.failed }}</div>
                <div class="text-xs text-red-600">失敗</div>
              </div>
            </div>

            <!-- Data Quality Tools -->
            <div class="mb-6 p-4 bg-slate-50 rounded-lg">
              <h4 class="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
                <Database class="w-4 h-4" />
                資料品質工具
              </h4>

              <div class="flex flex-wrap gap-2">
                <button
                  @click="handleDeduplicate(true)"
                  :disabled="deduplicating"
                  class="px-3 py-1.5 text-sm bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-100 transition-colors flex items-center gap-1.5"
                >
                  <Search v-if="!deduplicating" class="w-4 h-4" />
                  <Loader2 v-else class="w-4 h-4 animate-spin" />
                  檢查重複資料
                </button>

                <button
                  v-if="dedupeResult?.duplicate_groups > 0"
                  @click="handleDeduplicate(false)"
                  :disabled="deduplicating"
                  class="px-3 py-1.5 text-sm bg-red-50 border border-red-200 text-red-700 rounded-lg hover:bg-red-100 transition-colors flex items-center gap-1.5"
                >
                  <Trash2 class="w-4 h-4" />
                  清除 {{ dedupeResult.total_duplicates }} 筆重複
                </button>
              </div>

              <!-- Dedupe result -->
              <div v-if="dedupeResult" class="mt-3 text-sm">
                <div v-if="dedupeResult.success !== false" :class="['p-3 rounded-lg', dedupeResult.duplicate_groups > 0 ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700']">
                  <p class="font-medium">{{ dedupeResult.message }}</p>
                  <div v-if="dedupeResult.duplicates?.length > 0" class="mt-2 space-y-1">
                    <p v-for="dup in dedupeResult.duplicates.slice(0, 5)" :key="dup.name" class="text-xs">
                      • {{ dup.name }} ({{ dup.region }}) - {{ dup.count }} 筆重複
                    </p>
                    <p v-if="dedupeResult.duplicates.length > 5" class="text-xs opacity-75">
                      ...還有 {{ dedupeResult.duplicates.length - 5 }} 組
                    </p>
                  </div>
                </div>
                <div v-else class="p-3 rounded-lg bg-red-50 text-red-700">
                  錯誤：{{ dedupeResult.error }}
                </div>
              </div>
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
                class="w-full py-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
              >
                {{ tasksLoading ? '載入中...' : '載入更多' }}
              </button>
            </div>

            <!-- Empty state -->
            <div v-else-if="!tasksLoading" class="text-center py-8 text-slate-500">
              <Activity class="w-12 h-12 mx-auto mb-3 text-slate-300" />
              <p>尚無任務記錄</p>
              <p class="text-sm">登入後提交您的第一個任務吧！</p>
            </div>

            <!-- Loading -->
            <div v-else class="text-center py-8">
              <Loader2 class="w-8 h-8 mx-auto text-indigo-500 animate-spin" />
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
                    <a :href="selectedTask.source_url" target="_blank" class="text-indigo-600 hover:underline inline-flex items-center gap-1">
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
                        <a :href="source" target="_blank" class="text-sm text-indigo-600 hover:underline inline-flex items-center gap-1">
                          {{ source.substring(0, 60) }}...
                          <ExternalLink class="w-3 h-3" />
                        </a>
                      </li>
                    </ul>
                  </div>
                </div>

                <!-- Error message (only show if truly failed) -->
                <div v-if="selectedTask.error_message && getEffectiveStatus(selectedTask) === 'failed'" class="p-4 bg-red-50 text-red-700 rounded-lg">
                  <strong>錯誤：</strong>{{ selectedTask.error_message }}
                </div>

                <!-- Pending/Processing state -->
                <div v-if="getEffectiveStatus(selectedTask) === 'pending' || getEffectiveStatus(selectedTask) === 'processing'" class="text-center py-8">
                  <Loader2 class="w-12 h-12 mx-auto text-indigo-500 animate-spin mb-4" />
                  <p class="text-slate-600">任務處理中，請稍候...</p>
                </div>
              </div>
            </div>
          </div>
        </Teleport>
    </div>
  </div>
</template>
