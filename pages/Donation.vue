<script setup lang="ts">
import { ref } from 'vue'
import Hero from '../components/Hero.vue'
import { Copy, Check, Heart, ChevronDown } from 'lucide-vue-next'
import { usePageHead } from '../composables/usePageHead'

// 贊助走 Ko-fi。刻意用連結而不是嵌入 Ko-fi 的 Widget：這站是預渲染的靜態頁，
// 多一支第三方腳本會拖慢載入，而且先前 AdSense 的外部資源已經害過一次。
// 換 Ko-fi 帳號只要改這一行。
const KOFI_URL = 'https://ko-fi.com/cwen0708'

const copied = ref<string | null>(null)
const showAllCrypto = ref(false)
const cryptoWallets = [
  { name: 'Bitcoin', symbol: 'BTC', address: 'bc1q9umjtz04dfslddw4eryw5mn8hk4ld7csml40pk' },
  { name: 'Ethereum (ERC20)', symbol: 'ETH', address: '0xcd28639ce0395E9f8048AAf2F52da0624880a772' },
  { name: 'USDT (TRC20)', symbol: 'TRC20', address: 'TUfyufkfRiUFxWnZ5BURKqUWWZHRThvNHt' },
  { name: 'USDT (BEP20)', symbol: 'BEP20', address: '0xcd28639ce0395E9f8048AAf2F52da0624880a772' },
  { name: 'USDT (Solana)', symbol: 'SOL', address: 'Fm5gcJ4V79VjSo3EmFqeyeeTkgUKgT6HWUS9J1cGyLEq' },
]


const handleCopy = (address: string, symbol: string) => {
  navigator.clipboard.writeText(address)
  copied.value = symbol
  setTimeout(() => { copied.value = null }, 2000)
}





usePageHead({
  title: '贊助平台',
  description: '正見由公民贊助維運。查證由各方 AI 代理自備算力完成，捐款用於網站與資料庫。',
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>支持正見</template>
      <template #description>
        我們是不接受任何政黨資金的獨立開源專案。<br/>政見查證由各方 AI 代理自備算力完成，您的每一筆捐款用於網站與資料庫的維運。
      </template>
      <template #icon><Heart :size="400" class="text-red-500" /></template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <!-- 原本左欄是 AI 服務使用統計、右欄是贊助方式；2026-09-16 拿掉統計之後
           左欄只剩一段話，八比四的版面會空一大片，所以改成上下：說明一整條，贊助方式並排 -->
      <div class="space-y-8">
        <div class="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-6 flex items-center gap-4 shadow-lg">
          <Heart :size="32" class="text-red-500 shrink-0" />
          <p class="text-lg text-slate-700">
            您的捐款讓這些查證結果持續公開：網站、資料庫與查核紀錄都留在線上，任何人都查得到、也改得動。
          </p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          <!-- General Donation -->
          <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-lg hover:shadow-xl transition-shadow text-left">
            <h3 class="text-lg font-bold text-navy-900 mb-4 flex items-center gap-2">
              <img src="/kofi-cup.png" alt="" class="w-6 h-6" />請我們喝杯咖啡
            </h3>
            <a
              :href="KOFI_URL"
              target="_blank"
              rel="noopener"
              class="w-full bg-[#FF5E5B] hover:bg-[#e85450] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-colors"
            >
              <img src="/kofi-cup.png" alt="" class="w-6 h-6" />到 Ko-fi 贊助
            </a>
            <p class="text-xs text-slate-400 mt-3 leading-relaxed">
              支援信用卡與 PayPal，可以只贊助一次，也可以每月固定支持。金額由你決定。
            </p>
          </div>

          <!-- Crypto Donation -->
          <div class="bg-navy-900 p-6 rounded-2xl shadow-lg border border-navy-700 text-white text-left">
            <h3 class="text-lg font-bold mb-4 flex items-center gap-2">
              <span class="text-amber-400">₿</span>加密貨幣捐款
            </h3>
            <div class="space-y-2">
              <template v-for="(wallet, index) in cryptoWallets" :key="wallet.symbol">
                <div
                  v-if="index < 2 || showAllCrypto"
                  class="bg-navy-800 p-2.5 rounded-lg border border-navy-700"
                >
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-medium text-slate-300 w-24 shrink-0">{{ wallet.name }}</span>
                    <div class="flex-1 flex items-center gap-1.5 bg-navy-950 px-2 py-1 rounded border border-navy-800 min-w-0">
                      <code class="text-[10px] text-slate-400 truncate font-mono flex-1">{{ wallet.address }}</code>
                      <button @click="handleCopy(wallet.address, wallet.symbol)" class="p-0.5 hover:text-white text-slate-500 transition-colors shrink-0">
                        <Check v-if="copied === wallet.symbol" :size="12" class="text-emerald-500" />
                        <Copy v-else :size="12" />
                      </button>
                    </div>
                  </div>
                </div>
              </template>
              <!-- Expand/Collapse button -->
              <button
                v-if="cryptoWallets.length > 2"
                @click="showAllCrypto = !showAllCrypto"
                class="w-full py-2 text-xs text-slate-400 hover:text-slate-200 flex items-center justify-center gap-1 transition-colors"
              >
                <span>{{ showAllCrypto ? '收合' : `顯示更多 (${cryptoWallets.length - 2})` }}</span>
                <ChevronDown :size="14" :class="{ 'rotate-180': showAllCrypto }" class="transition-transform" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
