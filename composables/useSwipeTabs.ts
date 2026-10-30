import { onBeforeUnmount, watch, type Ref } from 'vue'
import { isMobileViewport } from './useMobileShell'

/**
 * 內容區左右滑動切換分頁（手機版，輕量觸控手勢，不用套件）。
 *
 * - 往左滑＝下一頁，往右滑＝上一頁；在第一頁再往右滑呼叫 onPastStart（外殼用它拉出左側選單）。
 * - 只認「橫向為主」的滑動；從輸入框、橫向可捲動的區塊（表格、晶片列）、標記 data-no-swipe 的地方起手不算。
 * - 桌面（md 以上）不啟用；換頁時有一個短的滑入動畫，prefers-reduced-motion 時不做。
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
const MAX_MS = 900

function inHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
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

export function useSwipeTabs(el: Ref<HTMLElement | null>, opts: SwipeTabsOptions) {
  let sx = 0, sy = 0, st = 0, blocked = true
  let bound: HTMLElement | null = null

  function slideIn(from: 1 | -1) {
    const node = bound
    if (!node || typeof node.animate !== 'function') return
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    node.animate([{ transform: `translateX(${from * 28}px)`, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: 'ease-out' })
  }

  function onStart(e: TouchEvent) {
    blocked = e.touches.length !== 1 || !isMobileViewport() || !bound || inHorizontalScroller(e.target, bound)
    const t = e.touches[0]
    if (t) { sx = t.clientX; sy = t.clientY; st = Date.now() }
  }
  function onEnd(e: TouchEvent) {
    if (blocked) return
    blocked = true
    const t = e.changedTouches[0]
    if (!t) return
    const dx = t.clientX - sx, dy = t.clientY - sy
    if (Date.now() - st > MAX_MS || Math.abs(dx) < MIN_DX || Math.abs(dx) < Math.abs(dy) * DOMINANCE) return
    const i = opts.index(), n = opts.count()
    if (dx < 0) {
      if (i < n - 1) { opts.go(i + 1); slideIn(1) }
    } else if (i > 0) {
      opts.go(i - 1); slideIn(-1)
    } else {
      opts.onPastStart?.()
    }
  }

  function unbind() {
    if (!bound) return
    bound.removeEventListener('touchstart', onStart)
    bound.removeEventListener('touchend', onEnd)
    bound = null
  }
  watch(el, (node) => {
    unbind()
    if (!node) return
    bound = node
    node.addEventListener('touchstart', onStart, { passive: true })
    node.addEventListener('touchend', onEnd, { passive: true })
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(unbind)
}
