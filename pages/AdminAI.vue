<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Hero from '../components/Hero.vue'
import AdminNav from '../components/AdminNav.vue'
import { useAuth } from '../composables/useAuth'
import { useSupabase } from '../composables/useSupabase'
import { supabase } from '../lib/supabase'
import {
  Sparkles,
  Search,
  RefreshCw,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  User,
  Calendar,
  Clock,
  DollarSign,
  Activity,
  ChevronDown,
  ChevronRight,
} from 'lucide-vue-next'

const { isAuthenticated, signInWithGoogle, userEmail } = useAuth()
const { elections } = useSupabase()

// Tab state
const activeTab = ref<'search' | 'update' | 'logs'>('search')

// Admin check (simple client-side check - real auth is in Edge Functions)
const isAdmin = computed(() => {
  const email = userEmail.value
  return email?.endsWith('@admin.com') || email?.includes('admin')
})

// =====================
// Search Tab State
// =====================
const searchYear = ref(2026)
const searchRegion = ref('')
const searchPosition = ref('')
const searchLoading = ref(false)
const searchError = ref<string | null>(null)
const searchResults = ref<any[]>([])
const searchSummary = ref('')
const importingCandidate = ref<string | null>(null)

const regions = [
  '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市',
  '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣',
  '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣',
  '台東縣', '澎湖縣', '金門縣', '連江縣',
]

const positions = ['縣市長', '縣市議員', '立法委員', '總統副總統']

async function handleSearch() {
  searchLoading.value = true
  searchError.value = null
  searchResults.value = []

  try {
    const response = await supabase.functions.invoke('ai-search', {
      body: {
        election_year: searchYear.value,
        region: searchRegion.value || undefined,
        position: searchPosition.value || undefined,
      },
    })

    if (response.error) {
      throw new Error(response.error.message)
    }

    const data = response.data
    if (data.error) {
      throw new Error(data.message || data.error)
    }

    searchResults.value = data.candidates || []
    searchSummary.value = data.summary
  } catch (err: any) {
    searchError.value = err.message || '搜尋失敗'
  } finally {
    searchLoading.value = false
  }
}

async function importCandidate(candidate: any) {
  importingCandidate.value = candidate.name

  try {
    const response = await supabase.functions.invoke('import-candidate', {
      body: {
        election_year: searchYear.value,
        candidate: {
          name: candidate.name,
          party: candidate.party,
          position: candidate.position,
          region: candidate.region,
          status: candidate.status,
          current_position: candidate.current_position,
          note: candidate.note,
        },
      },
    })

    if (response.error) {
      throw new Error(response.error.message)
    }

    const data = response.data
    if (data.error) {
      throw new Error(data.message || data.error)
    }

    // Mark as imported in UI
    candidate.imported = true
    alert(data.message)
  } catch (err: any) {
    alert('匯入失敗: ' + (err.message || '未知錯誤'))
  } finally {
    importingCandidate.value = null
  }
}

// =====================
// Update Tab State
// =====================
const updateMode = ref<'policy' | 'politician' | 'election'>('election')
const updatePolicyId = ref<number | null>(null)
const updatePoliticianId = ref<number | null>(null)
const updateElectionId = ref<number | null>(null)
const updateLoading = ref(false)
const updateError = ref<string | null>(null)
const updateResults = ref<any[]>([])
const updateSummary = ref('')

async function handleUpdate() {
  updateLoading.value = true
  updateError.value = null
  updateResults.value = []

  try {
    const body: any = {}
    if (updateMode.value === 'policy' && updatePolicyId.value) {
      body.policy_id = updatePolicyId.value
    } else if (updateMode.value === 'politician' && updatePoliticianId.value) {
      body.politician_id = updatePoliticianId.value
    } else if (updateMode.value === 'election' && updateElectionId.value) {
      body.election_id = updateElectionId.value
    }

    const response = await supabase.functions.invoke('ai-update-progress', {
      body,
    })

    if (response.error) {
      throw new Error(response.error.message)
    }

    const data = response.data
    if (data.error) {
      throw new Error(data.message || data.error)
    }

    updateResults.value = data.updates || []
    updateSummary.value = data.summary
  } catch (err: any) {
    updateError.value = err.message || '更新失敗'
  } finally {
    updateLoading.value = false
  }
}

// =====================
// Logs Tab State
// =====================
const logs = ref<any[]>([])
const logsLoading = ref(false)
const logsError = ref<string | null>(null)
const logsPage = ref(0)
const logsPageSize = 20
const expandedLogId = ref<string | null>(null)
const selectedLog = ref<any>(null)

function toggleLogExpand(logId: string) {
  expandedLogId.value = expandedLogId.value === logId ? null : logId
}

function selectLog(log: any) {
  selectedLog.value = log
}

async function fetchLogs() {
  logsLoading.value = true
  logsError.value = null

  try {
    const { data, error } = await supabase
      .from('ai_usage_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(logsPage.value * logsPageSize, (logsPage.value + 1) * logsPageSize - 1)

    if (error) throw error

    logs.value = data || []
  } catch (err: any) {
    logsError.value = err.message || '載入記錄失敗'
  } finally {
    logsLoading.value = false
  }
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatCost(cost: number): string {
  if (!cost) return '$0'
  if (cost < 0.001) return '< $0.001'
  return `$${cost.toFixed(4)}`
}

onMounted(() => {
  if (activeTab.value === 'logs') {
    fetchLogs()
  }
})

function handleTabChange(tab: 'search' | 'update' | 'logs') {
  activeTab.value = tab
  if (tab === 'logs' && logs.value.length === 0) {
    fetchLogs()
  }
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>AI 管理</template>
      <template #description>
        使用 AI 搜尋候選人資訊、更新政見進度，以及查看 AI 使用記錄
      </template>
      <template #icon>
        <Sparkles :size="400" class="text-amber-500" />
      </template>

      <AdminNav />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Login Required -->
      <div
        v-if="!isAuthenticated"
        class="bg-white p-8 rounded-2xl border border-slate-200 shadow-lg text-center"
      >
        <User :size="48" class="text-slate-400 mx-auto mb-4" />
        <h3 class="text-xl font-bold text-navy-900 mb-2">需要登入</h3>
        <p class="text-slate-600 mb-6">請先登入管理員帳號</p>
        <button
          @click="signInWithGoogle"
          class="bg-navy-800 hover:bg-navy-700 text-white font-bold py-3 px-6 rounded-xl transition-colors"
        >
          使用 Google 登入
        </button>
      </div>

      <!-- Main Content: 8:4 Layout -->
      <div v-else class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- Left: Response Display (8 cols) -->
        <div class="lg:col-span-8 space-y-4">
          <div class="bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden min-h-[600px]">
            <!-- Header -->
            <div class="px-6 py-4 border-b border-slate-200 bg-slate-50">
              <h3 class="font-bold text-navy-900 flex items-center gap-2">
                <Activity :size="18" class="text-blue-600" />
                AI 回應
              </h3>
            </div>

            <!-- Content Area -->
            <div class="p-6">
              <!-- Loading State -->
              <div v-if="searchLoading || updateLoading" class="flex flex-col items-center justify-center py-20">
                <Loader2 :size="48" class="animate-spin text-blue-500 mb-4" />
                <p class="text-slate-500">AI 處理中...</p>
              </div>

              <!-- Empty State -->
              <div v-else-if="!searchResults.length && !updateResults.length && !searchError && !updateError && !selectedLog" class="flex flex-col items-center justify-center py-20 text-center">
                <Sparkles :size="64" class="text-slate-200 mb-4" />
                <h4 class="text-lg font-medium text-slate-400 mb-2">尚無資料</h4>
                <p class="text-sm text-slate-400">請從右側操作區選擇功能並執行</p>
              </div>

              <!-- Error Display -->
              <div v-else-if="searchError || updateError" class="bg-red-50 border border-red-200 rounded-xl p-6">
                <div class="flex items-start gap-3">
                  <AlertCircle :size="24" class="text-red-500 shrink-0" />
                  <div>
                    <h4 class="font-medium text-red-800 mb-1">錯誤</h4>
                    <p class="text-red-700">{{ searchError || updateError }}</p>
                  </div>
                </div>
              </div>

              <!-- Search Results -->
              <div v-else-if="activeTab === 'search' && (searchResults.length || searchSummary)">
                <div class="mb-4">
                  <div class="text-xs font-medium text-slate-500 uppercase mb-2">AI 摘要</div>
                  <p class="text-slate-700 bg-blue-50 border border-blue-100 rounded-lg p-4">{{ searchSummary }}</p>
                </div>

                <div v-if="searchResults.length" class="space-y-3">
                  <div class="text-xs font-medium text-slate-500 uppercase mb-2">找到 {{ searchResults.length }} 位潛在候選人</div>
                  <div
                    v-for="(candidate, i) in searchResults"
                    :key="i"
                    class="border border-slate-200 rounded-lg p-4 hover:bg-slate-50"
                  >
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <div class="flex items-center gap-2 mb-1">
                          <span class="font-bold text-navy-900">{{ candidate.name }}</span>
                          <span
                            :class="[
                              'px-1.5 py-0.5 rounded text-[10px] font-medium',
                              candidate.status === 'confirmed' ? 'bg-emerald-100 text-emerald-700' :
                              candidate.status === 'likely' ? 'bg-blue-100 text-blue-700' :
                              'bg-amber-100 text-amber-700'
                            ]"
                          >
                            {{ candidate.status === 'confirmed' ? '已宣布' : candidate.status === 'likely' ? '可能參選' : '傳聞' }}
                          </span>
                        </div>
                        <div class="text-sm text-slate-600">
                          {{ candidate.party || '未知政黨' }} · {{ candidate.position }} · {{ candidate.region }}
                        </div>
                        <div v-if="candidate.current_position" class="text-xs text-slate-500 mt-1">
                          現任：{{ candidate.current_position }}
                        </div>
                        <div v-if="candidate.note" class="text-xs text-slate-400 mt-1">
                          {{ candidate.note }}
                        </div>
                      </div>
                      <button
                        v-if="!candidate.imported"
                        @click="importCandidate(candidate)"
                        :disabled="importingCandidate === candidate.name"
                        class="text-xs bg-navy-800 hover:bg-navy-700 disabled:bg-slate-300 text-white px-3 py-1.5 rounded-lg shrink-0 flex items-center gap-1"
                      >
                        <Loader2 v-if="importingCandidate === candidate.name" :size="12" class="animate-spin" />
                        {{ importingCandidate === candidate.name ? '匯入中...' : '匯入' }}
                      </button>
                      <span v-else class="text-xs text-emerald-600 flex items-center gap-1">
                        <CheckCircle :size="14" />
                        已匯入
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Update Results -->
              <div v-else-if="activeTab === 'update' && (updateResults.length || updateSummary)">
                <div class="mb-4">
                  <div class="text-xs font-medium text-slate-500 uppercase mb-2">更新摘要</div>
                  <p class="text-slate-700 bg-emerald-50 border border-emerald-100 rounded-lg p-4">{{ updateSummary }}</p>
                </div>

                <div v-if="updateResults.length" class="space-y-3">
                  <div class="text-xs font-medium text-slate-500 uppercase mb-2">更新了 {{ updateResults.length }} 筆政見</div>
                  <div
                    v-for="update in updateResults"
                    :key="update.policy_id"
                    class="border border-slate-200 rounded-lg p-4 bg-white"
                  >
                    <div class="font-medium text-navy-900 mb-1">{{ update.policy_title }}</div>
                    <p class="text-sm text-slate-600 mb-2">{{ update.event_description }}</p>
                    <div class="flex flex-wrap gap-2 text-xs">
                      <span v-if="update.new_status" class="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                        狀態: {{ update.new_status }}
                      </span>
                      <span v-if="update.new_progress !== undefined" class="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded">
                        進度: {{ update.new_progress }}%
                      </span>
                      <span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                        信心度: {{ Math.round(update.confidence * 100) }}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Log Detail -->
              <div v-else-if="activeTab === 'logs' && selectedLog">
                <div class="space-y-4">
                  <div class="flex items-center gap-3 mb-4">
                    <span
                      :class="[
                        'px-2 py-1 rounded text-xs font-medium',
                        selectedLog.function_type === 'verify' ? 'bg-blue-100 text-blue-700' :
                        selectedLog.function_type === 'search' ? 'bg-purple-100 text-purple-700' :
                        selectedLog.function_type === 'update' ? 'bg-emerald-100 text-emerald-700' :
                        'bg-amber-100 text-amber-700'
                      ]"
                    >
                      {{ selectedLog.function_type }}
                    </span>
                    <span class="text-sm text-slate-500">{{ formatDate(selectedLog.created_at) }}</span>
                    <CheckCircle v-if="selectedLog.success" :size="16" class="text-emerald-500" />
                    <XCircle v-else :size="16" class="text-red-500" />
                  </div>

                  <div v-if="selectedLog.input_message" class="space-y-1">
                    <div class="text-xs font-medium text-slate-500 uppercase">輸入訊息</div>
                    <div class="text-sm text-slate-700 bg-slate-50 p-3 rounded-lg border border-slate-200">
                      {{ selectedLog.input_message }}
                    </div>
                  </div>

                  <div v-if="selectedLog.input_url" class="space-y-1">
                    <div class="text-xs font-medium text-slate-500 uppercase">輸入網址</div>
                    <a :href="selectedLog.input_url" target="_blank" class="text-sm text-blue-600 hover:underline">{{ selectedLog.input_url }}</a>
                  </div>

                  <div v-if="selectedLog.raw_response" class="space-y-1">
                    <div class="text-xs font-medium text-slate-500 uppercase">AI 原始回應</div>
                    <div class="text-xs bg-navy-900 text-slate-300 p-4 rounded-lg font-mono whitespace-pre-wrap max-h-80 overflow-auto">
                      {{ selectedLog.raw_response }}
                    </div>
                  </div>

                  <div v-if="selectedLog.error_message" class="space-y-1">
                    <div class="text-xs font-medium text-red-500 uppercase">錯誤訊息</div>
                    <div class="text-sm text-red-700 bg-red-50 p-3 rounded-lg border border-red-200">
                      {{ selectedLog.error_message }}
                    </div>
                  </div>

                  <div class="flex flex-wrap gap-4 text-xs text-slate-500 pt-4 border-t border-slate-200">
                    <span>Model: {{ selectedLog.model_used }}</span>
                    <span>Tokens: {{ selectedLog.total_tokens?.toLocaleString() }}</span>
                    <span>費用: {{ formatCost(selectedLog.estimated_cost) }}</span>
                    <span v-if="selectedLog.confidence">信心度: {{ Math.round(selectedLog.confidence * 100) }}%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right: Operation Panel (4 cols) -->
        <div class="lg:col-span-4 space-y-4">
          <!-- Tabs -->
          <div class="bg-white p-2 rounded-xl border border-slate-200 shadow-sm">
            <div class="flex flex-col gap-1">
              <button
                @click="handleTabChange('search')"
                :class="[
                  'py-2 px-4 rounded-lg font-medium transition-colors flex items-center gap-2 text-sm',
                  activeTab === 'search'
                    ? 'bg-navy-800 text-white'
                    : 'text-slate-600 hover:bg-slate-100',
                ]"
              >
                <Search :size="16" />
                候選人搜尋
              </button>
              <button
                @click="handleTabChange('update')"
                :class="[
                  'py-2 px-4 rounded-lg font-medium transition-colors flex items-center gap-2 text-sm',
                  activeTab === 'update'
                    ? 'bg-navy-800 text-white'
                    : 'text-slate-600 hover:bg-slate-100',
                ]"
              >
                <RefreshCw :size="16" />
                政見進度更新
              </button>
              <button
                @click="handleTabChange('logs')"
                :class="[
                  'py-2 px-4 rounded-lg font-medium transition-colors flex items-center gap-2 text-sm',
                  activeTab === 'logs'
                    ? 'bg-navy-800 text-white'
                    : 'text-slate-600 hover:bg-slate-100',
                ]"
              >
                <FileText :size="16" />
                使用記錄
              </button>
            </div>
          </div>

          <!-- Search Form -->
          <div v-if="activeTab === 'search'" class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div>
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">選舉年份</label>
              <input
                v-model.number="searchYear"
                type="number"
                min="2020"
                max="2030"
                class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">縣市</label>
              <select v-model="searchRegion" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                <option value="">全部</option>
                <option v-for="r in regions" :key="r" :value="r">{{ r }}</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">職位</label>
              <select v-model="searchPosition" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                <option value="">全部</option>
                <option v-for="p in positions" :key="p" :value="p">{{ p }}</option>
              </select>
            </div>
            <button
              @click="handleSearch"
              :disabled="searchLoading"
              class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold py-2.5 rounded-lg flex items-center justify-center gap-2 text-sm"
            >
              <Loader2 v-if="searchLoading" :size="16" class="animate-spin" />
              <Search v-else :size="16" />
              {{ searchLoading ? '搜尋中...' : '開始搜尋' }}
            </button>
          </div>

          <!-- Update Form -->
          <div v-if="activeTab === 'update'" class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div>
              <label class="block text-xs font-medium text-slate-500 uppercase mb-2">更新範圍</label>
              <div class="space-y-2">
                <label class="flex items-center gap-2 text-sm">
                  <input type="radio" v-model="updateMode" value="election" class="text-blue-600" />
                  <span>按選舉</span>
                </label>
                <label class="flex items-center gap-2 text-sm">
                  <input type="radio" v-model="updateMode" value="politician" class="text-blue-600" />
                  <span>按政治人物</span>
                </label>
                <label class="flex items-center gap-2 text-sm">
                  <input type="radio" v-model="updateMode" value="policy" class="text-blue-600" />
                  <span>按政見</span>
                </label>
              </div>
            </div>

            <div v-if="updateMode === 'election'">
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">選擇選舉</label>
              <select v-model="updateElectionId" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                <option :value="null">請選擇...</option>
                <option v-for="e in elections" :key="e.id" :value="e.id">{{ e.name }}</option>
              </select>
            </div>

            <div v-if="updateMode === 'politician'">
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">政治人物 ID</label>
              <input
                v-model.number="updatePoliticianId"
                type="number"
                class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                placeholder="輸入 ID"
              />
            </div>

            <div v-if="updateMode === 'policy'">
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">政見 ID</label>
              <input
                v-model.number="updatePolicyId"
                type="number"
                class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                placeholder="輸入 ID"
              />
            </div>

            <button
              @click="handleUpdate"
              :disabled="updateLoading"
              class="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold py-2.5 rounded-lg flex items-center justify-center gap-2 text-sm"
            >
              <Loader2 v-if="updateLoading" :size="16" class="animate-spin" />
              <RefreshCw v-else :size="16" />
              {{ updateLoading ? '更新中...' : '執行更新' }}
            </button>
          </div>

          <!-- Logs List -->
          <div v-if="activeTab === 'logs'" class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-200 flex justify-between items-center">
              <span class="text-xs font-medium text-slate-500 uppercase">使用記錄</span>
              <button
                @click="fetchLogs"
                :disabled="logsLoading"
                class="text-slate-400 hover:text-navy-900 p-1"
              >
                <Loader2 v-if="logsLoading" :size="14" class="animate-spin" />
                <RefreshCw v-else :size="14" />
              </button>
            </div>

            <div v-if="logsLoading && logs.length === 0" class="text-center py-8">
              <Loader2 :size="20" class="animate-spin text-slate-400 mx-auto" />
            </div>

            <div v-else class="max-h-[400px] overflow-y-auto">
              <div
                v-for="log in logs"
                :key="log.id"
                @click="selectLog(log)"
                :class="[
                  'px-4 py-3 border-b border-slate-100 cursor-pointer transition-colors',
                  selectedLog?.id === log.id ? 'bg-blue-50' : 'hover:bg-slate-50'
                ]"
              >
                <div class="flex items-center gap-2 mb-1">
                  <span
                    :class="[
                      'px-1.5 py-0.5 rounded text-[10px] font-medium',
                      log.function_type === 'verify' ? 'bg-blue-100 text-blue-700' :
                      log.function_type === 'search' ? 'bg-purple-100 text-purple-700' :
                      log.function_type === 'update' ? 'bg-emerald-100 text-emerald-700' :
                      'bg-amber-100 text-amber-700'
                    ]"
                  >
                    {{ log.function_type }}
                  </span>
                  <CheckCircle v-if="log.success" :size="12" class="text-emerald-500" />
                  <XCircle v-else :size="12" class="text-red-500" />
                  <span class="text-[10px] text-slate-400 ml-auto">{{ formatDate(log.created_at) }}</span>
                </div>
                <div class="text-xs text-slate-600 truncate">
                  {{ log.input_message || log.input_url || '-' }}
                </div>
              </div>
            </div>

            <!-- Pagination -->
            <div class="px-4 py-2 border-t border-slate-200 flex justify-between items-center text-xs">
              <button
                @click="logsPage--; fetchLogs()"
                :disabled="logsPage === 0 || logsLoading"
                class="text-slate-500 hover:text-navy-900 disabled:opacity-50"
              >
                上一頁
              </button>
              <span class="text-slate-400">{{ logsPage + 1 }}</span>
              <button
                @click="logsPage++; fetchLogs()"
                :disabled="logs.length < logsPageSize || logsLoading"
                class="text-slate-500 hover:text-navy-900 disabled:opacity-50"
              >
                下一頁
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
