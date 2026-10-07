<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Grid3x3 } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import Breadcrumbs from '../components/Breadcrumbs.vue'
import LoadError from '../components/LoadError.vue'
import { useSupabase } from '../composables/useSupabase'
import { usePageHead, type BreadcrumbItem } from '../composables/usePageHead'
import { supabasePublic } from '../lib/supabase'
import { dataCategoryMdPath, dataIndexMdPath, dataRegionCategoryMdPath, dataRegionMdPath, renderPage } from '../lib/md/format'
import type { MdPage } from '../lib/md/format'
import type { Matrix } from '../lib/md/dataset'

/**
 * 政見矩陣（維護者 2026-10-07）：橫向 22 縣市、直列 19 個分類（照網站分類順序），格子＝該縣市該分類的競選承諾筆數（只算這一屆在選候選人名下、屬於這一屆的競選承諾，只放筆數、不放比例，
 * 直接按 policies.category 算）。三種粗切法都能一鍵拿到 .md：
 *   縣市欄標題 → 該縣市全部分類；分類列標題 → 該分類全部縣市；格子 → 該縣市的該分類；左上角 → 全部檔案的索引
 * 點了在下面展開那份 Markdown 摘要，並附「開 .md」連結。最後一列／最後一欄是各縣市與各分類的總數。
 *
 * 資料：排程每小時預產進 data_md_cache（scripts/build-data-md.ts），這裡只用 anon 讀同一份——筆數矩陣是 `_matrix` 那一列，
 * 展開的摘要是各 .md 對應的那一列。頁面不放說明文字，只留表頭與數字。
 * 預渲染（內容頁、可收錄、進網站地圖）：建置端把 _matrix 放進頁面快照，HTML 裡就有數字與連結；掛載後背景換成最新一批。
 */

interface CacheRow { body: string; meta: Record<string, unknown>; generated_at: string }
/** 展開的是哪一份：row＝快取表的鍵、path＝對外的 .md 網址（含屆別，已編碼）、title＝面板標題 */
interface Pick { id: string; row: string; path: string; title: string }

const route = useRoute()
// 預渲染與 hydrate 起手就有資料（建置端放在頁面快照裡，HTML 裡就有數字與連結）；沒有（從站內別頁換頁進來）才等讀取
const { elections, policyMatrix } = useSupabase()
const matrix = ref<Matrix | null>(policyMatrix.value)
const loading = ref(!policyMatrix.value)
const failed = ref(false)

const selected = ref<Pick | null>(null)
const panel = ref<{ text: string; loading: boolean; failed: boolean }>({ text: '', loading: false, failed: false })

async function loadMatrix() {
  // 已經有（快照帶來的）資料就留著顯示，背景換成最新一批
  loading.value = !matrix.value
  failed.value = false
  try {
    // query-bounds: ok — 主鍵查一列
    const { data, error } = await supabasePublic.from('data_md_cache').select('body').eq('path', '_matrix').limit(1)
    if (error) throw error
    const row = (data ?? [])[0] as { body: string } | undefined
    if (row) matrix.value = JSON.parse(row.body) as Matrix
  } catch {
    // 有快照的資料就不當成失敗（顯示舊一點的數字比整頁錯誤好）
    failed.value = !matrix.value
  } finally {
    loading.value = false
  }
}
onMounted(loadMatrix)

/** 這個網址的那一屆就是矩陣算的那一屆才顯示（舊的選舉頁沒有矩陣） */
const segment = computed(() => String(route.params.electionId ?? ''))
const valid = computed(() => !!matrix.value && matrix.value.election.segment === segment.value)
const year = computed(() => matrix.value?.election.year ?? '')
const election = computed(() => elections.value.find((e) => String(e.id) === segment.value || e.electionKey === segment.value))

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { name: '首頁', path: '/' },
  { name: election.value?.shortName || election.value?.name || (year.value ? `${year.value} 九合一` : '選舉'), path: `/election/${segment.value}` },
  { name: '政見矩陣' },
])

// 內容頁，可收錄（不加 noindex）：canonical 由 usePageHead 指正見.tw；標題「2026 九合一政見矩陣 | 正見」
const pageTitle = computed(() => `${(election.value?.shortName || (year.value ? `${year.value} 九合一` : '')).replace(/選舉$/, '')}政見矩陣`.trim())
usePageHead({
  title: () => pageTitle.value,
  description: () => `${year.value} 年地方選舉候選人的競選承諾，依 22 縣市與 19 個分類統計筆數，點開可看各縣市、各分類的 Markdown 摘要。`,
  breadcrumbs: () => breadcrumbs.value,
})

const count = (region: string, category: string) => matrix.value?.counts[region]?.[category] ?? 0
const seg = () => matrix.value!.election.segment

const pickAll = (): Pick => ({ id: 'all', row: `/data/${seg()}/index.md`, path: dataIndexMdPath(seg()), title: `${year.value} 全部檔案索引` })
const pickRegion = (r: string): Pick => ({ id: `r:${r}`, row: `/election/${seg()}/${r}.md`, path: dataRegionMdPath(seg(), r), title: `${r}　全部分類` })
const pickCategory = (c: string): Pick => ({ id: `c:${c}`, row: `/data/${seg()}/${c}.md`, path: dataCategoryMdPath(seg(), c), title: `${c}　全部縣市` })
const pickCell = (r: string, c: string): Pick => ({ id: `${r}|${c}`, row: `/data/${seg()}/${r}/${c}.md`, path: dataRegionCategoryMdPath(seg(), r, c), title: `${r}　${c}` })

async function open(p: Pick) {
  if (selected.value?.id === p.id) {
    selected.value = null
    return
  }
  selected.value = p
  panel.value = { text: '', loading: true, failed: false }
  try {
    // query-bounds: ok — 主鍵查一列
    const { data, error } = await supabasePublic.from('data_md_cache').select('body,meta,generated_at').eq('path', p.row).limit(1)
    if (error) throw error
    const row = (data ?? [])[0] as CacheRow | undefined
    if (selected.value?.id !== p.id) return
    panel.value = {
      text: row ? renderPage({ ...(row.meta as unknown as MdPage), body: [row.body] }, p.path, Date.parse(row.generated_at) || Date.now()) : '',
      loading: false,
      failed: !row,
    }
  } catch {
    panel.value = { text: '', loading: false, failed: true }
  }
}

const is = (id: string) => selected.value?.id === id
const HEAD = 'bg-slate-100 border-b border-slate-200 px-3 py-2 text-center font-bold text-slate-700 whitespace-nowrap transition-colors hover:bg-blue-50 hover:text-blue-800'
</script>

<template>
  <LoadError v-if="failed" inline message="政見矩陣讀取失敗" @retry="loadMatrix" />
  <div v-else class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>{{ pageTitle }}</template>
      <template #icon><Grid3x3 :size="400" class="text-blue-500" /></template>
    </Hero>
    <Breadcrumbs :items="breadcrumbs" />

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 text-left">
      <div v-if="loading" class="text-slate-500 text-center py-20">載入中…</div>
      <div v-else-if="!valid" class="text-slate-500 text-center py-20">這一屆沒有政見矩陣</div>
      <template v-else-if="matrix">
        <!-- 手機：整張表可橫向捲動，首欄（分類）固定在左 -->
        <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="matrix-scroll">
          <table class="min-w-max border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" class="sticky left-0 z-20 border-r border-slate-200 p-0">
                  <a :href="pickAll().path" :aria-current="is('all') ? 'true' : undefined" :class="[HEAD, 'block w-full h-full text-left', is('all') ? '!bg-blue-600 !text-white' : '']" aria-label="全部檔案索引" @click.prevent="open(pickAll())">全部 {{ matrix.total }}</a>
                </th>
                <th v-for="r in matrix.regions" :key="r" scope="col" class="p-0">
                  <a :href="pickRegion(r).path" :aria-current="is(`r:${r}`) ? 'true' : undefined" :class="[HEAD, 'block w-full', is(`r:${r}`) ? '!bg-blue-600 !text-white' : '']" @click.prevent="open(pickRegion(r))">{{ r }}</a>
                </th>
                <th scope="col" class="bg-slate-100 border-b border-l border-slate-200 px-3 py-2 text-center font-bold text-slate-500 whitespace-nowrap">合計</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in matrix.categories" :key="c" class="border-b border-slate-100">
                <th scope="row" class="sticky left-0 z-10 border-r border-slate-200 p-0">
                  <a :href="pickCategory(c).path" :aria-current="is(`c:${c}`) ? 'true' : undefined" :class="['block w-full bg-white px-3 py-2 text-left font-medium whitespace-nowrap transition-colors hover:bg-blue-50 hover:text-blue-800', is(`c:${c}`) ? '!bg-blue-600 !text-white' : 'text-slate-800']" @click.prevent="open(pickCategory(c))">{{ c }}</a>
                </th>
                <td v-for="r in matrix.regions" :key="r" class="p-0 text-center">
                  <a
                    :href="pickCell(r, c).path"
                    :aria-label="`${r}${c} ${count(r, c)} 筆`"
                    :aria-current="is(`${r}|${c}`) ? 'true' : undefined"
                    :class="[
                      'block w-full min-w-[3.25rem] px-3 py-2 tabular-nums transition-colors',
                      is(`${r}|${c}`) ? 'bg-blue-600 text-white font-bold' : count(r, c) > 0 ? 'text-slate-900 font-semibold hover:bg-blue-50' : 'text-slate-300 hover:bg-slate-50',
                    ]"
                    @click.prevent="open(pickCell(r, c))"
                  >{{ count(r, c) > 0 ? count(r, c) : '—' }}</a>
                </td>
                <td class="border-l border-slate-200 bg-slate-50 px-3 py-2 text-center font-bold tabular-nums text-slate-600" data-testid="category-total">{{ matrix.categoryTotals[c] ?? 0 }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="border-t border-slate-200 bg-slate-50">
                <th scope="row" class="sticky left-0 z-10 bg-slate-50 border-r border-slate-200 px-3 py-2 text-left font-bold text-slate-500">合計</th>
                <td v-for="r in matrix.regions" :key="r" class="px-3 py-2 text-center font-bold tabular-nums text-slate-600" data-testid="region-total">{{ matrix.regionTotals[r] ?? 0 }}</td>
                <td class="border-l border-slate-200 px-3 py-2 text-center font-bold tabular-nums text-slate-800">{{ matrix.total }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <section v-if="selected" class="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="matrix-panel">
          <header class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <h2 class="font-bold text-slate-800">{{ selected.title }}</h2>
            <a :href="selected.path" target="_blank" rel="noopener" class="text-sm font-medium text-blue-700 hover:underline">開 .md</a>
          </header>
          <div class="px-4 py-3">
            <p v-if="panel.loading" class="text-slate-500">載入中…</p>
            <p v-else-if="panel.failed" class="text-slate-500">這一份的摘要讀取失敗</p>
            <pre v-else class="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">{{ panel.text }}</pre>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
