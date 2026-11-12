<script setup lang="ts">
// 流程圖畫布：節點、直角連線、沿線走的圓點、節點上的計數。
// 兩種播法：
//   window  全站時間窗——位置是「窗內第幾毫秒」，speed 倍＝1 秒真實走 speed 秒資料時間
//   events  指定對象——位置是「第幾件事」（小數＝這件事走到哪），一件一件照真實順序走
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  COUNT_LABEL, GROUP_COLOR, NODE_HINT, eventRoute, groupOf, indexAtOrBefore, nodeCounts, sortBreakdown, strongBreakdown, workCardCount,
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
// 流程圖是固定 1640×504、不縮放；容器放不下（含手機）就左右捲動

interface Dot { path: Pt[]; len: number; color: string; born: number; flash: NodeId | null; end: NodeId; arrived: boolean }

const layout: Layout = computeLayout()
let ctx: CanvasRenderingContext2D | null = null
let dpr = 1
let raf = 0
let lastTs = 0
let wall = 0
let localPos = props.position
let dots: Dot[] = []
let counts: NodeCounts = {}
let strong = { claim: 0, finalized: 0, rejected: 0 }
let cards = 0
let sorted = { intake: 0, suggestions: 0 }
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
  if (!el) return
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
  strong = strongBreakdown(props.items, idx)
  cards = workCardCount(props.items, idx)
  sorted = sortBreakdown(props.items, idx)
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

function arrow(c: CanvasRenderingContext2D, a: Pt, b: Pt, color: string, k = 1): void {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
  c.save()
  c.translate(b[0], b[1])
  c.rotate(ang)
  c.fillStyle = color
  c.beginPath()
  c.moveTo(0, 0)
  c.lineTo(-7 * k, -3.5 * k)
  c.lineTo(-7 * k, 3.5 * k)
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

const LINE_COLOR = '#475569' // 深灰：所有線同色，只有「順手提議」是虛線

/** 文字塞得進寬度才用；太寬就一路縮小字，最小 7px */
function fitFont(c: CanvasRenderingContext2D, text: string, base: number, maxW: number, bold: boolean): void {
  let size = base
  for (;;) {
    c.font = `${bold ? 'bold ' : ''}${size}px ${fontFamily}`
    if (size <= 8 || c.measureText(text).width <= maxW) return
    size -= 0.5
  }
}

/** 四種框：系統＝實線方框、代理＝圓角框、SystemOne＝雙線框、終點＝粗框填底；亮起時換底色 */
function drawBox(c: CanvasRenderingContext2D, n: { kind: string; cx: number; cy: number; w: number; h: number }, glowAmt: number, s: number): void {
  const x = n.cx - n.w / 2
  const y = n.cy - n.h / 2
  const lit = glowAmt > 0
  const fill = lit ? `rgba(251,191,36,${0.15 + glowAmt * 0.35})` : n.kind === 'end' ? '#e2e8f0' : '#ffffff'
  const stroke = lit ? '#f59e0b' : '#334155'
  const radius = n.kind === 'agent' ? Math.min(n.h / 2, 12 * s) : 0
  const path = (inset: number): void => {
    if (radius > 0) roundRect(c, x + inset, y + inset, n.w - inset * 2, n.h - inset * 2, Math.max(1, radius - inset))
    else {
      c.beginPath()
      c.rect(x + inset, y + inset, n.w - inset * 2, n.h - inset * 2)
    }
  }
  path(0)
  c.fillStyle = fill
  c.fill()
  c.strokeStyle = stroke
  c.lineWidth = Math.max(1, (n.kind === 'end' ? 3.2 : 1.4) * s)
  c.stroke()
  if (n.kind === 'systemone') {
    path(Math.max(3, 4 * s))
    c.lineWidth = Math.max(1, 1.2 * s)
    c.stroke()
  }
}

function draw(): void {
  const c = ctx
  if (!c) return
  refreshCounts()
  const s = 1
  c.clearRect(0, 0, layout.width, layout.height)
  const hot = activeEdgeKeys()
  // 連線：不放文字
  for (const r of layout.routes) {
    const on = hot.has(`${r.from}>${r.to}`)
    c.strokeStyle = on ? '#0f172a' : LINE_COLOR
    c.lineWidth = Math.max(1, (on ? 2.6 : 1.5) * 1)
    c.setLineDash(r.style === 'dashed' ? [6 * 1, 4 * 1] : [])
    c.beginPath()
    r.pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])))
    c.stroke()
    c.setLineDash([])
    arrow(c, r.pts[r.pts.length - 2], r.pts[r.pts.length - 1], on ? '#0f172a' : LINE_COLOR, 1)
  }
  // 節點
  for (const n of Object.values(layout.nodes)) {
    drawBox(c, n, glow[n.id] ?? 0, s)
    const cl = COUNT_LABEL[n.id]
    const num = counts[n.id]
    const fmt = (v: number): string => v.toLocaleString('zh-TW')
    const second = n.id === 'card' ? `人×事 ${fmt(cards)} 張` : n.id === 'jevSort' ? `收件 ${fmt(sorted.intake)}${sorted.suggestions > 0 ? `／提議 ${fmt(sorted.suggestions)}` : ''}` : n.id === 'strongLane' ? `認領 ${strong.claim}／定案 ${strong.finalized}` : n.id === 'dispute' ? `轉裁決 ${(num ?? 0).toLocaleString('zh-TW')}` : cl ? `${cl} ${(num ?? 0).toLocaleString('zh-TW')}` : (n.sub ?? '')
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillStyle = '#0f172a'
    fitFont(c, n.label, 13 * s, n.w - 8 * s, true)
    c.fillText(n.label, n.cx, second ? n.cy - 7 * s : n.cy)
    if (second) {
      fitFont(c, second, 10 * s, n.w - 8 * s, false)
      c.fillStyle = num ? '#0369a1' : '#64748b'
      c.fillText(second, n.cx, n.cy + 9 * s)
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
    c.arc(n.cx, n.cy, (8 + t * 16) * 1, 0, Math.PI * 2)
    c.stroke()
    c.globalAlpha = 1
    return
  }
  const [x, y] = pointAlong(d.path, ease(t))
  c.globalAlpha = alpha
  c.fillStyle = d.color
  c.beginPath()
  c.arc(x, y, 5 * 1, 0, Math.PI * 2)
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

// 滑鼠停在有說明的節點上時，用瀏覽器原生提示顯示（title）
function onMove(e: MouseEvent): void {
  const el = canvas.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const x = e.clientX - r.left
  const y = e.clientY - r.top
  const hit = Object.values(layout.nodes).find((n) => Math.abs(x - n.cx) <= n.w / 2 && Math.abs(y - n.cy) <= n.h / 2)
  const hint = hit ? NODE_HINT[hit.id] ?? '' : ''
  if (el.title !== hint) el.title = hint
}
const hintList = Object.entries(NODE_HINT).map(([id, text]) => ({ id, name: layout.nodes[id as NodeId].label, text }))

// ---- 生命週期 ----

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
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
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
  <!-- 畫布的顏色是照淺色底畫的（深色線、白底方框），深色模式下底色也固定白，不然線會看不清 -->
  <div ref="wrap" class="w-full overflow-x-auto rounded" style="background-color: #ffffff">
    <canvas ref="canvas" role="img" :aria-label="label" class="block" style="touch-action: pan-x pan-y" @mousemove="onMove" />
    <ul class="sr-only" aria-label="節點說明"><li v-for="h in hintList" :key="h.id">{{ h.name }}：{{ h.text }}</li></ul>
  </div>
</template>
