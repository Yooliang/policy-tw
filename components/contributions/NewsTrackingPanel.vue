<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Newspaper } from 'lucide-vue-next'
import { supabasePublic } from '../../lib/supabase'
import { withTimeoutAndRetry } from '../../lib/retry'

/**
 * 新聞追蹤（2026-09-29）：每小時收媒體與縣市政府新聞、逐則存下，由 Jev 初篩後把有關的派給代理。
 * 這張表回答「收了多少、有幾則跟政見有關、派出去的做完了沒」——原本整份 RSS 一件任務的做法這些都數不到。
 * 資料是 news_daily_stats(天數)，資料庫端依台北日期聚合。
 */
const props = withDefaults(defineProps<{ days?: number; rangeLabel?: string }>(), { days: 7, rangeLabel: '7D' })

interface Row {
  day: string
  fetched: number
  screened: number
  related_progress: number
  related_new: number
  tasks: number
  submissions: number
  applied: number
}

const rows = ref<Row[]>([])
const failed = ref(false)
const loaded = ref(false)

async function load() {
  const days = props.days
  failed.value = false
  try {
    const { data, error } = await withTimeoutAndRetry(`news_daily_stats ${days}d`, (signal) =>
      supabasePublic.rpc('news_daily_stats', { p_days: days }).abortSignal(signal))
    if (error) throw error
    // 資料庫回的 bigint 會變成字串，這裡一律轉數字
    if (days === props.days) {
      rows.value = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        day: String(r.day),
        fetched: Number(r.fetched), screened: Number(r.screened),
        related_progress: Number(r.related_progress), related_new: Number(r.related_new),
        tasks: Number(r.tasks), submissions: Number(r.submissions), applied: Number(r.applied),
      }))
    }
  } catch {
    failed.value = true
  } finally {
    loaded.value = true
  }
}
onMounted(load)
watch(() => props.days, load)

const total = computed(() => rows.value.reduce((t, r) => ({
  fetched: t.fetched + r.fetched,
  related: t.related + r.related_progress + r.related_new,
  tasks: t.tasks + r.tasks,
  applied: t.applied + r.applied,
}), { fetched: 0, related: 0, tasks: 0, applied: 0 }))
const hasAny = computed(() => rows.value.some((r) => r.fetched > 0))
/** 「09-29」就好，年份在這張表裡沒有資訊量 */
function shortDay(d: string): string {
  return d.length >= 10 ? d.slice(5, 10) : d
}
</script>

<template>
  <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="news-tracking">
    <h3 class="font-black text-navy-900 mb-1 flex items-center gap-2"><Newspaper :size="18" class="text-rose-600" />新聞追蹤({{ rangeLabel }})</h3>
    <p class="text-xs text-slate-500 mb-3">每小時收媒體與縣市政府的新聞，由系統先篩出跟政見有關的，再派給代理查證。</p>
    <p v-if="loaded && failed" class="text-sm text-slate-500">暫時讀不到統計。</p>
    <p v-else-if="loaded && !hasAny" class="text-sm text-slate-500">還沒有資料（2026-09-29 開始記錄）。</p>
    <template v-else-if="loaded">
      <p class="text-sm text-slate-600 mb-2">
        共收 <b class="text-navy-900 tabular-nums">{{ total.fetched.toLocaleString() }}</b> 則，
        有關 <b class="text-navy-900 tabular-nums">{{ total.related.toLocaleString() }}</b> 則，
        派出 <b class="text-navy-900 tabular-nums">{{ total.tasks.toLocaleString() }}</b> 件，
        上線 <b class="text-navy-900 tabular-nums">{{ total.applied.toLocaleString() }}</b> 筆
      </p>
      <div class="max-h-72 overflow-auto">
        <table class="w-full text-sm tabular-nums">
          <thead class="text-xs text-slate-400 sticky top-0 bg-white">
            <tr>
              <th class="text-left font-bold py-1">日期</th>
              <th class="text-right font-bold py-1" title="這一天收進來幾則新聞">收錄</th>
              <th class="text-right font-bold py-1" title="系統初篩判過幾則">已篩</th>
              <th class="text-right font-bold py-1" title="跟某條既有政見的進度有關／某人提出新承諾">進度／新政見</th>
              <th class="text-right font-bold py-1" title="派給代理的任務">派出</th>
              <th class="text-right font-bold py-1" title="那些任務收到的交件（含查無異動）">交件</th>
              <th class="text-right font-bold py-1" title="交件中已驗證上線的資料">上線</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.day" class="border-t border-slate-100">
              <td class="py-1 text-slate-600">{{ shortDay(r.day) }}</td>
              <td class="py-1 text-right text-slate-800">{{ r.fetched }}</td>
              <td class="py-1 text-right text-slate-500">{{ r.screened }}</td>
              <td class="py-1 text-right text-slate-800">{{ r.related_progress }}／{{ r.related_new }}</td>
              <td class="py-1 text-right text-slate-800">{{ r.tasks }}</td>
              <td class="py-1 text-right text-slate-800">{{ r.submissions }}</td>
              <td class="py-1 text-right font-black text-navy-900">{{ r.applied }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
