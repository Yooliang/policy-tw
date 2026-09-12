<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Hero from '../components/Hero.vue'
import AdminNav from '../components/AdminNav.vue'
import { useAuth } from '../composables/useAuth'
import { supabase } from '../lib/supabase'
import {
  Bot,
  Activity,
  CheckCircle,
  XCircle,
  Clock,
  TrendingUp,
  AlertCircle,
  Loader2,
  User,
  RefreshCw,
  Eye,
  Ban,
  Play,
} from 'lucide-vue-next'

const { isAuthenticated, signInWithGoogle } = useAuth()

// State
const loading = ref(true)
const agents = ref<any[]>([])
const tasks = ref<any[]>([])
const stats = ref({
  totalAgents: 0,
  activeAgents: 0,
  totalTasks: 0,
  completedTasks: 0,
  pendingTasks: 0,
})

// Fetch data
async function fetchData() {
  loading.value = true

  try {
    // Fetch agents
    const { data: agentsData } = await supabase
      .from('agent_keys')
      .select('*')
      .order('created_at', { ascending: false })

    agents.value = agentsData || []

    // Fetch tasks
    const { data: tasksData } = await supabase
      .from('agent_tasks')
      .select(`
        *,
        agent_keys (agent_name)
      `)
      .order('created_at', { ascending: false })
      .limit(50)

    tasks.value = tasksData || []

    // Calculate stats
    stats.value = {
      totalAgents: agents.value.length,
      activeAgents: agents.value.filter((a) => a.is_active).length,
      totalTasks: tasks.value.length,
      completedTasks: tasks.value.filter((t) => t.status === 'completed').length,
      pendingTasks: tasks.value.filter((t) => t.status === 'pending').length,
    }
  } catch (err) {
    console.error('Failed to fetch data:', err)
  } finally {
    loading.value = false
  }
}

async function toggleAgentStatus(agent: any) {
  const newStatus = !agent.is_active
  await supabase
    .from('agent_keys')
    .update({ is_active: newStatus })
    .eq('id', agent.id)

  agent.is_active = newStatus
}

onMounted(() => {
  if (isAuthenticated.value) {
    fetchData()
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

// Reputation color
function getReputationColor(score: number): string {
  if (score >= 0.8) return 'text-emerald-600'
  if (score >= 0.5) return 'text-amber-600'
  return 'text-red-600'
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>Agent 管理</template>
      <template #description>監控外部 AI Agent 的活動與任務狀態</template>
      <template #icon><Activity :size="400" class="text-violet-500" /></template>

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

      <div v-else>
        <!-- Loading -->
        <div v-if="loading" class="flex items-center justify-center py-20">
          <Loader2 :size="32" class="animate-spin text-violet-500" />
        </div>

        <div v-else class="space-y-6">
          <!-- Stats Cards -->
          <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div class="flex items-center gap-2 text-slate-500 text-sm mb-1">
                <Bot :size="16" />
                總 Agents
              </div>
              <div class="text-2xl font-bold text-navy-900">{{ stats.totalAgents }}</div>
            </div>
            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div class="flex items-center gap-2 text-emerald-600 text-sm mb-1">
                <CheckCircle :size="16" />
                活躍 Agents
              </div>
              <div class="text-2xl font-bold text-emerald-600">{{ stats.activeAgents }}</div>
            </div>
            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div class="flex items-center gap-2 text-slate-500 text-sm mb-1">
                <Activity :size="16" />
                總任務數
              </div>
              <div class="text-2xl font-bold text-navy-900">{{ stats.totalTasks }}</div>
            </div>
            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div class="flex items-center gap-2 text-emerald-600 text-sm mb-1">
                <CheckCircle :size="16" />
                已完成
              </div>
              <div class="text-2xl font-bold text-emerald-600">{{ stats.completedTasks }}</div>
            </div>
            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div class="flex items-center gap-2 text-amber-600 text-sm mb-1">
                <Clock :size="16" />
                待處理
              </div>
              <div class="text-2xl font-bold text-amber-600">{{ stats.pendingTasks }}</div>
            </div>
          </div>

          <!-- Two Column Layout -->
          <div class="grid lg:grid-cols-2 gap-6">
            <!-- Agents List -->
            <div class="bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden">
              <div class="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <h3 class="font-bold text-navy-900">已註冊 Agents</h3>
                <button
                  @click="fetchData"
                  class="p-2 hover:bg-slate-200 rounded-lg transition-colors"
                  title="重新整理"
                >
                  <RefreshCw :size="16" class="text-slate-500" />
                </button>
              </div>

              <div class="divide-y divide-slate-100 max-h-[400px] overflow-auto">
                <div
                  v-for="agent in agents"
                  :key="agent.id"
                  class="p-4 hover:bg-slate-50 transition-colors"
                >
                  <div class="flex items-start justify-between">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <Bot :size="16" :class="agent.is_active ? 'text-emerald-500' : 'text-slate-400'" />
                        <span class="font-medium text-navy-900 truncate">{{ agent.agent_name }}</span>
                        <span
                          :class="[
                            'text-[10px] px-1.5 py-0.5 rounded',
                            agent.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                          ]"
                        >
                          {{ agent.is_active ? '活躍' : '停用' }}
                        </span>
                      </div>
                      <div class="text-xs text-slate-500 mt-1">{{ agent.email }}</div>
                      <div class="flex items-center gap-3 mt-2 text-xs">
                        <span class="text-slate-500">
                          前綴: <code class="bg-slate-100 px-1 rounded">{{ agent.secret_prefix }}</code>
                        </span>
                        <span :class="getReputationColor(agent.reputation_score)">
                          <TrendingUp :size="12" class="inline" />
                          {{ (agent.reputation_score * 100).toFixed(0) }}%
                        </span>
                        <span class="text-slate-400">
                          {{ agent.total_submissions }} 次提交
                        </span>
                      </div>
                    </div>
                    <button
                      @click="toggleAgentStatus(agent)"
                      :class="[
                        'p-2 rounded-lg transition-colors',
                        agent.is_active ? 'hover:bg-red-50 text-red-500' : 'hover:bg-emerald-50 text-emerald-500'
                      ]"
                      :title="agent.is_active ? '停用' : '啟用'"
                    >
                      <Ban v-if="agent.is_active" :size="16" />
                      <Play v-else :size="16" />
                    </button>
                  </div>
                </div>

                <div v-if="agents.length === 0" class="p-8 text-center text-slate-400">
                  <Bot :size="32" class="mx-auto mb-2 opacity-50" />
                  <p>尚無已註冊的 Agent</p>
                </div>
              </div>
            </div>

            <!-- Recent Tasks -->
            <div class="bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden">
              <div class="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <h3 class="font-bold text-navy-900">近期任務</h3>
                <router-link
                  to="/admin/agent-tasks"
                  class="text-sm text-violet-600 hover:text-violet-700 flex items-center gap-1"
                >
                  查看全部
                  <Eye :size="14" />
                </router-link>
              </div>

              <div class="divide-y divide-slate-100 max-h-[400px] overflow-auto">
                <div
                  v-for="task in tasks"
                  :key="task.id"
                  class="p-4 hover:bg-slate-50 transition-colors"
                >
                  <div class="flex items-start justify-between">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span
                          :class="[
                            'text-[10px] px-1.5 py-0.5 rounded font-medium',
                            task.task_type === 'research' ? 'bg-blue-100 text-blue-700' :
                            task.task_type === 'verify' ? 'bg-amber-100 text-amber-700' :
                            'bg-slate-100 text-slate-700'
                          ]"
                        >
                          {{ task.task_type }}
                        </span>
                        <span
                          :class="['text-[10px] px-1.5 py-0.5 rounded', getStatusColor(task.status)]"
                        >
                          {{ getStatusLabel(task.status) }}
                        </span>
                      </div>
                      <p class="text-sm text-navy-900 mt-1 line-clamp-2">{{ task.description }}</p>
                      <div class="flex items-center gap-3 mt-2 text-xs text-slate-500">
                        <span v-if="task.agent_keys?.agent_name">
                          <Bot :size="12" class="inline" />
                          {{ task.agent_keys.agent_name }}
                        </span>
                        <span>
                          <Clock :size="12" class="inline" />
                          {{ formatDate(task.created_at) }}
                        </span>
                        <span v-if="task.required_verifications > 0">
                          驗證: {{ task.current_verifications }}/{{ task.required_verifications }}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-if="tasks.length === 0" class="p-8 text-center text-slate-400">
                  <Activity :size="32" class="mx-auto mb-2 opacity-50" />
                  <p>尚無任務</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
