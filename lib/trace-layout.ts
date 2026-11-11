// /trace 流程圖的版面（維護者 2026-11-11 定案）：16 個節點、22 條全直角的線。
// 基準畫布 697×820，節點一律 126×36，寬度不同時等比縮放。純計算，不碰 DOM。
// 連接點：左右兩側各 3 個（index 0 上、1 中、2 下），上下兩側各 5 個（index 0 左 … 4 右）。
import type { NodeId } from './trace'

export const BASE_W = 697
export const BASE_H = 820
export const NODE_W = 126
export const NODE_H = 36

export type Side = 't' | 'b' | 'l' | 'r'
export type Pt = [number, number]

export interface NodeDef {
  id: NodeId
  label: string
  cx: number
  cy: number
}

/** 節點中心座標（基準畫布） */
export const NODE_DEFS: readonly NodeDef[] = [
  { id: 'official', label: '官方資料', cx: 87, cy: 41 },
  { id: 'detector', label: '資料缺口偵測（44 支臂）', cx: 87, cy: 123 },
  { id: 'card', label: '工作卡（人×事）', cx: 87, cy: 205 },
  { id: 'queue', label: '一條佇列', cx: 87, cy: 287 },
  { id: 'dispatcher', label: '派工分配器', cx: 87, cy: 369 },
  { id: 'vote', label: '別的代理投票', cx: 87, cy: 451 },
  { id: 'applied', label: '落庫上線', cx: 87, cy: 697 },
  { id: 'visitor', label: '訪客請求', cx: 261, cy: 41 },
  { id: 'suggest', label: '代理提議', cx: 436, cy: 41 },
  { id: 'jev', label: 'Jev', cx: 261, cy: 287 },
  { id: 'submit', label: '代理交件', cx: 436, cy: 451 },
  { id: 'notfound', label: '查無', cx: 610, cy: 533 },
  { id: 'cooldown', label: '冷卻 5／10／20 天', cx: 610, cy: 615 },
  { id: 'dispute', label: '爭議', cx: 261, cy: 451 },
  { id: 'strongLane', label: '強模型通道', cx: 261, cy: 533 },
  { id: 'rejected', label: '退件／結案', cx: 436, cy: 615 },
]

export type LinkStyle = 'solid' | 'return' | 'propose' | 'system'

export interface LinkDef {
  from: NodeId
  fromSide: Side
  fromIdx: number
  to: NodeId
  toSide: Side
  toIdx: number
  /** 起點與終點之間的轉折點（基準畫布座標），全部是直角 */
  via: readonly Pt[]
  style: LinkStyle
  label?: string
  labelAt?: Pt
  labelAlign?: 'left' | 'right' | 'center'
}

/** 22 條線：from → to，side／index 是連接點 */
export const LINKS: readonly LinkDef[] = [
  { from: 'official', fromSide: 'b', fromIdx: 2, to: 'detector', toSide: 'r', toIdx: 1, via: [[87, 82], [170, 82], [170, 123]], style: 'solid' },
  { from: 'detector', fromSide: 'b', fromIdx: 2, to: 'card', toSide: 't', toIdx: 2, via: [], style: 'solid' },
  { from: 'card', fromSide: 'b', fromIdx: 2, to: 'queue', toSide: 't', toIdx: 2, via: [], style: 'solid' },
  { from: 'queue', fromSide: 'b', fromIdx: 2, to: 'dispatcher', toSide: 't', toIdx: 2, via: [], style: 'solid' },
  { from: 'dispatcher', fromSide: 'b', fromIdx: 2, to: 'vote', toSide: 't', toIdx: 2, via: [], style: 'solid' },
  { from: 'vote', fromSide: 'b', fromIdx: 2, to: 'applied', toSide: 't', toIdx: 2, via: [], style: 'solid' },
  { from: 'visitor', fromSide: 'b', fromIdx: 2, to: 'card', toSide: 'r', toIdx: 0, via: [[261, 195]], style: 'solid' },
  { from: 'suggest', fromSide: 'b', fromIdx: 1, to: 'card', toSide: 'r', toIdx: 1, via: [[412, 205]], style: 'solid' },
  { from: 'jev', fromSide: 'r', fromIdx: 0, to: 'suggest', toSide: 'b', toIdx: 3, via: [[460, 277]], style: 'propose', label: '順手提議', labelAt: [466, 160], labelAlign: 'left' },
  { from: 'submit', fromSide: 't', fromIdx: 3, to: 'jev', toSide: 'r', toIdx: 2, via: [[460, 297]], style: 'solid' },
  { from: 'dispatcher', fromSide: 'r', fromIdx: 1, to: 'submit', toSide: 't', toIdx: 1, via: [[412, 369]], style: 'solid' },
  { from: 'jev', fromSide: 't', fromIdx: 2, to: 'queue', toSide: 't', toIdx: 4, via: [[261, 250], [135, 250]], style: 'return', label: '驗證票回隊', labelAt: [198, 243], labelAlign: 'center' },
  { from: 'jev', fromSide: 'l', fromIdx: 2, to: 'vote', toSide: 'r', toIdx: 0, via: [[175, 297], [175, 441]], style: 'system', label: '系統票', labelAt: [181, 322], labelAlign: 'left' },
  { from: 'vote', fromSide: 'b', fromIdx: 4, to: 'dispute', toSide: 'l', toIdx: 2, via: [[135, 485], [180, 485], [180, 461]], style: 'solid' },
  { from: 'dispute', fromSide: 'b', fromIdx: 2, to: 'strongLane', toSide: 't', toIdx: 2, via: [], style: 'solid' },
  { from: 'strongLane', fromSide: 'b', fromIdx: 1, to: 'applied', toSide: 'r', toIdx: 1, via: [[237, 697]], style: 'solid' },
  { from: 'strongLane', fromSide: 'b', fromIdx: 3, to: 'rejected', toSide: 't', toIdx: 2, via: [[285, 574], [436, 574]], style: 'solid' },
  { from: 'vote', fromSide: 'b', fromIdx: 3, to: 'rejected', toSide: 'l', toIdx: 1, via: [[111, 615]], style: 'solid' },
  { from: 'submit', fromSide: 'r', fromIdx: 1, to: 'notfound', toSide: 't', toIdx: 2, via: [[610, 451]], style: 'solid' },
  { from: 'notfound', fromSide: 'b', fromIdx: 2, to: 'cooldown', toSide: 't', toIdx: 2, via: [], style: 'solid' },
  { from: 'cooldown', fromSide: 'l', fromIdx: 1, to: 'rejected', toSide: 'r', toIdx: 1, via: [], style: 'solid' },
  { from: 'cooldown', fromSide: 'r', fromIdx: 1, to: 'card', toSide: 'r', toIdx: 2, via: [[690, 615], [690, 215]], style: 'return', label: '冷卻完回卡', labelAt: [560, 207], labelAlign: 'center' },
]

const SIDE_STEP_LR = 10 // 左右側連接點上下間距
const SIDE_STEP_TB = 24 // 上下側連接點左右間距

const DEF = Object.fromEntries(NODE_DEFS.map((n) => [n.id, n])) as Record<NodeId, NodeDef>

/** 基準畫布上的連接點 */
export function anchorPoint(id: NodeId, side: Side, idx: number): Pt {
  const n = DEF[id]
  if (side === 't') return [n.cx + (idx - 2) * SIDE_STEP_TB, n.cy - NODE_H / 2]
  if (side === 'b') return [n.cx + (idx - 2) * SIDE_STEP_TB, n.cy + NODE_H / 2]
  if (side === 'l') return [n.cx - NODE_W / 2, n.cy + (idx - 1) * SIDE_STEP_LR]
  return [n.cx + NODE_W / 2, n.cy + (idx - 1) * SIDE_STEP_LR]
}

export interface NodeBox {
  id: NodeId
  label: string
  cx: number
  cy: number
  w: number
  h: number
}

export interface Route {
  from: NodeId
  to: NodeId
  pts: Pt[]
  style: LinkStyle
  label?: string
  labelAt?: Pt
  labelAlign?: 'left' | 'right' | 'center'
}

export interface Layout {
  width: number
  height: number
  scale: number
  nodes: Record<NodeId, NodeBox>
  routes: Route[]
}

/** 依畫布寬度等比縮放基準畫布 */
export function computeLayout(width: number): Layout {
  const s = Math.max(1, width) / BASE_W
  const sc = (p: Pt): Pt => [p[0] * s, p[1] * s]
  const nodes = {} as Record<NodeId, NodeBox>
  for (const d of NODE_DEFS) nodes[d.id] = { id: d.id, label: d.label, cx: d.cx * s, cy: d.cy * s, w: NODE_W * s, h: NODE_H * s }
  const routes: Route[] = LINKS.map((l) => ({
    from: l.from,
    to: l.to,
    style: l.style,
    label: l.label,
    labelAt: l.labelAt ? sc(l.labelAt) : undefined,
    labelAlign: l.labelAlign,
    pts: [sc(anchorPoint(l.from, l.fromSide, l.fromIdx)), ...l.via.map(sc), sc(anchorPoint(l.to, l.toSide, l.toIdx))],
  }))
  return { width: BASE_W * s, height: BASE_H * s, scale: s, nodes, routes }
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
