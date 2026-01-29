<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import Hero from '../components/Hero.vue'
import { Database, CheckCircle2, Pause, Users, Activity, Loader2, Sparkles, XCircle, Clock } from 'lucide-vue-next'

const { politicians, fetchAll } = useSupabase()

// 狀態
const isRunning = ref(false)
const currentTask = ref('')
const logs = ref<string[]>([])
const stats = ref({ added: 0, updated: 0, exists: 0, failed: 0 })

// 選擇年份
const selectedYear = ref('2024')
const availableYears = ['2024', '2022']

// 選舉類型
const electionTypes = [
  { id: 'President', name: '總統', needCity: false, dataLevel: 'N' },
  { id: 'Legislator', name: '立委', needCity: true, dataLevel: 'A' },
  { id: 'Mayor', name: '直轄市長', needCity: false, dataLevel: 'C' },
  { id: 'CountyMayor', name: '縣市長', needCity: false, dataLevel: 'C' },
  { id: 'CouncilMember', name: '直轄市議員', needCity: true, dataLevel: 'A' },
  { id: 'CountyCouncilMember', name: '縣市議員', needCity: true, dataLevel: 'A' },
  { id: 'CityMayor', name: '鄉鎮市長', needCity: true, dataLevel: 'D' },
  { id: 'Village', name: '村里長', needCity: true, dataLevel: 'L' },
]

// 縣市
const cities = [
  { prvCode: '00', cityCode: '000', name: '全國' },
  { prvCode: '63', cityCode: '000', name: '台北市' },
  { prvCode: '65', cityCode: '000', name: '新北市' },
  { prvCode: '68', cityCode: '000', name: '桃園市' },
  { prvCode: '66', cityCode: '000', name: '台中市' },
  { prvCode: '67', cityCode: '000', name: '台南市' },
  { prvCode: '64', cityCode: '000', name: '高雄市' },
  { prvCode: '10', cityCode: '002', name: '宜蘭縣' },
  { prvCode: '10', cityCode: '004', name: '新竹縣' },
  { prvCode: '10', cityCode: '005', name: '苗栗縣' },
  { prvCode: '10', cityCode: '007', name: '彰化縣' },
  { prvCode: '10', cityCode: '008', name: '南投縣' },
  { prvCode: '10', cityCode: '009', name: '雲林縣' },
  { prvCode: '10', cityCode: '010', name: '嘉義縣' },
  { prvCode: '10', cityCode: '013', name: '屏東縣' },
  { prvCode: '10', cityCode: '014', name: '台東縣' },
  { prvCode: '10', cityCode: '015', name: '花蓮縣' },
  { prvCode: '10', cityCode: '016', name: '澎湖縣' },
  { prvCode: '10', cityCode: '017', name: '基隆市' },
  { prvCode: '10', cityCode: '018', name: '新竹市' },
  { prvCode: '10', cityCode: '020', name: '嘉義市' },
  { prvCode: '09', cityCode: '007', name: '金門縣' },
  { prvCode: '09', cityCode: '020', name: '連江縣' },
]

// themeId
const themesByYear: Record<string, Record<string, string>> = {
  '2024': {
    President: '4d83db17c1707e3defae5dc4d4e9c800',
    Legislator: '9c96a2080bfc199c590ec54f3a2bda7b',
  },
  '2022': {
    Mayor: '05cc7b904c7a30cc7c88d5b10898c98e',
    CountyMayor: '1275d73551f2c0caf202e803b1766057',
    CouncilMember: '25e12c45f9f5641aab4193598d5aff6e',
    CountyCouncilMember: '72976331a1ea6b85cfb1ed3380ae5f35',
    CityMayor: '664d46a37f4f38296ad0b9d0f24adab4',
    Village: '0bd11a4b3f092aae2811741428ec3e3d',
  },
}

// API 對應
const SUBJECT_MAP: Record<string, { subjectId: string; legisId: string }> = {
  President: { subjectId: 'P0', legisId: '00' },
  Legislator: { subjectId: 'L0', legisId: 'L1' },
  Mayor: { subjectId: 'C1', legisId: '00' },
  CountyMayor: { subjectId: 'C2', legisId: '00' },
  CouncilMember: { subjectId: 'T1', legisId: 'T1' },
  CountyCouncilMember: { subjectId: 'T2', legisId: 'T1' },
  CityMayor: { subjectId: 'D2', legisId: '00' },
  Village: { subjectId: 'V0', legisId: '00' },
}

// 進度狀態：'pending' | 'done' | 'error' | 'nodata'
type CellStatus = 'pending' | 'done' | 'error' | 'nodata' | 'running'
const progress = ref<Record<string, Record<string, CellStatus>>>({})

// 該年份可用的類型
const availableTypes = computed(() => {
  const themes = themesByYear[selectedYear.value] || {}
  return electionTypes.filter(t => themes[t.id])
})

// localStorage key
const storageKey = computed(() => `cec-progress-${selectedYear.value}`)

// 載入進度
function loadProgress() {
  const saved = localStorage.getItem(storageKey.value)
  if (saved) {
    progress.value = JSON.parse(saved)
  } else {
    resetProgress()
  }
}

// 儲存進度
function saveProgress() {
  localStorage.setItem(storageKey.value, JSON.stringify(progress.value))
}

// 重置進度
function resetProgress() {
  const p: Record<string, Record<string, CellStatus>> = {}
  for (const type of electionTypes) {
    p[type.id] = {}
    for (const city of cities) {
      p[type.id][`${city.prvCode}_${city.cityCode}`] = 'pending'
    }
  }
  progress.value = p
  saveProgress()
}

// 取得 cell 狀態
function getCellStatus(typeId: string, cityKey: string): CellStatus {
  return progress.value[typeId]?.[cityKey] || 'pending'
}

// 設定 cell 狀態
function setCellStatus(typeId: string, cityKey: string, status: CellStatus) {
  if (!progress.value[typeId]) progress.value[typeId] = {}
  progress.value[typeId][cityKey] = status
  saveProgress()
}

// 抓取單一格
async function fetchCell(typeId: string, themeId: string, city: typeof cities[0], dataLevel: string) {
  const cityKey = `${city.prvCode}_${city.cityCode}`
  const subject = SUBJECT_MAP[typeId]
  if (!subject) return

  setCellStatus(typeId, cityKey, 'running')
  currentTask.value = `${electionTypes.find(t => t.id === typeId)?.name} - ${city.name}`

  try {
    const apiUrl = `https://db.cec.gov.tw/static/elections/data/tickets/ELC/${subject.subjectId}/${subject.legisId}/${themeId}/${dataLevel}/${city.prvCode}_${city.cityCode}_00_000_0000.json`
    const response = await fetch(apiUrl)

    if (response.status === 404) {
      setCellStatus(typeId, cityKey, 'nodata')
      return
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const data = await response.json()

    // 合併所有 key 的資料（API 可能按區域分組回傳多個 key）
    const candList: any[] = []
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key])) {
        candList.push(...data[key])
      }
    }

    if (candList.length === 0) {
      setCellStatus(typeId, cityKey, 'nodata')
      return
    }

    // 解析候選人
    const typeName = electionTypes.find(t => t.id === typeId)?.name || typeId

    const candidates = candList
      .filter((c: any) => c.is_vice !== 'Y')
      .map((c: any) => {
        const party = c.party_name || '無黨籍'
        let birthYear = c.cand_birthyear ? parseInt(c.cand_birthyear) : null
        if (birthYear && birthYear < 1000) birthYear += 1911

        // 根據選舉類型決定欄位映射
        let region = city.name  // 預設用縣市名
        let subRegion = null
        let village = null

        if (typeId === 'Village') {
          // 村里長：area_name 是里名
          village = c.area_name || null
        } else if (typeId === 'CityMayor') {
          // 鄉鎮市長：area_name 是鄉鎮市名
          subRegion = c.area_name || null
        } else {
          // 其他：area_name 是選區名，存到 region
          region = c.area_name || city.name
        }

        return {
          name: c.cand_name,
          party,
          position: `${typeName}候選人`,
          region,
          subRegion,
          village,
          birthYear,
          educationLevel: c.cand_edu || null,
          electionType: typeName,
          electionId: parseInt(selectedYear.value),
        }
      })

    // 分批上傳到 Supabase（每批 50 人）
    const BATCH_SIZE = 50
    let batchAdded = 0
    let batchUpdated = 0

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE)
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/add-politician`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ politicians: batch })
      })
      const result = await res.json()

      if (result.success) {
        batchAdded += result.added || 0
        batchUpdated += result.updated || 0
      } else {
        throw new Error(result.error)
      }
    }

    stats.value.added += batchAdded
    stats.value.updated += batchUpdated
    logs.value.unshift(`✓ ${city.name} ${typeName}: +${batchAdded} ↻${batchUpdated} (共 ${candidates.length} 筆)`)
    setCellStatus(typeId, cityKey, 'done')
  } catch (err: any) {
    logs.value.unshift(`✗ ${city.name}: ${err.message}`)
    stats.value.failed++
    setCellStatus(typeId, cityKey, 'error')
  }
}

// 開始抓取
async function startFetch() {
  isRunning.value = true
  stats.value = { added: 0, updated: 0, exists: 0, failed: 0 }
  const themes = themesByYear[selectedYear.value] || {}

  for (const type of availableTypes.value) {
    if (!isRunning.value) break
    const themeId = themes[type.id]
    if (!themeId) continue

    if (type.needCity) {
      // 跳過全國，從縣市開始
      for (const city of cities.slice(1)) {
        if (!isRunning.value) break
        const cityKey = `${city.prvCode}_${city.cityCode}`
        if (getCellStatus(type.id, cityKey) === 'done') continue
        await fetchCell(type.id, themeId, city, type.dataLevel)
        await new Promise(r => setTimeout(r, 200))
      }
    } else {
      // 全國資料
      const cityKey = '00_000'
      if (getCellStatus(type.id, cityKey) !== 'done') {
        await fetchCell(type.id, themeId, cities[0], type.dataLevel)
      }
    }
  }

  isRunning.value = false
  currentTask.value = ''
  fetchAll()
}

function stop() {
  isRunning.value = false
}

// 統計
const doneCount = computed(() => {
  let count = 0
  for (const typeId in progress.value) {
    for (const cityKey in progress.value[typeId]) {
      if (progress.value[typeId][cityKey] === 'done') count++
    }
  }
  return count
})

const totalCount = computed(() => {
  let count = 0
  const themes = themesByYear[selectedYear.value] || {}
  for (const type of electionTypes) {
    if (!themes[type.id]) continue
    if (type.needCity) count += cities.length - 1
    else count += 1
  }
  return count
})

// 年份切換時載入進度
watch(selectedYear, loadProgress)
onMounted(loadProgress)
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #badge>管理後台</template>
      <template #title>中選會資料抓取</template>
      <template #icon><Database :size="400" class="text-blue-500" /></template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 py-8">
      <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <!-- 左側欄 -->
        <div class="lg:col-span-1 space-y-4">
          <!-- 系統總量 -->
          <div class="bg-navy-900 p-5 rounded-xl text-white shadow-lg">
            <h4 class="text-blue-400 text-xs font-bold uppercase mb-3">系統目前總量</h4>
            <div class="flex items-end justify-between">
              <div>
                <p class="text-3xl font-black">{{ politicians.length }}</p>
                <p class="text-slate-400 text-xs">總政治人物數</p>
              </div>
              <Users :size="40" class="text-blue-500 opacity-30" />
            </div>
          </div>

          <!-- 本次統計 -->
          <div class="bg-white rounded-xl border p-4 space-y-3">
            <h4 class="text-xs font-bold text-slate-400 uppercase">本次執行統計</h4>
            <div class="grid grid-cols-3 gap-2 text-center">
              <div class="bg-emerald-50 rounded-lg p-2">
                <p class="text-lg font-black text-emerald-600">{{ stats.added }}</p>
                <p class="text-[10px] text-emerald-500">新增</p>
              </div>
              <div class="bg-amber-50 rounded-lg p-2">
                <p class="text-lg font-black text-amber-600">{{ stats.updated }}</p>
                <p class="text-[10px] text-amber-500">更新</p>
              </div>
              <div class="bg-rose-50 rounded-lg p-2">
                <p class="text-lg font-black text-rose-600">{{ stats.failed }}</p>
                <p class="text-[10px] text-rose-500">失敗</p>
              </div>
            </div>
          </div>

          <!-- 控制面板 -->
          <div class="bg-white rounded-xl border p-4 space-y-4">
            <h4 class="text-xs font-bold text-slate-400 uppercase">任務控制</h4>

            <select v-model="selectedYear" class="w-full border rounded-lg px-3 py-2 font-medium">
              <option v-for="y in availableYears" :key="y" :value="y">{{ y }} 年</option>
            </select>

            <button
              v-if="!isRunning"
              @click="startFetch"
              class="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-lg font-bold flex items-center justify-center gap-2"
            >
              <Sparkles :size="18" /> 開始抓取
            </button>
            <button
              v-else
              @click="stop"
              class="w-full bg-red-500 hover:bg-red-600 text-white px-4 py-3 rounded-lg font-bold flex items-center justify-center gap-2"
            >
              <Pause :size="18" /> 停止
            </button>

            <div class="flex items-center justify-between text-sm">
              <span class="text-slate-500">進度: <b>{{ doneCount }}/{{ totalCount }}</b></span>
              <button @click="resetProgress" class="text-slate-400 hover:text-red-500 text-xs">
                重置
              </button>
            </div>
          </div>

          <!-- 目前任務 -->
          <div v-if="isRunning" class="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div class="flex items-center gap-2 text-amber-800 text-sm font-medium">
              <Loader2 :size="16" class="animate-spin" />
              {{ currentTask }}
            </div>
          </div>
        </div>

        <!-- 右側表格 -->
        <div class="lg:col-span-3 space-y-4">
          <!-- 2D 表格 -->
          <div class="bg-white rounded-xl border overflow-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="bg-slate-100">
                  <th class="p-2 text-center font-bold text-slate-600 sticky left-0 bg-slate-100 z-10 min-w-[80px]">縣市</th>
                  <th
                    v-for="type in availableTypes"
                    :key="type.id"
                    class="p-2 text-center font-bold text-slate-600 min-w-[60px]"
                  >
                    {{ type.name }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="city in cities" :key="`${city.prvCode}_${city.cityCode}`" class="border-t hover:bg-slate-50">
                  <td class="p-2 text-center font-medium text-slate-700 sticky left-0 bg-white">{{ city.name }}</td>
                  <td
                    v-for="type in availableTypes"
                    :key="type.id"
                    class="p-2"
                  >
                    <div class="flex items-center justify-center">
                      <template v-if="type.needCity && city.prvCode === '00'">
                        <span class="text-slate-300">-</span>
                      </template>
                      <template v-else-if="!type.needCity && city.prvCode !== '00'">
                        <span class="text-slate-300">-</span>
                      </template>
                      <template v-else>
                        <span
                          :class="[
                            {
                              'text-emerald-500 hover:text-emerald-700': getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`) === 'done',
                              'text-red-500 hover:text-red-700': getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`) === 'error',
                              'text-slate-300 hover:text-slate-500': getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`) === 'nodata',
                              'text-amber-500 animate-pulse': getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`) === 'running',
                              'text-slate-400': getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`) === 'pending',
                            },
                            ['done', 'error', 'nodata'].includes(getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`)) ? 'cursor-pointer' : ''
                          ]"
                          @click="['done', 'error', 'nodata'].includes(getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`)) && setCellStatus(type.id, `${city.prvCode}_${city.cityCode}`, 'pending')"
                        >
                          <CheckCircle2 v-if="getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`) === 'done'" :size="16" />
                          <XCircle v-else-if="getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`) === 'error'" :size="16" />
                          <Loader2 v-else-if="getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`) === 'running'" :size="16" class="animate-spin" />
                          <span v-else-if="getCellStatus(type.id, `${city.prvCode}_${city.cityCode}`) === 'nodata'">-</span>
                          <Clock v-else :size="14" />
                        </span>
                      </template>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 日誌 -->
          <div class="bg-slate-900 rounded-xl p-4 max-h-48 overflow-auto">
            <div v-for="(log, i) in logs.slice(0, 50)" :key="i" class="text-xs text-slate-400 font-mono">
              {{ log }}
            </div>
            <div v-if="logs.length === 0" class="text-xs text-slate-600 italic">尚無日誌</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
