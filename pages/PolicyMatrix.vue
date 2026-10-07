<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, type RouteLocationRaw } from 'vue-router'
import { Check, Copy, ExternalLink, X } from 'lucide-vue-next'
import ElectionHero from '../components/ElectionHero.vue'
import LoadError from '../components/LoadError.vue'
import { useSupabase } from '../composables/useSupabase'
import { usePageHead, type BreadcrumbItem } from '../composables/usePageHead'
import { supabasePublic } from '../lib/supabase'
import { electionViewLink, type ElectionViewMode } from '../lib/election-view-tabs'
import { renderMdPreview } from '../lib/md/html'
import { dataCategoryMdPath, dataIndexMdPath, dataRegionCategoryMdPath, dataRegionMdPath, renderPage } from '../lib/md/format'
import type { MdPage } from '../lib/md/format'
import type { Matrix } from '../lib/md/dataset'

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

/** 抽屜開著時：Esc 關閉、Tab 只在抽屜裡轉、背景不捲動；關掉後焦點回到點開它的那一格 */
const drawerEl = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    selected.value = null
    return
  }
  if (e.key !== 'Tab' || !drawerEl.value) return
  const items = Array.from(drawerEl.value.querySelectorAll<HTMLElement>(FOCUSABLE))
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === drawerEl.value)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

function unlock() {
  window.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
}

watch(selected, async (now, before) => {
  if (now && !before) {
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    await nextTick()
    drawerEl.value?.focus()
  } else if (!now && before) {
    unlock()
    // 關掉（Esc、背景、叉叉）後把焦點還給點開它的連結
    opener?.focus()
    opener = null
  }
})
onBeforeUnmount(unlock)

async function open(p: Pick, ev?: Event) {
  if (selected.value?.id === p.id) {
    selected.value = null
    return
  }
  if (!selected.value) opener = (ev?.currentTarget as HTMLElement | null) ?? (document.activeElement as HTMLElement | null)
  selected.value = p
  copied.value = false
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

// 抽屜裡看的是排好版的網頁；「複製給 AI」複製的是整份原文（含 front matter）
const preview = computed(() => (panel.value.text ? renderMdPreview(panel.value.text) : null))
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copyRaw() {
  const text = panel.value.text
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 沒有剪貼簿權限（舊瀏覽器、非 https）就退回選取＋複製指令
    const box = document.createElement('textarea')
    box.value = text
    box.style.position = 'fixed'
    box.style.opacity = '0'
    document.body.appendChild(box)
    box.select()
    try { document.execCommand('copy') } finally { document.body.removeChild(box) }
  }
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1500)
}
onBeforeUnmount(() => clearTimeout(copiedTimer))

const is = (id: string) => selected.value?.id === id
const HEAD = 'bg-slate-100 border-b border-slate-200 px-3 py-2 text-center font-bold text-slate-700 whitespace-nowrap transition-colors hover:bg-blue-50 hover:text-blue-800'
const DRAWER_BTN = 'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors'
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
        <!-- 手機：整張表可橫向捲動，首欄（分類）固定在左 -->
        <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="matrix-scroll">
          <table :class="['border-collapse text-sm', oneRegion ? 'w-full' : 'min-w-max']">
            <thead>
              <tr>
                <th scope="col" class="sticky left-0 z-20 border-r border-slate-200 p-0">
                  <a v-if="!oneRegion" :href="pickAll().path" :aria-current="is('all') ? 'true' : undefined" :class="[HEAD, 'block w-full h-full text-left', is('all') ? '!bg-blue-600 !text-white' : '']" aria-label="全部檔案索引" @click.prevent="open(pickAll(), $event)">全部 {{ matrix.total }}</a>
                  <span v-else :class="[HEAD, 'block w-full h-full text-left hover:!bg-slate-100 hover:!text-slate-700']">分類</span>
                </th>
                <th v-for="r in shownRegions" :key="r" scope="col" class="p-0">
                  <a :href="pickRegion(r).path" :aria-current="is(`r:${r}`) ? 'true' : undefined" :class="[HEAD, 'block w-full', is(`r:${r}`) ? '!bg-blue-600 !text-white' : '']" @click.prevent="open(pickRegion(r), $event)">{{ r }}</a>
                </th>
                <th v-if="!oneRegion" scope="col" class="bg-slate-100 border-b border-l border-slate-200 px-3 py-2 text-center font-bold text-slate-500 whitespace-nowrap">合計</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in matrix.categories" :key="c" class="border-b border-slate-100">
                <th scope="row" class="sticky left-0 z-10 border-r border-slate-200 p-0">
                  <a :href="pickCategory(c).path" :aria-current="is(`c:${c}`) ? 'true' : undefined" :class="['block w-full bg-white px-3 py-2 text-left font-medium whitespace-nowrap transition-colors hover:bg-blue-50 hover:text-blue-800', is(`c:${c}`) ? '!bg-blue-600 !text-white' : 'text-slate-800']" @click.prevent="open(pickCategory(c), $event)">{{ c }}</a>
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
                    @click.prevent="open(pickCell(r, c), $event)"
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

    <!-- 摘要抽屜：桌機從右側滑出、手機全寬；背景遮罩、叉叉、Esc 都能關 -->
    <Transition name="drawer">
      <div v-if="selected" class="fixed inset-0 z-[60]" data-testid="matrix-drawer">
        <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" @click="selected = null"></div>
        <aside
          ref="drawerEl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="matrix-drawer-title"
          tabindex="-1"
          class="drawer-panel absolute right-0 top-0 h-full w-full sm:w-[34rem] lg:w-[40rem] max-w-full bg-white shadow-2xl flex flex-col outline-none"
        >
          <header class="border-b border-slate-200 px-4 py-3">
            <div class="flex items-start justify-between gap-3">
              <h2 id="matrix-drawer-title" class="min-w-0 font-bold text-slate-800 leading-snug">{{ selected.title }}</h2>
              <button type="button" class="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="關閉" @click="selected = null"><X :size="20" /></button>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                :disabled="!panel.text"
                :class="[DRAWER_BTN, copied ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700', 'disabled:cursor-not-allowed disabled:opacity-40']"
                data-testid="matrix-copy"
                @click="copyRaw"
              >
                <component :is="copied ? Check : Copy" :size="16" />{{ copied ? '已複製' : '複製給 AI' }}
              </button>
              <a :href="selected.path" target="_blank" rel="noopener" :class="[DRAWER_BTN, 'border-slate-200 text-slate-700 hover:bg-slate-50']">
                <ExternalLink :size="16" />另開視窗
              </a>
            </div>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <p v-if="panel.loading" class="text-slate-500">載入中…</p>
            <p v-else-if="panel.failed" class="text-slate-500">這一份的摘要讀取失敗</p>
            <template v-else-if="preview">
              <p v-if="preview.dataAsOf" class="mb-2 text-xs text-slate-400">資料更新：{{ preview.dataAsOf }}</p>
              <!-- 內容來自資料庫：lib/md/html.ts 已把原始 HTML 跳脫、只放安全網址、連結新分頁開 -->
              <article class="md-doc" v-html="preview.html" />
            </template>
          </div>
        </aside>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.drawer-enter-active, .drawer-leave-active { transition: opacity 0.2s ease; }
.drawer-enter-active .drawer-panel, .drawer-leave-active .drawer-panel { transition: transform 0.25s ease; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-from .drawer-panel, .drawer-leave-to .drawer-panel { transform: translateX(100%); }
@media (prefers-reduced-motion: reduce) {
  .drawer-enter-active, .drawer-leave-active, .drawer-enter-active .drawer-panel, .drawer-leave-active .drawer-panel { transition: none; }
}

/* 沒裝 typography plugin，跟技能頁（Skill.vue）一樣手寫最小一套文件樣式，尺寸小一級 */
.md-doc :deep(h1) { font-size: 1.25rem; font-weight: 900; color: #0f172a; margin: 0 0 0.75rem; line-height: 1.3; }
.md-doc :deep(h2) { font-size: 1.1rem; font-weight: 800; color: #0f172a; margin: 1.5rem 0 0.5rem; padding-top: 1rem; border-top: 1px solid #e2e8f0; }
.md-doc :deep(h2:first-child) { margin-top: 0; padding-top: 0; border-top: 0; }
.md-doc :deep(h3) { font-size: 1rem; font-weight: 700; color: #1e293b; margin: 1.25rem 0 0.4rem; }
.md-doc :deep(p), .md-doc :deep(li) { color: #334155; line-height: 1.75; font-size: 0.9rem; }
.md-doc :deep(p) { margin: 0.5rem 0; }
.md-doc :deep(ul), .md-doc :deep(ol) { padding-left: 1.3rem; margin: 0.4rem 0; }
.md-doc :deep(ul) { list-style: disc; }
.md-doc :deep(ol) { list-style: decimal; }
.md-doc :deep(li) { margin: 0.2rem 0; }
.md-doc :deep(strong) { color: #0f172a; font-weight: 700; }
.md-doc :deep(a) { color: #1d4ed8; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.md-doc :deep(code) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: #f1f5f9; padding: 0.1rem 0.3rem; border-radius: 0.3rem; color: #0f172a; overflow-wrap: anywhere; }
.md-doc :deep(pre) { background: #0f172a; color: #e2e8f0; border-radius: 0.6rem; padding: 0.75rem 1rem; overflow-x: auto; margin: 0.6rem 0; font-size: 0.8rem; line-height: 1.6; }
.md-doc :deep(pre code) { background: transparent; color: inherit; padding: 0; overflow-wrap: normal; }
.md-doc :deep(blockquote) { border-left: 4px solid #3b82f6; background: #eff6ff; margin: 0.6rem 0; padding: 0.3rem 0.9rem; border-radius: 0 0.5rem 0.5rem 0; }
.md-doc :deep(table) { width: 100%; border-collapse: collapse; margin: 0.6rem 0; font-size: 0.8rem; display: block; overflow-x: auto; }
.md-doc :deep(th), .md-doc :deep(td) { border: 1px solid #e2e8f0; padding: 0.4rem 0.55rem; text-align: left; vertical-align: top; }
.md-doc :deep(th) { background: #f8fafc; font-weight: 700; color: #0f172a; }
.md-doc :deep(hr) { border: 0; border-top: 1px solid #e2e8f0; margin: 1.25rem 0; }
</style>
