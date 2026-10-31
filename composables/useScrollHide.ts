import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { isMobileViewport, useMobileShell } from './useMobileShell'
import { isSwipeChromeLocked } from './useSwipeTabs'

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
    return drawerOpen.value || typing || isSwipeChromeLocked()
  }
  /** 縮小標題區（[data-testid="mobile-hero"]）還有一部分在畫面內時不收合，避免頁首原本佔的位置露出空白；沒有標題區的頁面不受影響 */
  function heroStillVisible(): boolean {
    const h = document.querySelector('[data-testid="mobile-hero"]')
    return !!h && h.getBoundingClientRect().bottom > 0
  }
  /** 吸頂分頁條（[data-chrome-follow]）還沒吸到頁首下緣（top > 頁首高度 3.5rem＝56px）時不收合：
   *  收合是 translateY 位移，還在文流位置的分頁條會往上滑進上方的內容（人物頁的麵包屑卡片）蓋住它；吸住之後位移才是從頁首下方滑出畫面 */
  function followNotPinned(): boolean {
    const f = document.querySelector('[data-chrome-follow]')
    return !!f && f.getBoundingClientRect().top > 57
  }
  function step() {
    raf = 0
    const y = window.scrollY
    const dy = y - lastY
    lastY = y
    // 拖曳分頁中或切換後 400ms 內：頁面高度變化、捲動位置重設造成的 scroll 不算使用者往下捲，一律顯示並同步基準
    if (!isMobileViewport() || y <= 0 || blocked()) { down = 0; set(false); return }
    if (dy > 0) {
      if (heroStillVisible() || (!hidden && followNotPinned())) { down = 0; return }
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
