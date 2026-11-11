// /trace 流程圖的版面（維護者 2026-11-11 定稿）：17 個節點、23 條全直角的線。
// 基準畫布 697×820，節點一律 126×36，寬度不同時等比縮放。純計算，不碰 DOM。
// 連接點：左右兩側各 3 個（index 0 上、1 中、2 下），上下兩側各 5 個（index 0 左 … 4 右）。
import type { NodeId } from './trace'

export const BASE_W = 697
export const BASE_H = 820
export const NODE_W = 126
export const NODE_H = 36

export type Side = 't' | 'b' | 'l' | 'r'
export type Pt = [number, number]

/** 框型：系統節點＝實線方框、代理節點＝圓角框、Jev＝雙線框、終點＝粗框填底 */
export type NodeKind = 'system' | 'agent' | 'jev' | 'end'

export interface NodeDef {
  id: NodeId
  label: string
  kind: NodeKind
  cx: number
  cy: number
}

/** 節點中心座標（基準畫布）。維護者 2026-11-11 定稿：17 個節點 */
export const NODE_DEFS: readonly NodeDef[] = [
  { id: 'official', label: '官方資料', kind: 'system', cx: 87, cy: 41 },
  { id: 'detector', label: '資料缺口偵測（44 支臂）', kind: 'system', cx: 87, cy: 123 },
  { id: 'card', label: '工作卡（人×事）', kind: 'system', cx: 87, cy: 205 },
  { id: 'queue', label: '派工佇列', kind: 'system', cx: 87, cy: 287 },
  { id: 'dispatcher', label: '派工分配器', kind: 'system', cx: 87, cy: 369 },
  { id: 'vote', label: '別的代理投票', kind: 'agent', cx: 87, cy: 451 },
  { id: 'applied', label: '落庫上線', kind: 'end', cx: 87, cy: 615 },
  { id: 'visitor', label: '訪客請求', kind: 'agent', cx: 261, cy: 41 },
  { id: 'suggest', label: '代理提議', kind: 'agent', cx: 436, cy: 41 },
  { id: 'jevSort', label: 'Jev 整理', kind: 'jev', cx: 436, cy: 287 },
  { id: 'jevVote', label: 'Jev 系統票', kind: 'jev', cx: 436, cy: 451 },
  { id: 'submit', label: '代理交件', kind: 'agent', cx: 436, cy: 369 },
  { id: 'notfound', label: '查無', kind: 'system', cx: 610, cy: 369 },
  { id: 'cooldown', label: '冷卻 5／10／20 天', kind: 'system', cx: 610, cy: 205 },
  { id: 'dispute', label: '爭議', kind: 'system', cx: 261, cy: 533 },
  { id: 'strongLane', label: '強模型通道', kind: 'system', cx: 436, cy: 533 },
  { id: 'rejected', label: '退件／結案', kind: 'end', cx: 610, cy: 533 },
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
  /** 起點與終點之間的轉折點（基準畫布座標），全部是直角 */
  via: readonly Pt[]
  style: LinkStyle
}

const L = (id: string, from: NodeId, fs: Side, fi: number, to: NodeId, ts: Side, ti: number, via: readonly Pt[] = [], style: LinkStyle = 'solid'): LinkDef =>
  ({ id, from, fromSide: fs, fromIdx: fi, to, toSide: ts, toIdx: ti, via, style })

/** 23 條線：from → to，side／index 是連接點 */
export const LINKS: readonly LinkDef[] = [
  L('a1b', 'official', 'b', 2, 'detector', 't', 2),
  L('bw', 'detector', 'b', 2, 'card', 't', 2),
  L('wc', 'card', 'b', 2, 'queue', 't', 2),
  L('cd', 'queue', 'b', 2, 'dispatcher', 't', 2),
  L('dv', 'dispatcher', 'b', 2, 'vote', 't', 2),
  L('vl', 'vote', 'b', 2, 'applied', 't', 2),
  L('a2w', 'visitor', 'b', 2, 'card', 'r', 0, [[261, 195]]),
  L('a3w', 'suggest', 'b', 2, 'card', 'r', 1, [[436, 205]]),
  L('ja', 'jevSort', 'r', 0, 'suggest', 'r', 1, [[520, 277], [520, 41]], 'dashed'),
  L('ep3', 'submit', 'r', 2, 'jevVote', 'r', 2, [[520, 379], [520, 461]]),
  L('ep2', 'submit', 'r', 0, 'jevSort', 'r', 2, [[515, 359], [515, 297]]),
  L('de', 'dispatcher', 'r', 1, 'submit', 'l', 1),
  L('jq', 'jevSort', 'l', 1, 'queue', 'r', 1),
  L('jv', 'jevVote', 'l', 1, 'vote', 'r', 1),
  L('vg', 'vote', 'b', 3, 'dispute', 'l', 1, [[111, 533]]),
  L('gq', 'dispute', 'r', 1, 'strongLane', 'l', 1),
  L('ql', 'strongLane', 'b', 2, 'applied', 'r', 1, [[436, 615]]),
  L('qr', 'strongLane', 'r', 1, 'rejected', 'l', 1),
  L('vr', 'vote', 'b', 4, 'rejected', 't', 2, [[135, 490], [610, 490]]),
  L('en', 'submit', 'r', 1, 'notfound', 'l', 1),
  L('nk', 'notfound', 't', 2, 'cooldown', 'b', 2),
  L('kr', 'cooldown', 'r', 1, 'rejected', 'r', 1, [[690, 205], [690, 533]]),
  L('kw', 'cooldown', 'l', 2, 'card', 'r', 2),
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
  kind: NodeKind
  cx: number
  cy: number
  w: number
  h: number
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
  scale: number
  nodes: Record<NodeId, NodeBox>
  routes: Route[]
}

/** 依畫布寬度等比縮放基準畫布 */
export function computeLayout(width: number): Layout {
  const s = Math.max(1, width) / BASE_W
  const sc = (p: Pt): Pt => [p[0] * s, p[1] * s]
  const nodes = {} as Record<NodeId, NodeBox>
  for (const d of NODE_DEFS) nodes[d.id] = { id: d.id, label: d.label, kind: d.kind, cx: d.cx * s, cy: d.cy * s, w: NODE_W * s, h: NODE_H * s }
  const routes: Route[] = LINKS.map((l) => ({
    id: l.id,
    from: l.from,
    to: l.to,
    style: l.style,
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
