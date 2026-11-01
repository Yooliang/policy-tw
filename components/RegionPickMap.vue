<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { boundaryPath, decodeRaster, placeLabels, unitFillPaths, type RasterFile } from '../lib/raster-grid'
import { fileCache } from '../lib/map-data-cache'

/**
 * 選擇地區的地圖（選舉頁內容區，取代「選擇縣市／選擇鄉鎮市區」那一大塊按鈕格）。
 * 形狀用參選地圖同一套點陣檔（data/tw-raster：全國縣市、各縣市鄉鎮），每區一條填色 path；點哪區＝點同名晶片（emit pick）。
 * 沒有人的區淡灰、有人的區正常色（跟晶片列灰／亮一致）；滑過顯示區名與人數。
 */
export interface PickMapItem { name: string; dim: boolean; /** 該分頁在這區的人數；null＝沒有資料不顯示 */ count: number | null }
const props = defineProps<{
  level: 'county' | 'sub'
  /** level=sub 時：縣市官方碼（取該縣市的鄉鎮點陣） */
  countyCode: string | null
  /** 網站用的區名（臺／台寫法）與灰亮、人數；點陣上的區用正規化名稱對回來 */
  items: PickMapItem[]
}>()
const emit = defineEmits<{ pick: [name: string] }>()

const normName = (n: string) => n.replace(/臺/g, '台')
const townFiles = import.meta.glob<{ default: unknown }>('../data/tw-raster/towns/*.json')

const raster = shallowRef<ReturnType<typeof decodeRaster> | null>(null)
const fills = shallowRef<string[]>([])
const boundary = ref('')
const failed = ref(false)
let seq = 0
async function load() {
  const my = ++seq
  raster.value = null
  failed.value = false
  try {
    let file: unknown
    if (props.level === 'county') file = await fileCache.get('national', () => import('../data/tw-raster/national.json').then((m) => m.default))
    else {
      const code = props.countyCode
      const loader = code ? townFiles[`../data/tw-raster/towns/${code}.json`] : undefined
      if (!loader) throw new Error('no town raster')
      file = await fileCache.get(`towns/${code}`, () => loader().then((m) => m.default))
    }
    if (my !== seq) return
    const r = decodeRaster(file as RasterFile)
    fills.value = unitFillPaths(r)
    boundary.value = boundaryPath(r)
    raster.value = r
  } catch {
    if (my === seq) failed.value = true
  }
}
watch(() => [props.level, props.countyCode], load, { immediate: true })

const itemOf = computed(() => new Map(props.items.map((i) => [normName(i.name), i])))
/** 點陣上第 idx 區對應的選項（對不到＝不是這一屆可選的區，淡灰且不能點） */
const units = computed(() => (raster.value?.names ?? []).map((n, idx) => ({ idx, item: itemOf.value.get(normName(n)) ?? null, text: n })))

// 尺寸：依容器寬與高度上限換成每格幾像素，標籤字級以 12px 為準
const box = ref<HTMLElement | null>(null)
const boxW = ref(640)
let ro: ResizeObserver | null = null
onMounted(() => {
  if (!box.value) return
  boxW.value = box.value.clientWidth || 640
  ro = new ResizeObserver(() => { boxW.value = box.value?.clientWidth || boxW.value })
  ro.observe(box.value)
})
onBeforeUnmount(() => ro?.disconnect())
const MAX_H = 560
const pxPerCell = computed(() => (raster.value ? Math.min(boxW.value / raster.value.w, MAX_H / raster.value.h) : 1))
const labels = computed(() => (raster.value ? placeLabels(raster.value, raster.value.names, 12 / pxPerCell.value) : []))

const hover = ref<number | null>(null)
const tip = computed(() => {
  const u = hover.value === null ? null : units.value[hover.value]
  if (!u) return null
  const c = u.item?.count
  return { name: u.item?.name ?? u.text, count: c === null || c === undefined ? '' : c > 0 ? `${c} 人` : '沒有參選人' }
})
const fillOf = (u: { item: PickMapItem | null }, idx: number) =>
  !u.item || u.item.dim ? (hover.value === idx ? '#cbd5e1' : '#e2e8f0') : hover.value === idx ? '#2563eb' : '#93c5fd'
function onPick(u: { item: PickMapItem | null }) { if (u.item) emit('pick', u.item.name) }
</script>

<template>
  <div ref="box" class="relative mx-auto w-full" data-testid="region-pick-map">
    <p v-if="failed" class="py-10 text-center text-sm text-slate-500">地圖讀取失敗，請從上方列表選擇。</p>
    <p v-else-if="!raster" class="py-10 text-center text-sm text-slate-400">地圖讀取中</p>
    <template v-else>
      <svg :viewBox="`0 0 ${raster.w} ${raster.h}`" :width="raster.w * pxPerCell" :height="raster.h * pxPerCell" class="mx-auto block max-w-full" role="group" aria-label="地區地圖">
        <g shape-rendering="crispEdges">
          <path
            v-for="u in units" :key="u.idx" :d="fills[u.idx]" :fill="fillOf(u, u.idx)"
            :class="u.item ? 'cursor-pointer' : ''" :role="u.item ? 'button' : undefined" :tabindex="u.item ? 0 : undefined"
            :aria-label="u.item ? u.item.name : undefined"
            :data-testid="`pick-map-${u.item?.name ?? u.text}`" :data-dim="u.item?.dim ? '1' : '0'"
            @mouseenter="hover = u.idx" @mouseleave="hover = null" @focus="hover = u.idx" @blur="hover = null"
            @click="onPick(u)" @keydown.enter.prevent="onPick(u)"
          />
        </g>
        <path :d="boundary" fill="none" stroke="#ffffff" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none" />
        <g pointer-events="none" text-anchor="middle" font-weight="700">
          <text
            v-for="l in labels" :key="l.idx" :x="l.x" :y="l.y + l.fs * 0.35" :font-size="l.fs"
            :fill="units[l.idx]?.item?.dim || !units[l.idx]?.item ? '#94a3b8' : '#0f172a'"
            stroke="#ffffff" :stroke-width="l.fs * 0.2" paint-order="stroke" stroke-linejoin="round" data-testid="pick-map-label"
          >{{ l.text }}</text>
        </g>
      </svg>
      <div v-if="tip" class="pointer-events-none absolute right-2 top-2 rounded-lg border border-slate-200 bg-white/95 px-3 py-1.5 text-sm shadow" data-testid="pick-map-tip">
        <span class="font-bold text-navy-900">{{ tip.name }}</span><span v-if="tip.count" class="ml-2 text-slate-500">{{ tip.count }}</span>
      </div>
    </template>
  </div>
</template>
