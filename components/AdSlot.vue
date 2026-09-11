<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 整站唯一的贊助內容卡位（Monetag 300x250）。
 * - 用 v-show 不用 v-if：Monetag 的 iframe 只建立一次，元素被銷毀廣告就沒了。
 * - 類名／id 刻意不含 ad、sponsor 等字，否則會被瀏覽器廣告阻擋器的外觀過濾規則整塊藏掉。
 * - 標籤放在容器內：容器被藏時標籤一起消失，不會留下空標題。
 * - 後台、登入回呼、AI 助理、個人頁不顯示。
 */
const route = useRoute()
const HIDDEN_PREFIXES = ['/admin', '/auth', '/ai-assistant', '/profile']
const visible = computed(() => !HIDDEN_PREFIXES.some((p) => route.path.startsWith(p)))
</script>

<template>
  <section v-show="visible" class="border-t border-slate-200 bg-slate-100/70">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex justify-center">
      <div id="pt-tail-box" class="pt-tail">
        <span class="pt-tail__label text-[11px] tracking-widest uppercase text-slate-400">Sponsored · 贊助內容</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Monetag 會把它的 wrap（含 300x250 iframe）appendChild 進 #pt-tail-box，排在標籤之後 */
.pt-tail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}
.pt-tail:has(> .pt-tail__label:only-child) {
  /* 尚未載入或被阻擋：只剩標籤時整個藏起來，不留空白卡 */
  display: none;
}
.pt-tail :deep(iframe) {
  display: block;
  border-radius: 0.5rem;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}
</style>
