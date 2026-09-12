<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import Hero from '../components/Hero.vue'
import AdminNav from '../components/AdminNav.vue'
import {
  Users, Trash2, ShieldAlert, CheckCircle2,
  ExternalLink, Search, RefreshCw, Layers, Check, Loader2
} from 'lucide-vue-next'
import { usePageHead } from '../composables/usePageHead'

const { politicians, fetchAll } = useSupabase()

// --- State ---
const searchTerm = ref('')
const isProcessing = ref(false)

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

usePageHead({ title: '後台重複資料', noindex: true })
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>重複資料清理</template>
      <template #description>比對出生年與身份，確保政治人物資料的唯一性與準確性</template>
      <template #icon><ShieldAlert :size="400" class="text-rose-500" /></template>

      <AdminNav />
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
            
            <!-- 原本這裡有「中選會官方核對」與「自動合併」兩顆按鈕，2026-09-12 移除。
                 核對那顆送的參數對應的函式不認，按下去無聲失敗；合併那顆只比對姓名，
                 會把同名的不同人併成一筆，而且是不可逆的刪除。設計見
                 docs/BLUEPRINT-admin-to-tasks.md，重做成可逆並排成任務之後再開放。 -->
            <p class="text-xs text-slate-400 max-w-sm text-right leading-relaxed">
              合併功能正在重做。舊版只看姓名相同就合併，會把同名的不同人併成一個，而且刪掉救不回來。
            </p>
          </div>

          <!-- 中選會核對結果區塊隨核對按鈕一併移除（2026-09-12） -->
          
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
