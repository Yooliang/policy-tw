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
// 右欄整欄 200px 寬（2026-10-31 小良哥）：視窗夠高（≥760px，扣掉頁首與資料卡後放得下）用 200x600，較矮用 200x400，讓它不出捲軸也能 sticky
const SLOT_TALL = '4555838935' // 200x600
const SLOT_SHORT = '6738102968' // 200x400
const TALL_MIN_VIEWPORT = 760
const tall = typeof window === 'undefined' || window.innerHeight >= TALL_MIN_VIEWPORT
const RAIL_AD_SLOT = tall ? SLOT_TALL : SLOT_SHORT
const AD_HEIGHT = tall ? 600 : 400

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
  <aside v-if="visible" :key="route.path" ref="root" class="w-[213px] shrink-0 border-l border-slate-200 pb-4 pl-3 pt-0" aria-label="廣告" data-testid="ad-rail">
    <!-- 地區資料統計卡的落點（選舉頁 Teleport 進來；沒有就是空的、不佔位） -->
    <div id="desk-rail-top" class="mb-4 empty:hidden"></div>
    <!-- 只有廣告 sticky（卡片隨頁捲動）；視窗高度不夠放 600px 廣告時不 sticky，右欄不出現自己的捲軸 -->
    <div :style="{ height: AD_HEIGHT + 'px' }" class="w-[200px] overflow-hidden rounded-xl sticky top-[calc(3rem+1rem)]">
    <ins
      v-if="RAIL_AD_SLOT"
      class="adsbygoogle"
      :style="`display: inline-block; width: 200px; height: ${AD_HEIGHT}px`"
      :data-ad-client="AD_CLIENT"
      :data-ad-slot="RAIL_AD_SLOT"
    ></ins>
    <div v-else :style="{ height: AD_HEIGHT + 'px' }" class="flex w-full items-center justify-center rounded-xl border border-dashed border-slate-300 text-xs text-slate-400" data-testid="ad-rail-placeholder">廣告位 200 × {{ AD_HEIGHT }}</div>
    </div>
  </aside>
</template>
