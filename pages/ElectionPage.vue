<script lang="ts">
export default { name: 'ElectionPage' }
</script>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onActivated, onDeactivated, onBeforeUnmount, type Component } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import HeroAction from '../components/HeroAction.vue'
import { PolicyStatus, ElectionType, type Politician } from '../types'
import PolicyCard from '../components/PolicyCard.vue'
import PoliticianGrid from './election/PoliticianGrid.vue'
import VerticalStack from './election/VerticalStack.vue'
import ChipFilteredGroups from './election/ChipFilteredGroups.vue'
import PolicyPk from './election/PolicyPk.vue'
import { buildPick, comparablePeople, compareMatrix, hasPk, hasPolicies, parsePick, pickGroup, pkGroups, pkNeeds, pkQuery } from '../lib/policy-compare'
import Hero from '../components/Hero.vue'
import { useRouter, useRoute, RouterLink } from 'vue-router'
import {
  Vote, Megaphone, Flag, AlertCircle, Users, MapPin,
  Search, Layers, LayoutGrid, Clock, Scale,
  Building2, Mountain, Landmark, MessageCircle, Hash, Loader2,
  Crown, ScrollText, ArrowUpDown, Swords } from 'lucide-vue-next'

import { useGlobalState } from '../composables/useGlobalState'
import { isRunningCandidate } from '../lib/candidate-status'
import { issueTagsOf } from '../lib/issue-tags'
import GlobalRegionSelector from '../components/GlobalRegionSelector.vue'
import LoadError from '../components/LoadError.vue'
import { usePageHead } from '../composables/usePageHead'
import { useRegionQuerySync, queryField } from '../composables/useRegionQuerySync'
import { electionPath, isCounty, TAIWAN_COUNTIES } from '../lib/election-regions'
import { electionSegment, electionYearOfDate, legacyKeySegmentTarget } from '../lib/election-route'
import { classifyWard } from '../lib/ward-classification'
import { planLevels, positionSpec, sectionAnchor, type PositionSpec } from '../lib/election-levels'
import { groupByVillage } from '../lib/village-grouping'
import { districtsOf, groupByDistrict } from '../lib/district-grouping'
import { electionArea } from '../lib/election-area'
import { DIRECTORY_LEVELS, buildTownshipDirectory, directoryTotal } from '../lib/township-directory'
import { compareRegionName, normalizeRegionName, sameRegionName } from '../lib/region-name'
import type { RouteLocationRaw } from 'vue-router'

const router = useRouter()
const route = useRoute()
const { politicians, policies, locations, categories, getElectionBySegment, getPoliticianElectionData, loading, error, getElectoralDistrictByTownship, electoralDistrictAreas, ensureDistricts, loadPoliticiansByElection, loadedElections, ensurePolicies, politicianListIncomplete, availableElectionTypes, townshipDirectory, loadTownshipDirectory } = useSupabase()

// Helper: 取得候選人在該選舉的類型
function getElectionType(politician: any): string | undefined {
  const data = getPoliticianElectionData(politician, electionId.value)
  return data?.electionType
}

// Helper: 套用當前選舉的特定資料（解決跨選舉資料混亂問題）
function withCurrentElectionData(politician: any): any {
  const electionData = getPoliticianElectionData(politician, electionId.value)
  // 號次一定要換成這一屆的：全域人物物件會帶著上一屆（例如 2022）的號次，從 2022 切到 2026 會殘留（09-28 維護者）
  if (!electionData) return { ...politician, candNo: undefined }
  const electionType = electionData.electionType || politician.electionType
  return {
    ...politician,
    candNo: electionData.candNo,
    candidacyStatus: electionData.candidacyStatus,
    sourceNote: electionData.sourceNote,
    position: electionData.position || politician.position,
    electionType,
    // 議員這一屆沒有選區就列「選區待補」，不借人物的里或立委選區冒充（2026-10-05，lib/election-area.ts）
    ...electionArea(electionType, electionData, politician),
  }
}
const { globalRegion } = useGlobalState()

// 網址上那一段：舊三屆是 id（/election/2022）、新增的選舉（補選、罷免、重行選舉）是 election_key（#344 第二階段 A，lib/election-route.ts）
const election = computed(() => getElectionBySegment(route.params.electionId))
// 數字網址在選舉清單還沒載入時就先吃網址上的 id（預渲染與 hydrate 起手就能撈資料）；key 網址要等清單載入才找得到 id（NaN＝還沒有）
const electionId = computed(() => {
  if (election.value) return election.value.id
  const raw = route.params.electionId
  const seg = Array.isArray(raw) ? raw[0] : raw
  return typeof seg === 'string' && /^\d+$/.test(seg) ? Number(seg) : NaN
})
// 站內連結用的那一段（舊三屆 id、其他 election_key）
const electionSeg = computed(() => election.value ? electionSegment(election.value) : String(Array.isArray(route.params.electionId) ? route.params.electionId[0] : route.params.electionId))
// 舊三屆的 key 寫法（/election/2022-11-26_local）換成年份寫法，canonical 只有一個；Worker 與 Firebase 也會 301，這裡是客戶端直接進來的後備
watch(() => route.params.electionId, (seg) => {
  const target = legacyKeySegmentTarget(seg)
  if (target) router.replace({ name: route.name as string, params: { ...route.params, electionId: target }, query: route.query, hash: route.hash })
}, { immediate: true })
const electionLoading = ref(false)

/**
 * 縣市頁 /election/:electionId/:region（2026-09-30）：網址上的縣市就是這一頁的縣市。
 * 初始值先吃網址（預渲染與 hydrate 都看得到同一個縣市），之後由 useRegionQuerySync 跟全站的 globalRegion 對齊。
 * 不合法的縣市名當成沒有，useRegionQuerySync 會把網址換回全台。
 */
const routeRegion = computed(() => {
  const raw = route.params.region
  const value = Array.isArray(raw) ? raw[0] : raw
  return isCounty(value) ? value : undefined
})
/**
 * 鄉鎮頁 /election/:electionId/:region/:subRegion（2026-10-05）：網址上的鄉鎮市區就是這一頁的鄉鎮。
 * 跟縣市一樣初始值先吃網址（預渲染與 hydrate 才會是同一個鄉鎮）；縣市不合法時鄉鎮也不算。
 */
const routeSubRegion = computed(() => {
  if (!routeRegion.value) return undefined
  const raw = route.params.subRegion
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  return value && value !== 'All' ? value : undefined
})
const selectedRegion = ref(routeRegion.value ?? globalRegion.value)
const selectedSubRegion = ref<string>(routeSubRegion.value ?? 'All')  // 鄉鎮市區
const selectedVillage = ref<string>('All')    // 村里

// 載入這一屆、這一層的參選人（這一層＋下一層，見 lib/election-levels.ts）
// 只有最後一次載入能把「載入中」關掉（2026-10-05）：舊網址 ?sub= 進來時先撈縣市、再撈鄉鎮，兩次重疊；
// 先回來的縣市那次若把它關掉，頁內錨點會以為資料載完了、區塊還沒出現就放棄捲動
let loadSeq = 0
async function loadElectionData(id: number, region: string, subRegion: string) {
  if (!id) return
  const seq = ++loadSeq
  electionLoading.value = true
  try {
    await loadPoliticiansByElection(id, region, subRegion)
  } finally {
    if (seq === loadSeq) electionLoading.value = false
  }
  // 名錄只有縣市頁要，而且跟卡片分開撈（它要列到村里長，卡片只到下一層）。
  // 不 await 在上面那個 try 裡：名錄慢或失敗都不該讓卡片等它或跟著掛掉。
  if (region !== 'All' && subRegion === 'All') {
    loadTownshipDirectory(id, region)
  }
}

onMounted(() => {
  // 政見清單是按需載入的（257 KB，公民提問頁那類頁面不需要）。這一頁要整份。
  ensurePolicies()
  // 選舉區對應表 77 KB，只有這一頁篩議員選區要用，改成按需載入
  ensureDistricts()
  if (electionId.value) {
    loadElectionData(electionId.value, selectedRegion.value, selectedSubRegion.value)
  }
})

// 這一頁被 App.vue 的 <KeepAlive> 快取著，切回來時 onMounted 不會再跑；
// 路由參數沒變 watch 也不會觸發。而 loadPoliticiansByElection 在切到另一個選舉時
// 會清掉上一個選舉的候選人——於是切去別的選舉再切回來，名單是空的、畫面留白。
// 醒來時檢查一次：這個選舉的候選人還在就什麼都不做，不在就補載。
onActivated(() => {
  if (!electionId.value) return
  const hasAny = politicians.value.some(p => p.electionIds?.includes(electionId.value))
  if (!hasAny) {
    loadElectionData(electionId.value, selectedRegion.value, selectedSubRegion.value)
  }
})

// 屆別、縣市、鄉鎮市區任一個變了就重新載入——撈的職位是依層級決定的，換鄉鎮換的不只是篩選條件，
// 是要撈的東西本身（縣市頁撈縣市長／議員，鄉鎮頁撈鄉鎮市長／代表／村里長）。
// 三個來源合在一個 watch 裡：換縣市會順手把鄉鎮重設成 All（下面那個 watch），
// 分開寫會在同一個 tick 裡觸發兩次載入。
watch([electionId, selectedRegion, selectedSubRegion], ([id, region, subRegion]) => {
  if (id) {
    loadElectionData(id, region, subRegion)
  }
})

// 選舉年份（用於選舉區對應表查詢，因為該表存的是年份而非 election ID）
const electionYear = computed(() => electionYearOfDate(election.value?.electionDate) ?? 0)

// Hero 背景圖片（依選舉年份）
const heroImages: Record<number, string> = {
  2022: '/images/heroes/election-2022.png',
  2024: '/images/heroes/election-2024.png',
  2026: '/images/heroes/election-2026.png',
}
const heroBackgroundImage = computed(() => heroImages[electionYear.value] || '/images/heroes/election-default.png')

// Sync with global state
watch(globalRegion, (newVal) => {
  // 已經是這個縣市就不動（2026-10-05）：鄉鎮頁進來時，網址同步會把全站的縣市設成網址上的縣市，
  // 這時候若照舊把鄉鎮重設成「全部」，畫面會先閃一下縣市頁、多撈一次整個縣市，再切回鄉鎮。
  // 真的換縣市時 newVal 跟 selectedRegion 不同，照舊重設；回同一個縣市的縣市頁是換網址，由 useRegionQuerySync 設回「全部」。
  if (newVal === selectedRegion.value) return
  selectedRegion.value = newVal
  selectedSubRegion.value = 'All'
  selectedVillage.value = 'All'
  selectedDistrict.value = 'All'
})

// Reset filters when region changes locally
watch(selectedRegion, () => {
  selectedSubRegion.value = 'All'
  selectedVillage.value = 'All'
  selectedDistrict.value = 'All'
})

// Reset village filter when subRegion changes
watch(selectedSubRegion, () => {
  selectedVillage.value = 'All'
  selectedDistrict.value = 'All'
})

const VIEW_MODES = ['politicians', 'pledges', 'issues', 'comparison'] as const
type ElectionViewMode = typeof VIEW_MODES[number]
const viewMode = ref<ElectionViewMode>('politicians')

/**
 * Hero 的四個檢視頁籤（文字與圖示）。VIEW_MODES 是給網址參數驗證用的字串清單，兩者分開。
 * short 是手機版用的兩字短標（使用者 2026-09-19：四顆要放進一排；圖示照舊）。
 */
const VIEW_TABS: Array<{ key: ElectionViewMode; label: string; short: string; icon: typeof LayoutGrid }> = [
  { key: 'politicians', label: '候選人', short: '候選人', icon: LayoutGrid },
  { key: 'pledges', label: '競選承諾', short: '承諾', icon: Megaphone },
  { key: 'issues', label: '議題串聯', short: '串聯', icon: Layers },
  { key: 'comparison', label: '政見 PK', short: 'PK', icon: Scale },
]
const selectedIssueCategory = ref('All')
const selectedIssueTag = ref('')
/**
 * 政見 PK 的職位（網址 type）。空字串＝沒指定，自動選這一頁第一個有政見可比的職位（pkLevel）——
 * 2026-10-06 以前預設是縣市長，鄉鎮頁、或縣市長還沒有政見的縣市頁，PK 一打開是空的。
 */
const comparisonLevel = ref<string>('')
/** 政見 PK 選的是哪一場（組名，例如「第08選舉區」；空字串＝這一頁這個職位的第一場）與勾了誰（人物 id 以逗號隔開；空字串＝這一場全部）。2026-10-06 */
const comparisonDistrict = ref('')
const comparisonPick = ref('')

// 縣市／鄉鎮／村里／頁籤／PK 層級、選區、勾選 ↔ 網址，可貼連結直達（PK 的參數規則在 lib/policy-compare.ts 的 pkQuery）
// 縣市與鄉鎮在路徑上（/election/2022/嘉義縣/大林鎮，鄉鎮 2026-10-05 起），村里／頁籤仍是 query（?village=&view=&type=）；
// 舊的 ?region=、?sub= 進來會換成路徑的寫法（正見.tw 上 Worker 已經先 301 過了，這裡接住 web.app 與站內舊連結）
useRegionQuerySync({
  routeName: ['election', 'election-region', 'election-township'],
  regionPath: {
    get: () => routeRegion.value,
    getSub: () => routeSubRegion.value,
    build: (region, sub) => electionPath(electionSeg.value, region, sub),
  },
  sub: selectedSubRegion,
  village: selectedVillage,
  extra: {
    view: queryField(viewMode, 'politicians', { allowed: VIEW_MODES }),
    type: queryField(comparisonLevel, '', { allowed: Object.values(ElectionType), when: () => viewMode.value === 'comparison' }),
    // 順序要在 type 後面：套網址時一個欄位設完才設下一個
    district: queryField(comparisonDistrict, '', { when: () => viewMode.value === 'comparison' }),
    pick: queryField(comparisonPick, '', { when: () => viewMode.value === 'comparison' }),
  },
})

/**
 * 縣市選擇器的連結：到該縣市頁（或全台），保留目前的頁籤（view／type），鄉鎮與村里不帶過去（換縣市本來就會重設）。
 * 預渲染時沒有 query，href 就是乾淨的 /election/2026/台北市。
 */
function regionLink(region: string): RouteLocationRaw {
  return { path: electionPath(electionSeg.value, region), query: tabQuery() }
}

/** 換頁時要帶過去的頁籤參數（view／type）；鄉鎮與村里不帶 */
function tabQuery(): Record<string, string> {
  const query: Record<string, string> = {}
  for (const key of ['view', 'type']) {
    const v = route.query[key]
    if (typeof v === 'string' && v) query[key] = v
  }
  return query
}

/**
 * 右側鄉鎮市區的連結（2026-10-05）：到該鄉鎮頁（「全部」＝縣市頁），一樣保留頁籤、不帶村里。
 * 以前是按鈕改 selectedSubRegion（網址變 ?sub=），預渲染的縣市頁裡沒有通往鄉鎮的 <a href>。
 */
function townshipLink(township: string): RouteLocationRaw {
  return { path: electionPath(electionSeg.value, selectedRegion.value, township), query: tabQuery() }
}

const SIX_CAPITALS = ['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市']
const OTHER_LOCATIONS = computed(() => locations.value.filter(loc => !SIX_CAPITALS.includes(loc)))

// 判斷是否為直轄市（用於顯示「區」或「鄉鎮市區」）
const isSpecialMunicipality = computed(() => SIX_CAPITALS.includes(selectedRegion.value))
const subRegionLabel = computed(() => isSpecialMunicipality.value ? '區' : '鄉鎮市區')
const villageLabel = computed(() => isSpecialMunicipality.value ? '里' : '村里')

const timeLeft = computed(() => {
  if (!election.value) return { days: 0 }
  const difference = +new Date(election.value.electionDate) - +new Date()
  return { days: difference > 0 ? Math.floor(difference / (1000 * 60 * 60 * 24)) : 0 }
})

// 本選舉的候選人；退選（withdrawn，含 AI 推測但未登記的）與傳聞（空值）的人不進選舉頁，各級 grid 與統計數字都由這裡衍生
const electionPoliticians = computed(() =>
  politicians.value.filter(c =>
    c.electionIds?.includes(electionId.value) &&
    isRunningCandidate(getPoliticianElectionData(c, electionId.value)?.candidacyStatus)
  )
)

// 是否顯示右側篩選區（用於決定左側欄位數）
// 跟右側欄的 v-if 同一個條件：選了縣市但沒有鄉鎮資料時不會出現右側欄，主欄是全寬
const showSidebar = computed(() => selectedRegion.value !== 'All' && availableSubRegions.value.length > 0)

// Grid 欄位數（有右側篩選時用 2 欄）
const gridColumns = computed(() => showSidebar.value ? 2 : 3)

// 地名排序（先字數再筆畫）跟名錄分組共用同一套規則，見 lib/region-name.ts
const sortByLengthThenStroke = compareRegionName

// 候選人排序（使用者 2026-09-20：多種排序讓人選，預設「最近更新」）。
// 原本是資料庫撈出來的順序，等於先建檔的永遠排第一——清單第一格的曝光遠高於後面，系統不該替任何人站台。
type SortMode = 'updated' | 'stroke' | 'policies' | 'attention'
const sortMode = ref<SortMode>('updated')
const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: 'updated', label: '最近更新' },   // 名下政見或進度最近有變動的在前
  { key: 'stroke', label: '姓名筆畫' },    // 中選會抽籤前的慣例
  { key: 'policies', label: '政見數' },    // 登錄的政見多的在前
  { key: 'attention', label: '關注度' },   // 支持、反對、關注的總數
]
/** 每位候選人名下政見的統計：最後變動時間、筆數、表態總數（跨屆別都算，那是這個人的活動量） */
const policyStatsByPolitician = computed(() => {
  const m = new Map<string, { updated: string; count: number; attention: number }>()
  for (const p of policies.value) {
    const st = m.get(p.politicianId) ?? { updated: '', count: 0, attention: 0 }
    // updatedAt 是 timestamptz（內容任何變動都會蓋，含代理套用的更正）；快照還沒帶這欄時退回只有「日」的 lastUpdated
    const touched = p.updatedAt ?? p.lastUpdated ?? ''
    if (touched > st.updated) st.updated = touched
    st.count += 1
    st.attention += (p.stanceSupport ?? 0) + (p.stanceOppose ?? 0) + (p.stancePriority ?? 0)
    m.set(p.politicianId, st)
  }
  return m
})
function sortPoliticians<T extends Politician>(list: T[]): T[] {
  const stats = policyStatsByPolitician.value
  const st = (c: Politician) => stats.get(c.id) ?? { updated: '', count: 0, attention: 0 }
  const byStroke = (a: Politician, b: Politician) => sortByLengthThenStroke(a.name, b.name)
  const cmp: Record<SortMode, (a: Politician, b: Politician) => number> = {
    // 2026-09-21 卡在李四川：last_updated 只到「日」，六個人同日並列，筆畫或筆數任一種並列規則都會讓同一個人永遠第一。
    // 2026-09-22 改用 updated_at（timestamptz，內容任何變動都會蓋，migration 000028），並列只剩極少數；退路仍是筆數→筆畫。
    updated: (a, b) => st(b).updated.localeCompare(st(a).updated) || st(b).count - st(a).count || byStroke(a, b),
    stroke: byStroke,
    policies: (a, b) => (st(b).count - st(a).count) || byStroke(a, b),
    attention: (a, b) => (st(b).attention - st(a).attention) || byStroke(a, b),
  }
  return [...list].sort(cmp[sortMode.value])
}

// 取得選定縣市的鄉鎮市區（合併所有來源）
const availableSubRegions = computed(() => {
  if (selectedRegion.value === 'All') return []
  const subRegions = new Set<string>()

  // 1. 從 politicians 取得（鄉鎮市長、代表、村里長等），排除選舉區格式
  // 套用當前選舉資料以取得正確的 subRegion
  electionPoliticians.value.map(withCurrentElectionData)
    .filter(c => {
      const type = getElectionType(c)
      return sameRegionName(c.region, selectedRegion.value) && c.subRegion &&
        type !== ElectionType.COUNCILOR &&
        type !== ElectionType.LEGISLATOR &&
        type !== ElectionType.INDIGENOUS_DISTRICT_CHIEF &&
        type !== ElectionType.INDIGENOUS_DISTRICT_REP &&
        !c.subRegion.includes('選區')
    })
    .forEach(c => subRegions.add(c.subRegion!))

  // 2. 從選舉區對應表取得（議員對應的鄉鎮區）
  // 優先使用當前選舉年份，若無則使用任何可用年份（鄉鎮區跨選舉相對穩定）
  const areasForYear = electoralDistrictAreas.value.filter(
    m => sameRegionName(m.region, selectedRegion.value) && m.election_id === electionYear.value
  )
  const areasToUse = areasForYear.length > 0
    ? areasForYear
    : electoralDistrictAreas.value.filter(m => sameRegionName(m.region, selectedRegion.value))
  areasToUse.forEach(m => subRegions.add(m.township))

  // 過濾掉選舉區格式（如「第01選舉區」），並排序
  return Array.from(subRegions)
    .filter(s => !s.includes('選區') && !s.includes('選舉區'))
    .sort(sortByLengthThenStroke)
})

// 取得選定鄉鎮市區的村里（從村里長候選人）
const availableVillages = computed(() => {
  if (selectedSubRegion.value === 'All') return []
  const villages = new Set<string>()

  // 從村里長候選人取得村里名稱
  electionPoliticians.value.map(withCurrentElectionData)
    .filter(c => {
      const type = getElectionType(c)
      return type === ElectionType.CHIEF &&
        sameRegionName(c.region, selectedRegion.value) &&
        sameRegionName(c.subRegion, selectedSubRegion.value) &&
        c.village
    })
    .forEach(c => villages.add(c.village!))

  return Array.from(villages).sort(sortByLengthThenStroke)
})

const filteredPoliticians = computed(() => {
  // 關鍵：套用當前選舉的特定資料，確保 candidacyStatus/subRegion 等欄位正確
  let result = electionPoliticians.value.map(withCurrentElectionData)
  if (selectedRegion.value !== 'All') {
    result = result.filter(c => sameRegionName(c.region, selectedRegion.value))
  }
  // 鄉鎮市區篩選
  if (selectedSubRegion.value !== 'All') {
    result = result.filter(c => {
      const type = getElectionType(c)
      // 總統、立委、縣市長、議員不受鄉鎮篩選影響
      if (type === ElectionType.PRESIDENT ||
          type === ElectionType.LEGISLATOR ||
          type === ElectionType.MAYOR ||
          type === ElectionType.COUNCILOR) {
        return true
      }
      // 原民區長/代表：subRegion 格式是「XX區第YY選舉區」，用前綴匹配
      if (type === ElectionType.INDIGENOUS_DISTRICT_CHIEF ||
          type === ElectionType.INDIGENOUS_DISTRICT_REP) {
        return normalizeRegionName(c.subRegion).startsWith(normalizeRegionName(selectedSubRegion.value))
      }
      // 其他（鄉鎮市長、代表、村里長）：完全匹配
      return sameRegionName(c.subRegion, selectedSubRegion.value)
    })
  }
  return sortPoliticians(result)
})

const presidentPoliticians = computed(() =>
  filteredPoliticians.value
    .filter(c => getElectionType(c) === ElectionType.PRESIDENT)
    .sort((a, b) => {
      // 總統候選人排在副總統候選人前面
      const aIsVice = a.position?.includes('副') ? 1 : 0
      const bIsVice = b.position?.includes('副') ? 1 : 0
      return aIsVice - bIsVice
    })
)
const legislatorPoliticians = computed(() => {
  let result = electionPoliticians.value.map(withCurrentElectionData).filter(c => getElectionType(c) === ElectionType.LEGISLATOR)
  if (selectedRegion.value !== 'All') {
    result = result.filter(c => sameRegionName(c.region, selectedRegion.value))
  }
  return sortPoliticians(result)
})
const councilorPoliticians = computed(() => {
  let result = electionPoliticians.value.map(withCurrentElectionData).filter(c => getElectionType(c) === ElectionType.COUNCILOR)
  if (selectedRegion.value !== 'All') {
    result = result.filter(c => sameRegionName(c.region, selectedRegion.value))
  }
  // 當選擇鄉鎮市區時，透過對應表找出該鄉鎮所屬的議員選舉區
  if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All') {
    const electoralDistrict = getElectoralDistrictByTownship(
      selectedRegion.value,
      selectedSubRegion.value,
      electionYear.value
    )
    if (electoralDistrict) {
      result = result.filter(c => sameRegionName(c.subRegion, electoralDistrict))
    }
  }
  return result
})
/**
 * 縣市頁的「鄉鎮市區參選人名錄」。
 *
 * 這份名錄是預渲染的縣市頁裡**唯一**通往村里長人物頁的連結（2026-09-30 加的，當時
 * Search Console 整站內部連結只剩 28 個）。村里長有 13,338 位，爬蟲只能從這裡走到他們。
 *
 * 2026-10-05 分層之後卡片只撈「這一層＋下一層」，所以名錄不再從卡片的資料推——
 * 它由 useSupabase 的 loadTownshipDirectory 用一支只取四個欄位的輕量查詢單獨撈
 * （姓名、職位、鄉鎮、村里）。分組規則在 lib/township-directory.ts。
 */
const townshipDirectoryGroups = computed(() => {
  if (selectedRegion.value === 'All' || selectedSubRegion.value !== 'All') return []
  return buildTownshipDirectory(townshipDirectory.value, DIRECTORY_LEVELS)
})
const townshipDirectoryTotal = computed(() => directoryTotal(townshipDirectoryGroups.value))

const indigenousChiefPoliticians = computed(() => filteredPoliticians.value.filter(c => getElectionType(c) === ElectionType.INDIGENOUS_DISTRICT_CHIEF))
const indigenousRepPoliticians = computed(() => filteredPoliticians.value.filter(c => getElectionType(c) === ElectionType.INDIGENOUS_DISTRICT_REP))
const chiefPoliticians = computed(() => {
  let result = filteredPoliticians.value.filter(c => getElectionType(c) === ElectionType.CHIEF)
  // 村里篩選
  if (selectedVillage.value !== 'All') {
    result = result.filter(c => sameRegionName(c.village, selectedVillage.value))
  }
  return result
})

/**
 * 直轄市的區分兩種（2026-10-04，見 lib/ward-classification.ts）：一般區區長官派、
 * 原住民區區長與區代表皆民選。判斷不維護城市/區名單，直接看這個區有沒有原住民區長／
 * 區代表候選人——indigenousChiefPoliticians／indigenousRepPoliticians 已經用
 * subRegion 前綴把候選人篩到這個區（見 filteredPoliticians），這裡只是再問一次「有沒有」。
 */
const wardKind = computed(() => classifyWard({
  isSpecialMunicipality: isSpecialMunicipality.value,
  hasIndigenousRace: indigenousChiefPoliticians.value.length > 0 || indigenousRepPoliticians.value.length > 0,
}))

/**
 * 議員與原住民區代表依選舉區分組＋選區快篩（2026-10-04，lib/district-grouping.ts）。
 *
 * 高雄市 2022 有 124 位議員，攤成一長串卡片時使用者要找「我這一區選誰」得一張張看標籤。
 * 兩者共用同一個 selectedDistrict：議員只出現在縣市頁、區代表只出現在原住民區頁，
 * 不會同時在畫面上，而換縣市或換鄉鎮時下面的 watch 會把它重設。
 *
 * 沒有正式選區的人（2022 有 44 筆、2026 有 105 筆議員只到縣市）會被分組函式收進「選區待補」那一組，
 * 不會從畫面上消失；那一組不進快篩清單，因為它不是一個點得下去的選區。
 */
const selectedDistrict = ref<string>('All')
function toggleDistrictChip(district: string) {
  selectedDistrict.value = selectedDistrict.value === district ? 'All' : district
}
function groupsByDistrict(people: Politician[], electionType: string) {
  const picked = selectedDistrict.value === 'All'
    ? people
    : people.filter(c => c.subRegion === selectedDistrict.value)
  // 只認這種選舉的正式選區寫法，其餘收進「選區待補」（2026-10-05：不要冒出「大雅區」「臺中市第03選區」這種假選區）
  return groupByDistrict(picked, electionType).map(g => ({ label: g.district, people: g.people }))
}

/**
 * 這一頁畫哪些區塊（2026-10-05 #348）：照分層設定（lib/election-levels.ts 的 POSITIONS）算出
 * 「這一層」「下一層」各有哪些職位，每個職位畫一個區塊——卡片（grid）、依選舉區分組（district）、
 * 依村里分組（village）三種排法由設定決定。以前三個層級的區塊各自寫死在模板裡。
 *
 * 加一個職位：在 POSITIONS 加一列就會出現在對的頁面；排法是上面三種之一、圖示在 LEVEL_ICONS 裡，
 * 這裡就不用改。名單預設從 filteredPoliticians 照職位取；只有幾個既有職位有自己的排序或篩法
 * （PEOPLE_BY_TYPE），例如總統排在副總統前面、議員要照右側選的鄉鎮篩選區、村里長要照選的村里篩。
 */
const levelPlan = computed(() => planLevels({
  region: selectedRegion.value,
  subRegion: selectedSubRegion.value,
  isSpecialMunicipality: isSpecialMunicipality.value,
  wardKind: wardKind.value,
}))

/** 設定裡的圖示名稱 → 元件 */
const LEVEL_ICONS: Record<string, Component> = { Crown, Flag, Users, ScrollText, Building2, Landmark, Mountain, MessageCircle, MapPin }

const PEOPLE_BY_TYPE: Partial<Record<string, () => Politician[]>> = {
  [ElectionType.PRESIDENT]: () => presidentPoliticians.value,
  [ElectionType.LEGISLATOR]: () => legislatorPoliticians.value,
  [ElectionType.COUNCILOR]: () => councilorPoliticians.value,
  [ElectionType.CHIEF]: () => chiefPoliticians.value,
}
function peopleOf(type: string): Politician[] {
  return PEOPLE_BY_TYPE[type]?.() ?? filteredPoliticians.value.filter(c => getElectionType(c) === type)
}

interface LevelSection {
  spec: PositionSpec
  people: Politician[]
  /** district／village 排法的分組（分組函式會把沒填的人收進最後一組，不會讓人從畫面消失）；anchor＝這一組的頁內錨點 id */
  groups: Array<{ label: string; people: Politician[]; anchor?: string }>
  /** 選舉區快篩（district 排法才有；村里在右側面板的「村里」，選舉區在右側面板的「○○選舉區」，列表上方不放選擇，2026-10-06） */
  chips: readonly string[]
  empty: boolean
  /** 整個職位區塊的頁內錨點 id（人物頁麵包屑的職位層連到這裡，見 lib/election-levels.ts 的 sectionAnchor） */
  anchor?: string
}

/** 分組加上錨點 id：id 一律從 sectionAnchor 來，麵包屑（lib/election-breadcrumbs.ts）連的是同一個函式的輸出 */
function withAnchors(spec: PositionSpec, groups: Array<{ label: string; people: Politician[] }>) {
  return groups.map(g => ({ ...g, anchor: sectionAnchor(spec.type, g.label) }))
}

function buildSection(spec: PositionSpec): LevelSection {
  const people = peopleOf(spec.type)
  const anchor = sectionAnchor(spec.type)
  if (spec.display === 'district') {
    // 議員與原住民區代表共用同一個 selectedDistrict：議員只出現在縣市頁、區代表只出現在原住民區頁，
    // 不會同時在畫面上，而換縣市或換鄉鎮時 watch 會把它重設。
    const groups = withAnchors(spec, groupsByDistrict(people, spec.type))
    return { spec, people, groups, chips: districtsOf(people, spec.type), empty: groups.length === 0, anchor }
  }
  if (spec.display === 'village') {
    // 順序照 availableVillages（已排好序），每組只留真的有候選人的村里；選了特定村里時名單已經先篩過，
    // 這裡自然只剩一組。村里是空值或對不上的人收進最後一組「未標示里別」（lib/village-grouping.ts）。
    const groups = withAnchors(spec, groupByVillage(people, availableVillages.value).map(g => ({ label: g.village, people: g.people })))
    return { spec, people, groups, chips: [], empty: groups.length === 0, anchor }
  }
  return { spec, people, groups: [], chips: [], empty: people.length === 0, anchor }
}

function sectionsOf(types: readonly string[]): LevelSection[] {
  return types.map(positionSpec).filter((s): s is PositionSpec => !!s).map(buildSection)
}
const thisLevelSections = computed(() => sectionsOf(levelPlan.value.thisLevel))

/**
 * 區塊標題列的「政見 PK」按鈕（2026-10-06 維護者：取代區塊底下的並排比較，功能併進 PK 頁籤）。
 * 連到這一頁的 PK 頁籤、選好這個職位與這一場、帶入這一組全部的參選人；真連結，預渲染的 HTML 裡就有。
 *   卡片排法的區塊可能含好幾場（縣市頁的立委好幾個選區、鄉鎮市長好幾個鄉鎮）：只有一場就帶那一場，好幾場就只帶職位、到 PK 再選
 *   分組排法的區塊（議員依選區、村里長依里）：每一組各一顆，帶那一組；「選區待補」「未標示里別」不知道是哪一場，不給
 *   同一場不到兩位會出現在選票上的人：沒有 PK 可看，不給
 */
function pkLink(type: string, district?: string): RouteLocationRaw {
  return { path: electionPath(electionSeg.value, selectedRegion.value, selectedSubRegion.value), query: pkQuery(type, district) }
}
function sectionPkLink(section: LevelSection): RouteLocationRaw | undefined {
  // 全台頁的縣市長、縣市頁的鄉鎮市長等區塊：PK 要先選縣市／鄉鎮，區塊上不放按鈕（請用上方的縣市選擇器與右側的鄉鎮市區）
  if (pkNeeds(section.spec.type, selectedRegion.value, selectedSubRegion.value)) return undefined
  const groups = pkGroups(section.people, section.spec.type).filter(hasPk)
  if (groups.length === 0) return undefined
  return pkLink(section.spec.type, groups.length === 1 ? groups[0].label : undefined)
}
function groupPkLinkFor(type: string) {
  return (group: { label: string; people: Politician[] }): RouteLocationRaw | undefined => {
    if (pkNeeds(type, selectedRegion.value, selectedSubRegion.value)) return undefined
    const g = pkGroups(group.people, type).find(x => x.label === group.label.trim())
    return hasPk(g) ? pkLink(type, g!.label) : undefined
  }
}
const nextLevelSections = computed(() => sectionsOf(levelPlan.value.nextLevel))
/**
 * 右側面板的「選舉區」選擇（2026-10-06 維護者：列表上方的選舉區／村里選擇改放右側，上方不重複）：
 * 縣市頁的縣市議員、原住民區頁的區代表（只在「候選人」頁籤，其他頁籤不用選舉區）；選區不到兩個就不需要選。選了只看那一區（selectedDistrict，議員與區代表共用）。
 */
const districtPanels = computed(() => viewMode.value !== 'politicians' ? [] : [...thisLevelSections.value, ...nextLevelSections.value]
  .filter(sec => sec.spec.display === 'district' && !sec.empty && sec.chips.length > 1)
  .map(sec => ({ type: sec.spec.type, title: `${sec.spec.label}選舉區`, chips: sec.chips })))

/**
 * 頁內錨點（2026-10-05）：人物頁麵包屑的職位層連到這一頁的區塊，例如 /election/2026/金門縣#縣市長、
 * #縣市議員-第01選舉區。區塊的 id 由 sectionAnchor 產生（lib/election-levels.ts），麵包屑連的是同一個函式的輸出。
 *
 * router 的 scrollBehavior 是關的（站內換頁不亂捲），所以這裡自己捲：從別頁點進來時區塊要等資料載入才畫得出來，
 * 直接開網址時瀏覽器原生的 #錨點也只抓得到預渲染就有的區塊。想捲的 id 先記著，區塊出現了才捲。
 *
 * 捲到之後版面還會變，區塊會被往下推（2026-10-05 實測，約三成機率）：人物頁帶過來的同選區幾個人先把那一組畫出來，
 * 資料載完才冒出排在前面的縣市長；選舉區對應表（77 KB）載完才出現右側的鄉鎮篩選欄，主欄變窄、上面的卡片從一排
 * 變兩排。所以捲到之後不放手：版面高度一變就再捲一次，直到使用者自己動手（滾輪、觸控、按鍵、點擊）或過了
 * FOLLOW_MS——之後換篩選、重新載入都不會再把使用者拉回去。
 */
const pendingAnchor = ref('')
const FOLLOW_MS = 8000
const FOLLOW_STOP_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
let stopFollowing: (() => void) | undefined
function followAnchor(id: string) {
  stopFollowing?.()
  if (typeof ResizeObserver === 'undefined') return
  let frame = 0
  const observer = new ResizeObserver(() => {
    if (frame) return
    frame = requestAnimationFrame(() => { frame = 0; document.getElementById(id)?.scrollIntoView({ block: 'start' }) })
  })
  observer.observe(document.body)
  const stop = () => {
    observer.disconnect()
    clearTimeout(timer)
    cancelAnimationFrame(frame)
    for (const ev of FOLLOW_STOP_EVENTS) window.removeEventListener(ev, stop)
    stopFollowing = undefined
  }
  const timer = setTimeout(stop, FOLLOW_MS)
  for (const ev of FOLLOW_STOP_EVENTS) window.addEventListener(ev, stop, { passive: true })
  stopFollowing = stop
}
onDeactivated(() => stopFollowing?.())
onBeforeUnmount(() => stopFollowing?.())
function anchorInRoute(): string {
  const raw = route.hash.replace(/^#/, '')
  try { return decodeURIComponent(raw) } catch { return raw }
}
function scrollToPendingAnchor() {
  const id = pendingAnchor.value
  if (!id || typeof document === 'undefined') return
  // KeepAlive 下別頁的網址變動也會喊到這裡，只在選舉頁自己的網址上動作
  if (route.name !== 'election' && route.name !== 'election-region' && route.name !== 'election-township') return
  // 鄉鎮頁的錨點要等鄉鎮套上之後才找，不然會先捲到縣市頁上同名的區塊（例如鄉鎮市長）。
  // 鄉鎮在路徑上（/election/2022/金門縣/金城鎮#村里長-東門里，2026-10-05）；舊的 ?sub= 還沒被換成路徑之前
  // （policy-tw.web.app、站內舊連結，正見.tw 上 Worker 已經先 301 過了）一樣要等
  const legacySub = route.query.sub
  const sub = routeSubRegion.value ?? (typeof legacySub === 'string' && legacySub ? legacySub : undefined)
  if (sub && selectedSubRegion.value !== sub) return
  const el = document.getElementById(id)
  if (!el) {
    // 資料還在載入、區塊還沒畫出來：之後畫出來會再試；載完還沒有就是沒有這個區塊，放棄（免得之後切篩選時突然被捲過去）
    if (!electionLoading.value) pendingAnchor.value = ''
    return
  }
  el.scrollIntoView({ block: 'start' })
  pendingAnchor.value = ''
  followAnchor(id)
}
function queueAnchorScroll() {
  pendingAnchor.value = anchorInRoute()
  void nextTick(scrollToPendingAnchor)
}
onMounted(queueAnchorScroll)
onActivated(queueAnchorScroll)
watch(() => route.hash, queueAnchorScroll)
watch([thisLevelSections, nextLevelSections, selectedSubRegion, electionLoading], () => { void nextTick(scrollToPendingAnchor) })

// 檢查本次選舉是否有地方層級候選人（議員、鄉鎮市長、代表、村里長）
const hasLocalCandidates = computed(() => {
  const localTypes = [
    ElectionType.COUNCILOR,
    ElectionType.TOWNSHIP_MAYOR,
    ElectionType.INDIGENOUS_DISTRICT_CHIEF,
    ElectionType.REPRESENTATIVE,
    ElectionType.INDIGENOUS_DISTRICT_REP,
    ElectionType.CHIEF
  ]
  return electionPoliticians.value.some(c => localTypes.includes(getElectionType(c) as ElectionType))
})

/**
 * 這一屆有沒有立法委員要選。
 *
 * 不能用「撈回來的候選人裡有沒有立委」判斷——全台頁刻意不撈立委（他們全是綁縣市選區的
 * 區域立委，屬縣市層，見 lib/election-levels.ts），所以那一頁本來就一位都沒有。
 * 要問的是「這一屆有哪些職位在選」。
 */
const hasLegislatorRace = computed(() => availableElectionTypes.value.includes(ElectionType.LEGISLATOR))

const electionPoliticianIds = computed(() => new Set(electionPoliticians.value.map(c => c.id)))

/**
 * 這筆政見屬不屬於這場選舉。2026-09-18 之前三個檢視都只看「這個人有參加這場選舉」，
 * 於是同一個人 2024／2022 的舊承諾會混進 2026 的頁面（候選人卡片上的政見數有篩屆別，
 * 點進去的清單沒有，兩邊對不上）。
 * 只認標了屆別的：沒標的（目前 150 筆）先不顯示，等 policy_election_missing 任務補上。
 * 三個檢視共用這一個判斷，不要各寫各的。
 */
// policies.election_id 是 elections.id（舊三屆剛好等於年份，新增的選舉不是）——比 id，不比年份（#344 第二階段 A）
const belongsToThisElection = (p: { electionId?: number }) => p.electionId === electionId.value

const allCampaignPolicies = computed(() =>
  policies.value.filter(p => {
    if (p.status !== PolicyStatus.CAMPAIGN || !belongsToThisElection(p) || !electionPoliticianIds.value.has(p.politicianId)) return false
    const politician = politicians.value.find(c => c.id === p.politicianId)
    if (!politician) return false
    if (selectedRegion.value !== 'All' && !sameRegionName(politician.region, selectedRegion.value)) return false
    // 鄉鎮市區篩選（議員透過對應表查詢選舉區）
    if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All') {
      if (getElectionType(politician) === ElectionType.COUNCILOR) {
        const electoralDistrict = getElectoralDistrictByTownship(selectedRegion.value, selectedSubRegion.value, electionYear.value)
        if (electoralDistrict && politician.subRegion !== electoralDistrict) return false
      } else {
        if (!sameRegionName(politician.subRegion, selectedSubRegion.value)) return false
      }
    }
    return true
  })
)

// Issues mode
const regionPolicies = computed(() =>
  policies.value.filter(p => {
    if (p.status !== PolicyStatus.CAMPAIGN || !belongsToThisElection(p) || !electionPoliticianIds.value.has(p.politicianId)) return false
    const politician = politicians.value.find(c => c.id === p.politicianId)
    if (!politician) return false
    if (selectedRegion.value !== 'All' && !sameRegionName(politician.region, selectedRegion.value)) return false
    // 鄉鎮市區篩選（議員透過對應表查詢選舉區）
    if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All') {
      if (getElectionType(politician) === ElectionType.COUNCILOR) {
        const electoralDistrict = getElectoralDistrictByTownship(selectedRegion.value, selectedSubRegion.value, electionYear.value)
        if (electoralDistrict && politician.subRegion !== electoralDistrict) return false
      } else {
        if (!sameRegionName(politician.subRegion, selectedSubRegion.value)) return false
      }
    }
    return true
  })
)

const categoryFilteredPolicies = computed(() =>
  selectedIssueCategory.value === 'All' ? regionPolicies.value : regionPolicies.value.filter(p => p.category === selectedIssueCategory.value)
)

// 議題頁的標籤要是「講什麼事」：候選人名、年份、「2026新北市長」、來源、口號都濾掉（lib/issue-tags.ts，2026-09-22）；
// 完全沒可用標籤的政見退回它的類別，不然 177／223 筆 2026 政見在議題頁根本不出現
// 「不是議題的名字」：候選人名＋該縣市的鄉鎮市區名（楊梅、中壢、蘆竹這種標籤是地名不是議題），去掉「區／鄉／鎮／市」後綴也算
const electionPoliticianNames = computed(() => {
  const names = new Set(electionPoliticians.value.map(c => c.name))
  for (const sub of availableSubRegions.value) {
    names.add(sub)
    names.add(sub.replace(/[區鄉鎮市]$/, ''))
  }
  return names
})
const tagCounts = computed(() => {
  const counts: { [key: string]: number } = {}
  categoryFilteredPolicies.value.forEach(p => {
    issueTagsOf(p, electionPoliticianNames.value).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1 })
  })
  return counts
})

const availableTags = computed(() =>
  Object.keys(tagCounts.value).filter(tag => tagCounts.value[tag] > 0).sort((a, b) => tagCounts.value[b] - tagCounts.value[a])
)

watch([() => selectedIssueCategory.value, () => selectedRegion.value, () => selectedSubRegion.value, availableTags], () => {
  if (availableTags.value.length > 0 && (!selectedIssueTag.value || !availableTags.value.includes(selectedIssueTag.value))) {
    selectedIssueTag.value = availableTags.value[0]
  } else if (availableTags.value.length === 0) {
    selectedIssueTag.value = ''
  }
})

// Comparison mode
/** 選區是整個縣市（或全國）的層級：鄉鎮篩選對它沒有意義，不套用（2026-09-22：台東縣＋大武鄉把縣市長 PK 篩成空池） */
const COUNTY_WIDE_LEVELS: readonly string[] = [ElectionType.PRESIDENT, ElectionType.MAYOR]
/** 套上這一屆資料的候選人（號次、選區要是這一屆的，不是人物最近一屆的） */
const currentElectionPoliticians = computed(() => electionPoliticians.value.map(withCurrentElectionData))
function poolForLevel(level: ElectionType) {
  return currentElectionPoliticians.value.filter(c => {
    const type = getElectionType(c)
    if (!(type === level || (!type && level === ElectionType.MAYOR))) return false
    if (selectedRegion.value !== 'All' && !sameRegionName(c.region, selectedRegion.value)) return false
    // 鄉鎮市區篩選：議員透過對應表查選舉區；鄉鎮層級直接比；全縣層級不套用
    if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All' && !COUNTY_WIDE_LEVELS.includes(level)) {
      if (type === ElectionType.COUNCILOR) {
        const electoralDistrict = getElectoralDistrictByTownship(selectedRegion.value, selectedSubRegion.value, electionYear.value)
        if (electoralDistrict && c.subRegion !== electoralDistrict) return false
      } else {
        if (!sameRegionName(c.subRegion, selectedSubRegion.value)) return false
      }
    }
    return true
  })
}
const comparisonPool = computed(() => poolForLevel(pkLevel.value))
/** 目前地區各層級有幾個人可以 PK；只列有人的層級，頁籤上帶人數（全部 0 才退回全部，讓使用者看得出是資料還沒有） */
const levelCounts = computed(() => new Map(electionLevels.value.map(l => [l.type, poolForLevel(l.type).length])))
const visibleLevels = computed(() => {
  const withPeople = electionLevels.value.filter(l => (levelCounts.value.get(l.type) ?? 0) > 0)
  const levels = withPeople.length > 0 ? withPeople : electionLevels.value
  // 全台頁：有全國一場的職位（總統副總統）就只列它，區域立委、縣市長…要先選縣市，不放進職位列
  // （舊網址 ?type=立法委員 在全台頁對不上，退回第一個職位）；一個全國性職位都沒有（九合一）才全列、由提示說先選縣市
  const national = levels.filter(l => !pkNeeds(l.type, selectedRegion.value, selectedSubRegion.value))
  return selectedRegion.value === 'All' && national.length > 0 ? national : levels
})
/** 鄉鎮篩選對全縣層級沒作用時說一句，不然使用者會以為大武鄉的縣長候選人就是這幾位 */
const subRegionIgnoredNote = computed(() =>
  selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All' && COUNTY_WIDE_LEVELS.includes(pkLevel.value)
    ? `${pkLevel.value}是全${selectedRegion.value.endsWith('市') ? '市' : '縣'}選舉，「${selectedSubRegion.value}」的篩選在這一層不套用；要看該鄉鎮的選區請切到議員或鄉鎮層級`
    : ''
)

/**
 * 政見 PK（2026-10-06 改成多人）：這一頁這個職位分成一場一場（lib/policy-compare.ts 的 pkGroups，只留至少兩位的），
 * 網址選的那一場（沒選或對不上＝第一個有政見的那一場），預設這一場全部的人，可勾選增減。
 * 只在瀏覽器端畫、不進預渲染 HTML（維護者 10-06：PK 不是正文，政見的正文在政見頁與人物頁），見模板的 VIEW: Comparison。
 */
/** 範圍還不夠的職位（全台頁的縣市長、縣市頁的鄉鎮市長…）：不另畫縣市／鄉鎮按鈕，提示去用上方的縣市選擇器或右側的鄉鎮市區（模板的提示） */
const pkMissing = computed(() => pkNeeds(pkLevel.value, selectedRegion.value, selectedSubRegion.value))
const pkGroupList = computed(() => pkMissing.value ? [] : pkGroups(comparisonPool.value, pkLevel.value).filter(hasPk))
const groupHasPolicies = (g: { people: Politician[] }) => hasPolicies(g.people, policies.value, electionId.value)
const pkGroup = computed(() => pickGroup(pkGroupList.value, comparisonDistrict.value, groupHasPolicies))
const pkCandidates = computed(() => pkGroup.value ? comparablePeople(pkGroup.value.people) : [])
const pkIds = computed(() => pkCandidates.value.map(c => String(c.id)))
const pkPicked = computed(() => parsePick(comparisonPick.value, pkIds.value))
const pkMatrix = computed(() => {
  const picked = new Set(pkPicked.value)
  return compareMatrix(pkCandidates.value.filter(c => picked.has(String(c.id))), policies.value, electionId.value, categories.value)
})
const levelLabel = (type: string) => ALL_LEVELS.find(l => l.type === type)?.label ?? type
const pkTitle = computed(() => {
  const label = levelLabel(pkLevel.value)
  const g = pkGroup.value?.label
  return g && g !== '全國' && g !== selectedRegion.value ? `${label}・${g}` : label
})
/** PK 的選區（議員、立委的選舉區，村里長的村里）：放在右側面板，不放在 PK 主欄；一場就不需要選 */
const pkDistrictPanel = computed(() => viewMode.value !== 'comparison' || pkGroupList.value.length < 2 ? null : {
  title: pkLevel.value === ElectionType.CHIEF ? '村里' : `${levelLabel(pkLevel.value)}選舉區`,
  links: pkGroupList.value.map(g => ({ label: g.label, to: pkLink(pkLevel.value, g.label), active: g === pkGroup.value })),
})
/** 勾選／取消一位（至少留一位）；全部勾選時網址不寫 pick */
function togglePk(id: string) {
  const picked = new Set(pkPicked.value)
  if (picked.has(id)) { if (picked.size > 1) picked.delete(id) } else picked.add(id)
  comparisonPick.value = buildPick(picked, pkIds.value)
}

const ALL_LEVELS = [
  { type: ElectionType.PRESIDENT, label: '總統' },
  { type: ElectionType.LEGISLATOR, label: '立法委員' },
  { type: ElectionType.MAYOR, label: '縣市長' },
  { type: ElectionType.COUNCILOR, label: '縣市議員' },
  { type: ElectionType.TOWNSHIP_MAYOR, label: '鄉鎮市長' },
  { type: ElectionType.INDIGENOUS_DISTRICT_CHIEF, label: '原民區長' },
  { type: ElectionType.REPRESENTATIVE, label: '鄉鎮市民代表' },
  { type: ElectionType.INDIGENOUS_DISTRICT_REP, label: '原民區代表' },
  { type: ElectionType.CHIEF, label: '村里長' }
]
// 只列本屆真的有的層級（election_types 表）：2026 九合一沒有總統／立委，2024 沒有地方層級。表沒資料才退回全部。
const electionLevels = computed(() => {
  const types = election.value?.types ?? []
  return types.length > 0 ? ALL_LEVELS.filter(l => types.includes(l.type)) : ALL_LEVELS
})
/**
 * PK 實際比的職位：網址指定的（本屆、這一頁有的）優先；沒指定或指定了沒有的（2026 帶立法委員、鄉鎮頁帶縣市長）→
 * 第一個有政見可比的職位 → 第一個有人可比的職位 → 第一個職位。網址上的 type 不改寫，換頁回來照樣認。
 */
const pkLevel = computed<ElectionType>(() => {
  const levels = visibleLevels.value
  const explicit = levels.find(l => l.type === comparisonLevel.value)
  if (explicit) return explicit.type
  const comparable = levels.map(l => ({ type: l.type, groups: pkNeeds(l.type, selectedRegion.value, selectedSubRegion.value) ? [] : pkGroups(poolForLevel(l.type), l.type).filter(hasPk) }))
  return (comparable.find(l => l.groups.some(groupHasPolicies)) ?? comparable.find(l => l.groups.length > 0))?.type
    ?? levels[0]?.type ?? ElectionType.MAYOR
})

/** 縣市頁的頁首：「2026 台北市 候選人與政見」；全台照舊 */
const pageCounty = computed(() => isCounty(selectedRegion.value) ? selectedRegion.value : undefined)
const countyLevelCounts = computed(() => {
  const county = pageCounty.value
  if (!county) return ''
  return ALL_LEVELS
    .map(l => ({ label: l.label, n: electionPoliticians.value.filter(c => {
      const data = getPoliticianElectionData(c, electionId.value)
      return data?.electionType === l.type && (data.region || c.region) === county
    }).length }))
    .filter(x => x.n > 0)
    .map(x => `${x.label} ${x.n} 位`)
    .join('、')
})
/**
 * 鄉鎮頁的頁首（2026-10-05）：「2022 嘉義縣大林鎮 候選人與政見」。
 * 人數照這一頁實際畫出來的區塊數（這一層＋下一層），不另外算一份——描述寫的人數要跟畫面一樣。
 */
const pageTownship = computed(() => pageCounty.value && selectedSubRegion.value !== 'All' ? selectedSubRegion.value : undefined)
const townshipLevelCounts = computed(() => [...thisLevelSections.value, ...nextLevelSections.value]
  .filter(s => s.people.length > 0)
  .map(s => `${s.spec.label} ${s.people.length} 位`)
  .join('、'))
usePageHead({
  title: () => {
    if (!election.value) return undefined
    const year = electionYear.value || election.value.electionDate.slice(0, 4)
    if (pageTownship.value) return `${year} ${pageCounty.value}${pageTownship.value} 候選人與政見`
    return pageCounty.value
      ? `${year} ${pageCounty.value} 候選人與政見`
      : (election.value.shortName || election.value.name)
  },
  description: () => {
    if (!election.value) return undefined
    if (pageTownship.value) {
      const counts = townshipLevelCounts.value ? `：${townshipLevelCounts.value}` : ''
      const appointed = levelPlan.value.thisLevel.length === 0 ? `區長由市政府指派，不是選舉產生。` : ''
      return `${election.value.name}${pageCounty.value}${pageTownship.value}參選人名單與競選承諾${counts}。${appointed}可依${villageLabel.value}篩選、逐項比較政見。`
    }
    if (pageCounty.value) {
      const counts = countyLevelCounts.value ? `：${countyLevelCounts.value}` : ''
      return `${election.value.name}${pageCounty.value}參選人名單與競選承諾${counts}。可依鄉鎮市區篩選、逐項比較政見。`
    }
    return `${election.value.name}（投票日 ${election.value.electionDate}）候選人名單與競選承諾：總統、立委、縣市長到議員、鄉鎮市長、村里長，依縣市與鄉鎮篩選，比較政見。`
  },
})
</script>

<template>
  <div v-if="election" class="bg-slate-50 min-h-screen">

    <Hero full-width :background-image="heroBackgroundImage">
      <template #title>
        <div class="relative w-full">
          <div v-if="pageCounty">
            {{ electionYear || election.electionDate.slice(0, 4) }} {{ pageCounty }}{{ pageTownship }}<br/><span class="text-amber-400">候選人與政見</span>
          </div>
          <div v-else>
            預見未來，<br/><span class="text-amber-400">從您居住的城市開始</span>
          </div>
          <div class="hidden md:block absolute right-0 top-1/2 -translate-y-1/2">
            <div class="bg-white/5 backdrop-blur-md border border-white/20 rounded-[32px] p-8 text-center transform rotate-2 hover:rotate-0 transition-all duration-500 shadow-2xl shadow-blue-500/10">
              <div class="text-sm text-slate-400 mb-2 flex items-center justify-center gap-2 font-medium">
                <Clock :size="18" class="text-amber-400" /> 距離投票日
              </div>
              <div class="text-7xl font-black text-white mb-1 font-mono tracking-tighter leading-none animate-pulse">
                <!-- 倒數天數依當下日期計算，建置時算的會過期，只在瀏覽器渲染 -->
                <ClientOnly>
                  {{ timeLeft.days }}
                  <template #placeholder>&nbsp;</template>
                </ClientOnly>
              </div>
              <div class="text-sm font-bold text-amber-400 uppercase tracking-[0.3em] pl-[0.3em]">
                Days Left
              </div>
            </div>
          </div>
        </div>
      </template>
      <template #description>不僅是縣市長，我們深入記錄議員、鄉鎮代表等基層候選人的競選承諾。</template>

      <!-- Hero Actions: View Mode Tabs -->
      <template #actions>
        <!-- 檢視切換一律走 HeroAction：尺寸與間距跟全站動作區一致；手機用兩字短標讓四顆擠進一排 -->
        <HeroAction v-for="v in VIEW_TABS" :key="v.key" :active="viewMode === v.key" @click="viewMode = v.key">
          <component :is="v.icon" :size="16" />
          <span class="sm:hidden">{{ v.short }}</span>
          <span class="hidden sm:inline">{{ v.label }}</span>
        </HeroAction>
      </template>

      <!-- 縣市是真連結（/election/2026/台北市），點起來跟以前一樣切縣市，爬蟲也走得到 -->
      <GlobalRegionSelector :current="selectedRegion" :link-for="regionLink" />
    </Hero>


    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">

      <!--
        名單撈不完整時一定要講。少人比整頁空白難發現得多：高雄市 2022 曾經只載到村里長，
        市長與議員整個區塊不見，畫面上看起來就只是「這一屆沒有人參選」。
        這裡只說發生什麼、能怎麼辦；是哪支查詢撈到上限、撈了幾頁進 console。
      -->
      <div v-if="politicianListIncomplete" class="mb-8 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        參選人名單可能不完整，有些人沒有顯示出來。請重新整理頁面再試一次。
      </div>

      <div class="flex flex-col md:flex-row gap-8">

      <!-- 左側：主要內容 -->
      <div :class="selectedRegion !== 'All' && availableSubRegions.length > 0 ? 'flex-1 min-w-0 md:w-2/3' : 'w-full min-w-0'">

      <!-- VIEW: Politicians -->

      <div v-if="viewMode === 'politicians'" class="animate-fade-in">
        <!-- 排序選單：預設最近更新；不讓任何人固定排第一 -->
        <div class="flex items-center justify-end gap-2 mb-4 text-sm">
          <label for="candidate-sort" class="text-slate-400" title="排序"><ArrowUpDown :size="16" /><span class="sr-only">排序</span></label>
          <select id="candidate-sort" v-model="sortMode" class="border border-slate-300 rounded-lg px-2 py-1 text-sm text-slate-700 bg-white focus:ring-2 focus:ring-violet-500 focus:border-violet-500">
            <option v-for="o in SORT_OPTIONS" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
        </div>
        <!--
          分層（2026-10-05 #348 收成設定）：每一頁只畫「這一層＋下一層」，畫哪些職位、什麼順序、
          用卡片還是分組，全部照 lib/election-levels.ts 的 POSITIONS。加職位只要在那張表加一列。
            全台      總統副總統｜各縣市長
            縣市      縣市長、縣市議員、立法委員｜鄉鎮市長（直轄市：原住民區長）
            縣轄鄉鎮  鄉鎮市長、鄉鎮市民代表｜村里長
            直轄市區  原住民區：區長、區代表｜里長；一般區：區長官派（一行小字）｜里長
          這裡只剩各層的「附加物」：全台頁的立委引導、縣市頁的名錄、鄉鎮層的空白提示。
        -->
        <!--
          每個區塊標題列有一顆「政見 PK」（2026-10-06，取代 #364 放在區塊底下的並排比較）：連到 PK 頁籤、選好職位與那一場，
          規則在上面的 sectionPkLink／groupPkLinkFor。
        -->
        <template v-for="section in thisLevelSections" :key="section.spec.type">
          <PoliticianGrid v-if="section.spec.display === 'grid' && !section.empty" :id="section.anchor" :politicians="section.people" :columns="gridColumns" :election-id="electionId" :title="`${section.spec.label}參選人`" :pk-link="sectionPkLink(section)"><template #icon><component :is="LEVEL_ICONS[section.spec.icon]" :class="section.spec.iconClass" /></template></PoliticianGrid>
          <ChipFilteredGroups
            v-else-if="section.spec.display !== 'grid' && !section.empty"
            :id="section.anchor"
            :groups="section.groups"
            :columns="gridColumns"
            :election-id="electionId"
            :title-prefix="section.spec.display === 'district' ? section.spec.label : undefined"
            :pk-link-for="groupPkLinkFor(section.spec.type)"
          ><template #icon><component :is="LEVEL_ICONS[section.spec.icon]" :class="section.spec.iconClass" /></template></ChipFilteredGroups>
        </template>

        <!-- 直轄市一般區：區長市府指派，這一層沒有職位，一行小字說明，不擋里長名單 -->
        <p v-if="levelPlan.scope === 'township' && isSpecialMunicipality && levelPlan.thisLevel.length === 0" class="text-xs text-slate-400 mb-4">{{ selectedSubRegion }}的區長由市政府指派，不是選舉產生。</p>

        <template v-for="section in nextLevelSections" :key="section.spec.type">
          <PoliticianGrid v-if="section.spec.display === 'grid' && !section.empty" :id="section.anchor" :politicians="section.people" :columns="gridColumns" :election-id="electionId" :title="`${section.spec.label}參選人`" :pk-link="sectionPkLink(section)"><template #icon><component :is="LEVEL_ICONS[section.spec.icon]" :class="section.spec.iconClass" /></template></PoliticianGrid>
          <ChipFilteredGroups
            v-else-if="section.spec.display !== 'grid' && !section.empty"
            :id="section.anchor"
            :groups="section.groups"
            :columns="gridColumns"
            :election-id="electionId"
            :title-prefix="section.spec.display === 'district' ? section.spec.label : undefined"
            :pk-link-for="groupPkLinkFor(section.spec.type)"
          ><template #icon><component :is="LEVEL_ICONS[section.spec.icon]" :class="section.spec.iconClass" /></template></ChipFilteredGroups>
        </template>

        <!--
          全台頁的立委引導：立法委員不在全台層——資料裡的立委全部是綁縣市選區的區域立委（2024 那 312 位每一位
          都掛在「XX第NN選區」底下），列在全台頁既不是全國層級，也跟縣市頁完全重複。
          引導要能直接點過去，不是叫人自己去上面找（CLAUDE.md：換頁一律真連結，爬蟲才跟得到）。
        -->
        <section v-if="levelPlan.scope === 'national' && hasLegislatorRace" class="mb-12 text-left">
          <p class="text-sm text-slate-600 mb-3">區域立委依選區劃分，請選擇縣市查看：</p>
          <div class="flex flex-wrap gap-1.5">
            <RouterLink
              v-for="county in TAIWAN_COUNTIES"
              :key="county"
              :to="electionPath(electionSeg, county)"
              class="px-3 py-1 rounded-full text-xs font-bold border bg-white text-slate-600 border-slate-200 hover:bg-violet-50 hover:text-violet-700 hover:border-violet-200 transition-all"
            >{{ county }}</RouterLink>
          </div>
        </section>

        <!-- 縣市頁的鄉鎮市區參選人名錄：名字連結，收合在各鄉鎮底下（預渲染頁裡唯一通往村里長人物頁的連結） -->
        <section v-if="levelPlan.scope === 'county' && townshipDirectoryGroups.length > 0" class="mb-12 text-left">
          <h3 class="text-xl font-bold text-navy-900 mb-2 flex items-center gap-2 border-l-4 border-blue-500 pl-3">
            <Building2 class="text-indigo-500" /> 鄉鎮市區參選人名錄 ({{ townshipDirectoryTotal }})
          </h3>
          <p class="text-sm text-slate-500 mb-4">展開各{{ subRegionLabel }}看參選人名單；要看卡片請在右側選{{ subRegionLabel }}。</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
            <details v-for="t in townshipDirectoryGroups" :key="t.township" class="bg-white border border-slate-200 rounded-xl">
              <summary class="px-4 py-2.5 cursor-pointer font-bold text-navy-900 flex items-center justify-between">
                <span>{{ t.township }}</span>
                <span class="text-xs font-medium text-slate-400">{{ t.total }} 位</span>
              </summary>
              <div class="px-4 pb-3 space-y-2 text-sm leading-relaxed">
                <p v-for="g in t.groups" :key="g.label">
                  <span class="text-slate-500 font-medium">{{ g.label }}：</span>
                  <template v-for="(person, i) in g.people" :key="person.politicianId"><span v-if="i > 0" class="text-slate-300">、</span><RouterLink :to="`/politician/${person.politicianId}`" class="text-blue-700 hover:underline">{{ person.name }}</RouterLink><span v-if="person.village" class="text-slate-400 text-xs">（{{ person.village }}）</span></template>
                </p>
              </div>
            </details>
          </div>
        </section>

        <!-- 直轄市的區：下一層（里長）沒有人就提示（原住民區的區長、區代表名單照常列在上面） -->
        <div v-if="levelPlan.scope === 'township' && isSpecialMunicipality && nextLevelSections.every(s => s.empty)" class="text-center py-12 bg-white border border-dashed border-slate-300 rounded-xl">
          <MapPin :size="48" class="mx-auto mb-4 text-slate-300" />
          <h3 class="text-lg font-bold text-navy-900 mb-2">此{{ subRegionLabel }}無{{ villageLabel }}長參選人資料</h3>
          <p class="text-slate-500">請選擇其他{{ subRegionLabel }}查看。</p>
        </div>
        <!-- 縣轄鄉鎮市：這一層與下一層都沒有人時才算真的空 -->
        <div v-if="levelPlan.scope === 'township' && !isSpecialMunicipality && [...thisLevelSections, ...nextLevelSections].every(s => s.empty)" class="text-center py-12 bg-white border border-dashed border-slate-300 rounded-xl">
          <Building2 :size="48" class="mx-auto mb-4 text-slate-300" />
          <h3 class="text-lg font-bold text-navy-900 mb-2">此{{ subRegionLabel }}無參選人資料</h3>
          <p class="text-slate-500">請選擇其他{{ subRegionLabel }}查看。</p>
        </div>
      </div>

      <!-- VIEW: Pledges -->
      <div v-if="viewMode === 'pledges'" class="animate-fade-in grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <PolicyCard
          v-for="policy in allCampaignPolicies"
          :key="policy.id"
          :policy="policy"
          :politician="politicians.find(c => c.id === policy.politicianId)!"
        />
      </div>

      <!-- VIEW: Issues -->
      <div v-if="viewMode === 'issues'" class="space-y-8 animate-fade-in">
        <div>
          <div class="flex items-center gap-2 mb-2">
            <Layers :size="16" class="text-slate-400" />
            <span class="text-sm font-medium text-slate-500">議題分類篩選</span>
          </div>
          <div class="flex gap-4 w-full bg-slate-100 p-2 rounded-xl">
            <!-- Left: 全部 -->
            <div class="shrink-0 flex items-center gap-3">
              <button @click="selectedIssueCategory = 'All'" :class="`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${selectedIssueCategory === 'All' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`">全部</button>
              <div class="w-px h-6 bg-slate-300"></div>
            </div>
            <!-- Right: Wrap -->
            <div class="flex-grow flex flex-wrap items-center gap-2">
              <button v-for="category in categories" :key="category" @click="selectedIssueCategory = category" :class="`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${selectedIssueCategory === category ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'}`">{{ category }}</button>
            </div>
          </div>
        </div>

        <div v-if="selectedRegion === 'All'" class="text-center py-20 bg-white border border-dashed border-slate-300 rounded-xl">
          <Layers :size="48" class="mx-auto mb-4 text-slate-300" />
          <h3 class="text-lg font-bold text-navy-900 mb-2">請選擇特定縣市</h3>
          <p class="text-slate-500 max-w-md mx-auto">「議題串聯」功能需要針對特定行政區進行垂直分析。</p>
        </div>
        <template v-else>
          <div v-if="availableTags.length > 0" class="space-y-6">
            <div class="flex items-center gap-2 mb-2 overflow-x-auto no-scrollbar pb-2">
              <button
                v-for="tag in availableTags"
                :key="tag"
                @click="selectedIssueTag = tag"
                :class="`px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all border flex items-center gap-1 ${selectedIssueTag === tag ? 'bg-blue-600 text-white border-blue-600 shadow-md' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`"
              >
                <Hash :size="12" /> {{ tag }}
              </button>
            </div>
            <VerticalStack v-if="selectedIssueTag" :tag="selectedIssueTag" :policies="categoryFilteredPolicies" :election-politicians="electionPoliticians.map(withCurrentElectionData)" :junk-names="electionPoliticianNames" />
          </div>
          <div v-else class="text-center py-20 text-slate-400 bg-white border border-dashed border-slate-200 rounded-xl">
            <AlertCircle :size="48" class="mx-auto mb-4 opacity-50" />
            <p>此類別下尚未偵測到議題串聯。</p>
          </div>
        </template>
      </div>

      <!-- VIEW: Comparison（政見 PK，2026-10-06 改成多人）：刻意用 v-if、只在瀏覽器端畫——PK 不是正文，不進預渲染 HTML（維護者 10-06）。
           預渲染時 viewMode 一律是「候選人」（網址參數在掛載後才套用），帶 ?view=comparison 的網址 canonical 指回選舉頁本身 -->
      <div v-if="viewMode === 'comparison'" class="animate-fade-in space-y-6">
        <!-- 職位：真連結，換職位時選區與勾選重設 -->
        <div class="flex justify-start overflow-x-auto pb-2">
          <div class="inline-flex bg-slate-100 p-1 rounded-lg shrink-0">
            <RouterLink
              v-for="level in visibleLevels"
              :key="level.type"
              :to="pkLink(level.type)"
              :aria-current="pkLevel === level.type ? 'page' : undefined"
              :class="`px-4 py-2 rounded-md text-sm font-bold transition-all whitespace-nowrap ${pkLevel === level.type ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`"
            >{{ level.label }}<span class="ml-1 text-[11px] font-medium opacity-70">{{ levelCounts.get(level.type) ?? 0 }}</span></RouterLink>
          </div>
        </div>
        <p v-if="subRegionIgnoredNote" class="text-xs text-slate-500 -mt-4">{{ subRegionIgnoredNote }}</p>

        <!-- 縣市由上方的縣市選擇器、鄉鎮與選區由右側面板決定，PK 不另做一組；範圍還不夠就提示去哪裡選 -->
        <div v-if="pkMissing" class="text-center py-16 text-slate-500 border border-dashed border-slate-300 rounded-xl" data-testid="pk-pick-region">
          <Swords :size="48" class="mx-auto mb-4 opacity-50" />
          <p v-if="pkMissing === 'county'" class="font-bold text-slate-700">先在上方選擇縣市</p>
          <p v-else class="font-bold text-slate-700">先在右側選擇鄉鎮市區</p>
          <p class="text-sm mt-1">{{ levelLabel(pkLevel) }}的政見 PK 是一個{{ pkMissing === 'county' ? '縣市' : '鄉鎮市區' }}一場，選好之後就會並排這一場的參選人。</p>
        </div>
        <PolicyPk
          v-else
          :title="pkTitle"
          :candidates="pkCandidates"
          :picked="pkPicked"
          :matrix="pkMatrix"
          @toggle="togglePk"
          @all="comparisonPick = ''"
        />
      </div>

      </div><!-- 左側內容結束 -->

      <!-- 右側：篩選區（手機版顯示在上方） -->
      <div v-if="selectedRegion !== 'All' && availableSubRegions.length > 0" class="order-first md:order-last md:w-1/3 shrink-0">
        <div class="md:sticky md:top-[4.5rem] space-y-4">
          <!-- 鄉鎮市區篩選 -->
          <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div class="flex items-center gap-2 mb-3">
              <MapPin :size="16" class="text-slate-400" />
              <span class="text-sm font-bold text-slate-700">鄉鎮市區</span>
            </div>
            <!-- 鄉鎮是真連結（/election/2022/嘉義縣/大林鎮，2026-10-05）：點起來跟以前一樣切鄉鎮，爬蟲也走得到 -->
            <div class="flex flex-wrap gap-0.5">
              <RouterLink
                :to="townshipLink('All')"
                :aria-current="selectedSubRegion === 'All' ? 'page' : undefined"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedSubRegion === 'All' ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`"
              >全部</RouterLink>
              <RouterLink
                v-for="subRegion in availableSubRegions"
                :key="subRegion"
                :to="townshipLink(subRegion)"
                :aria-current="selectedSubRegion === subRegion ? 'page' : undefined"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedSubRegion === subRegion ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`"
              >{{ subRegion }}</RouterLink>
            </div>
          </div>

          <!-- 選舉區篩選（議員、原住民區代表；2026-10-06 從列表上方移到這裡）：點了只看那一區，再點一次取消 -->
          <div v-for="panel in districtPanels" :key="panel.type" class="bg-white rounded-xl border border-blue-200 p-4 shadow-sm" data-testid="district-panel">
            <div class="flex items-center gap-2 mb-3">
              <MapPin :size="16" class="text-blue-500" />
              <span class="text-sm font-bold text-slate-700">{{ panel.title }}</span>
            </div>
            <div class="flex flex-wrap gap-0.5 max-h-64 overflow-y-auto">
              <button
                type="button"
                @click="selectedDistrict = 'All'"
                :aria-pressed="selectedDistrict === 'All'"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedDistrict === 'All' ? 'bg-blue-600 text-white shadow-sm' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`"
              >全部</button>
              <button
                v-for="district in panel.chips"
                :key="district"
                type="button"
                @click="toggleDistrictChip(district)"
                :aria-pressed="selectedDistrict === district"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedDistrict === district ? 'bg-blue-600 text-white shadow-sm' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`"
              >{{ district }}</button>
            </div>
          </div>

          <!-- 政見 PK 的選區（跟其他頁籤的選舉區、村里同一個位置；真連結，網址 district 參數照舊） -->
          <div v-if="pkDistrictPanel" class="bg-white rounded-xl border border-blue-200 p-4 shadow-sm" data-testid="pk-district-panel">
            <div class="flex items-center gap-2 mb-3">
              <MapPin :size="16" class="text-blue-500" />
              <span class="text-sm font-bold text-slate-700">{{ pkDistrictPanel.title }}</span>
            </div>
            <div class="flex flex-wrap gap-0.5 max-h-64 overflow-y-auto">
              <RouterLink
                v-for="d in pkDistrictPanel.links"
                :key="d.label"
                :to="d.to"
                :aria-current="d.active ? 'page' : undefined"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${d.active ? 'bg-blue-600 text-white shadow-sm' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`"
              >{{ d.label }}</RouterLink>
            </div>
          </div>

          <!-- 村里篩選 -->
          <div v-if="availableVillages.length > 0 && viewMode !== 'comparison'" class="bg-white rounded-xl border border-amber-200 p-4 shadow-sm">
            <div class="flex items-center gap-2 mb-3">
              <MapPin :size="16" class="text-amber-500" />
              <span class="text-sm font-bold text-slate-700">村里</span>
            </div>
            <div class="flex flex-wrap gap-0.5 max-h-64 overflow-y-auto">
              <button
                @click="selectedVillage = 'All'"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedVillage === 'All' ? 'bg-amber-500 text-white shadow-sm' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`"
              >全部</button>
              <button
                v-for="village in availableVillages"
                :key="village"
                @click="selectedVillage = village"
                :class="`px-3 py-1.5 rounded-lg text-sm font-medium transition-all min-w-[50px] text-center ${selectedVillage === village ? 'bg-amber-500 text-white shadow-sm' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`"
              >{{ village }}</button>
            </div>
          </div>

          <!-- 篩選狀態摘要 -->
          <div v-if="selectedSubRegion !== 'All' || selectedDistrict !== 'All'" class="bg-slate-50 rounded-xl p-4 text-sm text-slate-600">
            <div class="flex items-center gap-2">
              <span class="font-medium">目前篩選：</span>
              <span v-if="selectedSubRegion !== 'All'" class="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{{ selectedSubRegion }}</span>
              <span v-if="selectedDistrict !== 'All'" class="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{{ selectedDistrict }}</span>
              <span v-if="selectedVillage !== 'All'" class="bg-amber-100 text-amber-700 px-2 py-0.5 rounded">{{ selectedVillage }}</span>
            </div>
          </div>
        </div>
      </div>

      </div><!-- flex 結束 -->
    </div>
  </div>

  <!-- Loading state -->
  <div v-else-if="loading || electionLoading" class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Loader2 :size="48" class="mx-auto mb-4 text-blue-500 animate-spin" />
      <p class="text-slate-500">載入中...</p>
    </div>
  </div>

  <!-- 資料拿不到（不是不存在）：給重試，別冒充「找不到」 -->
  <LoadError v-else-if="error" />

  <!-- Election not found -->
  <div v-else class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Vote :size="64" class="mx-auto mb-4 text-slate-300" />
      <h2 class="text-2xl font-bold text-navy-900 mb-2">找不到此選舉</h2>
      <p class="text-slate-500">請確認網址是否正確。</p>
    </div>
  </div>
</template>
