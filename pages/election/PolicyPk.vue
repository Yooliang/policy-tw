<script setup lang="ts">
/**
 * 選舉頁「政見 PK」頁籤的本體（2026-10-06 小良哥：並排比較併進 PK、改成多人）。
 *
 *   列＝政見類別，欄＝同職位同選區的參選人（預設這一組全部，可勾選增減），格子＝那個人在這一類的政見與三要素。
 *   欄的順序依號次，沒有號次依姓名筆畫：只並排，不排名、不打分（規則在 lib/policy-compare.ts；畫面上不另寫說明，10-06）。
 *   三要素的「未說明／未調查」照 PolicyElements 標。
 *
 * 只在瀏覽器端畫（小良哥 10-06）：PK 不是正文，政見的正文在政見頁與人物頁；並排的表進了預渲染 HTML 會被當成重複內容。
 * 選舉頁用 v-if 掛這個元件，預渲染時永遠是「候選人」頁籤，HTML 裡只有參選人卡片與「政見 PK」按鈕連結。
 *
 * 選哪個職位、哪一場、勾了誰由選舉頁管（都在網址上：type／district／pick，規則在 lib/policy-compare.ts），
 * 這裡只管畫。選區（議員的選舉區、村里長的村里）不在這裡選：跟其他頁籤一樣放在選舉頁右側面板（真連結，網址 district 參數照舊）。
 * 表比畫面寬時整張左右捲動，第一欄（類別）固定在左邊；手機上第一欄縮窄。
 */
import { RouterLink } from 'vue-router'
import { Check, Swords } from 'lucide-vue-next'
import type { Politician } from '../../types'
import type { CompareMatrix } from '../../lib/policy-compare'
import PolicyElements from '../../components/PolicyElements.vue'

const props = defineProps<{
  /** 例如「縣市議員・第08選舉區」 */
  title: string
  /** 這一場會出現在選票上的人（已照號次／筆畫排好） */
  candidates: Politician[]
  /** 勾選的人物 id */
  picked: readonly string[]
  matrix: CompareMatrix<Politician>
}>()

defineEmits<{ toggle: [id: string]; all: [] }>()

const isPicked = (id: string | number) => props.picked.includes(String(id))
</script>

<template>
  <div class="text-left" data-testid="policy-pk">
    <div v-if="candidates.length < 2" class="text-center py-16 text-slate-400 border border-dashed border-slate-300 rounded-xl">
      <Swords :size="48" class="mx-auto mb-4 opacity-50" />
      <p>這一層還沒有同一場、兩位以上的參選人可以並排。</p>
    </div>

    <section v-else class="bg-white rounded-xl border border-slate-200 shadow-sm">
      <div class="px-4 pt-4">
        <h3 class="font-bold text-navy-900 text-lg">{{ title }}：並排比較 {{ matrix.columns.length }} 位參選人的政見</h3>

        <!-- 勾選要並排的人：預設這一組全部；至少留一位 -->
        <fieldset class="mt-3">
          <legend class="text-xs font-bold text-slate-500 mb-1.5">
            勾選要並排的參選人（{{ picked.length }}／{{ candidates.length }}）
            <button v-if="picked.length < candidates.length" type="button" class="ml-2 font-bold text-violet-700 hover:underline" @click="$emit('all')">全部勾選</button>
          </legend>
          <div class="flex flex-wrap gap-1.5">
            <label
              v-for="c in candidates"
              :key="c.id"
              :class="['inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm cursor-pointer select-none transition-colors',
                       isPicked(c.id) ? 'border-violet-300 bg-violet-50 text-violet-700 font-bold' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50']"
            >
              <input
                type="checkbox"
                class="sr-only"
                :checked="isPicked(c.id)"
                :disabled="isPicked(c.id) && picked.length <= 1"
                @change="$emit('toggle', String(c.id))"
              />
              <span :class="['inline-flex items-center justify-center w-4 h-4 rounded border shrink-0', isPicked(c.id) ? 'bg-violet-600 border-violet-600 text-white' : 'border-slate-300']" aria-hidden="true"><Check v-if="isPicked(c.id)" :size="12" :stroke-width="3" /></span>
              <span v-if="c.candNo" class="text-xs">{{ c.candNo }}號</span>
              <span>{{ c.name }}</span>
            </label>
          </div>
        </fieldset>
      </div>

      <p v-if="matrix.policyCount === 0" class="px-4 py-10 text-center text-sm text-slate-400">勾選的參選人還沒有登錄這一場選舉的政見。</p>
      <div v-else class="mt-4 overflow-x-auto pb-2">
        <table class="w-full border-collapse text-sm text-left" :style="{ minWidth: `${6 + matrix.columns.length * 14}rem` }">
          <thead>
            <tr>
              <th scope="col" class="sticky left-0 z-10 bg-white w-20 min-w-[5rem] sm:w-28 sm:min-w-[7rem] p-2 pl-4 border-b border-slate-200 text-xs text-slate-500 font-bold align-bottom">類別</th>
              <th v-for="c in matrix.columns" :key="c.id" scope="col" class="p-2 border-b border-slate-200 align-bottom min-w-[13rem]">
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
              <th scope="row" class="sticky left-0 z-10 bg-white p-2 pl-4 border-b border-slate-100 text-xs font-bold text-slate-600">{{ row.category }}</th>
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
    </section>
  </div>
</template>
