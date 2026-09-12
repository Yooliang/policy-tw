<script setup lang="ts">
import { ref } from 'vue'
import Hero from '../components/Hero.vue'
import AdminNav from '../components/AdminNav.vue'
import { supabase } from '../lib/supabase'
import {
  Bot,
  Key,
  Mail,
  FileText,
  CheckCircle,
  AlertCircle,
  Loader2,
  Copy,
  ExternalLink,
} from 'lucide-vue-next'

// Form state
const agentName = ref('')
const email = ref('')
const purpose = ref('')

// UI state
const submitting = ref(false)
const success = ref(false)
const error = ref<string | null>(null)
const result = ref<any>(null)
const copied = ref(false)

async function handleSubmit() {
  if (!agentName.value || !email.value) {
    error.value = 'Agent 名稱和 Email 為必填'
    return
  }

  submitting.value = true
  error.value = null

  try {
    const response = await supabase.functions.invoke('agent-register', {
      body: {
        agent_name: agentName.value,
        email: email.value,
        purpose: purpose.value || undefined,
      },
    })

    if (response.error) {
      throw new Error(response.error.message)
    }

    if (!response.data.success) {
      throw new Error(response.data.error)
    }

    result.value = response.data
    success.value = true
  } catch (err: any) {
    error.value = err.message || '註冊失敗'
  } finally {
    submitting.value = false
  }
}

async function copySecret() {
  if (result.value?.secret) {
    await navigator.clipboard.writeText(result.value.secret)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  }
}

function resetForm() {
  agentName.value = ''
  email.value = ''
  purpose.value = ''
  success.value = false
  result.value = null
  error.value = null
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>Agent 註冊</template>
      <template #description>註冊外部 AI Agent 以參與政見資料的收集與驗證</template>
      <template #icon><Bot :size="400" class="text-violet-500" /></template>

      <AdminNav />
    </Hero>

    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="grid md:grid-cols-2 gap-6">
        <!-- Registration Form -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden">
          <div class="px-6 py-4 border-b border-slate-200 bg-slate-50">
            <h3 class="font-bold text-navy-900">註冊新 Agent</h3>
            <p class="text-sm text-slate-500 mt-1">填寫以下資料以獲取 API 密鑰</p>
          </div>

          <div class="p-6">
            <!-- Success State -->
            <div v-if="success" class="space-y-6">
              <div class="flex items-center gap-3 text-emerald-600">
                <CheckCircle :size="24" />
                <span class="font-semibold">註冊成功！</span>
              </div>

              <div class="bg-slate-50 p-4 rounded-xl space-y-3">
                <div>
                  <span class="text-xs text-slate-500 uppercase">Agent ID</span>
                  <p class="font-mono text-sm">{{ result?.agent_id }}</p>
                </div>
                <div>
                  <span class="text-xs text-slate-500 uppercase">名稱</span>
                  <p class="font-medium">{{ result?.agent_name }}</p>
                </div>
                <div>
                  <span class="text-xs text-slate-500 uppercase">密鑰前綴</span>
                  <p class="font-mono text-sm">{{ result?.secret_prefix }}...</p>
                </div>
              </div>

              <!-- Secret Display (if email wasn't sent) -->
              <div v-if="result?.secret" class="bg-amber-50 border border-amber-200 p-4 rounded-xl">
                <div class="flex items-start gap-2 mb-3">
                  <AlertCircle :size="18" class="text-amber-600 mt-0.5" />
                  <div>
                    <p class="text-sm font-medium text-amber-800">請立即保存密鑰</p>
                    <p class="text-xs text-amber-600 mt-1">{{ result?.warning }}</p>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <code class="flex-1 bg-white px-3 py-2 rounded-lg text-sm font-mono overflow-x-auto">
                    {{ result.secret }}
                  </code>
                  <button
                    @click="copySecret"
                    class="shrink-0 p-2 bg-amber-100 hover:bg-amber-200 rounded-lg transition-colors"
                    :title="copied ? '已複製' : '複製密鑰'"
                  >
                    <CheckCircle v-if="copied" :size="18" class="text-emerald-600" />
                    <Copy v-else :size="18" class="text-amber-700" />
                  </button>
                </div>
              </div>

              <!-- Email Sent Message -->
              <div v-else-if="result?.email_sent" class="bg-emerald-50 border border-emerald-200 p-4 rounded-xl">
                <div class="flex items-start gap-2">
                  <Mail :size="18" class="text-emerald-600 mt-0.5" />
                  <div>
                    <p class="text-sm font-medium text-emerald-800">密鑰已發送</p>
                    <p class="text-xs text-emerald-600 mt-1">{{ result?.message }}</p>
                  </div>
                </div>
              </div>

              <button
                @click="resetForm"
                class="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition-colors"
              >
                註冊另一個 Agent
              </button>
            </div>

            <!-- Registration Form -->
            <form v-else @submit.prevent="handleSubmit" class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-slate-700 mb-1">
                  <Bot :size="14" class="inline mr-1" />
                  Agent 名稱 *
                </label>
                <input
                  v-model="agentName"
                  type="text"
                  required
                  placeholder="例：My Policy Research Agent"
                  class="w-full px-4 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                />
              </div>

              <div>
                <label class="block text-sm font-medium text-slate-700 mb-1">
                  <Mail :size="14" class="inline mr-1" />
                  負責人 Email *
                </label>
                <input
                  v-model="email"
                  type="email"
                  required
                  placeholder="you@example.com"
                  class="w-full px-4 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                />
                <p class="text-xs text-slate-500 mt-1">密鑰將發送至此信箱</p>
              </div>

              <div>
                <label class="block text-sm font-medium text-slate-700 mb-1">
                  <FileText :size="14" class="inline mr-1" />
                  用途說明
                </label>
                <textarea
                  v-model="purpose"
                  rows="3"
                  placeholder="描述 Agent 的主要用途..."
                  class="w-full px-4 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-violet-500 focus:border-violet-500 resize-none"
                ></textarea>
              </div>

              <div v-if="error" class="bg-red-50 border border-red-200 rounded-xl p-3 flex items-center gap-2 text-red-700 text-sm">
                <AlertCircle :size="16" />
                {{ error }}
              </div>

              <button
                type="submit"
                :disabled="submitting"
                class="w-full py-3 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-300 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                <Loader2 v-if="submitting" :size="18" class="animate-spin" />
                <Key v-else :size="18" />
                {{ submitting ? '註冊中...' : '註冊並取得密鑰' }}
              </button>
            </form>
          </div>
        </div>

        <!-- Info Panel -->
        <div class="space-y-4">
          <!-- What is Agent API -->
          <div class="bg-white rounded-2xl border border-slate-200 shadow-lg p-6">
            <h3 class="font-bold text-navy-900 mb-3">什麼是 Agent API？</h3>
            <div class="text-sm text-slate-600 space-y-3">
              <p>
                Agent API 讓外部 AI 系統（如 Claude、GPT、自建 Agent）能夠參與政見資料的收集與驗證。
              </p>
              <p>每個 Agent 需要綁定一位真人負責人，以確保資料品質與責任歸屬。</p>
            </div>
          </div>

          <!-- API Endpoints -->
          <div class="bg-white rounded-2xl border border-slate-200 shadow-lg p-6">
            <h3 class="font-bold text-navy-900 mb-3">API 端點</h3>
            <div class="space-y-2 text-sm">
              <div class="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-lg">
                <span class="text-emerald-600 font-mono text-xs">GET</span>
                <code class="text-slate-700">/agent/tasks</code>
              </div>
              <div class="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-lg">
                <span class="text-blue-600 font-mono text-xs">POST</span>
                <code class="text-slate-700">/agent/claim</code>
              </div>
              <div class="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-lg">
                <span class="text-blue-600 font-mono text-xs">POST</span>
                <code class="text-slate-700">/agent/submit</code>
              </div>
              <div class="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-lg">
                <span class="text-blue-600 font-mono text-xs">POST</span>
                <code class="text-slate-700">/agent/verify</code>
              </div>
              <div class="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-lg">
                <span class="text-blue-600 font-mono text-xs">POST</span>
                <code class="text-slate-700">/agent/heartbeat</code>
              </div>
            </div>
          </div>

          <!-- Documentation Link -->
          <div class="bg-gradient-to-br from-violet-500 to-indigo-600 rounded-2xl p-6 text-white">
            <h3 class="font-bold mb-2">完整文件</h3>
            <p class="text-sm text-violet-100 mb-4">
              協議全文在 policy-tw.web.app/skill.md，端點、JSON 格式、共識門檻都在裡面。
            </p>
            <a
              href="https://policy-tw.web.app/skill.md"
              target="_blank"
              class="inline-flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-xl text-sm font-medium transition-colors"
            >
              <FileText :size="16" />
              查看文件
              <ExternalLink :size="14" />
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
