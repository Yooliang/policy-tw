<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Hero from '../components/Hero.vue'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import MechanismNav from '../components/MechanismNav.vue'
import AskQuestionForm from '../components/community/AskQuestionForm.vue'
import CitizenQuestionCard from '../components/community/CitizenQuestionCard.vue'
import { Loader2, MessageCircleQuestion } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'
import { useGlobalState } from '../composables/useGlobalState'
import { useCitizenQuestions } from '../composables/useCitizenQuestions'
import { voteStance, type AskQuestionResult, type Stance } from '../lib/citizen-questions'
import { usePageHead } from '../composables/usePageHead'
import { useRegionQuerySync, queryField } from '../composables/useRegionQuerySync'
import { useRoute } from 'vue-router'

const { policies, politicians, loadPoliticianById, loadPolicyById } = useSupabase()
const { globalRegion } = useGlobalState()
const { questions, loadingQuestions, questionsError, loadQuestions, answersByQuestion, loadAnswers, applyStanceResult } = useCitizenQuestions()

type StatusFilter = 'all' | 'open' | 'answered'
type SortMode = 'stance' | 'latest'

const route = useRoute()
const statusFilter = ref<StatusFilter>('all')
const sortMode = ref<SortMode>('latest')
// 從 PolicyDetail 的「民眾提問」帶 ?policy= 過來：只看這項政見的提問，且提問表單預設掛在它底下
const policyFilter = ref('')
// ?q= 由政見頁的「這不是政見？」帶過來，預先填好問題，使用者可以改或直接送出
const presetQuestion = computed(() => {
  const v = route.query.q
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined
})

// 縣市（全站共用）、狀態、排序 ↔ 網址 ?region=&status=&sort=&policy=
useRegionQuerySync({
  routeName: 'community',
  extra: {
    status: queryField(statusFilter, 'all', { allowed: ['all', 'open', 'answered'] as const }),
    sort: queryField(sortMode, 'latest', { allowed: ['stance', 'latest'] as const }),
    policy: queryField(policyFilter, ''),
  },
})

onMounted(loadQuestions)

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '待回答' },
  { key: 'answered', label: '已有答案' },
]
const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: 'stance', label: '表態多的' },
  { key: 'latest', label: '最新的' },
]
function chipClass(active: boolean): string {
  return active
    ? 'px-3 py-1.5 rounded-lg text-sm font-bold bg-white text-navy-900 shadow-sm transition-all'
    : 'px-3 py-1.5 rounded-lg text-sm font-bold text-slate-500 hover:text-slate-700 hover:bg-white/50 transition-all'
}

// 這一頁對政見與人物的全部需求，就是「用 id 換一個名字」。
// 所以兩邊都不叫 ensurePolicies／不預載整份清單，缺哪一筆就查哪一筆：
// 整份政見清單是 257 KB＋有政見的人物 91 KB，這一頁顯示的是幾行標題。
const policyTitleCache = ref<Record<string, string>>({})
function policyTitleOf(id: string | null): string | undefined {
  if (!id) return undefined
  return policies.value.find(p => p.id === id)?.title ?? policyTitleCache.value[id]
}
async function ensurePolicyTitle(id: string) {
  if (policyTitleCache.value[id] || policies.value.some(p => p.id === id)) return
  const loaded = await loadPolicyById(id)
  if (loaded) policyTitleCache.value = { ...policyTitleCache.value, [id]: loaded.title }
}
const policyFilterTitle = computed(() => policyTitleOf(policyFilter.value))

const politicianNameCache = ref<Record<string, string>>({})
function politicianNameOf(id: string | null): string | undefined {
  if (!id) return undefined
  return politicians.value.find(p => p.id === id)?.name ?? politicianNameCache.value[id]
}
async function ensurePoliticianName(id: string) {
  if (politicianNameCache.value[id] || politicians.value.some(p => p.id === id)) return
  const loaded = await loadPoliticianById(id)
  if (loaded) politicianNameCache.value = { ...politicianNameCache.value, [id]: loaded.name }
}
watch(questions, (list) => {
  const missing = new Set(list.map(q => q.politicianId).filter((id): id is string => !!id && !politicianNameOf(id)))
  missing.forEach(ensurePoliticianName)
  const missingPolicies = new Set(list.map(q => q.policyId).filter((id): id is string => !!id && !policyTitleOf(id)))
  missingPolicies.forEach(ensurePolicyTitle)
})
// 網址帶 ?policy=<id> 進來時，那一筆不一定在問題清單裡（例如還沒有人問過），單獨補
watch(policyFilter, (id) => { if (id) ensurePolicyTitle(id) }, { immediate: true })

const filteredQuestions = computed(() => {
  let list = questions.value
  if (globalRegion.value !== 'All') list = list.filter(q => q.region === globalRegion.value)
  if (policyFilter.value) list = list.filter(q => q.policyId === policyFilter.value)
  if (statusFilter.value !== 'all') list = list.filter(q => q.status === statusFilter.value)

  list = [...list]
  if (sortMode.value === 'stance') {
    list.sort((a, b) => (b.stanceUp + b.stanceDown) - (a.stanceUp + a.stanceDown) || b.createdAt.localeCompare(a.createdAt))
  } else {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  return list
})

// 展開／表態：以題目 id 為 key，各自獨立
const expandedIds = ref<Set<string>>(new Set())
function toggleQuestion(id: string) {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else {
    next.add(id)
    loadAnswers(id)
  }
  expandedIds.value = next
}

const LS_STANCE_KEY = 'zhengjian_question_stances'
const votedStances = ref<Record<string, Stance>>({})
onMounted(() => {
  try {
    const stored = localStorage.getItem(LS_STANCE_KEY)
    if (stored) votedStances.value = JSON.parse(stored)
  } catch { /* ignore */ }
})

const voteBusyIds = ref<Set<string>>(new Set())
const voteErrors = ref<Record<string, string>>({})

async function castVote(id: string, stance: Stance) {
  // 伺服器端同一題同一個 IP 是覆蓋（upsert）而不是報錯，所以按錯了要能改回來；
  // 只擋「重複送出同一個表態」與送出中的狀態。
  if (voteBusyIds.value.has(id) || votedStances.value[id] === stance) return
  voteBusyIds.value = new Set(voteBusyIds.value).add(id)
  voteErrors.value = { ...voteErrors.value, [id]: '' }
  try {
    const result = await voteStance(id, stance)
    applyStanceResult(id, result.stanceUp, result.stanceDown)
    votedStances.value = { ...votedStances.value, [id]: stance }
    localStorage.setItem(LS_STANCE_KEY, JSON.stringify(votedStances.value))
  } catch (err) {
    voteErrors.value = { ...voteErrors.value, [id]: err instanceof Error ? err.message : '表態失敗，請稍後再試' }
  } finally {
    const next = new Set(voteBusyIds.value)
    next.delete(id)
    voteBusyIds.value = next
  }
}

// 提問成功：重新整理列表，讓新題目馬上出現
function onAsked(_result: AskQuestionResult) {
  loadQuestions()
}

usePageHead({
  title: '公民提問',
  description: '對政見或政治人物有疑問？提出你的問題，AI 代理會去查有出處的資料來回答，多個代理的答案並陳，讓你自己比對判斷。',
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero background-image="/images/heroes/community.png">
      <template #title>公民提問</template>
      <template #description>提出你關心的問題，AI 代理會去查有出處的資料來回答——同一題可能有好幾個代理各自作答，答案並排列出，讓你自己比對判斷，而不是由誰說了算。看到有人宣布參選、或報導提到新政見，也可以直接把網址貼進來：AI 會去讀那個網址，把查得到的寫進資料庫。</template>
      <template #icon><MessageCircleQuestion :size="400" class="text-blue-500" /></template>

      <template #actions>
        <MechanismNav current="community" />
      </template>

      <GlobalRegionSelector />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-left">
      <AskQuestionForm :preset-policy-id="policyFilter || undefined" :preset-policy-title="policyFilterTitle" :preset-question="presetQuestion" class="mb-8" @asked="onAsked" />

      <div v-if="policyFilter" class="bg-blue-50 text-blue-700 px-4 py-2 rounded-lg flex items-center justify-between max-w-xl mb-6">
        <span>只看這項政見的提問：<strong>{{ policyFilterTitle || '（政見）' }}</strong></span>
        <button @click="policyFilter = ''" class="text-sm underline hover:text-blue-900 flex-shrink-0 ml-3">清除</button>
      </div>

      <div v-if="questionsError" class="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-6 flex items-center justify-between gap-4">
        <span>{{ questionsError }}</span>
        <button @click="loadQuestions" class="text-sm underline font-bold flex-shrink-0">重新整理</button>
      </div>

      <div class="flex flex-wrap items-center gap-4 bg-slate-100 p-2 rounded-xl mb-8">
        <div class="flex flex-wrap items-center gap-2">
          <button v-for="opt in STATUS_OPTIONS" :key="opt.key" @click="statusFilter = opt.key" :class="chipClass(statusFilter === opt.key)">{{ opt.label }}</button>
        </div>
        <div class="w-px h-6 bg-slate-300 hidden sm:block"></div>
        <div class="flex flex-wrap items-center gap-2 sm:ml-auto">
          <button v-for="opt in SORT_OPTIONS" :key="opt.key" @click="sortMode = opt.key" :class="chipClass(sortMode === opt.key)">{{ opt.label }}</button>
        </div>
      </div>

      <div v-if="loadingQuestions && questions.length === 0" class="text-center py-20 text-slate-400">
        <Loader2 :size="32" class="mx-auto mb-3 animate-spin" />
        <p>讀取提問中…</p>
      </div>

      <div v-else-if="filteredQuestions.length === 0" class="text-center py-20 text-slate-400 bg-white rounded-xl border border-dashed border-slate-300">
        <MessageCircleQuestion :size="48" class="mx-auto mb-4 opacity-40" />
        <p class="text-lg font-bold text-slate-500">{{ questions.length === 0 ? '目前還沒有人提問' : '這個篩選條件下還沒有提問' }}</p>
        <p class="text-sm mt-1">在上面留下你的問題，AI 代理很快就會來查證回答。</p>
      </div>

      <div v-else class="space-y-4">
        <CitizenQuestionCard
          v-for="q in filteredQuestions"
          :key="q.id"
          :question="q"
          :policy-title="policyTitleOf(q.policyId)"
          :politician-name="politicianNameOf(q.politicianId)"
          :expanded="expandedIds.has(q.id)"
          :answers="answersByQuestion[q.id]"
          :voted-stance="votedStances[q.id]"
          :vote-busy="voteBusyIds.has(q.id)"
          :vote-error="voteErrors[q.id]"
          @toggle="toggleQuestion"
          @vote="castVote"
        />
      </div>
    </div>
  </div>
</template>
