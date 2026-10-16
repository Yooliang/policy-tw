<script setup lang="ts">
/**
 * 地方基本統計（issue #508）：縣市或鄉鎮市區的人口、面積、總預算歲出、65 歲以上比例。
 * 沒有資料顯示「未調查」（照「讓資料自己說話」，不放方法論說明文字，只有標籤與出處連結）。
 */
import { computed } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import { REGIONAL_STAT_KEYS, REGIONAL_STAT_LABEL, regionalStatsFor } from '../lib/regional-stats'

const props = defineProps<{
  region?: string | null
  subRegion?: string | null
  /** 窄欄（選舉頁右側面板）：固定兩欄 */
  compact?: boolean
}>()

const { officialRegionalStats, ensureOfficialRegionalStats } = useSupabase()
ensureOfficialRegionalStats()

const rows = computed(() => {
  if (!props.region) return []
  const found = regionalStatsFor(officialRegionalStats.value, props.region, props.subRegion)
  const byKey = new Map(found.map((f) => [f.statKey, f.stat]))
  return REGIONAL_STAT_KEYS.map((statKey) => ({ statKey, label: REGIONAL_STAT_LABEL[statKey], stat: byKey.get(statKey) ?? null }))
})
</script>

<template>
  <!-- 窄欄（選舉頁右側面板，2026-10-16 維護者）：一張卡片、一項一列，只顯示數值；數值本身連到出處 -->
  <div v-if="region && compact" class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm" data-testid="regional-stats-panel">
    <dl class="divide-y divide-slate-100 text-sm">
      <div v-for="row in rows" :key="row.statKey" class="flex items-baseline justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
        <dt class="text-slate-500">{{ row.label }}</dt>
        <dd v-if="row.stat" class="text-right">
          <a :href="row.stat.sourceUrl" target="_blank" rel="noopener noreferrer" :title="`${row.stat.year} 年`" class="font-bold text-navy-900 hover:text-blue-700">{{ row.stat.value.toLocaleString('zh-TW') }}</a>
          <span class="text-xs text-slate-500 ml-1">{{ row.stat.unit }}</span>
        </dd>
        <dd v-else class="text-slate-400">未調查</dd>
      </div>
    </dl>
  </div>
  <div v-else-if="region" class="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="regional-stats-panel">
    <div v-for="row in rows" :key="row.statKey" class="bg-white rounded-lg border border-slate-200 px-3 py-2">
      <div class="text-xs text-slate-500">{{ row.label }}</div>
      <div v-if="row.stat" class="mt-0.5">
        <span class="text-lg font-bold text-navy-900">{{ row.stat.value.toLocaleString('zh-TW') }}</span>
        <span class="text-xs text-slate-500 ml-1">{{ row.stat.unit }}（{{ row.stat.year }}）</span>
        <a :href="row.stat.sourceUrl" target="_blank" rel="noopener noreferrer" class="block text-xs text-blue-700 underline underline-offset-2 mt-0.5">出處</a>
      </div>
      <div v-else class="mt-0.5 text-sm text-slate-400">未調查</div>
    </div>
  </div>
</template>
