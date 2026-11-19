<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { X } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'
import { useGlobalState } from '../composables/useGlobalState'
import { useDeskFilterPanel } from '../composables/useDeskFilterPanel'
import { ALL_REGIONS } from '../lib/policy-region'
import { TAIWAN_COUNTIES } from '../lib/election-regions'
import { categoryTotal, regionTotal } from '../lib/policy-region-counts'

/**
 * 桌面版的「地區／分類」方塊格（md 以上；手機維持 Hero 內既有的選擇器）。
 * 開關在左欄（useDeskFilterPanel）：地區＝全台＋22 縣市，分類＝全部＋各分類；每格附政見筆數（showCounts 時）。
 * 選了就收起；縣市是全站共用的 globalRegion，分類由頁面用 v-model:category 接。
 * 這個元件只出現在 md 以上，預渲染與 hydrate 時面板一律是收起的，所以不會有 hydration 不一致。
 */
const props = withDefaults(defineProps<{
  /** 目前分類（'All'＝全部）；沒有分類入口的頁不給 */
  category?: string
  /** 這頁有沒有分類格 */
  categoryEnabled?: boolean
  /** 格子上要不要印政見筆數（全部政見頁才印；數據分佈頁的篩選對象不是政見筆數） */
  showCounts?: boolean
  /** 呼叫端自己算格子上的數字（政策脈絡頁的脈絡條數）：給了就不用政見計數；回 null＝還沒載入、不印 */
  counter?: { region: (region: string, category: string) => number | null; category: (region: string, category: string) => number | null; unit: string; suffix: string }
}>(), { category: 'All', categoryEnabled: false, showCounts: false, counter: undefined })
const emit = defineEmits<{ (e: 'update:category', value: string): void }>()

const { categories, policyRegionCounts, ensurePolicyRegionCounts } = useSupabase()
const { globalRegion, setGlobalRegion } = useGlobalState()
const { panel, closePanel } = useDeskFilterPanel()

onMounted(() => { closePanel(); if (props.showCounts && !props.counter) void ensurePolicyRegionCounts() })
onBeforeUnmount(closePanel)

const fmt = (n: number) => n.toLocaleString('en-US')
const cell = (on: boolean) => ['p-4 border rounded-2xl text-left transition-all', on ? 'bg-blue-50 border-blue-300 ring-2 ring-blue-500/30' : 'bg-slate-50 border-slate-100 hover:border-blue-200 hover:bg-white']
const nameClass = (on: boolean) => ['text-sm font-bold', on ? 'text-blue-700' : 'text-navy-900']
const subClass = (on: boolean) => ['text-[10px] mt-1', on ? 'text-blue-500' : 'text-slate-400']

const hasCounts = computed(() => props.showCounts && policyRegionCounts.value.length > 0)
// 數字的來源：呼叫端給了 counter 就用它（脈絡條數），否則是全部政見頁的政見筆數
const unit = computed(() => props.counter?.unit ?? '政見')
const suffix = computed(() => props.counter?.suffix ?? '筆')
const regionCount = (r: string): number | null => (props.counter ? props.counter.region(r, props.category) : hasCounts.value ? regionTotal(policyRegionCounts.value, r, props.category) : null)
const categoryCount = (c: string): number | null => (props.counter ? props.counter.category(globalRegion.value, c) : hasCounts.value ? categoryTotal(policyRegionCounts.value, globalRegion.value, c) : null)
const regionCells = computed(() => [ALL_REGIONS, ...TAIWAN_COUNTIES].map(r => ({
  value: r,
  label: r === ALL_REGIONS ? '全台' : r,
  count: regionCount(r),
})))
const categoryCells = computed(() => ['All', ...categories.value].map(c => ({
  value: c,
  label: c === 'All' ? '全部' : c,
  count: categoryCount(c),
})))
const scopeTotal = computed(() => categoryCount('All'))
const scopeLabel = computed(() => (globalRegion.value === ALL_REGIONS ? '全台' : `在${globalRegion.value}範圍內`))

function pickRegion(r: string) { setGlobalRegion(r); closePanel() }
function pickCategory(c: string) { emit('update:category', c); closePanel() }
</script>

<template>
  <div v-if="panel === 'region' || (panel === 'category' && categoryEnabled)" class="hidden md:block mb-8 bg-white p-6 rounded-[32px] border border-slate-200 shadow-xl" data-testid="region-category-picker">
    <template v-if="panel === 'region'">
      <div class="flex items-center justify-between mb-4">
        <h4 class="text-sm font-black text-navy-900">選擇地區 <span class="font-bold text-slate-400">（{{ regionCells.length }}）</span></h4>
        <button type="button" class="text-xs font-bold text-slate-400 hover:text-slate-600 flex items-center gap-1" @click="closePanel()">收起<X :size="14" /></button>
      </div>
      <div class="grid grid-cols-4 gap-3" role="group" aria-label="選擇地區">
        <button v-for="c in regionCells" :key="c.value" type="button" :class="cell(globalRegion === c.value)" :aria-pressed="globalRegion === c.value" :data-testid="`region-cell-${c.value}`" @click="pickRegion(c.value)">
          <p :class="nameClass(globalRegion === c.value)">{{ c.label }}</p>
          <p v-if="c.count !== null" :class="subClass(globalRegion === c.value)">{{ unit }} {{ fmt(c.count) }} {{ suffix }}</p>
        </button>
      </div>
    </template>
    <template v-else>
      <div class="flex items-center justify-between mb-4">
        <h4 class="text-sm font-black text-navy-900">選擇分類 <span v-if="scopeTotal !== null" class="font-bold text-slate-400">· {{ scopeLabel }} {{ fmt(scopeTotal) }} {{ suffix }}</span></h4>
        <button type="button" class="text-xs font-bold text-slate-400 hover:text-slate-600 flex items-center gap-1" @click="closePanel()">收起<X :size="14" /></button>
      </div>
      <div class="grid grid-cols-4 gap-3" role="group" aria-label="選擇分類">
        <button v-for="c in categoryCells" :key="c.value" type="button" :class="cell(category === c.value)" :aria-pressed="category === c.value" :data-testid="`category-cell-${c.value}`" @click="pickCategory(c.value)">
          <p :class="nameClass(category === c.value)">{{ c.label }}</p>
          <p v-if="c.count !== null" :class="subClass(category === c.value)">{{ c.value === 'All' ? '共' : unit }} {{ fmt(c.count) }} {{ suffix }}</p>
        </button>
      </div>
    </template>
  </div>
</template>
