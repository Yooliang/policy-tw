<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import { usePageHead } from '../composables/usePageHead'
import { taskTypeLabel } from '../lib/task-labels'
import Hero from '../components/Hero.vue'
import MechanismNav from '../components/MechanismNav.vue'
import BoardNav from '../components/contributions/BoardNav.vue'
import { ListOrdered } from 'lucide-vue-next'

// 派工佇列（2026-10-19，#684）：跟站務主控台隊列頁同一份資料，來源是 console_queue_state()（migration 20261017000201 起，anon 可執行、唯讀）。
// 隊頭前 60 名（任務與驗證票合併，照 /next 順序）；維護者：正式頁不自動重新整理，只有手動「重新整理」。
// 整頁照搬（維護者 10-19：提供透明度），只拿掉「隊頭第一筆可派」卡片；投太多輪區塊含各票代號與理由，函式本來就是 anon 可讀。
type Status = 'ready' | 'dead_end' | 'saturated' | 'question_full' | 'parked' | 'cooling' | 'blocked'
type HeadRow = { pos: number; kind?: 'task' | 'verify'; task_type: string; source: string; status: Status; subject: string; queue_at: string; dispatch_count: number; last_dispatched_at: string | null }
type OvervotedItem = { contribution_id?: string; contribution_type?: string; subject?: string; status?: string; votes?: number; stopped?: boolean; verdicts?: { verdict?: string; agent?: string; reason?: string }[] }
type Overvoted = { baseline?: number; flag_votes?: number; stop_votes?: number; total?: number; items?: OvervotedItem[] }
type State = {
  by_type: { task_type: string; source: string; status: Status; n: number }[]
  verify: { total: number; eligible: number; by_type: { contribution_type: string; n: number; eligible: number }[] }
  head: HeadRow[]
  first_ready_pos: number | null
  parked?: { task_id: string; task_type: string; source: string; subject: string; queue_at: string; inflight: number; verify_waiting: number }[]
  parked_total?: number
  overvoted?: Overvoted
  dispatched_24h: { task_type: string; kind: 'verify' | 'auto' | 'manual'; n: number }[]
  age_buckets: { never: number; lt_1h: number; h1_6: number; h6_24: number; d1_3: number; gt_3d: number }
}

const state = ref<State | null>(null)
const failed = ref(false)
const loading = ref(false)
const refreshedAt = ref<Date | null>(null)
const groupBy = ref<'type' | 'source'>('type')

usePageHead({ title: '派工佇列', description: '接下來 60 筆會被領走的順序', noindex: true })

async function load() {
  if (loading.value) return
  loading.value = true
  failed.value = false
  try {
    const { data } = await withTimeoutAndRetry('console queue state', (signal) =>
      supabasePublic.rpc('console_queue_state').abortSignal(signal).throwOnError())
    state.value = (data ?? null) as State | null
    refreshedAt.value = new Date()
  } catch (e) {
    console.info('[佇列] 讀取失敗', e)
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)

const STATUSES: { key: Status; label: string; bar: string }[] = [
  { key: 'ready', label: '可派', bar: '#22c55e' },
  { key: 'dead_end', label: '查無等票', bar: '#fbbf24' },
  { key: 'saturated', label: '額滿', bar: '#f97316' },
  { key: 'question_full', label: '提問滿額', bar: '#8b5cf6' },
  { key: 'parked', label: '停放中', bar: '#06b6d4' },
  { key: 'cooling', label: '冷卻', bar: '#64748b' },
  { key: 'blocked', label: '擋下', bar: '#ef4444' },
]
const STATUS = Object.fromEntries(STATUSES.map((s) => [s.key, s])) as Record<Status, (typeof STATUSES)[number]>
const SOURCE_LABEL: Record<string, string> = { auto: '自動缺口', suggested: 'AI 提議', web_request: '網站請求', manual: '維護者', auto_dispute: '裁決', verify: '驗證票' }
const AGE: { key: keyof State['age_buckets']; label: string }[] = [
  { key: 'never', label: '從沒派過' },
  { key: 'lt_1h', label: '1 小時內' },
  { key: 'h1_6', label: '1–6 小時' },
  { key: 'h6_24', label: '6–24 小時' },
  { key: 'd1_3', label: '1–3 天' },
  { key: 'gt_3d', label: '3 天以上' },
]

// 左邊框依型別上色：用 inline style，不走 Tailwind 動態 class（要 safelist）
const BORDER: Record<string, string> = {
  policy_missing: '#1d4ed8',            // 政見缺口：藍
  term_policy_missing: '#0369a1',       // 補任期政見：深天藍
  profile_detail_gap: '#0e7490',        // 補學經歷條列：青藍
  policy_election_missing: '#4338ca',   // 政見缺屆別：靛
  policy_election_mismatch: '#4338ca',
  profile_gap: '#d97706',               // 基本資料：琥珀
  policy_source_missing: '#ea580c',     // 缺來源：橘
  source_mismatch: '#92400e',           // 來源不符：褐
  progress_stale: '#16a34a',            // 進度過期：綠
  not_running_recheck: '#dc2626',       // 未登記複查：紅
  candidacy_source_missing: '#be123c',  // 參選缺來源：玫紅
  candidate_status_stale: '#be123c',
  election_result_missing: '#0f172a',   // 選舉結果：近黑
  election_results_missing: '#334155',  // 整批補選舉結果：深灰（同一族）
  candidacy_owner_mismatch: '#9f1239',  // 參選紀錄疑似掛錯人：深玫紅（參選那一族）
  roster_check: '#06b6d4',              // 名冊清查：青
  district_seats_missing: '#0891b2',    // 補應選名額：深青
  legacy_audit: '#64748b',              // 舊資料稽核：灰
  policy_validity: '#94a3b8',           // 是不是政見：淺灰
  duplicate_policy: '#a16207',          // 重複政見：暗黃
  duplicate_politician: '#78716c',      // 重複人物：石
  question: '#db2777',                  // 提問：粉
  policy_elements_missing: '#7c2d12',   // 政見三要素：赭
  lineage_candidate: '#0f766e',         // 政策脈絡：深青（同一族）
  handover_missing: '#115e59',
  lineage_roles_missing: '#134e4a',
  lineage_link_candidate: '#14b8a6',
  placeholder_politician: '#64748b', // 疑似測試資料：灰
  party_info_missing: '#7c3aed',     // 補政黨資訊：紫
  deadline_due: '#15803d',              // 期限到了查進度：深綠（同進度那一族）
}
// 驗證項目（contribution_type）另一套，彼此也拉開
const VERIFY_BORDER: Record<string, string> = {
  policy: '#7c3aed',            // 新增政見：紫
  policy_progress: '#0d9488',   // 政見進度：藍綠
  correction: '#c026d3',        // 資料更正：紫紅
  candidacy: '#e11d48',         // 參選狀態：紅
  politician: '#65a30d',        // 人物資料：黃綠
  no_change: '#94a3b8',         // 查無異動：淺灰
  removal: '#0f172a',           // 建議移除：近黑
  task_suggestion: '#06b6d4',   // 任務提議：青
  roster_check: '#0284c7',      // 名單清查：天藍
  district_seats: '#0e7490',    // 應選名額：深青
  election_results: '#334155',  // 整批選舉結果：深灰
  reassign_candidacy: '#9f1239', // 參選紀錄改掛：深玫紅
  question_answer: '#db2777',   // 提問回答：粉
  merge_politician: '#4338ca',  // 人物合併：靛
  adjudication: '#475569',
  policy_elements: '#9a3412',   // 政見三要素：赭
  lineage: '#0f766e',           // 政策脈絡：深青
  lineage_participants: '#134e4a',
  lineage_handover: '#115e59',
  lineage_link: '#14b8a6',
  party_info: '#7c3aed',        // 政黨資訊：紫
}
// 驗證項目的 task_type 是 contribution_type：用貢獻牆同一套中文名，讀得出「在驗什麼」
const VERIFY_LABEL: Record<string, string> = {
  policy: '新增政見',
  no_change: '查無異動回報',
  politician: '人物資料',
  candidacy: '參選狀態',
  policy_progress: '政見進度',
  correction: '資料更正',
  task_suggestion: '任務提議',
  roster_check: '名單清查',
  district_seats: '應選名額',
  election_results: '整批選舉結果',
  reassign_candidacy: '參選紀錄改掛',
  question_answer: '提問回答',
  removal: '建議移除',
  merge_politician: '人物合併',
  adjudication: '裁決',
  policy_elements: '政見三要素',
  lineage: '政策脈絡',
  lineage_participants: '脈絡參與角色',
  lineage_handover: '脈絡交接',
  lineage_link: '脈絡上下級',
  party_info: '政黨資訊',
}

const KIND_LABEL: Record<string, string> = { verify: '驗證票', auto: '自動缺口', manual: '手動任務' }
const VERDICT: Record<string, string> = { agree: '同意', disagree: '反對', unsure: '不確定' }
const num2 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '—')
const isStopped = (it: { stopped?: boolean; status?: string }) => it.stopped === true || it.status === 'disputed'
const overvoted = computed(() => state.value?.overvoted ?? null)
const overItems = computed(() => (Array.isArray(overvoted.value?.items) ? overvoted.value!.items! : []))
const overTotal = computed(() => overvoted.value?.total ?? overItems.value.length)
const overTypeLabel = (t: string) => VERIFY_LABEL[t] ?? taskTypeLabel(t)
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s
const headTypeLabel = (r: { kind?: string; task_type: string }) => r.kind === 'verify' ? (VERIFY_LABEL[r.task_type] ?? r.task_type) : taskTypeLabel(r.task_type)
const headColor = (r: { kind?: string; task_type: string }) => (r.kind === 'verify' ? VERIFY_BORDER[r.task_type] : BORDER[r.task_type]) ?? '#cbd5e1'
const fmt = (n: number) => n.toLocaleString('zh-TW')
const when = (iso: string) => {
  const d = new Date(iso)
  if (d.getFullYear() < 1990) return '插隊'
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const hms = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`

const statusTotal = computed(() => {
  const t: Record<string, number> = {}
  for (const r of state.value?.by_type ?? []) t[r.status] = (t[r.status] ?? 0) + r.n
  return t
})
const cards = computed(() => {
  const t = statusTotal.value
  return [
    { label: '可派', n: t.ready ?? 0 },
    { label: '被擋（查無等票＋額滿＋提問滿額）', n: (t.dead_end ?? 0) + (t.saturated ?? 0) + (t.question_full ?? 0) },
    { label: '停放中', n: t.parked ?? 0 },
    { label: '冷卻', n: t.cooling ?? 0 },
    { label: '擋下', n: t.blocked ?? 0 },
  ]
})
const dispatched24 = computed(() => (state.value?.dispatched_24h ?? []).reduce((a, r) => a + r.n, 0))
// 各任務型別的狀態分布：一型別一條，各狀態一段
const typeRows = computed(() => {
  const m = new Map<string, Record<string, number>>()
  for (const r of state.value?.by_type ?? []) {
    const k = groupBy.value === 'type' ? r.task_type : r.source
    const o = m.get(k) ?? {}
    o[r.status] = (o[r.status] ?? 0) + r.n
    m.set(k, o)
  }
  return [...m.entries()]
    .map(([k, o]) => ({ key: k, label: groupBy.value === 'type' ? taskTypeLabel(k) : sourceLabel(k), counts: o, total: Object.values(o).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total)
})
const maxTotal = computed(() => Math.max(1, ...typeRows.value.map((r) => r.total)))
// 24 小時派出：驗證票歸一列「驗證票」，其餘照任務型別
const disp24Rows = computed(() => {
  const m = new Map<string, number>()
  for (const r of state.value?.dispatched_24h ?? []) {
    const k = groupBy.value === 'type' ? (r.kind === 'verify' ? 'verify' : r.task_type) : r.kind
    m.set(k, (m.get(k) ?? 0) + r.n)
  }
  return [...m.entries()].map(([k, n]) => ({ key: k, label: groupBy.value === 'type' ? (k === 'verify' ? '驗證票' : taskTypeLabel(k)) : (KIND_LABEL[k] ?? k), n })).sort((a, b) => b.n - a.n)
})
const parkedRows = computed(() => state.value?.parked ?? [])
const parkedTotal = computed(() => state.value?.parked_total ?? parkedRows.value.length)
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>派工隊列</template>
      <template #icon><ListOrdered :size="400" class="text-blue-500" /></template>
      <template #actions>
        <MechanismNav current="contributions" />
      </template>
      <BoardNav current="queue" />
    </Hero>
  <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 text-sm text-slate-700 space-y-6">
    <div class="flex items-center justify-between gap-2">
      <p class="text-slate-400 tabular-nums">{{ refreshedAt ? `更新於 ${hms(refreshedAt)}` : '' }}</p>
      <div class="flex items-center gap-2">
      <span class="inline-flex overflow-hidden rounded border border-slate-300 text-xs">
        <button type="button" class="px-2.5 py-1" :class="groupBy === 'type' ? 'bg-slate-100' : ''" @click="groupBy = 'type'">依類型</button>
        <button type="button" class="border-l border-slate-300 px-2.5 py-1" :class="groupBy === 'source' ? 'bg-slate-100' : ''" @click="groupBy = 'source'">依來源</button>
      </span>
      <button type="button" class="rounded border border-slate-300 px-2.5 py-1 hover:bg-slate-50 disabled:opacity-50" :disabled="loading" @click="load">
        {{ loading ? '更新中…' : '重新整理' }}
      </button>
      </div>
    </div>
    <p v-if="failed" class="text-red-600">佇列讀不到，<button class="underline" @click="load">重試</button>。</p>
    <p v-else-if="state === null" class="text-slate-400">載入中…</p>

    <template v-if="state && !failed">
      <section class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <div v-for="c in cards" :key="c.label" class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
          <div class="text-xs text-slate-500">{{ c.label }}</div>
          <div class="text-2xl tabular-nums">{{ fmt(c.n) }}</div>
        </div>
        <div class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
          <div class="text-xs text-slate-500">24 小時實際派出</div>
          <div class="text-2xl tabular-nums">{{ fmt(dispatched24) }}</div>
        </div>
      </section>

      <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
        <h3 class="font-black text-navy-900 mb-3">各狀態分布（{{ groupBy === 'type' ? '依類型' : '依來源' }}）</h3>
        <div class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span v-for="s in STATUSES" :key="s.key" class="inline-flex items-center gap-1.5"><i class="inline-block size-2.5 rounded-sm" :style="{ background: s.bar }"></i>{{ s.label }}</span>
        </div>
        <div class="space-y-1.5">
          <div v-for="r in typeRows" :key="r.key" class="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-2 sm:grid-cols-[10rem_1fr_4rem]">
            <span class="truncate">{{ r.label }}</span>
            <div class="flex h-3.5 overflow-hidden rounded bg-slate-100" :style="{ width: (r.total / maxTotal) * 100 + '%', minWidth: '4px' }">
              <template v-for="s in STATUSES" :key="s.key">
                <div v-if="r.counts[s.key]" :style="{ background: s.bar, width: (r.counts[s.key] / r.total) * 100 + '%' }" :title="`${s.label} ${fmt(r.counts[s.key])}`"></div>
              </template>
            </div>
            <span class="text-right tabular-nums text-slate-500">{{ fmt(r.total) }}</span>
          </div>
        </div>
      </section>

      <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
        <h2 class="font-black text-navy-900 mb-3">隊頭前 {{ state.head.length }} 名</h2>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[44rem]">
            <thead class="text-left text-xs text-slate-500">
              <tr>
                <th class="py-1 pr-2 pl-2 font-normal">名次</th>
                <th class="py-1 pr-2 font-normal">種類</th>
                <th class="py-1 pr-2 font-normal">類型</th>
                <th class="py-1 pr-2 font-normal">對象</th>
                <th class="py-1 pr-2 font-normal">狀態</th>
                <th class="py-1 pr-2 font-normal">排隊時間</th>
                <th class="py-1 pr-2 text-right font-normal">派出次數</th>
                <th class="py-1 font-normal">最後派出</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in state.head" :key="h.pos" class="border-t border-slate-100">
                <td class="py-1 pr-2 pl-2 tabular-nums" :style="{ borderLeft: '4px solid ' + headColor(h) }">{{ h.pos }}</td>
                <td class="py-1 pr-2 whitespace-nowrap">{{ h.kind === 'verify' ? '驗證' : '任務' }}</td>
                <td class="py-1 pr-2 whitespace-nowrap">{{ headTypeLabel(h) }}<span class="ml-1 text-xs text-slate-400">{{ sourceLabel(h.source) }}</span></td>
                <td class="py-1 pr-2 max-w-[16rem] truncate font-medium" :title="h.subject">{{ h.subject || '—' }}</td>
                <td class="py-1 pr-2 whitespace-nowrap">{{ STATUS[h.status]?.label ?? h.status }}</td>
                <td class="py-1 pr-2 whitespace-nowrap tabular-nums text-slate-500">{{ when(h.queue_at) }}</td>
                <td class="py-1 pr-2 text-right tabular-nums">{{ fmt(h.dispatch_count) }}</td>
                <td class="py-1 whitespace-nowrap tabular-nums text-slate-500">{{ h.dispatch_count > 0 && h.last_dispatched_at ? when(h.last_dispatched_at) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="parkedTotal > 0" class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
        <h2 class="font-black text-navy-900 mb-3">停放中 {{ fmt(parkedTotal) }} 筆</h2>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[36rem]">
            <thead class="text-left text-xs text-slate-500">
              <tr>
                <th class="py-1 pr-2 font-normal">類型</th>
                <th class="py-1 pr-2 font-normal">對象</th>
                <th class="py-1 pr-2 font-normal">排隊時間</th>
                <th class="py-1 pr-2 text-right font-normal">在途交件</th>
                <th class="py-1 text-right font-normal">等待驗證票</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in parkedRows" :key="p.task_id" class="border-t border-slate-100">
                <td class="py-1 pr-2 whitespace-nowrap">{{ taskTypeLabel(p.task_type) }}<span class="ml-1 text-xs text-slate-400">{{ sourceLabel(p.source) }}</span></td>
                <td class="py-1 pr-2 max-w-[16rem] truncate" :title="p.subject">{{ p.subject || '—' }}</td>
                <td class="py-1 pr-2 whitespace-nowrap tabular-nums text-slate-500">{{ when(p.queue_at) }}</td>
                <td class="py-1 pr-2 text-right tabular-nums">{{ fmt(p.inflight) }}</td>
                <td class="py-1 text-right tabular-nums">{{ fmt(p.verify_waiting) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="overvoted && (overTotal > 0 || overItems.length)" class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
        <h2 class="font-black text-navy-900 mb-3">投太多輪 <span class="ml-2 text-xs font-normal text-slate-500 tabular-nums">平均每筆 {{ num2(overvoted.baseline) }} 票；超過 {{ num2(overvoted.flag_votes) }} 票標出、超過 {{ num2(overvoted.stop_votes) }} 票停派；共 {{ fmt(overTotal) }} 筆</span></h2>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[44rem]">
            <thead class="text-left text-xs text-slate-500">
              <tr>
                <th class="py-1 pr-2 font-normal">類型</th>
                <th class="py-1 pr-2 font-normal">對象</th>
                <th class="py-1 pr-2 text-right font-normal">票數</th>
                <th class="py-1 pr-2 font-normal">處置</th>
                <th class="py-1 font-normal">各票意見</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(o, i) in overItems" :key="o.contribution_id ?? i" class="border-t border-slate-100 align-top">
                <td class="py-1 pr-2 whitespace-nowrap">{{ o.contribution_type ? overTypeLabel(o.contribution_type) : '—' }}</td>
                <td class="py-1 pr-2 max-w-[14rem] truncate" :title="o.subject">{{ o.subject || '—' }}</td>
                <td class="py-1 pr-2 text-right tabular-nums">{{ fmt(o.votes ?? 0) }}</td>
                <td class="py-1 pr-2 whitespace-nowrap">{{ isStopped(o) ? '已停派・轉裁決' : '已標出' }}</td>
                <td class="py-1">
                  <div v-if="!o.verdicts?.length" class="text-slate-400">—</div>
                  <div v-for="(v, j) in o.verdicts ?? []" :key="j" class="flex items-center gap-1.5 py-0.5 text-xs">
                    <span class="whitespace-nowrap">{{ VERDICT[v.verdict ?? ''] ?? v.verdict ?? '—' }}</span>
                    <span class="whitespace-nowrap text-slate-400">{{ v.agent || '—' }}</span>
                    <span v-if="v.reason" class="max-w-[18rem] truncate" :title="v.reason">{{ v.reason }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="grid gap-6 md:grid-cols-2">
        <div class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
          <h2 class="font-black text-navy-900 mb-3">24 小時實際派出</h2>
          <p v-if="!disp24Rows.length" class="text-slate-400">沒有</p>
          <ul class="space-y-0.5">
            <li v-for="r in disp24Rows" :key="r.key" class="flex justify-between gap-2"><span class="truncate">{{ r.label }}</span><span class="tabular-nums text-slate-500">{{ fmt(r.n) }}</span></li>
          </ul>
        </div>
        <div class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
          <h2 class="font-black text-navy-900 mb-3">可派的距上次派出</h2>
          <ul class="space-y-0.5">
            <li v-for="g in AGE" :key="g.key" class="flex justify-between gap-2"><span>{{ g.label }}</span><span class="tabular-nums text-slate-500">{{ fmt(state.age_buckets[g.key]) }}</span></li>
          </ul>
        </div>
      </section>

      <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5">
        <h2 class="font-black text-navy-900 mb-3">驗證佇列</h2>
        <p class="mb-2 tabular-nums">等驗證 {{ fmt(state.verify.total) }}　可派 {{ fmt(state.verify.eligible) }}</p>
        <ul class="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
          <li v-for="v in state.verify.by_type" :key="v.contribution_type" class="flex justify-between gap-2 border-b border-slate-100 py-0.5">
            <span>{{ VERIFY_LABEL[v.contribution_type] ?? v.contribution_type }}</span>
            <span class="tabular-nums text-slate-500">{{ fmt(v.n) }}<template v-if="v.eligible !== v.n">（可派 {{ fmt(v.eligible) }}）</template></span>
          </li>
        </ul>
      </section>
    </template>
  </main>
  </div>
</template>
