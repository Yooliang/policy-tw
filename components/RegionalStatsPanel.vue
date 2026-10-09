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
  <div v-if="region" class="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="regional-stats-panel">
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
