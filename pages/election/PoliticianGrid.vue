<script setup lang="ts">
import PartyBadge from '../../components/PartyBadge.vue'
import { ref, computed } from 'vue'
import { useSupabase } from '../../composables/useSupabase'
import { PolicyStatus, type Politician, type CandidateStatus } from '../../types'
import { ArrowRight, Megaphone, ChevronDown, ChevronUp } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import Avatar from '../../components/Avatar.vue'

const props = defineProps<{
  politicians: Politician[]
  title: string
  columns?: 2 | 3
  /**
   * 這一頁是哪一屆選舉。有給就只算那一屆的政見。
   * 2026-09-17：「這個頁面的政見應該顯示當屆的就好」，並拍板「純嚴格」——
   * 蔡易餘卡片上原本寫 18 項，實際上 2026 只有 2 項、2024 有 2 項、其餘 14 項沒標屆別。
   * 未標屆別的不算進來：那是「政見缺屆別」的資料缺口，不是當屆政見。
   */
  electionId?: number
}>()

// Grid classes based on columns prop
const gridClasses = computed(() => {
  if (props.columns === 2) {
    return 'grid grid-cols-1 md:grid-cols-2 gap-6'
  }
  return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6'
})

const router = useRouter()
const { policies } = useSupabase()
const collapsed = ref(false)

const getPledgeCount = (politicianId: string | number) =>
  policies.value.filter(p =>
    String(p.politicianId) === String(politicianId) &&
    p.status === PolicyStatus.CAMPAIGN &&
    (props.electionId === undefined || p.electionId === props.electionId)
  ).length

// 參選狀態顯示（選舉前中後三階段）
const candidateStatusLabel = (status?: CandidateStatus) => {
  switch (status) {
    case 'confirmed': return null  // 已確認參選不需特別標註
    case 'registered': return '已登記'
    case 'qualified': return '已審定'
    case 'not_running': return '未登記'  // 正常不會進到 grid（ElectionPage 已過濾），保底顯示
    case 'likely': return '可能參選'
    case 'rumored': return '傳聞'
    case 'elected': return '當選'
    case 'defeated': return '落選'
    default: return null
  }
}

const candidateStatusColor = (status?: CandidateStatus) => {
  switch (status) {
    case 'registered': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'qualified': return 'bg-emerald-200 text-emerald-800 border-emerald-300'
    case 'not_running': return 'bg-slate-100 text-slate-500 border-slate-200'
    case 'likely': return 'bg-amber-100 text-amber-700 border-amber-200'
    case 'rumored': return 'bg-slate-100 text-slate-500 border-slate-200'
    case 'elected': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'defeated': return 'bg-red-100 text-red-600 border-red-200'
    default: return ''
  }
}

// 只有 confirmed/elected 狀態才顯示「細到鄉鎮／村里」的選區（中選會正式資料）
const shouldShowSubRegion = (status?: CandidateStatus) => {
  return status === 'confirmed' || status === 'registered' || status === 'qualified' || status === 'elected' || status === 'defeated'
}

/**
 * 卡片上的選區（2026-09-18：「將選區也顯示出來吧」）。
 * 原本只顯示 subRegion，而縣市長的選區就是那個縣市本身——於是整頁 87 位縣市長參選人
 * 一個都看不出要選哪裡。縣市先顯示，鄉鎮／村里只在中選會正式資料時才加上去。
 */
const formatArea = (politician: Politician): string | null => {
  const parts = [politician.region]
  // 縣市長的選區就是那個縣市。politicians.sub_region 存的是這個人自己的身份
  // （例如鄭運鵬是桃園市第01選區的立委），印在縣市長卡片上會變成
  // 「縣市長候選人 ＋ 立委選區」這種讀不通的東西——177 位裡有 64 位會這樣。
  const isCityWide = politician.electionType === '縣市長'
  if (!isCityWide && (politician.subRegion || politician.village) && shouldShowSubRegion(politician.candidateStatus)) {
    parts.push(formatSubRegion(politician) ?? '')
  }
  const out = parts.filter(Boolean).join(' ')
  return out || null
}

// 格式化選區顯示（村里長顯示 "XX區 XX里"）
const formatSubRegion = (politician: Politician) => {
  if (politician.village && politician.subRegion) {
    return `${politician.subRegion} ${politician.village}`
  }
  if (politician.village) {
    return politician.village
  }
  return politician.subRegion
}

// 顯示備註（移除 AI搜尋匯入 前綴）
const URL_RE = /https?:\/\/\S+/g
/** 來源備註拆成「文字」與「網址」：卡片只顯示文字，網址做成小連結，避免長網址撐破版面 */
const splitNote = (note?: string): { text: string | null; url: string | null } => {
  if (!note) return { text: null, url: null }
  const url = note.match(URL_RE)?.[0] ?? null
  const text = note.replace(URL_RE, '').replace(/^AI搜尋匯入[：:]?\s*/, '').replace(/[\s，,;；]+$/, '').trim()
  return { text: text || null, url }
}
const displayNote = (note?: string) => splitNote(note).text
const noteUrl = (note?: string) => splitNote(note).url

</script>

<template>
  <div class="mb-12">
    <h3 class="text-xl font-bold text-navy-900 mb-6 flex items-center gap-2 border-l-4 border-blue-500 pl-3 text-left">
      <slot name="icon" /> {{ title }} ({{ politicians.length }})
      <button
        @click="collapsed = !collapsed"
        class="ml-auto p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
        :title="collapsed ? '展開' : '收合'"
      >
        <ChevronUp v-if="!collapsed" :size="20" />
        <ChevronDown v-else :size="20" />
      </button>
    </h3>
    <div v-if="!collapsed && politicians.length > 0" :class="gridClasses">
      <div
        v-for="politician in politicians"
        :key="politician.id"
        @click="router.push(`/politician/${politician.id}`)"
        class="group relative bg-white p-6 rounded-xl border border-slate-200 hover:border-violet-300 hover:shadow-lg transition-all cursor-pointer flex items-center gap-6"
      >
        <div class="relative shrink-0">
          <Avatar :src="politician.avatarUrl" :name="politician.name" size="xl" class="border-4 border-slate-50 group-hover:scale-105 transition-transform" />
          <PartyBadge :party="politician.party" class="absolute -bottom-1 -right-1" />
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex justify-between items-start">
            <div class="text-left">
              <div class="flex items-center gap-2">
                <!-- 真的 <a>：預渲染 HTML 才有選舉頁 → 候選人頁的連結給爬蟲走（卡片的 @click 是給人用的）-->
                <h3 class="text-lg font-bold text-navy-900 group-hover:text-violet-700 transition-colors">
                  <router-link :to="`/politician/${politician.id}`" @click.stop>{{ politician.name }}</router-link>
                </h3>
                <span
                  v-if="candidateStatusLabel(politician.candidateStatus)"
                  :class="`text-[10px] px-1.5 py-0.5 rounded border font-bold ${candidateStatusColor(politician.candidateStatus)}`"
                >
                  {{ candidateStatusLabel(politician.candidateStatus) }}
                </span>
              </div>
              <div class="flex flex-col">
                <p class="text-sm text-slate-500 font-medium">{{ politician.position || (politician.electionType || '縣市長') + '參選人' }}</p>
                <span v-if="formatArea(politician)" class="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded mt-1 w-fit">{{ formatArea(politician) }}</span>
                <!-- 同一句登記名單來源在 42 張卡上一字不差地重複（2026-09-18：「反而不用一直重複」），
                     那是整批匯入時寫進每一列的 source_note。卡片只留一個「來源」連結，滑過去才看得到那句話。 -->
                <p v-if="displayNote(politician.sourceNote) || noteUrl(politician.sourceNote)" class="text-xs text-slate-400 mt-1">
                  <a v-if="noteUrl(politician.sourceNote)" :href="noteUrl(politician.sourceNote)!" :title="displayNote(politician.sourceNote) ?? '來源'" target="_blank" rel="noopener" class="text-violet-500 hover:underline" @click.stop>來源</a>
                  <span v-else class="line-clamp-2 break-words">{{ displayNote(politician.sourceNote) }}</span>
                </p>
              </div>
            </div>
            <ArrowRight class="text-slate-300 group-hover:text-violet-400 group-hover:translate-x-1 transition-all" :size="20" />
          </div>
          <div class="mt-3 flex items-center gap-2">
            <!-- 0 用灰色：純嚴格只算當屆之後，多數參選人是 0，全部紫色徽章會變成一片噪音；
                 但不能直接藏起來——「這個人還沒有當屆政見」正是要讓人看見、有人去補的事 -->
            <span :class="['inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md font-bold',
                           getPledgeCount(politician.id) > 0 ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-400']">
              <Megaphone :size="12" /> {{ getPledgeCount(politician.id) }} 項政見
            </span>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="!collapsed" class="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-8 text-center text-slate-400">
      尚無此區域的{{ title }}資料
    </div>
  </div>
</template>
