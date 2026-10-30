import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'
import { isMobileViewport } from './useMobileShell'

/**
 * 內容區左右滑動切換分頁（手機版，輕量觸控手勢，不用套件）。
 *
 * - 往左滑＝下一頁，往右滑＝上一頁；在第一頁再往右滑呼叫 onPastStart（外殼用它拉出左側選單）。
 * - 只認「橫向為主」的滑動；從輸入框、橫向可捲動的區塊（表格、晶片列）、標記 data-no-swipe 的地方起手不算。
 * - 桌面（md 以上）不啟用。
 *
 * 跟手與吸附（2026-10-30，小良哥：「沒有特效、非常卡頓」）：
 * - 拖曳中只改內容區的 transform（translate3d，rAF 內寫入、touchmove 內不讀版面、不碰 Vue 響應式），內容跟著手指即時移動；
 *   分頁條的底線透過 swipeStrips 登記的控制器跟著拖曳進度移動。
 * - 放開後用約 250ms 的動畫吸附到下一頁（滑出）或彈回；「動畫結束後」才呼叫 go（切分頁狀態、改網址、載入／渲染新資料），
 *   滑動中不發請求、不改 router、不重渲染清單。
 * - prefers-reduced-motion：不跟手、不動畫，達門檻直接切換。
 */
export interface SwipeTabsOptions {
  /** 目前在第幾頁（從 0 起算） */
  index: () => number
  /** 一共幾頁 */
  count: () => number
  /** 切到第幾頁 */
  go: (i: number) => void
  /** 在第一頁再往右滑 */
  onPastStart?: () => void
}

const MIN_DX = 56
const DOMINANCE = 1.6
const LOCK_PX = 8
const SETTLE_MS = 250
const COMMIT_RATIO = 0.25
const FLICK_PX_PER_MS = 0.45
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** 分頁條提供給手勢用的控制器（底線跟著拖曳進度）；pos 是「小數頁號」：0＝第一頁、1.5＝第二與第三頁正中 */
export interface SwipeStripController {
  prepare: () => void
  update: (pos: number, animated?: boolean) => void
}
/**
 * 拖曳時左右相鄰分頁要看得到（已渲染的內容）：分頁面板平時用 v-show 藏起來，拖曳中外層（group/sw）帶 data-swiping，
 * 相鄰那一頁用這組 class 被強制顯示、絕對定位在左右一個螢幕寬的位置，跟著內容區一起被手指拖出來；其餘分頁維持隱藏。
 * offset：1＝下一頁（在右邊）、-1＝上一頁（在左邊），其他＝不是相鄰頁、不加 class。
 */
const ADJ_BASE = 'group-data-[swiping]/sw:!block group-data-[swiping]/sw:!absolute group-data-[swiping]/sw:top-0 group-data-[swiping]/sw:w-full'
export function adjacentPanelClass(offset: number): string {
  if (offset === 1) return ADJ_BASE + ' group-data-[swiping]/sw:left-[100vw]'
  if (offset === -1) return ADJ_BASE + ' group-data-[swiping]/sw:left-[-100vw]'
  return ''
}
export const swipeStrips = new WeakMap<HTMLElement, SwipeStripController>()
const STRIP_SELECTOR = '[data-testid="swipe-tab-strip"]'

export function inHorizontalScroller(target: EventTarget | null, root: HTMLElement | null): boolean {
  let el = target instanceof HTMLElement ? target : null
  while (el && el !== root) {
    if (el.hasAttribute('data-no-swipe')) return true
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
    el = el.parentElement
  }
  return false
}

/** 正在左右拖曳分頁（捲動隱藏頁首的邏輯要讓位） */
let dragging = false
export const isSwipeDragging = () => dragging

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function useSwipeTabs(el: Ref<HTMLElement | null>, opts: SwipeTabsOptions) {
  let sx = 0, sy = 0, st = 0
  let blocked = true
  let mode: 'idle' | 'pending' | 'drag' = 'idle'
  let settling = false
  let bound: HTMLElement | null = null
  // 拖曳狀態（touchmove 只更新這幾個數字，真正寫入在 rAF）
  let dx = 0, lastX = 0, lastY = 0, lastT = 0, vx = 0
  let idx = 0, total = 0, width = 360
  let raf = 0
  let strip: SwipeStripController | undefined

  function paint() {
    raf = 0
    if (!bound) return
    bound.style.transform = `translate3d(${dx}px,0,0)`
    strip?.update(idx - dx / width)
  }

  function begin(node: HTMLElement) {
    idx = opts.index()
    total = opts.count()
    width = Math.max(1, window.innerWidth)
    const stripEl = document.querySelector<HTMLElement>(STRIP_SELECTOR)
    strip = stripEl ? swipeStrips.get(stripEl) : undefined
    strip?.prepare()
    dragging = true
    node.setAttribute('data-swiping', '')
    node.style.willChange = 'transform'
    document.documentElement.style.overflowX = 'clip'
  }
  function finish(node: HTMLElement) {
    node.style.transform = ''
    node.style.willChange = ''
    node.removeAttribute('data-swiping')
    document.documentElement.style.overflowX = ''
    dragging = false
    mode = 'idle'
    dx = 0
  }

  /** dir：1＝下一頁（內容往左滑出）、-1＝上一頁、0＝彈回 */
  function settle(node: HTMLElement, dir: 1 | -1 | 0) {
    const to = dir === 0 ? 0 : -dir * width
    settling = true
    const done = () => {
      finish(node)
      if (dir === 0) { settling = false; return }
      opts.go(idx + dir) // 動畫結束後才切換分頁狀態（改網址）；各分頁內容已各自掛載保留，切過去不重畫、不閃空白
      void nextTick().then(() => {
        settling = false
      })
    }
    strip?.update(idx + dir, true)
    if (typeof node.animate !== 'function') { done(); return }
    const anim = node.animate(
      [{ transform: `translate3d(${dx}px,0,0)` }, { transform: `translate3d(${to}px,0,0)` }],
      { duration: dir === 0 ? 200 : SETTLE_MS, easing: EASE, fill: 'forwards' },
    )
    anim.onfinish = () => { anim.cancel(); done() }
  }

  function onStart(e: TouchEvent) {
    blocked = settling || e.touches.length !== 1 || !isMobileViewport() || !bound || inHorizontalScroller(e.target, bound)
    mode = blocked ? 'idle' : 'pending'
    const t = e.touches[0]
    if (t) { sx = t.clientX; sy = t.clientY; st = Date.now(); lastX = sx; lastT = st; vx = 0; dx = 0 }
  }
  function onMove(e: TouchEvent) {
    if (blocked || !bound) return
    const t = e.touches[0]
    if (!t) return
    const mx = t.clientX - sx, my = t.clientY - sy
    if (mode === 'pending') {
      if (Math.abs(mx) < LOCK_PX && Math.abs(my) < LOCK_PX) return
      if (Math.abs(mx) <= Math.abs(my) * 1.2) { blocked = true; mode = 'idle'; return } // 直向為主：交給瀏覽器捲動
      mode = 'drag'
      if (!reducedMotion()) begin(bound)
    }
    if (mode !== 'drag') return
    const now = Date.now()
    const dt = now - lastT
    if (dt > 0) vx = 0.6 * vx + 0.4 * ((t.clientX - lastX) / dt)
    lastX = t.clientX
    lastY = t.clientY
    lastT = now
    if (reducedMotion()) return
    // 兩端沒有下一頁：內容不動（第一頁右拉＝開左側選單，放開時判斷）
    const allowed = mx < 0 ? idx < total - 1 : idx > 0
    dx = allowed ? Math.max(-width, Math.min(width, mx)) : 0
    if (!raf) raf = requestAnimationFrame(paint)
  }
  function onEnd(e: TouchEvent) {
    if (blocked) return
    blocked = true
    if (mode !== 'drag') { mode = 'idle'; return }
    const t = e.changedTouches[0]
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    const node = bound
    const calm = reducedMotion()
    const mx = (t ? t.clientX : lastX) - sx, my = (t ? t.clientY : lastY) - sy
    const i = opts.index(), n = opts.count()
    const w = Math.max(1, window.innerWidth)
    const fast = Math.abs(vx) > FLICK_PX_PER_MS && Math.abs(mx) >= 24
    const far = Math.abs(mx) >= Math.max(MIN_DX, w * COMMIT_RATIO)
    const horizontal = Math.abs(mx) >= Math.abs(my) * DOMINANCE
    const want = horizontal && (far || fast) && Date.now() - st < 4000 ? (mx < 0 ? 1 : -1) : 0
    if (want === 1 && i < n - 1) {
      if (calm || !node) { mode = 'idle'; opts.go(i + 1) } else settle(node, 1)
    } else if (want === -1 && i > 0) {
      if (calm || !node) { mode = 'idle'; opts.go(i - 1) } else settle(node, -1)
    } else if (want === -1 && i === 0) {
      if (node && !calm) finish(node)
      mode = 'idle'
      opts.onPastStart?.()
    } else if (node && !calm) {
      settle(node, 0)
    } else {
      mode = 'idle'
    }
  }
  function onCancel() {
    blocked = true
    if (mode === 'drag' && bound && !reducedMotion()) {
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      settle(bound, 0)
    } else mode = 'idle'
  }

  function unbind() {
    if (!bound) return
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    bound.removeAttribute('data-swipe-tabs')
    bound.style.touchAction = ''
    bound.removeEventListener('touchstart', onStart)
    bound.removeEventListener('touchmove', onMove)
    bound.removeEventListener('touchend', onEnd)
    bound.removeEventListener('touchcancel', onCancel)
    if (mode === 'drag') finish(bound)
    bound = null
  }
  watch(el, (node) => {
    unbind()
    if (!node) return
    bound = node
    node.setAttribute('data-swipe-tabs', '') // 外殼（App.vue）的全頁右滑開選單看到這個標記就讓位
    node.style.touchAction = 'pan-y' // 橫向的拖曳全交給手勢，直向照常捲動
    node.addEventListener('touchstart', onStart, { passive: true })
    node.addEventListener('touchmove', onMove, { passive: true })
    node.addEventListener('touchend', onEnd, { passive: true })
    node.addEventListener('touchcancel', onCancel, { passive: true })
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(unbind)
}
