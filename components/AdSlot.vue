<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'

/**
 * Footer 上方的 AdSense 橫幅（版位「下方 橫」）。整站只有一個。
 *
 * 幾個刻意的選擇：
 * - 載入器在 index.html 的 <head>，不在這裡：Vue 的 template 不會執行 inline <script>，
 *   原始碼裡那段 (adsbygoogle = window.adsbygoogle || []).push({}) 必須改成 onMounted 呼叫。
 * - 不做「沒填滿就把整塊藏起來」：容器一旦 display:none，AdSense 量到的可用寬度是 0，
 *   廣告永遠不會出現。所以這裡不加背景、不加邊框、不加標籤——沒填滿就是什麼都看不到，
 *   不會留下空殼。
 * - 用 v-if 而不是 v-show：被排除的頁面不該渲染 <ins>。AdSense 不允許把已渲染的廣告藏起來。
 *   切回可顯示的頁面時元件重新掛載、重新 push，拿到的是新的一次請求，這是正確行為。
 * - 後台、登入回呼、AI 助理、個人頁不顯示（那些頁面沒有內容給讀者，也不該有廣告）。
 */
const AD_CLIENT = 'ca-pub-6687848895101003'
const AD_SLOT = '9455802665'
const HIDDEN_PREFIXES = ['/admin', '/auth', '/ai-assistant', '/profile']

const route = useRoute()
const visible = computed(() => !HIDDEN_PREFIXES.some((p) => route.path.startsWith(p)))

/** 對目前 DOM 裡的那個 <ins> 要一次廣告。每個 <ins> 只能對應一次 push。 */
async function requestAd(): Promise<void> {
  if (!visible.value) return
  await nextTick() // 等 <ins> 真的進 DOM，push 之後 AdSense 才找得到它
  try {
    // 載入器是 async 的，可能還沒到；push 進陣列會排隊，等它載完自行處理
    const w = window as unknown as { adsbygoogle?: unknown[] }
    w.adsbygoogle = w.adsbygoogle || []
    w.adsbygoogle.push({})
  } catch (err) {
    // 被阻擋器擋掉是常態，不是錯誤；使用者不需要知道，留給要看的人
    console.info('[ads] adsbygoogle push 沒有成功：', err)
  }
}

onMounted(requestAd)

// v-if 在這個元件的 template 裡，元件自己從頭到尾只掛載一次——所以走過
// /profile 這種排除頁再回來時，<ins> 是新的、但 onMounted 不會再跑，那個版位
// 在這次 session 裡就再也不會有廣告。實測抓到：切回來後 push 次數還是 1。
// 由隱藏轉可見時補一次 push，對應的正是那個新的 <ins>。
watch(visible, (now, was) => {
  if (now && !was) requestAd()
})
</script>

<template>
  <!-- overflow-hidden 是手機版的保險：data-full-width-responsive 的版位量錯寬度時
       會把整頁撐出去，這個站踩過一次橫向溢出 -->
  <div v-if="visible" class="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4 overflow-hidden">
    <ins
      class="adsbygoogle"
      style="display: block"
      :data-ad-client="AD_CLIENT"
      :data-ad-slot="AD_SLOT"
      data-ad-format="auto"
      data-full-width-responsive="true"
    ></ins>
  </div>
</template>
