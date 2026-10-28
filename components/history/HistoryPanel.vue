<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronUp, History, Loader2, AlertCircle, ExternalLink, Undo2 } from 'lucide-vue-next'
import { fetchHistory, formatDate, type HistoryEntry, type HistoryOrigin, type HistoryTarget, type HistoryWebRequest } from '../../lib/history'
import HistoryEntryDetail from './HistoryEntryDetail.vue'
import TimelineNote from '../TimelineNote.vue'
import SourceMeta from '../SourceMeta.vue'
import ScoreBar from '../ScoreBar.vue'
import { scoreBarFull } from '../../lib/score-bar'
import AgentInfo from '../AgentInfo.vue'
import { hostOf, shortUrlsIn } from '../../lib/url'

/**
 * 查核履歷區塊（政見頁／人物頁／分析頁共用）：預設展開、標題帶筆數；時間軸每筆可個別收合看驗證者與改動。
 * 字級規則（2026-10-06，維護者）：區塊「內容」不用粗體、不加大字，全部同一級 text-xs（原本中繼資料就是這一級）；層次只靠顏色與膠囊底色分，不靠粗細或大小。
 * 標題列（圖示＋標題＋筆數）不在此限，維持跟頁面上其他區塊標題一致。狀態、型別膠囊保留顏色、不粗。
 * 這條規則涵蓋子元件 HistoryEntryDetail、TimelineNote、ScoreBar；之後在這些元件加東西，也別再加 font-bold／font-medium 或 text-sm 以上。
 * 沿革：2026-09-17 曾把摘要那句從預設 16px 粗體降到 text-sm font-medium，免得在 12px 的中繼資料裡跳得像主標；10-06 再往前一步，連 text-sm 與粗體都拿掉。
 * 提交者代號（agent_name）與模型名（agent_tool）怎麼露出由 agentDisplay 決定（2026-10-08，維護者，#457、#475）：政見頁與候選人頁傳 'icon'，
 * 代號與模型合成一顆人形圖示（AgentInfo），滑過或點一下才看得到；預設 'inline' 直接寫在文字裡（貢獻看板這類透明度頁面、公民提問的處理紀錄）。
 * 沒有貢獻紀錄時顯示資料來源說明（匯入的 source_url／source_note），不留空白。
 */
const props = withDefaults(defineProps<{ target: HistoryTarget; id: string; title?: string; compact?: boolean; agentDisplay?: 'inline' | 'icon' }>(), { title: '查核履歷', compact: false, agentDisplay: 'inline' })
const emit = defineEmits<{ loaded: [payload: { total: number; appliedCount: number }] }>()

const open = ref(true)
const loading = ref(false)
const error = ref<string | null>(null)
const entries = ref<HistoryEntry[]>([])
const origin = ref<HistoryOrigin | null>(null)
const webRequests = ref<HistoryWebRequest[]>([])
const total = ref<number | null>(null)
const hasMore = ref(false)
const nextCursor = ref<string | null>(null)
const expanded = ref<Set<string>>(new Set())
const appliedCount = computed(() => entries.value.filter(e => e.status === 'applied').length)

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
    if (!cursor) webRequests.value = body.web_requests ?? []
    total.value = body.total
    hasMore.value = body.has_more
    nextCursor.value = body.next_cursor
    emit('loaded', { total: total.value ?? 0, appliedCount: appliedCount.value })
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

// 筆數改用藥丸標籤呈現（2026-09-18），跟同一頁的公民提問一致；標題本身只留字
const countBadge = computed(() => (total.value !== null && total.value > 0 ? total.value : null))

onMounted(() => { load() })
watch(() => props.id, () => { entries.value = []; webRequests.value = []; total.value = null; expanded.value = new Set(); load() })
</script>

<template>
  <section :class="['bg-white rounded-xl border border-slate-200 shadow-sm', compact ? 'p-4' : 'p-6']" data-testid="history-panel">
    <button type="button" class="w-full flex items-center justify-between gap-3 text-left" data-testid="history-toggle" :aria-expanded="open" @click="open = !open">
      <span :class="['font-bold text-navy-900 flex items-center gap-2', compact ? 'text-base' : 'text-xl']">
        <History class="text-slate-400" :size="compact ? 18 : 22" /> {{ title }}
        <span v-if="countBadge" class="text-xs font-black text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{{ countBadge }}</span>
        <Loader2 v-if="loading && total === null" :size="14" class="animate-spin text-slate-400" />
      </span>
      <!-- 只留箭頭（2026-09-17）：箭頭本身就在講開合，旁邊再寫「收合」是同一件事說兩次。
           title 留著，滑過去與讀螢幕的人仍讀得到。 -->
      <span class="text-slate-400" :title="open ? '收合' : (total === 0 ? '看來源' : '展開')">
        <component :is="open ? ChevronUp : ChevronDown" :size="18" />
      </span>
    </button>
    <!-- 收合時那句說明也走時間軸格式（2026-09-18），跟展開後的紀錄、跟政見頁公民提問一致 -->
    <TimelineNote
      v-if="!open && total !== null"
      class="mt-3"
      :label="total > 0 ? '已查核' : '尚未查核'"
      :text="total > 0 ? '這筆資料由 AI 代理提交、其他代理驗證後上線；展開看是誰查的、誰審的、改過什麼。' : (origin?.note ?? '這筆資料尚未經過 AI 貢獻流程')"
    />

    <div v-if="open" class="mt-4" data-testid="history-body">
      <!-- 網站請求（2026-10-28）：訪客按「請 AI 幫忙查」留下的紀錄，只有日期、查什麼、狀態 -->
      <div v-if="webRequests.length > 0" class="mb-4" data-testid="history-web-requests">
        <p class="text-xs font-bold text-slate-500 mb-2">網站請求（{{ webRequests.length }}）</p>
        <ol class="relative border-l-2 border-slate-200 ml-2 space-y-3">
          <li v-for="r in webRequests" :key="r.id" class="relative pl-6" data-testid="history-web-request" :data-status="r.status">
            <span :title="r.status_label" :class="['absolute -left-[7px] top-1.5 w-3 h-3 rounded-full border-2 border-white ring-2 ring-slate-100', r.status === 'closed' ? 'bg-emerald-500' : r.status === 'parked' ? 'bg-slate-300' : 'bg-amber-400']"></span>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-mono text-slate-400">{{ formatDate(r.created_at) }}</span>
              <span class="px-2 py-0.5 rounded-full bg-violet-50 text-violet-700">網站請求</span>
              <span class="text-slate-700">{{ r.kind_label }}</span>
              <span class="text-slate-500">{{ r.status_label }}<template v-if="r.closed_at">（{{ formatDate(r.closed_at) }}）</template></span>
            </div>
          </li>
        </ol>
      </div>
      <div v-if="loading && entries.length === 0" class="py-6 text-center text-xs text-slate-500"><Loader2 :size="22" class="animate-spin mx-auto mb-1 text-blue-500" />載入中…</div>
      <div v-else-if="error" class="py-4 text-center text-xs" data-testid="history-error">
        <AlertCircle :size="22" class="mx-auto mb-1 text-red-500" />
        <p class="text-slate-700">暫時讀不到履歷</p>
        <button type="button" class="mt-2 px-3 py-1.5 rounded-lg bg-navy-900 text-white text-xs" @click="load()">再試一次</button>
      </div>
      <!-- 還沒有貢獻紀錄：排在同一條時間軸上講一句（2026-09-18），
           格式跟下面的紀錄、跟政見頁「還沒有人問」一致，不再是框外的一段小字。
           來源網址是讀者唯一能往下追的東西，接在這句後面。 -->
      <div v-else-if="entries.length === 0" data-testid="history-empty">
        <TimelineNote label="尚未查核" :text="origin?.note ?? '這筆資料尚未經過 AI 貢獻流程'">
          <div class="mt-1 space-y-1">
            <a v-if="origin?.source_url" :href="origin.source_url" target="_blank" rel="noopener" class="text-xs text-blue-700 underline underline-offset-2 break-all inline-flex items-start gap-1"><ExternalLink :size="12" class="mt-0.5 flex-shrink-0" />{{ hostOf(origin.source_url) }}</a>
            <SourceMeta v-if="origin?.source" :kind="origin.source.kind" :self-evidence="origin.source.self_evidence" :archive-url="origin.source.archive_url" class="ml-2" />
            <ul v-if="origin?.source_notes?.length" class="list-disc pl-5 text-xs text-slate-500">
              <li v-for="n in origin.source_notes" :key="n">{{ n }}</li>
            </ul>
          </div>
        </TimelineNote>
      </div>
      <ol v-else class="relative border-l-2 border-slate-200 ml-2 space-y-4" data-testid="history-list">
        <li v-for="e in entries" :key="e.id" class="relative pl-6" data-testid="history-entry" :data-status="e.status">
          <span :title="e.status_label" :class="['absolute -left-[7px] top-1.5 w-3 h-3 rounded-full border-2 border-white ring-2', e.reverted ? 'bg-slate-300 ring-slate-100' : e.status === 'applied' ? 'bg-emerald-500 ring-emerald-100' : e.status === 'disputed' ? 'bg-orange-500 ring-orange-100' : e.status === 'rejected' ? 'bg-red-700 ring-red-100' : 'bg-amber-400 ring-amber-100']"></span>
          <!-- 日期那一列放在按鈕外面、自己接點擊：列尾有 AgentInfo（本身是按鈕），按鈕不能包按鈕。
               鍵盤展開／收合走下面摘要那顆按鈕，這一列只是讓滑鼠與手指點到這裡也一樣能開合。 -->
          <div class="flex flex-wrap items-center gap-2 text-xs cursor-pointer" @click="toggleEntry(e.id)">
              <span class="font-mono text-slate-400">{{ formatDate(e.at) }}</span>
              <span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{{ e.type_label }}</span>
              <!-- 已上線不再標籤（2026-09-17）：左邊那顆綠點講的就是這件事。
                   其他狀態留著——點只分得出綠（已上線）／橘（爭議）／琥珀（其餘），
                   「待驗證」與「驗證中」靠這個標籤才分得出來。 -->
              <span v-if="e.status !== 'applied'" :class="['px-2 py-0.5 rounded-full', STATUS_CLASS[e.status] ?? 'bg-slate-100 text-slate-600']">{{ e.status_label }}</span>
              <!-- 改了幾處放在上面這一列（2026-09-17）：它跟型別、狀態一樣是這筆的屬性，
                   擺在下面那排跟「誰提交、幾票」混在一起，看的人要掃兩遍 -->
              <span v-if="e.edits.length" class="text-slate-500">改動 {{ e.edits.length }} 處</span>
              <span v-if="e.reverted" class="text-amber-700 inline-flex items-center gap-1"><Undo2 :size="11" /> 已還原</span>
              <!-- 提交者與分數條接在日期那一列後面（2026-10-18，維護者）；滿格（達標上線或跌到退件）就不畫條，狀態已經講完了。
                   條件跟 ScoreBar 的填色同一套（lib/score-bar.ts scoreBarFull）。 -->
              <AgentInfo v-if="agentDisplay === 'icon'" :name="e.agent_name" :model="e.agent_tool" label="提交者" />
              <span v-else class="text-slate-500">提交：<span class="text-slate-700">{{ e.agent_name ?? '?' }}</span><span v-if="e.agent_tool" class="text-slate-400">・{{ e.agent_tool }}</span></span>
              <!-- 已上線的不畫：中選會自動查證等不經投票的路徑是 0 分上線，條會停在中間像還在等票（維護者 2026-10-25） -->
              <ScoreBar v-if="e.status !== 'applied' && !scoreBarFull(e.score, e.target_score)":score="e.score" :target="e.target_score" :agree="e.agree_count" :disagree="e.disagree_count" :unsure="e.unsure_count" />
              <span v-if="e.adjudications.length" class="text-slate-500">有裁決</span>
              <component :is="expanded.has(e.id) ? ChevronUp : ChevronDown" :size="14" class="ml-auto text-slate-400" />
            </div>
            <!-- 同一級大小、不粗（2026-09-17 降級，2026-10-06 再統一成 text-xs）：這是履歷的一列，不是標題，
                 原本用預設 16px 粗體，在一堆 12px 的中繼資料裡跳得像頁面主標 -->
          <button type="button" class="w-full text-left" :aria-expanded="expanded.has(e.id)" @click="toggleEntry(e.id)">
            <p :class="['mt-1 text-xs text-navy-900 leading-snug break-words', e.reverted ? 'line-through decoration-slate-400 text-slate-500' : '']">{{ shortUrlsIn(e.detail || e.summary) }}</p>
          </button>
          <div v-if="expanded.has(e.id)" class="mt-2 rounded-lg bg-slate-50 border border-slate-100 p-3">
            <HistoryEntryDetail :entry="e" :agent-display="agentDisplay" />
          </div>
        </li>
      </ol>
      <div v-if="hasMore" class="mt-4 text-center">
        <button type="button" class="px-4 py-2 rounded-lg bg-white border border-slate-300 text-xs text-navy-900 hover:bg-slate-50" :disabled="loading" @click="load(nextCursor)" data-testid="history-more">
          <Loader2 v-if="loading" :size="14" class="animate-spin inline mr-1" />載入更多
        </button>
      </div>
    </div>
  </section>
</template>
