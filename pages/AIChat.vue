<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import Hero from '../components/Hero.vue'
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
} from 'lucide-vue-next'

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
const pollingInterval = ref<ReturnType<typeof setInterval> | null>(null)

// Task history state
const tasks = ref<any[]>([])
const tasksLoading = ref(false)
const tasksPage = ref(0)
const tasksPageSize = 10
const hasMoreTasks = ref(true)

// Selected task result
const selectedTask = ref<any>(null)
const showResultModal = ref(false)

// Polling configuration
const POLL_INTERVAL = 5000 // 5 seconds
const POLL_TIMEOUT = 300000 // 5 minutes

// Task type labels
const taskTypeLabels: Record<string, string> = {
  candidate_search: '候選人搜尋',
  policy_search: '政見搜尋',
  policy_verify: '政見驗證',
  progress_tracking: '進度追蹤',
  policy_import: '政見匯入',
  user_contribution: '使用者貢獻',
}

// Status labels and colors
function getStatusLabel(status: string): string {
  switch (status) {
    case 'pending': return '等待中'
    case 'processing': return '處理中'
    case 'completed': return '已完成'
    case 'failed': return '失敗'
    default: return status
  }
}

function getStatusColor(status: string): string {
  switch (status) {
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

// Fetch user's tasks
async function fetchTasks(reset = false) {
  if (!user.value) return

  if (reset) {
    tasksPage.value = 0
    tasks.value = []
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

    submitSuccess.value = data.message
    currentTask.value = {
      id: data.prompt_id,
      task_type: data.task_type,
      status: 'pending',
      requires_review: data.requires_review,
      confidence: data.confidence,
    }

    // Clear input
    userInput.value = ''

    // Start polling if not requiring review
    if (!data.requires_review) {
      startPolling(data.prompt_id)
    }

    // Refresh task list
    fetchTasks(true)
  } catch (err: any) {
    console.error('Submit error:', err)
    submitError.value = err.message || '提交失敗，請稍後再試'
  } finally {
    submitting.value = false
  }
}

// Polling for task status
function startPolling(promptId: string) {
  const startTime = Date.now()

  const poll = async () => {
    try {
      const response = await supabase.functions.invoke('ai-prompt-status', {
        body: { prompt_id: promptId },
      })

      if (response.error) {
        throw new Error(response.error.message)
      }

      const data = response.data
      if (data.prompt) {
        currentTask.value = {
          ...currentTask.value,
          ...data.prompt,
        }

        if (data.prompt.status === 'completed' || data.prompt.status === 'failed') {
          stopPolling()
          fetchTasks(true)
        }
      }

      // Timeout check
      if (Date.now() - startTime > POLL_TIMEOUT) {
        stopPolling()
        currentTask.value = {
          ...currentTask.value,
          status: 'failed',
          error_message: '任務超時',
        }
      }
    } catch (err: any) {
      console.error('Polling error:', err)
    }
  }

  pollingInterval.value = setInterval(poll, POLL_INTERVAL)
  poll() // Initial poll
}

function stopPolling() {
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value)
    pollingInterval.value = null
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

// Lifecycle
onMounted(() => {
  if (user.value) {
    fetchTasks(true)
  }
})

onUnmounted(() => {
  stopPolling()
})

watch(user, (newUser) => {
  if (newUser) {
    fetchTasks(true)
  }
})
</script>

<template>
  <div class="min-h-screen bg-slate-50">
    <Hero title="AI 助手" subtitle="提交選舉資訊、搜尋候選人、驗證政見" />

    <main class="max-w-4xl mx-auto px-4 py-8 -mt-8 relative z-10">
      <!-- Login prompt -->
      <div v-if="!isAuthenticated" class="bg-white rounded-xl shadow-lg p-8 text-center">
        <Sparkles class="w-16 h-16 text-indigo-500 mx-auto mb-4" />
        <h2 class="text-xl font-bold text-slate-800 mb-2">登入使用 AI 助手</h2>
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
              <span :class="['px-3 py-1 rounded-full text-sm font-medium', getStatusColor(currentTask.status)]">
                {{ getStatusLabel(currentTask.status) }}
              </span>

              <Loader2 v-if="currentTask.status === 'pending' || currentTask.status === 'processing'" class="w-5 h-5 text-indigo-500 animate-spin" />
              <CheckCircle v-else-if="currentTask.status === 'completed'" class="w-5 h-5 text-emerald-500" />
              <XCircle v-else-if="currentTask.status === 'failed'" class="w-5 h-5 text-red-500" />
            </div>
          </div>

          <!-- Review notice -->
          <div v-if="currentTask.requires_review" class="mt-4 p-3 bg-amber-50 text-amber-700 rounded-lg flex items-center gap-2">
            <AlertCircle class="w-5 h-5 flex-shrink-0" />
            此任務需要審核，審核通過後將自動處理
          </div>

          <!-- Error message -->
          <div v-if="currentTask.error_message" class="mt-4 p-3 bg-red-50 text-red-700 rounded-lg">
            {{ currentTask.error_message }}
          </div>

          <!-- View result button -->
          <button
            v-if="currentTask.status === 'completed'"
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
              <History class="w-5 h-5 text-indigo-500" />
              我的任務
            </h3>

            <button
              @click="fetchTasks(true)"
              :disabled="tasksLoading"
              class="p-2 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <RefreshCw :class="['w-4 h-4', tasksLoading && 'animate-spin']" />
            </button>
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
                <span :class="['px-2 py-0.5 rounded text-xs font-medium', getStatusColor(task.status)]">
                  {{ getStatusLabel(task.status) }}
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
            <History class="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p>尚無任務記錄</p>
            <p class="text-sm">提交您的第一個任務吧！</p>
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
                <span :class="['px-2 py-0.5 rounded text-xs font-medium', getStatusColor(selectedTask.status)]">
                  {{ getStatusLabel(selectedTask.status) }}
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

            <!-- Error message -->
            <div v-if="selectedTask.error_message" class="p-4 bg-red-50 text-red-700 rounded-lg">
              <strong>錯誤：</strong>{{ selectedTask.error_message }}
            </div>

            <!-- Pending/Processing state -->
            <div v-if="selectedTask.status === 'pending' || selectedTask.status === 'processing'" class="text-center py-8">
              <Loader2 class="w-12 h-12 mx-auto text-indigo-500 animate-spin mb-4" />
              <p class="text-slate-600">任務處理中，請稍候...</p>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
