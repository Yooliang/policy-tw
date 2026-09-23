<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import { usePageHead } from '../composables/usePageHead'
import { taskTypeLabel } from '../lib/task-labels'

// 派工佇列：全站接下來 1000 筆會被領走的順序（2026-09-23 小良哥：一行一筆、li 排下去、不用標題）。
// 資料來自 queue_preview()（migration 20260923000001），跟 /next 同一把尺；不含每個代理各自的排除。
type Row = { pos: number; kind: 'task' | 'verify'; task_id: string; task_type: string; subject: string | null; region: string | null; queue_at: string }

const rows = ref<Row[] | null>(null)
const failed = ref(false)

usePageHead({ title: '派工佇列', description: '接下來 1000 筆會被領走的順序', noindex: true })

async function load() {
  failed.value = false
  try {
    const { data } = await withTimeoutAndRetry('queue preview', (signal) =>
      supabasePublic.rpc('queue_preview', { p_limit: 1000 }).abortSignal(signal).throwOnError())
    rows.value = (data ?? []) as Row[]
  } catch (e) {
    console.info('[佇列] 讀取失敗', e)
    failed.value = true
  }
}
onMounted(load)

// 左邊框依型別上色：用 inline style，不走 Tailwind 動態 class（要 safelist）
const BORDER: Record<string, string> = {
  verify: '#7c3aed',                 // 驗證：紫
  policy_missing: '#2563eb',         // 政見缺口：藍
  policy_election_missing: '#3b82f6',
  policy_election_mismatch: '#3b82f6',
  profile_gap: '#d97706',            // 基本資料：琥珀
  policy_source_missing: '#ea580c',  // 來源：橘
  source_mismatch: '#ea580c',
  progress_stale: '#059669',         // 進度：綠
  not_running_recheck: '#e11d48',    // 參選狀態：玫紅
  candidacy_source_missing: '#e11d48',
  candidate_status_stale: '#e11d48',
  election_result_missing: '#e11d48',
  roster_check: '#0891b2',           // 名冊：青
  legacy_audit: '#64748b',           // 稽核類：灰
  policy_validity: '#64748b',
  duplicate_policy: '#64748b',
  duplicate_politician: '#64748b',
  question: '#db2777',               // 提問：粉
}
// 驗證項目也依「在驗什麼」分色（2026-09-23 小良哥：只分任務／驗證兩色不夠）：鍵是 contribution_type
const VERIFY_BORDER: Record<string, string> = {
  policy: '#7c3aed',           // 新增政見：紫
  policy_progress: '#047857',  // 政見進度：深綠
  correction: '#c026d3',       // 資料更正：紫紅
  candidacy: '#be123c',        // 參選狀態：深紅
  politician: '#b45309',       // 人物資料：褐
  no_change: '#94a3b8',        // 查無異動回報：淺灰
  removal: '#dc2626',          // 建議移除：紅
  task_suggestion: '#0e7490',  // 任務提議：藍綠
  roster_check: '#0891b2',     // 名單清查：青
  question_answer: '#db2777',  // 提問回答：粉
  merge_politician: '#4f46e5', // 人物合併：靛
  adjudication: '#475569',
}
const typeColor = (r: Row) => (r.kind === 'verify' ? VERIFY_BORDER[r.task_type] : BORDER[r.task_type]) ?? '#cbd5e1'
// 左側 30px 色條：第一層分類（任務／驗證）的顏色漸變到第二層（型別）的顏色——固定範式，兩層都看得出來（2026-09-23 小良哥）
const KIND_COLOR: Record<string, string> = { task: '#1d4ed8', verify: '#7c3aed' }
// 漸層看起來糊（2026-09-23）：改成兩塊實色並排，左 15px 第一層、右 15px 第二層
const kindColor = (r: Row) => KIND_COLOR[r.kind] ?? '#94a3b8'

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
    <ul v-else class="space-y-0.5">
      <li v-for="r in rows" :key="r.task_id" class="flex items-stretch gap-3 text-slate-700" :title="r.task_id">
        <span class="flex w-[30px] shrink-0 rounded-sm overflow-hidden" aria-hidden="true">
          <span class="w-1/2" :style="{ background: kindColor(r) }"></span>
          <span class="w-1/2" :style="{ background: typeColor(r) }"></span>
        </span>
        <span class="py-0.5 whitespace-nowrap overflow-hidden text-ellipsis">
          <span class="text-slate-400 tabular-nums">{{ r.pos }}.</span>
          <span class="ml-1">{{ KIND_LABEL[r.kind] }}</span>
          <span class="ml-1 text-slate-500">{{ typeLabel(r) }}</span>
          <span v-if="r.subject" class="ml-1 font-medium">{{ r.subject }}</span>
          <span v-if="r.region" class="ml-1 text-slate-500">{{ r.region }}</span>
          <span class="ml-1 text-slate-400">{{ when(r.queue_at) }}</span>
        </span>
      </li>
    </ul>
  </main>
</template>
