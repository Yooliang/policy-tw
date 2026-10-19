<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import Hero from '../components/Hero.vue'
import MechanismNav from '../components/MechanismNav.vue'
import BoardNav from '../components/contributions/BoardNav.vue'
import { usePageHead } from '../composables/usePageHead'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import {
  NATIONAL_VIEW, breadcrumbs, buildMap, canDrill, drillDown, drillUp, normalizeRows, parentCodeOf, legendItems, tooltipLines, unitColor, unitHref, viewKey,
  type ColorMode, type CountRow, type MapUnit, type MapView,
} from '../lib/candidacy-map'
import { boundaryPath, decodeRaster, outlinePath, placeLabels, unitFillPaths, unitStats, type DecodedRaster, type RasterFile } from '../lib/raster-grid'
import { clampCenter, ZOOM_AFTER_DRILL_DOWN, ZOOM_AFTER_DRILL_UP, resolveWheel, type Pt } from '../lib/map-zoom'
import { Map as MapIcon, ChevronLeft, LayoutGrid, List, ExternalLink, Plus, Minus, RotateCcw } from 'lucide-vue-next'

/**
 * 參選地圖（#680）：把真實邊界點陣化成固定尺度的方格（全國與縣市 1 公里一格、村里 200 公尺一格），
 * 每格的顏色＝它所屬行政區的 2026 參選人數；滑過任一格高亮整個行政區，點擊往下鑽，麵包屑回上一層。
 * 形狀是預先產生的靜態檔（data/tw-raster/，產生方式見 scripts/build-tw-raster.ts），執行時不打外部 API；
 * 人數來自資料庫函式 candidacy_map，每次只查目前這一層。村里層只載入選中那一個鄉鎮的形狀與人數。
 * 同一行政區的格子合併成一條 SVG path（lib/raster-grid.ts），不是一格一個元素。純邏輯與測試在 lib/。
 */

const ELECTION_ID = 2026

const view = ref<MapView>(NATIONAL_VIEW)
const mode = ref<'grid' | 'list'>('grid')
/** 著色：預設看收錄率（綠黃紅），也可以看人數（中性灰階）。色碼是固定 hex（lib/candidacy-map.ts），不拼 Tailwind class */
const colorMode = ref<ColorMode>('coverage')
const loading = ref(false)
const failed = ref(false)
const selected = ref<string | null>(null)
const hovered = ref<string | null>(null)

const countCache = new Map<string, CountRow[]>()
const rasterCache = new Map<string, DecodedRaster>()
const nameByCode = ref(new Map<string, string>())
const rows = ref<CountRow[]>([])
const raster = shallowRef<DecodedRaster | null>(null)

const townFiles = import.meta.glob<{ default: unknown }>('../data/tw-raster/towns/*.json')
const villageFiles = import.meta.glob<{ default: unknown }>('../data/tw-raster/villages/*.json')

async function loadCounts(v: MapView): Promise<CountRow[]> {
  const key = viewKey(v)
  const hit = countCache.get(key)
  if (hit) return hit
  const { data } = await withTimeoutAndRetry(`參選地圖 ${key}`, (signal) =>
    supabasePublic.rpc('candidacy_map', {
      p_election_id: ELECTION_ID,
      p_level: v.level,
      ...(parentCodeOf(v) ? { p_parent: parentCodeOf(v) } : {}),
    }).abortSignal(signal).throwOnError())
  const list = normalizeRows((data ?? []) as Array<Record<string, unknown>>)
  countCache.set(key, list)
  return list
}

async function loadRaster(v: MapView): Promise<DecodedRaster> {
  const key = viewKey(v)
  const hit = rasterCache.get(key)
  if (hit) return hit
  let file: unknown
  if (v.level === 'county') file = (await import('../data/tw-raster/national.json')).default
  else {
    const loaders = v.level === 'town' ? townFiles : villageFiles
    const dir = v.level === 'town' ? 'towns' : 'villages'
    const code = v.level === 'town' ? v.countyCode : v.townCode
    const load = loaders[`../data/tw-raster/${dir}/${code}.json`]
    if (!load) throw new Error(`沒有 ${code} 的形狀檔`)
    file = (await load()).default
  }
  const decoded = decodeRaster(file as RasterFile)
  rasterCache.set(key, decoded)
  return decoded
}

function rememberNames(list: CountRow[]) {
  for (const r of list) nameByCode.value.set(r.code, r.name)
  nameByCode.value = new Map(nameByCode.value)
}

async function show(v: MapView) {
  const wanted = viewKey(v)
  loading.value = true
  failed.value = false
  try {
    const [counts, shape] = await Promise.all([loadCounts(v), loadRaster(v)])
    if (viewKey(view.value) !== wanted) return // 切太快：晚回來的舊請求不能蓋掉新的
    rememberNames(counts)
    rows.value = counts
    raster.value = shape
  } catch (e) {
    if (viewKey(view.value) !== wanted) return
    console.info('[參選地圖] 讀取失敗', e)
    failed.value = true
  } finally {
    if (viewKey(view.value) === wanted) loading.value = false
  }
}

/** 換層之後的縮放：往下鑽從 ZOOM_AFTER_DRILL_DOWN 起；回上一層聚焦在剛才那個行政區上（滾輪縮放用） */
let pendingFocus: { code: string | null; zoom: number } | null = null

function go(v: MapView, focus: { code: string | null; zoom: number } | null = null) {
  pendingFocus = focus
  view.value = v
  rows.value = []
  raster.value = null
  selected.value = null
  hovered.value = null
  resetZoom()
}
watch(view, (v) => { void show(v) })
onMounted(() => {
  void show(view.value)
  // 縣市名稱要在鄉鎮層、村里層的麵包屑與連結用；直接進來只會有一層，所以縣市層一律先備好
  void loadCounts(NATIONAL_VIEW).then(rememberNames).catch(() => {})
})

const built = computed(() => (raster.value ? buildMap(raster.value, rows.value) : null))
const allUnits = computed(() => (built.value ? [...built.value.units, ...built.value.unshaped] : []))
const total = computed(() => allUnits.value.reduce((s, u) => s + u.candidates, 0))
const crumbs = computed(() => breadcrumbs(view.value, (c) => nameByCode.value.get(c)))
const countyName = computed(() => nameByCode.value.get(view.value.countyCode ?? ''))
const townName = computed(() => nameByCode.value.get(view.value.townCode ?? ''))
const drillable = computed(() => canDrill(view.value))
const scaleLabel = computed(() => {
  const m = raster.value?.cellM ?? 0
  return m >= 1000 ? `${m / 1000} 公里` : `${m} 公尺`
})

// 同一行政區的格子合併成一條 path；邊界線整張圖一條
const fills = computed(() => (raster.value ? unitFillPaths(raster.value) : []))
const boundary = computed(() => (raster.value ? boundaryPath(raster.value) : ''))

const active = computed<MapUnit | null>(() => {
  const code = hovered.value ?? selected.value
  return code ? allUnits.value.find((u) => u.code === code) ?? null : null
})
const activeHref = computed(() => (active.value ? hrefOf(active.value) : null))
const outlineCache = new WeakMap<DecodedRaster, Map<number, string>>()
const activeOutline = computed(() => {
  const r = raster.value
  const u = active.value
  if (!r || !u || u.idx < 0) return ''
  const byIdx = outlineCache.get(r) ?? new Map<number, string>()
  outlineCache.set(r, byIdx)
  if (!byIdx.has(u.idx)) byIdx.set(u.idx, outlinePath(r, u.idx))
  return byIdx.get(u.idx)!
})
const sorted = computed(() => [...allUnits.value].sort((a, b) => b.candidates - a.candidates || a.code.localeCompare(b.code)))

// 名稱標籤：位置取最大內接位置、標籤互相避讓（小面積優先），放不下的不放，滑過仍有提示卡（lib/raster-grid.ts placeLabels）
const fontSize = computed(() => (raster.value ? Math.max(raster.value.w, raster.value.h) / 36 : 10))
const labels = computed(() => {
  const b = built.value
  if (!raster.value || !b) return []
  return placeLabels(raster.value, b.units.map((u) => u.name), fontSize.value).map((l) => ({ ...l, code: b.units[l.idx].code }))
})

function hrefOf(u: MapUnit): string {
  return unitHref(ELECTION_ID, view.value, u, { county: countyName.value, town: townName.value })
}
function colorOf(u: MapUnit): string {
  return unitColor(u, colorMode.value, built.value?.max ?? 0)
}

const canHover = () => typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches
/** 滑鼠：點一下往下鑽。觸控：點一下先選取看數字，再點同一個行政區才往下鑽 */
function pick(u: MapUnit) {
  if (suppressClick) return
  if (drillable.value && (canHover() || selected.value === u.code)) {
    go(drillDown(view.value, u.code))
    return
  }
  selected.value = u.code
}
function drill(u: MapUnit) {
  if (drillable.value) go(drillDown(view.value, u.code))
}

// ── 縮放與平移（手機看小行政區用）：按鈕放大縮小、拖曳平移 ──
const zoom = ref(1)
const center = ref<[number, number]>([0, 0])
const svgEl = ref<SVGSVGElement | null>(null)
let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null
let suppressClick = false

const viewBox = computed(() => {
  const r = raster.value
  if (!r) return '0 0 1 1'
  const w = r.w / zoom.value
  const h = r.h / zoom.value
  const x = Math.min(r.w - w, Math.max(0, center.value[0] - w / 2))
  const y = Math.min(r.h - h, Math.max(0, center.value[1] - h / 2))
  return `${x} ${y} ${w} ${h}`
})
function resetZoom() {
  zoom.value = 1
  center.value = raster.value ? [raster.value.w / 2, raster.value.h / 2] : [0, 0]
}
function setZoom(k: number) {
  zoom.value = Math.min(8, Math.max(1, k))
}
watch(raster, (r) => {
  if (!r) return
  center.value = [r.w / 2, r.h / 2]
  const focus = pendingFocus
  pendingFocus = null
  if (!focus) return
  zoom.value = focus.zoom
  const idx = focus.code ? r.codes.indexOf(focus.code) : -1
  const s = idx >= 0 ? unitStats(r)[idx] : null
  if (s) center.value = clampCenter([s.cx, s.cy], focus.zoom, r.w, r.h)
})

// ── 滾輪縮放（以游標為中心）──
// 只在游標位於地圖上時攔截滾輪（不用按 Ctrl）：地圖本身就是這頁的主角，要的是「捲一捲就放大」；
// 游標移到地圖外（兩側、右邊的資料卡、標題區）頁面照常捲動。需要 Ctrl 的做法會讓一般滾輪使用者找不到縮放，
// 而觸控板的捏合在瀏覽器本來就是帶 Ctrl 的滾輪事件，兩種都走同一條路。
// 縮放到門檻（lib/map-zoom.ts）自動切到游標下行政區的下一層，縮小回最小倍率再縮一格回上一層；
// 切層後 450 毫秒內忽略滾輪（慣性捲動不會一路連跳好幾層）。點擊下鑽與麵包屑照舊。
let wheelLockUntil = 0
function onWheel(e: WheelEvent) {
  const r = raster.value
  const svg = svgEl.value
  if (!r || !svg) return
  e.preventDefault()
  if (performance.now() < wheelLockUntil) return
  const ctm = svg.getScreenCTM()
  if (!ctm) return
  const pt = svg.createSVGPoint()
  pt.x = e.clientX
  pt.y = e.clientY
  const p = pt.matrixTransform(ctm.inverse())
  const gx = Math.floor(p.x)
  const gy = Math.floor(p.y)
  const idx = gx >= 0 && gy >= 0 && gx < r.w && gy < r.h ? r.cells[gy * r.w + gx] : -1
  const unit = idx >= 0 ? built.value?.units[idx] ?? null : null
  const act = resolveWheel(
    { zoom: zoom.value, center: center.value as Pt, w: r.w, h: r.h, canDrillDown: drillable.value && !!unit, canDrillUp: view.value.level !== 'county' },
    e.deltaY, e.ctrlKey, [p.x, p.y],
  )
  if (act.type === 'drillDown' && unit) {
    wheelLockUntil = performance.now() + 450
    go(drillDown(view.value, unit.code), { code: null, zoom: ZOOM_AFTER_DRILL_DOWN })
  } else if (act.type === 'drillUp') {
    wheelLockUntil = performance.now() + 450
    const from = view.value.level === 'village' ? view.value.townCode : view.value.countyCode
    go(drillUp(view.value), { code: from ?? null, zoom: ZOOM_AFTER_DRILL_UP })
  } else if (act.type === 'zoom') {
    zoom.value = act.zoom
    center.value = act.center
  }
}
function onDown(e: PointerEvent) {
  drag = { x: e.clientX, y: e.clientY, cx: center.value[0], cy: center.value[1], moved: false }
}
function onMove(e: PointerEvent) {
  if (!drag || !raster.value || !svgEl.value || zoom.value <= 1) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  if (!drag.moved && Math.hypot(dx, dy) < 5) return
  drag.moved = true
  const rect = svgEl.value.getBoundingClientRect()
  const unit = (raster.value.w / zoom.value) / Math.max(1, rect.width)
  center.value = [drag.cx - dx * unit, drag.cy - dy * unit]
}
function onUp() {
  if (drag?.moved) {
    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
  }
  drag = null
}

const legend = computed(() => legendItems(colorMode.value))
const levelLabel = computed(() => (view.value.level === 'county' ? '縣市' : view.value.level === 'town' ? '鄉鎮市區' : '村里'))

usePageHead({
  title: '參選地圖',
  description: '各縣市、鄉鎮市區、村里的參選人數地圖。',
  noindex: true,
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>參選地圖</template>
      <template #icon><MapIcon :size="400" class="text-blue-500" /></template>
      <template #actions>
        <MechanismNav current="contributions" />
      </template>

      <BoardNav current="map" />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-4" data-testid="candidacy-map">
      <!-- 麵包屑與切換 -->
      <div class="flex flex-wrap items-center gap-2 justify-between">
        <nav class="flex flex-wrap items-center gap-1 text-sm font-black" aria-label="層級" data-testid="map-crumbs">
          <button v-if="view.level !== 'county'" type="button" aria-label="回上一層" data-testid="map-up"
            class="p-2 rounded-xl border border-slate-200 bg-white text-slate-500 hover:border-blue-300 hover:text-blue-600"
            @click="go(drillUp(view))">
            <ChevronLeft :size="16" />
          </button>
          <template v-for="(c, i) in crumbs" :key="i">
            <span v-if="i > 0" class="text-slate-300">/</span>
            <button v-if="i < crumbs.length - 1" type="button" class="px-2 py-1 rounded-lg text-blue-600 hover:bg-blue-50"
              :data-testid="`map-crumb-${i}`" @click="go(c.view)">{{ c.label }}</button>
            <span v-else class="px-2 py-1 text-navy-900" data-testid="map-current">{{ c.label }}</span>
          </template>
          <span class="ml-2 text-slate-500 font-bold" data-testid="map-total">{{ total }} 人</span>
        </nav>
        <div class="flex flex-wrap items-center gap-2">
        <div class="flex rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm" role="group" aria-label="著色">
          <button type="button" :aria-pressed="colorMode === 'coverage'" data-testid="map-color-coverage"
            :class="['px-3 py-2 text-sm font-black', colorMode === 'coverage' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-800']"
            @click="colorMode = 'coverage'">收錄率</button>
          <button type="button" :aria-pressed="colorMode === 'count'" data-testid="map-color-count"
            :class="['px-3 py-2 text-sm font-black', colorMode === 'count' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-800']"
            @click="colorMode = 'count'">人數</button>
        </div>
        <div class="flex rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm" role="group" aria-label="呈現方式">
          <button type="button" :aria-pressed="mode === 'grid'" data-testid="map-mode-grid"
            :class="['px-3 py-2 text-sm font-black inline-flex items-center gap-1.5', mode === 'grid' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600']"
            @click="mode = 'grid'"><LayoutGrid :size="14" />地圖</button>
          <button type="button" :aria-pressed="mode === 'list'" data-testid="map-mode-list"
            :class="['px-3 py-2 text-sm font-black inline-flex items-center gap-1.5', mode === 'list' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600']"
            @click="mode = 'list'"><List :size="14" />清單</button>
        </div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem] gap-4 items-start">
        <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-3 sm:p-5 min-h-64 relative" :aria-busy="loading">
          <p v-if="failed" class="text-slate-500 font-bold py-10 text-center" data-testid="map-error">
            暫時讀不到資料
            <button type="button" class="ml-2 text-blue-600 underline" @click="show(view)">重試</button>
          </p>
          <p v-else-if="!built" class="text-slate-400 font-bold py-10 text-center">讀取中</p>

          <template v-else>
            <!-- 地圖：每個行政區一條 path（同區格子合併），滑過高亮整區、點擊往下鑽 -->
            <template v-if="mode === 'grid' && raster">
              <div class="absolute right-3 top-3 z-10 flex flex-col gap-1" data-testid="map-zoom">
                <button type="button" aria-label="放大" class="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-blue-600" @click="setZoom(zoom * 1.6)"><Plus :size="16" /></button>
                <button type="button" aria-label="縮小" class="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-blue-600" @click="setZoom(zoom / 1.6)"><Minus :size="16" /></button>
                <button v-if="zoom > 1" type="button" aria-label="重設" class="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-blue-600" @click="resetZoom"><RotateCcw :size="16" /></button>
              </div>
              <svg ref="svgEl" :viewBox="viewBox" preserveAspectRatio="xMidYMid meet" class="w-full h-auto mx-auto block select-none touch-pan-y"
                :style="{ maxHeight: '78vh', aspectRatio: `${raster.w} / ${raster.h}`, touchAction: zoom > 1 ? 'none' : 'pan-y', overscrollBehavior: 'contain' }"
                role="group" :aria-label="`${levelLabel}地圖`" data-testid="map-svg"
                @wheel="onWheel" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @pointerleave="onUp">
                <g shape-rendering="crispEdges">
                  <path v-for="u in built.units" :key="u.code" :d="fills[u.idx]" :fill="colorOf(u)"
                    class="cursor-pointer" role="button" tabindex="0" :aria-label="`${u.name} ${u.candidates} 人`"
                    :data-testid="`cell-${u.code}`" :data-count="u.candidates"
                    @mouseenter="hovered = u.code" @mouseleave="hovered = null" @focus="hovered = u.code" @blur="hovered = null"
                    @click="pick(u)" @keydown.enter.prevent="pick(u)" @keydown.space.prevent="pick(u)" />
                </g>
                <path :d="boundary" fill="none" stroke="#ffffff" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linecap="square" pointer-events="none" opacity="0.9" />
                <rect v-for="(f, i) in raster.insets" :key="`inset-${i}`" :x="f.ox - 0.5" :y="f.oy - 0.5" :width="f.w + 1" :height="f.h + 1"
                  fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" pointer-events="none" />
                <path v-if="activeOutline" :d="activeOutline" fill="none" stroke="#0f172a" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" pointer-events="none" data-testid="map-outline" />
                <g pointer-events="none" text-anchor="middle" font-weight="800">
                  <text v-for="l in labels" :key="l.code" :x="l.x" :y="l.y + l.fs * 0.35" :font-size="l.fs" fill="#0f172a" stroke="#ffffff" :stroke-width="l.fs * 0.22" paint-order="stroke" stroke-linejoin="round" data-testid="map-label">{{ l.text }}</text>
                </g>
              </svg>
            </template>

            <!-- 清單：手機上格子太小時用；一列一個行政區，點了一樣往下鑽 -->
            <ul v-else class="divide-y divide-slate-100" data-testid="map-list">
              <li v-for="u in sorted" :key="u.code">
                <button type="button" class="w-full flex items-center gap-3 py-2.5 px-1 text-left hover:bg-slate-50 rounded-lg"
                  :disabled="!drillable" :data-testid="`row-${u.code}`" @click="drill(u)">
                  <span class="w-3 h-3 rounded-sm flex-shrink-0" :style="{ background: colorOf(u) }"></span>
                  <span class="flex-1 font-black text-navy-900">{{ u.name }}</span>
                  <span class="text-sm text-slate-500 font-bold">
                    <template v-for="(l, i) in tooltipLines(u)" :key="l.label">{{ i ? '・' : '' }}{{ l.label }} {{ l.value }}</template>
                  </span>
                </button>
              </li>
            </ul>

            <div class="flex flex-wrap items-center justify-between gap-2 mt-4 text-xs font-bold text-slate-500">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="map-legend">
                <template v-if="colorMode === 'count'">
                  <span>0</span>
                  <span v-for="(l, i) in legend" :key="i" class="w-6 h-3 rounded-sm" :style="{ background: l.color }"></span>
                  <span>{{ built.max }}</span>
                </template>
                <span v-else v-for="(l, i) in legend" :key="i" class="inline-flex items-center gap-1">
                  <span class="w-4 h-3 rounded-sm" :style="{ background: l.color }"></span>{{ l.label }}
                </span>
              </div>
              <span data-testid="map-scale">每格 {{ scaleLabel }}</span>
            </div>
          </template>
        </section>

        <!-- 滑過或點選的行政區：名稱與三個數字，連到既有的選舉頁 -->
        <aside class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5 lg:sticky lg:top-24" data-testid="map-detail">
          <template v-if="active">
            <h2 class="text-xl font-black text-navy-900 mb-3" data-testid="map-detail-name">{{ active.name }}</h2>
            <dl class="space-y-1.5">
              <div v-for="l in tooltipLines(active)" :key="l.label" class="flex justify-between gap-3">
                <dt class="text-sm font-bold text-slate-500">{{ l.label }}</dt>
                <dd class="font-black text-navy-900">{{ l.value }}</dd>
              </div>
            </dl>
            <div class="mt-4 flex flex-wrap gap-2">
              <button v-if="drillable" type="button" data-testid="map-drill"
                class="px-3 py-2 rounded-xl text-sm font-black bg-blue-600 text-white hover:bg-blue-700" @click="drill(active)">
                看{{ view.level === 'county' ? '鄉鎮市區' : '村里' }}
              </button>
              <RouterLink v-if="activeHref" :to="activeHref" data-testid="map-election-link"
                class="px-3 py-2 rounded-xl text-sm font-black border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600 inline-flex items-center gap-1.5">
                選舉頁<ExternalLink :size="14" />
              </RouterLink>
            </div>
          </template>
          <p v-else class="text-slate-400 font-bold text-sm">點選或滑過行政區</p>
        </aside>
      </div>
    </div>
  </div>
</template>
