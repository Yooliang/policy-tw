<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronUp, History, Loader2, AlertCircle, ExternalLink, Undo2 } from 'lucide-vue-next'
import { fetchHistory, formatTime, type HistoryEntry, type HistoryOrigin, type HistoryTarget } from '../../lib/history'
import HistoryEntryDetail from './HistoryEntryDetail.vue'

/**
 * 查核履歷區塊（政見頁／人物頁／分析頁共用）：預設收合、標題帶筆數；展開列時間軸，每筆再展開看驗證者與改動。
 * 沒有貢獻紀錄時顯示資料來源說明（匯入的 source_url／source_note），不留空白。
 */
const props = withDefaults(defineProps<{ target: HistoryTarget; id: string; title?: string; compact?: boolean }>(), { title: '查核履歷', compact: false })

const open = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const entries = ref<HistoryEntry[]>([])
const origin = ref<HistoryOrigin | null>(null)
const total = ref<number | null>(null)
const hasMore = ref(false)
const nextCursor = ref<string | null>(null)
const expanded = ref<Set<string>>(new Set())

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800', verified: 'bg-sky-100 text-sky-800', applied: 'bg-emerald-100 text-emerald-800',
  apply_failed: 'bg-amber-100 text-amber-800', disputed: 'bg-orange-100 text-orange-800', rejected: 'bg-slate-100 text-slate-600', reverted: 'bg-slate-200 text-slate-700',
}

async function load(cursor: string | null = null) {
  loading.value = true
  error.value = null
  try {
    const body = await fetchHistory(props.target, props.id, { limit: 20, cursor })
    entries.value = cursor ? [...entries.value, ...body.entries] : body.entries
    origin.value = body.origin
    total.value = body.total
    hasMore.value = body.has_more
    nextCursor.value = body.next_cursor
  } catch (e) {
    error.value = e instanceof Error ? e.message : '暫時讀不到履歷'
  } finally {
    loading.value = false
  }
}

function toggleEntry(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

const headline = computed(() => {
  if (total.value === null) return props.title
  return total.value > 0 ? `${props.title}（${total.value} 筆）` : props.title
})

onMounted(() => { load() })
watch(() => props.id, () => { entries.value = []; total.value = null; expanded.value = new Set(); load() })
</script>

<template>
  <section :class="['bg-white rounded-xl border border-slate-200 shadow-sm', compact ? 'p-4' : 'p-6']" data-testid="history-panel">
    <button type="button" class="w-full flex items-center justify-between gap-3 text-left" data-testid="history-toggle" :aria-expanded="open" @click="open = !open">
      <span :class="['font-bold text-navy-900 flex items-center gap-2', compact ? 'text-base' : 'text-xl']">
        <History class="text-slate-400" :size="compact ? 18 : 22" /> {{ headline }}
        <Loader2 v-if="loading && total === null" :size="14" class="animate-spin text-slate-400" />
      </span>
      <span class="text-xs text-slate-500 inline-flex items-center gap-1 whitespace-nowrap">
        {{ open ? '收合' : (total === 0 ? '看來源' : '展開') }}
        <component :is="open ? ChevronUp : ChevronDown" :size="16" />
      </span>
    </button>
    <p v-if="!open && total !== null" class="mt-1 text-xs text-slate-500">
      {{ total > 0 ? '這筆資料由 AI 代理提交、其他代理驗證後上線；展開看是誰查的、誰審的、改過什麼。' : (origin?.note ?? '這筆資料尚未經過 AI 貢獻流程') }}
    </p>

    <div v-if="open" class="mt-4" data-testid="history-body">
      <div v-if="loading && entries.length === 0" class="py-6 text-center text-slate-500"><Loader2 :size="22" class="animate-spin mx-auto mb-1 text-blue-500" />載入中…</div>
      <div v-else-if="error" class="py-4 text-center text-sm" data-testid="history-error">
        <AlertCircle :size="22" class="mx-auto mb-1 text-red-500" />
        <p class="text-slate-700 font-bold">暫時讀不到履歷</p>
        <button type="button" class="mt-2 px-3 py-1.5 rounded-lg bg-navy-900 text-white text-xs font-bold" @click="load()">再試一次</button>
      </div>
      <div v-else-if="entries.length === 0" class="text-sm text-slate-600 space-y-2" data-testid="history-empty">
        <p class="font-bold text-slate-800">這筆資料尚未經過 AI 貢獻流程</p>
        <p v-if="origin?.note">{{ origin.note }}</p>
        <a v-if="origin?.source_url" :href="origin.source_url" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2 break-all inline-flex items-start gap-1"><ExternalLink :size="12" class="mt-1 flex-shrink-0" />{{ origin.source_url }}</a>
        <ul v-if="origin?.source_notes?.length" class="list-disc pl-5 text-slate-700">
          <li v-for="n in origin.source_notes" :key="n">{{ n }}</li>
        </ul>
      </div>
      <ol v-else class="relative border-l-2 border-slate-200 ml-2 space-y-4" data-testid="history-list">
        <li v-for="e in entries" :key="e.id" class="relative pl-6" data-testid="history-entry" :data-status="e.status">
          <span :class="['absolute -left-[7px] top-1.5 w-3 h-3 rounded-full border-2 border-white ring-2', e.reverted ? 'bg-slate-300 ring-slate-100' : e.status === 'applied' ? 'bg-emerald-500 ring-emerald-100' : e.status === 'disputed' ? 'bg-orange-500 ring-orange-100' : 'bg-amber-400 ring-amber-100']"></span>
          <button type="button" class="w-full text-left" @click="toggleEntry(e.id)">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-mono text-slate-400">{{ formatTime(e.at) }}</span>
              <span class="font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{{ e.type_label }}</span>
              <span :class="['font-bold px-2 py-0.5 rounded-full', STATUS_CLASS[e.status] ?? 'bg-slate-100 text-slate-600']">{{ e.status_label }}</span>
              <span v-if="e.reverted" class="text-amber-700 inline-flex items-center gap-1"><Undo2 :size="11" /> 已還原</span>
            </div>
            <p :class="['mt-1 font-bold text-navy-900 leading-snug break-words', e.reverted ? 'line-through decoration-slate-400 text-slate-500' : '']">{{ e.summary }}</p>
            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
              <span>提交：<b class="text-slate-700">{{ e.agent_name ?? '?' }}</b><span v-if="e.agent_tool" class="text-slate-400">・{{ e.agent_tool }}</span></span>
              <span>驗證 {{ e.verifiers.length }} 人（同意 {{ e.agree_count }}／反對 {{ e.disagree_count }}／不確定 {{ e.unsure_count }}）</span>
              <span v-if="e.edits.length">改動 {{ e.edits.length }} 處</span>
              <span v-if="e.adjudications.length">有裁決</span>
              <component :is="expanded.has(e.id) ? ChevronUp : ChevronDown" :size="14" class="ml-auto text-slate-400" />
            </div>
          </button>
          <div v-if="expanded.has(e.id)" class="mt-2 rounded-lg bg-slate-50 border border-slate-100 p-3">
            <HistoryEntryDetail :entry="e" />
          </div>
        </li>
      </ol>
      <div v-if="hasMore" class="mt-4 text-center">
        <button type="button" class="px-4 py-2 rounded-lg bg-white border border-slate-300 text-sm font-bold text-navy-900 hover:bg-slate-50" :disabled="loading" @click="load(nextCursor)" data-testid="history-more">
          <Loader2 v-if="loading" :size="14" class="animate-spin inline mr-1" />載入更多
        </button>
      </div>
    </div>
  </section>
</template>
