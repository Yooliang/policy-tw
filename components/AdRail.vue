<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { pushAd } from '../lib/ad-request'
import { whenContentReady } from '../lib/ad-ready'
import { AD_CLIENT, adHiddenPath } from '../lib/ad-pages'

/**
 * 桌面版右欄的直式廣告位（xl 以上，寬 300px，sticky 置頂；由 App.vue 依視窗寬度決定要不要渲染）。
 * 做法跟頁尾橫幅 AdSlot 一樣：載入器在 index.html 的 <head>、onMounted 才 push、換頁（route.path）換一個新的 <ins> 重新要、排除頁不渲染。
 *
 * RAIL_AD_SLOT：直式 300x600 版位。空字串時畫一個佔位框（看得到位置與尺寸），不借頁尾橫幅的版位。
 */
const RAIL_AD_SLOT = '8052230819' // 直式 300x600（2026-10-31 小良哥提供）

const route = useRoute()
const visible = computed(() => !adHiddenPath(route.path))
const root = ref<HTMLElement | null>(null)
let ticket = 0

async function requestAd(): Promise<void> {
  const mine = ++ticket
  if (!visible.value || !RAIL_AD_SLOT) return
  await nextTick()
  const ready = await whenContentReady(document.querySelector('main'), { cancelled: () => mine !== ticket })
  if (!ready || mine !== ticket) return
  try {
    const w = window as unknown as { adsbygoogle?: unknown[] }
    w.adsbygoogle = w.adsbygoogle || []
    pushAd(root.value?.querySelector('ins.adsbygoogle'), w.adsbygoogle)
  } catch (err) {
    console.info('[ads] adsbygoogle push 沒有成功：', err)
  }
}
onMounted(requestAd)
onBeforeUnmount(() => { ticket++ })
watch(() => route.path, (now, was) => { if (now !== was) requestAd() })
</script>

<template>
  <aside v-if="visible" :key="route.path" ref="root" class="w-[300px] shrink-0 self-start sticky top-0 h-screen overflow-hidden px-0 py-4" aria-label="廣告" data-testid="ad-rail">
    <ins
      v-if="RAIL_AD_SLOT"
      class="adsbygoogle"
      style="display: inline-block; width: 300px; height: 600px"
      :data-ad-client="AD_CLIENT"
      :data-ad-slot="RAIL_AD_SLOT"
    ></ins>
    <div v-else class="flex h-[600px] max-h-full w-full items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-400" data-testid="ad-rail-placeholder">廣告位 300 × 600</div>
  </aside>
</template>
