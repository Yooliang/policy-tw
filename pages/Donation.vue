<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { agentPlanRows, amount, levelTone, usageMap, type AgentPlan, type AgentUsage } from '../lib/agent-plans'
import Hero from '../components/Hero.vue'
import { Copy, Check, Heart, ChevronDown } from 'lucide-vue-next'
import { usePageHead } from '../composables/usePageHead'
import { supabasePublic } from '../lib/supabase'

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





// 運轉成本（2026-09-24 維護者：「不用太顯眼，一個基本的資料就好」）：後端每 15 分鐘更新，這裡只讀。
// 在瀏覽器才讀（onMounted），不進預渲染——數字會變，預渲染進去就是舊的。讀不到就整塊不顯示。
type Costs = { balance_level: string; jev_month_calls: number; jev_month_usd: number; db_bytes: number; refreshed_at: string | null }
const costs = ref<Costs | null>(null)
onMounted(async () => {
  try {
    const { data } = await supabasePublic.rpc('platform_cost_public')
    costs.value = ((data ?? []) as Costs[])[0] ?? null
  } catch { costs.value = null }
  try {
    const { data, error } = await supabasePublic.from('agent_plans').select('provider,plan,qty,monthly_usd,note,sort').order('sort').limit(50)
    plans.value = error ? [] : ((data ?? []) as AgentPlan[])
  } catch { plans.value = [] }
  try {
    const { data, error } = await supabasePublic.from('agent_usage').select('provider,account_label,pct,resets_at,captured_at').limit(50)
    usage.value = error ? [] : ((data ?? []) as AgentUsage[])
  } catch { usage.value = [] }
})
const usage = ref<AgentUsage[]>([])
const plans = ref<AgentPlan[]>([])
/** 餘額色調：資料庫算好的等級（< 5 黃、< 3 橘、< 1 紅），頁面不出現金額也不加提醒字。class 一律寫完整字串，Tailwind 才掃得到 */
const tone = computed(() => levelTone(costs.value?.balance_level))
const CARD_BORDER = { none: 'border-slate-200', yellow: 'border-amber-300', orange: 'border-orange-400', red: 'border-red-500' } as const
const ROW_TONE = { none: '', yellow: 'bg-amber-50 border-l-4 border-l-amber-400', orange: 'bg-orange-100 border-l-4 border-l-orange-500', red: 'bg-red-100 border-l-4 border-l-red-600' } as const
const jevCost = computed(() => costs.value
  ? { usd: Number(costs.value.jev_month_usd), usage: `本月 ${costs.value.jev_month_calls.toLocaleString()} 次`, tone: tone.value }
  : null)
const plansView = computed(() => agentPlanRows(plans.value, jevCost.value, { ...usageMap(usage.value, Date.now()), ...(costs.value ? { Supabase: mb(costs.value.db_bytes) } : {}) }))
const mb = (b: number) => `${Math.round(b / 1024 / 1024)} MB`

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

        <!-- 兩欄（md 以上）：右欄捐款方式、左欄系統狀態與維運；手機先捐款方式、再系統狀態（DOM 順序），md 以上用 order 對調 -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          <div class="space-y-6 md:order-2 md:col-start-2">
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

          <div v-if="costs && plansView.rows.length" class="space-y-4 md:order-1 md:col-start-1 md:row-start-1">
            <!-- 運轉成本：官方代理來自設定表 agent_plans，Jev 來自 platform_cost_public（只有餘額等級，不含金額）；讀不到就整塊不顯示 -->
            <section class="bg-white rounded-2xl shadow-lg border p-4 sm:p-5" :class="CARD_BORDER[tone]">
              <h2 class="font-black text-navy-900 mb-3">系統狀態與維運（每月 US$）</h2>
              <div class="overflow-x-auto">
                <table class="w-full min-w-[22rem] text-left text-sm">
                  <thead class="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th class="px-3 py-1.5 font-medium">項目</th>
                      <th class="px-3 py-1.5 font-medium">方案</th>
                      <th class="px-3 py-1.5 text-right font-medium">月費</th>
                      <th class="px-3 py-1.5 font-medium">本週用量</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(r, i) in plansView.rows" :key="i" class="border-t border-slate-100" :class="ROW_TONE[r.tone]">
                      <td class="px-3 py-1.5 text-slate-700">{{ r.provider }}{{ r.label ? ' ' + r.label : '' }}</td>
                      <td class="px-3 py-1.5 text-slate-600">{{ r.plan ?? '—' }}</td>
                      <td class="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{{ r.monthly == null ? '—' : (r.approx ? '約 ' : '') + amount(r.monthly) }}</td>
                      <td class="px-3 py-1.5 tabular-nums text-slate-500">{{ r.usage ?? '—' }}</td>
                    </tr>
                  </tbody>
                  <tfoot class="border-t border-slate-200 bg-slate-50 font-medium text-slate-700">
                    <tr>
                      <td class="px-3 py-1.5" colspan="2">合計</td>
                      <td class="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{{ plansView.approx ? '約 ' : '' }}{{ amount(plansView.total) }}</td>
                      <td class="px-3 py-1.5"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
