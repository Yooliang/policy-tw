<script setup lang="ts">
import PartyBadge from '../../components/PartyBadge.vue'
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { isMobileViewport } from '../../composables/useMobileShell'
import { avatarThumbUrl } from '../../lib/avatar-thumb'
import { useSupabase } from '../../composables/useSupabase'
import { PolicyStatus, type Politician, type CandidacyStatus } from '../../types'
import { Megaphone, ChevronDown, ChevronUp, Check } from 'lucide-vue-next'
import { getAvatarUrl } from '../../composables/useAvatar'
import { officeTitles, withdrawalText } from '../../lib/politician-office'
import { ballotLabel } from '../../lib/ballot-number'
import { isElectionVoted } from '../../lib/policy-stage'

// 根元素的 id（頁內錨點，人物頁麵包屑連到這裡）由呼叫端當 attribute 傳進來；scroll-mt-20 讓錨點捲到時不被置頂的導覽列蓋住
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
  /**
   * 標題列的「政見 PK」按鈕連到哪裡（2026-10-06 維護者：拿掉「大頭照／清單」切換，同一個位置放這顆）：
   * 選舉頁「政見 PK」頁籤、已選好這個區塊的職位與選區、帶入這一組全部的參選人（網址規則在 lib/policy-compare.ts）。
   * 真的 <a href>；沒給就不出現（同一場不到兩位、或不知道是哪一場）。
   */
}>()

const { policies, elections } = useSupabase()
const collapsed = ref(false)

/**
 * 卡片（2026-09-28 維護者試作大頭照版，參考民眾黨候選人頁；2026-10-06 維護者：拿掉「大頭照／清單」切換，只留這種卡片）：
 * 大張直式人像、名字＋號次＋政黨＋選區。欄數跟著版面寬度走（09-29 維護者）：右側有「鄉鎮市區」篩選欄時主欄只剩 2/3 寬 → 四欄，
 * 沒有就全寬 → 六欄，兩種卡片一樣大。預渲染與瀏覽器是同一種卡片（以前預渲染出清單版、掛載後才換，畫面會跳）。
 */
const portraitSrc = (p: Politician) => {
  const src = getAvatarUrl(p.avatarUrl ?? null, p.name)
  return p.avatarUrl ? avatarThumbUrl(src) : src
}
// 縮圖載不到就退回原圖，原圖也掛了才換預設圖
const onPortraitError = (e: Event, p: Politician) => {
  const img = e.target as HTMLImageElement
  const original = getAvatarUrl(p.avatarUrl ?? null, p.name)
  if (p.avatarUrl && img.dataset.fb !== '1' && img.src !== original) { img.dataset.fb = '1'; img.src = original; return }
  const fallback = getAvatarUrl(null, p.name)
  if (img.dataset.fb !== '2' && img.src !== fallback) { img.dataset.fb = '2'; img.src = fallback }
}

/**
 * 分批渲染（2026-10-31 手機效能）：一個職位幾百人時整批掛 DOM 會卡好幾秒。手機先畫第一屏（INITIAL 張），
 * 捲近底部的哨兵再加一批；桌機與預渲染（SSR／hydrate 第一次）照舊全畫，HTML 與預渲染一致、連結給爬蟲走。
 */
const INITIAL = 18
const STEP = 18
const limit = ref(Number.POSITIVE_INFINITY)
const shown = computed(() => limit.value >= props.politicians.length ? props.politicians : props.politicians.slice(0, limit.value))
const sentinel = ref<HTMLElement | null>(null)
let io: IntersectionObserver | undefined
function watchSentinel() {
  io?.disconnect()
  if (!sentinel.value || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver((entries) => {
    if (entries.some(en => en.isIntersecting) && limit.value < props.politicians.length) limit.value += STEP
  }, { rootMargin: '800px 0px' })
  io.observe(sentinel.value)
}
onMounted(() => { if (isMobileViewport()) limit.value = INITIAL })
// 哨兵出現（還有沒畫的）或每加一批後重新觀察：新一批畫完哨兵仍在視窗內時 observer 不會再觸發，要重接
watch([sentinel, limit, () => props.politicians.length], async () => { await nextTick(); watchSentinel() }, { flush: 'post' })
watch(() => props.politicians, () => { if (limit.value !== Number.POSITIVE_INFINITY) limit.value = INITIAL })
onBeforeUnmount(() => io?.disconnect())
// columns === 2 就是右側有篩選欄（ElectionPage 的 gridColumns）
const portraitGridClass = computed(() => props.columns === 2
  ? 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4'
  : 'grid grid-cols-3 sm:grid-cols-4 md:[grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr))] gap-3')

/**
 * 卡片上的現任職稱（2026-10-04 維護者：職稱跟參選狀況分開）。
 * 卡片原本那一行寫的是「這一屆參選什麼」（選舉頁的卡片本來就是參選名單），
 * 這裡另外標現任——看得出誰是爭取連任的現任者、誰是挑戰者。沒有現任職稱就不顯示。
 */
const currentTitle = (p: Politician) => officeTitles(p.offices).join('、')

// 一次掃過全部政見建好「人 → 當屆承諾數」，卡片只查表（原本每張卡片各掃一次全部政見，手機追蹤裡這段自身就 4.2 秒）
const pledgeCounts = computed(() => {
  const m = new Map<string, number>()
  for (const p of policies.value) {
    if (p.status !== PolicyStatus.CAMPAIGN) continue
    if (props.electionId !== undefined && p.electionId !== props.electionId) continue
    const k = String(p.politicianId)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
})
const getPledgeCount = (politicianId: string | number) => pledgeCounts.value.get(String(politicianId)) ?? 0

// 這一屆投完票了沒：投完票之後「已登記」那顆勾與「已登記」標籤沒有意思（人人都在選票上），只講結果
const voted = computed(() => {
  const d = elections.value.find((e) => e.id === props.electionId)?.electionDate
  return isElectionVoted(d)
})

// 參選狀態顯示（選前到選後同一欄 candidacy_status；#345 第二階段 A）
const candidateStatusLabel = (status?: CandidacyStatus, withdrawnAfterFiling?: boolean) => {
  switch (status) {
    case 'declared': return null  // 表態參選不需特別標註
    case 'filed': return null  // 已登記標在照片上（勾），不重複標文字
    case 'withdrawn': return withdrawalText(withdrawnAfterFiling)  // 正常不會進到 grid（ElectionPage 已過濾），保底顯示；說法看退選前有沒有登記過（#345 後續）
    case 'considering': return '考慮參選'
    case 'elected': return '當選'
    case 'not_elected': return '落選'
    default: return null
  }
}

const candidateStatusColor = (status?: CandidacyStatus) => {
  switch (status) {
    case 'filed': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'withdrawn': return 'bg-slate-100 text-slate-500 border-slate-200'
    case 'considering': return 'bg-amber-100 text-amber-700 border-amber-200'
    case 'elected': return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    case 'not_elected': return 'bg-red-100 text-red-600 border-red-200'
    default: return ''
  }
}

// 只有表明參選以後（表明、已登記、當選、落選）才顯示「細到鄉鎮／村里」的選區（中選會正式資料）
const shouldShowSubRegion = (status?: CandidacyStatus) => {
  return status === 'declared' || status === 'filed' || status === 'elected' || status === 'not_elected'
}

/**
 * 卡片上的選區（2026-09-18：「將選區也顯示出來吧」）。
 * 原本只顯示 subRegion，而縣市長的選區就是那個縣市本身——於是整頁 87 位縣市長參選人
 * 一個都看不出要選哪裡。縣市先顯示，鄉鎮／村里只在中選會正式資料時才加上去。
 */
// 縣市長的選區就是那個縣市。politicians.sub_region 存的是這個人自己的身份
// （例如鄭運鵬是桃園市第01選區的立委），印在縣市長卡片上會變成
// 「縣市長候選人 ＋ 立委選區」這種讀不通的東西——177 位裡有 64 位會這樣。
const hasSubArea = (politician: Politician): boolean =>
  politician.electionType !== '縣市長' && !!(politician.subRegion || politician.village) && shouldShowSubRegion(politician.candidacyStatus)

const formatArea = (politician: Politician): string | null => {
  const parts = [politician.region]
  if (hasSubArea(politician)) {
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

</script>

<template>
  <div class="mb-12 scroll-mt-20">
    <h3 class="text-xl font-bold text-navy-900 mb-3 md:mb-6 flex items-center gap-2 border-l-4 border-blue-500 pl-3 text-left">
      <slot name="icon" /> <span class="min-w-0">{{ title }} ({{ politicians.length }})</span>
      <button
        @click="collapsed = !collapsed"
        :class="['p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors shrink-0 ml-auto']"
        :title="collapsed ? '展開' : '收合'"
      >
        <ChevronUp v-if="!collapsed" :size="20" />
        <ChevronDown v-else :size="20" />
      </button>
    </h3>
    <!-- 卡片：直式人像 -->
    <div v-if="!collapsed && politicians.length > 0" :class="portraitGridClass">
      <div
        v-for="politician in shown"
        :key="politician.id"
        class="group relative bg-white rounded-xl border border-slate-200 hover:border-violet-300 hover:shadow-lg transition-all cursor-pointer overflow-hidden flex flex-col"
      >
        <div class="relative aspect-[3/4] bg-slate-100 overflow-hidden">
          <img :src="portraitSrc(politician)" :alt="politician.name" loading="lazy" decoding="async" width="240" height="320" class="w-full h-full object-cover object-top group-hover:scale-105 transition-transform" @error="onPortraitError($event, politician)" />
          <!-- 有號次（名單公告、抽籤後）就顯示「N號」；已登記＝綠色小勾 -->
          <span
            v-if="ballotLabel(politician.candNo)"
            class="absolute top-2 left-2 inline-flex items-center justify-center min-w-[2rem] h-7 px-2 rounded-full bg-navy-900/90 text-white text-sm font-black"
            :title="ballotLabel(politician.candNo)"
          >{{ ballotLabel(politician.candNo) }}</span>
          <span
            v-else-if="politician.candidacyStatus === 'filed' && !voted"
            class="absolute top-2 left-2 inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500 text-white"
            title="已登記"
          ><Check :size="14" :stroke-width="3" /></span>
          <PartyBadge :party="politician.party" class="absolute bottom-2 right-2" />
        </div>
        <div class="p-3 text-left">
          <!-- 真的 <a>：預渲染 HTML 才有選舉頁 → 候選人頁的連結給爬蟲走（stretched link，整張卡都點得到）-->
          <h4 class="text-base font-bold text-navy-900 group-hover:text-violet-700 transition-colors">
            <router-link :to="`/politician/${politician.id}`" class="after:absolute after:inset-0 after:content-['']">{{ politician.name }}</router-link>
          </h4>
          <p class="text-xs text-slate-500 mt-0.5">{{ politician.party }}</p>
          <!-- 已登記以外的參選狀態（可能參選、當選、落選…）照舊文字標；已登記與有號次的已經標在照片上 -->
          <span
            v-if="!ballotLabel(politician.candNo) && candidateStatusLabel(politician.candidacyStatus, politician.withdrawnAfterFiling)"
            :class="`inline-block text-[10px] px-1.5 py-0.5 rounded border font-bold mt-1 ${candidateStatusColor(politician.candidacyStatus)}`"
          >{{ candidateStatusLabel(politician.candidacyStatus, politician.withdrawnAfterFiling) }}</span>
          <p v-if="formatArea(politician)" class="text-xs text-slate-600 mt-1 line-clamp-2">{{ formatArea(politician) }}</p>
          <p v-if="currentTitle(politician)" class="text-[11px] text-sky-700 mt-1 line-clamp-1">現任 {{ currentTitle(politician) }}</p>
          <!-- 0 用灰色：純嚴格只算當屆之後，多數參選人是 0，全部紫色徽章會變成一片噪音；
               但不能直接藏起來——「這個人還沒有當屆政見」正是要讓人看見、有人去補的事 -->
          <span :class="['inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded mt-2 font-bold',
                         getPledgeCount(politician.id) > 0 ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-400']">
            <Megaphone :size="11" /> {{ getPledgeCount(politician.id) }} 項{{ voted && politician.candidacyStatus === 'elected' ? '政見' : '承諾' }}
          </span>
        </div>
      </div>
    </div>
    <div v-else-if="!collapsed" class="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-8 text-center text-slate-400">
      尚無此區域的{{ title }}資料
    </div>
    <div v-if="!collapsed && shown.length < politicians.length" ref="sentinel" class="h-px" aria-hidden="true"></div>
  </div>
</template>
