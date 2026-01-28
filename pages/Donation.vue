<script setup lang="ts">
import { ref } from 'vue'
import Hero from '../components/Hero.vue'
import { CreditCard, Copy, Check, Heart } from 'lucide-vue-next'

const copied = ref<string | null>(null)
const cryptoWallets = [
  { name: 'Bitcoin', symbol: 'BTC', address: '3FZbgi29cpjq2GjdwV8eyHuJJnkLtktZc5' },
  { name: 'Ethereum', symbol: 'ETH', address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F' },
  { name: 'USDT (TRC20)', symbol: 'USDT', address: 'T9yD14Nj9j7xAB4dbGeiX9h8zzC52CCD5' },
]

const handleCopy = (address: string, symbol: string) => {
  navigator.clipboard.writeText(address)
  copied.value = symbol
  setTimeout(() => { copied.value = null }, 2000)
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>支持正見</template>
      <template #description>
        我們是不接受任何政黨資金的獨立開源專案。<br/>您的每一筆捐款，都將用於伺服器維護、AI API 成本以及推動數據透明化。
      </template>
      <template #icon><Heart :size="400" class="text-red-500" /></template>
    </Hero>

    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
        <div class="bg-white p-8 rounded-2xl border border-slate-200 shadow-lg hover:shadow-xl transition-shadow text-left">
          <h3 class="text-xl font-bold text-navy-900 mb-6 flex items-center gap-2"><CreditCard class="text-blue-600" />一般捐款</h3>
          <div class="space-y-4">
            <button class="w-full bg-[#00c300] hover:bg-[#00b300] text-white font-bold py-4 rounded-xl flex items-center justify-center gap-3 transition-colors"><span class="font-bold text-xl">LINE Pay</span><span class="text-sm opacity-90">單次 / 定期定額</span></button>
            <button class="w-full bg-navy-800 hover:bg-navy-700 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-3 transition-colors"><span>信用卡 (VISA / Master)</span></button>
          </div>
        </div>
        <div class="bg-navy-900 p-8 rounded-2xl shadow-lg border border-navy-700 text-white text-left">
          <h3 class="text-xl font-bold mb-6 flex items-center gap-2"><span class="text-amber-400">₿</span>加密貨幣捐款</h3>
          <div class="space-y-6">
            <div v-for="wallet in cryptoWallets" :key="wallet.symbol" class="bg-navy-800 p-4 rounded-lg border border-navy-700">
              <div class="flex justify-between items-center mb-2"><span class="font-bold text-slate-200">{{ wallet.name }}</span><span class="text-xs bg-navy-950 px-2 py-1 rounded text-slate-400">{{ wallet.symbol }}</span></div>
              <div class="flex items-center gap-2 bg-navy-950 p-2 rounded border border-navy-800">
                <code class="text-xs text-slate-400 flex-1 truncate font-mono">{{ wallet.address }}</code>
                <button @click="handleCopy(wallet.address, wallet.symbol)" class="p-1 hover:text-white text-slate-500 transition-colors">
                  <Check v-if="copied === wallet.symbol" :size="16" class="text-emerald-500" />
                  <Copy v-else :size="16" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
