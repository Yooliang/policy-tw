<script setup lang="ts">
/**
 * 議題串聯（只認縣市）：上方一排議題分類 chip、下方是該議題的各級垂直串聯（縣市長 → 議員 → 鄉鎮市區長 → 代表 → 村里長）。
 * 資料來自資料庫函式 issues_summary／issues_page：chip 與各層筆數取自 summary，選了議題一次取回該縣市該議題的全部承諾（不分頁），
 * 不撈整個縣市的參選人與政見。
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { AlertCircle, ArrowDown, Hash, Loader2 } from 'lucide-vue-next'
import Avatar from '../../components/Avatar.vue'
import LoadError from '../../components/LoadError.vue'
import { loadIssuePage, loadIssueSummary } from '../../composables/useIssuesStack'
import { ISSUE_FETCH_LIMIT, type IssueCard, type IssueLevel, type IssueSummary } from '../../lib/issues-stack'

const props = defineProps<{ electionId: number; region: string }>()
const emit = defineEmits<{ select: [issue: string] }>()

const summary = ref<IssueSummary[]>([])
const summaryLoading = ref(false)
const summaryFailed = ref(false)
const tag = ref('')
let seq = 0 // 換議題／縣市後，舊請求的回應不能蓋掉新的

const cards = ref<IssueCard[]>([])
const pageLoading = ref(false)
const pageFailed = ref(false)
let pageSeq = 0
const cardsOf = (lv: IssueLevel) => cards.value.filter((c) => c.level === lv)

const LEVELS: Array<{ key: IssueLevel; label: string; border: string; bg: string; emptyMsg: string }> = [
  { key: '縣市長', label: '縣市長', border: 'border-red-400', bg: 'bg-red-100 text-red-700', emptyMsg: '縣市長層級尚未針對此議題表態。' },
  { key: '議員', label: '議員', border: 'border-blue-400', bg: 'bg-blue-100 text-blue-700', emptyMsg: '尚無議員針對此議題提出質詢或預算案。' },
  { key: '鄉鎮市區長', label: '鄉長/區長', border: 'border-indigo-400', bg: 'bg-indigo-100 text-indigo-700', emptyMsg: '尚無行政首長層級的規劃。' },
  { key: '代表', label: '代表', border: 'border-green-400', bg: 'bg-green-100 text-green-700', emptyMsg: '尚無地方代表層級的具體建議。' },
  { key: '村里長', label: '里長', border: 'border-amber-400', bg: 'bg-amber-100 text-amber-700', emptyMsg: '尚無里長層級的具體建議。' },
]

const tags = computed(() => [...summary.value].sort((a, b) => b.total - a.total))

// 單一議題在單一縣市最多幾十筆（實測最多 35），一次取回全部（資料庫函式單次上限 100）
async function loadTag() {
  const mine = ++pageSeq
  cards.value = []
  pageFailed.value = false
  if (!tag.value) return
  pageLoading.value = true
  try {
    const r = await loadIssuePage(props.electionId, props.region, tag.value, null, 0, ISSUE_FETCH_LIMIT)
    if (mine === pageSeq) cards.value = r.cards
  } catch {
    if (mine === pageSeq) pageFailed.value = true
  } finally {
    if (mine === pageSeq) pageLoading.value = false
  }
}

function pick(issue: string) {
  tag.value = issue
  if (issue) emit('select', issue)
  void loadTag()
}

async function loadSummary() {
  const mine = ++seq
  summaryLoading.value = true
  summaryFailed.value = false
  summary.value = []
  tag.value = ''
  cards.value = []
  try {
    const rows = await loadIssueSummary(props.electionId, props.region)
    if (mine !== seq) return
    summary.value = rows
    pick(tags.value[0]?.issue ?? '')
  } catch {
    if (mine === seq) summaryFailed.value = true
  } finally {
    if (mine === seq) summaryLoading.value = false
  }
}

onBeforeUnmount(() => { seq++; pageSeq++ })
watch(() => [props.electionId, props.region] as const, () => { void loadSummary() }, { immediate: true })
</script>

<template>
  <div data-testid="issues-stack">
    <LoadError v-if="summaryFailed" inline message="議題清單載入不了" @retry="loadSummary" />
    <div v-else-if="summaryLoading" class="flex justify-center py-16 text-slate-400" data-testid="issues-loading"><Loader2 :size="28" class="animate-spin" /></div>
    <div v-else-if="tags.length === 0" class="text-center py-20 text-slate-400 bg-white border border-dashed border-slate-200 rounded-xl" data-testid="issues-empty">
      <AlertCircle :size="48" class="mx-auto mb-4 opacity-50" />
      <p class="font-bold">尚無資料</p>
    </div>
    <div v-else class="space-y-6">
      <div class="flex flex-wrap items-center gap-2 mb-2" data-testid="issue-tags">
        <button
          v-for="s in tags"
          :key="s.issue"
          type="button"
          :class="`px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all border flex items-center gap-1 ${tag === s.issue ? 'bg-blue-600 text-white border-blue-600 shadow-md' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`"
          @click="pick(s.issue)"
        >
          <Hash :size="12" /> {{ s.issue }}
        </button>
      </div>

      <div v-if="tag" class="border border-slate-200 rounded-2xl bg-white shadow-sm overflow-hidden animate-fade-in">
        <div class="bg-slate-50 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="text-2xl font-bold text-navy-900">#{{ tag }}</span>
            <span class="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs font-bold">議題垂直分析</span>
          </div>
        </div>

        <div class="p-6 flex flex-col gap-6 md:gap-0">
          <template v-for="(level, levelIdx) in LEVELS" :key="level.key">
            <div class="flex flex-col md:flex-row gap-4 md:gap-5">
              <div class="relative w-full md:w-9 shrink-0 flex flex-col items-center justify-center md:self-stretch">
                <span :class="`${level.bg} px-3 py-1 rounded-full text-xs font-bold block w-full text-center md:px-0 md:py-2 md:absolute md:inset-0 md:overflow-hidden md:flex md:items-center md:justify-center md:text-xs md:tracking-normal md:[writing-mode:vertical-rl] md:[text-orientation:upright] ${levelIdx === 0 ? 'md:rounded-b-none' : levelIdx === LEVELS.length - 1 ? 'md:rounded-t-none' : 'md:rounded-none'}`">{{ level.label }}</span>
                <div v-if="levelIdx > 0" class="hidden md:flex absolute -top-3 left-1/2 -translate-x-1/2 z-10 w-6 h-6 rounded-full bg-white shadow ring-1 ring-slate-200 items-center justify-center text-slate-500"><ArrowDown :size="14" /></div>
              </div>
              <div class="flex-1 min-w-0 md:py-3" :data-testid="`level-${level.key}`">
                <div v-if="pageLoading" class="flex justify-center py-4 text-slate-400"><Loader2 :size="22" class="animate-spin" /></div>
                <LoadError v-else-if="pageFailed" inline message="政見載入不了" @retry="loadTag" />
                <div v-else-if="cardsOf(level.key).length === 0" class="text-slate-400 text-sm italic py-4">{{ level.emptyMsg }}</div>
                <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4 text-left items-start content-start">
                  <router-link
                    v-for="c in cardsOf(level.key)"
                    :key="c.policyId"
                    :to="`/policy/${c.policyId}`"
                    :class="`block bg-white border-l-4 ${level.border} shadow-sm border-y border-r border-slate-100 p-4 rounded-r-lg hover:shadow-md cursor-pointer transition-all`"
                  >
                    <div class="flex items-center gap-2 mb-2">
                      <Avatar :src="c.avatarUrl" :name="c.name" size="xs" />
                      <span class="text-sm font-bold text-navy-900">{{ c.name }}</span>
                    </div>
                    <h4 class="font-bold text-sm text-navy-900 line-clamp-2">{{ c.title }}</h4>
                  </router-link>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
