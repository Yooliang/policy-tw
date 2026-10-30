<script setup lang="ts">
import { useHead } from '@unhead/vue'
import Navbar from './components/Navbar.vue'
import Footer from './components/Footer.vue'
import AdSlot from './components/AdSlot.vue'
import MobileTabBar from './components/MobileTabBar.vue'
import { onBeforeUnmount, onMounted } from 'vue'
import { isMobileViewport, useMobileShell } from './composables/useMobileShell'
import { useScrollHide } from './composables/useScrollHide'
import { inHorizontalScroller } from './composables/useSwipeTabs'

// 手機版（X 式版面）：往右滑拉出左側選單。
// - 從畫面左緣起手：任何地方都行
// - 沒有分頁的頁面：內容區任何地方往右滑（排除輸入框、橫向捲動區、data-no-swipe）
// - 有分頁的區塊（標了 data-swipe-tabs）：「在最左一頁再往右拉」由 useSwipeTabs 處理，這裡讓位
useScrollHide()
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
  fromBody = mobile && !fromEdge && !!target && !target.closest('[data-swipe-tabs], [role="dialog"], [data-testid="mobile-drawer"]') && !inHorizontalScroller(target, null)
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
onMounted(() => {
  document.addEventListener('touchstart', onTouchStart, { passive: true })
  document.addEventListener('touchend', onTouchEnd, { passive: true })
})
onBeforeUnmount(() => {
  document.removeEventListener('touchstart', onTouchStart)
  document.removeEventListener('touchend', onTouchEnd)
})

// unhead 預設會把 <html lang> 寫成 en，這裡釘回 zh-TW（預渲染的每一頁都吃這個）
useHead({ htmlAttrs: { lang: 'zh-TW' } })
</script>

<template>
  <div class="flex flex-col min-h-screen font-sans pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
    <Navbar />
    <main class="flex-grow">
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="['ElectionPage']">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
    <AdSlot />
    <Footer />
    <MobileTabBar />
  </div>
</template>

