<script setup lang="ts">
// 流程圖畫布：節點、直角連線、沿線走的圓點、節點上的計數。
// 兩種播法：
//   window  全站時間窗——位置是「窗內第幾毫秒」，speed 倍＝1 秒真實走 speed 秒資料時間
//   events  指定對象——位置是「第幾件事」（小數＝這件事走到哪），一件一件照真實順序走
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  COUNT_LABEL, GROUP_COLOR, eventRoute, groupOf, indexAtOrBefore, nodeCounts,
  type NodeCounts, type NodeId, type TraceItem,
} from '../../lib/trace'
import { computeLayout, pathThrough, pointAlong, polylineLength, type Layout, type Pt } from '../../lib/trace-layout'

const props = defineProps<{
  items: TraceItem[]
  mode: 'window' | 'events'
  windowStart: number
  windowMs: number
  position: number
  playing: boolean
  /** window：資料秒／真實秒；events：每秒走幾件的倍率（1＝每 1.2 秒一件） */
  speed: number
  reduced: boolean
  label: string
}>()
const emit = defineEmits<{ 'update:position': [value: number]; end: [] }>()

const wrap = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

const DOT_LIFE = 1.4 // 秒（真實時間）
const EVENT_SEC = 1.2 // events 模式一件事走多久（speed 1）
const MAX_DOTS = 160

interface Dot { path: Pt[]; len: number; color: string; born: number; flash: NodeId | null; end: NodeId; arrived: boolean }

let layout: Layout = computeLayout(360)
let ctx: CanvasRenderingContext2D | null = null
let dpr = 1
let raf = 0
let lastTs = 0
let wall = 0
let localPos = props.position
let dots: Dot[] = []
let counts: NodeCounts = {}
let countKey = ''
const glow: Partial<Record<NodeId, number>> = {}
let hidden = typeof document !== 'undefined' && document.hidden
let fontFamily = 'system-ui, sans-serif'

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)

function makeDot(e: TraceItem): Dot {
  const route = eventRoute(e)
  const path = pathThrough(layout, route)
  return { path, len: polylineLength(path), color: GROUP_COLOR[groupOf(e.kind)], born: wall, flash: route.length === 1 ? route[0] : null, end: route[route.length - 1], arrived: false }
}

function setupCanvas(): void {
  const el = canvas.value
  const box = wrap.value
  if (!el || !box) return
  const w = Math.max(280, box.clientWidth)
  layout = computeLayout(w)
  dpr = Math.min(window.devicePixelRatio || 1, 3)
  el.width = Math.round(layout.width * dpr)
  el.height = Math.round(layout.height * dpr)
  el.style.width = `${layout.width}px`
  el.style.height = `${layout.height}px`
  ctx = el.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  fontFamily = getComputedStyle(el).fontFamily || fontFamily
  dots = []
  schedule()
}

// ---- 計數 ----

function currentIndex(): number {
  if (props.mode === 'window') return indexAtOrBefore(props.items, props.windowStart + localPos)
  const i = Math.min(Math.floor(localPos), props.items.length - 1)
  const frac = localPos - Math.floor(localPos)
  return props.reduced || frac >= 0.6 || localPos >= props.items.length ? i : i - 1
}

function refreshCounts(): void {
  const idx = currentIndex()
  const key = `${props.items.length}:${idx}`
  if (key === countKey) return
  countKey = key
  counts = nodeCounts(props.items, idx)
}

// ---- 前進 ----

function spawnBetween(prevAbs: number, nowAbs: number): void {
  const a = indexAtOrBefore(props.items, prevAbs)
  const b = indexAtOrBefore(props.items, nowAbs)
  for (let i = a + 1; i <= b; i++) dots.push(makeDot(props.items[i]))
  if (dots.length > MAX_DOTS) dots = dots.slice(dots.length - MAX_DOTS)
}

function step(dt: number): void {
  wall += dt
  for (const k of Object.keys(glow) as NodeId[]) glow[k] = Math.max(0, (glow[k] ?? 0) - dt * 1.6)
  if (props.playing) {
    if (props.mode === 'window') {
      const prev = localPos
      localPos = Math.min(props.windowMs, localPos + dt * props.speed * 1000)
      spawnBetween(props.windowStart + prev, props.windowStart + localPos)
      emit('update:position', localPos)
      if (localPos >= props.windowMs) emit('end')
    } else {
      localPos = Math.min(props.items.length, localPos + (dt * props.speed) / EVENT_SEC)
      emit('update:position', localPos)
      if (localPos >= props.items.length) emit('end')
    }
  }
  for (const d of dots) {
    if (!d.arrived && wall - d.born >= DOT_LIFE * 0.85) {
      d.arrived = true
      glow[d.end] = 1
    }
  }
  dots = dots.filter((d) => wall - d.born < DOT_LIFE)
  if (props.mode === 'events' && props.items.length > 0) {
    const i = Math.min(Math.floor(localPos), props.items.length - 1)
    const frac = localPos >= props.items.length ? 1 : localPos - Math.floor(localPos)
    if (frac > 0.85) glow[eventRoute(props.items[i]).at(-1) as NodeId] = 1
  }
}

function animating(): boolean {
  return props.playing || dots.length > 0 || Object.values(glow).some((v) => (v ?? 0) > 0)
}

function frame(ts: number): void {
  raf = 0
  const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0
  lastTs = ts
  step(dt)
  draw()
  if (animating() && !hidden && !props.reduced) raf = requestAnimationFrame(frame)
  else lastTs = 0
}

function schedule(): void {
  if (raf || hidden) return
  raf = requestAnimationFrame(frame)
}

// ---- 畫 ----

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}

function arrow(c: CanvasRenderingContext2D, a: Pt, b: Pt, color: string): void {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
  c.save()
  c.translate(b[0], b[1])
  c.rotate(ang)
  c.fillStyle = color
  c.beginPath()
  c.moveTo(0, 0)
  c.lineTo(-7, -3.5)
  c.lineTo(-7, 3.5)
  c.closePath()
  c.fill()
  c.restore()
}

function activeEdgeKeys(): Set<string> {
  const out = new Set<string>()
  if (props.mode !== 'events' || props.items.length === 0) return out
  const e = props.items[Math.min(Math.floor(localPos), props.items.length - 1)]
  const r = eventRoute(e)
  for (let i = 0; i < r.length - 1; i++) out.add(`${r[i]}>${r[i + 1]}`).add(`${r[i + 1]}>${r[i]}`)
  return out
}

function draw(): void {
  const c = ctx
  if (!c) return
  refreshCounts()
  c.clearRect(0, 0, layout.width, layout.height)
  const hot = activeEdgeKeys()
  // 連線
  for (const r of layout.routes) {
    const on = hot.has(`${r.from}>${r.to}`)
    const col = on ? '#334155' : r.dashed ? '#d97706' : '#cbd5e1'
    c.strokeStyle = col
    c.lineWidth = on ? 2.4 : r.dashed ? 1.8 : 1.4
    c.setLineDash(r.dashed ? [6, 4] : [])
    c.beginPath()
    r.pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])))
    c.stroke()
    c.setLineDash([])
    arrow(c, r.pts[r.pts.length - 2], r.pts[r.pts.length - 1], col)
    if (r.label && r.labelAt && layout.width >= (r.labelMinWidth ?? 0)) {
      c.font = `11px ${fontFamily}`
      c.fillStyle = r.dashed ? '#b45309' : '#64748b'
      c.textAlign = r.labelAlign ?? 'left'
      c.textBaseline = 'middle'
      c.fillText(r.label, r.labelAt[0], r.labelAt[1])
    }
  }
  // 節點
  for (const n of Object.values(layout.nodes)) {
    const g = glow[n.id] ?? 0
    roundRect(c, n.cx - n.w / 2, n.cy - n.h / 2, n.w, n.h, 8)
    c.fillStyle = g > 0 ? `rgba(251,191,36,${0.15 + g * 0.35})` : '#ffffff'
    c.fill()
    c.strokeStyle = g > 0 ? '#f59e0b' : '#94a3b8'
    c.lineWidth = n.big ? 2 : 1.4
    c.stroke()
    const cl = COUNT_LABEL[n.id]
    const num = counts[n.id]
    const second = cl ? `${cl} ${(num ?? 0).toLocaleString('zh-TW')}` : (n.sub ?? '')
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillStyle = '#0f172a'
    c.font = `bold ${n.big ? 13 : 12}px ${fontFamily}`
    c.fillText(n.label, n.cx, second ? n.cy - 8 : n.cy)
    if (second) {
      c.font = `11px ${fontFamily}`
      c.fillStyle = cl && num ? '#0369a1' : '#64748b'
      c.fillText(second, n.cx, n.cy + 9)
    }
  }
  drawDots(c)
}

function drawDot(c: CanvasRenderingContext2D, d: Dot, t: number, alpha: number): void {
  if (d.flash) {
    const n = layout.nodes[d.flash]
    c.strokeStyle = d.color
    c.globalAlpha = alpha * (1 - t)
    c.lineWidth = 2
    c.beginPath()
    c.arc(n.cx, n.cy, 8 + t * 16, 0, Math.PI * 2)
    c.stroke()
    c.globalAlpha = 1
    return
  }
  const [x, y] = pointAlong(d.path, ease(t))
  c.globalAlpha = alpha
  c.fillStyle = d.color
  c.beginPath()
  c.arc(x, y, 5, 0, Math.PI * 2)
  c.fill()
  c.strokeStyle = '#ffffff'
  c.lineWidth = 1.5
  c.stroke()
  c.globalAlpha = 1
}

function drawDots(c: CanvasRenderingContext2D): void {
  if (props.reduced) {
    // 減少動態：不動，只把目前這件（或最近一分鐘內的）事件的圓點畫在終點
    const idxs: number[] = []
    if (props.mode === 'events') {
      if (props.items.length > 0) idxs.push(Math.min(Math.floor(localPos), props.items.length - 1))
    } else {
      const b = indexAtOrBefore(props.items, props.windowStart + localPos)
      for (let i = b; i >= 0 && idxs.length < 40 && props.windowStart + localPos - props.items[i].ms <= 60_000; i--) idxs.push(i)
    }
    for (const i of idxs) drawDot(c, makeDot(props.items[i]), 1, 1)
    return
  }
  if (props.mode === 'events') {
    if (props.items.length === 0) return
    const i = Math.min(Math.floor(localPos), props.items.length - 1)
    const frac = localPos >= props.items.length ? 1 : localPos - Math.floor(localPos)
    drawDot(c, makeDot(props.items[i]), Math.min(1, frac / 0.85), 1)
    return
  }
  for (const d of dots) {
    const age = (wall - d.born) / DOT_LIFE
    drawDot(c, d, Math.min(1, age / 0.85), age > 0.85 ? Math.max(0, 1 - (age - 0.85) / 0.15) : 1)
  }
}

// ---- 生命週期 ----

let ro: ResizeObserver | null = null
const onVisibility = (): void => {
  hidden = document.hidden
  if (hidden) {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    lastTs = 0
  } else schedule()
}

onMounted(() => {
  setupCanvas()
  if (wrap.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => setupCanvas())
    ro.observe(wrap.value)
  }
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  ro?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
})

// 外面改位置（拖時間軸、點事件）＝跳過去：清掉圓點、重算計數；自己每幀回報的位置與本地相同，不算跳
watch(() => props.position, (p) => {
  if (Math.abs(p - localPos) > (props.mode === 'window' ? 1 : 0.0001)) {
    localPos = p
    dots = []
    countKey = ''
    for (const k of Object.keys(glow) as NodeId[]) glow[k] = 0
    schedule()
  }
})
watch(() => props.playing, () => schedule())
watch(() => [props.items, props.mode, props.reduced], () => {
  localPos = props.position
  dots = []
  countKey = ''
  schedule()
})
</script>

<template>
  <div ref="wrap" class="w-full">
    <canvas ref="canvas" role="img" :aria-label="label" class="block mx-auto max-w-full" style="touch-action: manipulation" />
  </div>
</template>
