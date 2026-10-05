<script setup lang="ts">
/**
 * 同職位、同選區參選人的政見並排比較（#364；日本站 keifu 的 PledgeCompare 同一個做法）。
 *
 *   列＝政見類別，欄＝參選人（有號次照號次，沒有照姓名筆畫），格子＝那個人在這一類的政見與三要素。
 *   只並排、不排名、不打分：不照政見數、關注度、黨派排，也不標誰比較好。
 *
 * 收在 <details> 裡、預設收合：內容一樣在預渲染的 HTML 裡（爬蟲讀得到、連結是真的 <a href>），
 * 只是不把選舉頁拉得很長。表比畫面寬時整張橫向捲動，第一欄（類別）固定在左邊。
 * 組表的規則在 lib/policy-compare.ts。
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Columns3 } from 'lucide-vue-next'
import type { Policy, Politician } from '../types'
import PolicyElements from './PolicyElements.vue'
import { compareMatrix, worthComparing } from '../lib/policy-compare'
import { ELEMENTS_EXPLAINER } from '../lib/policy-elements'

const props = defineProps<{
  people: Politician[]
  policies: Policy[]
  /** 這一場選舉（政見的 electionId） */
  electionId: number
  /** 網站分類表的順序（列的順序） */
  categories: readonly string[]
  /** 職位名，例如「縣市長」 */
  positionLabel: string
  /** 選區名（同一個區塊裡有好幾個選區時才給） */
  districtLabel?: string
}>()

const matrix = computed(() => compareMatrix(props.people, props.policies, props.electionId, props.categories))
const show = computed(() => worthComparing(matrix.value))
const title = computed(() => `${props.districtLabel ? `${props.districtLabel}：` : ''}並排比較 ${matrix.value.columns.length} 位${props.positionLabel}參選人的政見`)
</script>

<template>
  <details v-if="show" class="group mt-4 mb-2 bg-white rounded-xl border border-slate-200 shadow-sm" data-testid="policy-compare">
    <summary class="cursor-pointer select-none list-none px-4 py-3 flex items-center gap-2 font-bold text-navy-900 hover:bg-slate-50 rounded-xl">
      <Columns3 :size="18" class="text-violet-600 shrink-0" />
      <span class="min-w-0">{{ title }}</span>
      <span class="ml-auto text-xs font-medium text-slate-500 shrink-0">{{ matrix.rows.length }} 類・{{ matrix.policyCount }} 條</span>
      <span class="text-slate-400 text-xs shrink-0 group-open:rotate-180 transition-transform">▼</span>
    </summary>
    <div class="px-4 pb-4">
      <p class="text-xs text-slate-500 leading-relaxed mb-3">
        欄的順序依號次；還沒有號次的依姓名筆畫。只並排，不排名、不打分。{{ ELEMENTS_EXPLAINER }}<template v-if="matrix.columns.length >= 4">表格比畫面寬時可以左右捲動，第一欄類別會固定在左邊。</template>
      </p>
      <div class="overflow-x-auto -mx-4 px-4">
        <table class="w-full border-collapse text-sm text-left" :style="{ minWidth: `${7 + matrix.columns.length * 15}rem` }">
          <thead>
            <tr>
              <th scope="col" class="sticky left-0 z-10 bg-white w-28 min-w-[7rem] p-2 border-b border-slate-200 text-xs text-slate-500 font-bold align-bottom">類別</th>
              <th v-for="c in matrix.columns" :key="c.id" scope="col" class="p-2 border-b border-slate-200 align-bottom min-w-[14rem]">
                <div class="flex items-center gap-1.5">
                  <span v-if="c.candNo" class="inline-flex items-center justify-center min-w-[1.75rem] h-5 px-1.5 rounded-full bg-navy-900 text-white text-[11px] font-bold shrink-0">{{ c.candNo }}號</span>
                  <RouterLink :to="`/politician/${c.id}`" class="font-bold text-navy-900 hover:text-violet-700 hover:underline">{{ c.name }}</RouterLink>
                </div>
                <div v-if="c.party" class="text-xs font-normal text-slate-500 mt-0.5">{{ c.party }}</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in matrix.rows" :key="row.category" class="align-top">
              <th scope="row" class="sticky left-0 z-10 bg-white p-2 border-b border-slate-100 text-xs font-bold text-slate-600">{{ row.category }}</th>
              <td v-for="(cell, i) in row.cells" :key="matrix.columns[i].id" class="p-2 border-b border-slate-100">
                <template v-if="cell.length > 0">
                  <div v-for="(p, j) in cell" :key="p.id" :class="j > 0 ? 'mt-3 pt-3 border-t border-dashed border-slate-200' : ''">
                    <RouterLink :to="`/policy/${p.id}`" class="block font-bold text-navy-900 hover:text-blue-700 hover:underline leading-snug mb-1.5">{{ p.title }}</RouterLink>
                    <PolicyElements :elements="p.elements" compact />
                  </div>
                </template>
                <span v-else class="text-xs text-slate-400">沒有這一類的政見</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </details>
</template>

<style scoped>
/* 收合的三角形用自己的，瀏覽器預設的 marker 隱藏（Safari 要另外一條） */
summary::-webkit-details-marker { display: none; }
</style>
