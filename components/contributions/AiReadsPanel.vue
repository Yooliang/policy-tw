<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Bot } from 'lucide-vue-next'
import { supabasePublic } from '../../lib/supabase'
import { withTimeoutAndRetry } from '../../lib/retry'

/**
 * 被 AI 讀了幾次（2026-09-23）：AI 時代只看瀏覽數會低估正見的影響——AI 讀完直接回答使用者，人不一定點進來。
 * 資料是正見.tw 的 Worker 依 User-Agent／Referer 分類後的每日計數（ai_reads_daily，cloudflare/ai-reads.js）。
 * 被 Cloudflare 在邊緣擋掉的請求進不到 Worker，數不到。
 */

// 跟著統計頁的時間窗（2026-09-24）；資料庫端加總（90 天的逐日列會超過 1,000 列上限）
const props = withDefaults(defineProps<{ days?: number; rangeLabel?: string }>(), { days: 7, rangeLabel: '7D' })

interface Row { kind: string; agent: string; hits: number }

const KIND_LABEL: Record<string, { label: string; hint: string }> = {
  ai_user: { label: 'AI 當場來讀', hint: '有人問 AI，AI 當場讀正見來回答' },
  ai_referral: { label: '從 AI 點進來的人', hint: '在 AI 的回答裡點了正見的連結' },
  ai_search: { label: 'AI 搜尋建索引', hint: 'AI 搜尋服務收錄正見的頁面' },
  ai_training: { label: 'AI 訓練抓取', hint: '大量抓資料訓練模型' },
  search_engine: { label: '傳統搜尋引擎', hint: 'Google、Bing 等（對照用）' },
}
const KIND_ORDER = ['ai_user', 'ai_referral', 'ai_search', 'ai_training', 'search_engine']

const rows = ref<Row[]>([])
const failed = ref(false)
const loaded = ref(false)

async function load() {
  const days = props.days
  failed.value = false
  try {
    const { data, error } = await withTimeoutAndRetry(`ai_reads_summary ${days}d`, (signal) =>
      supabasePublic.rpc('ai_reads_summary', { p_days: days }).abortSignal(signal))
    if (error) throw error
    if (days === props.days) rows.value = ((data ?? []) as Row[]).map((r) => ({ ...r, hits: Number(r.hits) }))
  } catch {
    failed.value = true
  } finally {
    loaded.value = true
  }
}
onMounted(load)
watch(() => props.days, load)

const byKind = computed(() => KIND_ORDER.map((kind) => {
  const list = rows.value.filter((r) => r.kind === kind)
  const total = list.reduce((s, r) => s + r.hits, 0)
  const agents = new Map<string, number>()
  for (const r of list) agents.set(r.agent, (agents.get(r.agent) ?? 0) + r.hits)
  const top = [...agents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a} ${n}`)
  return { kind, ...KIND_LABEL[kind], total, top }
}))
</script>

<template>
  <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="ai-reads">
    <h3 class="font-black text-navy-900 mb-1 flex items-center gap-2"><Bot :size="18" class="text-violet-600" />AI 讀取({{ rangeLabel }})</h3>
    <p class="text-xs text-slate-500 mb-3">AI 讀完正見直接回答使用者，不一定有人點進來；這裡數的是正見.tw 被讀了幾次。</p>
    <p v-if="loaded && failed" class="text-sm text-slate-500">暫時讀不到統計。</p>
    <p v-else-if="loaded && rows.length === 0" class="text-sm text-slate-500">還沒有資料（2026-09-23 開始記錄）。</p>
    <table v-else-if="loaded" class="w-full text-sm">
      <tbody>
        <tr v-for="k in byKind" :key="k.kind" class="border-t border-slate-100 first:border-t-0">
          <td class="py-1.5 pr-2">
            <div class="font-medium text-slate-800">{{ k.label }}</div>
            <div class="text-xs text-slate-400">{{ k.top.length ? k.top.join('、') : k.hint }}</div>
          </td>
          <td class="py-1.5 text-right font-black text-navy-900 tabular-nums">{{ k.total.toLocaleString() }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
