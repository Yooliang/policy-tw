<script setup lang="ts">
import { computed } from 'vue'
import { useSupabase } from '../../composables/useSupabase'
import { ElectionType, type Policy } from '../../types'
import { ArrowDown } from 'lucide-vue-next'
import Avatar from '../../components/Avatar.vue'
import { issueTagsOf } from '../../lib/issue-tags'
import { comparePersonName } from '../../lib/person-name'
import { compareByPolicyDateDesc } from '../../lib/policy-date'

type LevelPolitician = { id: string | number; name: string; avatarUrl?: string | null; electionType?: string | null }
const props = defineProps<{
  tag: string
  policies: Policy[]
  /** 已套上本屆資料的候選人（ElectionPage 的 withCurrentElectionData）：分層要看「本屆」的層級，不是人物最近一屆的。沒傳就退回全域人物（舊的 Election2026 頁） */
  electionPoliticians?: LevelPolitician[]
  /** 不是議題的名字（候選人名＋鄉鎮名），跟 ElectionPage 的標籤列同一份；沒傳就只用候選人名 */
  junkNames?: Set<string>
}>()

const { politicians } = useSupabase()

const levelPoliticians = computed<LevelPolitician[]>(() => props.electionPoliticians ?? politicians.value)
const byId = computed(() => new Map(levelPoliticians.value.map(c => [String(c.id), c])))
const names = computed(() => props.junkNames ?? new Set(levelPoliticians.value.map(c => c.name)))
const politicianOf = (p: Policy): LevelPolitician | undefined =>
  byId.value.get(String(p.politicianId)) ?? politicians.value.find(c => String(c.id) === String(p.politicianId))

// 層內照人的姓名筆畫、同一人新到舊（2026-10-19 維護者「至少依某個規則」；之前是資料庫 id＝隨機順序）
const byPerson = (a: Policy, b: Policy) =>
  comparePersonName(politicianOf(a)?.name ?? '', politicianOf(b)?.name ?? '') ||
  String(a.politicianId).localeCompare(String(b.politicianId)) ||
  compareByPolicyDateDesc(a, b)
const getPoliciesByLevel = (type: ElectionType) =>
  props.policies.filter(p =>
    issueTagsOf(p, names.value).includes(props.tag) &&
    byId.value.get(String(p.politicianId))?.electionType === type
  )

const mayors = computed(() => getPoliciesByLevel(ElectionType.MAYOR).sort(byPerson))
const councilors = computed(() => getPoliciesByLevel(ElectionType.COUNCILOR).sort(byPerson))
const adminLevel = computed(() => [
  ...getPoliciesByLevel(ElectionType.TOWNSHIP_MAYOR),
  ...getPoliciesByLevel(ElectionType.INDIGENOUS_DISTRICT_CHIEF)
].sort(byPerson))
const commLevel = computed(() => [
  ...getPoliciesByLevel(ElectionType.REPRESENTATIVE),
  ...getPoliciesByLevel(ElectionType.INDIGENOUS_DISTRICT_REP)
].sort(byPerson))
const chiefs = computed(() => getPoliciesByLevel(ElectionType.CHIEF).sort(byPerson))

const levels = computed(() => [
  { label: '縣市長', colorBorder: 'border-red-400', colorBg: 'bg-red-100 text-red-700', items: mayors.value, cols: 'grid-cols-1 md:grid-cols-2', emptyMsg: '縣市長層級尚未針對此議題表態。' },
  { label: '議員', colorBorder: 'border-blue-400', colorBg: 'bg-blue-100 text-blue-700', items: councilors.value, cols: 'grid-cols-1 md:grid-cols-2', emptyMsg: '尚無議員針對此議題提出質詢或預算案。' },
  { label: '鄉長/區長', colorBorder: 'border-indigo-400', colorBg: 'bg-indigo-100 text-indigo-700', items: adminLevel.value, cols: 'grid-cols-1 md:grid-cols-2', emptyMsg: '尚無行政首長層級的規劃。' },
  { label: '代表', colorBorder: 'border-green-400', colorBg: 'bg-green-100 text-green-700', items: commLevel.value, cols: 'grid-cols-1 md:grid-cols-2', emptyMsg: '尚無地方代表層級的具體建議。' },
  { label: '里長', colorBorder: 'border-amber-400', colorBg: 'bg-amber-100 text-amber-700', items: chiefs.value, cols: 'grid-cols-1 md:grid-cols-2', emptyMsg: '尚無里長層級的具體建議。' },
])
</script>

<template>
  <div class="border border-slate-200 rounded-2xl bg-white shadow-sm overflow-hidden animate-fade-in">
    <div class="bg-slate-50 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="text-2xl font-bold text-navy-900">#{{ tag }}</span>
        <span class="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs font-bold">議題垂直分析</span>
      </div>
    </div>

    <!-- 層級高度跟著內容（2026-10-19）：直排字改成絕對定位填滿色塊、不再撐高整列；格子 items-start 不把卡片拉長 -->
    <!-- 寬螢幕：層級名直排、色塊上下相連，相鄰兩塊交界處放白底向下箭頭（2026-10-19 維護者）；手機維持橫的膠囊 -->
    <div class="p-6 flex flex-col gap-6 md:gap-0">
      <template v-for="(level, levelIdx) in levels" :key="level.label">
        <div class="flex flex-col md:flex-row gap-4 md:gap-5">
          <div class="relative w-full md:w-9 shrink-0 flex flex-col items-center justify-center md:self-stretch">
            <span :class="`${level.colorBg} px-3 py-1 rounded-full text-xs font-bold block w-full text-center md:px-0 md:py-2 md:absolute md:inset-0 md:overflow-hidden md:flex md:items-center md:justify-center md:text-xs md:tracking-normal md:[writing-mode:vertical-rl] md:[text-orientation:upright] ${levelIdx === 0 ? 'md:rounded-b-none' : levelIdx === levels.length - 1 ? 'md:rounded-t-none' : 'md:rounded-none'}`">{{ level.label }}</span>
            <div v-if="levelIdx > 0" class="hidden md:flex absolute -top-3 left-1/2 -translate-x-1/2 z-10 w-6 h-6 rounded-full bg-white shadow ring-1 ring-slate-200 items-center justify-center text-slate-500"><ArrowDown :size="14" /></div>
          </div>
          <div :class="`flex-1 grid ${level.cols} gap-4 text-left items-start content-start md:py-3`">
            <template v-if="level.items.length > 0">
              <router-link
                v-for="p in level.items"
                :key="p.id"
                :to="`/policy/${p.id}`"
                :class="`block bg-white border-l-4 ${level.colorBorder} shadow-sm border-y border-r border-slate-100 p-4 rounded-r-lg hover:shadow-md cursor-pointer transition-all`"
              >
                <div class="flex items-center gap-2 mb-2">
                  <Avatar :src="politicianOf(p)?.avatarUrl" :name="politicianOf(p)?.name || ''" size="xs" />
                  <span class="text-sm font-bold text-navy-900">{{ politicianOf(p)?.name }}</span>
                </div>
                <h4 class="font-bold text-sm text-navy-900 line-clamp-2">{{ p.title }}</h4>
              </router-link>
            </template>
            <div v-else class="text-slate-400 text-sm italic py-4">{{ level.emptyMsg }}</div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
