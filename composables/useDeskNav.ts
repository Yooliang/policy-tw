import { onBeforeUnmount, onMounted, ref, shallowRef, type ComputedRef } from 'vue'

/**
 * 桌面版外殼（md 以上）的共用狀態：
 * - 選舉頁把自己的「延伸欄篩選模型」登記進來（內容類型／層級／地區），延伸欄讀這份模型來畫、點了就呼叫選舉頁自己的函式——
 *   所以桌面與手機共用同一組狀態與網址，延伸欄不另寫邏輯。
 * - 延伸欄在窄桌面（< lg）收成抽屜，開關在這裡。
 * - 視窗寬度旗標：只在瀏覽器掛載後才有值（預渲染與第一次 hydrate 都是 false），要在畫面上做差異的地方用 CSS 斷點，只有「要不要渲染廣告」這類需要 JS 的才讀旗標。
 */
export interface DeskItem {
  key: string
  label: string
  active: boolean
  /** 有 to 就是連結（預渲染也走得到）；沒有就是按鈕，點了呼叫 select */
  to?: string
  select?: () => void
}
export interface DeskGroup {
  key: string
  title: string
  /** 同一組內再分塊（內容類型：候選人｜承諾｜PK ‖ 串聯｜矩陣），塊與塊之間畫分隔線 */
  blocks: DeskItem[][]
  /** 清單很長時可捲動 */
  scroll?: boolean
}
export interface DeskNavModel {
  title: string
  groups: DeskGroup[]
}

const electionNav = shallowRef<ComputedRef<DeskNavModel> | null>(null)
const drawerOpen = ref(false)
const width = ref(0)

export function useDeskNav() {
  return {
    electionNav,
    setElectionNav: (m: ComputedRef<DeskNavModel> | null) => { electionNav.value = m },
    drawerOpen,
    openDeskDrawer: () => { drawerOpen.value = true },
    closeDeskDrawer: () => { drawerOpen.value = false },
  }
}

let listeners = 0
function onResize() { width.value = window.innerWidth }
/** 視窗寬度旗標（掛載後才有值）：isDesktop＝md 以上、showAdRail＝xl 以上（1280px） */
export function useDeskLayout() {
  onMounted(() => {
    onResize()
    if (listeners++ === 0) window.addEventListener('resize', onResize, { passive: true })
  })
  onBeforeUnmount(() => {
    if (--listeners === 0 && typeof window !== 'undefined') window.removeEventListener('resize', onResize)
  })
  return { width }
}
export const DESK_MD = 768
export const DESK_LG = 1024
export const DESK_XL = 1280
