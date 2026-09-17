<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
const apexchart = defineAsyncComponent(() => import('vue3-apexcharts'))
import { Loader2, AlertCircle, Inbox, ExternalLink } from 'lucide-vue-next'
import { TASK_TYPE_LABEL, taskTypeLabel } from '../../lib/task-labels'
import GapTrendChart from './GapTrendChart.vue'

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
    leading: { status: string; agree_count: number; disagree_count: number; required_agree: number; verdict: string | null } | null
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

const SOURCE_LABEL: Record<string, string> = { manual: '維護者', suggested: 'AI 提議', web_request: '網站請求', auto_dispute: '系統（爭議）' }
const SOURCE_CLASS: Record<string, string> = {
  manual: 'bg-navy-900 text-white', suggested: 'bg-violet-100 text-violet-800', web_request: 'bg-sky-100 text-sky-800', auto_dispute: 'bg-orange-100 text-orange-800',
}

const props = defineProps<{ typeFilter?: string }>()
const emit = defineEmits<{ (e: 'update:typeFilter', value: string): void }>()

const tasks = ref<BoardTask[]>([])
const totals = ref<Record<string, number>>({})
const loading = ref(false)
const error = ref<string | null>(null)
const showClosed = ref(false)
const typeSel = ref(props.typeFilter ?? '')
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
    const res = await fetch(`${FN_BASE}/tasks?include_closed=1&with_current=0&limit=50`, { headers: headers() })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.success) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
    tasks.value = (body.tasks as BoardTask[]).filter(t => t.source !== 'auto')
    const { manual_open: _ignored, ...auto } = body.totals ?? {}
    totals.value = auto
  } catch (e) {
    error.value = e instanceof Error ? e.message : '讀取失敗'
    tasks.value = []
  } finally {
    loading.value = false
  }
}

const openTasks = computed(() => tasks.value.filter(t => t.status === 'open'))
const closedTasks = computed(() => tasks.value.filter(t => t.status === 'closed'))
const visibleTasks = computed(() => (showClosed.value ? tasks.value : openTasks.value).filter(t => !typeSel.value || t.task_type === typeSel.value))
const autoTotal = computed(() => Object.values(totals.value).reduce((a, n) => a + n, 0))

// 自動缺口：跟貢獻分頁的「近 7 日提交」同一種直條圖，多的排前面
const gapRows = computed(() => Object.entries(totals.value)
  .map(([type, count]) => ({ label: taskTypeLabel(type), count }))
  .sort((a, b) => b.count - a.count))
/**
 * 圓餅圖（2026-09-17 小良哥）：這裡要回答的是「缺口集中在哪一類」，比例比絕對值重要。
 * 缺口型別有十幾種，全部切成扇形會變成一圈看不懂的碎片，所以只畫前 6 大，
 * 其餘合併成「其他缺口」——跟下方的 24 小時趨勢圖用同一套取法。
 */
const GAP_TOP_N = 6
const GAP_COLORS = ['#2563eb', '#ea580c', '#059669', '#7c3aed', '#0891b2', '#eab308', '#94a3b8']
const gapPieRows = computed(() => {
  const rows = gapRows.value
  if (rows.length <= GAP_TOP_N + 1) return rows
  const head = rows.slice(0, GAP_TOP_N)
  const rest = rows.slice(GAP_TOP_N).reduce((sum, r) => sum + r.count, 0)
  return rest > 0 ? [...head, { label: '其他缺口', count: rest }] : head
})
const gapSeries = computed(() => gapPieRows.value.map(r => r.count))
const gapOptions = computed(() => ({
  chart: { type: 'pie' as const, toolbar: { show: false } },
  labels: gapPieRows.value.map(r => r.label),
  colors: GAP_COLORS,
  stroke: { width: 2, colors: ['#ffffff'] },
  // 扇形上只標百分比，件數留給圖例與提示框：小扇形塞兩個數字會疊在一起
  dataLabels: { enabled: true, formatter: (v: number) => (v >= 6 ? `${Math.round(v)}%` : ''), style: { fontSize: '11px', fontWeight: 700 }, dropShadow: { enabled: false } },
  legend: { position: 'bottom' as const, fontSize: '11px', fontWeight: 600, itemMargin: { horizontal: 6, vertical: 2 }, markers: { size: 6 } },
  tooltip: { y: { formatter: (v: number) => `${v} 件` } },
}))

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

onMounted(load)
defineExpose({ load })
</script>

<template>
  <section class="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start" data-testid="task-board">
    <!-- 資料缺口：手機上要在任務清單前面（2026-09-17 小良哥：不該捲一長串才看到），
         桌機用 col-start／row-start 指定回右欄 -->
    <aside class="lg:col-start-3 lg:row-start-1 lg:sticky lg:top-4">
      <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="gap-counts">
        <div class="flex items-baseline gap-2 mb-1">
          <h3 class="font-black text-navy-900">資料缺口</h3>
          <span class="ml-auto text-sm font-bold text-navy-900 whitespace-nowrap">共 {{ loading ? '–' : autoTotal }} 件</span>
        </div>
        <p class="text-xs text-slate-400 mb-2">自動偵測，依序派給 AI 代理</p>
        <p v-if="!loading && gapRows.length === 0" class="text-sm text-slate-400 py-6 text-center">目前沒有缺口</p>
        <div v-else class="h-72">
          <ClientOnly><apexchart v-if="gapRows.length > 0" type="pie" height="100%" :options="gapOptions" :series="gapSeries" /></ClientOnly>
        </div>
        <!-- 現在各有幾件（上面的直條）之外，也要看得出它們在變多還是變少 -->
        <GapTrendChart />
      </section>
    </aside>

    <!-- 任務清單 -->
    <div class="lg:col-span-2 lg:col-start-1 lg:row-start-1 bg-white rounded-2xl shadow-lg border border-slate-200">
      <div class="p-4 sm:p-5 border-b border-slate-100 flex flex-wrap items-center gap-3">
        <h3 class="font-black text-navy-900">任務清單 <span class="text-sm font-bold text-slate-400">進行中 {{ openTasks.length }}・已關閉 {{ closedTasks.length }}</span></h3>
        <select v-model="typeSel" class="ml-auto text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white" data-testid="task-type-filter" aria-label="任務類型">
          <option value="">全部類型</option>
          <option v-for="(label, k) in TASK_TYPE_LABEL" :key="k" :value="k">{{ label }}</option>
        </select>
        <label class="text-xs text-slate-500 inline-flex items-center gap-1.5"><input v-model="showClosed" type="checkbox" class="rounded" data-testid="toggle-closed" /> 顯示已關閉</label>
      </div>
      <p class="px-4 sm:px-5 pt-3 text-xs text-slate-500">在政見頁或人物頁按「查進度」「查政見」「查簡介」「這不是政見？」，就會出現在這裡；有爭議的貢獻會自動變成裁決任務。派工順序是公民提問優先，再來是這份清單，最後才是右邊的資料缺口。</p>

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
            <!-- 票數條：綠＝同意（格數＝需要的票數）、紅＝反對；跟貢獻清單同一種樣式 -->
            <span v-if="t.votes?.leading" class="inline-flex items-center gap-1.5" :title="voteTitle(t)" data-testid="task-votes">
              <span class="inline-flex items-center gap-px">
                <span v-for="n in t.votes.leading.required_agree" :key="`a${n}`" class="w-1 h-2.5 rounded-[1px]" :class="n <= t.votes.leading.agree_count ? 'bg-emerald-500' : 'bg-slate-200'"></span>
              </span>
              <span v-if="t.votes.leading.disagree_count > 0" class="inline-flex items-center gap-px">
                <span v-for="n in t.votes.leading.disagree_count" :key="`d${n}`" class="w-1 h-2.5 rounded-[1px] bg-red-500"></span>
              </span>
              <span v-if="t.votes.leading.verdict" class="text-[11px] text-slate-500">{{ VERDICT_LABEL[t.votes.leading.verdict] ?? '' }}</span>
            </span>
            <span v-if="t.votes && t.status === 'open'" class="text-[11px] text-slate-400" data-testid="task-submissions">
              {{ t.votes.submissions > 0 ? `已收到 ${t.votes.submissions} 筆` : '還沒有人提交' }}
            </span>
            <span v-if="t.status === 'closed'" class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">已關閉{{ t.closed_at ? `・${fmtTime(t.closed_at)}` : '' }}</span>
            <span v-if="t.region" class="text-[11px] text-slate-500">{{ t.region }}</span>
            <span class="text-[11px] text-slate-400 ml-auto whitespace-nowrap">{{ fmtTime(t.created_at) }}</span>
          </div>
          <p class="font-bold text-navy-900 leading-snug break-words">{{ t.title }}</p>
          <p v-if="t.description" class="mt-1 text-sm text-slate-600 whitespace-pre-wrap break-words">{{ t.description }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span v-if="t.suggested_by">提議者 {{ t.suggested_by }}</span>
            <span v-else-if="t.created_by && t.source === 'manual'">建立者 {{ t.created_by }}</span>
            <span>優先度 {{ priorityLabel(t.priority) }}</span>
            <span v-if="contributionIdOf(t)" class="font-mono text-slate-400">貢獻 {{ contributionIdOf(t)!.slice(0, 8) }}</span>
            <a v-if="targetLink(t)" :href="targetLink(t)!.href" class="text-blue-700 underline underline-offset-2 font-bold">{{ targetLink(t)!.label }}</a>
            <a v-for="u in t.hint_sources" :key="u" :href="u" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2 inline-flex items-center gap-1 break-all"><ExternalLink :size="10" />{{ u }}</a>
          </div>
        </li>
      </ul>
    </div>

  </section>
</template>
