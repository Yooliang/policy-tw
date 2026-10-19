<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import Hero from '../components/Hero.vue'
import MechanismNav from '../components/MechanismNav.vue'
import BoardNav from '../components/contributions/BoardNav.vue'
import { usePageHead } from '../composables/usePageHead'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import {
  NATIONAL_VIEW, breadcrumbs, buildMap, canDrill, drillDown, drillUp, normalizeRows, parentCodeOf, rampIndex,
  tooltipLines, unitHref, viewKey, type CountRow, type GridRow, type MapUnit, type MapView,
} from '../lib/candidacy-map'
import { Map as MapIcon, ChevronLeft, LayoutGrid, List, ExternalLink } from 'lucide-vue-next'

/**
 * 參選地圖（#680）：格子地圖看各縣市／鄉鎮市區／村里的 2026 參選人數，點格子往下鑽、麵包屑回上一層。
 * 座標是預先產生的靜態檔（data/tw-grid-*.json，產生方式見 scripts/build-tw-tile-grid.ts）；
 * 人數來自資料庫函式 candidacy_map，每次只查目前這一層。村里層只在選了鄉鎮才載入那一個縣市的座標檔與那一鄉鎮的人數。
 * 純邏輯與測試在 lib/candidacy-map.ts。
 */

const ELECTION_ID = 2026
const CELL = 52
const GAP = 4
/** 顏色分段（0 人灰、其餘由淺到深藍）；SVG 用寫死的色碼，不走 Tailwind 動態 class */
const RAMP = ['#e2e8f0', '#dbeafe', '#93c5fd', '#3b82f6', '#1e40af'] as const

const view = ref<MapView>(NATIONAL_VIEW)
const mode = ref<'grid' | 'list'>('grid')
const loading = ref(false)
const failed = ref(false)
const selected = ref<string | null>(null)
const hovered = ref<string | null>(null)

const countCache = new Map<string, CountRow[]>()
const nameByCode = ref(new Map<string, string>())
const rows = ref<CountRow[]>([])
const gridRows = ref<GridRow[]>([])

let adminGrid: { counties: GridRow[]; towns: Record<string, GridRow[]> } | null = null
const villageFiles = import.meta.glob<{ default: Record<string, GridRow[]> }>('../data/tw-grid-villages/*.json')
const villageCache = new Map<string, Record<string, GridRow[]>>()

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

async function loadGrid(v: MapView): Promise<GridRow[]> {
  if (!adminGrid) adminGrid = (await import('../data/tw-grid-admin.json')).default as unknown as NonNullable<typeof adminGrid>
  if (v.level === 'county') return adminGrid!.counties
  if (v.level === 'town') return adminGrid!.towns[v.countyCode ?? ''] ?? []
  const county = v.countyCode ?? ''
  if (!villageCache.has(county)) {
    const load = villageFiles[`../data/tw-grid-villages/${county}.json`]
    villageCache.set(county, load ? (await load()).default : {})
  }
  return villageCache.get(county)![v.townCode ?? ''] ?? []
}

async function show(v: MapView) {
  const wanted = viewKey(v)
  loading.value = true
  failed.value = false
  try {
    const [counts, grid] = await Promise.all([loadCounts(v), loadGrid(v)])
    if (viewKey(view.value) !== wanted) return // 切太快：晚回來的舊請求不能蓋掉新的
    for (const r of counts) nameByCode.value.set(r.code, r.name)
    nameByCode.value = new Map(nameByCode.value)
    rows.value = counts
    gridRows.value = grid
  } catch (e) {
    if (viewKey(view.value) !== wanted) return
    console.info('[參選地圖] 讀取失敗', e)
    failed.value = true
  } finally {
    if (viewKey(view.value) === wanted) loading.value = false
  }
}

function go(v: MapView) {
  view.value = v
  rows.value = []
  gridRows.value = []
  selected.value = null
  hovered.value = null
}
watch(view, (v) => { void show(v) })
onMounted(() => {
  void show(view.value)
  // 縣市名稱要在鄉鎮層、村里層的麵包屑與連結用；直接進來只會有一層，所以縣市層一律先備好
  void loadCounts(NATIONAL_VIEW).then((c) => { for (const r of c) nameByCode.value.set(r.code, r.name); nameByCode.value = new Map(nameByCode.value) }).catch(() => {})
})

const built = computed(() => buildMap(gridRows.value, rows.value))
const total = computed(() => built.value.units.reduce((s, u) => s + u.candidates, 0))
const crumbs = computed(() => breadcrumbs(view.value, (c) => nameByCode.value.get(c)))
const countyName = computed(() => nameByCode.value.get(view.value.countyCode ?? ''))
const townName = computed(() => nameByCode.value.get(view.value.townCode ?? ''))
const drillable = computed(() => canDrill(view.value))

const active = computed<MapUnit | null>(() => {
  const code = hovered.value ?? selected.value
  return code ? built.value.units.find((u) => u.code === code) ?? null : null
})
const activeHref = computed(() => active.value ? hrefOf(active.value) : null)
const sorted = computed(() => [...built.value.units].sort((a, b) => b.candidates - a.candidates || a.code.localeCompare(b.code)))

function hrefOf(u: MapUnit): string {
  return unitHref(ELECTION_ID, view.value, u, { county: countyName.value, town: townName.value })
}
function fillOf(u: MapUnit): string {
  return RAMP[rampIndex(u.candidates, built.value.max)]
}
function inkOf(u: MapUnit): string {
  return rampIndex(u.candidates, built.value.max) >= 3 ? '#ffffff' : '#1e293b'
}
function nameSize(u: MapUnit): number {
  const n = u.name.length
  return n <= 3 ? 12 : n === 4 ? 10.5 : 8.5
}

const canHover = () => typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches
/** 滑鼠：點一下往下鑽。觸控：點一下先選取看數字，再點同一格才往下鑽 */
function pick(u: MapUnit) {
  if (drillable.value && (canHover() || selected.value === u.code)) {
    go(drillDown(view.value, u.code))
    return
  }
  selected.value = u.code
}
function drill(u: MapUnit) {
  if (drillable.value) go(drillDown(view.value, u.code))
}

const legend = computed(() => RAMP.map((color, i) => ({ color, i })))
const levelLabel = computed(() => (view.value.level === 'county' ? '縣市' : view.value.level === 'town' ? '鄉鎮市區' : '村里'))

usePageHead({
  title: '參選地圖',
  description: '各縣市、鄉鎮市區、村里的參選人數格子地圖。',
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
        <div class="flex rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm" role="group" aria-label="呈現方式">
          <button type="button" :aria-pressed="mode === 'grid'" data-testid="map-mode-grid"
            :class="['px-3 py-2 text-sm font-black inline-flex items-center gap-1.5', mode === 'grid' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600']"
            @click="mode = 'grid'"><LayoutGrid :size="14" />格子</button>
          <button type="button" :aria-pressed="mode === 'list'" data-testid="map-mode-list"
            :class="['px-3 py-2 text-sm font-black inline-flex items-center gap-1.5', mode === 'list' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600']"
            @click="mode = 'list'"><List :size="14" />清單</button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem] gap-4 items-start">
        <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-3 sm:p-5 min-h-64" :aria-busy="loading">
          <p v-if="failed" class="text-slate-500 font-bold py-10 text-center" data-testid="map-error">
            暫時讀不到資料
            <button type="button" class="ml-2 text-blue-600 underline" @click="show(view)">重試</button>
          </p>
          <p v-else-if="loading && !built.units.length" class="text-slate-400 font-bold py-10 text-center">讀取中</p>

          <template v-else>
            <!-- 格子：viewBox 隨格數縮放，寬度吃滿容器、最大不超過原尺寸 -->
            <svg v-if="mode === 'grid'" :viewBox="`0 0 ${built.cols * (CELL + GAP) - GAP} ${built.rows * (CELL + GAP) - GAP}`"
              :style="{ maxWidth: `${built.cols * (CELL + GAP) * 1.4}px` }" class="w-full h-auto mx-auto block select-none"
              role="group" :aria-label="`${levelLabel}格子地圖`" data-testid="map-svg">
              <g v-for="u in built.units" :key="u.code" :transform="`translate(${u.x * (CELL + GAP)} ${u.y * (CELL + GAP)})`"
                class="cursor-pointer" role="button" tabindex="0" :aria-label="`${u.name} ${u.candidates} 人`"
                :data-testid="`cell-${u.code}`" :data-count="u.candidates"
                @mouseenter="hovered = u.code" @mouseleave="hovered = null" @focus="hovered = u.code" @blur="hovered = null"
                @click="pick(u)" @keydown.enter.prevent="pick(u)" @keydown.space.prevent="pick(u)">
                <rect :width="CELL" :height="CELL" rx="6" :fill="fillOf(u)"
                  :stroke="selected === u.code || hovered === u.code ? '#0f172a' : 'none'" stroke-width="2.5" />
                <text :x="CELL / 2" :y="CELL / 2 - 3" text-anchor="middle" :font-size="nameSize(u)" font-weight="800" :fill="inkOf(u)">{{ u.name }}</text>
                <text :x="CELL / 2" :y="CELL / 2 + 14" text-anchor="middle" font-size="13" font-weight="900" :fill="inkOf(u)">{{ u.candidates }}</text>
              </g>
            </svg>

            <!-- 清單：手機上格子太小時用；一列一個行政區，點了一樣往下鑽 -->
            <ul v-else class="divide-y divide-slate-100" data-testid="map-list">
              <li v-for="u in sorted" :key="u.code">
                <button type="button" class="w-full flex items-center gap-3 py-2.5 px-1 text-left hover:bg-slate-50 rounded-lg"
                  :disabled="!drillable" :data-testid="`row-${u.code}`" @click="drill(u)">
                  <span class="w-3 h-3 rounded-sm flex-shrink-0" :style="{ background: fillOf(u) }"></span>
                  <span class="flex-1 font-black text-navy-900">{{ u.name }}</span>
                  <span class="text-sm text-slate-500 font-bold">
                    <template v-for="(l, i) in tooltipLines(u)" :key="l.label">{{ i ? '・' : '' }}{{ l.label }} {{ l.value }}</template>
                  </span>
                </button>
              </li>
            </ul>

            <div class="flex items-center gap-1 mt-4 text-xs font-bold text-slate-500" data-testid="map-legend">
              <span>0</span>
              <span v-for="l in legend" :key="l.i" class="w-6 h-3 rounded-sm" :style="{ background: l.color }"></span>
              <span>{{ built.max }}</span>
            </div>
          </template>
        </section>

        <!-- 滑過或點選的格子：名稱與三個數字，連到既有的選舉頁 -->
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
          <p v-else class="text-slate-400 font-bold text-sm">點選或滑過格子</p>
        </aside>
      </div>
    </div>
  </div>
</template>
