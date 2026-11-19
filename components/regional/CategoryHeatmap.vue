<script setup lang="ts">
import { computed, ref } from 'vue'
import { COUNTIES, categoriesByTotal, heatAlpha, heatMatrix, normRegion, type HeatTab, type RegionalDataSet } from '../../lib/regional-overview'

/**
 * ② 縣市 × 19 分類熱力圖：承諾／政見／脈絡三個頁籤，三個頁籤共用同一個顏色尺度（各頁籤內以整張圖最大值為 1）。
 * 窄螢幕整張圖可橫向捲動。
 */
const props = defineProps<{ data: RegionalDataSet; region: string; category: string }>()
const emit = defineEmits<{ (e: 'pick', region: string): void }>()

const tab = ref<HeatTab>('pledge')
const tabs: { key: HeatTab; label: string }[] = [
  { key: 'pledge', label: '承諾' },
  { key: 'policy', label: '政見' },
  { key: 'lineage', label: '脈絡' },
]
const unit = computed(() => (tab.value === 'lineage' ? '條' : '筆'))

const allCategories = computed(() => [...new Set([...props.data.category.map((r) => r.category), ...props.data.lineage.map((l) => l.category ?? '')].filter(Boolean))])
const matrix = computed(() => {
  const cats = categoriesByTotal(tab.value, props.data, allCategories.value)
  return heatMatrix(tab.value, props.data, cats, COUNTIES)
})
const total = computed(() => matrix.value.values.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0))

function cellStyle(v: number) {
  const a = heatAlpha(v, matrix.value.max)
  if (a === 0) return { background: '#f1f5f9', color: '#cbd5e1' }
  return { background: `rgba(37,99,235,${a.toFixed(2)})`, color: a > 0.5 ? '#ffffff' : '#334155' }
}
const isOn = (name: string) => props.region !== 'All' && normRegion(props.region) === normRegion(name)
</script>

<template>
  <div class="bg-white p-5 md:p-8 rounded-[32px] border border-slate-200 shadow-sm" data-testid="regional-heatmap">
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <h3 class="text-xl font-black text-navy-900">縣市 × 分類</h3>
      <div class="flex gap-2" role="tablist" aria-label="資料種類">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          role="tab"
          :aria-selected="tab === t.key"
          :class="['px-4 py-1.5 rounded-full text-sm font-bold border transition', tab === t.key ? 'bg-navy-900 text-white border-navy-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300']"
          @click="tab = t.key"
        >{{ t.label }}</button>
      </div>
    </div>
    <div v-if="total === 0" class="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center text-sm font-black text-slate-400">資料收集中</div>
    <div v-else class="overflow-x-auto">
      <table class="w-full min-w-[760px]" style="table-layout: fixed">
        <colgroup><col style="width: 76px"><col v-for="c in matrix.categories" :key="c"></colgroup>
        <thead>
          <tr>
            <th class="text-right pr-3 align-bottom text-[11px] font-bold text-slate-400">單位：{{ unit }}</th>
            <th v-for="c in matrix.categories" :key="c" class="p-0 align-bottom">
              <div :class="['mx-auto text-[11px] font-bold', category === c ? 'text-blue-600' : 'text-slate-500']" style="writing-mode: vertical-rl; height: 128px; letter-spacing: 0.05em">{{ c }}</div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(name, i) in matrix.regions" :key="name">
            <td class="pr-3 text-right whitespace-nowrap">
              <button type="button" :class="['text-sm font-bold hover:text-blue-600', isOn(name) ? 'text-blue-600' : 'text-navy-900']" @click="emit('pick', name)">{{ name }}</button>
            </td>
            <td v-for="(v, j) in matrix.values[i]" :key="matrix.categories[j]" class="p-0.5">
              <div
                :class="['rounded text-center text-[11px] font-bold tabular-nums py-1.5', isOn(name) ? 'ring-1 ring-navy-900/40' : '']"
                :style="cellStyle(v)"
                :title="`${name} · ${matrix.categories[j]} ${v} ${unit}`"
              >{{ v }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
