<script setup lang="ts">
import { useHead } from '@unhead/vue'
import Navbar from './components/Navbar.vue'
import Footer from './components/Footer.vue'
import AdSlot from './components/AdSlot.vue'

// unhead 預設會把 <html lang> 寫成 en，這裡釘回 zh-TW（預渲染的每一頁都吃這個）
useHead({ htmlAttrs: { lang: 'zh-TW' } })
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

