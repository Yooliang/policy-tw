<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import { useAuth } from '../composables/useAuth'
import { useSupabase } from '../composables/useSupabase'
import { supabase } from '../lib/supabase'
import {
  Search,
  Link,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Sparkles,
  Send,
  User,
  Calendar,
  Tag,
  FileText,
  ChevronDown,
  ChevronUp,
} from 'lucide-vue-next'

const router = useRouter()
const { isAuthenticated, signInWithGoogle, userDisplayName, session } = useAuth()
const { politicians } = useSupabase()

// Form state
const message = ref('')
const url = ref('')
const isLoading = ref(false)
const error = ref<string | null>(null)

// Result state
interface ExtractedPolicy {
  title: string
  description: string
  category: string
  tags: string[]
}

interface AnalysisResult {
  is_election_related: boolean
  is_policy_content: boolean
  extracted_info?: {
    politician_name?: string
    politician_matched_id?: string
    election_year?: number
    position?: string
    policies?: ExtractedPolicy[]
  }
  summary: string
  confidence: number
  can_contribute: boolean
  usage: {
    tokens: number
    estimated_cost: number
  }
  rate_limit: {
    ip_remaining: number
    user_remaining: number
  }
  log_id?: string
}

const result = ref<AnalysisResult | null>(null)
const rateLimitInfo = ref<{ ip_remaining: number; user_remaining: number } | null>(null)

// Contribute state
const isContributing = ref(false)
const contributeSuccess = ref(false)
const contributeError = ref<string | null>(null)
const showContributeForm = ref(false)

// Editable contribute form
const selectedPoliticianId = ref<string | null>(null)
const editedPolicy = ref<{
  title: string
  description: string
  category: string
  tags: string[]
}>({
  title: '',
  description: '',
  category: '',
  tags: [],
})

const confidencePercentage = computed(() => {
  if (!result.value) return 0
  return Math.round(result.value.confidence * 100)
})

const confidenceColor = computed(() => {
  const pct = confidencePercentage.value
  if (pct >= 90) return 'text-emerald-600'
  if (pct >= 70) return 'text-amber-600'
  return 'text-red-600'
})

const matchedPolitician = computed(() => {
  if (!result.value?.extracted_info?.politician_matched_id) return null
  const matchId = String(result.value.extracted_info.politician_matched_id)
  return politicians.value.find(p => p.id === matchId)
})

// Category options
const categories = [
  '交通建設',
  '社會福利',
  '經濟發展',
  '環境保護',
  '教育文化',
  '居住正義',
  '醫療衛生',
  '治安司法',
  '其他',
]

async function handleSubmit() {
  if (!message.value.trim()) {
    error.value = '請輸入要查核的內容'
    return
  }

  isLoading.value = true
  error.value = null
  result.value = null
  contributeSuccess.value = false
  contributeError.value = null
  showContributeForm.value = false

  try {
    const response = await supabase.functions.invoke('ai-verify', {
      body: {
        message: message.value,
        url: url.value || undefined,
      },
    })

    if (response.error) {
      throw new Error(response.error.message || '分析失敗')
    }

    const data = response.data
    if (data.error) {
      if (data.rate_limit) {
        rateLimitInfo.value = data.rate_limit
      }
      throw new Error(data.message || data.error)
    }

    result.value = data
    rateLimitInfo.value = data.rate_limit

    // Pre-fill contribute form if applicable
    if (data.can_contribute && data.extracted_info?.policies?.length > 0) {
      const firstPolicy = data.extracted_info.policies[0]
      editedPolicy.value = {
        title: firstPolicy.title,
        description: firstPolicy.description,
        category: firstPolicy.category,
        tags: firstPolicy.tags || [],
      }
      selectedPoliticianId.value = data.extracted_info.politician_matched_id
        ? String(data.extracted_info.politician_matched_id)
        : null
    }
  } catch (err: any) {
    error.value = err.message || '分析時發生錯誤'
  } finally {
    isLoading.value = false
  }
}

async function handleContribute() {
  if (!result.value?.log_id || !selectedPoliticianId.value) {
    contributeError.value = '請選擇政治人物'
    return
  }

  if (!editedPolicy.value.title || !editedPolicy.value.description || !editedPolicy.value.category) {
    contributeError.value = '請填寫完整的政見資料'
    return
  }

  isContributing.value = true
  contributeError.value = null

  try {
    const response = await supabase.functions.invoke('ai-contribute', {
      body: {
        original_analysis_id: result.value.log_id,
        politician_id: selectedPoliticianId.value,
        policy: {
          title: editedPolicy.value.title,
          description: editedPolicy.value.description,
          category: editedPolicy.value.category,
          tags: editedPolicy.value.tags,
          source_url: url.value || undefined,
        },
      },
    })

    if (response.error) {
      throw new Error(response.error.message || '貢獻失敗')
    }

    const data = response.data
    if (!data.success) {
      throw new Error(data.message || '貢獻失敗')
    }

    contributeSuccess.value = true
    showContributeForm.value = false
  } catch (err: any) {
    contributeError.value = err.message || '貢獻時發生錯誤'
  } finally {
    isContributing.value = false
  }
}

function formatCost(cost: number): string {
  if (cost < 0.001) return '< $0.001'
  return `$${cost.toFixed(4)}`
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>政見內容查核</template>
      <template #description>
        使用 AI 分析網路上的政見相關內容，<br />幫助您判斷資訊的可信度並提取關鍵政見資料。
      </template>
      <template #icon>
        <Search :size="400" class="text-blue-500" />
      </template>
    </Hero>

    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <!-- Login Required Notice -->
      <div
        v-if="!isAuthenticated"
        class="bg-white p-8 rounded-2xl border border-slate-200 shadow-lg text-center"
      >
        <User :size="48" class="text-slate-400 mx-auto mb-4" />
        <h3 class="text-xl font-bold text-navy-900 mb-2">需要登入</h3>
        <p class="text-slate-600 mb-6">請先登入以使用 AI 政見查核功能</p>
        <button
          @click="signInWithGoogle"
          class="bg-navy-800 hover:bg-navy-700 text-white font-bold py-3 px-6 rounded-xl transition-colors"
        >
          使用 Google 登入
        </button>
      </div>

      <!-- Main Content (Authenticated) -->
      <div v-else class="space-y-8">
        <!-- Input Form -->
        <div class="bg-white p-8 rounded-2xl border border-slate-200 shadow-lg">
          <h3 class="text-xl font-bold text-navy-900 mb-6 flex items-center gap-2">
            <Sparkles class="text-amber-500" />
            輸入查核內容
          </h3>

          <form @submit.prevent="handleSubmit" class="space-y-6">
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-2"> 訊息內容 * </label>
              <textarea
                v-model="message"
                rows="5"
                class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                placeholder="請輸入您想查核的政見相關內容，例如新聞報導、社群貼文等..."
              ></textarea>
            </div>

            <div>
              <label class="block text-sm font-medium text-slate-700 mb-2">
                <Link :size="16" class="inline mr-1" />
                相關網址 (選填)
              </label>
              <input
                v-model="url"
                type="url"
                class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="https://example.com/news/article"
              />
              <p class="text-xs text-slate-500 mt-1">如有相關網址，AI 會一併分析網頁內容</p>
            </div>

            <!-- Error Message -->
            <div v-if="error" class="bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3">
              <AlertCircle :size="20" class="text-red-500 shrink-0 mt-0.5" />
              <p class="text-red-700">{{ error }}</p>
            </div>

            <!-- Submit Button -->
            <div class="flex items-center justify-between">
              <button
                type="submit"
                :disabled="isLoading || !message.trim()"
                class="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold py-3 px-6 rounded-xl transition-colors flex items-center gap-2"
              >
                <Loader2 v-if="isLoading" :size="20" class="animate-spin" />
                <Sparkles v-else :size="20" />
                {{ isLoading ? '分析中...' : '開始分析' }}
              </button>

              <div v-if="rateLimitInfo" class="text-sm text-slate-500">
                今日剩餘查詢: {{ rateLimitInfo.user_remaining }} / 50
              </div>
            </div>
          </form>
        </div>

        <!-- Analysis Result -->
        <div v-if="result" class="bg-white p-8 rounded-2xl border border-slate-200 shadow-lg">
          <h3 class="text-xl font-bold text-navy-900 mb-6">分析結果</h3>

          <!-- Status Indicators -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div
              class="flex items-center gap-3 p-4 rounded-xl"
              :class="result.is_election_related ? 'bg-emerald-50' : 'bg-slate-50'"
            >
              <CheckCircle
                v-if="result.is_election_related"
                :size="24"
                class="text-emerald-500"
              />
              <XCircle v-else :size="24" class="text-slate-400" />
              <span class="font-medium">選舉相關</span>
            </div>

            <div
              class="flex items-center gap-3 p-4 rounded-xl"
              :class="result.is_policy_content ? 'bg-emerald-50' : 'bg-slate-50'"
            >
              <CheckCircle v-if="result.is_policy_content" :size="24" class="text-emerald-500" />
              <XCircle v-else :size="24" class="text-slate-400" />
              <span class="font-medium">政見內容</span>
            </div>

            <div class="flex items-center gap-3 p-4 rounded-xl bg-slate-50">
              <div
                class="text-2xl font-bold"
                :class="confidenceColor"
              >
                {{ confidencePercentage }}%
              </div>
              <span class="font-medium text-slate-600">AI 信心度</span>
            </div>
          </div>

          <!-- Summary -->
          <div class="bg-slate-50 p-4 rounded-xl mb-6">
            <p class="text-slate-700">{{ result.summary }}</p>
          </div>

          <!-- Extracted Info -->
          <div
            v-if="result.extracted_info"
            class="border border-slate-200 rounded-xl p-6 mb-6"
          >
            <h4 class="font-bold text-navy-900 mb-4 flex items-center gap-2">
              <FileText :size="18" />
              提取的資訊
            </h4>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div v-if="result.extracted_info.politician_name">
                <span class="text-sm text-slate-500">政治人物</span>
                <p class="font-medium">
                  {{ result.extracted_info.politician_name }}
                  <span
                    v-if="matchedPolitician"
                    class="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded ml-2"
                  >
                    已匹配資料庫
                  </span>
                </p>
              </div>

              <div v-if="result.extracted_info.position">
                <span class="text-sm text-slate-500">參選職位</span>
                <p class="font-medium">{{ result.extracted_info.position }}</p>
              </div>

              <div v-if="result.extracted_info.election_year">
                <span class="text-sm text-slate-500">選舉年份</span>
                <p class="font-medium flex items-center gap-1">
                  <Calendar :size="14" />
                  {{ result.extracted_info.election_year }}
                </p>
              </div>
            </div>

            <!-- Extracted Policies -->
            <div v-if="result.extracted_info.policies?.length">
              <h5 class="font-medium text-slate-700 mb-3">提取的政見</h5>
              <div class="space-y-3">
                <div
                  v-for="(policy, index) in result.extracted_info.policies"
                  :key="index"
                  class="bg-white border border-slate-200 rounded-lg p-4"
                >
                  <div class="font-medium text-navy-900 mb-1">{{ policy.title }}</div>
                  <p class="text-sm text-slate-600 mb-2">{{ policy.description }}</p>
                  <div class="flex flex-wrap gap-2">
                    <span class="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                      {{ policy.category }}
                    </span>
                    <span
                      v-for="tag in policy.tags"
                      :key="tag"
                      class="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded flex items-center gap-1"
                    >
                      <Tag :size="10" />
                      {{ tag }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Contribute Section -->
          <div
            v-if="result.can_contribute && !contributeSuccess"
            class="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-6"
          >
            <div class="flex items-start gap-3 mb-4">
              <Sparkles :size="24" class="text-amber-500 shrink-0" />
              <div>
                <h4 class="font-bold text-navy-900">AI 分析信心度達 90% 以上!</h4>
                <p class="text-sm text-slate-600">
                  您可以將此政見資料貢獻到資料庫，幫助更多人追蹤政見執行進度
                </p>
              </div>
            </div>

            <button
              v-if="!showContributeForm"
              @click="showContributeForm = true"
              class="bg-amber-500 hover:bg-amber-600 text-white font-bold py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
            >
              <Send :size="16" />
              貢獻此政見資料
            </button>

            <!-- Contribute Form -->
            <div v-else class="mt-4 space-y-4">
              <div>
                <label class="block text-sm font-medium text-slate-700 mb-2">選擇政治人物 *</label>
                <select
                  v-model="selectedPoliticianId"
                  class="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500"
                >
                  <option :value="null">請選擇...</option>
                  <option
                    v-for="p in politicians"
                    :key="p.id"
                    :value="p.id"
                  >
                    {{ p.name }} ({{ p.party }})
                  </option>
                </select>
              </div>

              <div>
                <label class="block text-sm font-medium text-slate-700 mb-2">政見標題 *</label>
                <input
                  v-model="editedPolicy.title"
                  type="text"
                  class="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div>
                <label class="block text-sm font-medium text-slate-700 mb-2">政見描述 *</label>
                <textarea
                  v-model="editedPolicy.description"
                  rows="3"
                  class="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 resize-none"
                ></textarea>
              </div>

              <div>
                <label class="block text-sm font-medium text-slate-700 mb-2">分類 *</label>
                <select
                  v-model="editedPolicy.category"
                  class="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500"
                >
                  <option v-for="cat in categories" :key="cat" :value="cat">{{ cat }}</option>
                </select>
              </div>

              <!-- Error -->
              <div
                v-if="contributeError"
                class="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm"
              >
                {{ contributeError }}
              </div>

              <div class="flex gap-3">
                <button
                  @click="handleContribute"
                  :disabled="isContributing"
                  class="bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 text-white font-bold py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
                >
                  <Loader2 v-if="isContributing" :size="16" class="animate-spin" />
                  <Send v-else :size="16" />
                  {{ isContributing ? '提交中...' : '確認貢獻' }}
                </button>
                <button
                  @click="showContributeForm = false"
                  class="text-slate-600 hover:text-slate-800 py-2 px-4"
                >
                  取消
                </button>
              </div>
            </div>
          </div>

          <!-- Contribute Success -->
          <div
            v-if="contributeSuccess"
            class="bg-emerald-50 border border-emerald-200 rounded-xl p-6 flex items-center gap-3"
          >
            <CheckCircle :size="24" class="text-emerald-500" />
            <div>
              <h4 class="font-bold text-emerald-800">感謝您的貢獻!</h4>
              <p class="text-sm text-emerald-700">政見資料已成功加入資料庫</p>
            </div>
          </div>

          <!-- Usage Info -->
          <div class="mt-6 pt-4 border-t border-slate-200 text-sm text-slate-500 flex justify-between">
            <span>
              本次分析消耗: {{ result.usage.tokens.toLocaleString() }} tokens
              ({{ formatCost(result.usage.estimated_cost) }})
            </span>
            <span>Model: gemini-2.0-flash</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
