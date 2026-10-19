/**
 * 邊界點陣化的純函式（參選地圖，#680）：把行政區邊界畫成固定實際尺度的方格，每格記它屬於哪個行政區。
 * 產生端 scripts/build-tw-raster.ts 與畫面端 lib/candidacy-map.ts 共用；沒有外部依賴。
 *
 * 座標：投影成公里（正弦投影，中央經線 121°E：x＝東向距離、y＝北向距離，沿緯線與經線的距離都是真實的），
 * 所以一格就是真實的 cellKm × cellKm。
 * 格值：該格所屬行政區在 codes 裡的序號，海（沒有行政區）是 -1。
 */

export type Pt = [number, number]
/** 一塊陸地：外環＋洞（even-odd 規則處理洞），座標是投影後的公里 */
export interface RasterPolygon {
  rings: Pt[][]
}
export interface RasterInput {
  code: string
  polys: RasterPolygon[]
}
/** 取景框（公里）：x0 西界、yTop 北界，w／h 是格數 */
export interface RasterRect {
  x0: number
  yTop: number
  w: number
  h: number
}
export const SEA = -1

const KM_PER_DEG = 111.195
const LON0 = 121

export function projectKm(lon: number, lat: number): Pt {
  return [(lon - LON0) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180), lat * KM_PER_DEG]
}

/** 把一個取景範圍（經緯度）換成公里矩形（四角投影後取外框） */
export function rectKm(lonMin: number, lonMax: number, latMin: number, latMax: number) {
  const pts = [projectKm(lonMin, latMin), projectKm(lonMin, latMax), projectKm(lonMax, latMin), projectKm(lonMax, latMax)]
  return {
    xMin: Math.min(...pts.map((p) => p[0])),
    xMax: Math.max(...pts.map((p) => p[0])),
    yMin: Math.min(...pts.map((p) => p[1])),
    yMax: Math.max(...pts.map((p) => p[1])),
  }
}

export function rectToGrid(box: { xMin: number; xMax: number; yMin: number; yMax: number }, cellKm: number): RasterRect {
  return {
    x0: box.xMin,
    yTop: box.yMax,
    w: Math.max(1, Math.ceil((box.xMax - box.xMin) / cellKm)),
    h: Math.max(1, Math.ceil((box.yMax - box.yMin) / cellKm)),
  }
}

/** 多邊形外環的面積（公里²）與重心 */
export function polygonStats(poly: RasterPolygon): { area: number; cx: number; cy: number } {
  const ring = poly.rings[0] ?? []
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    a += f
    cx += (ring[j][0] + ring[i][0]) * f
    cy += (ring[j][1] + ring[i][1]) * f
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length || 1
    return { area: 0, cx: ring.reduce((s, p) => s + p[0], 0) / n, cy: ring.reduce((s, p) => s + p[1], 0) / n }
  }
  return { area: Math.abs(a / 2), cx: cx / (3 * a), cy: cy / (3 * a) }
}

/**
 * 點陣化：每格取 sub×sub 個取樣點，命中最多的行政區拿下這一格（同票取序號小的，結果可重現）。
 * 用掃描線：每條取樣列算出邊的交點、成對填色，不逐點判斷。
 * @returns 長度 w*h 的格值（行政區序號，海為 -1）
 */
export function rasterize(inputs: readonly RasterInput[], rect: RasterRect, cellKm: number, sub = 3): Int16Array {
  const { x0, yTop, w, h } = rect
  const cells = new Int16Array(w * h).fill(SEA)
  const bestCount = new Uint8Array(w * h)
  const counts = new Uint8Array(w * h)
  const step = cellKm / sub
  const rows = h * sub

  inputs.forEach((unit, idx) => {
    const touched: number[] = []
    for (const poly of unit.polys) {
      // 取樣列 → 交點 x
      const xsByRow = new Map<number, number[]>()
      for (const ring of poly.rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xa, ya] = ring[j]
          const [xb, yb] = ring[i]
          if (ya === yb) continue
          const yLo = Math.min(ya, yb)
          const yHi = Math.max(ya, yb)
          // 取樣列 r 的 y＝yTop − (r+0.5)·step；落在 [yLo, yHi) 的列
          const rFirst = Math.max(0, Math.ceil((yTop - yHi) / step - 0.5))
          const rLast = Math.min(rows - 1, Math.ceil((yTop - yLo) / step - 0.5) - 1)
          for (let r = rFirst; r <= rLast; r += 1) {
            const y = yTop - (r + 0.5) * step
            const x = xa + ((y - ya) * (xb - xa)) / (yb - ya)
            const list = xsByRow.get(r)
            if (list) list.push(x)
            else xsByRow.set(r, [x])
          }
        }
      }
      for (const [r, xs] of xsByRow) {
        xs.sort((p, q) => p - q)
        const cellRow = Math.floor(r / sub)
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const cFirst = Math.max(0, Math.ceil((xs[k] - x0) / step - 0.5))
          const cLast = Math.min(w * sub - 1, Math.ceil((xs[k + 1] - x0) / step - 0.5) - 1)
          for (let c = cFirst; c <= cLast; c += 1) {
            const at = cellRow * w + Math.floor(c / sub)
            if (counts[at] === 0) touched.push(at)
            counts[at] += 1
          }
        }
      }
    }
    for (const at of touched) {
      if (counts[at] > bestCount[at]) {
        bestCount[at] = counts[at]
        cells[at] = idx
      }
      counts[at] = 0
    }
  })
  return cells
}

export interface CellTarget {
  idx: number
  /** 希望放的位置（格座標，可為小數、可在取景框外；會夾回框內） */
  cx: number
  cy: number
}

/**
 * 保證每個行政區至少 1 格：沒拿到格子的，放在離目標位置最近的「海」或「有 2 格以上的鄰區的格子」
 * （都市裡很小的里常常整個落在鄰里的格子裡）。依 targets 順序處理，結果可重現。
 * 直接改傳入的 cells。
 */
export function ensureCells(cells: Int16Array, w: number, h: number, targets: readonly CellTarget[], unitCount: number): void {
  const owned = new Int32Array(unitCount)
  for (const v of cells) if (v >= 0) owned[v] += 1
  for (const t of targets) {
    if (owned[t.idx] > 0) continue
    const cx = Math.min(w - 1, Math.max(0, Math.floor(t.cx)))
    const cy = Math.min(h - 1, Math.max(0, Math.floor(t.cy)))
    const eligible = (x: number, y: number) => {
      const v = cells[y * w + x]
      return v === SEA || (v !== t.idx && owned[v] >= 2)
    }
    let found: [number, number] | null = null
    for (let r = 0; r < Math.max(w, h) && !found; r += 1) {
      let bestD = Infinity
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || y < 0 || x >= w || y >= h || !eligible(x, y)) continue
          const d = (x + 0.5 - t.cx) ** 2 + (y + 0.5 - t.cy) ** 2
          if (d < bestD) {
            bestD = d
            found = [x, y]
          }
        }
      }
    }
    if (!found) throw new Error(`沒有空間可以放第 ${t.idx} 個行政區`)
    const at = found[1] * w + found[0]
    if (cells[at] >= 0) owned[cells[at]] -= 1
    cells[at] = t.idx
    owned[t.idx] += 1
  }
}

/** 每個行政區的格數 */
export function cellCounts(cells: Int16Array, unitCount: number): Int32Array {
  const n = new Int32Array(unitCount)
  for (const v of cells) if (v >= 0) n[v] += 1
  return n
}

// ── 靜態檔格式（游程編碼）────────────────────────────────────────

/** 一張畫布上的一塊（全國層有主島＋三個離島內嵌框，其餘層只有一塊） */
export interface RasterLayer {
  ox: number
  oy: number
  w: number
  h: number
  /** [值, 連續格數, 值, 連續格數, …]，列優先；值＝行政區序號，海＝-1 */
  rle: number[]
  /** 內嵌框（離島）：畫面上加外框 */
  inset?: boolean
}
export interface RasterFile {
  /** 一格的邊長（公尺） */
  cellM: number
  /** 畫布大小（格） */
  w: number
  h: number
  /** 這張圖左上角在「世界」（全國層畫布，單位公里）裡的位置，單位是這個檔自己的格；全國檔沒有（＝0） */
  ox?: number
  oy?: number
  /** 行政區代碼，序號即格值 */
  codes: string[]
  /** 跟 codes 同順序的名稱（靜態資料，畫面不用等人數就能畫名稱） */
  names?: string[]
  layers: RasterLayer[]
}

export function encodeRle(cells: ArrayLike<number>): number[] {
  const out: number[] = []
  let prev = cells[0]
  let run = 0
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i] === prev) run += 1
    else {
      out.push(prev, run)
      prev = cells[i]
      run = 1
    }
  }
  if (cells.length) out.push(prev, run)
  return out
}

export function decodeRle(rle: readonly number[], length: number): Int16Array {
  const cells = new Int16Array(length)
  let at = 0
  for (let i = 0; i < rle.length; i += 2) {
    cells.fill(rle[i], at, at + rle[i + 1])
    at += rle[i + 1]
  }
  return cells
}

export interface DecodedRaster {
  w: number
  h: number
  cellM: number
  /** 世界位置（單位：這張圖的格），全國圖是 0 */
  ox: number
  oy: number
  codes: string[]
  names: string[]
  /** 整張畫布，列優先 */
  cells: Int16Array
  /** 內嵌框的位置（畫外框用） */
  insets: Array<{ ox: number; oy: number; w: number; h: number }>
}

/** 把各塊畫到整張畫布上（內嵌框後畫、蓋在主島之上） */
export function decodeRaster(file: RasterFile): DecodedRaster {
  const cells = new Int16Array(file.w * file.h).fill(SEA)
  const insets: DecodedRaster['insets'] = []
  for (const layer of file.layers) {
    const part = decodeRle(layer.rle, layer.w * layer.h)
    for (let y = 0; y < layer.h; y += 1) {
      for (let x = 0; x < layer.w; x += 1) {
        const v = part[y * layer.w + x]
        if (v !== SEA) cells[(layer.oy + y) * file.w + layer.ox + x] = v
      }
    }
    if (layer.inset) insets.push({ ox: layer.ox, oy: layer.oy, w: layer.w, h: layer.h })
  }
  return { w: file.w, h: file.h, cellM: file.cellM, ox: file.ox ?? 0, oy: file.oy ?? 0, codes: file.codes, names: file.names ?? [], cells, insets }
}

// ── 畫面：同一行政區的格子合併成一條 SVG path ─────────────────────

/** 每個行政區一條填色 path：同一列相連的格子合成一個長方形（M x y h n v 1 h -n z），單位是格 */
export function unitFillPaths(raster: Pick<DecodedRaster, 'w' | 'h' | 'cells' | 'codes'>): string[] {
  const { w, h, cells } = raster
  const parts: string[][] = raster.codes.map(() => [])
  for (let y = 0; y < h; y += 1) {
    let x = 0
    while (x < w) {
      const v = cells[y * w + x]
      let n = 1
      while (x + n < w && cells[y * w + x + n] === v) n += 1
      if (v >= 0) parts[v].push(`M${x} ${y}h${n}v1h-${n}z`)
      x += n
    }
  }
  return parts.map((p) => p.join(''))
}

/**
 * 沿格線的邊界。pick(a, b) 決定「格值 a 的右邊／下邊是 b」這條邊要不要畫；
 * 相連的同方向線段合併，輸出 M…h／v 的 path。
 */
function edgePath(raster: Pick<DecodedRaster, 'w' | 'h' | 'cells'>, pick: (a: number, b: number) => boolean): string {
  const { w, h, cells } = raster
  const out: string[] = []
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? SEA : cells[y * w + x])
  // 垂直邊：x 與 x−1 之間（x＝0…w）
  for (let x = 0; x <= w; x += 1) {
    let y = 0
    while (y < h) {
      if (pick(at(x - 1, y), at(x, y))) {
        let n = 1
        while (y + n < h && pick(at(x - 1, y + n), at(x, y + n))) n += 1
        out.push(`M${x} ${y}v${n}`)
        y += n
      } else y += 1
    }
  }
  // 水平邊：y 與 y−1 之間（y＝0…h）
  for (let y = 0; y <= h; y += 1) {
    let x = 0
    while (x < w) {
      if (pick(at(x, y - 1), at(x, y))) {
        let n = 1
        while (x + n < w && pick(at(x + n, y - 1), at(x + n, y))) n += 1
        out.push(`M${x} ${y}h${n}`)
        x += n
      } else x += 1
    }
  }
  return out.join('')
}

export interface UnitStat {
  count: number
  /** 格座標的重心與外框 */
  cx: number
  cy: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** 每個行政區的格數、重心與外框（放名稱標籤用）；沒有任何格的序號回 null */
export function unitStats(raster: Pick<DecodedRaster, 'w' | 'h' | 'cells' | 'codes'>): Array<UnitStat | null> {
  const stats: Array<UnitStat | null> = raster.codes.map(() => null)
  for (let y = 0; y < raster.h; y += 1) {
    for (let x = 0; x < raster.w; x += 1) {
      const v = raster.cells[y * raster.w + x]
      if (v < 0) continue
      const s = stats[v]
      if (!s) stats[v] = { count: 1, cx: x + 0.5, cy: y + 0.5, minX: x, maxX: x + 1, minY: y, maxY: y + 1 }
      else {
        s.cx += x + 0.5
        s.cy += y + 0.5
        s.count += 1
        if (x < s.minX) s.minX = x
        if (x + 1 > s.maxX) s.maxX = x + 1
        if (y < s.minY) s.minY = y
        if (y + 1 > s.maxY) s.maxY = y + 1
      }
    }
  }
  for (const s of stats) if (s) { s.cx /= s.count; s.cy /= s.count }
  return stats
}

/** 兩個不同行政區之間的邊界（整張地圖一條 path） */
export function boundaryPath(raster: Pick<DecodedRaster, 'w' | 'h' | 'cells'>): string {
  return edgePath(raster, (a, b) => a >= 0 && b >= 0 && a !== b)
}

/** 單一行政區的外框（含面向海的邊），滑過高亮用 */
export function outlinePath(raster: Pick<DecodedRaster, 'w' | 'h' | 'cells'>, idx: number): string {
  return edgePath(raster, (a, b) => (a === idx) !== (b === idx))
}

// ── 名稱標籤的位置與避讓 ─────────────────────────────────────────

/**
 * 每個陸地格到「最近的別區、海或圖邊」的距離（格，格心到邊界的距離，邊界格約 0.5）。
 * 兩趟 chamfer 近似歐氏距離；海格是 0。距離最大的格就是這個行政區的「最大內接位置」。
 */
export function inscribedDistance(raster: Pick<DecodedRaster, 'w' | 'h' | 'cells'>): Float32Array {
  const { w, h, cells } = raster
  const d = new Float32Array(w * h).fill(Infinity)
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -2 : cells[y * w + x])
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = cells[y * w + x]
      if (v < 0) d[y * w + x] = 0
      else if (at(x - 1, y) !== v || at(x + 1, y) !== v || at(x, y - 1) !== v || at(x, y + 1) !== v) d[y * w + x] = 0.5
    }
  }
  const D = Math.SQRT2
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? Infinity : d[y * w + x])
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      d[y * w + x] = Math.min(d[y * w + x], get(x - 1, y) + 1, get(x, y - 1) + 1, get(x - 1, y - 1) + D, get(x + 1, y - 1) + D)
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      d[y * w + x] = Math.min(d[y * w + x], get(x + 1, y) + 1, get(x, y + 1) + 1, get(x + 1, y + 1) + D, get(x - 1, y + 1) + D)
    }
  }
  return d
}

export interface PlacedLabel {
  idx: number
  text: string
  /** 文字中心（格座標）與字級（格） */
  x: number
  y: number
  fs: number
}

const LABEL_SCALES = [1, 0.85, 0.7, 0.6]

interface LabelPrep {
  stats: Array<UnitStat | null>
  /** 每個行政區的候選位置 [x, y, 距離]，距離最大的在前 */
  candidates: Array<Array<[number, number, number]>>
}
/** 標籤擺放要用的距離轉換與候選位置，每張點陣只算一次（縮放時重排標籤不再重算） */
const labelPrepCache = new WeakMap<object, LabelPrep>()
function labelPrep(raster: Pick<DecodedRaster, 'w' | 'h' | 'cells' | 'codes'>): LabelPrep {
  const hit = labelPrepCache.get(raster.cells)
  if (hit) return hit
  const { w, h, cells } = raster
  const dist = inscribedDistance(raster)
  const stats = unitStats(raster)
  // 每個行政區的候選位置：距離最大的格在前，之後從距離夠大的格裡均勻挑
  const best = raster.codes.map(() => 0)
  for (let i = 0; i < cells.length; i += 1) if (cells[i] >= 0 && dist[i] > best[cells[i]]) best[cells[i]] = dist[i]
  const pool: Array<Array<[number, number, number]>> = raster.codes.map(() => [])
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = cells[y * w + x]
      if (v >= 0 && dist[y * w + x] >= best[v] * 0.55) pool[v].push([x, y, dist[y * w + x]])
    }
  }
  const candidates = pool.map((list) => {
    list.sort((p, q) => q[2] - p[2] || p[1] - q[1] || p[0] - q[0])
    if (list.length <= 90) return list
    const stride = Math.ceil((list.length - 1) / 89)
    return list.filter((_, k) => k === 0 || k % stride === 0)
  })
  const prep = { stats, candidates }
  labelPrepCache.set(raster.cells, prep)
  return prep
}

/**
 * 標籤擺放：
 * - 位置用最大內接位置（距邊界最遠的格），不用重心——被別區環繞的小區（嘉義市在嘉義縣中間），環狀區的重心會落在小區上。
 * - 小面積的先擺；後擺的大區碰到已擺的標籤就換自己區內別的位置、再不行縮小字級（最小 0.6 倍）、都不行就不放（滑過仍有提示卡）。
 * - 大區的標籤要有一定比例落在自己的格子上；小到字寫不下的區（字比整個區還大）允許字溢出到鄰區，但仍以最大內接位置為中心。
 * @param texts 依行政區序號排的名稱
 * @param baseFs 預設字級（格）
 */
export function placeLabels(raster: Pick<DecodedRaster, 'w' | 'h' | 'cells' | 'codes'>, texts: readonly string[], baseFs: number): PlacedLabel[] {
  const { w, h, cells } = raster
  const { stats, candidates } = labelPrep(raster)

  const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = []
  const out: PlacedLabel[] = []
  const order = raster.codes.map((_, i) => i).filter((i) => stats[i]).sort((a, b) => stats[a]!.count - stats[b]!.count || a - b)
  for (const idx of order) {
    const text = texts[idx]
    const s = stats[idx]!
    if (!text) continue
    for (const scale of LABEL_SCALES) {
      const fs = baseFs * scale
      const bw = text.length * fs
      const bh = fs * 1.2
      // 字寫不下整個區（外框比字小）：小區例外，可以溢出到鄰區
      const cannotFit = bw > s.maxX - s.minX || bh > s.maxY - s.minY
      // 只有幾格的區（村里層很多）字溢出去只會蓋住鄰區，不放標籤
      if (cannotFit && s.count < 6) continue
      let hit: { x: number; y: number } | null = null
      for (const [cx, cy] of candidates[idx]) {
        const cxm = cx + 0.5
        const cym = cy + 0.5
        const box = { x0: cxm - bw / 2 - fs * 0.15, x1: cxm + bw / 2 + fs * 0.15, y0: cym - bh / 2 - fs * 0.1, y1: cym + bh / 2 + fs * 0.1 }
        if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue
        if (!cannotFit) {
          let inside = 0
          let total = 0
          for (let y = Math.floor(cym - bh / 2); y <= Math.floor(cym + bh / 2); y += 1) {
            for (let x = Math.floor(cxm - bw / 2); x <= Math.floor(cxm + bw / 2); x += 1) {
              total += 1
              if (x >= 0 && y >= 0 && x < w && y < h && cells[y * w + x] === idx) inside += 1
            }
          }
          if (inside / total < 0.6) continue
        }
        hit = { x: cxm, y: cym }
        placed.push(box)
        break
      }
      if (hit) {
        out.push({ idx, text, x: hit.x, y: hit.y, fs })
        break
      }
    }
  }
  return out.sort((a, b) => a.idx - b.idx)
}
