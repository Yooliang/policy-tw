<script setup lang="ts">
import { hostOf, shortUrlsIn } from '../../lib/url'
import { ref } from 'vue'
import { ExternalLink, Scale, Undo2, ThumbsUp, ThumbsDown, CircleHelp, ChevronDown, ChevronUp } from 'lucide-vue-next'
import { ADJ_VERDICT_LABEL, formatTime, formatValue, tableLabel, VERDICT_CLASS, VERDICT_LABEL, type HistoryEntry } from '../../lib/history'
import { policyStatusLabel } from '../../composables/usePageHead'

/** 一筆履歷的細節：驗證者與理由、欄位舊值新值、裁決、還原。查核履歷面板與貢獻看板共用（看板自己已顯示來源與備註，可關掉）。 */
withDefaults(defineProps<{ entry: HistoryEntry; hideSources?: boolean; hideNotes?: boolean }>(), { hideSources: false, hideNotes: false })

// 判定改用圖示（2026-09-17），跟上方摘要那三顆膠囊同一組符號；
// 文字留在 title 裡，讀螢幕的人與滑過去的人還是讀得到。
const VERDICT_ICON: Record<string, typeof ThumbsUp> = { agree: ThumbsUp, disagree: ThumbsDown, unsure: CircleHelp }

/**
 * 只有「政見狀態」這一欄翻中文（2026-09-17）：它是固定的 enum，翻得起來。
 * 其餘欄位（標題、日期、網址）的值是原文資料，照原樣印——翻譯資料本身會造假。
 */
// 驗證理由預設收起來（2026-09-17）：一則理由動輒三五百字，兩三位驗證者一展開
// 就把「誰驗的、判什麼」整個淹掉。要看的人再點開。
const openNotes = ref<Set<string>>(new Set())
function toggleNote(key: string) {
  const next = new Set(openNotes.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openNotes.value = next
}

const STATUS_FIELDS = new Set(['status', 'candidate_status', 'election_result'])
function editValue(field: string, v: unknown): string {
  const raw = formatValue(v)
  if (!STATUS_FIELDS.has(field) || raw === '（空）') return raw
  return field === 'status' ? policyStatusLabel(raw) : raw
}
</script>

<template>
  <!-- 每一段之間拉開並加淡分隔線（2026-09-17：「分段更優化一些」）：
       來源、驗證者、改了什麼、裁決原本只隔 12px，長理由一多就糊成一整塊。
       網址一律單行、過長截斷（title 帶完整網址，仍可複製）。 -->
  <div class="text-sm divide-y divide-slate-200/70 [&>*]:py-3 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0" data-testid="history-entry-detail">
    <div v-if="entry.edits.length">
      <p class="text-xs font-bold text-slate-400 mb-1">更新內容（{{ entry.edits.length }}）</p>
      <ul class="space-y-1.5" data-testid="edit-list">
        <li v-for="(e, i) in entry.edits" :key="i" class="flex flex-wrap items-baseline gap-x-2 text-slate-700" :class="e.reverted_at ? 'line-through decoration-slate-400 text-slate-400' : ''">
          <span class="text-xs font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{{ tableLabel(e.table) }}</span>
          <template v-if="e.field === '*'"><span>新增一列</span></template>
          <template v-else>
            <span class="font-bold">{{ e.field_label }}</span>
            <span class="text-slate-400">「{{ editValue(e.field, e.old_value) }}」</span>
            <span class="text-slate-400">→</span>
            <span>「{{ editValue(e.field, e.new_value) }}」</span>
          </template>
          <span v-if="e.reverted_at" class="text-xs text-amber-700 inline-flex items-center gap-1"><Undo2 :size="11" /> {{ formatTime(e.reverted_at) }} 由 {{ e.reverted_by ?? '維護者' }} 還原</span>
        </li>
      </ul>
    </div>

    <div v-if="!hideSources && entry.source_urls.length">
      <p class="text-xs font-bold text-slate-400 mb-1">來源</p>
      <ul class="space-y-1">
        <li v-for="u in entry.source_urls" :key="u">
          <a :href="u" :title="u" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2 flex items-center gap-1 min-w-0"><ExternalLink :size="12" class="flex-shrink-0" /><span class="truncate">{{ hostOf(u) }}</span></a>
        </li>
      </ul>
    </div>

    <div>
      <p class="text-xs font-bold text-slate-400 mb-1">驗證者（{{ entry.verifiers.length }}）</p>
      <p v-if="entry.verifiers.length === 0" class="text-slate-400">還沒有人驗證</p>
      <ul v-else class="space-y-3" data-testid="verifier-list">
        <li v-for="v in entry.verifiers" :key="`${v.agent_name}-${v.created_at}`" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" data-testid="verifier">
          <span :title="VERDICT_LABEL[v.verdict] ?? v.verdict" :class="['inline-flex items-center px-1.5 py-1 rounded-full', VERDICT_CLASS[v.verdict] ?? 'bg-slate-100 text-slate-600']">
            <component :is="VERDICT_ICON[v.verdict] ?? CircleHelp" :size="12" />
          </span>
          <span class="font-bold text-navy-900">{{ v.agent_name ?? '?' }}</span>
          <span v-if="v.agent_tool" class="text-xs text-slate-400">{{ v.agent_tool }}</span>
          <span class="text-xs text-slate-400">{{ formatTime(v.created_at) }}</span>
          <span v-if="v.resolved_politician_id" class="text-xs text-slate-500">指認 {{ v.resolved_politician_id === 'new' ? '新人物' : v.resolved_politician_id.slice(0, 8) }}</span>
          <button
            v-if="v.note"
            type="button"
            class="text-xs text-slate-500 hover:text-navy-900 inline-flex items-center gap-0.5"
            @click="toggleNote(`${v.agent_name}-${v.created_at}`)"
          >
            {{ openNotes.has(`${v.agent_name}-${v.created_at}`) ? '收合理由' : '看理由' }}
            <component :is="openNotes.has(`${v.agent_name}-${v.created_at}`) ? ChevronUp : ChevronDown" :size="12" />
          </button>
          <span v-if="v.note && openNotes.has(`${v.agent_name}-${v.created_at}`)" class="basis-full text-slate-600 leading-relaxed break-words border-l-2 border-slate-200 pl-2.5">{{ shortUrlsIn(v.note) }}</span>
          <a v-if="v.evidence_url" :href="v.evidence_url" :title="v.evidence_url" target="_blank" rel="noopener" class="basis-full text-blue-700 underline underline-offset-2 flex items-center gap-1 text-xs min-w-0"><ExternalLink :size="11" class="flex-shrink-0" /><span class="shrink-0">反證：</span><span class="truncate">{{ hostOf(v.evidence_url) }}</span></a>
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
            <p v-if="a.reason" class="mt-0.5 break-words">{{ shortUrlsIn(a.reason) }}</p>
          </template>
          <template v-else>
            <span class="text-slate-500">裁決任務已建立（{{ a.task_status === 'open' ? '等待代理裁決' : '已關閉' }}），{{ formatTime(a.created_at) }}</span>
          </template>
        </li>
      </ul>
    </div>

    <p v-if="!hideNotes && entry.review_notes" class="text-xs text-slate-500 whitespace-pre-wrap break-words"><span class="font-bold text-slate-400">系統備註：</span>{{ shortUrlsIn(entry.review_notes) }}</p>
  </div>
</template>
