<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import Hero from '../components/Hero.vue'
import { 
  Database, RefreshCw, CheckCircle2, AlertCircle, 
  Search, Play, Pause, Trash2, ChevronRight,
  UserCheck, Users, MapPin, Activity, Loader2, Sparkles, Zap
} from 'lucide-vue-next'

const { politicians, fetchAll } = useSupabase()

// --- Scraper State ---
const isRunning = ref(false)
const isSuperAuto = ref(false)
const currentTaskName = ref('')
const progress = ref(0)
const logs = ref<{time: string, msg: string, type: 'info' | 'success' | 'error'}[]>([])
const stats = ref({
  total: 0,
  added: 0,
  updated: 0,
  exists: 0,
  failed: 0
})

const selectedYear = ref('2022')
const selectedType = ref('C1')
const selectedCity = ref('')

const years = ['2022', '2024']
const electionTypes = [
  { id: 'P0', name: '總統副總統' },
  { id: 'L0', name: '立法委員' },
  { id: 'C1', name: '直轄市長' },
  { id: 'C2', name: '縣市長' },
  { id: 'T1', name: '直轄市議員' },
  { id: 'T2', name: '縣市議員' },
  { id: 'D2', name: '鄉鎮市長' },
  { id: 'D1', name: '直轄市山地原住民區長' },
  { id: 'R2', name: '鄉鎮市民代表' },
  { id: 'R1', name: '直轄市山地原住民區民代表' },
  { id: 'V0', name: '村里長' }
]

const cities = [
  { id: '63', name: '台北市' },
  { id: '64', name: '高雄市' },
  { id: '65', name: '新北市' },
  { id: '66', name: '台中市' },
  { id: '67', name: '桃園市' },
  { id: '68', name: '台南市' },
  { id: '10', name: '宜蘭縣' },
  { id: '01', name: '新竹縣' },
  { id: '02', name: '苗栗縣' },
  { id: '03', name: '彰化縣' },
  { id: '04', name: '南投縣' },
  { id: '05', name: '雲林縣' },
  { id: '06', name: '嘉義縣' },
  { id: '07', name: '屏東縣' },
  { id: '08', name: '台東縣' },
  { id: '09', name: '花蓮縣' },
  { id: '11', name: '澎湖縣' },
  { id: '12', name: '基隆市' },
  { id: '13', name: '新竹市' },
  { id: '14', name: '嘉義市' },
  { id: '15', name: '金門縣' },
  { id: '16', name: '連江縣' }
]

function addLog(msg: string, type: 'info' | 'success' | 'error' = 'info') {
  logs.value.unshift({ time: new Date().toLocaleTimeString(), msg, type })
  if (logs.value.length > 200) logs.value.pop()
}

// 核心抓取函式 (單次請求)
async function runTask(year: string, type: string, cityId: string = '') {
  const cityName = cities.find(c => c.id === cityId)?.name || '全台'
  const typeName = electionTypes.find(t => t.id === type)?.name || type
  currentTaskName.value = `${year} ${typeName} (${cityName})`
  
  addLog(`[任務啟動] ${currentTaskName.value}...`, 'info')

  try {
    const fetchRes = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-cec-data`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        year, 
        type, 
        cityCode: cityId,
        cityName // Pass the city name to Edge Function
      })
    })
    
    const { candidates, error } = await fetchRes.json()
    if (error) {
      addLog(`跳過: ${error}`, 'info')
      return
    }

    addLog(`獲取到 ${candidates.length} 位人員，開始分批同步...`, 'info')
    stats.value.total += candidates.length

    // --- 批次處理優化 (每 50 人一組) ---
    const BATCH_SIZE = 50
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      if (!isRunning.value) return
      const batch = candidates.slice(i, i + BATCH_SIZE)
      
      try {
        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/add-politician`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ politicians: batch })
        })
        
        const result = await response.json()
        if (result.success) {
          stats.value.added += (result.added || 0)
          stats.value.updated += (result.updated || 0)
          stats.value.exists += (result.exists || 0)
          stats.value.failed += (result.failed || 0)
        }
      } catch (err) {
        stats.value.failed += batch.length
      }
      
      addLog(`[進度] 已處理 ${Math.min(i + BATCH_SIZE, candidates.length)} / ${candidates.length} 人`, 'info')
    }
  } catch (err: any) {
    addLog(`發生錯誤: ${err.message}`, 'error')
  }
}

// 手動開始
async function startManual() {
  isRunning.value = true
  isSuperAuto.value = false
  stats.value = { total: 0, added: 0, updated: 0, exists: 0, failed: 0 }
  progress.value = 0
  await runTask(selectedYear.value, selectedType.value, selectedCity.value)
  isRunning.value = false
  addLog('手動抓取完成', 'success')
  fetchAll()
}

// --- 超級全自動模式 ---
async function startSuperAuto() {
  if (!confirm(`確定要啟動 ${selectedYear.value} 年全自動抓取嗎？這將遍歷所有類別與縣市，耗時較長。`)) return
  
  isRunning.value = true
  isSuperAuto.value = true
  stats.value = { total: 0, added: 0, updated: 0, exists: 0, failed: 0 }
  
  addLog(`🚀 啟動 ${selectedYear.value} 年超級全自動任務...`, 'success')

  for (const type of electionTypes) {
    if (!isRunning.value) break
    if (['P0', 'L0', 'C1', 'C2'].includes(type.id)) {
      await runTask(selectedYear.value, type.id, '')
    } else {
      addLog(`>>> 進入 ${type.name} 縣市遍歷模式...`, 'info')
      for (const city of cities) {
        if (!isRunning.value) break
        await runTask(selectedYear.value, type.id, city.id)
        await new Promise(r => setTimeout(r, 500))
      }
    }
  }

  isRunning.value = false
  isSuperAuto.value = false
  addLog('🎊 全年度資料抓取任務圓滿完成！', 'success')
  fetchAll()
}

function stop() {
  isRunning.value = false
  isSuperAuto.value = false
  addLog('⏹️ 使用者終止任務', 'error')
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #badge>管理後台</template>
      <template #title>超級全自動抓取系統</template>
      <template #description>一鍵遍歷全台灣各級選舉，支援 22 縣市、11 類別自動排程抓取與重複檢查。</template>
      <template #icon><Zap :size="400" class="text-amber-500 opacity-20" /></template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div class="grid grid-cols-1 lg:grid-cols-4 gap-8">
        
        <div class="lg:col-span-1 space-y-6">
          <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
            <h3 class="font-bold text-navy-900 flex items-center gap-2">
              <Sparkles :size="18" class="text-amber-500" /> 任務設定
            </h3>
            
            <div class="space-y-4">
              <div>
                <label class="block text-xs font-bold text-slate-400 uppercase mb-2">選擇目標年份</label>
                <select v-model="selectedYear" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500">
                  <option v-for="y in years" :key="y" :value="y">{{ y }} 年大選</option>
                </select>
              </div>

              <div class="pt-4 space-y-3">
                <button v-if="!isRunning" @click="startSuperAuto" class="w-full py-4 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white rounded-xl font-black flex items-center justify-center gap-2 shadow-xl shadow-amber-200 transition-all transform hover:-translate-y-1">
                  <Sparkles :size="20" /> 啟動超級全自動抓取
                </button>
                
                <div v-if="!isRunning" class="relative py-4 flex items-center">
                  <div class="flex-grow border-t border-slate-200"></div>
                  <span class="flex-shrink mx-4 text-xs font-bold text-slate-400 uppercase tracking-widest">或 手動控制</span>
                  <div class="flex-grow border-t border-slate-200"></div>
                </div>

                <div v-if="!isRunning" class="space-y-3">
                  <select v-model="selectedType" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-500">
                    <option v-for="t in electionTypes" :key="t.id" :value="t.id">{{ t.name }}</option>
                  </select>
                  <select v-model="selectedCity" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">全台 (自動嘗試)</option>
                    <option v-for="c in cities" :key="c.id" :value="c.id">{{ c.name }}</option>
                  </select>
                  <button @click="startManual" class="w-full py-2 bg-slate-800 text-white rounded-lg text-sm font-bold flex items-center justify-center gap-2 hover:bg-black transition-all">
                    <Play :size="14" /> 執行單項抓取
                  </button>
                </div>

                <button v-if="isRunning" @click="stop" class="w-full py-4 bg-red-500 hover:bg-red-600 text-white rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg shadow-red-200 transition-all">
                  <Pause :size="20" /> 停止所有任務
                </button>
              </div>
            </div>
          </div>

          <div class="bg-navy-900 p-6 rounded-2xl text-white shadow-xl shadow-indigo-900/20">
            <h4 class="text-blue-400 text-xs font-bold uppercase mb-4 tracking-widest">系統目前總量</h4>
            <div class="flex items-end justify-between">
              <div>
                <p class="text-3xl font-black">{{ politicians.length }}</p>
                <p class="text-slate-400 text-xs font-medium">總政治人物數</p>
              </div>
              <Users :size="48" class="text-blue-500 opacity-30" />
            </div>
          </div>
        </div>

        <div class="lg:col-span-3 space-y-6">
          <div v-if="isRunning" class="bg-white p-8 rounded-2xl border-2 border-amber-500 shadow-xl shadow-amber-100 relative overflow-hidden">
            <div class="absolute top-0 right-0 p-4">
              <div class="flex items-center gap-2 bg-amber-100 text-amber-700 px-3 py-1 rounded-full text-xs font-black animate-pulse">
                <Activity :size="14" /> 正在執行中
              </div>
            </div>

            <div class="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
              <div class="space-y-1">
                <p class="text-xs font-black text-amber-600 uppercase tracking-widest">目前執行任務</p>
                <h3 class="text-2xl font-black text-navy-900">{{ currentTaskName }}</h3>
              </div>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div class="bg-emerald-50 p-4 rounded-xl border border-emerald-100 text-center">
                <p class="text-2xl font-black text-emerald-600">{{ stats.added }}</p>
                <p class="text-[10px] font-black text-emerald-400 uppercase">新增入庫</p>
              </div>
              <div class="bg-amber-50 p-4 rounded-xl border border-amber-100 text-center">
                <p class="text-2xl font-black text-amber-600">{{ stats.updated }}</p>
                <p class="text-[10px] font-black text-amber-400 uppercase">資料補全</p>
              </div>
              <div class="bg-blue-50 p-4 rounded-xl border border-blue-100 text-center">
                <p class="text-2xl font-black text-blue-600">{{ stats.exists }}</p>
                <p class="text-[10px] font-black text-blue-400 uppercase">重複略過</p>
              </div>
              <div class="bg-rose-50 p-4 rounded-xl border border-rose-100 text-center">
                <p class="text-2xl font-black text-rose-600">{{ stats.failed }}</p>
                <p class="text-[10px] font-black text-rose-400 uppercase">執行失敗</p>
              </div>
              <div class="bg-slate-50 p-4 rounded-xl border border-slate-100 text-center">
                <p class="text-2xl font-black text-slate-600">{{ stats.added + stats.updated + stats.exists + stats.failed }}</p>
                <p class="text-[10px] font-black text-slate-400 uppercase">已處理人員</p>
              </div>
            </div>

            <div class="mt-8 flex items-center gap-3">
               <Loader2 :size="18" class="text-amber-500 animate-spin" />
               <p class="text-xs text-slate-500 font-medium italic">系統正在處理中，請勿關閉分頁...</p>
            </div>
          </div>

          <div v-else-if="stats.total > 0" class="bg-emerald-600 p-8 rounded-2xl text-white shadow-xl shadow-emerald-200">
             <div class="flex items-center gap-4 mb-4">
                <CheckCircle2 :size="32" />
                <h3 class="text-2xl font-black">任務已順利結束！</h3>
             </div>
             <p class="text-emerald-100 mb-6 font-medium">本次任務共計處理了 {{ stats.added + stats.updated + stats.exists + stats.failed }} 位候選人。</p>
             <button @click="stats.total = 0" class="bg-emerald-500 hover:bg-emerald-400 px-6 py-2 rounded-lg font-bold transition-colors">確認並清除統計</button>
          </div>

          <div class="bg-slate-900 rounded-2xl border border-slate-800 shadow-2xl overflow-hidden flex flex-col h-[500px]">
            <div class="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-800/50">
              <h3 class="font-bold text-slate-300 flex items-center gap-2">
                <Activity :size="18" class="text-slate-500" /> 即時執行紀錄
              </h3>
              <div class="flex items-center gap-4">
                <button @click="logs = []" class="text-xs text-slate-500 hover:text-rose-400 transition-colors">CLEAR LOGS</button>
              </div>
            </div>
            <div class="flex-1 overflow-y-auto p-6 space-y-2 font-mono text-xs leading-relaxed">
              <div v-for="(log, i) in logs" :key="i" :class="`flex gap-4 border-l-2 pl-3 ${log.type === 'success' ? 'text-emerald-400 border-emerald-500' : log.type === 'error' ? 'text-rose-400 border-rose-500' : 'text-slate-400 border-slate-700'}`">
                <span class="text-slate-600 shrink-0">{{ log.time }}</span>
                <span class="break-all">{{ log.msg }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-spin { animation: spin 2s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
