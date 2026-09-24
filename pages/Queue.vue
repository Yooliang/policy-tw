<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import { usePageHead } from '../composables/usePageHead'
import { taskTypeLabel } from '../lib/task-labels'

// 派工佇列：全站接下來 1000 筆會被領走的順序（2026-09-23 小良哥：一行一筆、li 排下去、不用標題）。
// 資料來自 queue_preview()（migration 20260923000001），跟 /next 同一把尺；不含每個代理各自的排除。
type Row = { pos: number; kind: 'task' | 'verify'; task_id: string; task_type: string; subject: string | null; region: string | null; queue_at: string }

const rows = ref<Row[] | null>(null)
const failed = ref(false)
// 誰領走了什麼（2026-09-24 小良哥：「a-zhen 領走的應該看的到吧」）：最近 30 分鐘的任務認領與驗證派發，只有代號、沒有 IP
type Dispatch = { kind: 'task' | 'verify'; task_id: string; agent_name: string; dispatched_at: string; active_until: string }
const recent = ref<Dispatch[]>([])
const holderOf = computed(() => {
  const m = new Map<string, Dispatch>()
  const now = Date.now()
  for (const d of recent.value) if (Date.parse(d.active_until) > now && !m.has(d.task_id)) m.set(d.task_id, d)
  return m
})

usePageHead({ title: '派工佇列', description: '接下來 1000 筆會被領走的順序', noindex: true })

async function load() {
  failed.value = false
  try {
    const { data } = await withTimeoutAndRetry('queue preview', (signal) =>
      supabasePublic.rpc('queue_preview', { p_limit: 1000 }).abortSignal(signal).throwOnError())
    rows.value = (data ?? []) as Row[]
    // 派出紀錄讀不到不影響佇列本身
    try {
      const { data: rd } = await supabasePublic.rpc('dispatch_recent', { p_minutes: 30 })
      recent.value = (rd ?? []) as Dispatch[]
    } catch { recent.value = [] }
  } catch (e) {
    console.info('[佇列] 讀取失敗', e)
    failed.value = true
  }
}
onMounted(load)

// 左邊框依型別上色：用 inline style，不走 Tailwind 動態 class（要 safelist）
const BORDER: Record<string, string> = {
  policy_missing: '#1d4ed8',            // 政見缺口：藍
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
  roster_check: '#06b6d4',              // 名冊清查：青
  legacy_audit: '#64748b',              // 舊資料稽核：灰
  policy_validity: '#94a3b8',           // 是不是政見：淺灰
  duplicate_policy: '#a16207',          // 重複政見：暗黃
  duplicate_politician: '#78716c',      // 重複人物：石
  question: '#db2777',                  // 提問：粉
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
  question_answer: '#db2777',   // 提問回答：粉
  merge_politician: '#4338ca',  // 人物合併：靛
  adjudication: '#475569',
}
const typeColor = (r: Row) => (r.kind === 'verify' ? VERIFY_BORDER[r.task_type] : BORDER[r.task_type]) ?? '#cbd5e1'
const KIND_LABEL: Record<string, string> = { task: '任務', verify: '驗證' }
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
  question_answer: '提問回答',
  removal: '建議移除',
  merge_politician: '人物合併',
  adjudication: '裁決',
}
const typeLabel = (r: Row) => r.kind === 'verify' ? (VERIFY_LABEL[r.task_type] ?? r.task_type) : taskTypeLabel(r.task_type)
const minsLeft = (iso: string) => Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000))
const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const when = (iso: string) => {
  const d = new Date(iso)
  if (d.getFullYear() < 1990) return '優先'
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <main class="max-w-5xl mx-auto px-4 py-6 text-sm">
    <p v-if="failed" class="text-red-600">佇列讀不到，<button class="underline" @click="load">重試</button>。</p>
    <p v-else-if="rows === null" class="text-slate-400">載入中…</p>
    <details v-if="rows !== null && recent.length > 0" class="mb-4 text-slate-600">
      <summary class="cursor-pointer">最近 30 分鐘派出 {{ recent.length }} 筆（驗證 {{ recent.filter((d) => d.kind === 'verify').length }}／任務 {{ recent.filter((d) => d.kind === 'task').length }}）</summary>
      <ul class="mt-1 space-y-0.5">
        <li v-for="d in recent" :key="d.kind + d.task_id + d.dispatched_at" class="whitespace-nowrap overflow-hidden text-ellipsis">
          <span class="text-slate-400 tabular-nums">{{ hhmm(d.dispatched_at) }}</span>
          <span class="ml-1">{{ d.agent_name }}</span>
          <span class="ml-1">{{ KIND_LABEL[d.kind] }}</span>
          <span class="ml-1 text-slate-400">{{ d.task_id }}</span>
        </li>
      </ul>
    </details>
    <ul v-if="rows !== null && !failed" class="space-y-0.5">
      <li v-for="r in rows" :key="r.task_id" class="flex items-stretch gap-3 text-slate-700" :title="r.task_id">
        <span class="w-[30px] shrink-0 rounded-sm" :style="{ background: typeColor(r) }" aria-hidden="true"></span>
        <span class="py-0.5 whitespace-nowrap overflow-hidden text-ellipsis">
          <span class="text-slate-400 tabular-nums">{{ r.pos }}.</span>
          <span class="ml-1">{{ KIND_LABEL[r.kind] }}</span>
          <span class="ml-1 text-slate-500">{{ typeLabel(r) }}</span>
          <span v-if="r.subject" class="ml-1 font-medium">{{ r.subject }}</span>
          <span v-if="r.region" class="ml-1 text-slate-500">{{ r.region }}</span>
          <span class="ml-1 text-slate-400">{{ when(r.queue_at) }}</span>
          <span v-if="holderOf.get(r.task_id)" class="ml-1 text-amber-700">{{ holderOf.get(r.task_id)!.agent_name }} 處理中（剩 {{ minsLeft(holderOf.get(r.task_id)!.active_until) }} 分）</span>
        </span>
      </li>
    </ul>
  </main>
</template>
