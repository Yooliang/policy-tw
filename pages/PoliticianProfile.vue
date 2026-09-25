<script setup lang="ts">
import { shortUrlsIn } from '../lib/url'
import PartyBadge from '../components/PartyBadge.vue'
import { ref, computed, onMounted, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSupabase } from '../composables/useSupabase'
import { BOARD_PATH, requestTask, requestTaskMessage, type RequestKind, type RequestTaskResult } from '../lib/request-task'
import { useRequestTask } from '../composables/useRequestTask'
import RequestTaskNotice from '../components/RequestTaskNotice.vue'
import LoadError from '../components/LoadError.vue'
import { PolicyStatus } from '../types'
import type { CandidateStatus, Policy } from '../types'
import { policySortDate } from '../lib/policy-date'
import Avatar from '../components/Avatar.vue'
import PolicyCard from '../components/PolicyCard.vue'
import Hero from '../components/Hero.vue'
import HistoryPanel from '../components/history/HistoryPanel.vue'
import { MapPin, GraduationCap, Briefcase, CheckCircle2, Megaphone, ThumbsUp, User, ChevronLeft, ChevronRight, Loader2, Sparkles, Search, CheckCircle, XCircle, Vote, Calendar, FileText, Camera, LayoutGrid, Table2 } from 'lucide-vue-next'
import { DATA_LICENSE_URL, PUBLISHER_LD, SITE_URL, usePageHead } from '../composables/usePageHead'
import HeroAction from '../components/HeroAction.vue'
import { HERO_ICON_BUTTON, HERO_ICON_SIZE } from '../lib/hero-action-styles'
import AiLookupInline from '../components/AiLookupInline.vue'
// 側欄的「請 AI 幫忙查」區塊（四顆針對這個人的功能鈕都在那裡），錨點仍保留供深連結使用
const AI_LOOKUP_SECTION_ID = 'ai-lookup'

const route = useRoute()
const router = useRouter()
const { politicians, policies, elections, loading, error, loadPoliticianById, getElectionById, ensurePolicies } = useSupabase()
const activeTab = ref<'campaign' | 'history' | 'profile'>('campaign')
// 競選承諾的呈現：卡片或表格（2026-09-23 小良哥）。選擇記在瀏覽器；預渲染時沒有 window，用預設值
type CampaignView = 'cards' | 'table'
const campaignView = ref<CampaignView>('cards')
onMounted(() => {
  try { const v = localStorage.getItem('campaignView'); if (v === 'cards' || v === 'table') campaignView.value = v } catch { /* 隱私模式 */ }
})
function setCampaignView(v: CampaignView) {
  campaignView.value = v
  try { localStorage.setItem('campaignView', v) } catch { /* 無法存就算了 */ }
}
// 側欄改成第三個分頁（使用者 2026-09-20）；帶 #ai-lookup 進來的深連結要先切到它
if (typeof window !== 'undefined' && window.location.hash === `#${AI_LOOKUP_SECTION_ID}`) activeTab.value = 'profile'

// 「請 AI 幫忙查」：四顆按鈕都把這位人物丟進貢獻任務池（公開端點 request-task，不需登入）
type LookupKey = 'campaign' | 'history' | 'bio' | 'avatar'
const LOOKUP_KIND: Record<LookupKey, RequestKind> = { campaign: 'policy', history: 'policy', bio: 'profile', avatar: 'profile' }
interface LookupState { loading: boolean; result: RequestTaskResult | null; error: string | null }
const idle = (): LookupState => ({ loading: false, result: null, error: null })
const lookup = reactive<Record<LookupKey, LookupState>>({ campaign: idle(), history: idle(), bio: idle(), avatar: idle() })

async function requestLookup(key: LookupKey) {
  const pol = politician.value
  if (!pol || lookup[key].loading) return
  lookup[key] = { loading: true, result: null, error: null }
  try {
    const result = await requestTask({ kind: LOOKUP_KIND[key], politician_id: pol.id })
    lookup[key] = { loading: false, result, error: null }
  } catch (err: unknown) {
    lookup[key] = { loading: false, result: null, error: err instanceof Error ? err.message : '送出失敗，請稍後再試' }
  }
}

// 動作列的「查政見」「查簡介」：按一下就建任務（kind=policy／profile），出現在任務看板
const policyRequest = useRequestTask()
const profileRequest = useRequestTask()
watch(() => route.params.politicianId, () => { policyRequest.reset(); profileRequest.reset() })

// Get election name by ID
function getElectionName(electionId: number): string {
  const election = elections.value.find(e => e.id === electionId)
  return election?.shortName || election?.name || `選舉 ${electionId}`
}

// Get election year by ID
function getElectionYear(electionId: number): number | null {
  const election = elections.value.find(e => e.id === electionId)
  if (!election?.electionDate) return null
  return new Date(election.electionDate).getFullYear()
}

// Check if election is in the past
function isElectionPast(electionId: number): boolean {
  const election = elections.value.find(e => e.id === electionId)
  if (!election?.electionDate) return false
  return new Date(election.electionDate) < new Date()
}

// Candidate status helpers - considers whether election is past or future
/**
 * 選舉結果優先於參選狀態（2026-09-18）。
 *
 * candidate_status 記的是「選前的登記狀態」，2024 那 318 筆全都停在 confirmed；
 * 選完的結果在另一個欄位 election_result（已用中選會資料回填：當選 75、落選 239）。
 * 這裡原本只讀 candidate_status，過去選舉又只認 elected/defeated，
 * 結果是「2024 總統候選人 賴清德」右邊一片空白——資料有，只是沒人去讀。
 */
function resultLabel(result?: 'elected' | 'not_elected'): string | null {
  if (result === 'elected') return '當選'
  if (result === 'not_elected') return '落選'
  return null
}

function getCandidateStatusLabel(status?: CandidateStatus, electionId?: number, result?: 'elected' | 'not_elected'): string | null {
  const byResult = resultLabel(result)
  if (byResult) return byResult
  const isPast = electionId ? isElectionPast(electionId) : false

  // For past elections, only show elected/defeated（未登記參選是歷史事實，一併保留）
  if (isPast) {
    switch (status) {
      case 'elected': return '當選'
      case 'defeated': return '落選'
      case 'not_running': return '未登記參選'
      default: return null // Don't show "確認參選" for past elections
    }
  }

  // For future elections, show pre-election status
  switch (status) {
    case 'confirmed': return '確認參選'
    case 'registered': return '已登記'
    case 'qualified': return '已審定'
    case 'not_running': return '未登記參選'
    case 'likely': return '可能參選'
    case 'rumored': return '傳聞參選'
    case 'elected': return '當選'
    case 'defeated': return '落選'
    default: return null
  }
}

function getCandidateStatusColor(status?: CandidateStatus, electionId?: number, result?: 'elected' | 'not_elected'): string {
  if (result === 'elected') return 'bg-emerald-100 text-emerald-700 border-emerald-200'
  if (result === 'not_elected') return 'bg-red-100 text-red-600 border-red-200'
  const isPast = electionId ? isElectionPast(electionId) : false

  // For past elections without elected/defeated status, use neutral color
  if (isPast && status !== 'elected' && status !== 'defeated') {
    return 'bg-slate-50 text-slate-600 border-slate-200'
  }

  switch (status) {
    case 'confirmed': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'registered': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'qualified': return 'bg-emerald-200 text-emerald-800 border-emerald-300'
    case 'not_running': return 'bg-slate-100 text-slate-500 border-slate-200'
    case 'likely': return 'bg-amber-100 text-amber-700 border-amber-200'
    case 'rumored': return 'bg-slate-100 text-slate-600 border-slate-200'
    case 'elected': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'defeated': return 'bg-red-100 text-red-600 border-red-200'
    default: return 'bg-slate-50 text-slate-600 border-slate-200'
  }
}

const politicianLoading = ref(false)

/** 這個人不在全域 state 裡就從 DB 補載。/politician/A → /politician/B 也要走這裡。 */
async function ensurePoliticianLoaded(politicianId: string): Promise<void> {
  if (!politicianId || politicians.value.find(p => p.id === politicianId)) return
  politicianLoading.value = true
  try {
    await loadPoliticianById(politicianId)
  } finally {
    politicianLoading.value = false
  }
}

onMounted(async () => {
  // 政見清單是按需載入的（257 KB，公民提問頁那類頁面不需要）。這一頁要整份。
  ensurePolicies()
  await ensurePoliticianLoaded(String(route.params.politicianId))
})

// 站內從一位政治人物點到另一位，走的是同一個元件實例，onMounted 不會再跑。
// 沒有這個 watch，只要對方還沒在全域 state 裡，頁面就直接顯示「找不到該政治人物」。
// （直接開網址不受影響，那是預渲染的頁面。）
watch(() => route.params.politicianId, (id) => {
  if (id) ensurePoliticianLoaded(String(id))
})


const politician = computed(() => politicians.value.find(c => c.id === String(route.params.politicianId)))
// 軟合併過的人物：舊網址轉向到保留的那一筆（2026-09-19 同名人物流程）
watch(politician, (p) => { if (p?.mergedInto) router.replace(`/politician/${p.mergedInto}`) }, { immediate: true })

const campaignPledges = computed(() => politician.value ? policies.value.filter(p => p.politicianId === politician.value!.id && p.status === PolicyStatus.CAMPAIGN) : [])
const historicalPolicies = computed(() => politician.value ? policies.value.filter(p => p.politicianId === politician.value!.id && p.status !== PolicyStatus.CAMPAIGN) : [])

interface PolicyGroup {
  key: string
  label: string | null // null＝不顯示分組標題
  policies: Policy[]
}

// 目前這屆＝elections 裡選舉日最新的一屆（不寫死年份，2026 過後自然換下一屆）。
const latestElectionId = computed<number | null>(() => {
  if (elections.value.length === 0) return null
  return elections.value.reduce((latest, e) => (e.electionDate > latest.electionDate ? e : latest)).id
})

// 依所屬選舉屆別分組，新屆別在前、沒有屆別的（舊資料）排最後；組內依提出日期新到舊。
// 標題的用途是「避免讀者誤以為這是本屆的」，所以只在可能誤會時才出現：
// 分成多組一定要標；只有一組時，本屆與沒有屆別的舊資料都不必標
// （年份在政見卡片上本來就看得到），只有往屆單獨一組時要標出來，
// 不然只有 2024 屆政見的人物頁會讓人誤以為在看本屆。
function groupPoliciesByElection(list: Policy[], suffix: string): PolicyGroup[] {
  const byElection = new Map<number | null, Policy[]>()
  for (const p of list) {
    const key = p.electionId ?? null
    byElection.set(key, [...(byElection.get(key) ?? []), p])
  }

  const knownYears = [...byElection.keys()].filter((id): id is number => id !== null).sort((a, b) => b - a)
  const orderedKeys: (number | null)[] = byElection.has(null) ? [...knownYears, null] : knownYears

  const groups = orderedKeys.map((id): PolicyGroup => {
    const groupPolicies = [...(byElection.get(id) ?? [])].sort((a, b) => policySortDate(b) - policySortDate(a))
    const label = id === null ? '未標註屆別' : `${getElectionById(id)?.shortName ?? `${id} 年`}${suffix}`
    return { key: id === null ? 'unlabeled' : String(id), label, policies: groupPolicies }
  })

  const onlyGroupNeedsNoLabel = groups.length === 1
    && (groups[0].key === 'unlabeled' || groups[0].key === String(latestElectionId.value))
  if (onlyGroupNeedsNoLabel) {
    return [{ ...groups[0], label: null }]
  }
  return groups
}

const campaignGroups = computed(() => groupPoliciesByElection(campaignPledges.value, '承諾'))
const historyGroups = computed(() => groupPoliciesByElection(historicalPolicies.value, '政見'))

usePageHead({
  type: 'article',
  // firebase.json 把 /politician/** rewrite 到殼檔回 200，不存在的 id 也會是 200；確定沒資料就標 noindex 免得被當 soft 404 收錄
  noindex: () => !loading.value && !politicianLoading.value && !politician.value,
  title: () => politician.value ? `${politician.value.name}｜${politician.value.position}` : undefined,
  description: () => politician.value
    ? (politician.value.slogan || politician.value.bio
        ? `${politician.value.name}（${politician.value.party}，${politician.value.region}${politician.value.position}）：${politician.value.slogan || politician.value.bio}`
        : `${politician.value.name}，${politician.value.party}，${politician.value.region}${politician.value.position}。正見追蹤其競選承諾 ${campaignPledges.value.length} 項、過往政績 ${historicalPolicies.value.length} 項。`)
    : undefined,
  // 2026-09-23：給搜尋引擎與 AI 讀的結構化資料；政見清單放 subjectOf，每筆帶固定網址，AI 轉述時才引得回來
  jsonLd: () => politician.value ? {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: politician.value.name,
    url: `${SITE_URL}/politician/${politician.value.id}`,
    ...(politician.value.avatarUrl ? { image: politician.value.avatarUrl } : {}),
    ...(politician.value.currentPosition ? { jobTitle: politician.value.currentPosition } : {}),
    ...(politician.value.party ? { affiliation: { '@type': 'Organization', name: politician.value.party } } : {}),
    ...(politician.value.region ? { homeLocation: { '@type': 'Place', name: politician.value.region } } : {}),
    subjectOf: campaignPledges.value.slice(0, 30).map((p) => ({
      '@type': 'CreativeWork',
      additionalType: '競選承諾',
      name: p.title,
      url: `${SITE_URL}/policy/${p.id}`,
      ...(p.sourceUrl ? { citation: p.sourceUrl } : {}),
    })),
    publisher: PUBLISHER_LD,
    license: DATA_LICENSE_URL,
  } : undefined,
})
</script>

<template>
  <div v-if="politician" class="bg-slate-50 min-h-screen">
    <Hero>
      <template #icon><User :size="400" class="text-violet-500" /></template>
      <template #title>
        <div class="flex flex-col md:flex-row gap-8 items-start">
          <div class="relative">
            <Avatar :src="politician.avatarUrl" :name="politician.name" size="2xl" class="border-4 border-white shadow-xl" />
            <PartyBadge :party="politician.party" :size="8" class="absolute bottom-2 right-2 shadow-md" />
            <!-- Avatar search button - always visible -->
            <button
              v-if="!lookup.avatar.result"
              @click="requestLookup('avatar')"
              :disabled="lookup.avatar.loading"
              class="absolute -bottom-2 left-1/2 -translate-x-1/2 text-xs px-2 py-1 bg-white/90 hover:bg-white text-slate-700 rounded-full transition-all flex items-center gap-1 shadow-lg"
            >
              <Loader2 v-if="lookup.avatar.loading" :size="10" class="animate-spin" />
              <Camera v-else :size="10" />
              {{ lookup.avatar.loading ? '...' : '照片更新' }}
            </button>
            <span
              v-if="lookup.avatar.result"
              class="absolute -bottom-2 left-1/2 -translate-x-1/2 text-xs px-2 py-1 bg-emerald-500 text-white rounded-full flex items-center gap-1 shadow-lg"
            >
              <CheckCircle :size="10" />
              已排入
            </span>
          </div>
          <div class="flex-1">
            <div class="flex flex-wrap items-center gap-3 mb-2">
              <h1 class="text-4xl font-bold text-white">{{ politician.name }}</h1>
              <span class="bg-white/20 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm">{{ politician.position }}</span>
              <span class="bg-white/20 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm flex items-center gap-1"><MapPin :size="14" /> {{ politician.region }}</span>
              <span v-if="politician.birthYear" class="bg-white/20 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm">
                {{ politician.birthYear }} 年生 ({{ new Date().getFullYear() - politician.birthYear }} 歲)
              </span>
            </div>

            <h2 v-if="politician.slogan" class="text-xl md:text-2xl font-bold text-amber-400 mb-4 italic">"{{ politician.slogan }}"</h2>

            <!-- Bio display -->
            <div class="max-w-2xl">
              <p v-if="politician.bio" class="text-violet-100 leading-relaxed mb-6 text-lg">{{ shortUrlsIn(politician.bio) }}</p>
              <p v-else class="text-violet-200 mb-4 text-sm opacity-75">暫無簡介</p>
            </div>
          </div>
        </div>
      </template>
      <template #actions>
        <div class="flex flex-wrap items-center gap-2 sm:gap-3 ml-0 md:ml-48">
          <button @click="router.go(-1)" :class="HERO_ICON_BUTTON" aria-label="返回">
            <ChevronLeft :size="HERO_ICON_SIZE" class="group-hover:-translate-x-1 transition-transform" />
          </button>
          <!-- 按一下就建任務，出現在任務看板；跟政見頁的按鈕同一套（composables/useRequestTask.ts） -->
          <HeroAction data-testid="hero-query-policy" @click="policyRequest.send({ kind: 'policy', politician_id: politician.id })">
            <Loader2 v-if="policyRequest.loading.value" :size="16" class="animate-spin" />
            <CheckCircle v-else-if="policyRequest.done.value" :size="16" />
            <XCircle v-else-if="policyRequest.error.value" :size="16" />
            <Sparkles v-else :size="16" />
            {{ policyRequest.label('查政見') }}
          </HeroAction>
          <HeroAction data-testid="hero-query-profile" @click="profileRequest.send({ kind: 'profile', politician_id: politician.id })">
            <Loader2 v-if="profileRequest.loading.value" :size="16" class="animate-spin" />
            <CheckCircle v-else-if="profileRequest.done.value" :size="16" />
            <XCircle v-else-if="profileRequest.error.value" :size="16" />
            <Sparkles v-else :size="16" />
            {{ profileRequest.label('查簡介') }}
          </HeroAction>
        </div>
        <RequestTaskNotice class="mt-3 ml-0 md:ml-48" :result="policyRequest.result.value" :error="policyRequest.error.value" on-dark />
        <RequestTaskNotice class="mt-3 ml-0 md:ml-48" :result="profileRequest.result.value" :error="profileRequest.error.value" on-dark />
      </template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="text-left">
        <div>
          <!-- 三個分頁在手機上會被擠成直排（2026-09-20 截圖）：手機用短標、縮字級與內距、不換行 -->
          <div class="flex border-b border-slate-200 mb-6 overflow-x-auto">
            <button @click="activeTab = 'campaign'" :class="`pb-3 sm:pb-4 px-3 sm:px-6 font-bold text-base sm:text-lg flex items-center gap-1.5 sm:gap-2 whitespace-nowrap shrink-0 transition-all relative ${activeTab === 'campaign' ? 'text-violet-600' : 'text-slate-400 hover:text-slate-600'}`">
              <Megaphone :size="18" /><span class="sm:hidden">承諾</span><span class="hidden sm:inline">競選承諾</span><span class="bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full text-xs ml-1">{{ campaignPledges.length }}</span>
              <div v-if="activeTab === 'campaign'" class="absolute bottom-0 left-0 w-full h-1 bg-violet-600 rounded-t-full"></div>
            </button>
            <button @click="activeTab = 'history'" :class="`pb-3 sm:pb-4 px-3 sm:px-6 font-bold text-base sm:text-lg flex items-center gap-1.5 sm:gap-2 whitespace-nowrap shrink-0 transition-all relative ${activeTab === 'history' ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'}`">
              <CheckCircle2 :size="18" /><span class="sm:hidden">政績</span><span class="hidden sm:inline">過往政績與追蹤</span><span class="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-xs ml-1">{{ historicalPolicies.length }}</span>
              <div v-if="activeTab === 'history'" class="absolute bottom-0 left-0 w-full h-1 bg-blue-600 rounded-t-full"></div>
            </button>
            <button @click="activeTab = 'profile'" :class="`pb-3 sm:pb-4 px-3 sm:px-6 font-bold text-base sm:text-lg flex items-center gap-1.5 sm:gap-2 whitespace-nowrap shrink-0 transition-all relative ${activeTab === 'profile' ? 'text-emerald-600' : 'text-slate-400 hover:text-slate-600'}`">
              <User :size="18" /><span class="sm:hidden">資料</span><span class="hidden sm:inline">基本資料</span>
              <div v-if="activeTab === 'profile'" class="absolute bottom-0 left-0 w-full h-1 bg-emerald-600 rounded-t-full"></div>
            </button>
          </div>
          <div class="space-y-6">
            <template v-if="activeTab === 'campaign'">
              <template v-if="campaignPledges.length > 0">
                <div class="flex justify-end -mt-2">
                  <div class="inline-flex bg-slate-100 p-1 rounded-lg">
                    <button @click="setCampaignView('cards')" :class="`px-3 py-1.5 rounded-md text-xs font-bold flex items-center gap-1 transition-all ${campaignView === 'cards' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`" title="卡片"><LayoutGrid :size="14" />卡片</button>
                    <button @click="setCampaignView('table')" :class="`px-3 py-1.5 rounded-md text-xs font-bold flex items-center gap-1 transition-all ${campaignView === 'table' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`" title="表格"><Table2 :size="14" />表格</button>
                  </div>
                </div>
                <div v-if="campaignView === 'table'" class="space-y-8">
                  <div v-for="group in campaignGroups" :key="group.key">
                    <h3 v-if="group.label" class="text-sm font-black text-slate-400 uppercase tracking-wider mb-3">{{ group.label }}</h3>
                    <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                      <table class="w-full text-sm">
                        <thead class="bg-slate-50 text-slate-500 text-xs">
                          <tr>
                            <th class="text-left font-semibold px-3 py-2 w-10">#</th>
                            <th class="text-left font-semibold px-3 py-2">政見</th>
                            <th class="text-left font-semibold px-3 py-2 w-32">類別</th>
                            <th class="text-left font-semibold px-3 py-2 w-28">提出日期</th>
                            <th class="text-left font-semibold px-3 py-2">標籤</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="(policy, i) in group.policies" :key="policy.id" class="border-t border-slate-100 hover:bg-violet-50/40 cursor-pointer" @click="router.push(`/policy/${policy.id}`)">
                            <td class="px-3 py-2 text-slate-400 tabular-nums">{{ i + 1 }}</td>
                            <td class="px-3 py-2">
                              <div class="font-bold text-navy-900">{{ policy.title }}</div>
                              <div class="text-slate-500 text-xs line-clamp-2">{{ policy.description }}</div>
                            </td>
                            <td class="px-3 py-2 text-slate-600 whitespace-nowrap">{{ policy.category }}</td>
                            <td class="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{{ policy.proposedDate ?? '—' }}</td>
                            <td class="px-3 py-2 text-slate-500 text-xs">{{ (policy.tags ?? []).join('、') }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
                <div v-else class="space-y-8">
                  <div v-for="group in campaignGroups" :key="group.key">
                    <h3 v-if="group.label" class="text-sm font-black text-slate-400 uppercase tracking-wider mb-4">{{ group.label }}</h3>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <PolicyCard v-for="policy in group.policies" :key="policy.id" :policy="policy" :politician="politician" :show-politician="false" :show-status="false" :on-click="() => router.push(`/policy/${policy.id}`)" />
                    </div>
                  </div>
                </div>
                <!-- 已有資料也能再查：次要位置、小按鈕 -->
                <AiLookupInline :state="lookup.campaign" label="請 AI 補充最新的政見" @click="requestLookup('campaign')" />
              </template>
              <div v-else class="bg-white p-12 text-center rounded-xl border border-dashed border-slate-300">
                <Search :size="48" class="mx-auto mb-4 text-slate-300" />
                <p class="text-slate-500 mb-6">該候選人尚未發布競選承諾。</p>

                <!-- AI Search Button -->
                <button
                  v-if="!lookup.campaign.result"
                  @click="requestLookup('campaign')"
                  :disabled="lookup.campaign.loading"
                  :class="[
                    'px-6 py-3 rounded-xl font-bold transition-all flex items-center gap-2 mx-auto',
                    lookup.campaign.error
                      ? 'bg-red-100 text-red-700 hover:bg-red-200'
                      : 'bg-violet-600 hover:bg-violet-700 text-white shadow-lg shadow-violet-500/20'
                  ]"
                >
                  <Loader2 v-if="lookup.campaign.loading" :size="20" class="animate-spin" />
                  <Sparkles v-else :size="20" />
                  {{ lookup.campaign.loading ? '送出中…' : lookup.campaign.error ? '重試' : '請 AI 幫忙查政見' }}
                </button>

                <!-- Success State -->
                <div v-if="lookup.campaign.result" class="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mt-4 max-w-md mx-auto" data-testid="request-task-done">
                  <div class="flex items-center gap-2 text-emerald-700 font-bold mb-2">
                    <CheckCircle :size="20" />
                    已交給 AI 代理
                  </div>
                  <p class="text-sm text-emerald-600">{{ requestTaskMessage(lookup.campaign.result) }}</p>
                  <RouterLink :to="BOARD_PATH" class="inline-block mt-2 text-sm font-bold text-emerald-800 underline underline-offset-2">到任務看板看進度</RouterLink>
                </div>

                <!-- Error Message -->
                <p v-if="lookup.campaign.error && !lookup.campaign.result" class="text-red-500 text-sm mt-3">{{ lookup.campaign.error }}</p>
              </div>
            </template>
            <!-- 只在「過往政績」分頁出現；原本是 v-else，切到「基本資料」時也會跟著出來（2026-09-20） -->
            <template v-else-if="activeTab === 'history'">
              <template v-if="historicalPolicies.length > 0">
                <div class="space-y-8">
                  <div v-for="group in historyGroups" :key="group.key">
                    <h3 v-if="group.label" class="text-sm font-black text-slate-400 uppercase tracking-wider mb-4">{{ group.label }}</h3>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <PolicyCard v-for="policy in group.policies" :key="policy.id" :policy="policy" :politician="politician" :show-politician="false" :on-click="() => router.push(`/policy/${policy.id}`)" />
                    </div>
                  </div>
                </div>
                <AiLookupInline :state="lookup.history" label="請 AI 補充最新的政績" @click="requestLookup('history')" />
              </template>
              <div v-else class="bg-white p-12 text-center rounded-xl border border-dashed border-slate-300">
                <FileText :size="48" class="mx-auto mb-4 text-slate-300" />
                <p class="text-slate-500 mb-6">該候選人無過往追蹤紀錄。</p>

                <!-- AI Search Button for History -->
                <button
                  v-if="!lookup.history.result"
                  @click="requestLookup('history')"
                  :disabled="lookup.history.loading"
                  :class="[
                    'px-6 py-3 rounded-xl font-bold transition-all flex items-center gap-2 mx-auto',
                    lookup.history.error
                      ? 'bg-red-100 text-red-700 hover:bg-red-200'
                      : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20'
                  ]"
                >
                  <Loader2 v-if="lookup.history.loading" :size="20" class="animate-spin" />
                  <Sparkles v-else :size="20" />
                  {{ lookup.history.loading ? '送出中…' : lookup.history.error ? '重試' : '請 AI 幫忙查政績' }}
                </button>

                <!-- Success State -->
                <div v-if="lookup.history.result" class="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mt-4 max-w-md mx-auto" data-testid="request-task-done">
                  <div class="flex items-center gap-2 text-emerald-700 font-bold mb-2">
                    <CheckCircle :size="20" />
                    已交給 AI 代理
                  </div>
                  <p class="text-sm text-emerald-600">{{ requestTaskMessage(lookup.history.result) }}</p>
                  <RouterLink :to="BOARD_PATH" class="inline-block mt-2 text-sm font-bold text-emerald-800 underline underline-offset-2">到任務看板看進度</RouterLink>
                </div>

                <!-- Error Message -->
                <p v-if="lookup.history.error && !lookup.history.result" class="text-red-500 text-sm mt-3">{{ lookup.history.error }}</p>
              </div>
            </template>
            <!-- 基本資料：原本的右側欄（政黨、選區、參選紀錄、現職、經歷、學歷、請 AI 幫忙查），2026-09-20 改成分頁。
                 用 v-show 不用 v-if：預渲染的 HTML 要有這一段，否則沒政見的人物頁 <main> 不到 120 字，
                 postbuild 的空殼檢查會把 14,137 頁擋下（#107 上線時建置紅在這裡） -->
            <div v-show="activeTab === 'profile'">
              <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <div class="space-y-4">
                <div>
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

                <!-- Election participation -->
                <div v-if="politician.elections?.length" class="pt-4 border-t border-slate-100">
                  <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">參選紀錄</h4>
                  <div class="space-y-2">
                    <div
                      v-for="elec in politician.elections"
                      :key="elec.electionId"
                      :class="['flex items-center justify-between p-2 rounded-lg text-sm border', getCandidateStatusColor(elec.candidateStatus, elec.electionId, elec.electionResult)]"
                    >
                      <div class="flex items-center gap-2">
                        <Vote :size="14" />
                        <span class="font-medium">{{ getElectionYear(elec.electionId) }} {{ elec.position }}<span v-if="elec.candNo" class="ml-1 text-slate-500">（{{ elec.candNo }}號）</span></span>
                      </div>
                      <span v-if="getCandidateStatusLabel(elec.candidateStatus, elec.electionId, elec.electionResult)" class="text-xs">
                        {{ getCandidateStatusLabel(elec.candidateStatus, elec.electionId, elec.electionResult) }}
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Current position -->
                <div v-if="politician.currentPosition" class="pt-4 border-t border-slate-100">
                  <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">現任職位</h4>
                  <p class="text-navy-900 font-medium flex items-center gap-2"><Briefcase :size="16" class="text-slate-400" />{{ politician.currentPosition }}</p>
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
                  <div v-if="politician.educationLevel" class="mb-4 bg-violet-50 p-3 rounded-lg border border-violet-100">
                    <p class="text-[10px] font-bold text-violet-400 uppercase tracking-wider mb-1">最高學歷</p>
                    <p class="text-violet-700 font-bold">{{ politician.educationLevel }}</p>
                  </div>
                  <ul class="space-y-3">

                    <template v-if="politician.education?.length">
                      <li v-for="(edu, i) in politician.education" :key="i" class="text-sm text-slate-600 pl-4 border-l-2 border-slate-200">{{ edu }}</li>
                    </template>
                    <li v-else class="text-slate-400 text-sm">暫無資料</li>
                  </ul>
                </div>

                <!-- AI Lookup Section - Always visible（動作列那顆會捲到這裡） -->
                <div :id="AI_LOOKUP_SECTION_ID" class="pt-4 border-t border-slate-100 scroll-mt-24">
                  <h3 class="font-bold text-navy-900 mb-4 flex items-center gap-2"><Sparkles class="text-violet-500" :size="18" /> 請 AI 幫忙查</h3>
                  <p class="text-xs text-slate-500 mb-3">按下去會把這位人物加進貢獻任務池，由 AI 代理查證後提交、經同儕驗證上線；已有資料也可以再查，補新的或更新；不需登入。</p>
                  <div class="space-y-3">
                    <!-- Search Bio Button -->
                    <button
                      @click="requestLookup('bio')"
                      :disabled="lookup.bio.loading"
                      :class="[
                        'w-full px-4 py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm',
                        lookup.bio.result
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : lookup.bio.error
                            ? 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                            : 'bg-violet-50 text-violet-700 border border-violet-200 hover:bg-violet-100'
                      ]"
                    >
                      <Loader2 v-if="lookup.bio.loading" :size="16" class="animate-spin" />
                      <CheckCircle v-else-if="lookup.bio.result" :size="16" />
                      <XCircle v-else-if="lookup.bio.error" :size="16" />
                      <User v-else :size="16" />
                      {{ lookup.bio.loading ? '送出中…' : lookup.bio.result ? (lookup.bio.result.status === 'already_queued' ? '已在任務池中' : '已排入任務池') : lookup.bio.error ? '重試' : (politician.bio || politician.education?.length || politician.experience?.length ? '請 AI 補充最新的簡介／學經歷' : '請 AI 查簡介／學經歷') }}
                    </button>

                    <!-- Search Avatar Button -->
                    <button
                      @click="requestLookup('avatar')"
                      :disabled="lookup.avatar.loading"
                      :class="[
                        'w-full px-4 py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm',
                        lookup.avatar.result
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : lookup.avatar.error
                            ? 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                            : 'bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100'
                      ]"
                    >
                      <Loader2 v-if="lookup.avatar.loading" :size="16" class="animate-spin" />
                      <CheckCircle v-else-if="lookup.avatar.result" :size="16" />
                      <XCircle v-else-if="lookup.avatar.error" :size="16" />
                      <Camera v-else :size="16" />
                      {{ lookup.avatar.loading ? '送出中…' : lookup.avatar.result ? (lookup.avatar.result.status === 'already_queued' ? '已在任務池中' : '已排入任務池') : lookup.avatar.error ? '重試' : (politician.avatarUrl ? '更新正確或新的照片' : '照片更新') }}
                    </button>

                    <!-- Error messages -->
                    <p v-if="lookup.bio.error" class="text-red-500 text-xs">{{ lookup.bio.error }}</p>
                    <p v-if="lookup.avatar.error" class="text-red-500 text-xs">{{ lookup.avatar.error }}</p>

                    <!-- Success hint -->
                    <div v-if="lookup.bio.result || lookup.avatar.result" class="bg-emerald-50 border border-emerald-200 rounded-lg p-3" data-testid="request-task-done">
                      <p class="text-xs text-emerald-600">{{ requestTaskMessage((lookup.bio.result || lookup.avatar.result)!) }}</p>
                      <RouterLink :to="BOARD_PATH" class="inline-block mt-1 text-xs font-bold text-emerald-800 underline underline-offset-2">到任務看板看進度</RouterLink>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </div>
          </div>

          <!-- 資料來源與查核履歷：這個人的資料被誰查過、誰驗過 -->
          <div class="mt-8"><HistoryPanel target="politician" :id="politician.id" title="資料來源與查核履歷" /></div>
        </div>

      </div>
    </div>
  </div>
  
  <!-- Loading state -->
  <div v-else-if="loading || politicianLoading" class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Loader2 :size="48" class="mx-auto mb-4 text-violet-500 animate-spin" />
      <p class="text-slate-500">載入中...</p>
    </div>
  </div>

  <!-- 資料拿不到（不是不存在）：給重試，別冒充「找不到」 -->
  <LoadError v-else-if="error" />

  <!-- Not found state -->
  <div v-else class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <User :size="64" class="mx-auto mb-4 text-slate-300" />
      <h2 class="text-2xl font-bold text-navy-900 mb-2">找不到候選人</h2>
      <p class="text-slate-500">請確認網址是否正確，或候選人資料尚未建立。</p>
      <button @click="router.push('/')" class="mt-6 text-violet-600 hover:text-violet-800 font-medium flex items-center gap-1 justify-center mx-auto">
        <ChevronLeft :size="18" /> 返回首頁
      </button>
    </div>
  </div>
</template>

