// /trace 流程圖的版面：節點位置與直角連線。純計算，不碰 DOM；寬度不同版面等比縮放，手機寬度（320）也排得下。
import type { NodeId } from './trace'

export interface NodeBox {
  id: NodeId
  label: string
  sub?: string
  cx: number
  cy: number
  w: number
  h: number
  big?: boolean
}

export type Pt = [number, number]

export interface Route {
  from: NodeId
  to: NodeId
  pts: Pt[]
  /** 虛線（回流線） */
  dashed?: boolean
  /** 線上的小標 */
  label?: string
  labelAt?: Pt
  labelAlign?: 'left' | 'right' | 'center'
  /** 畫布寬度不到這個值就不畫小標（窄畫面放不下） */
  labelMinWidth?: number
}

export interface Layout {
  width: number
  height: number
  nodes: Record<NodeId, NodeBox>
  routes: Route[]
}

interface Spec {
  id: NodeId
  label: string
  sub?: string
  x: number
  y: number
  big?: boolean
}

const SPECS: Spec[] = [
  { id: 'a1', label: '官方資料', x: 0.2, y: 0.05 },
  { id: 'a2', label: '訪客請求', x: 0.5, y: 0.05 },
  { id: 'a3', label: '代理提議', x: 0.83, y: 0.05 },
  { id: 'b', label: '44 支臂', x: 0.2, y: 0.2 },
  { id: 'c', label: '一條佇列', x: 0.5, y: 0.37, big: true },
  { id: 'd', label: '派工', x: 0.5, y: 0.52 },
  { id: 'e', label: '代理交件', x: 0.76, y: 0.66 },
  { id: 'v', label: '別的代理投票', x: 0.24, y: 0.66 },
  { id: 'l', label: '落庫上線', x: 0.24, y: 0.8 },
  { id: 'r', label: '退件', x: 0.54, y: 0.8 },
  { id: 'n', label: '查無', x: 0.83, y: 0.8 },
  { id: 'k', label: '冷卻', sub: '5／10／20 天', x: 0.83, y: 0.94 },
]

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

/** 依畫布寬度算出版面；高度跟著寬度走（窄畫面較高） */
export function computeLayout(width: number): Layout {
  const W = Math.max(280, Math.round(width))
  const H = Math.round(clamp(W * 1.4, 520, 700))
  const nw = Math.min(112, W * 0.26)
  const nodes = {} as Record<NodeId, NodeBox>
  for (const s of SPECS) {
    nodes[s.id] = {
      id: s.id,
      label: s.label,
      sub: s.sub,
      cx: Math.round(s.x * W),
      cy: Math.round(24 + s.y * (H - 48)),
      w: s.big ? Math.min(nw * 1.3, W * 0.36) : nw,
      h: s.big ? 50 : 40,
      big: s.big,
    }
  }
  const { a2, a3, b, c, d, e, v, l, r, n, k } = nodes
  const top = (x: NodeBox): number => x.cy - x.h / 2
  const bot = (x: NodeBox): number => x.cy + x.h / 2
  const left = (x: NodeBox): number => x.cx - x.w / 2
  const right = (x: NodeBox): number => x.cx + x.w / 2
  const midDV = Math.round((bot(d) + top(v)) / 2)
  const midEN = Math.round((bot(e) + top(n)) / 2)
  const midVL = Math.round((bot(v) + top(r)) / 2)
  const upA3 = Math.round(top(c) - 16)
  const propX = Math.min(Math.max(right(e) + 10, a3.cx + 14), W - 6)
  const routes: Route[] = [
    { from: 'a1', to: 'b', pts: [[nodes.a1.cx, bot(nodes.a1)], [b.cx, top(b)]] },
    { from: 'b', to: 'c', pts: [[right(b), b.cy], [c.cx - 30, b.cy], [c.cx - 30, top(c)]] },
    { from: 'a2', to: 'c', pts: [[a2.cx, bot(a2)], [c.cx, top(c)]] },
    { from: 'a3', to: 'c', pts: [[a3.cx - 14, bot(a3)], [a3.cx - 14, upA3], [c.cx + 30, upA3], [c.cx + 30, top(c)]] },
    { from: 'c', to: 'd', pts: [[c.cx, bot(c)], [d.cx, top(d)]] },
    { from: 'd', to: 'e', pts: [[d.cx + 22, bot(d)], [d.cx + 22, midDV], [e.cx - 24, midDV], [e.cx - 24, top(e)]] },
    { from: 'd', to: 'v', pts: [[d.cx - 22, bot(d)], [d.cx - 22, midDV], [v.cx, midDV], [v.cx, top(v)]] },
    { from: 'e', to: 'c', dashed: true, label: '交一件，回隊一張票', labelAt: [e.cx + 6, Math.round((top(e) + c.cy) / 2)], labelAlign: 'left', labelMinWidth: 560,
      pts: [[e.cx, top(e)], [e.cx, c.cy], [right(c), c.cy]] },
    { from: 'e', to: 'a3', dashed: true, label: '順手提議', labelAt: [propX - 6, Math.round((e.cy + a3.cy) / 2)], labelAlign: 'right', labelMinWidth: 560,
      pts: [[right(e), e.cy - 8], [propX, e.cy - 8], [propX, bot(a3)]] },
    { from: 'e', to: 'n', pts: [[e.cx + 10, bot(e)], [e.cx + 10, midEN], [n.cx, midEN], [n.cx, top(n)]] },
    { from: 'n', to: 'k', pts: [[n.cx, bot(n)], [k.cx, top(k)]] },
    { from: 'k', to: 'c', dashed: true, label: '冷卻完再派', labelAt: [Math.round((10 + left(k)) / 2), k.cy - 9], labelAlign: 'center',
      pts: [[left(k), k.cy], [10, k.cy], [10, c.cy], [left(c), c.cy]] },
    { from: 'v', to: 'l', label: '上線', labelAt: [v.cx - 6, Math.round((bot(v) + top(l)) / 2)], labelAlign: 'right', pts: [[v.cx, bot(v)], [l.cx, top(l)]] },
    { from: 'v', to: 'r', label: '反對累積就退件', labelAt: [Math.round((v.cx + 22 + r.cx) / 2), midVL - 6], labelAlign: 'center', labelMinWidth: 400,
      pts: [[v.cx + 22, bot(v)], [v.cx + 22, midVL], [r.cx, midVL], [r.cx, top(r)]] },
  ]
  return { width: W, height: H, nodes, routes }
}

const reverse = (r: Route): Pt[] => [...r.pts].reverse()

/** from 到 to 的折線；沒有直接定義的方向用反向，再沒有就走 L 形直角線 */
export function routeBetween(layout: Layout, from: NodeId, to: NodeId): Pt[] {
  const direct = layout.routes.find((r) => r.from === from && r.to === to)
  if (direct) return direct.pts
  const back = layout.routes.find((r) => r.from === to && r.to === from)
  if (back) return reverse(back)
  const a = layout.nodes[from]
  const b = layout.nodes[to]
  return [[a.cx, a.cy], [b.cx, a.cy], [b.cx, b.cy]]
}

/** 一串節點串成一條連續折線（相鄰線段接點相同就合併） */
export function pathThrough(layout: Layout, nodes: readonly NodeId[]): Pt[] {
  if (nodes.length === 0) return []
  if (nodes.length === 1) {
    const n = layout.nodes[nodes[0]]
    return [[n.cx, n.cy]]
  }
  const out: Pt[] = []
  for (let i = 0; i < nodes.length - 1; i++) {
    const seg = routeBetween(layout, nodes[i], nodes[i + 1])
    seg.forEach((p, j) => {
      const last = out[out.length - 1]
      if (j === 0 && last && last[0] === p[0] && last[1] === p[1]) return
      out.push(p)
    })
  }
  return out
}

export function polylineLength(pts: readonly Pt[]): number {
  let len = 0
  for (let i = 0; i < pts.length - 1; i++) len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
  return len
}

/** 沿折線走 t（0～1）的位置 */
export function pointAlong(pts: readonly Pt[], t: number): Pt {
  if (pts.length === 0) return [0, 0]
  if (pts.length === 1) return pts[0]
  let d = clamp(t, 0, 1) * polylineLength(pts)
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
    if (d <= seg || i === pts.length - 2) {
      const f = seg === 0 ? 0 : d / seg
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]
    }
    d -= seg
  }
  return pts[pts.length - 1]
}
