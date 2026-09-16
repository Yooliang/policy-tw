<script setup lang="ts">
import PartyBadge from '../components/PartyBadge.vue'
import { ref, computed, onMounted, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSupabase } from '../composables/useSupabase'
import { useRequestTask } from '../composables/useRequestTask'
import RequestTaskNotice from '../components/RequestTaskNotice.vue'
import { supabasePublic as supabase } from '../lib/supabase'
import { PolicyStatus } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import Hero from '../components/Hero.vue'
import Avatar from '../components/Avatar.vue'
import HistoryPanel from '../components/history/HistoryPanel.vue'
import { Calendar, MapPin, Tag, Bot, Activity, CheckCircle2, Clock, ChevronLeft, ChevronRight, ThumbsUp, MessageCircleQuestion, Share2, GitCommit, ArrowRightCircle, FileText, Briefcase, GraduationCap, Loader2, Sparkles, CheckCircle, XCircle, ExternalLink, Newspaper, History, AlertTriangle } from 'lucide-vue-next'
import type { RawPolicySource } from '../types'
import HeroAction from '../components/HeroAction.vue'
import LoadError from '../components/LoadError.vue'
import { HERO_ACTION_BASE, HERO_ACTION_SIZE, HERO_ICON_BUTTON, HERO_ICON_SIZE } from '../lib/hero-action-styles'
import { usePageHead } from '../composables/usePageHead'
import { policyStatusLabel } from '../composables/usePageHead'
import { policySortDate, policyYear } from '../lib/policy-date'
import { castPolicyStance, myStance, type PolicyStance, type StanceCounts } from '../lib/policy-stance'


const route = useRoute()
const router = useRouter()
const { policies, politicians, loading, error, elections, getElectionById, loadPoliticianById, loadPolicyById, ensurePolicies } = useSupabase()

// 這一頁除了主角那筆，還要「同一人的其他政見」與整條市政接力鏈（otherPolicies／policyChain），
// 兩者都讀全域的 policies。直接開這一頁時預渲染的切片已經把那些一起嵌好了，
// 但從公民提問頁之類的地方換頁進來時清單裡只有 loadPolicyById 撈到的那一筆，
// 兩個區塊會憑空變空。所以這一頁明確要整份。
onMounted(() => { ensurePolicies() })

// 讀者表態。以前這裡只有一個 hasVoted 的 local ref——按下去把畫面數字 +1，
// 什麼都沒存，重新整理就沒了，而旁邊寫著「讓候選人看見選民的聲音」。
// 現在真的打 /policy-stance，計數以伺服器回的為準。
const myPolicyStance = ref<PolicyStance | null>(null)
const stanceBusy = ref<PolicyStance | null>(null)
const stanceError = ref<string | null>(null)
const stanceCounts = ref<StanceCounts | null>(null)

// 「查進度／查兌現情形」「這不是政見？」：按一下就建任務，出現在任務看板（/ai-assistant?tab=tasks）
const progressRequest = useRequestTask()
const validityRequest = useRequestTask()

const policyId = computed(() => route.params.policyId)
watch(policyId, () => { progressRequest.reset(); validityRequest.reset() })
const policy = computed(() => policies.value.find(p => String(p.id) === String(policyId.value)))
const politician = computed(() => policy.value ? politicians.value.find(c => String(c.id) === String(policy.value!.politicianId)) : null)

const policyLoading = ref(false)
const politicianLoading = ref(false)

// 當直接訪問或重新整理時，若找不到 policy 則單獨抓取
watch(
  policyId,
  async (id) => {
    if (!id) return
    if (!policies.value.some(p => String(p.id) === String(id))) {
      policyLoading.value = true
      try {
        await loadPolicyById(String(id))
      } finally {
        policyLoading.value = false
      }
    }
  },
  { immediate: true }
)

// 取得 policy 後，若找不到對應的 politician 則即時載入（因全站候選人不預載）
watch(
  () => policy.value?.politicianId,
  async (politicianId) => {
    if (!politicianId) return
    if (!politicians.value.some(p => String(p.id) === String(politicianId))) {
      politicianLoading.value = true
      try {
        await loadPoliticianById(String(politicianId))
      } finally {
        politicianLoading.value = false
      }
    }
  },
  { immediate: true }
)

// 政見所屬選舉屆別的簡稱，例如「2024 大選」「2026 九合一」。沒有屆別（舊資料）就不顯示。
const policyElection = computed(() => policy.value?.electionId != null ? getElectionById(policy.value.electionId) : undefined)

const otherPolicies = computed(() =>
  politician.value
    ? policies.value.filter(p => String(p.politicianId) === String(politician.value!.id) && p.id !== policy.value?.id).slice(0, 3)
    : []
)


const policyChain = computed(() => {
  if (!policy.value?.relatedPolicyIds) return []
  const relatedPolicies = policies.value.filter(p =>
    policy.value!.relatedPolicyIds?.includes(p.id) || p.relatedPolicyIds?.includes(policy.value!.id)
  ).sort((a, b) => policySortDate(a) - policySortDate(b))

  return [...relatedPolicies, policy.value]
    .filter((p): p is typeof policy.value => !!p)
    .sort((a, b) => policySortDate(a!) - policySortDate(b!))
    .filter((v, i, a) => a.findIndex(t => t!.id === v!.id) === i)
})

const isCampaign = computed(() => policy.value?.status === PolicyStatus.CAMPAIGN)

/**
 * 查證按鈕三態，跟後端派任務的條件一致（migration 20260913000004）。
 *
 * 一筆 2026 的競選承諾不可能有執行進度——投票日還沒到。後端已經不對這種政見
 * 派 progress_stale 了，前端就不該留一顆按鈕請人去派。屆別空著的同理：
 * 連是哪一場選舉都不知道，查不出「兌現了沒有」。
 *
 * 施政中的政見              → 查進度
 * 已投票屆別的競選承諾      → 查兌現情形
 * 未投票或屆別不明的承諾    → 不給按鈕，改說一句為什麼
 */
const TODAY = new Date().toISOString().slice(0, 10)
const pledgeElectionDone = computed(() => {
  const d = policyElection.value?.electionDate
  return !!d && d < TODAY
})
const canVerify = computed(() => !isCampaign.value || pledgeElectionDone.value)
const verifyLabel = computed(() => (isCampaign.value ? '查兌現情形' : '查進度'))
/** 不能查證時，畫面上要講得出原因（而且是使用者能據以行動的那句） */
const verifyBlockedReason = computed(() => {
  if (canVerify.value) return null
  const d = policyElection.value?.electionDate
  return d ? `${d} 投票，選後才會有執行進度` : '還沒確認這是哪一場選舉的承諾'
})

// 查核履歷徽章：有 status=applied 的紀錄才顯示，點擊平滑捲到履歷區塊
const appliedHistoryCount = ref(0)
const historySectionEl = ref<HTMLElement | null>(null)
function onHistoryLoaded(payload: { total: number; appliedCount: number }) {
  appliedHistoryCount.value = payload.appliedCount
}
function scrollToHistory() {
  historySectionEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// Policy sources state
const sources = ref<RawPolicySource[]>([])
const showAllSources = ref(false)
const displayedSources = computed(() =>
  showAllSources.value ? sources.value : sources.value.slice(0, 5)
)

// Fetch policy sources
watch(policyId, async (id) => {
  if (!id) return
  appliedHistoryCount.value = 0
  const { data } = await supabase
    .from('policy_sources')
    .select('*')
    .eq('policy_id', id)
    .order('published_date', { ascending: false })
  sources.value = data || []
}, { immediate: true })

const STANCE_OPTIONS: Array<{ key: PolicyStance; label: string; hint: string }> = [
  { key: 'support', label: '我支持', hint: '希望這項政見被實現' },
  { key: 'oppose', label: '我反對', hint: '不希望這項政見被實現' },
  { key: 'priority', label: '我關注', hint: '不一定有立場，但會持續注意這件事' },
]

/** 畫面上的計數：表態過就用伺服器回的最新值，否則用政見本身帶的 */
const shownStances = computed<StanceCounts>(() => stanceCounts.value ?? {
  stance_support: policy.value?.stanceSupport ?? 0,
  stance_oppose: policy.value?.stanceOppose ?? 0,
  stance_priority: policy.value?.stancePriority ?? 0,
})

async function castStance(stance: PolicyStance) {
  const id = policy.value?.id
  if (!id || stanceBusy.value) return
  stanceBusy.value = stance
  stanceError.value = null
  try {
    const r = await castPolicyStance(id, stance)
    stanceCounts.value = { stance_support: r.stance_support, stance_oppose: r.stance_oppose, stance_priority: r.stance_priority }
    myPolicyStance.value = stance
  } catch (e) {
    stanceError.value = e instanceof Error ? e.message : '表態沒有成功，請稍後再試'
  } finally {
    stanceBusy.value = null
  }
}

// 換一條政見就重讀「我投過什麼」，不要把上一條的狀態留在畫面上
watch(() => policy.value?.id, (id) => {
  stanceCounts.value = null
  stanceError.value = null
  myPolicyStance.value = id ? myStance(id) : null
}, { immediate: true })


usePageHead({
  type: 'article',
  // firebase.json 把 /policy/** rewrite 到殼檔回 200，不存在的 id 也會是 200；確定沒資料就標 noindex 免得被當 soft 404 收錄
  noindex: () => !loading.value && !policyLoading.value && !politicianLoading.value && !policy.value,
  title: () => policy.value?.title,
  description: () => policy.value
    ? `${politician.value?.name ?? ''}政見「${policy.value.title}」，狀態：${policyStatusLabel(policy.value.status)}，進度 ${policy.value.progress}%。${policy.value.description}`
    : undefined,
})
</script>

<template>
  <div v-if="policy && politician" class="bg-slate-50 min-h-screen">
    <Hero>
      <template #icon><FileText :size="400" class="text-blue-500" /></template>
      <template #title>
        <div class="flex flex-col md:flex-row gap-8 items-start">
          <div class="relative cursor-pointer" @click="router.push(`/politician/${politician.id}`)">
            <Avatar :src="politician.avatarUrl" :name="politician.name" class="w-28 h-28 md:w-36 md:h-36 border-4 border-white shadow-xl" />
            <PartyBadge :party="politician.party" :size="8" class="absolute bottom-2 right-2 shadow-md" />
          </div>
          <div class="flex-1">
            <div class="flex flex-wrap items-center gap-3 mb-3">
              <StatusBadge :status="policy.status" />
              <span class="bg-white/20 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm flex items-center gap-1"><Tag :size="14" /> {{ policy.category }}</span>
              <span class="bg-white/20 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm flex items-center gap-1"><MapPin :size="14" /> {{ politician.region }}</span>
              <button
                v-if="appliedHistoryCount > 0"
                type="button"
                class="bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/30 px-3 py-1 rounded-full text-sm font-bold backdrop-blur-sm flex items-center gap-1 transition-colors"
                data-testid="history-badge"
                @click="scrollToHistory"
              >
                <CheckCircle2 :size="14" /> 已查核 · {{ appliedHistoryCount }} 筆
              </button>
            </div>
            <h1 class="text-3xl md:text-4xl font-black text-white leading-tight mb-3">{{ policy.title }}</h1>
            <div class="flex flex-wrap items-center gap-4 text-sm text-slate-300">
              <span v-if="policyElection" class="flex items-center gap-1 bg-white/10 px-2.5 py-0.5 rounded-full text-xs font-bold text-white">
                {{ policyElection.shortName }}政見
              </span>
              <span v-if="policy.proposedDate" class="flex items-center gap-1"><Clock :size="16" /> 提出：{{ policy.proposedDate }}</span>
              <span class="flex items-center gap-1"><Activity :size="16" /> 更新：{{ policy.lastUpdated }}</span>
              <span class="flex items-center gap-1 cursor-pointer hover:text-white" @click="router.push(`/politician/${politician.id}`)">
                {{ politician.name }} · {{ politician.position }}
              </span>
            </div>
          </div>
        </div>
      </template>
      <template #actions>
        <div class="flex flex-wrap items-center gap-2 sm:gap-3 ml-0 md:ml-44">
          <button @click="router.go(-1)" :class="HERO_ICON_BUTTON" aria-label="返回">
            <ChevronLeft :size="HERO_ICON_SIZE" class="group-hover:-translate-x-1 transition-transform" />
          </button>
          <span v-if="!canVerify" data-testid="hero-progress-blocked" :class="[HERO_ACTION_BASE, HERO_ACTION_SIZE, 'bg-white/10 text-white/70 border border-white/20']">
            <Clock :size="16" /> {{ verifyBlockedReason }}
          </span>
          <!-- 主要動作，保留藍底；尺寸走共用 token，跟旁邊那幾顆一致 -->
          <button
            v-else
            type="button"
            data-testid="hero-progress"
            :disabled="progressRequest.loading.value"
            :class="[
              HERO_ACTION_BASE, HERO_ACTION_SIZE, 'border border-transparent text-white',
              progressRequest.done.value ? 'bg-emerald-500' : progressRequest.error.value ? 'bg-red-500/80' : 'bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-500/20',
            ]"
            @click="progressRequest.send({ kind: 'progress', policy_id: policy.id })"
          >
            <Loader2 v-if="progressRequest.loading.value" :size="16" class="animate-spin" />
            <CheckCircle v-else-if="progressRequest.done.value" :size="16" />
            <XCircle v-else-if="progressRequest.error.value" :size="16" />
            <Sparkles v-else :size="16" />
            {{ progressRequest.label(verifyLabel) }}
          </button>
          <HeroAction data-testid="hero-community" :to="{ path: '/community', query: { policy: policy.id } }"><MessageCircleQuestion :size="16" /> 民眾提問</HeroAction>
          <HeroAction data-testid="hero-history" @click="scrollToHistory"><History :size="16" /> 查核履歷</HeroAction>
        </div>
        <RequestTaskNotice class="mt-3 ml-0 md:ml-44" :result="progressRequest.result.value" :error="progressRequest.error.value" on-dark />
      </template>
    </Hero>

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
                      <span class="text-xs font-bold text-slate-400 block mb-1">{{ policyYear(p!, elections) ?? '—' }}</span>
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

          <!-- 讀者表態：支持／反對／更在意，計數以伺服器回的為準，不在本機加一。
               對所有狀態的政見都顯示，不只競選承諾：「這不是政見？」的回報入口在這一區，
               非承諾類的政見（那些才更可能被誤建）一樣要有得按。 -->
          <div class="bg-gradient-to-r from-violet-50 to-indigo-50 border border-violet-100 rounded-xl p-6">
            <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
              <div>
                <h3 class="text-lg font-bold text-violet-900 mb-1">你怎麼看這項政見？</h3>
                <p class="text-slate-600 text-sm">表態會公開顯示在這裡，候選人與其他讀者都看得到。這不會影響政見內容的真假判定——那由附出處的查證決定。</p>
              </div>
              <div class="flex items-center gap-5 shrink-0">
                <div class="text-center">
                  <span class="block text-2xl font-black text-violet-700 tabular-nums">{{ shownStances.stance_support.toLocaleString() }}</span>
                  <span class="text-[11px] text-violet-400 font-bold">支持</span>
                </div>
                <div class="text-center">
                  <span class="block text-2xl font-black text-rose-600 tabular-nums">{{ shownStances.stance_oppose.toLocaleString() }}</span>
                  <span class="text-[11px] text-rose-400 font-bold">反對</span>
                </div>
                <div class="text-center">
                  <span class="block text-2xl font-black text-amber-600 tabular-nums">{{ shownStances.stance_priority.toLocaleString() }}</span>
                  <span class="text-[11px] text-amber-500 font-bold">關注</span>
                </div>
              </div>
            </div>
            <div class="mt-5 flex flex-wrap gap-2">
              <button
                v-for="opt in STANCE_OPTIONS"
                :key="opt.key"
                @click="castStance(opt.key)"
                :disabled="stanceBusy !== null"
                :title="opt.hint"
                :class="[
                  'px-4 py-2 rounded-lg font-bold text-sm transition-all border disabled:opacity-60',
                  myPolicyStance === opt.key
                    ? 'bg-violet-600 border-violet-600 text-white shadow'
                    : 'bg-white border-violet-200 text-violet-700 hover:bg-violet-50',
                ]"
              >
                <Loader2 v-if="stanceBusy === opt.key" :size="16" class="inline animate-spin mr-1" />
                {{ opt.label }}
              </button>
              <span v-if="myPolicyStance" class="self-center text-xs text-violet-500">已記錄你的立場，改按別顆就會換掉</span>
            </div>
            <p v-if="stanceError" class="mt-3 text-sm text-rose-600">{{ stanceError }}</p>
            <div class="mt-5 pt-4 border-t border-violet-100">
              <button
                type="button"
                data-testid="hero-not-a-policy"
                :disabled="validityRequest.loading.value || validityRequest.done.value"
                class="inline-flex items-center gap-1.5 text-sm font-bold text-slate-500 hover:text-rose-600 disabled:hover:text-slate-500 transition-colors"
                @click="validityRequest.send({ kind: 'validity', policy_id: policy.id })"
              >
                <Loader2 v-if="validityRequest.loading.value" :size="15" class="animate-spin" />
                <AlertTriangle v-else :size="15" />
                {{ validityRequest.label('這不是政見？回報給 AI 查證') }}
              </button>
              <RequestTaskNotice class="mt-2" :result="validityRequest.result.value" :error="validityRequest.error.value" />
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

          <!-- Citizen Questions -->
          <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
            <div>
              <h3 class="text-lg font-bold text-navy-900 flex items-center gap-2"><MessageCircleQuestion class="text-blue-600" />公民提問</h3>
              <p class="text-sm text-slate-500 mt-1">想問這項政見的細節？提出問題，AI 代理會去查有出處的資料來回答。</p>
            </div>
            <button @click="router.push({ path: '/community', query: { policy: policy.id } })" class="px-4 py-2 bg-white border border-slate-300 hover:border-blue-400 text-slate-700 hover:text-blue-600 rounded-lg font-medium transition-colors">
              前往提問
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

          <!-- 查核履歷：誰交的、誰驗的、改了什麼 -->
          <div id="history" ref="historySectionEl" class="scroll-mt-24">
            <HistoryPanel target="policy" :id="policy.id" @loaded="onHistoryLoaded" />
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
  <div v-else-if="loading || policyLoading || politicianLoading" class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Loader2 :size="48" class="mx-auto mb-4 text-blue-500 animate-spin" />
      <p class="text-slate-500">載入中...</p>
    </div>
  </div>

  <!-- 資料拿不到（不是不存在）：給重試，別冒充「找不到」 -->
  <LoadError v-else-if="error" />

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

