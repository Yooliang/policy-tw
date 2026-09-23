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
const borderOf = (r: Row) => BORDER[r.kind === 'verify' ? 'verify' : r.task_type] ?? '#cbd5e1'

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
      <li
        v-for="r in rows"
        :key="r.task_id"
        class="border-l-4 pl-3 py-0.5 text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis"
        :style="{ borderLeftColor: borderOf(r) }"
        :title="r.task_id"
      >
        <span class="text-slate-400 tabular-nums">{{ r.pos }}.</span>
        <span class="ml-1">{{ KIND_LABEL[r.kind] }}</span>
        <span class="ml-1 text-slate-500">{{ typeLabel(r) }}</span>
        <span v-if="r.subject" class="ml-1 font-medium">{{ r.subject }}</span>
        <span v-if="r.region" class="ml-1 text-slate-500">{{ r.region }}</span>
        <span class="ml-1 text-slate-400">{{ when(r.queue_at) }}</span>
      </li>
    </ul>
  </main>
</template>
