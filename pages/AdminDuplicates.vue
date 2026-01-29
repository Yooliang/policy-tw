<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import Hero from '../components/Hero.vue'
import { 
  Users, Trash2, ShieldAlert, CheckCircle2, 
  ExternalLink, Search, RefreshCw, Layers, Check, Loader2
} from 'lucide-vue-next'

const { politicians, fetchAll } = useSupabase()

// --- State ---
const searchTerm = ref('')
const isProcessing = ref(false)
const cecResults = ref<Record<string, any[]>>({}) // { name: [cand_data] }
const loadingCec = ref<Record<string, boolean>>({})

// --- Logic: Find Duplicates ---
const duplicateGroups = computed(() => {
  const groups: Record<string, any[]> = {}
  
  // Group by name
  politicians.value.forEach(p => {
    if (!groups[p.name]) groups[p.name] = []
    groups[p.name].push(p)
  })

  // Filter groups with more than 1 member
  return Object.entries(groups)
    .filter(([name, list]) => list.length > 1 && name.includes(searchTerm.value))
    .map(([name, list]) => {
      // Logic for conflict:
      // 1. Someone is missing birth year (Don't know if they are the same person)
      // 2. Multiple people have the EXACT same birth year (Definitely duplicates)
      const birthYears = list.map(p => p.birthYear).filter(y => !!y)
      const hasMissing = list.some(p => !p.birthYear)
      const hasDuplicateYear = new Set(birthYears).size !== birthYears.length
      const hasConflict = hasMissing || hasDuplicateYear

      return {
        name,
        count: list.length,
        hasConflict,
        list: list.sort((a, b) => (b.birthYear || 0) - (a.birthYear || 0))
      }
    })
})

const totalDuplicates = computed(() => duplicateGroups.value.length)

// --- Actions ---
async function refresh() {
  isProcessing.value = true
  await fetchAll()
  isProcessing.value = false
}

async function verifyWithCec(name: string) {
  loadingCec.value[name] = true
  try {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-cec-data`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ queryName: name })
    })
    const data = await res.json()
    if (data.success && data.cand_data_list) {
      // Deduplicate results by birth year and party since one person might have many election records
      const uniqueCands: any[] = []
      const seen = new Set()
      data.cand_data_list.forEach((c: any) => {
        const key = `${c.cand_birthyear}_${c.party_name}`
        if (!seen.has(key)) {
          uniqueCands.push(c)
          seen.add(key)
        }
      })
      cecResults.value[name] = uniqueCands
    }
  } catch (e) {
    console.error(e)
  } finally {
    loadingCec.value[name] = false
  }
}

async function applyCecIdentity(p: any, cec: any) {
  if (!confirm(`將 ${p.name} 的出生年設定為 ${cec.cand_birthyear}？`)) return
  
  try {
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/update-politician`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        update: {
          id: p.id,
          birthYear: parseInt(cec.cand_birthyear),
          party: cec.party_name
        }
      })
    })
    const result = await response.json()
    if (result.success) {
      alert('已更新身份資訊')
      await fetchAll()
    }
  } catch (e) {
    alert('更新失敗')
  }
}

async function mergeDuplicate(name: string) {
  if (!confirm(`確定要自動合併「${name}」的所有重複項嗎？這將優先保留有出生年的紀錄。`)) return
  
  isProcessing.value = true
  try {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/merge-politicians`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name })
    })
    const result = await res.json()
    if (result.success) {
      alert(result.message)
      await fetchAll()
    } else {
      alert('合併失敗: ' + result.error)
    }
  } catch (e) {
    alert('合併請求失敗')
  } finally {
    isProcessing.value = false
  }
}
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #badge>管理後台</template>
      <template #title>資料核對與清理中心</template>
      <template #description>對接中選會官方資料庫，精確比對出生年與身份，確保政治人物資料的唯一性與準確性。</template>
      <template #icon><ShieldAlert :size="400" class="text-rose-500 opacity-20" /></template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-10 relative z-30">
      <div class="bg-white p-6 rounded-2xl shadow-xl border border-slate-200">
        <div class="flex flex-col md:flex-row justify-between items-center gap-4">
          <div class="flex items-center gap-4">
            <div class="bg-rose-100 text-rose-600 p-3 rounded-xl">
              <Users :size="24" />
            </div>
            <div>
              <h3 class="text-xl font-black text-navy-900">偵測到 {{ totalDuplicates }} 組重複姓名</h3>
              <p class="text-slate-400 text-xs font-bold uppercase tracking-widest">總計 {{ politicians.length }} 位人員</p>
            </div>
          </div>
          
          <div class="flex gap-2 w-full md:w-auto">
            <div class="relative flex-grow">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="16" />
              <input 
                v-model="searchTerm" 
                type="text" 
                placeholder="搜尋姓名..." 
                class="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <button @click="refresh" :disabled="isProcessing" class="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg transition-all">
              <RefreshCw :size="18" :class="{'animate-spin': isProcessing}" />
            </button>
          </div>
        </div>
      </div>

      <!-- List of Duplicate Groups -->
      <div class="mt-8 space-y-12">
        <div v-for="group in duplicateGroups" :key="group.name" class="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden animate-fade-in">
          <div class="px-8 py-6 bg-slate-50 border-b border-slate-100 flex flex-col md:flex-row justify-between gap-6">
            <div class="flex items-center gap-4">
              <span class="text-2xl font-black text-navy-900">{{ group.name }}</span>
              <div class="flex gap-2">
                <span v-if="group.hasConflict" class="bg-rose-100 text-rose-600 px-3 py-1 rounded-full text-xs font-black uppercase tracking-tight">身分衝突 / 待合併</span>
                <span v-else class="bg-blue-100 text-blue-600 px-3 py-1 rounded-full text-xs font-black uppercase tracking-tight">已區分身分 ({{ group.count }} 人)</span>
              </div>
            </div>
            
            <div class="flex gap-3">
              <button 
                @click="verifyWithCec(group.name)" 
                :disabled="loadingCec[group.name]"
                class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 shadow-lg shadow-blue-200 transition-all"
              >
                <Search :size="14" v-if="!loadingCec[group.name]" />
                <Loader2 :size="14" class="animate-spin" v-else />
                中選會官方核對
              </button>
              <button @click="mergeDuplicate(group.name)" :disabled="isProcessing" class="px-4 py-2 bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 rounded-xl text-xs font-bold flex items-center gap-2 transition-all">
                <Layers :size="14" /> 自動合併
              </button>
            </div>
          </div>

          <!-- CEC Reference Area -->
          <div v-if="cecResults[group.name]" class="px-8 py-4 bg-blue-50 border-b border-blue-100 flex flex-wrap gap-4">
            <div class="w-full text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1 flex items-center gap-2">
              <CheckCircle2 :size="12" /> 中選會搜尋結果 (供對照使用)
            </div>
            <div v-for="c in cecResults[group.name]" :key="c.cand_id" class="bg-white p-3 rounded-xl border border-blue-200 shadow-sm flex items-center gap-4">
              <div class="flex flex-col">
                <span class="text-xs font-black text-navy-900">{{ c.cand_birthyear }} 年生</span>
                <span class="text-[10px] text-blue-600 font-bold">{{ c.party_name }}</span>
              </div>
              <div class="text-[10px] text-slate-400 max-w-[150px] leading-tight">
                {{ c.theme_name }} <br/> {{ c.area_data.file_location.area_name }}
              </div>
            </div>
          </div>
          
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-white">
                  <th class="px-8 py-4">目前系統中的資料</th>
                  <th class="px-4 py-4">政黨</th>
                  <th class="px-4 py-4">出生年 / 學歷</th>
                  <th class="px-4 py-4">區域 / 職位</th>
                  <th class="px-4 py-4">抓取來源</th>
                  <th class="px-8 py-4 text-right">符合中選會?</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-50">
                <tr v-for="p in group.list" :key="p.id" class="hover:bg-slate-50/50 transition-colors group">
                  <td class="px-8 py-4">
                    <div class="flex flex-col">
                      <span class="text-[10px] font-mono text-slate-300 mb-1">{{ p.id }}</span>
                      <div class="flex items-center gap-2">
                        <span :class="`w-2 h-2 rounded-full ${p.birthYear ? 'bg-green-500' : 'bg-rose-400'}`"></span>
                        <span class="text-xs font-bold text-navy-900">{{ p.name }}</span>
                      </div>
                    </div>
                  </td>
                  <td class="px-4 py-4">
                    <span class="px-2 py-1 bg-slate-100 rounded text-[11px] font-bold text-slate-600">{{ p.party }}</span>
                  </td>
                  <td class="px-4 py-4">
                    <div class="flex flex-col">
                      <span :class="`text-xs font-bold ${p.birthYear ? 'text-navy-900' : 'text-rose-500 underline decoration-dotted'}`">
                        {{ p.birthYear || '缺失年份' }}
                      </span>
                      <span class="text-[10px] text-slate-400">{{ p.educationLevel || '-' }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-4">
                    <div class="flex flex-col">
                      <span class="text-xs font-bold text-navy-900">{{ p.region }}</span>
                      <span class="text-[10px] text-slate-400">{{ p.electionType || '-' }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-4">
                    <span class="text-[11px] text-slate-500 max-w-[150px] block truncate" :title="p.position">{{ p.position }}</span>
                  </td>
                  <td class="px-8 py-4 text-right">
                    <div class="flex justify-end gap-2">
                      <template v-if="cecResults[group.name]">
                        <button 
                          v-for="cec in cecResults[group.name]" 
                          :key="cec.cand_id"
                          @click="applyCecIdentity(p, cec)"
                          class="p-1.5 hover:bg-blue-600 hover:text-white border border-blue-200 text-blue-600 rounded-lg text-[10px] font-bold transition-all"
                          :title="`標記為 ${cec.cand_birthyear} 生`"
                        >
                          {{ cec.cand_birthyear }}
                        </button>
                      </template>
                      <a :href="`/politician/${p.id}`" target="_blank" class="p-1.5 bg-slate-100 text-slate-400 hover:text-blue-600 rounded-lg transition-colors">
                        <ExternalLink :size="14" />
                      </a>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="duplicateGroups.length === 0" class="bg-white py-20 rounded-3xl border-2 border-dashed border-slate-200 text-center">
          <CheckCircle2 :size="48" class="mx-auto mb-4 text-green-400 opacity-20" />
          <h3 class="text-lg font-bold text-slate-400">目前沒有偵測到任何重複姓名</h3>
          <p class="text-slate-300 text-sm">資料庫非常乾淨！</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.5s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
