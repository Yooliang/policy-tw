<script setup lang="ts">
/**
 * 選舉頁「政見 PK」頁籤的本體（2026-10-06 維護者：並排比較併進 PK、改成多人）。
 *
 *   列＝政見類別，欄＝同職位同選區的參選人（預設這一組全部，可勾選增減），格子＝那個人在這一類的政見與三要素。
 *   欄的順序依號次，沒有號次依姓名筆畫：只並排，不排名、不打分（規則在 lib/policy-compare.ts；畫面上不另寫說明，10-06）。
 *   三要素的「未說明／未調查」照 PolicyElements 標。
 *
 * 只在瀏覽器端畫（維護者 10-06）：PK 不是正文，政見的正文在政見頁與人物頁；並排的表進了預渲染 HTML 會被當成重複內容。
 * 選舉頁用 v-if 掛這個元件，預渲染時永遠是「候選人」頁籤，HTML 裡只有參選人卡片與「政見 PK」按鈕連結。
 *
 * 選哪個職位、哪一場、勾了誰由選舉頁管（都在網址上：type／district／pick，規則在 lib/policy-compare.ts），
 * 這裡只管畫。選區（議員的選舉區、村里長的村里）不在這裡選：跟其他頁籤一樣放在選舉頁右側面板（真連結，網址 district 參數照舊）。
 * 表比畫面寬時整張左右捲動，第一欄（類別）固定在左邊；手機上第一欄縮窄。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { FileText, Maximize2, Minimize2, Swords } from 'lucide-vue-next'
import type { Politician } from '../../types'
import type { CompareMatrix } from '../../lib/policy-compare'
import PolicyElements from '../../components/PolicyElements.vue'
import MdDrawer, { type MdPick } from '../../components/MdDrawer.vue'

const props = defineProps<{
  /** 例如「縣市議員・第08選舉區」 */
  title: string
  /** 這一場會出現在選票上的人（已照號次／筆畫排好） */
  candidates: Politician[]
  /** 勾選的人物 id */
  picked: readonly string[]
  matrix: CompareMatrix<Politician>
  /** 選舉年份（投票日的年） */
  year?: string | number
  /** 縣市名；全國的職位不給（不是選區選擇） */
  regionLabel?: string
  /** 選舉頁給的 .md 抽屜：不給分類＝縣市全部分類；回 null＝這一屆沒有預產，不顯示按鈕 */
  mdPickFor?: (category?: string) => MdPick | null
}>()

defineEmits<{ toggle: [id: string]; all: [] }>()

// 全畫面（2026-10-16 維護者）：整張比較表蓋滿瀏覽器視窗；Esc 或「還原」離開，期間頁面本身不捲動
const fullscreen = ref(false)
watch(fullscreen, (on) => { document.body.style.overflow = on ? 'hidden' : '' })
// Markdown 抽屜開著時 Esc 只關抽屜（抽屜自己聽），不連全畫面一起退出
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !mdOpen.value) fullscreen.value = false }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); document.body.style.overflow = '' })

// .md 抽屜（2026-10-19 維護者）：跟政見矩陣一樣，開預產的「縣市×分類」.md（複製給 AI、另開視窗）；不是把比較表轉成 Markdown
const mdPick = ref<MdPick | null>(null)
const mdOpen = computed(() => mdPick.value !== null)
// 抽屜關掉時會把 body 捲動還原；全畫面還開著就再鎖回去（分類列的按鈕全畫面也能開）
watch(mdOpen, async (on) => {
  if (on) return
  await nextTick()
  if (fullscreen.value) document.body.style.overflow = 'hidden'
})
const regionPick = computed(() => props.mdPickFor?.() ?? null)
const openMd = (category?: string) => { mdPick.value = props.mdPickFor?.(category) ?? null }

const isPicked = (id: string | number) => props.picked.includes(String(id))
</script>

<template>
  <div class="text-left" data-testid="policy-pk">
    <div v-if="candidates.length < 2" class="text-center py-16 text-slate-400 border border-dashed border-slate-300 rounded-xl">
      <Swords :size="48" class="mx-auto mb-4 opacity-50" />
      <p>這一層還沒有同一場、兩位以上的參選人可以並排。</p>
    </div>

    <section v-else :class="fullscreen ? 'fixed inset-0 z-[100] overflow-auto bg-white' : 'bg-white rounded-xl border border-slate-200 shadow-sm'">
      <div class="px-4 pt-4">
        <div class="flex items-start justify-between gap-3">
          <h3 class="font-bold text-navy-900 text-lg">{{ title }}：並排比較 {{ matrix.columns.length }} 位參選人的政見</h3>
          <div class="flex shrink-0 items-center gap-2">
          <button
            v-if="!fullscreen && regionPick"
            type="button"
            class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            data-testid="pk-md"
            @click="openMd()"
          ><FileText :size="16" />{{ regionPick.title }}</button>
          <button
            type="button"
            class="hidden md:inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-sm font-bold text-slate-600 hover:bg-slate-50"
            :aria-pressed="fullscreen"
            data-testid="pk-fullscreen"
            @click="fullscreen = !fullscreen"
          ><component :is="fullscreen ? Minimize2 : Maximize2" :size="14" />{{ fullscreen ? '還原' : '全畫面' }}</button>
          </div>
        </div>

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
              <th scope="row" class="sticky left-0 z-10 bg-white p-2 pl-4 border-b border-slate-100 text-xs font-bold text-slate-600">
                <button v-if="props.mdPickFor?.(row.category)" type="button" class="inline-flex items-start gap-1 text-left hover:text-violet-700 hover:underline" :title="`${regionLabel}　${row.category}`" @click="openMd(row.category)"><FileText :size="12" class="mt-0.5 shrink-0" />{{ row.category }}</button>
                <template v-else>{{ row.category }}</template>
              </th>
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
      <MdDrawer :pick="mdPick" @close="mdPick = null" />
    </section>
  </div>
</template>
