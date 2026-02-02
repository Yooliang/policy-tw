<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSupabase } from '../composables/useSupabase'
import { useAuth } from '../composables/useAuth'
import { supabase } from '../lib/supabase'
import { useIndexedDB } from '../composables/useIndexedDB'
import { PolicyStatus } from '../types'
import type { CandidateStatus } from '../types'
import Avatar from '../components/Avatar.vue'
import PolicyCard from '../components/PolicyCard.vue'
import Hero from '../components/Hero.vue'
import { MapPin, GraduationCap, Briefcase, CheckCircle2, Megaphone, ThumbsUp, User, ChevronLeft, ChevronRight, Loader2, Sparkles, Search, CheckCircle, XCircle, Vote, Calendar, FileText, Camera } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const { politicians, policies, elections, loading, refreshPoliticians, loadPoliticianById } = useSupabase()
const { isAuthenticated, signInWithGoogle, session } = useAuth()
const { getCacheTimestamp } = useIndexedDB()
const activeTab = ref<'campaign' | 'history'>('campaign')

// AI search states
const searchingCampaign = ref(false)
const searchCampaignSuccess = ref(false)
const searchCampaignError = ref<string | null>(null)

const searchingHistory = ref(false)
const searchHistorySuccess = ref(false)
const searchHistoryError = ref<string | null>(null)

const searchingBio = ref(false)
const searchBioSuccess = ref(false)
const searchBioError = ref<string | null>(null)

const searchingAvatar = ref(false)
const searchAvatarSuccess = ref(false)
const searchAvatarError = ref<string | null>(null)

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
function getCandidateStatusLabel(status?: CandidateStatus, electionId?: number): string | null {
  const isPast = electionId ? isElectionPast(electionId) : false

  // For past elections, only show elected/defeated
  if (isPast) {
    switch (status) {
      case 'elected': return '當選'
      case 'defeated': return '落選'
      default: return null // Don't show "確認參選" for past elections
    }
  }

  // For future elections, show pre-election status
  switch (status) {
    case 'confirmed': return '確認參選'
    case 'likely': return '可能參選'
    case 'rumored': return '傳聞參選'
    case 'elected': return '當選'
    case 'defeated': return '落選'
    default: return null
  }
}

function getCandidateStatusColor(status?: CandidateStatus, electionId?: number): string {
  const isPast = electionId ? isElectionPast(electionId) : false

  // For past elections without elected/defeated status, use neutral color
  if (isPast && status !== 'elected' && status !== 'defeated') {
    return 'bg-slate-50 text-slate-600 border-slate-200'
  }

  switch (status) {
    case 'confirmed': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'likely': return 'bg-amber-100 text-amber-700 border-amber-200'
    case 'rumored': return 'bg-slate-100 text-slate-600 border-slate-200'
    case 'elected': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'defeated': return 'bg-red-100 text-red-600 border-red-200'
    default: return 'bg-slate-50 text-slate-600 border-slate-200'
  }
}

// Trigger AI search for campaign pledges
async function handleSearchCampaign() {
  if (!isAuthenticated.value) {
    signInWithGoogle()
    return
  }

  const pol = politician.value
  if (!pol) return

  searchingCampaign.value = true
  searchCampaignSuccess.value = false
  searchCampaignError.value = null

  try {
    const input = `請搜尋「${pol.name}」的 2026 年選舉政見與競選承諾。地區：${pol.region}，職位：${pol.position}`

    const response = await supabase.functions.invoke('ai-classify', {
      body: {
        input,
        politician_id: pol.id,
        politician_name: pol.name,
      },
      headers: {
        Authorization: `Bearer ${session.value?.access_token}`,
      },
    })

    if (response.error) {
      throw new Error(response.error.message || JSON.stringify(response.error))
    }

    const data = response.data
    if (!data.success) {
      throw new Error(data.message || '提交失敗')
    }

    searchCampaignSuccess.value = true
  } catch (err: any) {
    console.error('Search error:', err)
    searchCampaignError.value = err.message || '搜尋請求失敗，請稍後再試'
  } finally {
    searchingCampaign.value = false
  }
}

// Trigger AI search for historical records
async function handleSearchHistory() {
  if (!isAuthenticated.value) {
    signInWithGoogle()
    return
  }

  const pol = politician.value
  if (!pol) return

  searchingHistory.value = true
  searchHistorySuccess.value = false
  searchHistoryError.value = null

  try {
    const input = `請搜尋「${pol.name}」的過往政績與施政成果。地區：${pol.region}，現任或曾任：${pol.currentPosition || pol.position}`

    const response = await supabase.functions.invoke('ai-classify', {
      body: {
        input,
        politician_id: pol.id,
        politician_name: pol.name,
      },
      headers: {
        Authorization: `Bearer ${session.value?.access_token}`,
      },
    })

    if (response.error) {
      throw new Error(response.error.message || JSON.stringify(response.error))
    }

    const data = response.data
    if (!data.success) {
      throw new Error(data.message || '提交失敗')
    }

    searchHistorySuccess.value = true
  } catch (err: any) {
    console.error('Search error:', err)
    searchHistoryError.value = err.message || '搜尋請求失敗，請稍後再試'
  } finally {
    searchingHistory.value = false
  }
}

// Trigger AI search for bio
async function handleSearchBio() {
  if (!isAuthenticated.value) {
    signInWithGoogle()
    return
  }

  const pol = politician.value
  if (!pol) return

  searchingBio.value = true
  searchBioSuccess.value = false
  searchBioError.value = null

  try {
    const input = `請搜尋「${pol.name}」的個人簡介、經歷、學歷背景，以及維基百科頭像照片。${pol.party ? `政黨：${pol.party}，` : ''}地區：${pol.region}`

    const response = await supabase.functions.invoke('ai-classify', {
      body: {
        input,
        politician_id: pol.id,
        politician_name: pol.name,
      },
      headers: {
        Authorization: `Bearer ${session.value?.access_token}`,
      },
    })

    if (response.error) {
      throw new Error(response.error.message || JSON.stringify(response.error))
    }

    const data = response.data
    if (!data.success) {
      throw new Error(data.message || '提交失敗')
    }

    searchBioSuccess.value = true
  } catch (err: any) {
    console.error('Search error:', err)
    searchBioError.value = err.message || '搜尋請求失敗，請稍後再試'
  } finally {
    searchingBio.value = false
  }
}

// Trigger AI search for avatar only
async function handleSearchAvatar() {
  if (!isAuthenticated.value) {
    signInWithGoogle()
    return
  }

  const pol = politician.value
  if (!pol) return

  searchingAvatar.value = true
  searchAvatarSuccess.value = false
  searchAvatarError.value = null

  try {
    const input = `請搜尋「${pol.name}」的維基百科頭像照片。${pol.party ? `政黨：${pol.party}，` : ''}地區：${pol.region}，職位：${pol.position}`

    const response = await supabase.functions.invoke('ai-classify', {
      body: {
        input,
        politician_id: pol.id,
        politician_name: pol.name,
      },
      headers: {
        Authorization: `Bearer ${session.value?.access_token}`,
      },
    })

    if (response.error) {
      throw new Error(response.error.message || JSON.stringify(response.error))
    }

    const data = response.data
    if (!data.success) {
      throw new Error(data.message || '提交失敗')
    }

    searchAvatarSuccess.value = true
  } catch (err: any) {
    console.error('Search error:', err)
    searchAvatarError.value = err.message || '搜尋請求失敗，請稍後再試'
  } finally {
    searchingAvatar.value = false
  }
}

// Check cache age on mount, refresh if older than 1 hour
const ONE_HOUR = 60 * 60 * 1000
const politicianLoading = ref(false)

onMounted(async () => {
  // 如果 politicians 中找不到該候選人，直接從 DB 載入
  const politicianId = String(route.params.politicianId)
  if (!politicians.value.find(p => p.id === politicianId)) {
    politicianLoading.value = true
    await loadPoliticianById(politicianId)
    politicianLoading.value = false
  }

  const cacheTimestamp = await getCacheTimestamp('politicians_all')
  if (cacheTimestamp && Date.now() - cacheTimestamp > ONE_HOUR) {
    console.log('Cache older than 1 hour, refreshing politicians...')
    refreshPoliticians()
  }
})


const politician = computed(() => politicians.value.find(c => c.id === String(route.params.politicianId)))

const campaignPledges = computed(() => politician.value ? policies.value.filter(p => p.politicianId === politician.value!.id && p.status === PolicyStatus.CAMPAIGN) : [])
const historicalPolicies = computed(() => politician.value ? policies.value.filter(p => p.politicianId === politician.value!.id && p.status !== PolicyStatus.CAMPAIGN) : [])
</script>

<template>
  <div v-if="politician" class="bg-slate-50 min-h-screen">
    <Hero>
      <template #icon><User :size="400" class="text-violet-500" /></template>
      <template #title>
        <div class="flex flex-col md:flex-row gap-8 items-start">
          <div class="relative">
            <Avatar :src="politician.avatarUrl" :name="politician.name" size="2xl" class="border-4 border-white shadow-xl" />
            <span :class="`absolute bottom-2 right-2 w-8 h-8 flex items-center justify-center rounded-full text-sm font-bold text-white border-2 border-white shadow-md
              ${politician.party === '國民黨' ? 'bg-blue-600' :
                politician.party === '民進黨' ? 'bg-green-600' :
                politician.party === '民眾黨' ? 'bg-cyan-600' : 'bg-gray-500'}`">
              {{ politician.party[0] }}
            </span>
            <!-- Avatar search button when no avatar -->
            <button
              v-if="!politician.avatarUrl && !searchAvatarSuccess"
              @click="handleSearchAvatar"
              :disabled="searchingAvatar"
              class="absolute -bottom-2 left-1/2 -translate-x-1/2 text-xs px-2 py-1 bg-white/90 hover:bg-white text-slate-700 rounded-full transition-all flex items-center gap-1 shadow-lg"
            >
              <Loader2 v-if="searchingAvatar" :size="10" class="animate-spin" />
              <Camera v-else :size="10" />
              {{ searchingAvatar ? '...' : '查找照片' }}
            </button>
            <span
              v-if="!politician.avatarUrl && searchAvatarSuccess"
              class="absolute -bottom-2 left-1/2 -translate-x-1/2 text-xs px-2 py-1 bg-emerald-500 text-white rounded-full flex items-center gap-1 shadow-lg"
            >
              <CheckCircle :size="10" />
              已提交
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

            <!-- Bio with AI search -->
            <div class="max-w-2xl">
              <p v-if="politician.bio" class="text-violet-100 leading-relaxed mb-6 text-lg">{{ politician.bio }}</p>
              <div v-else class="text-violet-200 mb-4 flex items-center gap-3 flex-wrap">
                <span class="text-sm opacity-75">暫無簡介</span>
                <button
                  v-if="!searchBioSuccess"
                  @click="handleSearchBio"
                  :disabled="searchingBio"
                  class="text-xs px-2.5 py-1 bg-white/10 hover:bg-white/20 rounded-lg transition-all flex items-center gap-1.5 border border-white/20"
                >
                  <Loader2 v-if="searchingBio" :size="12" class="animate-spin" />
                  <Sparkles v-else :size="12" />
                  {{ searchingBio ? '搜尋中...' : 'AI 查找' }}
                </button>
                <span v-if="searchBioSuccess" class="text-emerald-300 text-xs flex items-center gap-1">
                  <CheckCircle :size="12" />
                  已提交
                </span>
                <span v-if="searchBioError" class="text-red-300 text-xs">{{ searchBioError }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
      <template #actions>
        <div class="flex items-center gap-4 ml-0 md:ml-48">
          <button @click="router.go(-1)" class="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition-all border border-white/10 group shrink-0" aria-label="返回">
            <ChevronLeft :size="24" class="group-hover:-translate-x-1 transition-transform" />
          </button>
          <button class="bg-amber-500 hover:bg-amber-600 text-white px-6 py-2 rounded-lg font-bold shadow-lg shadow-amber-500/30 transition-all flex items-center gap-2"><ThumbsUp :size="18" /> 支持候選人</button>
          <button class="bg-white/10 hover:bg-white/20 text-white px-6 py-2 rounded-lg font-bold border border-white/30 transition-all">分享頁面</button>
        </div>
      </template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left">
        <!-- Main Content (Left) -->
        <div class="lg:col-span-2">
          <div class="flex border-b border-slate-200 mb-6">
            <button @click="activeTab = 'campaign'" :class="`pb-4 px-6 font-bold text-lg flex items-center gap-2 transition-all relative ${activeTab === 'campaign' ? 'text-violet-600' : 'text-slate-400 hover:text-slate-600'}`">
              <Megaphone :size="20" />2026 競選承諾<span class="bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full text-xs ml-1">{{ campaignPledges.length }}</span>
              <div v-if="activeTab === 'campaign'" class="absolute bottom-0 left-0 w-full h-1 bg-violet-600 rounded-t-full"></div>
            </button>
            <button @click="activeTab = 'history'" :class="`pb-4 px-6 font-bold text-lg flex items-center gap-2 transition-all relative ${activeTab === 'history' ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'}`">
              <CheckCircle2 :size="20" />過往政績與追蹤<span class="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-xs ml-1">{{ historicalPolicies.length }}</span>
              <div v-if="activeTab === 'history'" class="absolute bottom-0 left-0 w-full h-1 bg-blue-600 rounded-t-full"></div>
            </button>
          </div>
          <div class="space-y-6">
            <template v-if="activeTab === 'campaign'">
              <div v-if="campaignPledges.length > 0" class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <PolicyCard v-for="policy in campaignPledges" :key="policy.id" :policy="policy" :politician="politician" :on-click="() => router.push(`/policy/${policy.id}`)" />
              </div>
              <div v-else class="bg-white p-12 text-center rounded-xl border border-dashed border-slate-300">
                <Search :size="48" class="mx-auto mb-4 text-slate-300" />
                <p class="text-slate-500 mb-6">該候選人尚未發布 2026 競選承諾。</p>

                <!-- AI Search Button -->
                <button
                  v-if="!searchCampaignSuccess"
                  @click="handleSearchCampaign"
                  :disabled="searchingCampaign"
                  :class="[
                    'px-6 py-3 rounded-xl font-bold transition-all flex items-center gap-2 mx-auto',
                    searchCampaignError
                      ? 'bg-red-100 text-red-700 hover:bg-red-200'
                      : 'bg-violet-600 hover:bg-violet-700 text-white shadow-lg shadow-violet-500/20'
                  ]"
                >
                  <Loader2 v-if="searchingCampaign" :size="20" class="animate-spin" />
                  <Sparkles v-else :size="20" />
                  {{ searchingCampaign ? '搜尋中...' : searchCampaignError ? '重試' : 'AI 一鍵查找政見' }}
                </button>

                <!-- Success State -->
                <div v-if="searchCampaignSuccess" class="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mt-4 max-w-md mx-auto">
                  <div class="flex items-center gap-2 text-emerald-700 font-bold mb-2">
                    <CheckCircle :size="20" />
                    任務已開始
                  </div>
                  <p class="text-sm text-emerald-600 mb-3">將在背景運行，請稍後回來查看結果。</p>
                  <button
                    @click="router.push('/ai-assistant')"
                    class="text-sm font-bold text-emerald-700 hover:text-emerald-900 flex items-center gap-1 mx-auto"
                  >
                    前往 AI 查核 <ChevronRight :size="16" />
                  </button>
                </div>

                <!-- Error Message -->
                <p v-if="searchCampaignError && !searchCampaignSuccess" class="text-red-500 text-sm mt-3">{{ searchCampaignError }}</p>
              </div>
            </template>
            <template v-else>
              <div v-if="historicalPolicies.length > 0" class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <PolicyCard v-for="policy in historicalPolicies" :key="policy.id" :policy="policy" :politician="politician" :on-click="() => router.push(`/policy/${policy.id}`)" />
              </div>
              <div v-else class="bg-white p-12 text-center rounded-xl border border-dashed border-slate-300">
                <FileText :size="48" class="mx-auto mb-4 text-slate-300" />
                <p class="text-slate-500 mb-6">該候選人無過往追蹤紀錄。</p>

                <!-- AI Search Button for History -->
                <button
                  v-if="!searchHistorySuccess"
                  @click="handleSearchHistory"
                  :disabled="searchingHistory"
                  :class="[
                    'px-6 py-3 rounded-xl font-bold transition-all flex items-center gap-2 mx-auto',
                    searchHistoryError
                      ? 'bg-red-100 text-red-700 hover:bg-red-200'
                      : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20'
                  ]"
                >
                  <Loader2 v-if="searchingHistory" :size="20" class="animate-spin" />
                  <Sparkles v-else :size="20" />
                  {{ searchingHistory ? '搜尋中...' : searchHistoryError ? '重試' : 'AI 一鍵查找政績' }}
                </button>

                <!-- Success State -->
                <div v-if="searchHistorySuccess" class="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mt-4 max-w-md mx-auto">
                  <div class="flex items-center gap-2 text-emerald-700 font-bold mb-2">
                    <CheckCircle :size="20" />
                    任務已開始
                  </div>
                  <p class="text-sm text-emerald-600 mb-3">將在背景運行，請稍後回來查看結果。</p>
                  <button
                    @click="router.push('/ai-assistant')"
                    class="text-sm font-bold text-emerald-700 hover:text-emerald-900 flex items-center gap-1 mx-auto"
                  >
                    前往 AI 查核 <ChevronRight :size="16" />
                  </button>
                </div>

                <!-- Error Message -->
                <p v-if="searchHistoryError && !searchHistorySuccess" class="text-red-500 text-sm mt-3">{{ searchHistoryError }}</p>
              </div>
            </template>
          </div>
        </div>

        <!-- Sidebar (Right) -->
        <div class="lg:col-span-1 space-y-6">
          <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm sticky top-24">
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
                    :class="['flex items-center justify-between p-2 rounded-lg text-sm border', getCandidateStatusColor(elec.candidateStatus, elec.electionId)]"
                  >
                    <div class="flex items-center gap-2">
                      <Vote :size="14" />
                      <span class="font-medium">{{ getElectionYear(elec.electionId) }} {{ elec.position }}</span>
                    </div>
                    <span v-if="getCandidateStatusLabel(elec.candidateStatus, elec.electionId)" class="text-xs">
                      {{ getCandidateStatusLabel(elec.candidateStatus, elec.electionId) }}
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
            </div>
          </div>
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

