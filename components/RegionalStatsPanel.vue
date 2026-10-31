<script setup lang="ts">
/**
 * 地方基本統計（issue #508）：縣市或鄉鎮市區的人口、面積、總預算歲出、65 歲以上比例。
 * 沒有資料顯示「未調查」（照「讓資料自己說話」，不放方法論說明文字，只有標籤與出處連結）。
 */
import { computed } from 'vue'
import { Users, Map as MapIcon, Wallet, HeartPulse } from 'lucide-vue-next'
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
/** 窄卡的短標題與圖示（人口／面積／預算／高齡），高齡格標題旁另有小字「65+」 */
const SHORT: Record<string, { title: string; icon: typeof Users }> = {
  population: { title: '人口', icon: Users },
  area_km2: { title: '面積', icon: MapIcon },
  budget_expenditure: { title: '預算', icon: Wallet },
  aging_rate: { title: '高齡', icon: HeartPulse },
}
/** 精簡顯示（200px 放不下完整數字）：人口 243.9 萬、面積 271.8 km²、預算 2,140 億（資料單位是千元）、高齡 24.2%；完整數字放在 title 提示 */
function brief(statKey: string, value: number): { num: string; unit: string } {
  const n1 = (v: number) => v.toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  if (statKey === 'population') return value >= 10000 ? { num: n1(value / 10000), unit: '萬' } : { num: value.toLocaleString('zh-TW'), unit: '人' }
  if (statKey === 'area_km2') return { num: n1(value), unit: 'km²' }
  if (statKey === 'budget_expenditure') {
    const yuan = value * 1000
    if (yuan >= 1e8) return { num: yuan >= 1e10 ? Math.round(yuan / 1e8).toLocaleString('zh-TW') : n1(yuan / 1e8), unit: '億' }
    return { num: Math.round(yuan / 1e4).toLocaleString('zh-TW'), unit: '萬' }
  }
  return { num: n1(value), unit: '%' }
}

/** 卡片標題的地名：有鄉鎮寫鄉鎮，否則縣市 */
const placeName = computed(() => props.subRegion && props.subRegion !== 'All' ? props.subRegion : props.region ?? '')
/** 資料還沒回來（載入中）：同尺寸骨架，右欄下方的廣告位置不會因為卡片忽大忽小而跳動 */
const loading = computed(() => officialRegionalStats.value.length === 0)
</script>

<template>
  <!-- 窄欄（選舉頁右欄與手機內容最下方）：標題＋地名，2×2 數據格（上小標籤、下大數值，數值連到出處）；缺值的格子顯示淡色「—」，四項全缺收成一行 -->
  <!-- 窄欄（選舉頁右欄與手機內容最下方）：只留下方一條框線、無外框圓角；標題只寫地名；2×2 格（icon＋短標題、下面精簡數值，完整數字在 title）；缺值淡色「—」，全缺與載入中也照常畫 2×2（高度不變，載入中數值是脈動骨架） -->
  <div v-if="region && compact" class="w-full border-b border-slate-200 pb-4 pt-4" data-testid="regional-stats-panel">
    <div class="mb-2.5 truncate text-xs font-bold text-slate-500">{{ placeName }}</div>
    <dl class="grid grid-cols-2 gap-x-3 gap-y-3">
      <div v-for="row in rows" :key="row.statKey" class="min-w-0">
        <dt class="flex items-center gap-1 whitespace-nowrap text-[11px] text-slate-500">
          <component :is="SHORT[row.statKey].icon" :size="12" class="shrink-0" aria-hidden="true" />{{ SHORT[row.statKey].title }}<span v-if="row.statKey === 'aging_rate'" class="text-[10px] text-slate-400">65+</span>
        </dt>
        <dd v-if="row.stat" class="mt-0.5 h-6 whitespace-nowrap tabular-nums leading-6">
          <a :href="row.stat.sourceUrl" target="_blank" rel="noopener noreferrer" :title="`${row.stat.value.toLocaleString('zh-TW')} ${row.stat.unit}（${row.stat.year} 年）`" class="text-base font-bold text-navy-900 hover:text-blue-700">{{ brief(row.statKey, row.stat.value).num }}</a><span class="ml-0.5 text-[11px] text-slate-500">{{ brief(row.statKey, row.stat.value).unit }}</span>
        </dd>
        <dd v-else-if="loading" class="mt-0.5 flex h-6 items-center" aria-hidden="true"><span class="h-4 w-12 animate-pulse rounded bg-slate-100"></span></dd>
        <dd v-else class="mt-0.5 h-6 text-base leading-6 text-slate-300">—</dd>
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
