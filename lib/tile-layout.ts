/**
 * 格子地圖的排格演算法（純函式，無外部依賴）。
 *
 * 輸入：一群單位的中心點經緯度。輸出：每個單位一格（整數座標），相對位置大致照地理。
 * 做法：
 *   1. 經度乘 cos(中心緯度) 投影，北在上（y 往下增加）。
 *   2. 依單位數量定格子邊長，讓外框格數約為單位數的 density 倍。
 *   3. 每個中心點量化到所在格。沒人共用的先落位；
 *      多個單位搶同一格時，依 key 排序（結果可重現），各自往最近的空格推
 *      （以環狀向外找，距離比的是原始位置到格心，同距離取上方、左方）。
 *   4. 座標平移到 (0,0) 起算。
 *
 * 用在 scripts/build-tw-tile-grid.ts（預先產生靜態座標）與 appendTiles（資料裡多出來、
 * 座標檔沒有的單位，補在外框空格或最下方）。
 */

export interface GeoPoint {
  key: string
  lon: number
  lat: number
}

export interface TileCell {
  key: string
  x: number
  y: number
}

export interface TileLayout {
  cells: TileCell[]
  cols: number
  rows: number
}

export interface LayoutOptions {
  /** 外框格數 ÷ 單位數。越大越鬆、越貼近地理；預設 1.7 */
  density?: number
}

const DEFAULT_DENSITY = 1.7

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 環狀由內而外列出距離中心 r（切比雪夫距離）的格座標 */
function ringOffsets(r: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === r) out.push([dx, dy])
    }
  }
  return out
}

export function layoutTiles(points: readonly GeoPoint[], options: LayoutOptions = {}): TileLayout {
  const n = points.length
  if (n === 0) return { cells: [], cols: 0, rows: 0 }
  if (n === 1) return { cells: [{ key: points[0].key, x: 0, y: 0 }], cols: 1, rows: 1 }

  const density = options.density && options.density > 0 ? options.density : DEFAULT_DENSITY
  const midLat = points.reduce((s, p) => s + p.lat, 0) / n
  const k = Math.cos((midLat * Math.PI) / 180)
  const proj = points.map((p) => ({ key: p.key, px: p.lon * k, py: -p.lat }))

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of proj) {
    if (p.px < minX) minX = p.px
    if (p.px > maxX) maxX = p.px
    if (p.py < minY) minY = p.py
    if (p.py > maxY) maxY = p.py
  }
  const w = maxX - minX
  const h = maxY - minY
  // 一條線（寬或高為 0）：邊長改按長邊 ÷ 單位數，避免面積為 0
  const side = w > 0 && h > 0 ? Math.sqrt((w * h) / (n * density)) : Math.max(w, h) / Math.max(1, Math.ceil(n * density) - 1) || 1

  // 以格為單位的浮點位置（格心在 .5）
  const items = proj.map((p) => ({
    key: p.key,
    fx: (p.px - minX) / side,
    fy: (p.py - minY) / side,
  }))
  const home = (fx: number, fy: number): [number, number] => [Math.floor(fx), Math.floor(fy)]
  const id = (x: number, y: number) => `${x},${y}`

  const demand = new Map<string, number>()
  for (const it of items) {
    const [x, y] = home(it.fx, it.fy)
    demand.set(id(x, y), (demand.get(id(x, y)) ?? 0) + 1)
  }

  const taken = new Set<string>()
  const placed = new Map<string, [number, number]>()
  // 先落位沒人搶的
  for (const it of items) {
    const [x, y] = home(it.fx, it.fy)
    if (demand.get(id(x, y)) === 1) {
      taken.add(id(x, y))
      placed.set(it.key, [x, y])
    }
  }
  // 再處理搶格的：key 排序，各自找最近空格
  const contested = items.filter((it) => !placed.has(it.key)).sort((a, b) => compareKey(a.key, b.key))
  for (const it of contested) {
    const [hx, hy] = home(it.fx, it.fy)
    let found: [number, number] | null = null
    for (let r = 0; found === null; r += 1) {
      let best: [number, number] | null = null
      let bestD = Infinity
      for (const [dx, dy] of r === 0 ? ([[0, 0]] as Array<[number, number]>) : ringOffsets(r)) {
        const x = hx + dx
        const y = hy + dy
        if (taken.has(id(x, y))) continue
        const d = (x + 0.5 - it.fx) ** 2 + (y + 0.5 - it.fy) ** 2
        // 同距離取上方、再取左方（掃描順序已是由上而下、由左而右，嚴格小於即可）
        if (d < bestD - 1e-9) {
          bestD = d
          best = [x, y]
        }
      }
      if (best) found = best
    }
    taken.add(id(found[0], found[1]))
    placed.set(it.key, found)
  }

  let loX = Infinity
  let loY = Infinity
  let hiX = -Infinity
  let hiY = -Infinity
  for (const [x, y] of placed.values()) {
    if (x < loX) loX = x
    if (y < loY) loY = y
    if (x > hiX) hiX = x
    if (y > hiY) hiY = y
  }
  const cells = points
    .map((p) => {
      const [x, y] = placed.get(p.key)!
      return { key: p.key, x: x - loX, y: y - loY }
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
  return { cells, cols: hiX - loX + 1, rows: hiY - loY + 1 }
}

/**
 * 座標檔沒有的單位（官方清單新增、座標檔還沒重產）：補在外框內的空格，
 * 沒有空格再開新的一列。不動既有的格子。
 */
export function appendTiles(cells: readonly TileCell[], missingKeys: readonly string[]): TileLayout {
  const out = cells.map((c) => ({ ...c }))
  let cols = out.reduce((m, c) => Math.max(m, c.x + 1), 0)
  let rows = out.reduce((m, c) => Math.max(m, c.y + 1), 0)
  const taken = new Set(out.map((c) => `${c.x},${c.y}`))
  if (cols === 0) cols = Math.max(1, Math.ceil(Math.sqrt(missingKeys.length)))
  for (const key of [...missingKeys].sort(compareKey)) {
    let placedAt: [number, number] | null = null
    for (let y = 0; y < rows && !placedAt; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        if (!taken.has(`${x},${y}`)) {
          placedAt = [x, y]
          break
        }
      }
    }
    if (!placedAt) {
      placedAt = [0, rows]
      rows += 1
    }
    taken.add(`${placedAt[0]},${placedAt[1]}`)
    out.push({ key, x: placedAt[0], y: placedAt[1] })
  }
  return { cells: out, cols, rows: Math.max(rows, out.reduce((m, c) => Math.max(m, c.y + 1), 0)) }
}
