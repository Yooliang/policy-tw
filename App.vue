<script setup lang="ts">
import { useHead } from '@unhead/vue'
import Navbar from './components/Navbar.vue'
import Footer from './components/Footer.vue'
import AdSlot from './components/AdSlot.vue'
import MobileTabBar from './components/MobileTabBar.vue'
import DeskRail from './components/DeskRail.vue'
import DeskExtNav from './components/DeskExtNav.vue'
import AdRail from './components/AdRail.vue'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { DESK_LG, DESK_MD, DESK_XL, useDeskLayout, useDeskNav } from './composables/useDeskNav'
import { sectionOfRoute } from './lib/desk-sections'
import { adHiddenPath } from './lib/ad-pages'
import { isMobileViewport, useMobileShell } from './composables/useMobileShell'
import { useScrollHide } from './composables/useScrollHide'
import { inHorizontalScroller } from './composables/useSwipeTabs'

// 手機版（X 式版面）：往右滑拉出左側選單。
// - 從畫面左緣起手：任何地方都行
// - 沒有分頁的頁面：內容區任何地方往右滑（排除輸入框、橫向捲動區、data-no-swipe）
// - 有分頁的區塊（標了 data-swipe-tabs）：「在最左一頁再往右拉」由 useSwipeTabs 處理，這裡讓位
useScrollHide()

// 桌面版（md 以上）外殼：最左窄圖示欄＋延伸欄＋內容＋右側廣告欄；md 以下維持手機版（頂部頁首＋底部分頁列）
const route = useRoute()
const { width } = useDeskLayout()
const { drawerOpen: deskDrawer, closeDeskDrawer } = useDeskNav()
const isDesk = computed(() => width.value >= DESK_MD)
// 右欄：首頁不放，其他頁（包含沒有地區資料的頁，那就只放廣告）都放，排除清單見 lib/ad-pages.ts
const showRail = computed(() => width.value >= DESK_XL && route.path !== '/' && !adHiddenPath(route.path))
// 首頁沒有子項目，延伸欄整欄收起
const hasExt = computed(() => { const s = sectionOfRoute(route.name); return s !== null })
const drawerShown = computed(() => deskDrawer.value && hasExt.value && width.value >= DESK_MD && width.value < DESK_LG)
const { openDrawer } = useMobileShell()
const EDGE_PX = 28
let ex = 0
let ey = 0
let fromEdge = false
let fromBody = false
function onTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  const mobile = e.touches.length === 1 && !!t && isMobileViewport()
  fromEdge = mobile && t!.clientX <= EDGE_PX
  const target = e.target instanceof HTMLElement ? e.target : null
  // 頁面上有分頁滑動區（選舉頁）時，通用的「任何地方往右滑開選單」整個停用：留白處也歸分頁滑動管，開選單只剩左緣與「第一頁再往右拉」
  const tabbedPage = !!document.querySelector('[data-swipe-tabs]')
  fromBody = mobile && !tabbedPage && !fromEdge && !!target && !target.closest('[data-swipe-tabs], [role="dialog"], [data-testid="mobile-drawer"]') && !inHorizontalScroller(target, null)
  if (t) { ex = t.clientX; ey = t.clientY }
}
function onTouchEnd(e: TouchEvent) {
  if (!fromEdge && !fromBody) return
  fromEdge = false
  fromBody = false
  const t = e.changedTouches[0]
  if (!t) return
  const dx = t.clientX - ex
  const dy = t.clientY - ey
  if (dx > 56 && dx > Math.abs(dy) * 1.5) openDrawer()
}
function onKeydown(e: KeyboardEvent) { if (e.key === 'Escape' && deskDrawer.value) closeDeskDrawer() }
onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('touchstart', onTouchStart, { passive: true })
  document.addEventListener('touchend', onTouchEnd, { passive: true })
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('touchstart', onTouchStart)
  document.removeEventListener('touchend', onTouchEnd)
})

// unhead 預設會把 <html lang> 寫成 en，這裡釘回 zh-TW（預渲染的每一頁都吃這個）
useHead({ htmlAttrs: { lang: 'zh-TW' } })
</script>

<template>
  <div class="font-sans md:flex md:min-h-screen">
    <!-- 桌面版最左窄欄與延伸欄（md 以上；延伸欄 lg 以上固定顯示，窄桌面收成抽屜） -->
    <!-- 窄圖示欄永遠在最上層（z-[70]，高於抽屜與背板的 z-[60]），抽屜開著時照樣明亮可點 -->
    <!-- 窄欄與延伸欄改 fixed（inset-y-0，不用 100vh 也不用 sticky）＋同寬佔位：sticky＋h-screen 在頁面底部／小數點縮放（125%、150%）時會被容器邊界推 0.2px，窄欄圖示就跟著上下抖 -->
    <div class="hidden md:block w-[72px] shrink-0" aria-hidden="true"></div>
    <div class="hidden md:block fixed inset-y-0 left-0 z-[70] w-[72px]" data-chrome="rail"><DeskRail /></div>
    <div v-if="hasExt" class="hidden lg:block w-[176px] shrink-0" aria-hidden="true"></div>
    <div v-if="hasExt" class="hidden lg:block fixed inset-y-0 left-[72px] z-30 w-[176px]" data-chrome="ext"><DeskExtNav /></div>
    <!-- 抽屜與背板從圖示欄右側（72px）起，背板只蓋內容區 -->
    <div v-if="drawerShown" class="fixed inset-y-0 left-[72px] right-0 z-[60] hidden md:block lg:hidden" data-testid="desk-drawer">
      <div class="absolute inset-0 bg-black/40" @click="closeDeskDrawer"></div>
      <div class="absolute inset-y-0 left-0 shadow-2xl"><DeskExtNav drawer @close="closeDeskDrawer" /></div>
    </div>

    <div class="flex min-h-screen min-w-0 flex-1 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0 md:pt-12" data-desk-main>
      <Navbar />
      <main class="flex-grow">
        <RouterView v-slot="{ Component }">
          <KeepAlive :include="['ElectionPage']">
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
      </main>
      <!-- 桌面版廣告在右欄；頁尾橫幅只留給手機（桌面不渲染，AdSense 不允許把已渲染的廣告藏起來） -->
      <AdSlot v-if="!isDesk" class="md:hidden" />
      <!-- 頁尾（桌面與手機都只用 CSS 隱藏，預渲染的 HTML 仍在，連結給爬蟲走；連結在左欄與延伸欄／抽屜選單） -->
      <Footer class="hidden" />
      <MobileTabBar />
    </div>
    <!-- 右欄從桌面頁首（h-12，下框線是 box-shadow 不佔高度）下緣開始，跟內容區頂端對齊；頁首桌面版不收合，所以 sticky 的 top 也是頁首高度 -->
    <div v-if="showRail" class="hidden min-[1200px]:flex shrink-0 pt-12"><AdRail /></div>
  </div>
</template>
