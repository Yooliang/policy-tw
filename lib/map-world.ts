/**
 * 參選地圖「單一大地圖連續縮放」的純函式（pages/StatsMap.vue 用）。
 *
 * 世界座標＝全國層畫布的座標，單位公里，原點在左上（y 往下）。檢視 View＝中心 (cx, cy) 與縮放 k（螢幕上每公里幾個像素）。
 * 細節層（LOD）只看 k：縣市層的格子是 1 公里，所以 k＝「1 公里格在螢幕上幾像素」；鄉鎮層同尺度；村里層格子 200 公尺。
 */

export interface View {
  cx: number
  cy: number
  k: number
}
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}
export type Lod = 'county' | 'town' | 'village'

/** 每公里 ≥ 這麼多像素就從縣市換成鄉鎮、再換成村里（鄉鎮：1 公里格 4 像素；村里：200 公尺格約 2.8 像素） */
export const TOWN_AT = 4
export const VILLAGE_AT = 14
/** 縮小時的遲滯（避免在門檻上來回閃） */
export const LOD_HYSTERESIS = 0.9
export const K_MAX = 90

export function lodFor(k: number, prev: Lod): Lod {
  let lod = prev
  if (lod === 'county' && k >= TOWN_AT) lod = 'town'
  if (lod === 'town' && k >= VILLAGE_AT) lod = 'village'
  if (lod === 'village' && k < VILLAGE_AT * LOD_HYSTERESIS) lod = 'town'
  if (lod === 'town' && k < TOWN_AT * LOD_HYSTERESIS) lod = 'county'
  return lod
}

/** 螢幕大小 w×h 像素時，檢視看得到的世界範圍 */
export function viewBox(view: View, w: number, h: number): Box {
  const hw = w / view.k / 2
  const hh = h / view.k / 2
  return { x0: view.cx - hw, y0: view.cy - hh, x1: view.cx + hw, y1: view.cy + hh }
}

export function boxesIntersect(a: Box, b: Box, pad = 0): boolean {
  return a.x0 - pad < b.x1 && a.x1 + pad > b.x0 && a.y0 - pad < b.y1 && a.y1 + pad > b.y0
}

export function expandBox(b: Box, f: number): Box {
  const px = (b.x1 - b.x0) * f
  const py = (b.y1 - b.y0) * f
  return { x0: b.x0 - px, y0: b.y0 - py, x1: b.x1 + px, y1: b.y1 + py }
}

/** 一張點陣在世界裡佔的範圍（公里）：ox、oy、w、h 的單位是它自己的格，cellM 是格的邊長（公尺） */
export function layerBox(r: { ox: number; oy: number; w: number; h: number; cellM: number }): Box {
  const u = r.cellM / 1000
  return { x0: r.ox * u, y0: r.oy * u, x1: (r.ox + r.w) * u, y1: (r.oy + r.h) * u }
}

/** 世界座標 (x, y) 落在這張點陣的哪一格；圖外或海回 -1 */
export function cellAt(r: { ox: number; oy: number; w: number; h: number; cellM: number; cells: ArrayLike<number> }, x: number, y: number): number {
  const u = r.cellM / 1000
  const gx = Math.floor(x / u - r.ox)
  const gy = Math.floor(y / u - r.oy)
  if (gx < 0 || gy < 0 || gx >= r.w || gy >= r.h) return -1
  return r.cells[gy * r.w + gx]
}

/** 整張世界剛好放進螢幕的縮放 */
export function fitK(world: { w: number; h: number }, w: number, h: number): number {
  return Math.max(0.01, Math.min(w / world.w, h / world.h))
}

/** 把某個範圍放進螢幕中央（留 pad 倍邊），縮放夾在 [kMin, kMax] */
export function fitBox(box: Box, w: number, h: number, pad: number, kMin: number, kMax = K_MAX): View {
  const bw = Math.max(0.5, box.x1 - box.x0) * pad
  const bh = Math.max(0.5, box.y1 - box.y0) * pad
  const k = Math.min(kMax, Math.max(kMin, Math.min(w / bw, h / bh)))
  return { cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, k }
}

/** 中心夾在世界範圍內（外面是海，不讓人拖到全空） */
export function clampView(view: View, world: { w: number; h: number }): View {
  return { k: view.k, cx: Math.min(world.w, Math.max(0, view.cx)), cy: Math.min(world.h, Math.max(0, view.cy)) }
}

/**
 * 一格滾輪換成倍率；觸控板捏合（瀏覽器送帶 ctrlKey 的 wheel，deltaY 很小）靈敏度放大；
 * 滑鼠 Ctrl＋滾輪（deltaY 一格約 100）走一般靈敏度，不然一格就放大 2.7 倍。單次變化有上限（慣性滾輪不會一次衝過頭）。
 */
export function wheelK(k: number, deltaY: number, ctrlKey: boolean, kMin: number, kMax = K_MAX): number {
  const rate = ctrlKey && Math.abs(deltaY) < 30 ? 0.01 : 0.002
  const next = k * Math.exp(-Math.max(-200, Math.min(200, deltaY)) * rate)
  return Math.min(kMax, Math.max(kMin, next))
}

/** 縮放到 newK，並讓螢幕上 (px, py)（相對地圖左上角的像素）底下那個世界點留在原位 */
export function zoomAtPoint(view: View, w: number, h: number, px: number, py: number, newK: number): View {
  const wx = view.cx + (px - w / 2) / view.k
  const wy = view.cy + (py - h / 2) / view.k
  return { k: newK, cx: wx - (px - w / 2) / newK, cy: wy - (py - h / 2) / newK }
}

/** 螢幕像素 → 世界座標 */
export function screenToWorld(view: View, w: number, h: number, px: number, py: number): [number, number] {
  return [view.cx + (px - w / 2) / view.k, view.cy + (py - h / 2) / view.k]
}

/**
 * 村里層要載入哪些鄉鎮：範圍跟（放大一圈的）視窗相交的，離視窗中心近的先，最多 limit 個
 */
export function pickVisibleTowns(towns: ReadonlyArray<{ code: string; box: Box }>, view: Box, limit: number): string[] {
  const cx = (view.x0 + view.x1) / 2
  const cy = (view.y0 + view.y1) / 2
  const pad = Math.max(view.x1 - view.x0, view.y1 - view.y0) * 0.1
  return towns
    .filter((t) => boxesIntersect(t.box, view, pad))
    .map((t) => ({ code: t.code, d: Math.hypot((t.box.x0 + t.box.x1) / 2 - cx, (t.box.y0 + t.box.y1) / 2 - cy) }))
    .sort((a, b) => a.d - b.d || (a.code < b.code ? -1 : 1))
    .slice(0, limit)
    .map((t) => t.code)
}

/** 超過上限時要釋放哪些已載入的鄉鎮：不在 keep 裡的，最久沒用到的先 */
export function pickEvictions(loaded: ReadonlyMap<string, number>, keep: ReadonlySet<string>, max: number): string[] {
  const extra = loaded.size - max
  if (extra <= 0) return []
  return [...loaded.entries()]
    .filter(([code]) => !keep.has(code))
    .sort((a, b) => a[1] - b[1])
    .slice(0, extra)
    .map(([code]) => code)
}

/** 滾輪要不要用來縮放地圖：Ctrl（Windows／Linux、觸控板捏合）或 ⌘（Mac）才縮放，一般滾輪留給頁面捲動 */
export function isZoomWheel(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey
}

/** 提示用的修飾鍵名稱：Mac 顯示 ⌘，其他顯示 Ctrl */
export function zoomModifierLabel(platform: string): 'Ctrl' | '⌘' {
  return /Mac|iPhone|iPad/i.test(platform) ? '⌘' : 'Ctrl'
}

// ── 取景要扣掉被遮住的區域 ──────────────────────────────────────

/** 螢幕上被選單、浮動面板蓋住的邊（像素）：取景時地圖要放進「扣掉這些邊」之後看得到的那塊 */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** 看得到的那塊的大小（至少 50 像素，免得面板很大時算出負的） */
function visible(w: number, h: number, i: Insets) {
  return { aw: Math.max(50, w - i.left - i.right), ah: Math.max(50, h - i.top - i.bottom) }
}

/** 整張世界剛好放進「扣掉被遮住的區域」之後看得到的那塊 */
export function fitKInsets(world: { w: number; h: number }, w: number, h: number, i: Insets): number {
  const { aw, ah } = visible(w, h, i)
  return Math.max(0.01, Math.min(aw / world.w, ah / world.h))
}

/** 把某個範圍放進看得到的那塊的正中央（留 pad 倍邊），縮放夾在 [kMin, kMax]；沒有被遮住的邊就跟 fitBox 一樣 */
export function fitBoxInsets(box: Box, w: number, h: number, pad: number, kMin: number, kMax: number, i: Insets): View {
  const { aw, ah } = visible(w, h, i)
  const bw = Math.max(0.5, box.x1 - box.x0) * pad
  const bh = Math.max(0.5, box.y1 - box.y0) * pad
  const k = Math.min(kMax, Math.max(kMin, Math.min(aw / bw, ah / bh)))
  // 看得到的那塊的中心在螢幕上的位置，要剛好對上範圍的中心
  const vx = i.left + aw / 2
  const vy = i.top + ah / 2
  return { cx: (box.x0 + box.x1) / 2 - (vx - w / 2) / k, cy: (box.y0 + box.y1) / 2 - (vy - h / 2) / k, k }
}

/**
 * 從實際量到的面板位置算出被遮住的邊（像素，相對地圖左上角）。
 * - 上：上方面板（路徑與人數、切換）最低的下緣＋邊距，至少是白色分頁卡片疊進來的那 50px＋邊距
 * - 下：圖例的高度（加上它離底邊的距離）＋邊距
 * - 右：縮放鈕那一排佔掉的寬度（從它的左緣到地圖右緣）＋邊距
 * - 左：只留邊距
 * 量不到（沒掛上、display:none，寬或高是 0）的面板不算。
 */
export function insetsFromRects(
  stage: Rect,
  panels: { top: Array<Rect | null>; bottom: Rect | null; side: Rect | null },
  opts: { overlap?: number; margin?: number } = {},
): Insets {
  const overlap = opts.overlap ?? 50
  const margin = opts.margin ?? 12
  const real = (r: Rect | null): r is Rect => !!r && r.right - r.left > 0 && r.bottom - r.top > 0
  let top = overlap
  for (const r of panels.top) if (real(r)) top = Math.max(top, r.bottom - stage.top)
  const bottom = real(panels.bottom) ? stage.bottom - panels.bottom.top : 0
  const right = real(panels.side) ? stage.right - panels.side.left : 0
  return { top: top + margin, right: right > 0 ? right + margin : margin, bottom: bottom > 0 ? bottom + margin : margin, left: margin }
}
