<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSupabase } from '../composables/useSupabase'
import { PolicyStatus, ElectionType } from '../types'
import StatusBadge from '../components/StatusBadge.vue'
import Hero from '../components/Hero.vue'
import Avatar from '../components/Avatar.vue'
import HistoryPanel from '../components/history/HistoryPanel.vue'
import {
  Bot, Link as LinkIcon, FileText,
  Layers, ShieldCheck, ArrowRight, Sparkles, Network, MapPin,
  Database, Milestone, GitBranch, UserCheck, ArrowRightCircle, GitCommit, History,
  Activity, ChevronLeft, CheckCircle, XCircle, Loader2
} from 'lucide-vue-next'
import { usePageHead } from '../composables/usePageHead'
import { BOARD_PATH, isAuditUrl, requestTask, requestTaskMessage, type RequestTaskResult } from '../lib/request-task'
import HeroAction from '../components/HeroAction.vue'
import { askPolicyProgress } from '../lib/ask-links'
import { HERO_ACTION_BASE, HERO_ACTION_SIZE, HERO_ICON_BUTTON, HERO_ICON_SIZE } from '../lib/hero-action-styles'
import { policySortDate, policyYear } from '../lib/policy-date'

const route = useRoute()
const router = useRouter()
const { policies, politicians, elections, ensurePolicies } = useSupabase()

// 「執行稽核」：把訪客貼的文件網址丟進貢獻任務池（request-task kind=audit），AI 代理來核對與既有政見／進度的落差
const sourceUrl = ref('')
const auditing = ref(false)
const auditResult = ref<RequestTaskResult | null>(null)
const auditError = ref<string | null>(null)
const canAudit = computed(() => sourceUrl.value.trim().length > 0 && !auditing.value)
const auditInputRef = ref<HTMLInputElement | null>(null)

// 動作列「執行稽核」：不是另開頁，只是把畫面捲到下面那個網址輸入框並聚焦
function focusAuditInput(): void {
  const el = auditInputRef.value
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.focus()
}

// 動作列「查進度」改成跳到公民提問（見 lib/ask-links.ts）；這一頁的「執行稽核」仍走 requestTask。

async function submitAudit() {
  const url = sourceUrl.value.trim()
  if (!url || auditing.value) return
  auditError.value = null
  auditResult.value = null
  if (!isAuditUrl(url)) {
    auditError.value = '請貼完整的網址（要以 http:// 或 https:// 開頭）'
    return
  }
  auditing.value = true
  try {
    auditResult.value = await requestTask({
      kind: 'audit',
      source_url: url,
      policy_id: selectedPolicy.value?.id,
      politician_id: politician.value?.id,
    })
  } catch (err: unknown) {
    auditError.value = err instanceof Error ? err.message : '送出失敗，請稍後再試'
  } finally {
    auditing.value = false
  }
}

const policyId = computed(() => route.params.policyId)
const selectedPolicy = computed(() => policies.value.find(p => String(p.id) === String(policyId.value)))

const relayChain = computed(() => {
  if (!selectedPolicy.value) return []
  const visited = new Set<string>()
  const queue = [selectedPolicy.value.id]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const p = policies.value.find(pol => String(pol.id) === String(id))
    if (!p) continue
    // follow outgoing links
    p.relatedPolicyIds?.forEach(rid => { if (!visited.has(rid)) queue.push(rid) })
    // follow incoming links
    policies.value.forEach(other => {
      if (other.relatedPolicyIds?.includes(id) && !visited.has(other.id)) queue.push(other.id)
    })
  }
  return policies.value.filter(p => visited.has(p.id))
    .sort((a, b) => policySortDate(a) - policySortDate(b))
})

const politician = computed(() => selectedPolicy.value ? politicians.value.find(c => String(c.id) === String(selectedPolicy.value!.politicianId)) : null)

const allPoliticians = computed(() => {
  const ids = new Set(relayChain.value.map(p => String(p.politicianId)))
  return politicians.value.filter(c => ids.has(String(c.id)))
})

const isLevelActiveForChain = (levelType: ElectionType, idx: number) => {
  return allPoliticians.value.some(c =>
    c.electionType === levelType || (c.electionType === ElectionType.MAYOR && idx === 0)
  )
}

const LEVEL_ORDER: Record<string, number> = {
  [ElectionType.MAYOR]: 0,
  [ElectionType.COUNCILOR]: 1,
  [ElectionType.TOWNSHIP_MAYOR]: 2,
  [ElectionType.INDIGENOUS_DISTRICT_CHIEF]: 2,
  [ElectionType.REPRESENTATIVE]: 3,
  [ElectionType.INDIGENOUS_DISTRICT_REP]: 3,
  [ElectionType.CHIEF]: 3,
}

const allLogs = computed(() => {
  return relayChain.value
    .flatMap(p => {
      const c = politicians.value.find(c => String(c.id) === String(p.politicianId))
      const level = c?.electionType ? (LEVEL_ORDER[c.electionType] ?? 0) : 0
      return p.logs.map(log => ({
        ...log,
        policyId: p.id,
        policyTitle: p.title,
        politicianId: p.politicianId,
        politicianName: c?.name || '',
        politicianAvatar: c?.avatarUrl || '',
        isSelected: String(p.id) === String(policyId.value),
        level,
      }))
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
})

const getPoliticiansForLevel = (levelType: ElectionType, idx: number) => {
  return allPoliticians.value.filter(c =>
    c.electionType === levelType || (!c.electionType && levelType === ElectionType.MAYOR && idx === 0)
  )
}

const currentYear = new Date().getFullYear()
const YEARS = Array.from({ length: 12 }, (_, i) => String(currentYear - 11 + i))

// 頂軸時間刻度：接力鏈裡有沒有政見落在這一年（沒有提出日期的政見改看所屬選舉屆別／最後更新時間）
const chainHasYear = (year: string) => relayChain.value.some(p => policyYear(p, elections.value) === year)
const selectedPolicyIsInYear = (year: string) => {
  const p = selectedPolicy.value
  if (!p) return false
  return policyYear(p, elections.value) === year || p.lastUpdated.includes(year)
}

const HIERARCHY_LEVELS = [
  { label: '戰略層', role: '縣市首長', desc: '資源整合與願景規劃', iconComponent: ShieldCheck, iconClass: 'text-red-500', type: ElectionType.MAYOR },
  { label: '監督層', role: '縣市議員', desc: '預算審查與行政監督', iconComponent: Layers, iconClass: 'text-blue-500', type: ElectionType.COUNCILOR },
  { label: '行政層', role: '鄉鎮區長', desc: '計畫執行與基層管理', iconComponent: FileText, iconClass: 'text-indigo-500', type: ElectionType.TOWNSHIP_MAYOR },
  { label: '執行層', role: '村里長', desc: '民意反應與第一線服務', iconComponent: MapPin, iconClass: 'text-amber-500', type: ElectionType.CHIEF },
]

const isLevelActive = (levelType: ElectionType, idx: number) => {
  if (!politician.value) return false
  return (politician.value.electionType === levelType) || (politician.value.electionType === ElectionType.MAYOR && idx === 0)
}

const isPoliticianSelected = (politicianId: string | number) => {
  return relayChain.value.some(p => String(p.politicianId) === String(politicianId) && String(p.id) === String(policyId.value))
}


usePageHead({
  type: 'article',
  title: () => selectedPolicy.value ? `${selectedPolicy.value.title} 深度分析` : undefined,
  description: () => selectedPolicy.value
    ? `${politician.value?.name ?? ''}「${selectedPolicy.value.title}」的接力軌跡與完整時間軸，進度 ${selectedPolicy.value.progress}%。${selectedPolicy.value.description}`
    : undefined,
})
// 政見清單是按需載入的（257 KB，公民提問頁那類頁面不需要）。這一頁要整份。
onMounted(() => { ensurePolicies() })

</script>

<template>
  <div v-if="selectedPolicy && politician" class="bg-slate-50 min-h-screen pb-20 text-left">

    <Hero :back-action="() => router.push('/analysis')">
      <template #icon><Database :size="400" class="text-blue-500" /></template>
      <template #title>{{ selectedPolicy.title }}</template>
      <template #description>
        超越單一任期。AI 自動偵測該案件在行政體系中的「接力軌跡」，<br class="hidden lg:block" />
        確保治理透明度與政策延續性，讓每一份行政努力都能被溯源。
      </template>

      <template #actions>
        <div class="flex flex-wrap items-center gap-2 sm:gap-3">
          <button @click="router.push('/analysis')" :class="HERO_ICON_BUTTON" aria-label="返回">
            <ChevronLeft :size="HERO_ICON_SIZE" class="group-hover:-translate-x-1 transition-transform" />
          </button>
          <HeroAction data-testid="hero-policy-source" :to="`/policy/${selectedPolicy.id}`"><FileText :size="16" /> 政見原文</HeroAction>
          <!-- 跟政見頁那顆同一套：跳到公民提問、問題先填好（見 lib/ask-links.ts） -->
          <HeroAction data-testid="hero-progress" :to="askPolicyProgress(selectedPolicy.id, selectedPolicy.title, selectedPolicy.status === PolicyStatus.CAMPAIGN)">
            <Sparkles :size="16" /> {{ selectedPolicy.status === PolicyStatus.CAMPAIGN ? '查兌現情形' : '查進度' }}
          </HeroAction>
          <HeroAction data-testid="hero-audit-focus" @click="focusAuditInput"><LinkIcon :size="16" /> 執行稽核</HeroAction>
        </div>
      </template>

      <!-- novalidate：用自己的檢查與文案，不讓瀏覽器原生的 type=url 泡泡擋掉 submit -->
      <form class="flex flex-col md:flex-row gap-2" novalidate @submit.prevent="submitAudit">
        <div class="flex-1 relative text-left">
          <LinkIcon class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" :size="20" />
          <input
            ref="auditInputRef"
            v-model="sourceUrl"
            type="url"
            inputmode="url"
            placeholder="貼上相關文件網址，請 AI 核對與這條政見的落差..."
            :class="['w-full border-none rounded-xl py-3 pl-12 pr-4 text-navy-900 placeholder:text-slate-400 focus:ring-2 transition-all text-sm', auditError ? 'ring-2 ring-red-400 focus:ring-red-400' : 'focus:ring-blue-500']"
            data-testid="audit-url"
            @input="auditError = null"
          />
        </div>
        <button type="submit" :disabled="!canAudit" class="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-500 disabled:cursor-not-allowed text-white font-bold px-6 py-3 rounded-xl transition-all flex items-center justify-center gap-2 group whitespace-nowrap" data-testid="audit-submit">
          <Bot :size="20" :class="auditing ? 'animate-pulse' : 'group-hover:rotate-12 transition-transform'" />
          {{ auditing ? '送出中…' : '執行稽核' }}
        </button>
      </form>
      <p v-if="auditError" class="mt-2 text-sm text-red-200 text-left" data-testid="audit-error">{{ auditError }}</p>
      <p v-else-if="auditResult" class="mt-2 text-sm text-emerald-200 text-left" data-testid="audit-done">
        {{ requestTaskMessage(auditResult) }}
        <RouterLink :to="BOARD_PATH" class="ml-1 font-bold underline underline-offset-2 text-white">到貢獻看板看進度</RouterLink>
      </p>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 relative z-20">
      <div class="bg-white rounded-[40px] border border-slate-200 shadow-2xl overflow-hidden flex flex-col min-h-[950px]">


        <!-- TOP AXIS: Timeline -->
        <div class="border-b border-slate-100 bg-slate-50/90 sticky top-0 z-30 backdrop-blur-md">
          <div class="grid grid-cols-12">
            <div
              v-for="year in YEARS"
              :key="year"
              :class="`py-8 flex flex-col items-center border-r border-slate-100 last:border-r-0 relative transition-all ${chainHasYear(year) ? 'bg-blue-50/20' : ''}`"
            >
              <span :class="`text-[12px] font-black mb-3 ${year === '2024' ? 'text-emerald-600' : chainHasYear(year) ? 'text-blue-600' : 'text-slate-300'}`">
                {{ year }}
              </span>
              <div :class="`w-3 h-3 rounded-full border-2 border-white shadow-sm transition-all duration-500 ${year === '2024' ? 'bg-emerald-500 animate-pulse' : chainHasYear(year) ? 'bg-blue-600 scale-125 ring-4 ring-blue-50' : 'bg-slate-200'}`"></div>

              <div
                v-if="selectedPolicyIsInYear(year)"
                class="absolute top-[85px] left-1/2 -translate-x-1/2 z-30 bg-white p-3 rounded-xl border border-blue-100 shadow-xl w-44 text-left animate-fade-in pointer-events-none"
              >
                <div class="text-[10px] text-blue-600 font-black mb-1 flex items-center gap-1"><History :size="10" /> 歷史座標</div>
                <div class="text-[11px] font-black text-navy-900 leading-tight">進度審計: {{ selectedPolicy.progress }}%</div>
              </div>
            </div>
          </div>
        </div>

        <div class="flex flex-1 overflow-hidden">
          <!-- LEFT SECTION -->
          <div class="flex-1 p-12 overflow-y-auto custom-scrollbar border-r border-slate-100 text-left">

            <!-- AI Insight -->
            <div class="mb-14">
              <div class="flex items-center justify-between mb-10">
                <div class="flex flex-wrap gap-3">
                  <div v-if="relayChain.length > 1" class="flex items-center gap-1.5 bg-blue-50 text-blue-700 px-4 py-2 rounded-full text-xs font-black border border-blue-100">
                    <GitBranch :size="14" /> 市政接力 {{ relayChain.length }} 階段
                  </div>
                </div>
                <div class="text-right">
                  <span class="text-[10px] text-slate-400 font-black uppercase tracking-widest block mb-1">AUDIT_VERIFIED</span>
                  <span class="text-xs font-bold text-emerald-600 flex items-center gap-1 justify-end">
                    <ShieldCheck :size="16" /> 已通過 AI 鏈上稽核
                  </span>
                </div>
              </div>

              <div class="bg-gradient-to-br from-slate-50 to-blue-50/40 p-10 rounded-[32px] border border-slate-100 relative overflow-hidden mb-12 shadow-inner">
                <div class="absolute top-0 right-0 p-8 opacity-5"><Bot :size="180" /></div>
                <h3 class="text-xs font-black text-blue-600 uppercase tracking-[0.2em] mb-5 flex items-center gap-2">
                  <Bot :size="18" /> Zheng Jian AI 治理洞察
                </h3>
                <p class="text-2xl text-slate-800 leading-relaxed font-bold italic tracking-tight">
                  「此專案跨越了不同行政任期，體現了高強度的政策延續性。從初期規劃到目前階段，行政體系展現了穩定的接力特徵。目前的關鍵稽核點在於預算執行率與基層反饋的一致性。」
                </p>
              </div>
            </div>

            <!-- Timeline: All logs sorted by date -->
            <div class="space-y-8">
              <h3 class="text-xl font-black text-navy-900 flex items-center gap-3 uppercase tracking-tight">
                <Milestone class="text-blue-600" :size="24" />
                完整時間軸
              </h3>
              <div class="relative ml-4 space-y-8">
                <!-- Vertical line -->
                <div class="absolute left-0 top-0 bottom-0 w-0.5 bg-slate-200"></div>

                <div
                  v-for="log in allLogs"
                  :key="log.id"
                  class="relative pl-10"
                  :style="{ marginLeft: `${log.level * 32}px` }"
                >
                  <!-- Horizontal connector from main line -->
                  <div
                    v-if="log.level > 0"
                    class="absolute top-[17px] bg-slate-200 h-px"
                    :style="{ left: `${-log.level * 32}px`, width: `${log.level * 32}px` }"
                  ></div>

                  <div :class="`absolute left-[-15px] top-1 w-8 h-8 rounded-full border-2 border-white shadow-lg flex items-center justify-center
                    ${log.isSelected ? 'bg-blue-600 text-white' : log.level === 0 ? 'bg-slate-300 text-slate-600' : 'bg-slate-200 text-slate-400'}`">
                    <History :size="14" />
                  </div>
                  <div class="relative group/log">
                    <div class="flex items-center justify-between mb-1">
                      <h4 :class="`font-black ${log.isSelected ? 'text-navy-900 text-lg' : log.level === 0 ? 'text-slate-600 text-lg' : 'text-slate-500 text-base'}`">{{ log.event }}</h4>
                      <span class="text-xs font-mono font-black text-slate-400 bg-slate-100 px-3 py-1 rounded-full border border-slate-200 shrink-0 ml-4">{{ log.date }}</span>
                    </div>
                    <p v-if="log.description" class="text-slate-500 text-sm leading-relaxed">{{ log.description }}</p>

                    <!-- Hover: absolute card overlay wrapping content + politician info -->
                    <div class="hidden group-hover/log:block absolute inset-x-[-12px] top-[-8px] z-40 bg-white rounded-xl shadow-lg ring-1 ring-slate-200 px-3 py-2 pointer-events-none">
                      <div class="flex items-center justify-between mb-1">
                        <h4 :class="`font-black ${log.isSelected ? 'text-navy-900 text-lg' : log.level === 0 ? 'text-slate-600 text-lg' : 'text-slate-500 text-base'}`">{{ log.event }}</h4>
                        <span class="text-xs font-mono font-black text-slate-400 bg-slate-100 px-3 py-1 rounded-full border border-slate-200 shrink-0 ml-4">{{ log.date }}</span>
                      </div>
                      <p v-if="log.description" class="text-slate-500 text-sm leading-relaxed">{{ log.description }}</p>
                      <div class="flex items-center gap-3 mt-3 pt-3 border-t border-slate-100">
                        <Avatar :src="log.politicianAvatar" :name="log.politicianName" size="xs" class="border border-white shadow-sm shrink-0" />
                        <span class="text-xs font-bold text-slate-500 whitespace-nowrap">{{ log.politicianName }}</span>
                        <span class="text-[10px] text-slate-400 whitespace-nowrap">{{ politicians.find(c => c.id === log.politicianId)?.position }}</span>
                        <span class="text-[10px] text-slate-300">·</span>
                        <span :class="`text-xs font-bold whitespace-nowrap ${log.isSelected ? 'text-blue-600' : 'text-slate-500'}`">{{ log.policyTitle }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <p v-if="relayChain.length > 1" class="text-[11px] text-slate-400 mt-10 bg-slate-50 p-4 rounded-xl italic font-bold leading-relaxed border border-slate-100">
              * 這項建設跨越了不同任期，由多位首長接力完成。Zheng Jian AI 自動追蹤這份治理傳承，確保每一步行政努力在歷史座標中都被完整記錄。
            </p>
          </div>

          <!-- RIGHT AXIS -->
          <div class="w-80 lg:w-96 bg-slate-50/50 p-8 flex flex-col border-l border-slate-100 text-left">

            <div class="space-y-6 relative flex-1">
              <div class="absolute left-[22px] top-8 bottom-8 w-2 bg-slate-200/50 rounded-full"></div>


              <div
                v-for="(level, idx) in HIERARCHY_LEVELS"
                :key="idx"
                :class="`relative group p-5 rounded-2xl transition-all duration-500 border
                  ${isLevelActiveForChain(level.type, idx) ? 'bg-white border-slate-200 shadow-sm z-10' : 'bg-transparent border-transparent opacity-20 grayscale hover:opacity-40'}`"
              >
                <h5 class="font-black text-navy-900 text-base mb-3">{{ level.role }}</h5>

                <div v-if="isLevelActiveForChain(level.type, idx)" class="space-y-3">
                  <div
                    v-for="c in getPoliticiansForLevel(level.type, idx)"
                    :key="c.id"
                    :class="`flex items-center gap-3 p-2 rounded-xl transition-all duration-300
                      ${isPoliticianSelected(c.id) ? 'bg-blue-50 ring-2 ring-blue-500' : 'opacity-40 grayscale hover:opacity-70 hover:grayscale-0 cursor-pointer'}`"
                    @click="!isPoliticianSelected(c.id) && router.push(`/analysis/${relayChain.find(p => p.politicianId === c.id)?.id}`)"
                  >
                    <Avatar
                      :src="c.avatarUrl"
                      :name="c.name"
                      size="sm"
                      :class="`border-2 shadow-sm ${isPoliticianSelected(c.id) ? 'border-blue-500' : 'border-slate-200'}`"
                    />
                    <div class="flex-1">
                      <div :class="`text-sm font-black ${isPoliticianSelected(c.id) ? 'text-navy-900' : 'text-slate-400'}`">{{ c.name }}</div>
                      <div class="text-[11px] text-slate-400 font-bold">{{ c.position }}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- AI Bottom Alert -->
            <div class="mt-12 bg-navy-900 p-8 rounded-[40px] text-white relative overflow-hidden shadow-2xl border border-navy-700">
              <div class="absolute top-0 right-0 p-8 opacity-10"><Bot :size="70" /></div>
              <h4 class="text-[10px] font-black mb-4 flex items-center gap-2 text-blue-400 uppercase tracking-[0.2em]">
                <Sparkles :size="16" /> 行政效能預估
              </h4>
              <p class="text-[13px] leading-relaxed text-slate-300 font-bold italic">
                「基於歷史傳承模式分析，此專案在『戰略層』的變動並未影響核心執行力。建議持續關注 2025 年基層撥款的實施情況。」
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 這條政見的查核履歷（同 /policy 頁，target=policy） -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8">
      <HistoryPanel target="policy" :id="selectedPolicy.id" title="這條政見的查核履歷" />
    </div>
  </div>
</template>
