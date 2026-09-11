<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 整站唯一的廣告卡位。用 v-show 而不是 v-if：Monetag 的 iframe 只會建立一次，
 * 元素若被銷毀廣告就沒了。後台、登入回呼、AI 助理頁不顯示。
 */
const route = useRoute()
const HIDDEN_PREFIXES = ['/admin', '/auth', '/ai-assistant', '/profile']
const visible = computed(() => !HIDDEN_PREFIXES.some((p) => route.path.startsWith(p)))
</script>

<template>
  <section v-show="visible" class="border-t border-slate-200 bg-slate-100/70" aria-label="贊助內容">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col items-center gap-2">
      <span class="text-[11px] tracking-widest uppercase text-slate-400">Sponsored · 贊助內容</span>
      <div id="monetag-slot" class="ad-slot"></div>
    </div>
  </section>
</template>

<style scoped>
/* 預留 300x250，廣告載入前後版面不跳動；Monetag 的 wrap 會被塞進來 */
.ad-slot {
  min-height: 250px;
  min-width: 300px;
  display: flex;
  justify-content: center;
  align-items: center;
}
.ad-slot :deep(iframe) {
  display: block;
  border-radius: 0.5rem;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}
</style>
