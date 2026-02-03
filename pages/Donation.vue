<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Hero from '../components/Hero.vue'
import { supabase } from '../lib/supabase'
import { CreditCard, Copy, Check, Heart, Sparkles, Loader2, ChevronDown } from 'lucide-vue-next'

const copied = ref<string | null>(null)
const showAllCrypto = ref(false)
const cryptoWallets = [
  { name: 'Bitcoin', symbol: 'BTC', address: 'bc1q9umjtz04dfslddw4eryw5mn8hk4ld7csml40pk' },
  { name: 'Ethereum (ERC20)', symbol: 'ETH', address: '0xcd28639ce0395E9f8048AAf2F52da0624880a772' },
  { name: 'USDT (TRC20)', symbol: 'TRC20', address: 'TUfyufkfRiUFxWnZ5BURKqUWWZHRThvNHt' },
  { name: 'USDT (BEP20)', symbol: 'BEP20', address: '0xcd28639ce0395E9f8048AAf2F52da0624880a772' },
  { name: 'USDT (Solana)', symbol: 'SOL', address: 'Fm5gcJ4V79VjSo3EmFqeyeeTkgUKgT6HWUS9J1cGyLEq' },
]

// USD to TWD exchange rate (approximate)
const USD_TO_TWD = 32.5

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
  policyUpdate: number
  politicianUpdate: number
  totalTokens: number
  totalCost: number
}>({
  verify: 0,
  search: 0,
  policyUpdate: 0,
  politicianUpdate: 0,
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
    let policyUpdateCount = 0
    let politicianUpdateCount = 0
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
        if (stat.function_type === 'policy_update') policyUpdateCount += stat.request_count
        if (stat.function_type === 'politician_update') politicianUpdateCount += stat.request_count
      }
    }

    currentMonthStats.value = {
      verify: verifyCount,
      search: searchCount,
      policyUpdate: policyUpdateCount,
      politicianUpdate: politicianUpdateCount,
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

function formatCostUSD(cost: number): string {
  if (cost < 0.01) return '< $0.01'
  return `$${cost.toFixed(2)}`
}

function formatCostTWD(cost: number): string {
  const twd = cost * USD_TO_TWD
  if (twd < 1) return '< NT$1'
  return `NT$${Math.round(twd).toLocaleString()}`
}

function formatCostNumber(cost: number): string {
  const twd = cost * USD_TO_TWD
  if (twd < 1) return '< 1'
  return Math.round(twd).toLocaleString()
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
          <!-- CTA - Independent card above stats -->
          <div class="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-6 flex items-center gap-4 shadow-lg">
            <Heart :size="32" class="text-red-500 shrink-0" />
            <p class="text-lg text-slate-700">
              您的捐款將幫助我們維持 AI 服務運作，讓更多公民能夠查核政見、追蹤政治承諾。
            </p>
          </div>

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
              <!-- Stats Grid: 4 columns x 2 rows -->
              <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                <!-- Row 1: Task types -->
                <div class="bg-slate-50 p-4 rounded-xl text-center">
                  <div class="text-2xl font-bold text-navy-900">{{ currentMonthStats.verify }}</div>
                  <div class="text-sm text-slate-500">內容查核</div>
                </div>
                <div class="bg-slate-50 p-4 rounded-xl text-center">
                  <div class="text-2xl font-bold text-navy-900">{{ currentMonthStats.search }}</div>
                  <div class="text-sm text-slate-500">候選人搜尋</div>
                </div>
                <div class="bg-slate-50 p-4 rounded-xl text-center">
                  <div class="text-2xl font-bold text-navy-900">{{ currentMonthStats.politicianUpdate }}</div>
                  <div class="text-sm text-slate-500">候選人更新</div>
                </div>
                <div class="bg-slate-50 p-4 rounded-xl text-center">
                  <div class="text-2xl font-bold text-navy-900">{{ currentMonthStats.policyUpdate }}</div>
                  <div class="text-sm text-slate-500">政見更新</div>
                </div>
                <!-- Row 2: Tokens and Costs -->
                <div class="bg-blue-50 p-4 rounded-xl text-center">
                  <div class="text-2xl font-bold text-blue-600">{{ formatTokens(currentMonthStats.totalTokens) }}</div>
                  <div class="text-sm text-slate-500">本月 tokens</div>
                </div>
                <div class="bg-amber-50 p-4 rounded-xl text-center">
                  <div class="text-2xl font-bold text-amber-600">{{ formatCostNumber(currentMonthStats.totalCost) }}</div>
                  <div class="text-sm text-slate-500">本月成本 (NT$)</div>
                </div>
                <div class="bg-slate-100 p-4 rounded-xl text-center">
                  <div class="text-2xl font-bold text-navy-900">{{ formatTokens(allTimeStats.totalTokens) }}</div>
                  <div class="text-sm text-slate-500">累計 tokens</div>
                </div>
                <div class="bg-orange-50 p-4 rounded-xl text-center">
                  <div class="text-2xl font-bold text-orange-600">{{ formatCostNumber(allTimeStats.totalCost) }}</div>
                  <div class="text-sm text-slate-500">累計成本 (NT$)</div>
                </div>
              </div>

              <!-- Pricing Reference -->
              <div class="border-t border-slate-200 pt-4 mt-4">
                <p class="text-xs text-slate-400">
                  價格參考：Claude Opus 4.5 輸入 $5/MTok、輸出 $25/MTok｜Haiku 4.5 輸入 $1/MTok、輸出 $5/MTok
                  <a href="https://platform.claude.com/docs/zh-TW/about-claude/pricing" target="_blank" class="text-blue-500 hover:underline ml-1">官方定價</a>
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
