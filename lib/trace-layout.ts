// /trace 流程圖的版面（維護者 2026-11-12 定稿，說明頁第 4 版「左到右」）：17 個節點、23 條全直角的線。
// 畫布固定 1640×504，不縮放（容器放不下就水平捲動）；節點一律 126×36。純計算，不碰 DOM。
// 連接點：左右兩側各 5 個（index 0 上 … 4 下），上下兩側各 3 個（index 0 左、1 中、2 右）。
import type { NodeId } from './trace'

export const CANVAS_W = 1640
export const CANVAS_H = 504
export const NODE_W = 126
export const NODE_H = 36
const PAD_Y = 24
const STUB = 12 // 線離開／進入節點時先直走的長度

export type Side = 't' | 'b' | 'l' | 'r'
export type Pt = [number, number]

/** 框型：系統節點＝實線方框、代理節點＝圓角框、SystemOne＝雙線框、終點＝粗框填底 */
export type NodeKind = 'system' | 'agent' | 'systemone' | 'end'

export interface NodeDef {
  id: NodeId
  label: string
  sub?: string
  kind: NodeKind
  /** 0～1 正規化座標：cx = x*W、cy = 24 + y*(H-48) */
  x: number
  y: number
}

/** 17 個節點（x、y 取自說明頁 NODES；id 已換成 /trace 事件的 node key） */
export const NODE_DEFS: readonly NodeDef[] = [
  { id: 'official', label: '官方資料', sub: '中選會', kind: 'system', x: 0.05, y: 0.0974 },
  { id: 'detector', label: '資料缺口偵測', sub: '44 支臂，每 10 分鐘掃', kind: 'system', x: 0.15, y: 0.0974 },
  { id: 'card', label: '工作卡', sub: '人×事', kind: 'system', x: 0.25, y: 0.0974 },
  { id: 'queue', label: '派工佇列', sub: '1.7 萬／2.6 千／1.2 千', kind: 'system', x: 0.35, y: 0.0974 },
  { id: 'dispatcher', label: '派工分配器', kind: 'system', x: 0.45, y: 0.0974 },
  { id: 'vote', label: '別的代理投票', kind: 'agent', x: 0.55, y: 0.0974 },
  { id: 'applied', label: '落庫上線', kind: 'end', x: 0.75, y: 0.0974 },
  { id: 'visitor', label: '訪客請求', kind: 'agent', x: 0.05, y: 0.3658 },
  { id: 'suggest', label: '代理提議', kind: 'agent', x: 0.05, y: 0.6342 },
  { id: 'jevSort', label: 'SystemOne 整理', kind: 'systemone', x: 0.35, y: 0.6342 },
  { id: 'jevVote', label: 'SystemOne 系統票', kind: 'systemone', x: 0.55, y: 0.6342 },
  { id: 'submit', label: '代理交件', kind: 'agent', x: 0.45, y: 0.6342 },
  { id: 'notfound', label: '查無', sub: '佔交件 31%', kind: 'system', x: 0.45, y: 0.9026 },
  { id: 'cooldown', label: '冷卻', sub: '5／10／20 天', kind: 'system', x: 0.25, y: 0.9026 },
  { id: 'dispute', label: '爭議', kind: 'system', x: 0.65, y: 0.3658 },
  { id: 'strongLane', label: '強模型通道', kind: 'system', x: 0.65, y: 0.6342 },
  { id: 'rejected', label: '退件／結案', kind: 'end', x: 0.65, y: 0.9026 },
]

/** 線型：只有「順手提議」是虛線，其餘一律深灰實線；線上不放文字 */
export type LinkStyle = 'solid' | 'dashed'

export interface LinkDef {
  id: string
  from: NodeId
  fromSide: Side
  fromIdx: number
  to: NodeId
  toSide: Side
  toIdx: number
  style: LinkStyle
}

const L = (id: string, from: NodeId, fs: Side, fi: number, to: NodeId, ts: Side, ti: number, style: LinkStyle = 'solid'): LinkDef =>
  ({ id, from, fromSide: fs, fromIdx: fi, to, toSide: ts, toIdx: ti, style })

/** 23 條線：from → to，side／index 是連接點（說明頁 DEFP） */
export const LINKS: readonly LinkDef[] = [
  L('a1b', 'official', 'r', 2, 'detector', 'l', 2),
  L('bw', 'detector', 'r', 2, 'card', 'l', 2),
  L('wc', 'card', 'r', 2, 'queue', 'l', 2),
  L('cd', 'queue', 'r', 2, 'dispatcher', 'l', 2),
  L('dv', 'dispatcher', 'r', 2, 'vote', 'l', 2),
  L('vl', 'vote', 'r', 2, 'applied', 'l', 2),
  L('a2w', 'visitor', 'r', 2, 'card', 'b', 0),
  L('a3w', 'suggest', 'r', 2, 'card', 'b', 1),
  L('ja', 'jevSort', 'b', 0, 'suggest', 'b', 1, 'dashed'),
  L('ep3', 'submit', 'b', 2, 'jevVote', 'b', 1),
  L('ep2', 'submit', 'b', 0, 'jevSort', 'b', 1),
  L('de', 'dispatcher', 'b', 1, 'submit', 't', 1),
  L('jq', 'jevSort', 't', 1, 'queue', 'b', 1),
  L('jv', 'jevVote', 't', 1, 'vote', 'b', 1),
  L('vg', 'vote', 'r', 3, 'dispute', 't', 1),
  L('gq', 'dispute', 'b', 1, 'strongLane', 't', 1),
  L('ql', 'strongLane', 'r', 2, 'applied', 'b', 1),
  L('qr', 'strongLane', 'b', 1, 'rejected', 't', 1),
  L('vr', 'vote', 'r', 4, 'rejected', 'l', 2),
  L('en', 'submit', 'b', 1, 'notfound', 't', 1),
  L('nk', 'notfound', 'l', 2, 'cooldown', 'r', 2),
  L('kr', 'cooldown', 'b', 1, 'rejected', 'b', 1),
  L('kw', 'cooldown', 't', 2, 'card', 'b', 2),
]

export interface NodeBox {
  id: NodeId
  label: string
  sub?: string
  kind: NodeKind
  cx: number
  cy: number
  w: number
  h: number
}

export const portCount = (side: Side): number => (side === 't' || side === 'b' ? 3 : 5)

const toBox = (d: NodeDef): NodeBox => ({
  id: d.id, label: d.label, sub: d.sub, kind: d.kind,
  cx: d.x * CANVAS_W, cy: PAD_Y + d.y * (CANVAS_H - 2 * PAD_Y), w: NODE_W, h: NODE_H,
})

const BOX = Object.fromEntries(NODE_DEFS.map((d) => [d.id, toBox(d)])) as Record<NodeId, NodeBox>

/** 連接點座標：上下側把寬度 4 等分取 3 點、左右側把高度 6 等分取 5 點 */
export function anchorPoint(id: NodeId, side: Side, idx: number): Pt {
  const n = BOX[id]
  if (side === 't' || side === 'b') return [n.cx - n.w / 2 + (n.w * (idx + 1)) / 4, side === 't' ? n.cy - n.h / 2 : n.cy + n.h / 2]
  return [side === 'l' ? n.cx - n.w / 2 : n.cx + n.w / 2, n.cy - n.h / 2 + (n.h * (idx + 1)) / 6]
}

const dirOf = (s: Side): Pt => (s === 't' ? [0, -1] : s === 'b' ? [0, 1] : s === 'l' ? [-1, 0] : [1, 0])

/** 去掉重複點與共線的中間點 */
function simplify(pts: Pt[]): Pt[] {
  const a: Pt[] = []
  for (const q of pts) {
    const l = a[a.length - 1]
    if (!l || Math.abs(l[0] - q[0]) > 0.5 || Math.abs(l[1] - q[1]) > 0.5) a.push(q)
  }
  const o: Pt[] = [a[0]]
  for (let i = 1; i < a.length - 1; i++) {
    const [p0, p1, p2] = [o[o.length - 1], a[i], a[i + 1]]
    if (Math.abs((p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0])) > 0.5) o.push(p1)
  }
  o.push(a[a.length - 1])
  return o
}

/** 正交走線：兩端各先直走 STUB，中間依兩側方向補 1～2 個轉折（說明頁 buildPath） */
export function buildPath(A: Pt, sa: Side, B: Pt, sb: Side): Pt[] {
  const [da, db] = [dirOf(sa), dirOf(sb)]
  const A1: Pt = [A[0] + da[0] * STUB, A[1] + da[1] * STUB]
  const B1: Pt = [B[0] + db[0] * STUB, B[1] + db[1] * STUB]
  const va = sa === 't' || sa === 'b'
  const vb = sb === 't' || sb === 'b'
  let mid: Pt[]
  if (va && vb) {
    const ym = sa === sb ? (sa === 'b' ? Math.max(A1[1], B1[1]) : Math.min(A1[1], B1[1])) : (A1[1] + B1[1]) / 2
    mid = [[A1[0], ym], [B1[0], ym]]
  } else if (!va && !vb) {
    const xm = sa === sb ? (sa === 'r' ? Math.max(A1[0], B1[0]) : Math.min(A1[0], B1[0])) : (A1[0] + B1[0]) / 2
    mid = [[xm, A1[1]], [xm, B1[1]]]
  } else if (va) mid = [[A1[0], B1[1]]]
  else mid = [[B1[0], A1[1]]]
  return simplify([A, A1, ...mid, B1, B])
}

export interface Route {
  id: string
  from: NodeId
  to: NodeId
  pts: Pt[]
  style: LinkStyle
}

export interface Layout {
  width: number
  height: number
  nodes: Record<NodeId, NodeBox>
  routes: Route[]
}

/** 整張圖的版面；固定尺寸，沒有輸入 */
export function computeLayout(): Layout {
  const routes: Route[] = LINKS.map((l) => ({
    id: l.id, from: l.from, to: l.to, style: l.style,
    pts: buildPath(anchorPoint(l.from, l.fromSide, l.fromIdx), l.fromSide, anchorPoint(l.to, l.toSide, l.toIdx), l.toSide),
  }))
  return { width: CANVAS_W, height: CANVAS_H, nodes: { ...BOX }, routes }
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

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

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
