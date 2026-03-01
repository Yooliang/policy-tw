<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSupabase } from '../composables/useSupabase'
import { useAuth } from '../composables/useAuth'
import { supabase } from '../lib/supabase'
import { PolicyStatus } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import Hero from '../components/Hero.vue'
import Avatar from '../components/Avatar.vue'
import { Calendar, MapPin, Tag, Bot, Activity, CheckCircle2, Clock, ChevronLeft, ChevronRight, ThumbsUp, MessageSquare, Share2, GitCommit, ArrowRightCircle, FileText, Briefcase, GraduationCap, Loader2, Sparkles, CheckCircle, XCircle, ExternalLink, Newspaper } from 'lucide-vue-next'
import type { RawPolicySource } from '../types'


const route = useRoute()
const router = useRouter()
const { policies, politicians, loading } = useSupabase()
const { isAuthenticated, signInWithGoogle, user } = useAuth()

const hasVoted = ref(false)

// AI verification state
const verifying = ref(false)
const verifySuccess = ref(false)
const verifyError = ref<string | null>(null)
const verifyPromptId = ref<string | null>(null)

// Trigger AI verification for this policy
async function handleVerify() {
  if (!isAuthenticated.value) {
    signInWithGoogle()
    return
  }

  verifying.value = true
  verifySuccess.value = false
  verifyError.value = null

  try {
    const policy = policies.value.find(p => String(p.id) === String(policyId.value))
    const politician = policy ? politicians.value.find(c => String(c.id) === String(policy.politicianId)) : null

    if (!policy || !politician) {
      throw new Error('找不到政見資料')
    }

    const input = `請查核並更新「${politician.name}」的政見「${policy.title}」的最新進度與執行狀況。`

    const response = await supabase.functions.invoke('ai-classify', {
      body: {
        input,
        politician_id: politician.id,
        politician_name: politician.name,
        policy_id: policy.id,
      },
    })

    if (response.error) {
      throw new Error(response.error.message || JSON.stringify(response.error))
    }

    const data = response.data
    if (!data.success) {
      throw new Error(data.message || '提交失敗')
    }

    verifyPromptId.value = data.prompt_id
    verifySuccess.value = true
  } catch (err: any) {
    console.error('Verify error:', err)
    verifyError.value = err.message || '查核請求失敗，請稍後再試'
  } finally {
    verifying.value = false
  }
}

const policyId = computed(() => route.params.policyId)
const policy = computed(() => policies.value.find(p => String(p.id) === String(policyId.value)))
const politician = computed(() => policy.value ? politicians.value.find(c => String(c.id) === String(policy.value!.politicianId)) : null)

const otherPolicies = computed(() =>
  politician.value
    ? policies.value.filter(p => String(p.politicianId) === String(politician.value!.id) && p.id !== policy.value?.id).slice(0, 3)
    : []
)


const policyChain = computed(() => {
  if (!policy.value?.relatedPolicyIds) return []
  const relatedPolicies = policies.value.filter(p =>
    policy.value!.relatedPolicyIds?.includes(p.id) || p.relatedPolicyIds?.includes(policy.value!.id)
  ).sort((a, b) => new Date(a.proposedDate).getTime() - new Date(b.proposedDate).getTime())

  return [...relatedPolicies, policy.value]
    .filter((p): p is typeof policy.value => !!p)
    .sort((a, b) => new Date(a!.proposedDate).getTime() - new Date(b!.proposedDate).getTime())
    .filter((v, i, a) => a.findIndex(t => t!.id === v!.id) === i)
})

const isCampaign = computed(() => policy.value?.status === PolicyStatus.CAMPAIGN)

// Policy sources state
const sources = ref<RawPolicySource[]>([])
const showAllSources = ref(false)
const displayedSources = computed(() =>
  showAllSources.value ? sources.value : sources.value.slice(0, 5)
)

// Fetch policy sources
watch(policyId, async (id) => {
  if (!id) return
  const { data } = await supabase
    .from('policy_sources')
    .select('*')
    .eq('policy_id', id)
    .order('published_date', { ascending: false })
  sources.value = data || []
}, { immediate: true })

const handleVote = () => {
  if (!hasVoted.value) hasVoted.value = true
}
</script>

<template>
  <div v-if="policy && politician" class="bg-slate-50 min-h-screen">
    <Hero>
      <template #icon><FileText :size="400" class="text-blue-500" /></template>
      <template #title>
        <div class="flex flex-col md:flex-row gap-8 items-start">
          <div class="relative cursor-pointer" @click="router.push(`/politician/${politician.id}`)">
            <Avatar :src="politician.avatarUrl" :name="politician.name" class="w-28 h-28 md:w-36 md:h-36 border-4 border-white shadow-xl" />
            <span :class="`absolute bottom-2 right-2 w-8 h-8 flex items-center justify-center rounded-full text-sm font-bold text-white border-2 border-white shadow-md
              ${politician.party === '國民黨' ? 'bg-blue-600' :
                politician.party === '民進黨' ? 'bg-green-600' :
                politician.party === '民眾黨' ? 'bg-cyan-600' : 'bg-gray-500'}`">
              {{ politician.party[0] }}
            </span>
          </div>
          <div class="flex-1">
            <div class="flex flex-wrap items-center gap-3 mb-3">
              <StatusBadge :status="policy.status" />
              <span class="bg-white/20 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm flex items-center gap-1"><Tag :size="14" /> {{ policy.category }}</span>
              <span class="bg-white/20 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm flex items-center gap-1"><MapPin :size="14" /> {{ politician.region }}</span>
            </div>
            <h1 class="text-3xl md:text-4xl font-black text-white leading-tight mb-3">{{ policy.title }}</h1>
            <div class="flex flex-wrap items-center gap-4 text-sm text-slate-300">
              <span class="flex items-center gap-1"><Clock :size="16" /> 提出：{{ policy.proposedDate }}</span>
              <span class="flex items-center gap-1"><Activity :size="16" /> 更新：{{ policy.lastUpdated }}</span>
              <span class="flex items-center gap-1 cursor-pointer hover:text-white" @click="router.push(`/politician/${politician.id}`)">
                {{ politician.name }} · {{ politician.position }}
              </span>
            </div>
          </div>
        </div>
      </template>
      <template #actions>
        <div class="flex items-center gap-3 ml-0 md:ml-44">
          <button @click="router.go(-1)" class="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition-all border border-white/10 group shrink-0" aria-label="返回">
            <ChevronLeft :size="24" class="group-hover:-translate-x-1 transition-transform" />
          </button>
          <button
            @click="handleVerify"
            :disabled="verifying"
            :class="[
              'px-5 py-2 rounded-lg font-bold transition-all flex items-center gap-2',
              verifySuccess
                ? 'bg-emerald-500 text-white'
                : verifyError
                  ? 'bg-red-500/80 text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20'
            ]"
          >
            <Loader2 v-if="verifying" :size="18" class="animate-spin" />
            <CheckCircle v-else-if="verifySuccess" :size="18" />
            <XCircle v-else-if="verifyError" :size="18" />
            <Sparkles v-else :size="18" />
            {{ verifying ? '查核中...' : verifySuccess ? '已送出' : verifyError ? '失敗' : 'AI 查核' }}
          </button>
          <button class="bg-white/10 hover:bg-white/20 text-white px-5 py-2 rounded-lg font-bold border border-white/20 transition-all flex items-center gap-2"><Share2 :size="18" /> 分享</button>
          <button @click="router.push({ path: '/community', query: { filter: policy.title } })" class="bg-white/10 hover:bg-white/20 text-white px-5 py-2 rounded-lg font-bold border border-white/20 transition-all flex items-center gap-2"><MessageSquare :size="18" /> 公民討論</button>
        </div>
      </template>
    </Hero>

    <!-- AI Verification Notification -->
    <div v-if="verifySuccess || verifyError" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
      <div
        :class="[
          'p-4 rounded-xl flex items-center justify-between',
          verifySuccess ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'
        ]"
      >
        <div class="flex items-center gap-3">
          <CheckCircle v-if="verifySuccess" class="text-emerald-600" :size="20" />
          <XCircle v-else class="text-red-600" :size="20" />
          <span :class="verifySuccess ? 'text-emerald-700' : 'text-red-700'">
            {{ verifySuccess ? '任務已開始，將在背景運行。請稍後回來查看結果。' : verifyError }}
          </span>
        </div>
        <button
          v-if="verifySuccess && verifyPromptId"
          @click="router.push('/ai-assistant')"
          class="text-sm font-bold text-emerald-700 hover:text-emerald-900 flex items-center gap-1"
        >
          查看進度 <ChevronRight :size="16" />
        </button>
        <button
          v-else-if="verifyError"
          @click="verifyError = null"
          class="text-sm font-bold text-red-700 hover:text-red-900"
        >
          關閉
        </button>
      </div>
    </div>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left">

        <!-- Main Content -->
        <div class="lg:col-span-2 space-y-6">

          <!-- Policy Relay -->
          <div v-if="policyChain.length > 1" class="bg-white rounded-xl border border-blue-200 overflow-hidden shadow-sm">
            <div class="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-4 border-b border-blue-100 flex items-center gap-2">
              <GitCommit class="text-blue-600" />
              <h2 class="text-lg font-bold text-navy-900">市政接力與傳承 Governance Relay</h2>
            </div>
            <div class="p-6">
              <p class="text-sm text-slate-500 mb-6">這項建設跨越了不同任期，由多位首長接力完成。我們記錄這份傳承，確保每一步努力都被看見。</p>
              <div class="relative">
                <div class="absolute top-8 left-8 right-8 h-1 bg-slate-200 -z-10"></div>
                <div class="flex flex-col md:flex-row justify-between items-start gap-6 md:gap-0">
                  <div
                    v-for="(p, index) in policyChain"
                    :key="p!.id"
                    class="flex flex-col items-center flex-1 relative cursor-pointer group"
                    @click="router.push(`/policy/${p!.id}`)"
                  >
                    <div :class="`w-16 h-16 rounded-full border-4 flex items-center justify-center bg-white transition-all z-10
                      ${p!.id === policy?.id ? 'border-blue-500 shadow-lg scale-110' : 'border-slate-300 group-hover:border-blue-300'}`">
                      <Avatar :src="politicians.find(pol => pol.id === p!.politicianId)?.avatarUrl" :name="politicians.find(pol => pol.id === p!.politicianId)?.name || ''" class="w-full h-full" />
                    </div>
                    <div class="mt-4 text-center">
                      <span class="text-xs font-bold text-slate-400 block mb-1">{{ p!.proposedDate.split('-')[0] }}</span>
                      <h4 :class="`font-bold text-sm mb-1 ${p!.id === policy?.id ? 'text-blue-700' : 'text-slate-700'}`">
                        {{ politicians.find(pol => pol.id === p!.politicianId)?.name }}
                      </h4>
                      <div :class="`text-xs px-2 py-1 rounded-full border inline-block
                        ${p!.id === policy?.id ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`">
                        {{ p!.status === 'Achieved' ? '完成階段' : p!.status === 'In Progress' ? '執行階段' : '規劃階段' }}
                      </div>
                      <div v-if="index < policyChain.length - 1" class="hidden md:block absolute top-8 -right-1/2 translate-x-1/2 z-0">
                        <ArrowRightCircle :size="20" class="text-slate-400 bg-white rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Campaign Action -->
          <div v-if="isCampaign" class="bg-gradient-to-r from-violet-50 to-indigo-50 border border-violet-100 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-6">
            <div>
              <h3 class="text-lg font-bold text-violet-900 mb-1">您期待這項政見被實現嗎？</h3>
              <p class="text-slate-600 text-sm">點擊支持，讓候選人看見選民的聲音。</p>
            </div>
            <div class="flex items-center gap-4">
              <div class="text-center">
                <span class="block text-2xl font-bold text-violet-700">
                  {{ hasVoted ? ((policy.supportCount || 0) + 1).toLocaleString() : policy.supportCount?.toLocaleString() }}
                </span>
                <span class="text-xs text-violet-400 uppercase tracking-wider font-bold">選民期待</span>
              </div>
              <button
                @click="handleVote"
                :disabled="hasVoted"
                :class="`px-6 py-3 rounded-lg font-bold flex items-center gap-2 transition-all shadow-md
                  ${hasVoted ? 'bg-violet-200 text-violet-800 cursor-default' : 'bg-violet-600 hover:bg-violet-700 text-white hover:shadow-lg hover:-translate-y-0.5'}`"
              >
                <ThumbsUp :size="20" :class="hasVoted ? '' : 'animate-pulse'" />
                {{ hasVoted ? '已表達支持' : '我支持' }}
              </button>
            </div>
          </div>

          <!-- Description & AI Analysis -->
          <div class="bg-white p-8 rounded-xl border border-slate-200 shadow-sm">
            <h2 class="text-xl font-bold text-navy-900 mb-4">重大建設/政見詳情</h2>
            <p class="text-slate-700 leading-relaxed mb-8 text-lg">{{ policy.description }}</p>

            <div v-if="policy.aiAnalysis" class="bg-gradient-to-br from-slate-50 to-blue-50/30 rounded-lg border border-blue-100 p-6 relative overflow-hidden">
              <div class="absolute top-0 right-0 p-4 opacity-5"><Bot :size="100" /></div>
              <div class="flex items-start gap-3 relative z-10">
                <div class="bg-blue-600 text-white p-2 rounded-lg shrink-0 shadow-lg shadow-blue-500/20"><Bot :size="24" /></div>
                <div>
                  <h3 class="font-bold text-navy-900 mb-2">AI 智能解析</h3>
                  <p class="text-slate-700 text-sm leading-relaxed text-justify">{{ policy.aiAnalysis }}</p>
                  <div class="mt-4 flex gap-2">
                    <span v-for="tag in policy.tags" :key="tag" class="text-xs bg-white border border-blue-200 text-blue-700 px-2 py-1 rounded">#{{ tag }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Sources -->
          <div v-if="sources.length > 0" class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 class="text-lg font-bold text-navy-900 mb-4 flex items-center gap-2">
              <Newspaper class="text-blue-600" :size="20" />
              資料來源
              <span class="text-sm font-normal text-slate-400">({{ sources.length }})</span>
            </h3>
            <ul class="space-y-3">
              <li v-for="src in displayedSources" :key="src.id" class="flex items-start gap-3 group">
                <ExternalLink :size="16" class="text-slate-400 mt-1 shrink-0" />
                <div class="min-w-0">
                  <a
                    :href="src.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-blue-600 hover:text-blue-800 font-medium text-sm line-clamp-1 break-all"
                  >
                    {{ src.title || src.url }}
                  </a>
                  <div class="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                    <span v-if="src.source_name">{{ src.source_name }}</span>
                    <span v-if="src.source_name && src.published_date">·</span>
                    <span v-if="src.published_date">{{ src.published_date }}</span>
                  </div>
                </div>
              </li>
            </ul>
            <button
              v-if="sources.length > 5 && !showAllSources"
              @click="showAllSources = true"
              class="mt-4 text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
            >
              查看更多（共 {{ sources.length }} 筆）
              <ChevronRight :size="14" />
            </button>
          </div>

          <!-- Community Discussion -->
          <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
            <div>
              <h3 class="text-lg font-bold text-navy-900 flex items-center gap-2"><MessageSquare class="text-blue-600" />公民討論區</h3>
              <p class="text-sm text-slate-500 mt-1">針對此政見有不同的看法？歡迎加入討論。</p>
            </div>
            <button @click="router.push({ path: '/community', query: { filter: policy.title } })" class="px-4 py-2 bg-white border border-slate-300 hover:border-blue-400 text-slate-700 hover:text-blue-600 rounded-lg font-medium transition-colors">
              前往討論
            </button>
          </div>

          <!-- Timeline -->
          <div v-if="!isCampaign" class="bg-white p-8 rounded-xl border border-slate-200 shadow-sm">
            <h2 class="text-xl font-bold text-navy-900 mb-6 flex items-center gap-2"><Calendar class="text-slate-400" />執行歷程追蹤</h2>
            <div class="relative border-l-2 border-slate-200 ml-3 space-y-8 pb-2">
              <div v-for="(log, index) in policy.logs" :key="log.id" class="relative pl-8 group">
                <div :class="`absolute -left-[9px] top-1.5 w-4 h-4 rounded-full border-2 border-white ring-2 ${
                  index === 0 ? 'bg-blue-600 ring-blue-100' : 'bg-slate-300 ring-slate-50'
                }`"></div>
                <span class="text-sm font-mono text-slate-400 block mb-1">{{ log.date }}</span>
                <h4 :class="`text-lg font-bold ${index === 0 ? 'text-navy-900' : 'text-slate-600'}`">{{ log.event }}</h4>
                <p v-if="log.description" class="text-slate-500 mt-1">{{ log.description }}</p>
                <span v-if="index === 0" class="inline-flex items-center gap-1 text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded mt-2">
                  <CheckCircle2 :size="12" /> 最新進度
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Sidebar -->
        <div class="lg:col-span-1 space-y-6">
          <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm sticky top-24">
            <div class="flex items-center gap-4 mb-6 cursor-pointer hover:bg-slate-50 p-2 rounded-lg transition-colors" @click="router.push(`/politician/${politician.id}`)">
              <Avatar :src="politician.avatarUrl" :name="politician.name" size="lg" class="border-2 border-slate-100" />
              <div>
                <h3 class="text-lg font-bold text-navy-900 flex items-center gap-1">{{ politician.name }}<ChevronRight :size="16" class="text-slate-300" /></h3>
                <p class="text-sm text-slate-500">{{ politician.position }}</p>
              </div>
            </div>

            <div class="space-y-4">
              <div v-if="!isCampaign">
                <div class="flex justify-between text-sm font-medium text-slate-600 mb-1">
                  <span>當前進度</span>
                  <span class="text-blue-600">{{ policy.progress }}%</span>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-2.5">
                  <div
                    :class="`h-2.5 rounded-full transition-all duration-1000 ${
                      policy.status === 'Achieved' ? 'bg-emerald-500' :
                      policy.status === 'Failed' ? 'bg-red-500' : 'bg-blue-600'
                    }`"
                    :style="{ width: `${policy.progress}%` }"
                  ></div>
                </div>
              </div>

              <div class="pt-4 border-t border-slate-100">
                <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">所屬政黨</h4>
                <span :class="`inline-block px-3 py-1 rounded text-sm font-bold
                  ${politician.party === '國民黨' ? 'bg-blue-50 text-blue-700' :
                    politician.party === '民進黨' ? 'bg-green-50 text-green-700' :
                    politician.party === '民眾黨' ? 'bg-cyan-50 text-cyan-700' : 'bg-gray-50 text-gray-700'}`">
                  {{ politician.party }}
                </span>
              </div>

              <div class="pt-4 border-t border-slate-100">
                <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">選區</h4>
                <p class="text-navy-900 font-medium flex items-center gap-2"><MapPin :size="16" class="text-slate-400" />{{ politician.region }}</p>
              </div>

              <div class="pt-4 border-t border-slate-100">
                <h3 class="font-bold text-navy-900 mb-4 flex items-center gap-2"><Briefcase class="text-slate-400" :size="18" /> 經歷</h3>
                <ul class="space-y-3">
                  <template v-if="politician.experience?.length">
                    <li v-for="(exp, i) in politician.experience" :key="i" class="text-sm text-slate-600 pl-4 border-l-2 border-slate-200">{{ exp }}</li>
                  </template>
                  <li v-else class="text-slate-400 text-sm">暫無資料</li>
                </ul>
              </div>

              <div class="pt-4 border-t border-slate-100">
                <h3 class="font-bold text-navy-900 mb-4 flex items-center gap-2"><GraduationCap class="text-slate-400" :size="18" /> 學歷</h3>
                <ul class="space-y-3">
                  <template v-if="politician.education?.length">
                    <li v-for="(edu, i) in politician.education" :key="i" class="text-sm text-slate-600 pl-4 border-l-2 border-slate-200">{{ edu }}</li>
                  </template>
                  <li v-else class="text-slate-400 text-sm">暫無資料</li>
                </ul>
              </div>

              <div v-if="otherPolicies.length > 0" class="pt-6 mt-2 border-t border-slate-100">
                <h4 class="text-sm font-bold text-navy-900 mb-3">該候選人的其他政見</h4>
                <div class="space-y-3">
                  <div
                    v-for="p in otherPolicies"
                    :key="p.id"
                    @click="router.push(`/policy/${p.id}`)"
                    class="group cursor-pointer bg-slate-50 hover:bg-white border border-slate-100 hover:border-blue-200 p-3 rounded-lg transition-all"
                  >
                    <div class="flex justify-between items-start mb-1">
                      <span :class="`text-xs px-1.5 py-0.5 rounded ${p.status === 'Campaign Pledge' ? 'bg-violet-100 text-violet-700' : 'bg-blue-100 text-blue-700'}`">
                        {{ p.status === 'Campaign Pledge' ? '承諾' : '追蹤中' }}
                      </span>
                      <span class="text-[10px] text-slate-400">{{ p.category }}</span>
                    </div>
                    <h5 class="text-sm font-medium text-navy-900 group-hover:text-blue-600 line-clamp-1">{{ p.title }}</h5>
                  </div>
                  <button
                    v-if="otherPolicies.length >= 3"
                    @click="router.push(`/politician/${politician.id}`)"
                    class="w-full text-center text-xs text-slate-500 hover:text-blue-600 mt-2 flex items-center justify-center gap-1"
                  >
                    查看更多 <ChevronRight :size="12" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <!-- Loading state -->
  <div v-else-if="loading" class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Loader2 :size="48" class="mx-auto mb-4 text-blue-500 animate-spin" />
      <p class="text-slate-500">載入中...</p>
    </div>
  </div>

  <!-- Not found state -->
  <div v-else class="min-h-screen flex items-center justify-center bg-slate-50">
    <div class="text-center px-4">
      <FileText :size="64" class="mx-auto mb-4 text-slate-300" />
      <h2 class="text-2xl font-bold text-navy-900 mb-2">找不到該政見</h2>
      <p class="text-slate-500 mb-6">該政見可能已被移除或連結錯誤。</p>
      <div class="flex flex-col sm:flex-row items-center justify-center gap-4">
        <button @click="router.push('/tracking')" class="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all">
          返回追蹤列表
        </button>
        <button @click="router.push('/')" class="text-slate-500 hover:text-navy-900 font-medium flex items-center gap-1">
          <ChevronLeft :size="18" /> 返回首頁
        </button>
      </div>
    </div>
  </div>
</template>

