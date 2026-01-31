<script setup lang="ts">
import { ref, computed } from 'vue'
import Hero from '../components/Hero.vue'
import AdminNav from '../components/AdminNav.vue'
import { useAuth } from '../composables/useAuth'
import { supabase } from '../lib/supabase'
import * as XLSX from 'xlsx'
import {
  Upload,
  FileSpreadsheet,
  CheckCircle,
  XCircle,
  Loader2,
  User,
  AlertCircle,
  Download,
} from 'lucide-vue-next'

const { isAuthenticated, signInWithGoogle } = useAuth()

// State
const file = ref<File | null>(null)
const parsing = ref(false)
const parseError = ref<string | null>(null)
const parsedData = ref<any[]>([])
const importing = ref(false)
const importProgress = ref(0)
const importResults = ref<{ success: number; failed: number; skipped: number }>({ success: 0, failed: 0, skipped: 0 })
const isDragging = ref(false)

// Election settings
const electionYear = ref(2022)
const electionType = ref('縣市長')
const dataSource = ref('中選會官方資料')

const electionTypes = ['縣市長', '縣市議員', '立法委員', '鄉鎮市長', '村里長']

// Parse ROC date to ISO
function parseROCDate(rocDate: string | null): string | null {
  if (!rocDate || typeof rocDate !== 'string') return null
  const match = rocDate.match(/(\d{2,3})\/(\d{2})\/(\d{2})/)
  if (!match) return null
  const year = parseInt(match[1]) + 1911
  return `${year}-${match[2]}-${match[3]}`
}

function extractBirthYear(rocDate: string | null): number | null {
  if (!rocDate || typeof rocDate !== 'string') return null
  const match = rocDate.match(/(\d{2,3})\//)
  if (!match) return null
  return parseInt(match[1]) + 1911
}

function parseVotes(votes: any): number {
  if (!votes) return 0
  return parseInt(String(votes).replace(/,/g, '')) || 0
}

// Handle drag events
function handleDragOver(event: DragEvent) {
  event.preventDefault()
  isDragging.value = true
}

function handleDragLeave(event: DragEvent) {
  event.preventDefault()
  isDragging.value = false
}

function handleDrop(event: DragEvent) {
  event.preventDefault()
  isDragging.value = false

  const files = event.dataTransfer?.files
  if (files?.length) {
    processFile(files[0])
  }
}

// Handle file selection
async function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files?.length) return
  processFile(input.files[0])
}

async function processFile(selectedFile: File) {
  file.value = selectedFile
  parseError.value = null
  parsedData.value = []

  parsing.value = true

  try {
    const data = await file.value.arrayBuffer()
    const workbook = XLSX.read(data)

    const results: any[] = []

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][]

      // Find header row
      let headerRowIndex = -1
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        if (rows[i]?.some(cell => String(cell).includes('候選人姓名'))) {
          headerRowIndex = i
          break
        }
      }

      if (headerRowIndex === -1) continue

      const headers = rows[headerRowIndex]
      const nameCol = headers.findIndex((h: string) => String(h).includes('候選人姓名'))
      const genderCol = headers.findIndex((h: string) => String(h).includes('性別'))
      const birthCol = headers.findIndex((h: string) => String(h).includes('出生'))
      const partyCol = headers.findIndex((h: string) => String(h).includes('政黨'))
      const votesCol = headers.findIndex((h: string) => String(h).includes('得票'))
      const electedCol = headers.findIndex((h: string) => String(h).includes('當選'))

      for (let i = headerRowIndex + 1; i < rows.length; i++) {
        const row = rows[i]
        if (!row || !row[nameCol]) continue

        const name = String(row[nameCol]).trim()
        if (!name) continue

        results.push({
          region: sheetName,
          name,
          gender: row[genderCol] || null,
          birthDate: parseROCDate(row[birthCol]),
          birthYear: extractBirthYear(row[birthCol]),
          party: row[partyCol] || '無',
          votes: parseVotes(row[votesCol]),
          elected: row[electedCol] === '是',
          selected: true, // Default selected for import
        })
      }
    }

    parsedData.value = results
  } catch (err: any) {
    parseError.value = err.message || '解析檔案失敗'
  } finally {
    parsing.value = false
  }
}

// Toggle selection
function toggleAll(selected: boolean) {
  parsedData.value.forEach(item => item.selected = selected)
}

// Chunk size for batch import (to avoid timeout)
const CHUNK_SIZE = 100

// Import selected candidates in chunks
async function importSelected() {
  const selected = parsedData.value.filter(item => item.selected)
  if (selected.length === 0) {
    alert('請先選擇要匯入的資料')
    return
  }

  importing.value = true
  importProgress.value = 0
  importResults.value = { success: 0, failed: 0, skipped: 0 }

  // Split into chunks
  const chunks: any[][] = []
  for (let i = 0; i < selected.length; i += CHUNK_SIZE) {
    chunks.push(selected.slice(i, i + CHUNK_SIZE))
  }

  const totalChunks = chunks.length
  let completedChunks = 0

  try {
    for (const chunk of chunks) {
      const response = await supabase.functions.invoke('batch-import-candidates', {
        body: {
          election_year: electionYear.value,
          election_type: electionType.value,
          data_source: dataSource.value,
          candidates: chunk.map(c => ({
            name: c.name,
            region: c.region,
            party: c.party,
            birth_year: c.birthYear,
            gender: c.gender,
            votes: c.votes,
            elected: c.elected,
          })),
        },
      })

      if (response.error) {
        console.error('Chunk import error:', response.error)
        importResults.value.failed += chunk.length
      } else {
        const data = response.data
        importResults.value.success += data.success || 0
        importResults.value.failed += data.failed || 0
        importResults.value.skipped += data.skipped || 0

        // Mark imported items
        if (data.imported_names) {
          parsedData.value.forEach(item => {
            if (data.imported_names.includes(item.name)) {
              item.imported = true
              item.selected = false
            }
          })
        }
      }

      completedChunks++
      importProgress.value = Math.round((completedChunks / totalChunks) * 100)
    }

    alert(`匯入完成！成功: ${importResults.value.success}, 略過: ${importResults.value.skipped}, 失敗: ${importResults.value.failed}`)
  } catch (err: any) {
    alert('匯入失敗: ' + (err.message || '未知錯誤'))
  } finally {
    importing.value = false
  }
}

const selectedCount = computed(() => parsedData.value.filter(item => item.selected).length)
const electedCount = computed(() => parsedData.value.filter(item => item.elected).length)

// Expose CHUNK_SIZE for template
const chunkSizeDisplay = CHUNK_SIZE
</script>

<template>
  <div class="bg-slate-50 min-h-screen">
    <Hero>
      <template #title>資料匯入</template>
      <template #description>從中選會 Excel 檔案批次匯入選舉結果</template>
      <template #icon><Upload :size="400" class="text-emerald-500" /></template>

      <AdminNav />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Login Required -->
      <div v-if="!isAuthenticated" class="bg-white p-8 rounded-2xl border border-slate-200 shadow-lg text-center">
        <User :size="48" class="text-slate-400 mx-auto mb-4" />
        <h3 class="text-xl font-bold text-navy-900 mb-2">需要登入</h3>
        <p class="text-slate-600 mb-6">請先登入管理員帳號</p>
        <button @click="signInWithGoogle" class="bg-navy-800 hover:bg-navy-700 text-white font-bold py-3 px-6 rounded-xl">
          使用 Google 登入
        </button>
      </div>

      <!-- 8:4 Layout -->
      <div v-else class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- Left: Results Display (8 cols) -->
        <div class="lg:col-span-8">
          <div class="bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden min-h-[600px]">
            <!-- Header -->
            <div class="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div>
                <h3 class="font-bold text-navy-900">解析結果</h3>
                <p v-if="parsedData.length > 0" class="text-sm text-slate-500">
                  共 {{ parsedData.length }} 筆，已選 {{ selectedCount }} 筆，當選 {{ electedCount }} 人
                </p>
              </div>
              <div v-if="parsedData.length > 0" class="flex gap-2">
                <button @click="toggleAll(true)" class="text-xs px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg">
                  全選
                </button>
                <button @click="toggleAll(false)" class="text-xs px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg">
                  取消
                </button>
                <button
                  @click="importSelected"
                  :disabled="importing || selectedCount === 0"
                  class="text-xs px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded-lg flex items-center gap-1"
                >
                  <Loader2 v-if="importing" :size="14" class="animate-spin" />
                  {{ importing ? '匯入中...' : `匯入 ${selectedCount} 筆` }}
                </button>
                <span v-if="selectedCount > chunkSizeDisplay && !importing" class="text-[10px] text-amber-600 flex items-center gap-1">
                  <AlertCircle :size="10" />
                  將分 {{ Math.ceil(selectedCount / chunkSizeDisplay) }} 批處理
                </span>
              </div>
            </div>

            <!-- Empty State -->
            <div v-if="parsedData.length === 0" class="flex flex-col items-center justify-center py-20 text-center">
              <FileSpreadsheet :size="64" class="text-slate-200 mb-4" />
              <h4 class="text-lg font-medium text-slate-400 mb-2">尚無資料</h4>
              <p class="text-sm text-slate-400">請從右側上傳 Excel 檔案</p>
            </div>

            <!-- Data Table -->
            <div v-else class="max-h-[520px] overflow-auto">
              <table class="w-full text-sm">
                <thead class="bg-slate-50 sticky top-0">
                  <tr>
                    <th class="text-left py-2 px-4 font-medium text-slate-600 w-10">
                      <input type="checkbox" :checked="selectedCount === parsedData.length" @change="toggleAll(($event.target as HTMLInputElement).checked)" />
                    </th>
                    <th class="text-left py-2 px-4 font-medium text-slate-600">地區</th>
                    <th class="text-left py-2 px-4 font-medium text-slate-600">姓名</th>
                    <th class="text-left py-2 px-4 font-medium text-slate-600">政黨</th>
                    <th class="text-left py-2 px-4 font-medium text-slate-600">出生年</th>
                    <th class="text-right py-2 px-4 font-medium text-slate-600">得票數</th>
                    <th class="text-center py-2 px-4 font-medium text-slate-600">當選</th>
                    <th class="text-center py-2 px-4 font-medium text-slate-600">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(item, i) in parsedData" :key="i" :class="['border-b border-slate-100', item.elected ? 'bg-emerald-50/50' : '']">
                    <td class="py-2 px-4">
                      <input type="checkbox" v-model="item.selected" :disabled="item.imported" />
                    </td>
                    <td class="py-2 px-4 text-slate-600">{{ item.region }}</td>
                    <td class="py-2 px-4 font-medium text-navy-900">{{ item.name }}</td>
                    <td class="py-2 px-4">
                      <span class="px-2 py-0.5 bg-slate-100 rounded text-xs">{{ item.party }}</span>
                    </td>
                    <td class="py-2 px-4 text-slate-600">{{ item.birthYear || '-' }}</td>
                    <td class="py-2 px-4 text-right font-mono text-slate-600">{{ item.votes?.toLocaleString() }}</td>
                    <td class="py-2 px-4 text-center">
                      <CheckCircle v-if="item.elected" :size="16" class="text-emerald-500 mx-auto" />
                      <XCircle v-else :size="16" class="text-slate-300 mx-auto" />
                    </td>
                    <td class="py-2 px-4 text-center">
                      <span v-if="item.imported" class="text-xs text-emerald-600 flex items-center justify-center gap-1">
                        <CheckCircle :size="12" /> 已匯入
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Right: Settings & Upload (4 cols) -->
        <div class="lg:col-span-4 space-y-4">
          <!-- Settings -->
          <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h3 class="text-sm font-bold text-navy-900">匯入設定</h3>
            <div>
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">選舉年份</label>
              <input v-model.number="electionYear" type="number" min="2000" max="2030" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">選舉類型</label>
              <select v-model="electionType" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                <option v-for="t in electionTypes" :key="t" :value="t">{{ t }}</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 uppercase mb-1">資料來源</label>
              <input v-model="dataSource" type="text" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            </div>
          </div>

          <!-- File Upload -->
          <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <h3 class="text-sm font-bold text-navy-900 mb-3">上傳檔案</h3>

            <label
              @dragover="handleDragOver"
              @dragleave="handleDragLeave"
              @drop="handleDrop"
              :class="[
                'flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-colors',
                isDragging
                  ? 'border-emerald-500 bg-emerald-50'
                  : 'border-slate-300 hover:bg-slate-50'
              ]"
            >
              <div class="flex flex-col items-center justify-center">
                <FileSpreadsheet :size="32" :class="isDragging ? 'text-emerald-500' : 'text-slate-400'" class="mb-2" />
                <p class="text-xs text-slate-500">
                  <span class="font-semibold">點擊上傳</span> 或拖曳檔案
                </p>
                <p class="text-[10px] text-slate-400">.xls, .xlsx</p>
              </div>
              <input type="file" class="hidden" accept=".xls,.xlsx" @change="handleFileSelect" />
            </label>

            <div v-if="file" class="mt-3 flex items-center gap-2 text-xs bg-slate-50 p-2 rounded-lg">
              <FileSpreadsheet :size="16" class="text-emerald-500 shrink-0" />
              <span class="font-medium truncate">{{ file.name }}</span>
              <span class="text-slate-400 shrink-0">({{ (file.size / 1024).toFixed(1) }} KB)</span>
            </div>

            <div v-if="parsing" class="mt-3 flex items-center gap-2 text-xs text-slate-500">
              <Loader2 :size="14" class="animate-spin" />
              解析中...
            </div>

            <div v-if="parseError" class="mt-3 bg-red-50 border border-red-200 rounded-lg p-2 flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle :size="14" />
              {{ parseError }}
            </div>
          </div>

          <!-- Import Progress -->
          <div v-if="importing" class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <h3 class="text-sm font-bold text-navy-900 mb-3">匯入進度</h3>
            <div class="space-y-3">
              <div class="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div
                  class="h-full bg-emerald-500 transition-all duration-300"
                  :style="{ width: `${importProgress}%` }"
                ></div>
              </div>
              <div class="flex justify-between text-xs text-slate-500">
                <span>{{ importProgress }}%</span>
                <span>每批 {{ chunkSizeDisplay }} 筆</span>
              </div>
              <div class="text-xs text-slate-600 space-y-1">
                <div>✓ 成功: {{ importResults.success }}</div>
                <div>⊘ 略過: {{ importResults.skipped }}</div>
                <div>✗ 失敗: {{ importResults.failed }}</div>
              </div>
            </div>
          </div>

          <!-- Import Results -->
          <div v-else-if="importResults.success > 0 || importResults.failed > 0" class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <h3 class="text-sm font-bold text-navy-900 mb-3">匯入結果</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-slate-600">成功</span>
                <span class="font-medium text-emerald-600">{{ importResults.success }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-slate-600">略過（已存在）</span>
                <span class="font-medium text-slate-500">{{ importResults.skipped }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-slate-600">失敗</span>
                <span class="font-medium text-red-600">{{ importResults.failed }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
