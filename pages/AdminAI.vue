<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
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

const { isAuthenticated, isAdmin, signInWithGoogle, userEmail } = useAuth()
const { elections } = useSupabase()

// Tab state
const activeTab = ref<'search' | 'update' | 'logs' | 'history'>('search')

// =====================
// Search Tab State
// =====================
const searchYear = ref(2026)
const searchRegion = ref('')
const searchPosition = ref('')
const searchName = ref('')
const searchLoading = ref(false)
const searchError = ref<string | null>(null)
const searchResults = ref<any[]>([])
const searchSummary = ref('')
const searchSources = ref<string[]>([])
const importingCandidate = ref<string | null>(null)
const importingAll = ref(false)
const importProgress = ref({ current: 0, total: 0, success: 0, failed: 0 })

// Polling state
const currentPromptId = ref<string | null>(null)
const pollingInterval = ref<ReturnType<typeof setInterval> | null>(null)
const pollingStatus = ref<string>('idle') // idle, polling, completed, failed
const pollingMessage = ref('')

// 自動批次搜尋匯入
const autoBatchRunning = ref(false)
const autoBatchProgress = ref({
  currentRegion: '',
  currentRegionIndex: 0,
  totalRegions: 0,
  totalCandidates: 0,
  importedCount: 0,
  failedCount: 0,
  logs: [] as string[],
})

const regions = [
  '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市',
  '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣',
  '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣',
  '台東縣', '澎湖縣', '金門縣', '連江縣',
]

const positions = ['縣市長', '縣市議員', '立法委員', '總統副總統']

// Polling configuration
const POLL_INTERVAL = 5000 // 5 seconds
const POLL_TIMEOUT = 300000 // 5 minutes

async function pollForResult(promptId: string): Promise<any> {
  const startTime = Date.now()

  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const response = await supabase.functions.invoke('ai-prompt-status', {
          body: { prompt_id: promptId },
        })

        if (response.error) {
          throw new Error(response.error.message)
        }

        const data = response.data
        if (data.error) {
          throw new Error(data.message || data.error)
        }

        const status = data.prompt?.status
        pollingMessage.value = data.message || `狀態: ${status}`

        if (status === 'completed') {
          pollingStatus.value = 'completed'
          stopPolling()
          resolve(data.prompt)
        } else if (status === 'failed') {
          pollingStatus.value = 'failed'
          stopPolling()
          reject(new Error(data.prompt?.error_message || '任務失敗'))
        } else if (Date.now() - startTime > POLL_TIMEOUT) {
          pollingStatus.value = 'failed'
          stopPolling()
          reject(new Error('任務超時'))
        }
        // Continue polling for pending/processing status
      } catch (err: any) {
        pollingStatus.value = 'failed'
        stopPolling()
        reject(err)
      }
    }

    pollingInterval.value = setInterval(poll, POLL_INTERVAL)
    poll() // Initial poll
  })
}

function stopPolling() {
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value)
    pollingInterval.value = null
  }
}

async function handleSearch() {
  searchLoading.value = true
  searchError.value = null
  searchResults.value = []
  searchSources.value = []
  pollingStatus.value = 'idle'
  pollingMessage.value = ''

  try {
    // Step 1: Create the prompt
    const response = await supabase.functions.invoke('ai-search', {
      body: {
        election_year: searchYear.value,
        region: searchRegion.value || undefined,
        position: searchPosition.value || undefined,
        name: searchName.value || undefined,
      },
    })

    if (response.error) {
      throw new Error(response.error.message)
    }

    const data = response.data
    if (data.error) {
      throw new Error(data.message || data.error)
    }

    currentPromptId.value = data.prompt_id
    pollingStatus.value = 'polling'
    pollingMessage.value = '任務已建立，等待處理...'

    // Step 2: Poll for result
    const result = await pollForResult(data.prompt_id)

    // Step 3: Process result
    if (result.result_data) {
      const resultData = result.result_data

      // Filter invalid candidates
      const invalidPatterns = ['未定', '待定', '待確認', '尚待確認', '未知', '人選', '其他', '待公布']
      const validCandidates = (resultData.candidates || []).filter((c: any) => {
        if (!c.name || c.name.length < 2 || c.name.length > 10) return false
        if (invalidPatterns.some(p => c.name.includes(p))) return false
        return true
      })

      searchResults.value = validCandidates
      searchSummary.value = resultData.summary || result.result_summary || '搜尋完成'
      searchSources.value = resultData.sources || []
    } else {
      searchSummary.value = result.result_summary || '搜尋完成，但沒有找到候選人'
    }

  } catch (err: any) {
    searchError.value = err.message || '搜尋失敗'
    pollingStatus.value = 'failed'
  } finally {
    searchLoading.value = false
    currentPromptId.value = null
  }
}

async function importCandidate(candidate: any, silent = false) {
  if (!silent) importingCandidate.value = candidate.name

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
    if (!silent) alert(data.message)
    return true
  } catch (err: any) {
    if (!silent) alert('匯入失敗: ' + (err.message || '未知錯誤'))
    return false
  } finally {
    if (!silent) importingCandidate.value = null
  }
}

async function importAllCandidates() {
  const toImport = searchResults.value.filter(c => !c.imported)
  if (toImport.length === 0) {
    alert('沒有需要匯入的候選人')
    return
  }

  if (!confirm(`確定要匯入 ${toImport.length} 位候選人嗎？`)) {
    return
  }

  importingAll.value = true
  importProgress.value = { current: 0, total: toImport.length, success: 0, failed: 0 }

  for (const candidate of toImport) {
    importProgress.value.current++
    const success = await importCandidate(candidate, true)
    if (success) {
      importProgress.value.success++
    } else {
      importProgress.value.failed++
    }
  }

  importingAll.value = false
  alert(`匯入完成！成功: ${importProgress.value.success}, 失敗: ${importProgress.value.failed}`)
}

// 自動批次搜尋並匯入所有縣市的縣市長
async function startAutoBatch() {
  if (!confirm(`確定要自動搜尋並匯入 ${searchYear.value} 年所有縣市的縣市長候選人嗎？\n\n這將依序搜尋 ${regions.length} 個縣市，每個縣市搜尋後自動匯入。\n\n注意：使用新的 Claude 處理系統，每個搜尋可能需要較長時間。`)) {
    return
  }

  autoBatchRunning.value = true
  autoBatchProgress.value = {
    currentRegion: '',
    currentRegionIndex: 0,
    totalRegions: regions.length,
    totalCandidates: 0,
    importedCount: 0,
    failedCount: 0,
    logs: [],
  }

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString('zh-TW')
    autoBatchProgress.value.logs.unshift(`[${time}] ${msg}`)
    if (autoBatchProgress.value.logs.length > 50) {
      autoBatchProgress.value.logs.pop()
    }
  }

  addLog(`開始批次搜尋 ${searchYear.value} 年縣市長候選人 (使用 Claude)...`)

  for (let i = 0; i < regions.length; i++) {
    if (!autoBatchRunning.value) {
      addLog('批次處理已停止')
      break
    }

    const region = regions[i]
    autoBatchProgress.value.currentRegion = region
    autoBatchProgress.value.currentRegionIndex = i + 1

    addLog(`搜尋 ${region} 縣市長候選人...`)

    try {
      // Create search prompt
      const createResponse = await supabase.functions.invoke('ai-search', {
        body: {
          election_year: searchYear.value,
          region: region,
          position: '縣市長',
        },
      })

      if (createResponse.error || createResponse.data?.error) {
        addLog(`❌ ${region} 建立任務失敗: ${createResponse.error?.message || createResponse.data?.message}`)
        continue
      }

      const promptId = createResponse.data.prompt_id
      addLog(`✓ ${region} 任務已建立，等待處理...`)

      // Poll for result with timeout
      try {
        const result = await pollForResult(promptId)

        if (result.result_data?.candidates) {
          const invalidPatterns = ['未定', '待定', '待確認', '尚待確認', '未知', '人選', '其他', '待公布']
          const candidates = result.result_data.candidates.filter((c: any) => {
            if (!c.name || c.name.length < 2 || c.name.length > 10) return false
            if (invalidPatterns.some(p => c.name.includes(p))) return false
            return true
          })

          const skipped = result.result_data.candidates.length - candidates.length
          addLog(`✓ ${region} 找到 ${candidates.length} 位候選人${skipped > 0 ? ` (略過 ${skipped} 筆無效)` : ''}`)
          autoBatchProgress.value.totalCandidates += candidates.length

          // Import each candidate
          for (const candidate of candidates) {
            try {
              const importResponse = await supabase.functions.invoke('import-candidate', {
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

              if (importResponse.error || importResponse.data?.error) {
                addLog(`  ⚠ ${candidate.name} 匯入失敗`)
                autoBatchProgress.value.failedCount++
              } else {
                addLog(`  ✓ ${candidate.name} ${importResponse.data?.updated ? '(已更新)' : '(已匯入)'}`)
                autoBatchProgress.value.importedCount++
              }
            } catch (err: any) {
              addLog(`  ⚠ ${candidate.name} 匯入錯誤: ${err.message}`)
              autoBatchProgress.value.failedCount++
            }
          }
        } else {
          addLog(`⚠ ${region} 搜尋完成但沒有找到候選人`)
        }
      } catch (pollErr: any) {
        addLog(`❌ ${region} 處理失敗: ${pollErr.message}`)
      }

      // Wait between regions to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000))

    } catch (err: any) {
      addLog(`❌ ${region} 處理錯誤: ${err.message}`)
    }
  }

  addLog(`🎉 批次處理完成！共找到 ${autoBatchProgress.value.totalCandidates} 位候選人，成功 ${autoBatchProgress.value.importedCount}，失敗 ${autoBatchProgress.value.failedCount}`)
  autoBatchRunning.value = false
}

function stopAutoBatch() {
  autoBatchRunning.value = false
  stopPolling()
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
// History Tab State
// =====================
const prompts = ref<any[]>([])
const promptsLoading = ref(false)
const promptsError = ref<string | null>(null)
const promptsPage = ref(0)
const promptsPageSize = 10
const selectedPrompt = ref<any>(null)

async function fetchPrompts() {
  promptsLoading.value = true
  promptsError.value = null

  try {
    const { data, error } = await supabase
      .from('ai_prompts')
      .select('*')
      .order('created_at', { ascending: false })
      .range(promptsPage.value * promptsPageSize, (promptsPage.value + 1) * promptsPageSize - 1)

    if (error) throw error
    prompts.value = data || []
  } catch (err: any) {
    promptsError.value = err.message || '載入歷史記錄失敗'
  } finally {
    promptsLoading.value = false
  }
}

async function viewPromptResult(prompt: any) {
  selectedPrompt.value = prompt
  // If completed, process result_data
  if (prompt.status === 'completed' && prompt.result_data) {
    const resultData = prompt.result_data
    const invalidPatterns = ['未定', '待定', '待確認', '尚待確認', '未知', '人選', '其他', '待公布']
    const validCandidates = (resultData.candidates || []).filter((c: any) => {
      if (!c.name || c.name.length < 2 || c.name.length > 10) return false
      if (invalidPatterns.some(p => c.name.includes(p))) return false
      return true
    })
    searchResults.value = validCandidates
    searchSummary.value = resultData.summary || prompt.result_summary || '搜尋完成'
    searchSources.value = resultData.sources || []
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

function getStatusLabel(status: string): string {
  switch (status) {
    case 'completed': return '已完成'
    case 'processing': return '處理中'
    case 'pending': return '等待中'
    case 'failed': return '失敗'
    default: return status
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

onUnmounted(() => {
  stopPolling()
})

function handleTabChange(tab: 'search' | 'update' | 'logs' | 'history') {
  activeTab.value = tab
  if (tab === 'logs' && logs.value.length === 0) {
    fetchLogs()
  }
  if (tab === 'history' && prompts.value.length === 0) {
    fetchPrompts()
  }
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>AI 管理</template>
      <template #description>
        使用 Claude AI 搜尋候選人資訊、更新政見進度，以及查看 AI 使用記錄
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
                <span v-if="pollingStatus === 'polling'" class="text-xs text-amber-600 ml-2 flex items-center gap-1">
                  <Loader2 :size="12" class="animate-spin" />
                  {{ pollingMessage }}
                </span>
              </h3>
            </div>

            <!-- Content Area -->
            <div class="p-6">
              <!-- Loading State -->
              <div v-if="searchLoading || updateLoading" class="flex flex-col items-center justify-center py-20">
                <Loader2 :size="48" class="animate-spin text-blue-500 mb-4" />
                <p class="text-slate-500 mb-2">
                  {{ pollingStatus === 'polling' ? 'Claude 處理中...' : 'AI 處理中...' }}
                </p>
                <p v-if="pollingMessage" class="text-xs text-slate-400">{{ pollingMessage }}</p>
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

              <!-- Search Results (from search or history) -->
              <div v-else-if="(activeTab === 'search' || activeTab === 'history') && (searchResults.length || searchSummary)">
                <div class="mb-4">
                  <div class="text-xs font-medium text-slate-500 uppercase mb-2">AI 摘要</div>
                  <p class="text-slate-700 bg-blue-50 border border-blue-100 rounded-lg p-4">{{ searchSummary }}</p>
                </div>

                <!-- 搜尋來源 -->
                <div v-if="searchSources.length" class="mb-4">
                  <div class="text-xs font-medium text-slate-500 uppercase mb-2">搜尋來源 ({{ searchSources.length }})</div>
                  <div class="bg-slate-50 border border-slate-200 rounded-lg p-3 max-h-32 overflow-y-auto">
                    <div v-for="(url, i) in searchSources" :key="i" class="text-xs text-blue-600 hover:underline truncate mb-1">
                      <a :href="url" target="_blank" rel="noopener">{{ url }}</a>
                    </div>
                  </div>
                </div>

                <div v-if="searchResults.length" class="space-y-3">
                  <div class="flex items-center justify-between mb-2">
                    <div class="text-xs font-medium text-slate-500 uppercase">找到 {{ searchResults.length }} 位潛在候選人</div>
                    <button
                      v-if="searchResults.some(c => !c.imported)"
                      @click="importAllCandidates"
                      :disabled="importingAll"
                      class="text-xs bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white px-3 py-1.5 rounded-lg flex items-center gap-1"
                    >
                      <Loader2 v-if="importingAll" :size="12" class="animate-spin" />
                      <CheckCircle v-else :size="12" />
                      {{ importingAll ? `匯入中 ${importProgress.current}/${importProgress.total}` : '一鍵匯入全部' }}
                    </button>
                  </div>
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
                          <span v-if="candidate.confidence" class="text-[10px] text-slate-400">
                            信心度: {{ Math.round(candidate.confidence * 100) }}%
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
                @click="handleTabChange('history')"
                :class="[
                  'py-2 px-4 rounded-lg font-medium transition-colors flex items-center gap-2 text-sm',
                  activeTab === 'history'
                    ? 'bg-navy-800 text-white'
                    : 'text-slate-600 hover:bg-slate-100',
                ]"
              >
                <Clock :size="16" />
                搜尋歷史
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
            <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
              <strong>Claude AI 模式</strong>：搜尋任務會交給 Claude 處理，可能需要等待較長時間。
            </div>

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
            <div>
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">指定人名 (選填)</label>
              <input
                v-model="searchName"
                type="text"
                placeholder="例：蔣萬安、陳時中"
                class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <button
              @click="handleSearch"
              :disabled="searchLoading || autoBatchRunning"
              class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold py-2.5 rounded-lg flex items-center justify-center gap-2 text-sm"
            >
              <Loader2 v-if="searchLoading" :size="16" class="animate-spin" />
              <Search v-else :size="16" />
              {{ searchLoading ? '搜尋中...' : '開始搜尋' }}
            </button>

            <!-- 分隔線 -->
            <div class="border-t border-slate-200 pt-4">
              <div class="text-xs font-medium text-slate-500 uppercase mb-3">自動批次模式</div>
              <button
                v-if="!autoBatchRunning"
                @click="startAutoBatch"
                :disabled="searchLoading"
                class="w-full bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 text-white font-bold py-2.5 rounded-lg flex items-center justify-center gap-2 text-sm"
              >
                <Sparkles :size="16" />
                自動搜尋匯入全部縣市長
              </button>
              <button
                v-else
                @click="stopAutoBatch"
                class="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-2.5 rounded-lg flex items-center justify-center gap-2 text-sm"
              >
                <XCircle :size="16" />
                停止批次處理
              </button>
            </div>
          </div>

          <!-- Auto Batch Progress -->
          <div v-if="activeTab === 'search' && (autoBatchRunning || autoBatchProgress.logs.length)" class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
            <div class="flex items-center justify-between mb-3">
              <div class="text-xs font-medium text-slate-500 uppercase">批次處理進度</div>
              <div v-if="autoBatchRunning" class="flex items-center gap-2 text-xs text-amber-600">
                <Loader2 :size="12" class="animate-spin" />
                處理中
              </div>
              <div v-else class="text-xs text-emerald-600">已完成</div>
            </div>

            <div v-if="autoBatchRunning" class="mb-3">
              <div class="text-sm font-medium text-navy-900 mb-1">
                {{ autoBatchProgress.currentRegion }} ({{ autoBatchProgress.currentRegionIndex }}/{{ autoBatchProgress.totalRegions }})
              </div>
              <div class="w-full bg-slate-200 rounded-full h-2">
                <div
                  class="bg-amber-500 h-2 rounded-full transition-all"
                  :style="{ width: `${(autoBatchProgress.currentRegionIndex / autoBatchProgress.totalRegions) * 100}%` }"
                ></div>
              </div>
            </div>

            <div class="flex gap-4 text-xs text-slate-600 mb-3">
              <span>找到: {{ autoBatchProgress.totalCandidates }}</span>
              <span class="text-emerald-600">成功: {{ autoBatchProgress.importedCount }}</span>
              <span class="text-red-600">失敗: {{ autoBatchProgress.failedCount }}</span>
            </div>

            <div class="bg-slate-900 rounded-lg p-3 max-h-40 overflow-y-auto font-mono text-[11px] text-slate-300">
              <div v-for="(log, i) in autoBatchProgress.logs" :key="i" class="leading-relaxed">
                {{ log }}
              </div>
              <div v-if="!autoBatchProgress.logs.length" class="text-slate-500">等待開始...</div>
            </div>
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

          <!-- History List -->
          <div v-if="activeTab === 'history'" class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-200 flex justify-between items-center">
              <span class="text-xs font-medium text-slate-500 uppercase">AI 搜尋歷史</span>
              <button
                @click="fetchPrompts"
                :disabled="promptsLoading"
                class="text-slate-400 hover:text-navy-900 p-1"
              >
                <Loader2 v-if="promptsLoading" :size="14" class="animate-spin" />
                <RefreshCw v-else :size="14" />
              </button>
            </div>

            <div v-if="promptsLoading && prompts.length === 0" class="text-center py-8">
              <Loader2 :size="20" class="animate-spin text-slate-400 mx-auto" />
            </div>

            <div v-else-if="promptsError" class="p-4 text-sm text-red-600">
              {{ promptsError }}
            </div>

            <div v-else class="max-h-[500px] overflow-y-auto">
              <div
                v-for="prompt in prompts"
                :key="prompt.id"
                @click="viewPromptResult(prompt)"
                :class="[
                  'px-4 py-3 border-b border-slate-100 cursor-pointer transition-colors',
                  selectedPrompt?.id === prompt.id ? 'bg-blue-50' : 'hover:bg-slate-50'
                ]"
              >
                <div class="flex items-center gap-2 mb-1">
                  <span
                    :class="[
                      'px-1.5 py-0.5 rounded text-[10px] font-medium',
                      getStatusColor(prompt.status)
                    ]"
                  >
                    {{ getStatusLabel(prompt.status) }}
                  </span>
                  <span class="text-[10px] text-slate-400 ml-auto">
                    {{ formatDate(prompt.created_at) }}
                  </span>
                </div>
                <div class="text-sm font-medium text-navy-900 mb-1">
                  {{ prompt.task_type === 'candidate_search' ? '候選人搜尋' : prompt.task_type }}
                </div>
                <div class="text-xs text-slate-600">
                  <span v-if="prompt.parameters?.region">{{ prompt.parameters.region }}</span>
                  <span v-if="prompt.parameters?.position"> · {{ prompt.parameters.position }}</span>
                  <span v-if="prompt.parameters?.election_year"> · {{ prompt.parameters.election_year }}年</span>
                </div>
                <div v-if="prompt.result_summary" class="text-xs text-slate-500 mt-1 line-clamp-2">
                  {{ prompt.result_summary }}
                </div>
                <div v-if="prompt.error_message" class="text-xs text-red-500 mt-1">
                  {{ prompt.error_message }}
                </div>
              </div>

              <div v-if="prompts.length === 0" class="p-8 text-center text-slate-400 text-sm">
                尚無搜尋歷史
              </div>
            </div>

            <!-- Pagination -->
            <div class="px-4 py-2 border-t border-slate-200 flex justify-between items-center text-xs">
              <button
                @click="promptsPage--; fetchPrompts()"
                :disabled="promptsPage === 0 || promptsLoading"
                class="text-slate-500 hover:text-navy-900 disabled:opacity-50"
              >
                上一頁
              </button>
              <span class="text-slate-400">{{ promptsPage + 1 }}</span>
              <button
                @click="promptsPage++; fetchPrompts()"
                :disabled="prompts.length < promptsPageSize || promptsLoading"
                class="text-slate-500 hover:text-navy-900 disabled:opacity-50"
              >
                下一頁
              </button>
            </div>
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
