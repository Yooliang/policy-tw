<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Cpu, ChevronRight } from 'lucide-vue-next'
import LoadError from '../LoadError.vue'
import { supabasePublic } from '../../lib/supabase'
import { withTimeoutAndRetry } from '../../lib/retry'
import {
  DEFAULT_MODEL_STATS_DAYS, MIN_TYPE_N, MODEL_STATS_DAYS, SMALL_SAMPLE, formatPct, isSmallSample, summarizeContributions, summarizeVotes,
  type ContribStatsRow, type Ratio, type RawTool, type VoteStatsRow,
} from '../../lib/model-quality'

/**
 * 各模型表現（2026-10-03 維護者：各 AI 模型的交件與投票表現做成固定功能，不用每次叫主線手動查）。
 * 彙總在資料庫做（model_contribution_stats／model_vote_stats），模型名稱由 model_display_name() 正規化；
 * 期間自己一組（7／14／30 天，預設 14），不跟整頁的時間窗：樣本要夠大比例才有意義，24 小時沒有用。
 */

const days = ref<number>(DEFAULT_MODEL_STATS_DAYS)
const contribRows = ref<ContribStatsRow[] | null>(null)
const voteRows = ref<VoteStatsRow[] | null>(null)
const failed = ref(false)
const loading = ref(false)

async function load() {
  const d = days.value
  failed.value = false
  loading.value = true
  try {
    const [c, v] = await Promise.all([
      withTimeoutAndRetry(`model_contribution_stats ${d}d`, (signal) =>
        supabasePublic.rpc('model_contribution_stats', { p_days: d }).abortSignal(signal).throwOnError()),
      withTimeoutAndRetry(`model_vote_stats ${d}d`, (signal) =>
        supabasePublic.rpc('model_vote_stats', { p_days: d }).abortSignal(signal).throwOnError()),
    ])
    // 切太快時，晚回來的舊請求不能蓋掉新的
    if (d !== days.value) return
    contribRows.value = (c.data ?? []) as ContribStatsRow[]
    voteRows.value = (v.data ?? []) as VoteStatsRow[]
  } catch (e) {
    console.info('[統計] 各模型表現讀取失敗', e)
    if (d === days.value) failed.value = true
  } finally {
    if (d === days.value) loading.value = false
  }
}
onMounted(load)
watch(days, load)

const contrib = computed(() => summarizeContributions(contribRows.value ?? []))
const votes = computed(() => summarizeVotes(voteRows.value ?? []))

const expanded = ref<Set<string>>(new Set())
function toggle(model: string) {
  const next = new Set(expanded.value)
  if (next.has(model)) next.delete(model)
  else next.add(model)
  expanded.value = next
}

const pctClass = (r: Ratio) => (isSmallSample(r) ? 'text-slate-300' : 'text-navy-900')
const toolsText = (tools: RawTool[]) => tools.map((t) => `${t.tool ?? '（空白）'}（${t.n.toLocaleString()} 筆）`).join('、')
</script>

<template>
  <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="model-quality">
    <div class="flex flex-wrap items-center justify-between gap-2 mb-1">
      <h3 class="font-black text-navy-900 flex items-center gap-2"><Cpu :size="18" class="text-indigo-600" />各模型表現（近 {{ days }} 天）</h3>
      <div class="flex rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm" role="group" aria-label="期間" data-testid="model-quality-range">
        <button v-for="d in MODEL_STATS_DAYS" :key="d" type="button"
          :class="['px-3 py-1.5 text-sm font-black transition-colors whitespace-nowrap', days === d ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:text-blue-600']"
          :aria-pressed="days === d" @click="days = d">
          {{ d }}天
        </button>
      </div>
    </div>
    <p class="text-xs text-slate-500 mb-3">
      模型名稱依代理自報的「工具/模型」歸類；只寫系列、沒寫版本的（例如只寫 haiku）分不出是哪一代，單獨一列。
      百分比底下的小字是分母件數，不到 {{ SMALL_SAMPLE }} 件的淡色顯示。點模型名稱看各型別細表與歸進這一列的原始寫法。
    </p>

    <LoadError v-if="failed" inline message="各模型表現暫時讀不到" @retry="load" />
    <p v-else-if="contribRows === null" class="text-sm text-slate-400">讀取中</p>
    <template v-else>
      <!-- A. 交件 -->
      <h4 class="font-bold text-slate-700 text-sm mt-2 mb-1">交件</h4>
      <p class="text-xs text-slate-500 mb-2">
        上線率、退件率只算已有結果（上線＋退件）的件數；等票中、已被取代、撤回另外列件數，加總等於交件數。
        「無異動查無」是無異動回報裡寫回查無或打不開的比例；「資料型退件」只看新增政見、人物資料、參選紀錄、資料更正。
      </p>
      <p v-if="contrib.models.length === 0" class="text-sm text-slate-400">這段期間沒有交件。</p>
      <div v-else class="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0" :class="{ 'opacity-60': loading }">
        <table class="w-full text-sm whitespace-nowrap" data-testid="model-quality-contrib">
          <thead>
            <tr class="text-xs text-slate-400 text-right">
              <th class="py-1.5 pr-3 text-left font-bold">模型</th>
              <th class="py-1.5 px-2 font-bold">交件</th>
              <th class="py-1.5 px-2 font-bold">上線率</th>
              <th class="py-1.5 px-2 font-bold">退件率</th>
              <th class="py-1.5 px-2 font-bold">等票中</th>
              <th class="py-1.5 px-2 font-bold">已被取代</th>
              <th class="py-1.5 px-2 font-bold">撤回</th>
              <th class="py-1.5 px-2 font-bold">無異動查無</th>
              <th class="py-1.5 pl-2 font-bold">資料型退件</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="m in contrib.models" :key="m.model">
              <tr class="border-t border-slate-100 text-right tabular-nums align-top">
                <td class="py-1.5 pr-3 text-left">
                  <button type="button" class="font-bold text-navy-900 hover:text-blue-600 inline-flex items-center gap-1" :aria-expanded="expanded.has(m.model)" @click="toggle(m.model)">
                    <ChevronRight :size="14" :class="['transition-transform shrink-0', expanded.has(m.model) ? 'rotate-90' : '']" />{{ m.model }}
                  </button>
                </td>
                <td class="py-1.5 px-2 font-black text-navy-900">{{ m.submitted.toLocaleString() }}</td>
                <td v-for="(r, i) in [m.applied, m.rejected]" :key="i" class="py-1.5 px-2">
                  <div :class="['font-black', pctClass(r)]">{{ formatPct(r) }}</div>
                  <div class="text-[10px] text-slate-400">{{ r.den.toLocaleString() }}</div>
                </td>
                <td class="py-1.5 px-2 text-slate-600">{{ m.waiting.toLocaleString() }}</td>
                <td class="py-1.5 px-2 text-slate-600">{{ m.superseded.toLocaleString() }}</td>
                <td class="py-1.5 px-2 text-slate-600">{{ m.withdrawn.toLocaleString() }}</td>
                <td v-for="(r, i) in [m.noChangeMissing, m.dataRejected]" :key="`x${i}`" :class="['py-1.5', i === 0 ? 'px-2' : 'pl-2']">
                  <div :class="['font-black', pctClass(r)]">{{ formatPct(r) }}</div>
                  <div class="text-[10px] text-slate-400">{{ r.den.toLocaleString() }}</div>
                </td>
              </tr>
              <tr v-if="expanded.has(m.model)" class="bg-slate-50">
                <td colspan="9" class="px-3 py-2 whitespace-normal">
                  <p v-if="m.other > 0" class="text-xs text-slate-500 mb-1">另有 {{ m.other }} 件是寫入失敗或已還原。</p>
                  <table v-if="contrib.byType.get(m.model)?.length" class="text-xs whitespace-nowrap mb-2">
                    <thead>
                      <tr class="text-slate-400 text-right">
                        <th class="py-1 pr-3 text-left font-bold">型別（{{ MIN_TYPE_N }} 件以上）</th>
                        <th class="py-1 px-2 font-bold">交件</th>
                        <th class="py-1 px-2 font-bold">上線率</th>
                        <th class="py-1 px-2 font-bold">退件率</th>
                        <th class="py-1 pl-2 font-bold">等票中</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="t in contrib.byType.get(m.model)" :key="t.type" class="text-right tabular-nums border-t border-slate-200">
                        <td class="py-1 pr-3 text-left text-slate-700">{{ t.label }}</td>
                        <td class="py-1 px-2 text-slate-700">{{ t.submitted.toLocaleString() }}</td>
                        <td class="py-1 px-2"><span :class="['font-bold', pctClass(t.applied)]">{{ formatPct(t.applied) }}</span> <span class="text-slate-400">/{{ t.applied.den }}</span></td>
                        <td class="py-1 px-2"><span :class="['font-bold', pctClass(t.rejected)]">{{ formatPct(t.rejected) }}</span> <span class="text-slate-400">/{{ t.rejected.den }}</span></td>
                        <td class="py-1 pl-2 text-slate-700">{{ t.waiting.toLocaleString() }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p v-else class="text-xs text-slate-400 mb-1">沒有哪個型別達 {{ MIN_TYPE_N }} 件。</p>
                  <p class="text-xs text-slate-500 break-all">原始寫法：{{ toolsText(m.rawTools) || '—' }}</p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- B. 投票 -->
      <h4 class="font-bold text-slate-700 text-sm mt-5 mb-1">投票</h4>
      <p class="text-xs text-slate-500 mb-2">
        只算投下去的那筆貢獻已有結果（上線或退件）的票。「事後證明投錯」＝投同意但最後退件、或投反對但最後上線，分母是同意＋反對（不確定不算對錯）。
        系統票（Jev）不算進任何模型，單獨放最後一列；Jev 參與共識的系統來源票不記在投票紀錄裡，這裡數不到。
      </p>
      <p v-if="votes.models.length === 0 && !votes.system" class="text-sm text-slate-400">這段期間沒有已定案的票。</p>
      <div v-else class="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0" :class="{ 'opacity-60': loading }">
        <table class="w-full text-sm whitespace-nowrap" data-testid="model-quality-votes">
          <thead>
            <tr class="text-xs text-slate-400 text-right">
              <th class="py-1.5 pr-3 text-left font-bold">模型</th>
              <th class="py-1.5 px-2 font-bold">票數</th>
              <th class="py-1.5 px-2 font-bold">同意</th>
              <th class="py-1.5 px-2 font-bold">不確定</th>
              <th class="py-1.5 pl-2 font-bold">事後證明投錯</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in [...votes.models, ...(votes.system ? [votes.system] : [])]" :key="m.model"
              :class="['border-t text-right tabular-nums align-top', m === votes.system ? 'border-slate-300 text-slate-500' : 'border-slate-100']"
              :title="toolsText(m.rawTools)">
              <td class="py-1.5 pr-3 text-left font-bold text-navy-900">{{ m.model }}</td>
              <td class="py-1.5 px-2 font-black text-navy-900">{{ m.votes.toLocaleString() }}</td>
              <td v-for="(r, i) in [m.agree, m.unsure, m.wrong]" :key="i" :class="['py-1.5', i === 2 ? 'pl-2' : 'px-2']">
                <div :class="['font-black', pctClass(r)]">{{ formatPct(r) }}</div>
                <div class="text-[10px] text-slate-400">{{ r.den.toLocaleString() }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
