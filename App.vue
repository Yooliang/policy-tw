<script setup lang="ts">
import Navbar from './components/Navbar.vue'
import Footer from './components/Footer.vue'
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
    <Footer />
  </div>
</template>

