import { ref } from 'vue'

/**
 * 手機版外殼（X 式版面，md 以下）的共用狀態：左側抽屜選單開不開。
 * 模組級 ref，頁首的選單鈕、抽屜、邊緣滑動、分頁區「在最左一頁再往右拉」都讀寫同一份。
 */
const drawerOpen = ref(false)

export function useMobileShell() {
  return {
    drawerOpen,
    openDrawer: () => { drawerOpen.value = true },
    closeDrawer: () => { drawerOpen.value = false },
  }
}

/** 手機版斷點（跟 Tailwind 的 md 一致：768px 以下是手機版面） */
export const MOBILE_QUERY = '(max-width: 767.98px)'
export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches
}
