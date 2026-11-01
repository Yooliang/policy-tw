<script setup lang="ts">
/**
 * 議題串聯（只認縣市）：首屏是議題清單（議題名＋總數＋各層級小計），點開議題才載第一頁 30 筆，
 * 捲到底載下一頁，可依層級篩選。資料來自資料庫函式 issues_summary／issues_page，不撈整個縣市的參選人與政見。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { AlertCircle, ChevronDown, Hash, Loader2 } from 'lucide-vue-next'
import Avatar from '../../components/Avatar.vue'
import LoadError from '../../components/LoadError.vue'
import { loadIssuePage, loadIssueSummary } from '../../composables/useIssuesStack'
import { appendCards, hasMore, levelCounts, type IssueCard, type IssueLevel, type IssueSummary } from '../../lib/issues-stack'

const props = defineProps<{ electionId: number; region: string }>()
const emit = defineEmits<{ select: [issue: string] }>()

const summary = ref<IssueSummary[]>([])
const summaryLoading = ref(false)
const summaryFailed = ref(false)
const openIssue = ref('')
const level = ref<IssueLevel | null>(null)
const cards = ref<IssueCard[]>([])
const total = ref(0)
const pageLoading = ref(false)
const pageFailed = ref(false)
let seq = 0 // 換議題／層級／縣市後，舊請求的回應不能蓋掉新的

const LEVEL_STYLE: Record<IssueLevel, { border: string; badge: string }> = {
  '縣市長': { border: 'border-red-400', badge: 'bg-red-100 text-red-700' },
  '議員': { border: 'border-blue-400', badge: 'bg-blue-100 text-blue-700' },
  '鄉鎮市區長': { border: 'border-indigo-400', badge: 'bg-indigo-100 text-indigo-700' },
  '代表': { border: 'border-green-400', badge: 'bg-green-100 text-green-700' },
  '村里長': { border: 'border-amber-400', badge: 'bg-amber-100 text-amber-700' },
}

const current = computed(() => summary.value.find((s) => s.issue === openIssue.value))
const filterLevels = computed(() => (current.value ? levelCounts(current.value) : []))
const more = computed(() => hasMore(cards.value.length, total.value))

async function loadSummary() {
  const mine = ++seq
  summaryLoading.value = true
  summaryFailed.value = false
  summary.value = []
  openIssue.value = ''
  cards.value = []
  try {
    const rows = await loadIssueSummary(props.electionId, props.region)
    if (mine !== seq) return
    summary.value = rows
  } catch {
    if (mine === seq) summaryFailed.value = true
  } finally {
    if (mine === seq) summaryLoading.value = false
  }
}

async function loadFirstPage() {
  const mine = ++seq
  cards.value = []
  total.value = 0
  pageFailed.value = false
  if (!openIssue.value) return
  pageLoading.value = true
  try {
    const r = await loadIssuePage(props.electionId, props.region, openIssue.value, level.value, 0)
    if (mine !== seq) return
    cards.value = r.cards
    total.value = r.total
  } catch {
    if (mine === seq) pageFailed.value = true
  } finally {
    if (mine === seq) pageLoading.value = false
  }
  void nextTick(observeSentinel)
}

async function loadNextPage() {
  if (pageLoading.value || !more.value || !openIssue.value) return
  const mine = seq
  pageLoading.value = true
  pageFailed.value = false
  try {
    const r = await loadIssuePage(props.electionId, props.region, openIssue.value, level.value, cards.value.length)
    if (mine !== seq) return
    if (r.cards.length === 0) total.value = cards.value.length // 後端沒有更多了，免得無限觸發
    cards.value = appendCards(cards.value, r.cards)
  } catch {
    if (mine === seq) pageFailed.value = true
  } finally {
    if (mine === seq) pageLoading.value = false
  }
  void nextTick(observeSentinel)
}

function toggle(issue: string) {
  openIssue.value = openIssue.value === issue ? '' : issue
  level.value = null
  if (openIssue.value) emit('select', issue)
  void loadFirstPage()
}
function pickLevel(lv: IssueLevel | null) {
  level.value = lv
  void loadFirstPage()
}

// 捲到底自動載下一頁
const sentinel = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null
function observeSentinel() {
  io?.disconnect()
  if (typeof IntersectionObserver === 'undefined' || !sentinel.value) return
  io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) void loadNextPage() }, { rootMargin: '300px 0px' })
  io.observe(sentinel.value)
}
watch(sentinel, () => { void nextTick(observeSentinel) })
onBeforeUnmount(() => { io?.disconnect(); seq++ })

watch(() => [props.electionId, props.region] as const, () => { void loadSummary() }, { immediate: true })
</script>

<template>
  <div data-testid="issues-stack">
    <LoadError v-if="summaryFailed" inline message="議題清單載入不了" @retry="loadSummary" />
    <div v-else-if="summaryLoading" class="flex justify-center py-16 text-slate-400" data-testid="issues-loading"><Loader2 :size="28" class="animate-spin" /></div>
    <div v-else-if="summary.length === 0" class="text-center py-20 text-slate-400 bg-white border border-dashed border-slate-200 rounded-xl" data-testid="issues-empty">
      <AlertCircle :size="48" class="mx-auto mb-4 opacity-50" />
      <p class="font-bold">尚無資料</p>
    </div>
    <ul v-else class="space-y-3">
      <li v-for="s in summary" :key="s.issue" class="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden" :data-testid="`issue-${s.issue}`">
        <button
          type="button"
          class="w-full text-left px-4 py-3 md:px-6 md:py-4 flex items-start gap-3 hover:bg-slate-50"
          :aria-expanded="openIssue === s.issue"
          @click="toggle(s.issue)"
        >
          <Hash :size="18" class="mt-0.5 text-slate-400 shrink-0" />
          <span class="flex-1 min-w-0">
            <span class="flex items-center gap-2 flex-wrap">
              <span class="text-base md:text-lg font-bold text-navy-900">{{ s.issue }}</span>
              <span class="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs font-bold">{{ s.total }}</span>
            </span>
            <span class="mt-1.5 flex flex-wrap gap-1.5">
              <span v-for="lc in levelCounts(s)" :key="lc.level" :class="`px-2 py-0.5 rounded-full text-[11px] font-bold ${LEVEL_STYLE[lc.level].badge}`">{{ lc.level }} {{ lc.count }}</span>
            </span>
          </span>
          <ChevronDown :size="20" :class="`mt-1 text-slate-400 shrink-0 transition-transform ${openIssue === s.issue ? 'rotate-180' : ''}`" />
        </button>

        <div v-if="openIssue === s.issue" class="border-t border-slate-100 px-4 py-4 md:px-6">
          <div v-if="filterLevels.length > 1" class="flex flex-wrap gap-2 mb-4" data-testid="issue-level-filter">
            <button
              type="button"
              :aria-pressed="level === null"
              :class="`px-3 py-1.5 rounded-full text-xs font-bold border ${level === null ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}`"
              @click="pickLevel(null)"
            >全部 {{ s.total }}</button>
            <button
              v-for="lc in filterLevels"
              :key="lc.level"
              type="button"
              :aria-pressed="level === lc.level"
              :class="`px-3 py-1.5 rounded-full text-xs font-bold border ${level === lc.level ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}`"
              @click="pickLevel(lc.level)"
            >{{ lc.level }} {{ lc.count }}</button>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 items-start content-start">
            <router-link
              v-for="c in cards"
              :key="c.policyId"
              :to="`/policy/${c.policyId}`"
              :class="`block bg-white border-l-4 ${LEVEL_STYLE[c.level].border} shadow-sm border-y border-r border-slate-100 p-4 rounded-r-lg hover:shadow-md transition-all`"
            >
              <div class="flex items-center gap-2 mb-2">
                <Avatar :src="c.avatarUrl" :name="c.name" size="xs" />
                <span class="text-sm font-bold text-navy-900 truncate">{{ c.name }}</span>
                <span v-if="c.candNo" class="text-xs text-slate-400 shrink-0">{{ c.candNo }} 號</span>
                <span :class="`ml-auto shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold ${LEVEL_STYLE[c.level].badge}`">{{ c.level }}</span>
              </div>
              <h4 class="font-bold text-sm text-navy-900 line-clamp-2">{{ c.title }}</h4>
              <p v-if="c.party" class="mt-1 text-xs text-slate-400">{{ c.party }}</p>
            </router-link>
          </div>

          <LoadError v-if="pageFailed" inline message="政見載入不了" class="mt-4" @retry="cards.length ? loadNextPage() : loadFirstPage()" />
          <div v-if="pageLoading" class="flex justify-center py-6 text-slate-400"><Loader2 :size="22" class="animate-spin" /></div>
          <div v-else-if="cards.length === 0 && !pageFailed" class="py-8 text-center text-sm font-bold text-slate-400">尚無資料</div>
          <div v-if="more" ref="sentinel" class="h-8" aria-hidden="true" />
          <button v-if="more && !pageLoading && !pageFailed" type="button" class="mx-auto mt-2 block rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50" @click="loadNextPage">載入更多</button>
        </div>
      </li>
    </ul>
  </div>
</template>
