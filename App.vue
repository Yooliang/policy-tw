<script setup lang="ts">
import { onMounted } from 'vue'
import { useHead } from '@unhead/vue'
import Navbar from './components/Navbar.vue'
import Footer from './components/Footer.vue'
import AdSlot from './components/AdSlot.vue'
import { loadMonetag } from './lib/ads'

// unhead 預設會把 <html lang> 寫成 en，這裡釘回 zh-TW（預渲染的每一頁都吃這個）
useHead({ htmlAttrs: { lang: 'zh-TW' } })

// 廣告容器（AdSlot）隨整棵樹掛好後才載入 Monetag，才會放進容器而不是 footer 下方；只在瀏覽器執行。
onMounted(() => loadMonetag())
</script>

<template>
  <div class="flex flex-col min-h-screen font-sans">
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
  </div>
</template>

