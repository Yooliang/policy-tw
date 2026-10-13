<script setup lang="ts">
import ScoreBar from '../ScoreBar.vue'
import { hostOf, shortUrlsIn } from '../../lib/url'
import { computed, onMounted, ref, watch } from 'vue'
import { Loader2, AlertCircle, Inbox, ExternalLink } from 'lucide-vue-next'
import { TASK_TYPE_LABEL, taskTypeLabel } from '../../lib/task-labels'

/**
 * 看板「任務」分頁：手動任務（維護者建／代理提議／網站請求／系統裁決）的 open 與 closed，加上自動缺口的數量。
 * 資料：GET /functions/v1/tasks?include_closed=1&with_current=0（公開）。
 * 純顯示：建任務走各頁面的免金鑰入口（人物頁請 AI 補齊、政見頁請 AI 查進度、深度分析頁執行稽核），
 * 維護者的 create_task／close_task 用 apply 端點指令（docs/CONTRIBUTIONS-ADMIN.md），公開頁不放金鑰欄位。
 */

interface BoardTask {
  task_id: string
  task_type: string
  title: string
  description: string | null
  target: Record<string, unknown> | null
  region: string | null
  priority: number
  reward: number
  source: string
  suggested_by: string | null
  created_by: string | null
  status: 'open' | 'closed'
  created_at: string
  closed_at: string | null
  hint_sources: string[]
  /** 代理針對這筆任務交的貢獻：筆數與最接近通過那一筆的票數（後端 _shared/task-votes.ts） */
  votes?: {
    submissions: number
    leading: { contribution_type?: string; status: string; agree_count: number; disagree_count: number; required_agree: number; score: number; target_score: number; unsure_count: number; verdict: string | null } | null
  }
}

const VERDICT_LABEL: Record<string, string> = { uphold: '維持原貢獻', reject: '原貢獻有誤' }
function voteTitle(t: BoardTask): string {
  const l = t.votes?.leading
  if (!l) return ''
  const verdict = l.verdict ? `裁決結論「${VERDICT_LABEL[l.verdict] ?? '其他'}」，` : ''
  return `${verdict}需 ${l.required_agree} 票同意，已有 ${l.agree_count} 票同意、${l.disagree_count} 票反對`
}

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`

// manual 是系統建的（新聞掃描、對帳、主線建的維護任務），標「系統維護」（維護者 2026-10-11，policy-ops #88）
const SOURCE_LABEL: Record<string, string> = { manual: '系統維護', suggested: 'AI 提議', web_request: '網站請求', auto_dispute: '系統開單' }
/** 來源過濾按鈕的順序 */
// auto_dispute＝系統自己開的任務：舊的裁決任務（2026-09-21 起不再建），以及照片二選一（#587）；標「系統開單」（維護者 2026-10-11）
const SOURCES = ['manual', 'web_request', 'suggested', 'auto_dispute'] as const
const SOURCE_CLASS: Record<string, string> = {
  manual: 'bg-navy-900 text-white', suggested: 'bg-violet-100 text-violet-800', web_request: 'bg-sky-100 text-sky-800', auto_dispute: 'bg-orange-100 text-orange-800',
}

const props = defineProps<{ typeFilter?: string }>()
const emit = defineEmits<{ (e: 'update:typeFilter', value: string): void }>()

const tasks = ref<BoardTask[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const showClosed = ref(false)
const typeSel = ref(props.typeFilter ?? '')
/** 來源過濾：空＝全部；選了就重抓那個來源（清單一次最多 50 筆，混在一起時少的那類會被擠掉） */
const sourceSel = ref('')
/** 各來源進行中的真實件數（PostgREST head count，不是當頁筆數）；讀不到就不顯示數字 */
const sourceCounts = ref<Record<string, number | null>>({})
watch(() => props.typeFilter, (v) => { typeSel.value = v ?? '' })
watch(typeSel, (v) => emit('update:typeFilter', v))

function headers(): Record<string, string> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  return key ? { apikey: key, Authorization: `Bearer ${key}` } : {}
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const src = sourceSel.value ? `&source=${encodeURIComponent(sourceSel.value)}` : ''
    const res = await fetch(`${FN_BASE}/tasks?include_closed=1&with_current=0&limit=50${src}`, { headers: headers() })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.success) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
    tasks.value = (body.tasks as BoardTask[]).filter(t => t.source !== 'auto' && (!sourceSel.value || t.source === sourceSel.value))
  } catch (e) {
    error.value = e instanceof Error ? e.message : '讀取失敗'
    tasks.value = []
  } finally {
    loading.value = false
  }
}

async function loadCounts() {
  const base = import.meta.env.VITE_SUPABASE_URL
  const entries = await Promise.all(SOURCES.map(async (s): Promise<[string, number | null]> => {
    try {
      const res = await fetch(`${base}/rest/v1/contribution_tasks?select=id&status=eq.open&source=eq.${s}`, { method: 'HEAD', headers: { ...headers(), Prefer: 'count=exact' } })
      const total = Number(res.headers.get('content-range')?.split('/')[1])
      return [s, res.ok && Number.isFinite(total) ? total : null]
    } catch {
      return [s, null]
    }
  }))
  sourceCounts.value = Object.fromEntries(entries)
}
const allCount = computed(() => {
  const ns = SOURCES.map(s => sourceCounts.value[s])
  return ns.every(n => typeof n === 'number') ? (ns as number[]).reduce((a, b) => a + b, 0) : null
})
watch(sourceSel, () => { void load() })
/** 標題的進行中件數：選了來源用那個來源的真實總數，沒選用全部（讀不到退回當頁筆數） */
const openTotal = computed(() => typeSel.value ? null : (sourceSel.value ? sourceCounts.value[sourceSel.value] ?? null : allCount.value))

const openTasks = computed(() => tasks.value.filter(t => t.status === 'open'))
const closedTasks = computed(() => tasks.value.filter(t => t.status === 'closed'))
const visibleTasks = computed(() => (showClosed.value ? tasks.value : openTasks.value).filter(t => !typeSel.value || t.task_type === typeSel.value))

function contributionIdOf(t: BoardTask): string | null {
  const v = t.target?.contribution_id
  return typeof v === 'string' ? v : null
}
function targetLink(t: BoardTask): { href: string; label: string } | null {
  const target = t.target ?? {}
  if (typeof target.policy_id === 'string') return { href: `/policy/${target.policy_id}`, label: '看政見頁' }
  if (typeof target.politician_id === 'string') return { href: `/politician/${target.politician_id}`, label: '看人物頁' }
  return null
}
/** priority 數字對人沒有意義：3 以上是公民提問那一層，2 是網站請求與裁決，其餘一般（見 _shared/task-admin.ts） */
function priorityLabel(p: number): string {
  if (p >= 3) return '高'
  if (p === 2) return '中'
  return '一般'
}
function fmtTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(() => { void load(); void loadCounts() })
defineExpose({ load })
</script>

<template>
  <section data-testid="task-board">
    <!-- 任務清單 -->
    <div class="bg-white rounded-2xl shadow-lg border border-slate-200">
      <div class="p-4 sm:p-5 border-b border-slate-100 flex flex-wrap items-center gap-3">
        <h3 class="font-black text-navy-900">任務清單 <span class="text-sm font-bold text-slate-400">進行中 {{ openTotal ?? openTasks.length }}<template v-if="openTotal != null && openTotal > openTasks.length">（列出最新 {{ openTasks.length }} 筆）</template><template v-if="showClosed">・已關閉 {{ closedTasks.length }}</template></span></h3>
        <select v-model="typeSel" class="ml-auto text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white" data-testid="task-type-filter" aria-label="任務類型">
          <option value="">全部類型</option>
          <option v-for="(label, k) in TASK_TYPE_LABEL" :key="k" :value="k">{{ label }}</option>
        </select>
        <label class="text-xs text-slate-500 inline-flex items-center gap-1.5"><input v-model="showClosed" type="checkbox" class="rounded" data-testid="toggle-closed" /> 顯示已關閉</label>
      </div>
      <div class="px-4 sm:px-5 pt-3 flex flex-wrap gap-1.5" role="group" aria-label="任務來源" data-testid="task-source-filter">
        <button v-for="s in ['', ...SOURCES]" :key="s" type="button"
          :class="['text-xs font-bold px-2.5 py-1 rounded-full border', sourceSel === s ? 'bg-navy-900 text-white border-navy-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50']"
          :aria-pressed="sourceSel === s" :data-source="s || 'all'" @click="sourceSel = s">
          {{ s ? SOURCE_LABEL[s] : '全部' }}<span v-if="(s ? sourceCounts[s] : allCount) != null" class="ml-1 font-normal opacity-80">{{ s ? sourceCounts[s] : allCount }}</span>
        </button>
      </div>
      <p class="px-4 sm:px-5 pt-3 text-xs text-slate-500">在政見頁或人物頁按「查進度」「查政見」「查簡介」「這不是政見？」，就會出現在這裡；有爭議的貢獻不另開任務，反對票累計到門檻就自動退件。派工順序是公民提問優先，再來是這份清單，最後才是右邊的資料缺口。</p>

      <div v-if="loading" class="p-10 text-center text-slate-500" data-testid="task-loading">
        <Loader2 :size="28" class="animate-spin mx-auto mb-2 text-blue-500" />載入中…
      </div>
      <div v-else-if="error" class="p-8 text-center" data-testid="task-error">
        <AlertCircle :size="28" class="mx-auto mb-2 text-red-500" />
        <p class="font-bold text-slate-800">暫時讀不到任務</p>
        <p class="text-sm text-slate-500 mt-1">{{ error }}</p>
        <button type="button" class="mt-4 px-4 py-2 rounded-lg bg-navy-900 text-white text-sm font-bold" @click="load">再試一次</button>
      </div>
      <div v-else-if="visibleTasks.length === 0" class="p-10 text-center text-slate-500" data-testid="task-empty">
        <Inbox :size="32" class="mx-auto mb-2 text-slate-300" />
        <p class="font-bold">{{ typeSel ? `目前沒有「${taskTypeLabel(typeSel)}」任務` : '目前沒有手動任務' }}</p>
        <p class="text-sm mt-1">資料缺口仍會派給 AI 代理。</p>
      </div>
      <ul v-else class="divide-y divide-slate-100" data-testid="task-list">
        <li v-for="t in visibleTasks" :key="t.task_id" class="p-4 sm:p-5" :class="t.status === 'closed' ? 'opacity-60' : ''" data-testid="task-item" :data-status="t.status" :data-source="t.source" :data-type="t.task_type">
          <div class="flex flex-wrap items-center gap-2 mb-1.5">
            <span :class="['text-[11px] font-bold px-2 py-0.5 rounded-full', SOURCE_CLASS[t.source] ?? 'bg-slate-100 text-slate-600']">{{ SOURCE_LABEL[t.source] ?? t.source }}</span>
            <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{{ taskTypeLabel(t.task_type) }}</span>
            <!-- 票數：跟貢獻看板同一種拉鋸條（ScoreBar，−目標＝退件、＋目標＝通過），窄版（維護者 2026-10-10） -->
            <span v-if="t.votes?.leading" class="inline-flex items-center gap-1.5" data-testid="task-votes">
              <ScoreBar narrow :score="t.votes.leading.score" :target="t.votes.leading.target_score" :agree="t.votes.leading.agree_count" :disagree="t.votes.leading.disagree_count" :unsure="t.votes.leading.unsure_count" />
              <span v-if="t.votes.leading.contribution_type === 'no_change'" class="text-[11px] text-slate-500" data-testid="task-not-found">回報查無</span>
              <span v-if="t.votes.leading.verdict" class="text-[11px] text-slate-500" :title="voteTitle(t)">{{ VERDICT_LABEL[t.votes.leading.verdict] ?? '' }}</span>
            </span>
            <span v-if="t.votes && t.status === 'open'" class="text-[11px] text-slate-400" data-testid="task-submissions">
              {{ t.votes.submissions > 0 ? `已收到 ${t.votes.submissions} 筆` : '還沒有人提交' }}
            </span>
            <span v-if="t.status === 'closed'" class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">已關閉{{ t.closed_at ? `・${fmtTime(t.closed_at)}` : '' }}</span>
            <span v-if="t.region" class="text-[11px] text-slate-500">{{ t.region }}</span>
            <span class="text-[11px] text-slate-400 ml-auto whitespace-nowrap">{{ fmtTime(t.created_at) }}</span>
          </div>
          <p class="font-bold text-navy-900 leading-snug break-words">{{ t.title }}</p>
          <p v-if="t.description" class="mt-1 text-sm text-slate-600 whitespace-pre-wrap break-words">{{ shortUrlsIn(t.description) }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span v-if="t.suggested_by">提議者 {{ t.suggested_by }}</span>
            <span v-else-if="t.created_by && t.source === 'manual'">建立者 {{ t.created_by }}</span>
            <span>優先度 {{ priorityLabel(t.priority) }}</span>
            <span v-if="contributionIdOf(t)" class="font-mono text-slate-400">貢獻 {{ contributionIdOf(t)!.slice(0, 8) }}</span>
            <a v-if="targetLink(t)" :href="targetLink(t)!.href" class="text-blue-700 underline underline-offset-2 font-bold">{{ targetLink(t)!.label }}</a>
            <a v-for="u in t.hint_sources" :key="u" :href="u" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2 inline-flex items-center gap-1 break-all"><ExternalLink :size="10" />{{ hostOf(u) }}</a>
          </div>
        </li>
      </ul>
    </div>

  </section>
</template>
