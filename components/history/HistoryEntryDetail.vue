<script setup lang="ts">
import { ExternalLink, Scale, Undo2 } from 'lucide-vue-next'
import { ADJ_VERDICT_LABEL, formatTime, formatValue, VERDICT_CLASS, VERDICT_LABEL, type HistoryEntry } from '../../lib/history'

/** 一筆履歷的細節：驗證者與理由、欄位舊值新值、裁決、還原。查核履歷面板與貢獻看板共用（看板自己已顯示來源與備註，可關掉）。 */
withDefaults(defineProps<{ entry: HistoryEntry; hideSources?: boolean; hideNotes?: boolean }>(), { hideSources: false, hideNotes: false })
</script>

<template>
  <div class="space-y-3 text-sm" data-testid="history-entry-detail">
    <div v-if="!hideSources && entry.source_urls.length">
      <p class="text-xs font-bold text-slate-400 mb-1">來源</p>
      <ul class="space-y-1">
        <li v-for="u in entry.source_urls" :key="u">
          <a :href="u" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2 break-all inline-flex items-start gap-1"><ExternalLink :size="12" class="mt-1 flex-shrink-0" />{{ u }}</a>
        </li>
      </ul>
    </div>

    <div>
      <p class="text-xs font-bold text-slate-400 mb-1">驗證者（{{ entry.verifiers.length }}）</p>
      <p v-if="entry.verifiers.length === 0" class="text-slate-400">還沒有人驗證</p>
      <ul v-else class="space-y-1.5" data-testid="verifier-list">
        <li v-for="v in entry.verifiers" :key="`${v.agent_name}-${v.created_at}`" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" data-testid="verifier">
          <span :class="['text-[11px] font-bold px-2 py-0.5 rounded-full', VERDICT_CLASS[v.verdict] ?? 'bg-slate-100 text-slate-600']">{{ VERDICT_LABEL[v.verdict] ?? v.verdict }}</span>
          <span class="font-bold text-navy-900">{{ v.agent_name ?? '?' }}</span>
          <span v-if="v.agent_tool" class="text-xs text-slate-400">{{ v.agent_tool }}</span>
          <span class="text-xs text-slate-400">{{ formatTime(v.created_at) }}</span>
          <span v-if="v.resolved_politician_id" class="text-xs text-slate-500">指認 {{ v.resolved_politician_id === 'new' ? '新人物' : v.resolved_politician_id.slice(0, 8) }}</span>
          <span v-if="v.note" class="basis-full text-slate-700 break-words">{{ v.note }}</span>
          <a v-if="v.evidence_url" :href="v.evidence_url" target="_blank" rel="noopener" class="basis-full text-blue-700 underline underline-offset-2 break-all inline-flex items-start gap-1 text-xs"><ExternalLink :size="11" class="mt-0.5 flex-shrink-0" />反證：{{ v.evidence_url }}</a>
        </li>
      </ul>
    </div>

    <div v-if="entry.edits.length">
      <p class="text-xs font-bold text-slate-400 mb-1">改了什麼（{{ entry.edits.length }}）</p>
      <ul class="space-y-1" data-testid="edit-list">
        <li v-for="(e, i) in entry.edits" :key="i" class="flex flex-wrap items-baseline gap-x-2 text-slate-700" :class="e.reverted_at ? 'line-through decoration-slate-400 text-slate-400' : ''">
          <span class="text-xs text-slate-400 font-mono">{{ e.table }}</span>
          <template v-if="e.field === '*'"><span>新增一列</span></template>
          <template v-else>
            <span class="font-bold">{{ e.field_label }}</span>
            <span class="text-slate-400">「{{ formatValue(e.old_value) }}」</span>
            <span class="text-slate-400">→</span>
            <span>「{{ formatValue(e.new_value) }}」</span>
          </template>
          <span v-if="e.reverted_at" class="text-xs text-amber-700 inline-flex items-center gap-1"><Undo2 :size="11" /> {{ formatTime(e.reverted_at) }} 由 {{ e.reverted_by ?? '維護者' }} 還原</span>
        </li>
      </ul>
    </div>

    <div v-if="entry.adjudications.length" data-testid="adjudication-list">
      <p class="text-xs font-bold text-slate-400 mb-1 inline-flex items-center gap-1"><Scale :size="12" /> 裁決</p>
      <ul class="space-y-1.5">
        <li v-for="a in entry.adjudications" :key="a.contribution_id || a.task_id || a.created_at" class="text-slate-700">
          <template v-if="a.verdict">
            <span class="font-bold text-navy-900">{{ a.agent_name ?? '?' }}</span>
            <span :class="['ml-2 text-[11px] font-bold px-2 py-0.5 rounded-full', a.verdict === 'uphold' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700']">{{ ADJ_VERDICT_LABEL[a.verdict] ?? a.verdict }}</span>
            <span class="ml-2 text-xs text-slate-400">{{ a.status === 'applied' ? '已定案' : '驗證中' }}・{{ formatTime(a.created_at) }}</span>
            <p v-if="a.reason" class="mt-0.5 break-words">{{ a.reason }}</p>
          </template>
          <template v-else>
            <span class="text-slate-500">裁決任務已建立（{{ a.task_status === 'open' ? '等待代理裁決' : '已關閉' }}），{{ formatTime(a.created_at) }}</span>
          </template>
        </li>
      </ul>
    </div>

    <p v-if="!hideNotes && entry.review_notes" class="text-xs text-slate-500 whitespace-pre-wrap break-words"><span class="font-bold text-slate-400">系統備註：</span>{{ entry.review_notes }}</p>
  </div>
</template>
