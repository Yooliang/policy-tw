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
/** 卡片標題的地名：有鄉鎮寫鄉鎮，否則縣市 */
const placeName = computed(() => props.subRegion && props.subRegion !== 'All' ? props.subRegion : props.region ?? '')
/** 四項全缺：整張卡收成一行淡色字（2026-10-31 小良哥：不要「未調查」重複四次） */
const allMissing = computed(() => rows.value.length > 0 && rows.value.every(r => !r.stat))
</script>

<template>
  <!-- 窄欄（選舉頁右欄與手機內容最下方）：標題＋地名，2×2 數據格（上小標籤、下大數值，數值連到出處）；缺值的格子顯示淡色「—」，四項全缺收成一行 -->
  <p v-if="region && compact && allMissing" class="px-1 text-xs text-slate-400" data-testid="regional-stats-panel">{{ placeName }}地區資料未調查</p>
  <div v-else-if="region && compact" class="w-full max-w-[300px] rounded-xl border border-slate-200 bg-white p-4" data-testid="regional-stats-panel">
    <div class="mb-3 flex items-baseline gap-2 text-xs">
      <span class="font-bold text-slate-500">地區資料</span>
      <span class="truncate text-slate-400">{{ placeName }}</span>
    </div>
    <dl class="grid grid-cols-2 gap-x-4 gap-y-3">
      <div v-for="row in rows" :key="row.statKey" class="min-w-0">
        <dt class="text-[11px] text-slate-500">{{ row.label }}</dt>
        <dd v-if="row.stat" class="mt-0.5 tabular-nums leading-tight">
          <a :href="row.stat.sourceUrl" target="_blank" rel="noopener noreferrer" :title="`${row.stat.year} 年`" class="text-lg font-bold text-navy-900 hover:text-blue-700">{{ row.stat.value.toLocaleString('zh-TW') }}</a><span class="ml-0.5 text-[11px] text-slate-500">{{ row.stat.unit }}</span>
        </dd>
        <dd v-else class="mt-0.5 text-lg leading-tight text-slate-300">—</dd>
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
