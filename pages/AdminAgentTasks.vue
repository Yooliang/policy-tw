<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Hero from '../components/Hero.vue'
import AdminNav from '../components/AdminNav.vue'
import { useAuth } from '../composables/useAuth'
import { supabase } from '../lib/supabase'
import {
  ClipboardList,
  Plus,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  Loader2,
  User,
  RefreshCw,
  Eye,
  ChevronDown,
  Bot,
  ExternalLink,
  FileText,
} from 'lucide-vue-next'

const { isAuthenticated, signInWithGoogle } = useAuth()

// State
const loading = ref(true)
const tasks = ref<any[]>([])
const expandedTask = ref<string | null>(null)
const taskResults = ref<Record<string, any[]>>({})

// Filters
const statusFilter = ref('all')
const typeFilter = ref('all')

// Create Task Modal
const showCreateModal = ref(false)
const newTask = ref({
  task_type: 'research',
  priority: 5,
  description: '',
  politician_id: null as number | null,
  policy_id: null as number | null,
  required_verifications: 1,
  expires_days: 7,
})
const creating = ref(false)

// Fetch tasks
async function fetchTasks() {
  loading.value = true

  try {
    let query = supabase
      .from('agent_tasks')
      .select(`
        *,
        agent_keys (agent_name, email),
        politicians (name),
        policies (title)
      `)
      .order('created_at', { ascending: false })

    if (statusFilter.value !== 'all') {
      query = query.eq('status', statusFilter.value)
    }
    if (typeFilter.value !== 'all') {
      query = query.eq('task_type', typeFilter.value)
    }

    const { data } = await query.limit(100)
    tasks.value = data || []
  } catch (err) {
    console.error('Failed to fetch tasks:', err)
  } finally {
    loading.value = false
  }
}

// Fetch task results when expanded
async function toggleExpand(taskId: string) {
  if (expandedTask.value === taskId) {
    expandedTask.value = null
    return
  }

  expandedTask.value = taskId

  if (!taskResults.value[taskId]) {
    const { data } = await supabase
      .from('agent_task_results')
      .select(`
        *,
        agent_keys (agent_name)
      `)
      .eq('task_id', taskId)
      .order('created_at', { ascending: true })

    taskResults.value[taskId] = data || []
  }
}

// Create new task
async function createTask() {
  if (!newTask.value.description) {
    alert('請輸入任務描述')
    return
  }

  creating.value = true

  try {
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + newTask.value.expires_days)

    const { error } = await supabase.from('agent_tasks').insert({
      task_type: newTask.value.task_type,
      priority: newTask.value.priority,
      description: newTask.value.description,
      politician_id: newTask.value.politician_id || null,
      policy_id: newTask.value.policy_id || null,
      required_verifications: newTask.value.required_verifications,
      expires_at: expiresAt.toISOString(),
    })

    if (error) throw error

    showCreateModal.value = false
    newTask.value = {
      task_type: 'research',
      priority: 5,
      description: '',
      politician_id: null,
      policy_id: null,
      required_verifications: 1,
      expires_days: 7,
    }
    await fetchTasks()
  } catch (err: any) {
    alert('建立失敗: ' + err.message)
  } finally {
    creating.value = false
  }
}

// Manually complete a task
async function completeTask(taskId: string) {
  if (!confirm('確定要手動完成此任務？')) return

  await supabase
    .from('agent_tasks')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', taskId)

  await fetchTasks()
}

// Cancel a task
async function cancelTask(taskId: string) {
  if (!confirm('確定要取消此任務？')) return

  await supabase
    .from('agent_tasks')
    .update({ status: 'failed' })
    .eq('id', taskId)

  await fetchTasks()
}

onMounted(() => {
  if (isAuthenticated.value) {
    fetchTasks()
  }
})

// Format date
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-TW', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Status badge color
function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-100 text-emerald-700'
    case 'in_progress':
      return 'bg-blue-100 text-blue-700'
    case 'pending':
      return 'bg-slate-100 text-slate-700'
    case 'pending_verification':
      return 'bg-amber-100 text-amber-700'
    case 'failed':
      return 'bg-red-100 text-red-700'
    case 'expired':
      return 'bg-slate-100 text-slate-500'
    default:
      return 'bg-slate-100 text-slate-700'
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return '完成'
    case 'in_progress':
      return '進行中'
    case 'pending':
      return '待處理'
    case 'pending_verification':
      return '待驗證'
    case 'failed':
      return '失敗'
    case 'expired':
      return '已過期'
    default:
      return status
  }
}

function getTypeColor(type: string): string {
  switch (type) {
    case 'research':
      return 'bg-blue-100 text-blue-700'
    case 'verify':
      return 'bg-amber-100 text-amber-700'
    case 'update':
      return 'bg-violet-100 text-violet-700'
    default:
      return 'bg-slate-100 text-slate-700'
  }
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>任務管理</template>
      <template #description>建立、監控與審核 Agent 任務</template>
      <template #icon><ClipboardList :size="400" class="text-violet-500" /></template>

      <AdminNav />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Login Required -->
      <div v-if="!isAuthenticated" class="bg-white p-8 rounded-2xl border border-slate-200 shadow-lg text-center">
        <User :size="48" class="text-slate-400 mx-auto mb-4" />
        <h3 class="text-xl font-bold text-navy-900 mb-2">需要登入</h3>
        <p class="text-slate-600 mb-6">請先登入管理員帳號</p>
        <button @click="signInWithGoogle" class="bg-navy-800 hover:bg-navy-700 text-white font-bold py-3 px-6 rounded-xl">
          使用 Google 登入
        </button>
      </div>

      <div v-else class="space-y-6">
        <!-- Controls -->
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <!-- Status Filter -->
            <select
              v-model="statusFilter"
              @change="fetchTasks"
              class="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
            >
              <option value="all">所有狀態</option>
              <option value="pending">待處理</option>
              <option value="in_progress">進行中</option>
              <option value="pending_verification">待驗證</option>
              <option value="completed">已完成</option>
              <option value="failed">失敗</option>
            </select>

            <!-- Type Filter -->
            <select
              v-model="typeFilter"
              @change="fetchTasks"
              class="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
            >
              <option value="all">所有類型</option>
              <option value="research">research</option>
              <option value="verify">verify</option>
              <option value="update">update</option>
            </select>

            <button
              @click="fetchTasks"
              class="p-2 hover:bg-slate-200 rounded-lg transition-colors"
              title="重新整理"
            >
              <RefreshCw :size="18" :class="loading ? 'animate-spin' : ''" class="text-slate-500" />
            </button>
          </div>

          <button
            @click="showCreateModal = true"
            class="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl transition-colors"
          >
            <Plus :size="18" />
            建立任務
          </button>
        </div>

        <!-- Tasks List -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden">
          <div v-if="loading" class="flex items-center justify-center py-20">
            <Loader2 :size="32" class="animate-spin text-violet-500" />
          </div>

          <div v-else-if="tasks.length === 0" class="p-12 text-center text-slate-400">
            <ClipboardList :size="48" class="mx-auto mb-3 opacity-50" />
            <p>目前沒有任務</p>
          </div>

          <div v-else class="divide-y divide-slate-100">
            <div v-for="task in tasks" :key="task.id" class="transition-colors">
              <!-- Task Row -->
              <div
                class="p-4 cursor-pointer hover:bg-slate-50"
                @click="toggleExpand(task.id)"
              >
                <div class="flex items-start justify-between">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span :class="['text-[10px] px-1.5 py-0.5 rounded font-medium', getTypeColor(task.task_type)]">
                        {{ task.task_type }}
                      </span>
                      <span :class="['text-[10px] px-1.5 py-0.5 rounded', getStatusColor(task.status)]">
                        {{ getStatusLabel(task.status) }}
                      </span>
                      <span class="text-[10px] text-slate-400">
                        優先度: {{ task.priority }}
                      </span>
                      <span v-if="task.politicians?.name" class="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                        {{ task.politicians.name }}
                      </span>
                    </div>
                    <p class="text-sm text-navy-900 mt-2">{{ task.description }}</p>
                    <div class="flex items-center gap-4 mt-2 text-xs text-slate-500">
                      <span v-if="task.agent_keys?.agent_name">
                        <Bot :size="12" class="inline" />
                        {{ task.agent_keys.agent_name }}
                      </span>
                      <span>
                        <Clock :size="12" class="inline" />
                        {{ formatDate(task.created_at) }}
                      </span>
                      <span>
                        驗證: {{ task.current_verifications }}/{{ task.required_verifications }}
                      </span>
                    </div>
                  </div>
                  <ChevronDown
                    :size="20"
                    :class="['text-slate-400 transition-transform', expandedTask === task.id ? 'rotate-180' : '']"
                  />
                </div>
              </div>

              <!-- Expanded Details -->
              <div
                v-if="expandedTask === task.id"
                class="px-4 pb-4 bg-slate-50 border-t border-slate-100"
              >
                <div class="pt-4 space-y-4">
                  <!-- Task Context -->
                  <div v-if="task.context" class="bg-white p-3 rounded-lg border border-slate-200">
                    <h4 class="text-xs font-medium text-slate-500 mb-2">Context</h4>
                    <pre class="text-xs text-slate-600 whitespace-pre-wrap">{{ JSON.stringify(task.context, null, 2) }}</pre>
                  </div>

                  <!-- Results -->
                  <div v-if="taskResults[task.id]?.length" class="space-y-2">
                    <h4 class="text-xs font-medium text-slate-500">執行結果</h4>
                    <div
                      v-for="result in taskResults[task.id]"
                      :key="result.id"
                      :class="[
                        'bg-white p-3 rounded-lg border',
                        result.result_type === 'primary' ? 'border-blue-200' : 'border-slate-200'
                      ]"
                    >
                      <div class="flex items-center gap-2 mb-2">
                        <span :class="[
                          'text-[10px] px-1.5 py-0.5 rounded',
                          result.result_type === 'primary' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'
                        ]">
                          {{ result.result_type === 'primary' ? '主要結果' : '驗證' }}
                        </span>
                        <span class="text-xs text-slate-500">{{ result.agent_keys?.agent_name }}</span>
                        <span v-if="result.confidence_score" class="text-xs text-slate-400">
                          信心度: {{ (result.confidence_score * 100).toFixed(0) }}%
                        </span>
                        <span v-if="result.result_type === 'verification'" class="flex items-center gap-1">
                          <CheckCircle v-if="result.agrees_with_primary" :size="14" class="text-emerald-500" />
                          <XCircle v-else :size="14" class="text-red-500" />
                        </span>
                      </div>
                      <pre class="text-xs text-slate-600 whitespace-pre-wrap max-h-40 overflow-auto">{{ JSON.stringify(result.payload, null, 2) }}</pre>
                      <div v-if="result.sources?.length" class="mt-2 flex flex-wrap gap-1">
                        <a
                          v-for="(src, i) in result.sources"
                          :key="i"
                          :href="src"
                          target="_blank"
                          class="text-[10px] text-violet-600 hover:text-violet-800 flex items-center gap-0.5"
                        >
                          <ExternalLink :size="10" />
                          來源 {{ i + 1 }}
                        </a>
                      </div>
                      <p v-if="result.disagreement_notes" class="mt-2 text-xs text-red-600">
                        不同意原因: {{ result.disagreement_notes }}
                      </p>
                    </div>
                  </div>

                  <!-- Actions -->
                  <div v-if="task.status !== 'completed' && task.status !== 'failed'" class="flex gap-2">
                    <button
                      @click.stop="completeTask(task.id)"
                      class="px-3 py-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 rounded-lg text-xs flex items-center gap-1"
                    >
                      <CheckCircle :size="14" />
                      手動完成
                    </button>
                    <button
                      @click.stop="cancelTask(task.id)"
                      class="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 rounded-lg text-xs flex items-center gap-1"
                    >
                      <XCircle :size="14" />
                      取消任務
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Task Modal -->
    <div
      v-if="showCreateModal"
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      @click.self="showCreateModal = false"
    >
      <div class="bg-white rounded-2xl w-full max-w-lg shadow-xl">
        <div class="px-6 py-4 border-b border-slate-200">
          <h3 class="font-bold text-navy-900">建立新任務</h3>
        </div>

        <form @submit.prevent="createTask" class="p-6 space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">任務類型</label>
              <select v-model="newTask.task_type" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                <option value="research">research (研究)</option>
                <option value="verify">verify (驗證)</option>
                <option value="update">update (更新)</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">優先度 (1-10)</label>
              <input
                v-model.number="newTask.priority"
                type="number"
                min="1"
                max="10"
                class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1">任務描述 *</label>
            <textarea
              v-model="newTask.description"
              rows="3"
              required
              placeholder="詳細描述任務內容..."
              class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none"
            ></textarea>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">需要驗證數</label>
              <input
                v-model.number="newTask.required_verifications"
                type="number"
                min="0"
                max="5"
                class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">過期天數</label>
              <input
                v-model.number="newTask.expires_days"
                type="number"
                min="1"
                max="30"
                class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          <div class="flex justify-end gap-3 pt-4">
            <button
              type="button"
              @click="showCreateModal = false"
              class="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl"
            >
              取消
            </button>
            <button
              type="submit"
              :disabled="creating"
              class="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-300 text-white rounded-xl flex items-center gap-2"
            >
              <Loader2 v-if="creating" :size="16" class="animate-spin" />
              建立任務
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
