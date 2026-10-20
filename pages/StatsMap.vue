<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import Hero from '../components/Hero.vue'
import MechanismNav from '../components/MechanismNav.vue'
import BoardNav from '../components/contributions/BoardNav.vue'
import MapLayers, { type DrawLayer, type LabelItem } from '../components/map/MapLayers.vue'
import MapCrumbs, { type MapCrumb } from '../components/map/MapCrumbs.vue'
import MapToggles from '../components/map/MapToggles.vue'
import { usePageHead } from '../composables/usePageHead'
import { applyRows, buildLayer, type Layer } from '../lib/map-layer'
import { mapStatsUrl, type MapStatsLevel } from '../lib/map-stats-url'
import { SITE_URL } from '../lib/site'
import { fileCache, labelCache, rowsCache, rowsKey, statsTimeCache } from '../lib/map-data-cache'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import {
  formatStatsTime, legendFor, normalizeRows, tooltipLines, unitColor, unitHref,
  type ColorMode, type CountRow, type MapLevel, type MapUnit,
} from '../lib/candidacy-map'
import { outlinePath, placeLabels, type RasterFile } from '../lib/raster-grid'
import {
  K_MAX, boxesIntersect, cellAt, clampView, expandBox, fitBox, fitK, isZoomWheel, lodFor, pickEvictions, pickVisibleTowns,
  screenToWorld, viewBox, wheelK, zoomAtPoint, zoomModifierLabel, type Box, type Lod, type View,
} from '../lib/map-world'
import { Map as MapIcon, Plus, Minus, Maximize2, ExternalLink, X } from 'lucide-vue-next'

/**
 * 參選地圖（#680）：單一張全國大地圖連續縮放，像線上地圖。
 * - 世界座標＝全國層畫布（公里）；縣市層與鄉鎮層 1 公里一格、村里層 200 公尺一格，全部對齊同一條格線
 *   （data/tw-raster/，scripts/build-tw-raster.ts 產生；點陣化的純函式在 lib/raster-grid.ts）。
 * - 細節層（LOD）只看縮放（螢幕上每公里幾像素，lib/map-world.ts）：縮小看縣市、中間看鄉鎮、放大看村里，
 *   切換不換頁、不重設視角。縣市層與鄉鎮層全國一次載入；村里層只載入視窗內看得到的鄉鎮，離開後釋放（上限 MAX_VILLAGE_TOWNS 個，釋放的只是解碼後的 path，原始 JSON 與人數留在快取）。
 * - 同一行政區的格子合併成一條 SVG path（不是一格一個元素），所以路徑數：縣市 22、鄉鎮 368、村里層視窗內大約幾百條。
 *   SVG 的平移縮放只改 viewBox，不重畫路徑，評估過 canvas：這個量級 SVG 就夠，而且滑過高亮、點擊、無障礙現成，所以沒用 canvas。
 */

const ELECTION_ID = 2026
/** 同時留在記憶體裡的村里鄉鎮檔上限（超過就釋放最久沒看的） */
const MAX_VILLAGE_TOWNS = 200
/** 視窗內最多同時要村里的鄉鎮數 */
const MAX_VISIBLE_TOWNS = 40
const LABEL_PX = 12

const mode = ref<'grid' | 'list'>('grid')
const colorMode = ref<ColorMode>('coverage')
const failed = ref(false)
const pending = ref(0)

// ── 資料 ──────────────────────────────────────────────────────
const nameByCode = shallowRef(new Map<string, string>())
const countyLayer = shallowRef<Layer | null>(null)
const townLayers = shallowRef<Layer[]>([])
const villageLayers = shallowRef(new Map<string, Layer>())
const layerIndex = new Map<string, Layer>()
const unitIndex = new Map<string, { layer: Layer; idx: number }>()
const villageUsed = new Map<string, number>()
const inflight = new Set<string>()
let townsPromise: Promise<void> | null = null

const townFiles = import.meta.glob<{ default: unknown }>('../data/tw-raster/towns/*.json')
const villageFiles = import.meta.glob<{ default: unknown }>('../data/tw-raster/villages/*.json')

/**
 * 人數：依（屆別、層級、上層代碼）在模組層快取（lib/map-data-cache.ts），進行中的同一個請求共用；
 * 縮放切換細節層、來回捲動、離開頁面再回來都不再重打 candidacy_map。
 */
/** 先打正見.tw 的 /api/map-stats（Worker 在邊緣快取約 5 分鐘）；任何失敗（沒有 Worker、逾時、回的不是陣列）退回直接呼叫 Supabase RPC */
async function viaEdge(level: MapStatsLevel, parent?: string | null): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(mapStatsUrl(SITE_URL, ELECTION_ID, level, parent), { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`edge ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error('edge not array')
  return data as Array<Record<string, unknown>>
}
async function fetchRows(level: MapLevel, parent?: string): Promise<CountRow[]> {
  const rows = await rowsCache.get(rowsKey(ELECTION_ID, level, parent), async () => {
    try {
      return normalizeRows(await viaEdge(level, parent))
    } catch {
      const { data } = await withTimeoutAndRetry(`參選地圖 ${level}:${parent ?? ''}`, (signal) =>
        supabasePublic.rpc('candidacy_map', { p_election_id: ELECTION_ID, p_level: level, ...(parent ? { p_parent: parent } : {}) })
          .abortSignal(signal).throwOnError())
      return normalizeRows((data ?? []) as Array<Record<string, unknown>>)
    }
  })
  return rows
}

/** 統計時間（資料庫排程重算的時間）：圖例旁的小標籤；讀不到就不顯示 */
const statsAt = ref<string | null>(null)
function loadStatsTime() {
  statsTimeCache.get(String(ELECTION_ID), async () => {
    const pick = (data: unknown) => ((data as Array<{ computed_at?: string }> | null)?.[0]?.computed_at ?? null)
    try {
      return pick(await viaEdge('meta'))
    } catch {
      const { data } = await withTimeoutAndRetry('參選地圖統計時間', (signal) =>
        supabasePublic.from('candidacy_map_stats').select('computed_at').eq('election_id', ELECTION_ID).eq('scope', 'nation')
          .order('computed_at', { ascending: false }).limit(1).abortSignal(signal).throwOnError())
      return pick(data)
    }
  }).then((v) => { statsAt.value = formatStatsTime(v) }).catch(() => { statsAt.value = null })
}

/** 人數回來只負責上色：把數字套到已經畫好的圖層（名稱與邊界早就在了），再讓畫面重新上色 */
const rev = ref(0)
const rowsFailed = ref(false)
function loadRowsInto(layers: Layer[], level: MapLevel, parent?: string) {
  fetchRows(level, parent).then((rows) => {
    for (const L of layers) applyRows(L, rows)
    rowsFailed.value = false
    rev.value += 1
  }).catch((e) => {
    console.info('[參選地圖] 人數讀取失敗', level, parent, e)
    rowsFailed.value = true
  })
}
function retryRows() {
  rowsFailed.value = false
  if (countyLayer.value && !countyLayer.value.ready) loadRowsInto([countyLayer.value], 'county')
  if (townLayers.value.length && !townLayers.value[0].ready) loadRowsInto(townLayers.value, 'town')
  for (const [code, L] of villageLayers.value) if (!L.ready) loadRowsInto([L], 'village', code)
}

function makeLayer(key: string, level: MapLevel, file: unknown, rows: CountRow[]): Layer {
  // 解碼、合成 path 只在第一次載入做一次；markRaw 讓 Vue 不深層追蹤這些大陣列與字串
  const layer = markRaw(buildLayer(key, level, file as RasterFile, rows))
  layerIndex.set(key, layer)
  const names = new Map(nameByCode.value)
  layer.built.units.forEach((unit, idx) => { unitIndex.set(unit.code, { layer, idx }); names.set(unit.code, unit.name) })
  nameByCode.value = names
  return layer
}

async function loadCounty() {
  failed.value = false
  pending.value += 1
  try {
    const file = await fileCache.get('national', () => import('../data/tw-raster/national.json').then((m) => m.default))
    countyLayer.value = makeLayer('county', 'county', file, [])
    loadRowsInto([countyLayer.value], 'county')
  } catch (e) {
    console.info('[參選地圖] 讀取失敗', e)
    failed.value = true
  } finally {
    pending.value -= 1
  }
}

/** 鄉鎮層：22 個縣市檔＋全部鄉鎮的人數，一次載入 */
function ensureTowns(): Promise<void> {
  if (townsPromise) return townsPromise
  pending.value += 1
  townsPromise = (async () => {
    const files = await Promise.all(Object.entries(townFiles).map(async ([path, load]) => [path.match(/towns\/(\d+)\.json/)![1], await fileCache.get(`towns/${path.match(/towns\/(\d+)\.json/)![1]}`, () => load().then((m) => m.default))] as const))
    townLayers.value = files.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([code, file]) => makeLayer(`town:${code}`, 'town', file, []))
    refreshVisible()
    loadRowsInto(townLayers.value, 'town')
  })().catch((e) => {
    console.info('[參選地圖] 鄉鎮層讀取失敗', e)
    townsPromise = null
    failed.value = !countyLayer.value
  }).finally(() => { pending.value -= 1 })
  return townsPromise
}

const queue: string[] = []
let running = 0
function ensureVillage(code: string) {
  if (villageLayers.value.has(code) || inflight.has(code)) return
  inflight.add(code)
  queue.push(code)
  pump()
}
function pump() {
  while (running < 4 && queue.length) {
    const code = queue.shift()!
    running += 1
    pending.value += 1
    ;(async () => {
      const load = villageFiles[`../data/tw-raster/villages/${code}.json`]
      if (!load) return
      const file = await fileCache.get(`villages/${code}`, () => load().then((m) => m.default))
      const layer = makeLayer(`village:${code}`, 'village', file, [])
      loadRowsInto([layer], 'village', code)
      const next = new Map(villageLayers.value)
      next.set(code, layer)
      villageLayers.value = next
      villageUsed.set(code, performance.now())
    })().catch((e) => console.info('[參選地圖] 村里讀取失敗', code, e)).finally(() => {
      inflight.delete(code)
      running -= 1
      pending.value -= 1
      refreshVisible()
      pump()
    })
  }
}

// ── 檢視 ──────────────────────────────────────────────────────
// 手勢期間的檢視（cur）是普通物件：縮放、平移只改外層 svg 的 viewBox 屬性（rAF 合併，每格最多一次），
// 不經過 Vue 的反應式、不重新渲染任何 path，也不重畫 SVG（改 CSS transform，瀏覽器直接合成）。停下約 150 毫秒（最久 400 毫秒）後才把 cur 同步給 view，
// 才做細節層切換、視窗內鄉鎮清單、標籤排版、路徑與網址更新。
const stage = ref<HTMLElement | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const size = ref({ w: 900, h: 620 })
const cur: View = { cx: 0, cy: 0, k: 1 }
const view = ref<View>({ cx: 0, cy: 0, k: 1 })
const lod = ref<Lod>('county')
const world = computed(() => (countyLayer.value ? { w: countyLayer.value.raster.w, h: countyLayer.value.raster.h } : null))
const kMin = computed(() => (world.value ? fitK(world.value, size.value.w, size.value.h) : 1))
let observer: ResizeObserver | null = null
let animId = 0

// 兩層：viewBox 只在「停下來」（commit）或改版面時才寫；手勢期間只改 svg 元素的 CSS transform（GPU 合成已經畫好的圖，
// 不重畫任何 path），用 base（上次寫進 viewBox 的視角）與 cur 的差換算成平移加縮放。
let base: View = { cx: 0, cy: 0, k: 1 }
let applyQueued = false
function applyViewBox() {
  const el = svgEl.value
  if (!el) return
  base = { ...cur }
  const b = viewBox(base, size.value.w, size.value.h)
  el.setAttribute('viewBox', `${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}`)
  el.style.transform = ''
}
function applyTransform() {
  const el = svgEl.value
  if (!el) return
  const { w, h } = size.value
  const vx = (v: View) => v.cx - w / (2 * v.k)
  const vy = (v: View) => v.cy - h / (2 * v.k)
  const s = cur.k / base.k
  el.style.transform = `translate(${(vx(base) - vx(cur)) * cur.k}px, ${(vy(base) - vy(cur)) * cur.k}px) scale(${s})`
}
function scheduleApply() {
  if (applyQueued) return
  applyQueued = true
  requestAnimationFrame(() => { applyQueued = false; applyTransform() })
}
let commitTimer: ReturnType<typeof setTimeout> | undefined
let commitFirst = 0
function commitView() {
  commitFirst = 0
  applyViewBox()
  view.value = { ...cur }
  svgEl.value?.classList.remove('moving')
}
function scheduleCommit() {
  const now = performance.now()
  if (!commitFirst) commitFirst = now
  clearTimeout(commitTimer)
  commitTimer = setTimeout(commitView, Math.max(0, Math.min(150, commitFirst + 400 - now)))
}
function setView(v: View) {
  const c = world.value ? clampView(v, world.value) : v
  cur.cx = c.cx
  cur.cy = c.cy
  cur.k = c.k
  svgEl.value?.classList.add('moving')
  scheduleApply()
  scheduleCommit()
}
function fitAll() {
  if (!world.value) return
  animateTo({ cx: world.value.w / 2, cy: world.value.h / 2, k: kMin.value })
}
function zoomBy(f: number) {
  animateTo({ cx: cur.cx, cy: cur.cy, k: Math.min(K_MAX, Math.max(kMin.value, cur.k * f)) }, 220)
}

function cancelAnim() { animId += 1 }
function animateTo(target: View, ms = 380) {
  const from = { ...cur }
  const id = ++animId
  const t0 = performance.now()
  const lk0 = Math.log(from.k)
  const lk1 = Math.log(target.k)
  const step = (now: number) => {
    if (id !== animId) return
    const t = Math.min(1, (now - t0) / ms)
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    setView({ cx: from.cx + (target.cx - from.cx) * e, cy: from.cy + (target.cy - from.cy) * e, k: Math.exp(lk0 + (lk1 - lk0) * e) })
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

watch(() => view.value.k, (k) => {
  const next = lodFor(k, lod.value)
  if (next !== lod.value) lod.value = next
})
watch(lod, (l) => { if (l !== 'county') void ensureTowns() })
watch(view, () => scheduleRefresh(), { deep: false })
watch(svgEl, (el) => { if (el) applyViewBox() }, { flush: 'post' })

// ── 目前要畫哪些層 ────────────────────────────────────────────
const renderState = shallowRef<{ towns: Layer[]; villages: Layer[]; key: string }>({ towns: [], villages: [], key: '' })
let refreshQueued = false
function scheduleRefresh() {
  if (refreshQueued) return
  refreshQueued = true
  requestAnimationFrame(() => { refreshQueued = false; refreshVisible() })
}
let townBoxCache: { src: Layer[]; boxes: Array<{ code: string; box: Box }> } | null = null
function townBoxes(): Array<{ code: string; box: Box }> {
  if (townBoxCache && townBoxCache.src === townLayers.value) return townBoxCache.boxes
  const out: Array<{ code: string; box: Box }> = []
  for (const L of townLayers.value) {
    L.built.units.forEach((u, i) => {
      const s = L.stats[i]
      if (s) out.push({ code: u.code, box: { x0: L.tx + s.minX * L.u, y0: L.ty + s.minY * L.u, x1: L.tx + s.maxX * L.u, y1: L.ty + s.maxY * L.u } })
    })
  }
  townBoxCache = { src: townLayers.value, boxes: out }
  return out
}
function refreshVisible() {
  const vb = viewBox(view.value, size.value.w, size.value.h)
  const padded = expandBox(vb, 0.15)
  let towns: Layer[] = []
  let villages: Layer[] = []
  if (lod.value !== 'county') towns = townLayers.value.filter((L) => boxesIntersect(L.box, padded))
  if (lod.value === 'village' && townLayers.value.length) {
    const want = pickVisibleTowns(townBoxes(), vb, MAX_VISIBLE_TOWNS)
    const now = performance.now()
    for (const code of want) {
      ensureVillage(code)
      if (villageLayers.value.has(code)) villageUsed.set(code, now)
    }
    const drop = pickEvictions(new Map([...villageLayers.value.keys()].map((c) => [c, villageUsed.get(c) ?? 0])), new Set(want), MAX_VILLAGE_TOWNS)
    if (drop.length) {
      const next = new Map(villageLayers.value)
      for (const c of drop) {
        const L = next.get(c)
        if (L) { layerIndex.delete(L.key); for (const u of L.built.units) unitIndex.delete(u.code) }
        next.delete(c)
        villageUsed.delete(c)
      }
      villageLayers.value = next
    }
    villages = [...villageLayers.value.values()].filter((L) => boxesIntersect(L.box, padded))
  }
  const key = `${lod.value}|${towns.map((l) => l.key).join(',')}|${villages.map((l) => l.key).join(',')}`
  if (key !== renderState.value.key) renderState.value = { towns, villages, key }
}
watch([townLayers, villageLayers, countyLayer], () => scheduleRefresh())
watch(lod, () => refreshVisible())

const hiddenTowns = computed(() => new Set(lod.value === 'village' ? renderState.value.villages.map((L) => L.key.slice('village:'.length)) : []))
const drawLayers = computed<DrawLayer[]>(() => {
  void rev.value // 人數回來時重建單位陣列（名稱與 path 不變，只重新上色）
  const out: DrawLayer[] = []
  if (!countyLayer.value) return out
  // 鄉鎮層還沒載好（第一次放大的那一下）先用縣市層墊著，不會空白
  if (lod.value === 'county' || !townLayers.value.length) return [{ layer: countyLayer.value, units: countyLayer.value.built.units }]
  for (const L of renderState.value.towns) out.push({ layer: L, units: L.built.units.filter((u) => !hiddenTowns.value.has(u.code)) })
  for (const L of renderState.value.villages) out.push({ layer: L, units: L.built.units })
  return out
})

const maxByLevel = computed(() => (void rev.value, {
  county: countyLayer.value?.built.max ?? 0,
  town: townLayers.value.reduce((m, L) => Math.max(m, L.built.max), 0),
  village: [...villageLayers.value.values()].reduce((m, L) => Math.max(m, L.built.max), 0),
}))
// ── 滑過、點選、提示卡 ────────────────────────────────────────
const hover = ref<{ key: string; idx: number } | null>(null)
const selected = ref<{ key: string; idx: number } | null>(null)
const activeRef = computed(() => hover.value ?? selected.value)
const activeLayer = computed(() => (activeRef.value ? layerIndex.get(activeRef.value.key) ?? null : null))
const active = computed<MapUnit | null>(() => (void rev.value, activeLayer.value && activeRef.value ? activeLayer.value.built.units[activeRef.value.idx] ?? null : null))
const outlineCache = new Map<string, string>()
const activeOutline = computed(() => {
  const L = activeLayer.value
  const r = activeRef.value
  if (!L || !r) return ''
  const k = `${r.key}:${r.idx}`
  if (!outlineCache.has(k)) outlineCache.set(k, outlinePath(L.raster, r.idx))
  return outlineCache.get(k)!
})
/** 這一區的人數資料回來了沒（沒回來就只顯示名稱，不顯示 0 人） */
function isReady(u: MapUnit): boolean {
  void rev.value
  return unitIndex.get(u.code)?.layer.ready ?? false
}
const activeReady = computed(() => (active.value ? isReady(active.value) : false))
const activeHref = computed(() => (active.value ? hrefOf(active.value) : null))

function hrefOf(u: MapUnit): string {
  const level: MapLevel = u.code.length === 5 ? 'county' : u.code.length === 8 ? 'town' : 'village'
  return unitHref(ELECTION_ID, { level }, u, { county: nameByCode.value.get(u.code.slice(0, 5)), town: nameByCode.value.get(u.code.slice(0, 8)) })
}

function boxOfUnit(code: string): Box | null {
  const hit = unitIndex.get(code)
  const s = hit ? hit.layer.stats[hit.idx] : null
  if (!hit || !s) return null
  const L = hit.layer
  return { x0: L.tx + s.minX * L.u, y0: L.ty + s.minY * L.u, x1: L.tx + s.maxX * L.u, y1: L.ty + s.maxY * L.u }
}
/** 放大並置中到某個行政區（點擊格子、點路徑、點清單） */
function zoomToCode(code: string | null, instant = false) {
  if (!world.value) return
  if (!code) { fitAll(); return }
  const box = boxOfUnit(code)
  if (!box) return
  const target = fitBox(box, size.value.w, size.value.h, 1.4, kMin.value)
  if (instant) { cancelAnim(); setView(target) } else animateTo(target)
}

let suppressClick = false
function onHover(hit: { key: string; idx: number } | null) {
  hover.value = hit
}
function onPick(hit: { key: string; idx: number }) {
  if (suppressClick) return
  const u = layerIndex.get(hit.key)?.built.units[hit.idx]
  if (!u) return
  selected.value = hit
  zoomToCode(u.code)
}

// ── 手勢：滾輪（以游標為中心）、拖曳平移、雙指捏合 ─────────────────
// 滾輪：一般滾輪不攔截（捲頁面），Ctrl／⌘＋滾輪才縮放地圖，所以滿版地圖不會把整頁卡住；觸控板捏合是帶 ctrlKey 的 wheel，照樣縮放。
// 觸控：單指留給頁面捲動（touch-action: pan-y），雙指縮放與平移地圖；滑鼠拖曳平移照舊。
function localPoint(e: { clientX: number; clientY: number }): [number, number] {
  const r = stage.value?.getBoundingClientRect()
  return [e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)]
}
// 提示：一般滾輪在地圖上時淡入一句「按住 Ctrl（Mac ⌘）再滾動可縮放地圖」，約 1.5 秒淡出
const wheelHint = ref(false)
const zoomKey = typeof navigator === 'undefined' ? 'Ctrl' : zoomModifierLabel(navigator.platform || navigator.userAgent)
let hintTimer: ReturnType<typeof setTimeout> | undefined
function showWheelHint() {
  wheelHint.value = true
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => { wheelHint.value = false }, 1500)
}
function onWheel(e: WheelEvent) {
  if (!world.value) return
  // 像嵌入式地圖：一般滾輪＝捲頁面（不攔截），Ctrl／⌘＋滾輪（觸控板捏合本來就帶 ctrlKey）＝縮放地圖
  if (!isZoomWheel(e)) {
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) showWheelHint()
    return
  }
  e.preventDefault()
  cancelAnim()
  const [px, py] = localPoint(e)
  const k2 = wheelK(cur.k, e.deltaY, e.ctrlKey, kMin.value)
  setView(zoomAtPoint(cur, size.value.w, size.value.h, px, py, k2))
}

const pointers = new Map<number, { x: number; y: number }>()
let touchMode = false
let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null
let pinch: { dist: number; view: View; mid: [number, number] } | null = null
function mid(): [number, number] {
  const [a, b] = [...pointers.values()]
  const r = stage.value?.getBoundingClientRect()
  return [(a.x + b.x) / 2 - (r?.left ?? 0), (a.y + b.y) / 2 - (r?.top ?? 0)]
}
function dist(): number {
  const [a, b] = [...pointers.values()]
  return Math.hypot(a.x - b.x, a.y - b.y)
}
function onPointerDown(e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  cancelAnim()
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  touchMode = e.pointerType === 'touch'
  if (pointers.size === 1 && !touchMode) drag = { x: e.clientX, y: e.clientY, cx: cur.cx, cy: cur.cy, moved: false }
  else if (pointers.size === 2) { drag = null; pinch = { dist: dist(), view: { ...cur }, mid: mid() } }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
}
function onPointerMove(e: PointerEvent) {
  const p = pointers.get(e.pointerId)
  if (!p) return
  p.x = e.clientX
  p.y = e.clientY
  if (pinch && pointers.size >= 2) {
    suppressClick = true
    const k2 = Math.min(K_MAX, Math.max(kMin.value, pinch.view.k * (dist() / Math.max(1, pinch.dist))))
    const v = zoomAtPoint(pinch.view, size.value.w, size.value.h, pinch.mid[0], pinch.mid[1], k2)
    const m = mid()
    setView({ k: k2, cx: v.cx - (m[0] - pinch.mid[0]) / k2, cy: v.cy - (m[1] - pinch.mid[1]) / k2 })
  } else if (drag) {
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    drag.moved = true
    suppressClick = true
    setView({ k: cur.k, cx: drag.cx - dx / cur.k, cy: drag.cy - dy / cur.k })
  }
}
function onPointerUp(e: PointerEvent) {
  pointers.delete(e.pointerId)
  if (pointers.size < 2) pinch = null
  if (pointers.size === 1 && !touchMode) {
    const [rest] = [...pointers.values()]
    drag = { x: rest.x, y: rest.y, cx: cur.cx, cy: cur.cy, moved: true }
  }
  if (pointers.size === 0) {
    drag = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    setTimeout(() => { suppressClick = false }, 0)
  }
}

// ── 游標或視窗中心所在的縣市／鄉鎮／村里（路徑用）─────────────────
const probe = ref<[number, number] | null>(null)
let probeQueued = false
function onSvgMove(e: MouseEvent) {
  if (probeQueued || pointers.size) return
  probeQueued = true
  const [px, py] = localPoint(e)
  requestAnimationFrame(() => {
    probeQueued = false
    probe.value = screenToWorld(cur, size.value.w, size.value.h, px, py)
  })
}
function onSvgLeave() { probe.value = null }

const located = computed(() => {
  void rev.value
  const [x, y] = probe.value ?? [view.value.cx, view.value.cy]
  const out: { county: MapUnit | null; town: MapUnit | null; village: MapUnit | null } = { county: null, town: null, village: null }
  const cl = countyLayer.value
  if (cl) { const i = cellAt(cl.raster, x, y); if (i >= 0) out.county = cl.built.units[i] }
  for (const L of townLayers.value) {
    if (x < L.box.x0 || x >= L.box.x1 || y < L.box.y0 || y >= L.box.y1) continue
    const i = cellAt(L.raster, x, y)
    if (i >= 0) { out.town = L.built.units[i]; break }
  }
  for (const L of villageLayers.value.values()) {
    if (x < L.box.x0 || x >= L.box.x1 || y < L.box.y0 || y >= L.box.y1) continue
    const i = cellAt(L.raster, x, y)
    if (i >= 0) { out.village = L.built.units[i]; break }
  }
  if (out.town && !out.county) out.county = cl?.built.units.find((u) => u.code === out.town!.code.slice(0, 5)) ?? null
  return out
})
const crumbs = computed<MapCrumb[]>(() => {
  const out: MapCrumb[] = [{ label: '全國', code: null }]
  const l = located.value
  if (l.county) out.push({ label: l.county.name, code: l.county.code })
  if (l.town && lod.value !== 'county') out.push({ label: l.town.name, code: l.town.code })
  if (l.village && lod.value === 'village') out.push({ label: l.village.name, code: l.village.code })
  return out
})
const crumbPeople = computed<number | null>(() => {
  const l = located.value
  const u = (lod.value === 'village' ? l.village : null) ?? (lod.value !== 'county' ? l.town : null) ?? l.county
  if (u) return isReady(u) ? u.candidates : null
  return countyLayer.value?.ready ? countyLayer.value.built.units.reduce((s, x) => s + x.candidates, 0) : null
})

// ── 名稱標籤：只畫目前這一層、放得下且不互相蓋住的（lib/raster-grid.ts placeLabels）─────────
const fsStep = computed(() => {
  const u = lod.value === 'village' ? 0.2 : 1
  return Math.round(Math.log(LABEL_PX / (view.value.k * u)) / Math.log(1.25))
})
const labels = computed<LabelItem[]>(() => {
  const layers = lod.value === 'county' ? (countyLayer.value ? [countyLayer.value] : []) : lod.value === 'town' ? renderState.value.towns : renderState.value.villages
  const step = fsStep.value
  const out: LabelItem[] = []
  for (const L of layers) {
    const ck = `${L.key}|${step}`
    let list = labelCache.get(ck)
    if (!list) {
      if (labelCache.size > 2000) labelCache.clear()
      list = placeLabels(L.raster, L.built.units.map((u) => u.name), Math.pow(1.25, step)).map((p) => ({ code: L.built.units[p.idx].code, text: p.text, x: p.x, y: p.y, fs: p.fs }))
      labelCache.set(ck, list)
    }
    for (const p of list) out.push({ key: `${ck}:${p.code}`, transform: L.transform, text: p.text, x: p.x, y: p.y, fs: p.fs })
  }
  return out
})

const scaleLabel = computed(() => (lod.value === 'village' ? '200 公尺' : '1 公里'))
const legend = computed(() => legendFor(colorMode.value, maxByLevel.value[lod.value]))
const tickClass = (pos: number) => (pos < 0.02 ? '' : pos < 0.85 ? '-translate-x-1/2' : '-translate-x-full')

// ── 清單模式：目前那一層、游標（視窗中心）所在上一層底下的行政區 ─────────
const listUnits = computed<MapUnit[]>(() => {
  void rev.value
  const l = located.value
  let units: MapUnit[] = []
  if (lod.value === 'county' || !l.county) units = countyLayer.value?.built.units ?? []
  else if (lod.value === 'town' || !l.town) units = townLayers.value.flatMap((L) => L.built.units).filter((u) => u.code.startsWith(l.county!.code))
  else units = [...villageLayers.value.values()].flatMap((L) => L.built.units).filter((u) => u.code.startsWith(l.town!.code))
  return [...units].sort((a, b) => b.candidates - a.candidates || a.code.localeCompare(b.code))
})
function pickRow(u: MapUnit) {
  selected.value = null
  zoomToCode(u.code, true)
  if (u.code.length === 8) void ensureTowns()
}

// ── 網址帶視角（?at=縣市或鄉鎮代碼，方便分享）─────────────────────
const route = useRoute()
const router = useRouter()
let urlTimer: ReturnType<typeof setTimeout> | undefined
watch(view, () => {
  clearTimeout(urlTimer)
  urlTimer = setTimeout(() => {
    const l = located.value
    const at = lod.value === 'county'
      ? (view.value.k > kMin.value * 1.3 ? l.county?.code : undefined)
      : l.town?.code ?? l.county?.code
    if ((route.query.at ?? undefined) === at) return
    const query = { ...route.query }
    if (at) query.at = at
    else delete query.at
    void router.replace({ query })
  }, 700)
})
async function applyAtFromUrl() {
  const at = typeof route.query.at === 'string' ? route.query.at : ''
  if (!/^\d{5}(\d{3})?$/.test(at)) return
  if (at.length === 8) await ensureTowns()
  zoomToCode(at, true)
}

// ── 啟動與尺寸 ────────────────────────────────────────────────
function measure() {
  const el = stage.value
  if (!el) return
  const next = { w: Math.max(200, el.clientWidth), h: Math.max(200, el.clientHeight) }
  const atFit = world.value ? cur.k <= fitK(world.value, size.value.w, size.value.h) * 1.001 : true
  size.value = next
  applyViewBox()
  if (world.value && atFit) setView({ cx: world.value.w / 2, cy: world.value.h / 2, k: fitK(world.value, next.w, next.h) })
}
watch(stage, (el) => {
  observer?.disconnect()
  if (!el) return
  observer = new ResizeObserver(measure)
  observer.observe(el)
  measure()
})
watch(countyLayer, async (L) => {
  if (!L) return
  measure()
  setView({ cx: L.raster.w / 2, cy: L.raster.h / 2, k: kMin.value })
  commitView()
  await applyAtFromUrl()
}, { once: true })

onMounted(() => { void loadCounty(); loadStatsTime() })
onBeforeUnmount(() => {
  observer?.disconnect()
  cancelAnim()
  clearTimeout(urlTimer)
  clearTimeout(commitTimer)
  clearTimeout(hintTimer)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
})

usePageHead({
  title: '參選地圖',
  description: '各縣市、鄉鎮市區、村里的參選人收錄地圖。',
  noindex: true,
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero class-name="z-10">
      <template #title>參選地圖</template>
      <template #description>
        全台各縣市、鄉鎮、村里的 2026 參選人收錄情形，放大就能看到村里。
      </template>
      <template #icon><MapIcon :size="400" class="text-blue-500" /></template>
      <template #actions>
        <MechanismNav current="contributions" />
      </template>

      <BoardNav current="map" />
    </Hero>

    <!-- 地圖：滿版寬度、約佔滿剩下的視窗；面板都浮在地圖上 -->
    <section v-if="mode === 'grid'" ref="stage" class="relative z-0 w-full overflow-hidden bg-slate-100 border-y border-slate-200 select-none"
      :style="{ height: 'calc(100dvh - 4rem)', minHeight: '480px', marginTop: '-50px' }" data-testid="map-stage" :aria-busy="pending > 0">
      <p v-if="failed" class="absolute inset-0 flex items-center justify-center text-slate-500 font-bold" data-testid="map-error">
        暫時讀不到資料
        <button type="button" class="ml-2 text-blue-600 underline" @click="loadCounty()">重試</button>
      </p>
      <p v-else-if="!countyLayer" class="absolute inset-0 flex items-center justify-center text-slate-400 font-bold">讀取中</p>

      <svg v-else ref="svgEl" class="map-svg absolute inset-0 block w-full h-full cursor-grab active:cursor-grabbing"
        style="touch-action: pan-y" role="group" aria-label="參選地圖" data-testid="map-svg"
        @wheel="onWheel" @pointerdown="onPointerDown" @mousemove="onSvgMove" @mouseleave="onSvgLeave">
        <MapLayers :layers="drawLayers" :color-mode="colorMode" :maxes="maxByLevel" :labels="labels" :lod="lod" @hover="onHover" @pick="onPick" />
        <g v-if="activeLayer && activeOutline" :transform="activeLayer.transform" pointer-events="none">
          <path :d="activeOutline" fill="none" stroke="#0f172a" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" data-testid="map-outline" />
        </g>
      </svg>

      <!-- 一般滾輪捲頁面時的提示 -->
      <Transition name="map-fade">
        <p v-if="wheelHint" class="pointer-events-none absolute inset-x-0 top-1/2 z-20 mx-auto w-fit max-w-[90%] rounded-full bg-slate-900/80 px-4 py-2 text-sm font-bold text-white" data-testid="map-wheel-hint">按住 {{ zoomKey }} 再滾動可縮放地圖</p>
      </Transition>

      <template v-if="countyLayer">
        <!-- 浮動面板：跟上方分頁卡片同一個內容寬度（max-w-7xl＋同樣的左右 padding），垂直放在分頁卡片下方（地圖往上疊了 50px） -->
        <div class="pointer-events-none absolute inset-0 z-10"><div class="mx-auto h-full max-w-7xl px-4 sm:px-6 lg:px-8"><div class="relative h-full">
        <!-- 左上：層級路徑與人數 -->
        <div class="pointer-events-auto absolute left-0 top-[66px] max-w-full md:max-w-[50%] rounded-xl bg-white/90 backdrop-blur border border-slate-200 shadow px-3 py-2">
          <MapCrumbs :crumbs="crumbs" :people="crumbPeople" @pick="zoomToCode" />
        </div>
        <!-- 右上：著色與呈現切換 -->
        <div class="pointer-events-auto absolute right-0 top-[130px] max-w-full md:top-[66px]">
          <MapToggles v-model:color-mode="colorMode" v-model:mode="mode" />
        </div>
        <!-- 右下：縮放 -->
        <div :class="['pointer-events-auto absolute right-0 flex flex-col gap-1', active ? 'bottom-60 md:bottom-4' : 'bottom-4']" data-testid="map-zoom">
          <button type="button" aria-label="放大" class="p-2 rounded-lg border border-slate-200 bg-white/95 shadow text-slate-600 hover:text-blue-600"
            @click="zoomBy(1.8)"><Plus :size="16" /></button>
          <button type="button" aria-label="縮小" class="p-2 rounded-lg border border-slate-200 bg-white/95 shadow text-slate-600 hover:text-blue-600"
            @click="zoomBy(1 / 1.8)"><Minus :size="16" /></button>
          <button type="button" aria-label="看全台" class="p-2 rounded-lg border border-slate-200 bg-white/95 shadow text-slate-600 hover:text-blue-600"
            @click="fitAll"><Maximize2 :size="16" /></button>
        </div>
        <!-- 左下：圖例與格子尺度 -->
        <div :class="['pointer-events-auto absolute left-0 bottom-4 rounded-xl bg-white/90 backdrop-blur border border-slate-200 shadow px-3 py-2 text-xs font-bold text-slate-500 flex-col gap-1 max-w-[calc(100%-5rem)]', active ? 'hidden md:flex' : 'flex']" data-testid="map-legend">
          <div class="flex flex-wrap items-end gap-x-3 gap-y-1">
            <div class="relative w-44 sm:w-56 pb-4" data-testid="map-legend-bar">
              <div class="h-3 rounded" :style="{ background: legend.css }"></div>
              <span v-for="t in legend.ticks" :key="t.label" :class="['absolute top-3.5 text-[10px] leading-none', tickClass(t.pos)]" :style="{ left: (t.pos * 100) + '%' }">{{ t.label }}</span>
            </div>
            <span v-if="legend.noData" class="inline-flex items-center gap-1 pb-4">
              <span class="w-4 h-3 rounded-sm" :style="{ background: legend.noData.color }"></span>{{ legend.noData.label }}
            </span>
          </div>
          <span class="flex flex-wrap gap-x-3"><span data-testid="map-scale">每格 {{ scaleLabel }}</span><span v-if="statsAt" data-testid="map-stats-time">統計時間 {{ statsAt }}</span></span>
        </div>
        <p v-if="rowsFailed" class="pointer-events-auto absolute left-1/2 -translate-x-1/2 top-[190px] md:top-[122px] rounded-full bg-white/95 border border-slate-200 shadow px-3 py-1 text-xs font-bold text-slate-500" data-testid="map-rows-error">人數暫時讀不到<button type="button" class="ml-2 text-blue-600 underline" @click="retryRows">重試</button></p>
        <p v-if="pending > 0" class="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-4 rounded-full bg-white/90 border border-slate-200 shadow px-3 py-1 text-xs font-bold text-slate-500" data-testid="map-pending">讀取中</p>

        <!-- 提示卡：電腦浮在地圖右側，手機是底部抽屜 -->
        <aside v-if="active" class="pointer-events-auto absolute z-20 inset-x-0 bottom-0 rounded-t-2xl md:inset-x-auto md:bottom-auto md:top-[122px] md:right-0 md:w-72 md:rounded-2xl bg-white/95 backdrop-blur border border-slate-200 shadow-xl p-4 sm:p-5" data-testid="map-detail">
          <button v-if="selected" type="button" class="absolute right-2 top-2 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 md:hidden" aria-label="關閉" @click="selected = null; hover = null"><X :size="16" /></button>
          <h2 class="text-xl font-black text-navy-900 mb-3" data-testid="map-detail-name">{{ active.name }}</h2>
          <dl v-if="activeReady" class="space-y-1.5">
            <div v-for="l in tooltipLines(active)" :key="l.label" class="flex justify-between gap-3">
              <dt class="text-sm font-bold text-slate-500">{{ l.label }}</dt>
              <dd class="font-black text-navy-900">{{ l.value }}</dd>
            </div>
          </dl>
          <p v-else class="text-sm font-bold text-slate-400">人數讀取中</p>
          <div class="mt-4 flex flex-wrap gap-2">
            <button v-if="activeLayer && active" type="button" data-testid="map-zoom-to"
              class="px-3 py-2 rounded-xl text-sm font-black bg-blue-600 text-white hover:bg-blue-700" @click="zoomToCode(active.code)">放大到這裡</button>
            <RouterLink v-if="activeHref" :to="activeHref" data-testid="map-election-link"
              class="px-3 py-2 rounded-xl text-sm font-black border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600 inline-flex items-center gap-1.5">
              選舉頁<ExternalLink :size="14" />
            </RouterLink>
          </div>
        </aside>
        </div></div></div>
      </template>
    </section>

    <!-- 清單：一般寬度版面 -->
    <div v-else class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 pb-20 space-y-4">
      <div class="flex flex-wrap items-center gap-2 justify-between">
        <MapCrumbs :crumbs="crumbs" :people="crumbPeople" @pick="zoomToCode($event, true)" />
        <MapToggles v-model:color-mode="colorMode" v-model:mode="mode" />
      </div>
      <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-3 sm:p-5">
        <p v-if="!countyLayer" class="text-slate-400 font-bold py-10 text-center">讀取中</p>
        <ul v-else class="divide-y divide-slate-100" data-testid="map-list">
          <li v-for="u in listUnits" :key="u.code">
            <button type="button" class="w-full flex items-center gap-3 py-2.5 px-1 text-left hover:bg-slate-50 rounded-lg" :data-testid="`row-${u.code}`" @click="pickRow(u)">
              <span class="w-3 h-3 rounded-sm flex-shrink-0" :style="{ background: unitColor(u, colorMode, maxByLevel[u.code.length === 5 ? 'county' : u.code.length === 8 ? 'town' : 'village']) }"></span>
              <span class="flex-1 font-black text-navy-900">{{ u.name }}</span>
              <span v-if="isReady(u)" class="text-sm text-slate-500 font-bold">
                <template v-for="(l, i) in tooltipLines(u)" :key="l.label">{{ i ? '・' : '' }}{{ l.label }} {{ l.value }}</template>
              </span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 瀏覽器對可聚焦的 SVG 元素會畫一個矩形圓角的 focus 外框（點格子之後那個大圓角框）：整個拿掉，
   選中與鍵盤聚焦都改由「沿行政區形狀的描邊」表示（hover ?? selected 的外框 path，見 activeOutline） */
.map-svg,
.map-svg * {
  outline: none;
  -webkit-tap-highlight-color: transparent;
}
</style>

<style>
/* 縮放、平移進行中先藏起邊界線與標籤（畫面上最重的部分），停下來再顯示 */
.map-svg { transform-origin: 0 0; }
.map-svg.moving { will-change: transform; }
.map-svg.moving .map-hide-moving { display: none; }
</style>
