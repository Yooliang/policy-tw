/**
 * 參選地圖的滾輪縮放（純函式，pages/StatsMap.vue 用）：
 * 以游標為中心縮放；放大到門檻就切到游標下那個行政區的下一層，縮小到最小倍率以下就回上一層。
 * 觸控板的捏合在瀏覽器裡是帶 ctrlKey 的 wheel 事件，走同一條路。
 */

export type Pt = [number, number]

export const ZOOM_MIN = 1
export const ZOOM_MAX = 8
/** 放大到這個倍率、而且游標下有行政區、還有下一層，就切到下一層 */
export const ZOOM_DRILL_AT = 3
/** 切到下一層之後的起始倍率（要低於 ZOOM_DRILL_AT，不然一落地又往下切） */
export const ZOOM_AFTER_DRILL_DOWN = 1.4
/** 縮小回上一層之後，聚焦在剛才那個行政區上的倍率（要低於 ZOOM_DRILL_AT） */
export const ZOOM_AFTER_DRILL_UP = 2.2

/** 一格滾輪（deltaY）換成倍率變化；捏合（ctrlKey）的 deltaY 很小，靈敏度放大 */
export function zoomStep(zoom: number, deltaY: number, ctrlKey = false): number {
  const rate = ctrlKey ? 0.01 : 0.0015
  return zoom * Math.exp(-Math.max(-200, Math.min(200, deltaY)) * rate)
}

/** 檢視中心夾在畫布內（檢視窗是畫布的 1/zoom） */
export function clampCenter(center: Pt, zoom: number, w: number, h: number): Pt {
  const hw = w / zoom / 2
  const hh = h / zoom / 2
  return [Math.min(w - hw, Math.max(hw, center[0])), Math.min(h - hh, Math.max(hh, center[1]))]
}

/** 倍率從 from 變成 to 時，讓游標下那一點（畫布座標）留在螢幕上同一個位置的新中心 */
export function zoomAround(center: Pt, from: number, to: number, point: Pt): Pt {
  const r = from / to
  return [point[0] - (point[0] - center[0]) * r, point[1] - (point[1] - center[1]) * r]
}

export type WheelAction =
  | { type: 'zoom'; zoom: number; center: Pt }
  | { type: 'drillDown' }
  | { type: 'drillUp' }

export interface WheelState {
  zoom: number
  center: Pt
  w: number
  h: number
  /** 現在這層還能往下鑽，而且游標下有行政區 */
  canDrillDown: boolean
  /** 現在不是全國層 */
  canDrillUp: boolean
}

/** 一次滾輪事件該做什麼 */
export function resolveWheel(state: WheelState, deltaY: number, ctrlKey: boolean, point: Pt): WheelAction {
  const raw = zoomStep(state.zoom, deltaY, ctrlKey)
  // 回上一層要先縮到最小倍率、再縮一格才切（不會一格滾輪從放大中直接跳層）
  if (raw < ZOOM_MIN && deltaY > 0 && state.canDrillUp && state.zoom <= ZOOM_MIN + 0.01) return { type: 'drillUp' }
  if (raw >= ZOOM_DRILL_AT && state.canDrillDown) return { type: 'drillDown' }
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw))
  const center = clampCenter(zoomAround(state.center, state.zoom, zoom, point), zoom, state.w, state.h)
  return { type: 'zoom', zoom, center }
}
