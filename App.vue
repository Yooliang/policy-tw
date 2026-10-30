<script setup lang="ts">
import { useHead } from '@unhead/vue'
import Navbar from './components/Navbar.vue'
import Footer from './components/Footer.vue'
import AdSlot from './components/AdSlot.vue'
import MobileTabBar from './components/MobileTabBar.vue'
import { onBeforeUnmount, onMounted } from 'vue'
import { isMobileViewport, useMobileShell } from './composables/useMobileShell'

// 手機版（X 式版面）：從畫面左緣往右滑拉出左側選單。分頁區「在最左一頁再往右拉」另由 useSwipeTabs 處理。
const { openDrawer } = useMobileShell()
const EDGE_PX = 28
let ex = 0
let ey = 0
let fromEdge = false
function onTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  fromEdge = e.touches.length === 1 && !!t && t.clientX <= EDGE_PX && isMobileViewport()
  if (t) { ex = t.clientX; ey = t.clientY }
}
function onTouchEnd(e: TouchEvent) {
  if (!fromEdge) return
  fromEdge = false
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

