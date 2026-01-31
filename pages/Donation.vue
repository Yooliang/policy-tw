<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Hero from '../components/Hero.vue'
import { supabase } from '../lib/supabase'
import { CreditCard, Copy, Check, Heart, Sparkles, Loader2 } from 'lucide-vue-next'

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

// AI Usage Stats
interface AIUsageStat {
  month: string
  function_type: string
  request_count: number
  total_tokens: number
  total_cost: number
}

const aiStats = ref<AIUsageStat[]>([])
const aiStatsLoading = ref(true)
const aiStatsError = ref<string | null>(null)

// Computed totals
const currentMonthStats = ref<{
  verify: number
  search: number
  update: number
  contribute: number
  totalTokens: number
  totalCost: number
}>({
  verify: 0,
  search: 0,
  update: 0,
  contribute: 0,
  totalTokens: 0,
  totalCost: 0,
})

const allTimeStats = ref<{
  totalTokens: number
  totalCost: number
}>({
  totalTokens: 0,
  totalCost: 0,
})

async function fetchAIStats() {
  aiStatsLoading.value = true
  aiStatsError.value = null

  try {
    const { data, error } = await supabase.from('ai_usage_stats').select('*')

    if (error) throw error

    aiStats.value = data || []

    // Calculate current month stats
    const now = new Date()
    const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    let verifyCount = 0
    let searchCount = 0
    let updateCount = 0
    let contributeCount = 0
    let monthTokens = 0
    let monthCost = 0
    let allTokens = 0
    let allCost = 0

    for (const stat of aiStats.value) {
      const statMonth = stat.month?.slice(0, 7) // YYYY-MM

      allTokens += stat.total_tokens || 0
      allCost += Number(stat.total_cost) || 0

      if (statMonth === currentMonthStr) {
        monthTokens += stat.total_tokens || 0
        monthCost += Number(stat.total_cost) || 0

        if (stat.function_type === 'verify') verifyCount += stat.request_count
        if (stat.function_type === 'search') searchCount += stat.request_count
        if (stat.function_type === 'update') updateCount += stat.request_count
        if (stat.function_type === 'contribute') contributeCount += stat.request_count
      }
    }

    currentMonthStats.value = {
      verify: verifyCount,
      search: searchCount,
      update: updateCount,
      contribute: contributeCount,
      totalTokens: monthTokens,
      totalCost: monthCost,
    }

    allTimeStats.value = {
      totalTokens: allTokens,
      totalCost: allCost,
    }
  } catch (err: any) {
    console.error('Failed to fetch AI stats:', err)
    aiStatsError.value = err.message || '載入統計資料失敗'
  } finally {
    aiStatsLoading.value = false
  }
}

function formatCost(cost: number): string {
  if (cost < 0.01) return '< $0.01'
  return `$${cost.toFixed(2)}`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return tokens.toLocaleString()
}

onMounted(() => {
  fetchAIStats()
})
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

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <!-- Left: AI Usage Statistics (8 cols) -->
        <div class="lg:col-span-8 space-y-6">
          <div class="bg-white p-8 rounded-2xl border border-slate-200 shadow-lg text-left">
            <h3 class="text-xl font-bold text-navy-900 mb-6 flex items-center gap-2">
              <Sparkles class="text-amber-500" />
              AI 服務使用統計
            </h3>

            <div v-if="aiStatsLoading" class="flex items-center justify-center py-8">
              <Loader2 :size="24" class="animate-spin text-slate-400" />
              <span class="ml-2 text-slate-500">載入統計資料...</span>
            </div>

            <div v-else-if="aiStatsError" class="text-red-600 py-4">
              {{ aiStatsError }}
            </div>

            <div v-else class="space-y-6">
              <!-- Current Month -->
              <div>
                <h4 class="text-sm font-medium text-slate-500 mb-3">本月使用量</h4>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div class="bg-slate-50 p-4 rounded-xl">
                    <div class="text-2xl font-bold text-navy-900">{{ currentMonthStats.verify }}</div>
                    <div class="text-sm text-slate-500">內容查核</div>
                  </div>
                  <div class="bg-slate-50 p-4 rounded-xl">
                    <div class="text-2xl font-bold text-navy-900">{{ currentMonthStats.search }}</div>
                    <div class="text-sm text-slate-500">候選人搜尋</div>
                  </div>
                  <div class="bg-slate-50 p-4 rounded-xl">
                    <div class="text-2xl font-bold text-navy-900">{{ currentMonthStats.update }}</div>
                    <div class="text-sm text-slate-500">政見更新</div>
                  </div>
                  <div class="bg-slate-50 p-4 rounded-xl">
                    <div class="text-2xl font-bold text-navy-900">{{ currentMonthStats.contribute }}</div>
                    <div class="text-sm text-slate-500">公民貢獻</div>
                  </div>
                </div>
              </div>

              <!-- Totals -->
              <div class="border-t border-slate-200 pt-6">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <h4 class="text-sm font-medium text-slate-500 mb-2">本月消耗</h4>
                    <div class="flex items-baseline gap-2">
                      <span class="text-3xl font-bold text-navy-900">{{ formatTokens(currentMonthStats.totalTokens) }}</span>
                      <span class="text-slate-500">tokens</span>
                    </div>
                    <div class="text-lg text-slate-600">{{ formatCost(currentMonthStats.totalCost) }} USD</div>
                  </div>
                  <div>
                    <h4 class="text-sm font-medium text-slate-500 mb-2">累計消耗</h4>
                    <div class="flex items-baseline gap-2">
                      <span class="text-3xl font-bold text-navy-900">{{ formatTokens(allTimeStats.totalTokens) }}</span>
                      <span class="text-slate-500">tokens</span>
                    </div>
                    <div class="text-lg text-slate-600">{{ formatCost(allTimeStats.totalCost) }} USD</div>
                  </div>
                </div>
              </div>

              <!-- CTA -->
              <div class="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
                <Heart :size="20" class="text-red-500 shrink-0" />
                <p class="text-sm text-slate-700">
                  您的捐款將幫助我們維持 AI 服務運作，讓更多公民能夠查核政見、追蹤政治承諾。
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Right: Donation Options (4 cols) -->
        <div class="lg:col-span-4 space-y-6">
          <!-- General Donation -->
          <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-lg hover:shadow-xl transition-shadow text-left">
            <h3 class="text-lg font-bold text-navy-900 mb-4 flex items-center gap-2">
              <CreditCard class="text-blue-600" />一般捐款
            </h3>
            <div class="space-y-3">
              <button class="w-full bg-[#00c300] hover:bg-[#00b300] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-colors">
                <span class="font-bold">LINE Pay</span>
                <span class="text-xs opacity-90">單次 / 定期</span>
              </button>
              <button class="w-full bg-navy-800 hover:bg-navy-700 text-white font-bold py-3 rounded-xl transition-colors">
                信用卡
              </button>
            </div>
          </div>

          <!-- Crypto Donation -->
          <div class="bg-navy-900 p-6 rounded-2xl shadow-lg border border-navy-700 text-white text-left">
            <h3 class="text-lg font-bold mb-4 flex items-center gap-2">
              <span class="text-amber-400">₿</span>加密貨幣捐款
            </h3>
            <div class="space-y-4">
              <div v-for="wallet in cryptoWallets" :key="wallet.symbol" class="bg-navy-800 p-3 rounded-lg border border-navy-700">
                <div class="flex justify-between items-center mb-2">
                  <span class="font-bold text-slate-200 text-sm">{{ wallet.name }}</span>
                  <span class="text-xs bg-navy-950 px-2 py-0.5 rounded text-slate-400">{{ wallet.symbol }}</span>
                </div>
                <div class="flex items-center gap-2 bg-navy-950 p-2 rounded border border-navy-800">
                  <code class="text-[10px] text-slate-400 flex-1 truncate font-mono">{{ wallet.address }}</code>
                  <button @click="handleCopy(wallet.address, wallet.symbol)" class="p-1 hover:text-white text-slate-500 transition-colors shrink-0">
                    <Check v-if="copied === wallet.symbol" :size="14" class="text-emerald-500" />
                    <Copy v-else :size="14" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
