import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { isMobileViewport, useMobileShell } from './useMobileShell'
import { isSwipeDragging } from './useSwipeTabs'

/**
 * 手機版（X 式）：往下捲時頁首（含吸頂分頁條）往上滑出、底部分頁列往下滑出，一往回捲就立刻滑回；捲到最頂一定顯示。
 * 只比較捲動方向與累積距離（往下累積超過 8px 才隱藏、往上任何距離就顯示），只切 <html> 上的一個屬性
 * data-chrome-hidden；位移全在 CSS（styles/main.css，translateY，不改版面高度，內容不會跳動）。
 * 抽屜開著、輸入框聚焦、正在左右拖曳分頁時不隱藏。被動 scroll 監聽＋rAF，不讀版面。
 */
const HIDE_AFTER_PX = 8
const ATTR = 'data-chrome-hidden'

export function useScrollHide() {
  const { drawerOpen } = useMobileShell()
  const route = useRoute()
  let lastY = 0
  let down = 0
  let raf = 0
  let hidden = false

  function set(v: boolean) {
    if (v === hidden) return
    hidden = v
    if (v) document.documentElement.setAttribute(ATTR, '')
    else document.documentElement.removeAttribute(ATTR)
  }
  function blocked(): boolean {
    const a = document.activeElement
    const typing = !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')
    return drawerOpen.value || typing || isSwipeDragging()
  }
  function step() {
    raf = 0
    const y = window.scrollY
    const dy = y - lastY
    lastY = y
    if (!isMobileViewport() || y <= 0 || blocked()) { down = 0; set(false); return }
    if (dy > 0) {
      down += dy
      if (down > HIDE_AFTER_PX) set(true)
    } else if (dy < 0) {
      down = 0
      set(false)
    }
  }
  function onScroll() {
    if (!raf) raf = requestAnimationFrame(step)
  }
  onMounted(() => {
    lastY = window.scrollY
    window.addEventListener('scroll', onScroll, { passive: true })
  })
  onBeforeUnmount(() => {
    window.removeEventListener('scroll', onScroll)
    if (raf) cancelAnimationFrame(raf)
    set(false)
  })
  watch(() => route.fullPath, () => { down = 0; set(false); lastY = typeof window !== 'undefined' ? window.scrollY : 0 })
  watch(drawerOpen, (o) => { if (o) set(false) })
}
