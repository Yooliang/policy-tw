<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { useRoute, type RouteLocationRaw } from 'vue-router'
import ElectionHero from '../components/ElectionHero.vue'
import LoadError from '../components/LoadError.vue'
import MdDrawer, { type MdPick } from '../components/MdDrawer.vue'
import { useSupabase } from '../composables/useSupabase'
import { usePageHead, type BreadcrumbItem } from '../composables/usePageHead'
import { supabasePublic } from '../lib/supabase'
import { electionViewLink, type ElectionViewMode } from '../lib/election-view-tabs'
import { electionPath } from '../lib/election-regions'
import { dataCategoryMdPath, dataIndexMdPath, dataRegionCategoryMdPath, dataRegionMdPath } from '../lib/md/format'
import type { Matrix } from '../lib/md/dataset'
import { categoryItems, regionItems, sliceColors, topSlices, type Slice } from '../lib/matrix-share'
import { CHART_LEGEND } from '../lib/chart-style'

const apexchart = defineAsyncComponent(() => import('vue3-apexcharts'))

/**
 * 政見矩陣（維護者 2026-10-07）：橫向 22 縣市、直列 19 個分類（照網站分類順序），格子＝該縣市該分類的競選承諾筆數（只算這一屆在選候選人名下、屬於這一屆的競選承諾，只放筆數、不放比例，
 * 直接按 policies.category 算）。三種粗切法都能一鍵拿到 .md：
 *   縣市欄標題 → 該縣市全部分類；分類列標題 → 該分類全部縣市；格子 → 該縣市的該分類；左上角 → 全部檔案的索引
 * 點了從右側滑出抽屜，把那份 Markdown 摘要排成網頁（標題、清單、表格、連結），標題旁有「複製給 AI」（整份原文含 front matter）與「另開視窗」（開 .md 網址）。
 * 最後一列／最後一欄是各縣市與各分類的總數。
 * 頁首跟選舉頁是同一個（components/ElectionHero.vue），政見矩陣是第五個頁籤；縣市選擇器在這一頁改的是表格範圍：全台＝完整表，
 * 選一個縣市＝只列那個縣市的各分類筆數；選擇存在網址 ?region=（可分享、重新整理還在；canonical 照舊指 /election/:屆/matrix，預渲染永遠是完整表）。
 *
 * 資料：排程每小時預產進 data_md_cache（scripts/build-data-md.ts），這裡只用 anon 讀同一份——筆數矩陣是 `_matrix` 那一列，
 * 展開的摘要是各 .md 對應的那一列。頁面不放說明文字，只留表頭與數字。
 * 表格上方兩張甜甜圈（lib/matrix-share.ts）：左＝政見分類占比、右＝各縣市占比，只用矩陣現有的數字；切片超過 8 塊取前 8、其餘合成「其他」，中間是總筆數；
 * 點切片＝點對應的表頭（分類／縣市；選了縣市時分類切片＝該縣市的該分類格），「其他」不可點。圖只在瀏覽器畫（ClientOnly＋非同步載入，預渲染的 HTML 只有預留好高度的空框）。
 * 預渲染（內容頁、可收錄、進網站地圖）：建置端把 _matrix 放進頁面快照，HTML 裡就有數字與連結；掛載後背景換成最新一批。
 */

/** 展開的是哪一份：row＝快取表的鍵、path＝對外的 .md 網址（含屆別，已編碼）、title＝面板標題 */
type Pick = MdPick

const route = useRoute()
// 預渲染與 hydrate 起手就有資料（建置端放在頁面快照裡，HTML 裡就有數字與連結）；沒有（從站內別頁換頁進來）才等讀取
const { elections, policyMatrix } = useSupabase()
const matrix = ref<Matrix | null>(policyMatrix.value)
const loading = ref(!policyMatrix.value)
const failed = ref(false)

const selected = ref<Pick | null>(null)

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

// 縣市選擇器選的範圍（網址 ?region=）：預渲染與 hydrate 一律是完整表（網址參數在掛載後才套用，才不會 hydration 不一致）；
// 不在矩陣的縣市名當成沒選。canonical 不帶 query（usePageHead 用 route.path），所以各縣市不各自成一個可收錄的網址
const queryRegion = ref('')
function applyRegionQuery() {
  const raw = route.query.region
  queryRegion.value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''
}
onMounted(applyRegionQuery)
watch(() => route.query.region, applyRegionQuery)
const scopeRegion = computed(() => (matrix.value && matrix.value.regions.includes(queryRegion.value) ? queryRegion.value : 'All'))
const oneRegion = computed(() => scopeRegion.value !== 'All')
const shownRegions = computed(() => (matrix.value ? (oneRegion.value ? [scopeRegion.value] : matrix.value.regions) : []))
// 換範圍時抽屜開著的那份可能已不在表上，先關
watch(scopeRegion, () => { selected.value = null })

/** 縣市選擇器的連結：回到這一頁、只換 ?region=（全台就不帶） */
function regionLink(r: string): RouteLocationRaw {
  return { path: `/election/${segment.value}/matrix`, query: r === 'All' ? {} : { region: r } }
}
/** 四個檢視頁籤回選舉頁；有選縣市就回那個縣市的選舉頁（/election/2026/台南市?view=pledges） */
function viewLink(view: ElectionViewMode): RouteLocationRaw {
  if (scopeRegion.value !== 'All') return electionViewLink(segment.value, view, scopeRegion.value)
  // 矩陣自己維持全國資料；但從矩陣回選舉頁要回到離開前的定位（選舉頁存在 localStorage 'zj.location'：縣市、鄉鎮、村里、層級分頁、選區），不回全台
  try {
    const saved = JSON.parse(localStorage.getItem('zj.location') || 'null') as { region?: string; sub?: string; village?: string; tab?: string; area?: string } | null
    if (saved?.region && saved.region !== 'All') {
      const sub = saved.sub && saved.sub !== 'All' ? saved.sub : undefined
      const query: Record<string, string> = {}
      if (view !== 'politicians') query.view = view
      if (saved.tab) query.tab = saved.tab
      if (saved.area && saved.area !== 'All') query.area = saved.area
      if (saved.village && saved.village !== 'All' && sub) query.village = saved.village
      return { path: electionPath(segment.value, saved.region, sub), query }
    }
  } catch { /* 讀不到就回全台 */ }
  return electionViewLink(segment.value, view, scopeRegion.value)
}

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

// 兩張甜甜圈：全台＝分類總數／22 縣市；選了縣市＝該縣市各分類／「所選縣市 vs 其他縣市合計」
// （右圖選縣市時不維持 22 塊：22 塊裡所選縣市常掉進「其他」，看不到；兩塊直接回答「它占全台多少」，而且所選縣市可點）
const categorySlices = computed<Slice[]>(() => (matrix.value ? topSlices(categoryItems(matrix.value, scopeRegion.value), '其餘分類') : []))
const regionSlices = computed<Slice[]>(() => (matrix.value ? topSlices(regionItems(matrix.value, scopeRegion.value), '其他縣市') : []))

/** 切片點下去等於點對應的表頭或格子；合併項回 null（不可點） */
function pickCategorySlice(s: Slice): Pick | null {
  if (s.isOther) return null
  return oneRegion.value ? pickCell(scopeRegion.value, s.key) : pickCategory(s.key)
}
function pickRegionSlice(s: Slice): Pick | null {
  return s.isOther ? null : pickRegion(s.key)
}

function donutOptions(slices: Slice[], pickOf: (s: Slice) => Pick | null) {
  const total = slices.reduce((sum, s) => sum + s.value, 0)
  return {
    chart: {
      type: 'donut' as const,
      toolbar: { show: false },
      events: {
        dataPointSelection: (_e: unknown, _c: unknown, cfg: { dataPointIndex: number }) => {
          const s = slices[cfg.dataPointIndex]
          const p = s ? pickOf(s) : null
          if (p) open(p)
        },
        dataPointMouseEnter: (e: { target?: EventTarget | null }, _c: unknown, cfg: { dataPointIndex: number }) => {
          const s = slices[cfg.dataPointIndex]
          if (e.target instanceof SVGElement) e.target.style.cursor = s && pickOf(s) ? 'pointer' : 'default'
        },
      },
    },
    labels: slices.map((s) => s.label),
    colors: sliceColors(slices),
    stroke: { width: 2, colors: ['#ffffff'] },
    dataLabels: { enabled: false },
    // 圖例只當標示，點了不隱藏切片（隱藏後中間的總數就對不上）
    legend: { ...CHART_LEGEND, onItemClick: { toggleDataSeries: false } },
    states: { active: { filter: { type: 'none' } } },
    plotOptions: {
      pie: {
        donut: {
          size: '66%',
          labels: {
            show: true,
            name: { show: true, fontSize: '12px', color: '#64748b', offsetY: -2 },
            value: { show: true, fontSize: '22px', fontWeight: 800, color: '#0f172a', offsetY: 2, formatter: (v: string) => `${v}` },
            total: { show: true, showAlways: true, label: '總筆數', fontSize: '12px', color: '#64748b', formatter: () => `${total}` },
          },
        },
      },
    },
    // 只放筆數、不放百分比（DECISIONS 2026-10-07「首頁與矩陣只放筆數」；圓餅的切片大小本身就是比例）
    tooltip: { y: { formatter: (v: number) => `${v} 筆` } },
  }
}
const charts = computed(() => {
  const one = oneRegion.value
  const cat = categorySlices.value
  const reg = regionSlices.value
  return [
    { id: 'category', title: one ? `${scopeRegion.value}　政見分類` : '政見分類', empty: cat.length === 0, options: donutOptions(cat, pickCategorySlice), series: cat.map((s) => s.value) },
    { id: 'region', title: one ? `${scopeRegion.value}　與其他縣市` : '各縣市', empty: reg.length === 0, options: donutOptions(reg, pickRegionSlice), series: reg.map((s) => s.value) },
  ]
})

function open(p: Pick) {
  selected.value = selected.value?.id === p.id ? null : p
}

const is = (id: string) => selected.value?.id === id
const HEAD = 'bg-slate-100 border-b border-slate-200 px-3 py-2 text-center font-bold text-slate-700 whitespace-nowrap transition-colors hover:bg-blue-50 hover:text-blue-800'
</script>

<template>
  <LoadError v-if="failed" inline message="政見矩陣讀取失敗" @retry="loadMatrix" />
  <div v-else class="bg-slate-50 min-h-screen pb-20">
    <!-- 頁首跟選舉頁同一個：政見矩陣是第五個頁籤；四個檢視頁籤回選舉頁（有選縣市就回那個縣市頁），縣市選擇器改的是下面表格的範圍 -->
    <ElectionHero
      v-if="election"
      :election="election" :election-seg="segment" view="matrix" :has-matrix="true"
      :region="scopeRegion" :region-link="regionLink" :view-link="viewLink"
    />

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-left">
      <div v-if="loading" class="text-slate-500 text-center py-20">載入中…</div>
      <div v-else-if="!valid" class="text-slate-500 text-center py-20">這一屆沒有政見矩陣</div>
      <template v-else-if="matrix">
        <!-- 表格上方兩張甜甜圈：桌機並排、手機上下排；高度固定，圖在瀏覽器端載入前後版面不跳動 -->
        <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="matrix-charts">
          <section v-for="c in charts" :key="c.id" class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" :data-testid="`matrix-chart-${c.id}`">
            <h2 class="mb-2 text-sm font-bold text-slate-700">{{ c.title }}</h2>
            <div class="h-[22rem]">
              <ClientOnly><apexchart v-if="!c.empty" type="donut" :height="352" :options="c.options" :series="c.series" /></ClientOnly>
            </div>
          </section>
        </div>

        <!-- 手機：整張表可橫向捲動，首欄（分類）固定在左 -->
        <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="matrix-scroll">
          <table :class="['border-collapse text-sm', oneRegion ? 'w-full' : 'min-w-max']">
            <thead>
              <tr>
                <th scope="col" class="sticky left-0 z-20 border-r border-slate-200 p-0">
                  <a v-if="!oneRegion" :href="pickAll().path" :aria-current="is('all') ? 'true' : undefined" :class="[HEAD, 'block w-full h-full text-left', is('all') ? '!bg-blue-600 !text-white' : '']" aria-label="全部檔案索引" @click.prevent="open(pickAll())">全部 {{ matrix.total }}</a>
                  <span v-else :class="[HEAD, 'block w-full h-full text-left hover:!bg-slate-100 hover:!text-slate-700']">分類</span>
                </th>
                <th v-for="r in shownRegions" :key="r" scope="col" class="p-0">
                  <a :href="pickRegion(r).path" :aria-current="is(`r:${r}`) ? 'true' : undefined" :class="[HEAD, 'block w-full', is(`r:${r}`) ? '!bg-blue-600 !text-white' : '']" @click.prevent="open(pickRegion(r))">{{ r }}</a>
                </th>
                <th v-if="!oneRegion" scope="col" class="bg-slate-100 border-b border-l border-slate-200 px-3 py-2 text-center font-bold text-slate-500 whitespace-nowrap">合計</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in matrix.categories" :key="c" class="border-b border-slate-100">
                <th scope="row" class="sticky left-0 z-10 border-r border-slate-200 p-0">
                  <a :href="pickCategory(c).path" :aria-current="is(`c:${c}`) ? 'true' : undefined" :class="['block w-full bg-white px-3 py-2 text-left font-medium whitespace-nowrap transition-colors hover:bg-blue-50 hover:text-blue-800', is(`c:${c}`) ? '!bg-blue-600 !text-white' : 'text-slate-800']" @click.prevent="open(pickCategory(c))">{{ c }}</a>
                </th>
                <td v-for="r in shownRegions" :key="r" class="p-0 text-center">
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
                <td v-if="!oneRegion" class="border-l border-slate-200 bg-slate-50 px-3 py-2 text-center font-bold tabular-nums text-slate-600" data-testid="category-total">{{ matrix.categoryTotals[c] ?? 0 }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="border-t border-slate-200 bg-slate-50">
                <th scope="row" class="sticky left-0 z-10 bg-slate-50 border-r border-slate-200 px-3 py-2 text-left font-bold text-slate-500">合計</th>
                <td v-for="r in shownRegions" :key="r" class="px-3 py-2 text-center font-bold tabular-nums text-slate-600" data-testid="region-total">{{ matrix.regionTotals[r] ?? 0 }}</td>
                <td v-if="!oneRegion" class="border-l border-slate-200 px-3 py-2 text-center font-bold tabular-nums text-slate-800">{{ matrix.total }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </template>
    </div>

    <!-- 摘要抽屜（components/MdDrawer.vue，選舉頁「議題串聯」共用） -->
    <MdDrawer :pick="selected" @close="selected = null" />
  </div>
</template>
