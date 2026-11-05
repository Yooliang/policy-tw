<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { fetchHistory, type HistoryEntry } from '../../lib/history'
import { withTimeoutAndRetry } from '../../lib/retry'
import { shortUrlsIn } from '../../lib/url'
import HistoryEntryDetail from './HistoryEntryDetail.vue'
import LoadError from '../LoadError.vue'

/**
 * 單筆貢獻的內容：展開時才讀（history?target=contribution），顯示的就是動態牆展開後那一份
 * （摘要、更新內容、來源、驗證者與理由、裁決），不另寫一套。網站請求下的每一筆交件共用。
 */
const props = withDefaults(defineProps<{ id: string; agentDisplay?: 'inline' | 'icon' }>(), { agentDisplay: 'inline' })

const entry = ref<HistoryEntry | null>(null)
const loading = ref(false)
const error = ref(false)

async function load() {
  loading.value = true
  error.value = false
  try {
    const body = await withTimeoutAndRetry(`history contribution ${props.id}`, (signal) => fetchHistory('contribution', props.id, { limit: 1, signal }))
    entry.value = body.entries[0] ?? null
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>

<template>
  <div data-testid="contribution-detail">
    <p v-if="loading" class="text-xs text-slate-400 inline-flex items-center gap-1"><Loader2 :size="12" class="animate-spin" /> 載入中…</p>
    <LoadError v-else-if="error" inline message="這筆交件暫時讀不到" @retry="load" />
    <div v-else-if="entry" class="space-y-3">
      <p class="text-xs text-slate-700 break-words">{{ shortUrlsIn(entry.detail || entry.summary) }}</p>
      <HistoryEntryDetail :entry="entry" :agent-display="agentDisplay" />
    </div>
  </div>
</template>
