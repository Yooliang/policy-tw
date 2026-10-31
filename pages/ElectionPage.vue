<script lang="ts">
export default { name: 'ElectionPage' }
</script>

<script setup lang="ts">
import { ref, shallowRef, computed, watch, nextTick, onMounted, onActivated, onDeactivated, onBeforeUnmount, type Component } from 'vue'
import { useSupabase } from '../composables/useSupabase'
import ElectionHero from '../components/ElectionHero.vue'
import RegionalStatsPanel from '../components/RegionalStatsPanel.vue'
import ScrollRow from '../components/ScrollRow.vue'
import { runAfterRender } from '../lib/after-render'
import { PolicyStatus, ElectionType, type Politician, type Policy } from '../types'
import { compareByPolicyDateDesc } from '../lib/policy-date'
import PolicyCard from '../components/PolicyCard.vue'
import PoliticianGrid from './election/PoliticianGrid.vue'
import VerticalStack from './election/VerticalStack.vue'
import MdDrawer, { type MdPick } from '../components/MdDrawer.vue'
import Pagination from '../components/Pagination.vue'
import { clampPage, slicePage, totalPagesOf } from '../lib/pagination'
import SortIcons, { type SortIconOption } from '../components/SortIcons.vue'
import { dataRegionCategoryMdPath, dataRegionMdPath } from '../lib/md/format'
import ChipFilteredGroups from './election/ChipFilteredGroups.vue'
import PolicyPk from './election/PolicyPk.vue'
import { buildPick, comparablePeople, compareMatrix, hasPk, hasPolicies, parsePick, pickGroup, pkGroups, pkLocationLabel, pkNeeds, pkPickForLocation, pkQuery, sameDistrict } from '../lib/policy-compare'
import { renderPkMd } from '../lib/policy-pk-md'
import { useRouter, useRoute, RouterLink } from 'vue-router'
import {
  Vote, Flag, AlertCircle, Users, MapPin,
  Search, Layers,
  Building2, Mountain, Landmark, MessageCircle, Hash, Loader2,
  Crown, ScrollText, Swords, FileText, Clock, List, Eye, ChevronDown } from 'lucide-vue-next'
import { latestLocalElection } from '../lib/md/scope'

import { useGlobalState } from '../composables/useGlobalState'
import { isRunningCandidate } from '../lib/candidate-status'
import { issueTagsOf } from '../lib/issue-tags'
import { VIEW_MODES, VIEW_TABS, type ElectionViewMode } from '../lib/election-view-tabs'
import LoadError from '../components/LoadError.vue'
import { canonicalPath, SITE_URL, usePageHead } from '../composables/usePageHead'
import { candidateListItems, itemListLd, regionDescription, type LevelCount } from '../lib/seo'
import { useRegionQuerySync, queryField } from '../composables/useRegionQuerySync'
import { electionPath, isCounty, TAIWAN_COUNTIES } from '../lib/election-regions'
import { electionSegment, electionYearOfDate, legacyKeySegmentTarget } from '../lib/election-route'
import { classifyWard } from '../lib/ward-classification'
import { planLevels, POSITIONS, positionSpec, sectionAnchor, type PositionSpec } from '../lib/election-levels'
import { groupByVillage } from '../lib/village-grouping'
import { districtsOf, groupByDistrict } from '../lib/district-grouping'
import { electionArea } from '../lib/election-area'
import { DIRECTORY_LEVELS, buildTownshipDirectory, directoryTotal } from '../lib/township-directory'
import { compareRegionName, normalizeRegionName, sameRegionName } from '../lib/region-name'
import { comparePerson, comparePersonName } from '../lib/person-name'
import { inTownship, townshipOfSubRegion } from '../lib/election-townships'
import { listByBallotNo, listByCountyBallot } from '../lib/ballot-number'
import type { RouteLocationRaw } from 'vue-router'
import SwipeTabStrip from '../components/SwipeTabStrip.vue'
import { useSwipeTabs, adjacentPanelClass } from '../composables/useSwipeTabs'
import { useMobileShell, isMobileViewport } from '../composables/useMobileShell'
import { useMobileHeader } from '../composables/useMobileHeader'
import { useDeskNav, type DeskGroup, type DeskItem, type DeskNavModel } from '../composables/useDeskNav'
import { fileCache } from '../lib/map-data-cache'
import rasterIndex from '../data/tw-raster-index.json'
import districtCacheData from '../data/tw-districts/2026.json'

const router = useRouter()
const route = useRoute()
/** 顯示用名稱（必須宣告在最前面：usePageHead 的 description 在 setup 就會算到 townshipLevelCounts，晚宣告會在鄉鎮頁炸 TDZ「Cannot access before initialization」，2026-10-31 上線後抓到）：鄉鎮市長→鄉鎮市區長、鄉鎮市民代表→鄉鎮市區民代表（只改畫面文字；資料庫 election_type 值、錨點與比對一律用原名） */
const DISPLAY_LABELS: Record<string, string> = { 鄉鎮市長: '鄉鎮市區長', 鄉鎮市民代表: '鄉鎮市區民代表' }
const displayLabel = (label: string) => DISPLAY_LABELS[label] ?? label
/**
 * 「分頁面板版面」（層級分頁＋共用定位，原本只有手機版）：2026-10-31 桌面版也改成這一套——層級與地區由左邊延伸欄選（DeskExtNav），
 * 內容區跟手機版同一組面板。只在瀏覽器判斷（預渲染與 hydrate 第一次都是 false），所以桌面也走手機版那些載入邏輯；
 * 上次定位的還原（restoreLocation）仍只限手機寬度。
 */
const panelLayout = () => typeof window !== 'undefined'
const { elections, politicians, policies, locations, categories, getElectionBySegment, getPoliticianElectionData, loading, error, getElectoralDistrictByTownship, electoralDistrictAreas, ensureDistricts, ensureOfficialRegionalStats, loadPoliticiansByElection, loadedElections, ensurePolicies, politicianListIncomplete, availableElectionTypes, townshipDirectory, loadTownshipDirectory } = useSupabase()

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
/** 最近一次載完的「屆別｜縣市｜鄉鎮」：手機版分頁面板用它判斷目前畫面上的資料是不是這個地區的（不是就先保留舊地區的內容並淡化） */
const mobileLoadedKey = ref('')
// 政見矩陣只做最新一屆定期選舉（lib/md/scope.ts 的 latestLocalElection，跟預產的 .md 同一個判斷）
const hasMatrix = computed(() => !!election.value && latestLocalElection(elections.value)?.id === election.value.id)

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
    // 手機版全台、停在議員／鄉鎮市長／代表分頁：先讓那一分頁的第一批撈完（最多等 8 秒），再撈全台縣市長（60KB，這個分頁用不到），不跟第一屏搶頻寬
    if (region === 'All' && subRegion === 'All' && panelLayout() && NATIONWIDE_TYPES[mobileActiveType.value]) {
      await Promise.race([fillNationwide(mobileActiveType.value, BATCH), new Promise(r => setTimeout(r, 8000))])
    }
    await loadPoliticiansByElection(id, region, subRegion)
  } finally {
    if (seq === loadSeq) { electionLoading.value = false; mobileLoadedKey.value = `${id}|${region}|${subRegion}` }
  }
  // 名錄只有縣市頁要，而且跟卡片分開撈（它要列到村里長，卡片只到下一層）。
  // 不 await 在上面那個 try 裡：名錄慢或失敗都不該讓卡片等它或跟著掛掉。
  if (region !== 'All' && subRegion === 'All') {
    loadTownshipDirectory(id, region)
  }
}

onMounted(() => {
  // 首屏只要候選人清單（路由解析時已經先發了，這裡接手同一個 promise，見 router/index.ts）。
  // 次要資料等第一批卡片載完、畫上去之後才抓（2026-10-31，載入順序優化）：
  // 政見清單 257 KB 與選舉區對應 77 KB 以前在這裡一掛載就發，在行動網路上跟卡片搶頻寬。
  // 這幾份資料到之前，畫面用的是既有的空狀態／載入狀態（政見數 0、選區選單暫空、基本統計「未調查」），
  // 跟以前資料還沒回來時一樣。
  const firstCards = electionId.value
    ? loadElectionData(electionId.value, selectedRegion.value, selectedSubRegion.value)
    : Promise.resolve()
  void firstCards.catch(() => undefined).then(() => runAfterRender(() => {
    // 政見清單是按需載入的（257 KB，公民提問頁那類頁面不需要）。這一頁要整份。
    ensurePolicies()
    // 選舉區對應表 77 KB，只有這一頁篩議員選區要用，改成按需載入
    ensureDistricts()
    // 地方基本統計（RegionalStatsPanel 在這一頁不自己抓，由這裡統一排）
    ensureOfficialRegionalStats()
  }, nextTick))
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

const viewMode = ref<ElectionViewMode>('politicians')
/** 手機版（X 式版面）目前停在哪一種參選人類型（網址 ?tab=；空字串＝這一頁第一個有資料的類型） */
const mobileTab = ref('')
/** 承諾頁籤的頁碼（網址 ?page=，字串形式給 queryField；實際頁碼看 pledgePage） */
const pledgePageParam = ref('1')
const hasSidebar = computed(() => selectedRegion.value !== 'All' && availableSubRegions.value.length > 0)
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
/** 議員／代表的選區快篩（內容區晶片列）；放在這裡是因為要寫進網址（?area=，從矩陣回來時帶回選區），後面的說明見 toggleDistrict */
const selectedDistrict = ref<string>('All')
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
    // 手機版的類型分頁；換地區時帶過去，盡量停在原本的類型
    tab: queryField(mobileTab, ''),
    type: queryField(comparisonLevel, '', { allowed: Object.values(ElectionType), when: () => viewMode.value === 'comparison' }),
    // 順序要在 type 後面：套網址時一個欄位設完才設下一個
    district: queryField(comparisonDistrict, '', { when: () => viewMode.value === 'comparison' }),
    pick: queryField(comparisonPick, '', { when: () => viewMode.value === 'comparison' }),
    // 選區晶片（議員、代表）；換縣市／鄉鎮時 watch 會重設成 All
    area: queryField(selectedDistrict, 'All'),
    // 承諾頁籤的頁碼；第 1 頁不帶。放最後：縣市／鄉鎮／頁籤套完才套頁碼
    page: queryField(pledgePageParam, '1', { when: () => viewMode.value === 'pledges' }),
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
  for (const key of ['view', 'type', 'tab']) {
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

// 候選人排序（使用者 2026-09-20：多種排序讓人選）。
// 原本是資料庫撈出來的順序，等於先建檔的永遠排第一——清單第一格的曝光遠高於後面，系統不該替任何人站台。
// 2026-10-19 維護者：改成純圖示（components/SortIcons.vue），預設改成不看活動量的規則——有號次照號次、沒有就姓名筆畫；
// 「最近更新／政見數／關注度」留著讓讀者自己選（更正 09-20 預設「最近更新」與 10-18「有號次不給選」）
type SortMode = 'ballot' | 'updated' | 'stroke' | 'policies' | 'attention'
const sortChoice = ref<SortMode | null>(null)
const hasBallotNos = computed(() => electionPoliticians.value.some(c => !!getPoliticianElectionData(c, electionId.value)?.candNo))
const sortMode = computed<SortMode>({
  get: () => {
    const v = sortChoice.value
    if (v === 'ballot' && !hasBallotNos.value) return 'stroke'
    return v ?? (hasBallotNos.value ? 'ballot' : 'stroke')
  },
  set: (v) => { sortChoice.value = v },
})
const SORT_OPTIONS = computed<SortIconOption<SortMode>[]>(() => [
  { key: 'updated', label: '最近更新', icon: Clock },   // 名下政見或進度最近有變動的在前
  { key: 'stroke', label: '姓名筆畫', text: '姓' },     // 中選會抽籤前的慣例
  { key: 'policies', label: '政見數', icon: List },     // 登錄的政見多的在前
  { key: 'attention', label: '關注度', icon: Eye },     // 支持、反對、關注的總數
  ...(hasBallotNos.value ? [{ key: 'ballot' as const, label: '號次', text: 'No' }] : []),
])
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
  const byStroke = (a: Politician, b: Politician) => comparePerson(a, b)
  const byUpdated = (a: Politician, b: Politician) => st(b).updated.localeCompare(st(a).updated) || st(b).count - st(a).count || byStroke(a, b)
  const cmp: Record<SortMode, (a: Politician, b: Politician) => number> = {
    // 號次：先照姓名筆畫排，再由 listByCountyBallot 依縣市（站上固定順序）→選舉區→號次排、沒號次的在該選區最後（跨縣市不交錯）
    ballot: byStroke,
    // 2026-09-21 卡在李四川：last_updated 只到「日」，六個人同日並列，筆畫或筆數任一種並列規則都會讓同一個人永遠第一。
    // 2026-09-22 改用 updated_at（timestamptz，內容任何變動都會蓋，migration 000028），並列只剩極少數；退路仍是筆數→筆畫。
    updated: byUpdated,
    stroke: byStroke,
    policies: (a, b) => (st(b).count - st(a).count) || byStroke(a, b),
    attention: (a, b) => (st(b).attention - st(a).attention) || byStroke(a, b),
  }
  const sorted = [...list].sort(cmp[sortMode.value])
  return sortMode.value === 'ballot' ? listByCountyBallot(sorted, TAIWAN_COUNTIES) : sorted
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
        (!c.subRegion.includes('選區') || townshipOfSubRegion(c.subRegion) !== null)
    })
    // 代表記到「<鄉鎮>第NN選舉區」的（#464 起）收它的鄉鎮
    .forEach(c => subRegions.add(townshipOfSubRegion(c.subRegion) ?? c.subRegion!))

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
      // 其他（鄉鎮市長、代表、村里長）：等值，或代表記到「<鄉鎮>第NN選舉區」（#464 起）——跟預渲染、
      // get_politicians_by_level 同一條規則（lib/election-townships.ts 的 inTownship）
      return inTownship(c.subRegion, selectedSubRegion.value)
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
  return sortPoliticians(result)
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
  /** 卡片排法（grid）實際要畫的人：鄉鎮市民代表依右側選的選舉區篩過；其餘等於 people */
  shown: Politician[]
  empty: boolean
  /** 人多的「全部」名單：畫面分批載入 */
  batch?: boolean
  /** 整個職位區塊的頁內錨點 id（人物頁麵包屑的職位層連到這裡，見 lib/election-levels.ts 的 sectionAnchor） */
  anchor?: string
}

/** 分組加上錨點 id：id 一律從 sectionAnchor 來，麵包屑（lib/election-breadcrumbs.ts）連的是同一個函式的輸出 */
function withAnchors(spec: PositionSpec, groups: Array<{ label: string; people: Politician[] }>) {
  return groups.map(g => ({ ...g, anchor: sectionAnchor(spec.type, g.label) }))
}

/** 代表的分組標題：「民雄鄉 第01區」＝鄉鎮（鄉鎮內分組標題的前半）＋選區簡稱；選區欄沒有「第NN選舉區」就只寫鄉鎮 */
function repGroupLabel(c: Politician): string {
  const sub = c.subRegion ?? ''
  const m = sub.match(/^(.*?)(第\d+)選舉區$/)
  const town = (m ? m[1] : sub) || (c.subRegion ? townshipOfSubRegion(c.subRegion) ?? sub : '未標示')
  return m ? `${town} ${m[2]}區` : town
}

function buildSection(spec: PositionSpec): LevelSection {
  const people = peopleOf(spec.type)
  const anchor = sectionAnchor(spec.type)
  if (spec.display === 'district') {
    // 議員與原住民區代表共用同一個 selectedDistrict：議員只出現在縣市頁、區代表只出現在原住民區頁，
    // 不會同時在畫面上，而換縣市或換鄉鎮時 watch 會把它重設。
    const groups = withAnchors(spec, groupsByDistrict(people, spec.type))
    return { spec, people, shown: people, groups, chips: districtsOf(people, spec.type), empty: groups.length === 0, anchor }
  }
  if (spec.display === 'village') {
    // 順序照 availableVillages（已排好序），每組只留真的有候選人的村里；選了特定村里時名單已經先篩過，
    // 這裡自然只剩一組。村里是空值或對不上的人收進最後一組「未標示里別」（lib/village-grouping.ts）。
    const groups = withAnchors(spec, groupByVillage(people, availableVillages.value).map(g => ({ label: g.village, people: g.people })))
    return { spec, people, shown: people, groups, chips: [], empty: groups.length === 0, anchor }
  }
  if (spec.type === '鄉鎮市民代表') {
    // 鄉鎮市民代表是卡片排法，但同一個鄉鎮有好幾個選舉區（subRegion＝「湖口鄉第01選舉區」）：
    // 快篩清單照目前這一頁的代表蒐集，選了只畫那一區（selectedDistrict；鄉鎮頁沒有議員，不會互相打架）。
    const shown = selectedDistrict.value === 'All' ? people : people.filter(c => c.subRegion === selectedDistrict.value)
    // 依鄉鎮、組內再依選區分組（標題「民雄鄉 第01區 (n)」），跟議員依選區分組同一個分組元件；只有一組就照舊平面排
    const by = new Map<string, Politician[]>()
    for (const c of shown) { const k = repGroupLabel(c); const a = by.get(k); if (a) a.push(c); else by.set(k, [c]) }
    if (by.size > 1) {
      const groups = withAnchors(spec, [...by.entries()].sort((x, y) => sortByLengthThenStroke(x[0], y[0])).map(([label, ps]) => ({ label, people: ps })))
      return { spec: { ...spec, display: 'district' }, people, shown, groups, chips: districtsOf(people, spec.type), empty: people.length === 0, anchor }
    }
    return { spec, people, shown, groups: [], chips: districtsOf(people, spec.type), empty: people.length === 0, anchor }
  }
  if (spec.type === ElectionType.MAYOR && selectedRegion.value === 'All' && people.length > 0) {
    // 全台的縣市長一百位上下，攤平了找不到自己的縣市：依縣市分組（順序照縣市標準排序），用跟議員依選舉區分組同一個元件與樣式；
    // 選了某縣市時名單已先篩過，只剩一組（照舊畫平面清單，不分組）。沒填縣市的收進最後一組
    const by = new Map<string, Politician[]>()
    for (const p of people) { const k = p.region && TAIWAN_COUNTIES.includes(p.region as typeof TAIWAN_COUNTIES[number]) ? p.region : '其他'; (by.get(k) ?? by.set(k, []).get(k)!).push(p) }
    const order = [...TAIWAN_COUNTIES as readonly string[], '其他']
    const groups = withAnchors(spec, order.filter(k => by.has(k)).map(k => ({ label: k, people: by.get(k)! })))
    if (groups.length > 1) return { spec, people, shown: people, groups, chips: [], empty: false, anchor }
  }
  return { spec, people, shown: people, groups: [], chips: [], empty: people.length === 0, anchor }
}

function sectionsOf(types: readonly string[]): LevelSection[] {
  return types.map(positionSpec).filter((s): s is PositionSpec => !!s).map(buildSection)
}
const thisLevelSections = computed(() => sectionsOf(levelPlan.value.thisLevel))

/** PK 頁籤的連結（選好職位與這一場）；區塊標題列的「政見 PK」按鈕 2026-10-31 拿掉，上方檢視列已有 PK 入口 */
function pkLink(type: string, district?: string): RouteLocationRaw {
  return { path: electionPath(electionSeg.value, selectedRegion.value, selectedSubRegion.value), query: pkQuery(type, district) }
}
const nextLevelSections = computed(() => sectionsOf(levelPlan.value.nextLevel))
/**
 * 右側面板的「選舉區」選擇（2026-10-06 維護者：列表上方的選舉區／村里選擇改放右側，上方不重複）：
 * 縣市頁的縣市議員、原住民區頁的區代表（只在「候選人」頁籤，其他頁籤不用選舉區）；選區不到兩個就不需要選。選了只看那一區（selectedDistrict，議員與區代表共用）。
 */
const districtPanels = computed(() => viewMode.value !== 'politicians' ? [] : [...thisLevelSections.value, ...nextLevelSections.value]
  .filter(sec => (sec.spec.display === 'district' || sec.spec.type === '鄉鎮市民代表') && !sec.empty && sec.chips.length > 1)
  .map(sec => ({ type: sec.spec.type, title: displayLabel(sec.spec.label), chips: sec.chips })))
/** 選區晶片的短寫：「第01選舉區」「湖口鄉第01選舉區」都顯示成「第01區」（篩選仍用完整的 subRegion） */
function shortDistrict(d: string): string {
  return d.replace(/^.*?(第\d+)選舉區$/, '$1區')
}

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

/**
 * 手機版（X 式版面）承諾／串聯／PK 跟候選人檢視共用同一組層級分頁與地區：依目前分頁的職位篩（直轄市的鄉鎮市長／代表＝原住民區長／區代表）。
 * 桌機版不分層級，維持原樣——所以這個篩選只在瀏覽器判斷為手機寬度之後才套用（這三個檢視不進預渲染，不會有 hydration 差異）。
 */
const isMobileNow = ref(false)
const INDIGENOUS_ALIAS: Record<string, string> = {
  [ElectionType.TOWNSHIP_MAYOR]: ElectionType.INDIGENOUS_DISTRICT_CHIEF,
  [ElectionType.REPRESENTATIVE]: ElectionType.INDIGENOUS_DISTRICT_REP,
}
function matchesMobileTab(politician: Politician): boolean {
  if (!isMobileNow.value) return true
  const data = withCurrentElectionData(politician) as Politician
  const t = getElectionType(data)
  const a = mobileActiveType.value
  if (t !== a && t !== INDIGENOUS_ALIAS[a]) return false
  if (selectedVillage.value !== 'All' && a === ElectionType.CHIEF && !sameRegionName(data.village, selectedVillage.value)) return false
  if (selectedDistrict.value !== 'All' && (a === ElectionType.COUNCILOR || a === ElectionType.REPRESENTATIVE) && data.subRegion !== selectedDistrict.value) return false
  return true
}
// 桌面版也走層級分頁面板（見 panelLayout），掛載後一律套用
onMounted(() => { isMobileNow.value = true })

/** 人物 id → 人物；承諾迴圈裡查人用，免得每筆都掃一遍整份名單 */
const politicianById = computed(() => new Map(politicians.value.map(c => [c.id, c])))
const allCampaignPolicies = computed(() =>
  policies.value.filter(p => {
    if (p.status !== PolicyStatus.CAMPAIGN || !belongsToThisElection(p) || !electionPoliticianIds.value.has(p.politicianId)) return false
    const politician = politicianById.value.get(p.politicianId)
    if (!politician) return false
    if (selectedRegion.value !== 'All' && !sameRegionName(politician.region, selectedRegion.value)) return false
    // 鄉鎮市區篩選（議員透過對應表查詢選舉區）
    if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All') {
      if (getElectionType(politician) === ElectionType.COUNCILOR) {
        const electoralDistrict = getElectoralDistrictByTownship(selectedRegion.value, selectedSubRegion.value, electionYear.value)
        if (electoralDistrict && !sameDistrict(politician.subRegion, electoralDistrict)) return false
      } else {
        if (!inTownship(politician.subRegion, selectedSubRegion.value)) return false
      }
    }
    return matchesMobileTab(politician)
  })
)

// 政見頁籤的排序（2026-10-19 維護者）：預設照人的姓名筆畫、同一人新到舊；時鐘＝全部照提出日期新到舊。
// 之前沒有排，用的是資料庫 id（隨機 UUID）順序
type PledgeSort = 'stroke' | 'recent'
const pledgeSort = ref<PledgeSort>('stroke')
const PLEDGE_SORT_OPTIONS: SortIconOption<PledgeSort>[] = [
  { key: 'recent', label: '最近提出', icon: Clock },
  { key: 'stroke', label: '姓名筆畫', text: '姓' },
]
const sortedCampaignPolicies = computed(() => {
  const nameOf = new Map(politicians.value.map(c => [c.id, c.name]))
  const byName = (a: Policy, b: Policy) => comparePersonName(nameOf.get(a.politicianId) ?? '', nameOf.get(b.politicianId) ?? '')
  const cmp = pledgeSort.value === 'recent'
    ? (a: Policy, b: Policy) => compareByPolicyDateDesc(a, b) || byName(a, b)
    : (a: Policy, b: Policy) => byName(a, b) || String(a.politicianId).localeCompare(String(b.politicianId)) || compareByPolicyDateDesc(a, b)
  return [...allCampaignPolicies.value].sort(cmp)
})

// 承諾頁籤分頁：每頁 60 張。預渲染只畫第 1 頁；page>1 的 canonical 仍是不帶 query 的網址（canonicalPath 只取 route.path）
const PLEDGES_PAGE_SIZE = 60
const pledgeTotalPages = computed(() => totalPagesOf(sortedCampaignPolicies.value.length, PLEDGES_PAGE_SIZE))
const pledgePage = computed(() => clampPage(pledgePageParam.value, pledgeTotalPages.value))
const pagedCampaignPolicies = computed(() => slicePage(sortedCampaignPolicies.value, pledgePage.value, PLEDGES_PAGE_SIZE))
const pledgeListTop = ref<HTMLElement | null>(null)
function goPledgePage(p: number) {
  pledgePageParam.value = String(p)
  void nextTick(() => pledgeListTop.value?.scrollIntoView({ block: 'start' }))
}
// 換縣市／鄉鎮／村里／排序回第 1 頁
watch([selectedRegion, selectedSubRegion, selectedVillage, pledgeSort], () => { pledgePageParam.value = '1' })

// Issues mode
const regionPolicies = computed(() =>
  policies.value.filter(p => {
    if (p.status !== PolicyStatus.CAMPAIGN || !belongsToThisElection(p) || !electionPoliticianIds.value.has(p.politicianId)) return false
    const politician = politicianById.value.get(p.politicianId)
    if (!politician) return false
    if (selectedRegion.value !== 'All' && !sameRegionName(politician.region, selectedRegion.value)) return false
    // 鄉鎮市區篩選（議員透過對應表查詢選舉區）
    if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All') {
      if (getElectionType(politician) === ElectionType.COUNCILOR) {
        const electoralDistrict = getElectoralDistrictByTownship(selectedRegion.value, selectedSubRegion.value, electionYear.value)
        if (electoralDistrict && !sameDistrict(politician.subRegion, electoralDistrict)) return false
      } else {
        if (!inTownship(politician.subRegion, selectedSubRegion.value)) return false
      }
    }
    return matchesMobileTab(politician)
  })
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
  regionPolicies.value.forEach(p => {
    issueTagsOf(p, electionPoliticianNames.value).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1 })
  })
  return counts
})

const availableTags = computed(() =>
  Object.keys(tagCounts.value).filter(tag => tagCounts.value[tag] > 0).sort((a, b) => tagCounts.value[b] - tagCounts.value[a])
)

// 議題串聯的 .md 抽屜（components/MdDrawer.vue，跟政見矩陣同一份預產快取 data_md_cache，2026-10-19 維護者）：
// 只有最新一屆有預產；標籤剛好是分類名（九成以上的政見沒有自由標籤、退回分類）就開「縣市×分類」那份，其他開縣市全部分類
const issuesMdPick = computed<MdPick | null>(() => {
  const region = selectedRegion.value
  if (!hasMatrix.value || region === 'All') return null
  const seg = electionSeg.value
  const tag = selectedIssueTag.value
  if (tag && categories.value.includes(tag)) {
    return { id: `${region}|${tag}`, row: `/data/${seg}/${region}/${tag}.md`, path: dataRegionCategoryMdPath(seg, region, tag), title: `${region}　${tag}` }
  }
  return { id: `r:${region}`, row: `/election/${seg}/${region}.md`, path: dataRegionMdPath(seg, region), title: `${region}　全部分類` }
})
// 政見 PK 的 .md 抽屜：「PK 詳情」（不指定分類）由畫面上同一張比較表現場組成（lib/policy-pk-md.ts），範圍與標題的人數一致
// （2026-10-20 維護者回報：原本開預產的縣市全部分類 .md，標題寫第01選舉區 8 位，詳情卻列出全縣市的議員）；
// 點表格的分類名才開預產的 /data/<屆>/<縣市>/<分類>.md——預產只到「縣市×分類」，沒有選區版本，所以字樣寫明「全縣市」
function pkMdPick(category?: string): MdPick | null {
  const region = selectedRegion.value
  if (!category) {
    if (pkMatrix.value.columns.length < 2 || !election.value) return null
    const matrix = pkMatrix.value
    const level = pkTitle.value
    const regionName = region !== 'All' ? region : undefined
    const year = electionYear.value || election.value.electionDate.slice(0, 4)
    const electionName = election.value.name
    const htmlPath = electionPath(electionSeg.value, selectedRegion.value, selectedSubRegion.value)
    // text 用 getter：只在抽屜真的打開時才組，不在每次畫面更新時重組
    return {
      id: `pk:${electionSeg.value}|${region}|${pkLevel.value}|${pkGroup.value?.label ?? ''}|${pkPicked.value.join(',')}`,
      path: '',
      title: `${regionName ? `${regionName} ` : ''}${level} PK`,
      get text() { return renderPkMd({ title: level, region: regionName, year, electionName, matrix, htmlPath }, Date.now()) },
    }
  }
  if (!hasMatrix.value || region === 'All' || !categories.value.includes(category)) return null
  const seg = electionSeg.value
  return { id: `${region}|${category}`, row: `/data/${seg}/${region}/${category}.md`, path: dataRegionCategoryMdPath(seg, region, category), title: `${region}全縣市　${category}` }
}
/** PK 範圍比縣市窄（不是縣市長、或有選區）：點分類名開的 .md 是全縣市版本，提示一句 */
const pkMdNarrow = computed(() => pkLevel.value !== ElectionType.MAYOR || pkTitle.value !== levelLabel(pkLevel.value))
const issuesMdOpen = ref<MdPick | null>(null)
watch([viewMode, selectedRegion], () => { issuesMdOpen.value = null })

watch([() => selectedRegion.value, () => selectedSubRegion.value, availableTags], () => {
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
  // 有號次的場次照號次排、沒號次的人不列（lib/ballot-number.ts）；沒有號次的場次不變
  return listByBallotNo(currentElectionPoliticians.value.filter(c => {
    const type = getElectionType(c)
    if (!(type === level || (!type && level === ElectionType.MAYOR))) return false
    if (selectedRegion.value !== 'All' && !sameRegionName(c.region, selectedRegion.value)) return false
    // 鄉鎮市區篩選：議員透過對應表查選舉區；鄉鎮層級直接比；全縣層級不套用
    if (selectedSubRegion.value !== 'All' && selectedRegion.value !== 'All' && !COUNTY_WIDE_LEVELS.includes(level)) {
      if (type === ElectionType.COUNCILOR) {
        const electoralDistrict = getElectoralDistrictByTownship(selectedRegion.value, selectedSubRegion.value, electionYear.value)
        if (electoralDistrict && !sameDistrict(c.subRegion, electoralDistrict)) return false
      } else {
        if (!inTownship(c.subRegion, selectedSubRegion.value)) return false
      }
    }
    return true
  }))
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
/** PK 的選區跟內容區的選區晶片共用 selectedDistrict（網址 ?district= 是 PK 自己點的，優先；晶片一換就清掉它，見下面的 watch） */
const chipDistrictLabel = computed(() => selectedDistrict.value === 'All' ? '' : selectedDistrict.value.replace(/^.*?(第\d+選舉區)$/, '$1'))
// 村里、鄉鎮的定位一換也清掉 PK 自己的選場（?district=），一律以共用定位為準
watch([selectedDistrict, selectedVillage, selectedSubRegion], () => { comparisonDistrict.value = '' })
/**
 * PK 比較哪一場＝跟目前共用定位走（2026-10-31 正式站 bug：楠梓區村里長晶片選五常里，PK 卻是久昌里）：
 *   村里長＝選中的村里；鄉鎮市長＝選中的鄉鎮（組名就是鄉鎮）；議員／代表＝選中的選區晶片；縣市長＝縣市（頁面範圍已定）。
 * 沒選（全部）回空字串，沿用 pickGroup 的預設（第一個有政見的場），並由下面的 watch 把實際比較的那一項同步回晶片。
 */
const pkWantedLabel = computed(() => comparisonDistrict.value || pkLocationLabel(pkLevel.value, { village: selectedVillage.value, subRegion: selectedSubRegion.value, districtLabel: chipDistrictLabel.value }))
// 共用定位選了某一場（村里、鄉鎮、選區）就只比那一場：那一場不到兩位（沒有 PK）時畫「尚無資料」，不退去比別場（楠梓區五常里 → 久昌里 的 bug）；
// 網址 ?district= 帶了這一頁沒有的組名仍照舊退回預設（舊連結）
const pkGroup = computed(() => pkPickForLocation(pkGroupList.value, pkWantedLabel.value, !!comparisonDistrict.value, groupHasPolicies))
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
  { type: ElectionType.TOWNSHIP_MAYOR, label: '鄉鎮市區長' },
  { type: ElectionType.INDIGENOUS_DISTRICT_CHIEF, label: '原民區長' },
  { type: ElectionType.REPRESENTATIVE, label: '鄉鎮市區民代表' },
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
  // 手機版：職位跟著上方的層級分頁走（直轄市的鄉鎮市長／代表＝原住民區長／區代表）
  if (isMobileNow.value) {
    const a = mobileActiveType.value
    return (isSpecialMunicipality.value ? INDIGENOUS_ALIAS[a] ?? a : a) as ElectionType
  }
  const levels = visibleLevels.value
  const explicit = levels.find(l => l.type === comparisonLevel.value)
  if (explicit) return explicit.type
  const comparable = levels.map(l => ({ type: l.type, groups: pkNeeds(l.type, selectedRegion.value, selectedSubRegion.value) ? [] : pkGroups(poolForLevel(l.type), l.type).filter(hasPk) }))
  return (comparable.find(l => l.groups.some(groupHasPolicies)) ?? comparable.find(l => l.groups.length > 0))?.type
    ?? levels[0]?.type ?? ElectionType.MAYOR
})

/** 縣市頁的頁首：「2026 台北市 候選人與政見」；全台照舊 */
const pageCounty = computed(() => isCounty(selectedRegion.value) ? selectedRegion.value : undefined)
/**
 * 縣市頁這個縣市的候選人（人、職位在 POSITIONS 裡的順位、號次）：摘要的人數、縣市長姓名與結構化資料的候選人清單共用這一份，
 * 三處講的人數才會一致（#461）。職位不在 POSITIONS 裡的（總統副總統以外的全國性職位）不算進縣市頁。
 */
const countyRows = computed(() => {
  const county = pageCounty.value
  if (!county) return []
  return electionPoliticians.value.flatMap(person => {
    const data = getPoliticianElectionData(person, electionId.value)
    const rank = POSITIONS.findIndex(p => p.type === data?.electionType)
    return data && rank >= 0 && (data.region || person.region) === county ? [{ person, rank, candNo: data.candNo }] : []
  })
})
const countyLevelCounts = computed<LevelCount[]>(() => POSITIONS
  .map((p, rank) => ({ label: p.label, n: countyRows.value.filter(r => r.rank === rank).length })))
/** 縣市長候選人姓名（依號次、姓名排；摘要裡找「某某市長候選人」的人用） */
const countyHeadNames = computed(() => {
  const headRank = POSITIONS.findIndex(p => p.type === ElectionType.MAYOR)
  return candidateListItems(
    countyRows.value.filter(r => r.rank === headRank).map(r => ({ id: String(r.person.id), name: r.person.name, rank: r.rank, candNo: r.candNo })),
    { cap: 1000 },
  ).map(it => it.name)
})
/** 名下這一屆政見的筆數（只算傳進來的這些人；不管 policies 載完整了沒，同一批人同一屆的數字都一樣） */
function policyCountOf(people: ReadonlyArray<{ id: string | number }>): number {
  const ids = new Set(people.map(p => String(p.id)))
  return policies.value.filter(p => p.electionId === electionId.value && ids.has(String(p.politicianId))).length
}
/**
 * 鄉鎮頁的頁首（2026-10-05）：「2022 嘉義縣大林鎮 候選人與政見」。
 * 人數照這一頁實際畫出來的區塊數（這一層＋下一層），不另外算一份——描述寫的人數要跟畫面一樣。
 */
const pageTownship = computed(() => pageCounty.value && selectedSubRegion.value !== 'All' ? selectedSubRegion.value : undefined)
const townshipSections = computed(() => [...thisLevelSections.value, ...nextLevelSections.value].filter(s => s.people.length > 0))
const townshipLevelCounts = computed<LevelCount[]>(() => townshipSections.value.map(s => ({ label: displayLabel(s.spec.label), n: s.people.length })))
usePageHead({
  // 縣市頁有 Markdown 版（/election/<屆>/<縣市>.md，lib/md/region.ts）；全台頁與鄉鎮頁沒有
  markdown: () => !!election.value && !!pageCounty.value && !pageTownship.value,
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
    // 縣市頁、鄉鎮頁的摘要用資料組句：「2026 台中市候選人 128 位：縣市長 8 位、縣市議員 120 位，已收錄政見 35 項。」（lib/seo.ts，#461）
    const year = electionYear.value || election.value.electionDate.slice(0, 4)
    if (pageTownship.value) {
      return regionDescription({
        year,
        place: `${pageCounty.value}${pageTownship.value}`,
        levels: townshipLevelCounts.value,
        policyCount: policyCountOf(townshipSections.value.flatMap(s => s.people)),
        note: levelPlan.value.thisLevel.length === 0 ? '區長由市政府指派，不是選舉產生。' : undefined,
      })
    }
    if (pageCounty.value) {
      return regionDescription({
        year,
        place: pageCounty.value,
        levels: countyLevelCounts.value,
        policyCount: policyCountOf(countyRows.value.map(r => r.person)),
        heads: { label: '縣市長', names: countyHeadNames.value },
      })
    }
    return `${election.value.name}（投票日 ${election.value.electionDate}）候選人名單與競選承諾：總統、立委、縣市長到議員、鄉鎮市長、村里長，依縣市與鄉鎮篩選，比較政見。`
  },
  // 縣市頁的候選人清單（schema.org ItemList，#461）：職位、號次、姓名排序，最多 100 位，完整人數放 numberOfItems
  jsonLd: () => {
    if (!election.value || !pageCounty.value || pageTownship.value || countyRows.value.length === 0) return undefined
    const year = electionYear.value || election.value.electionDate.slice(0, 4)
    return itemListLd({
      name: `${year} ${pageCounty.value} 候選人`,
      url: `${SITE_URL}${canonicalPath(route.path)}`,
      items: candidateListItems(countyRows.value.map(r => ({ id: String(r.person.id), name: r.person.name, rank: r.rank, candNo: r.candNo }))),
      total: countyRows.value.length,
    })
  },
})

// ---- 手機版 X 式版面（md 以下）：定位（縣市／鄉鎮／村里）＋固定五個類型分頁＋內容區左右滑動 ----
// 共用一組定位（縣市、鄉鎮、村里），存在 globalRegion／網址（路徑＋?village=），並用 localStorage 記住上次。
// 五個分頁固定，各自需要不同深度的定位：縣市長／議員要縣市、鄉鎮市長／代表要鄉鎮、村里長要村里；
// 定位不夠就在分頁內容區列出下一層選項讓人挑，夠了直接顯示資料。
const { openDrawer } = useMobileShell()
const { setCrumbs } = useMobileHeader()

const MOBILE_TAB_TYPES: string[] = [ElectionType.MAYOR, ElectionType.COUNCILOR, ElectionType.TOWNSHIP_MAYOR, ElectionType.REPRESENTATIVE, ElectionType.CHIEF]
const TAB_NEEDS: Record<string, 'county' | 'sub' | 'village'> = {
  [ElectionType.MAYOR]: 'county', [ElectionType.COUNCILOR]: 'county',
  [ElectionType.TOWNSHIP_MAYOR]: 'sub', [ElectionType.REPRESENTATIVE]: 'sub', [ElectionType.CHIEF]: 'village',
}
/**
 * 分頁與區塊標題用的名稱。直轄市頁的「縣市長」「縣市議員」叫「直轄市長」「直轄市議員」。
 * 根因（2026-10-30）：以前判斷寫成 ElectionType.CHIEF（那是「村里長」），縣市長是 MAYOR，所以直轄市頁一直沒換成功；
 * 而且分頁條與區塊標題是兩個名稱來源（區塊標題直接用 POSITIONS 的 label），只改一邊不會生效——現在兩處都走這個函式。
 */
function mobileTypeLabel(type: string): string {
  if (selectedRegion.value !== 'All' && isSpecialMunicipality.value) {
    if (type === ElectionType.MAYOR) return '直轄市長'
    if (type === ElectionType.COUNCILOR) return '直轄市議員'
  }
  const l = positionSpec(type)?.label ?? type
  return displayLabel(l)
}
const mobileTabs = computed(() => MOBILE_TAB_TYPES.map(t => ({ key: t, label: mobileTypeLabel(t) })))
const mobileActiveType = computed(() => MOBILE_TAB_TYPES.includes(mobileTab.value) ? mobileTab.value : MOBILE_TAB_TYPES[0]!)
const mobileIndex = computed(() => Math.max(0, MOBILE_TAB_TYPES.indexOf(mobileActiveType.value)))
function setMobileTab(key: string) { mobileTab.value = key }

/** 直轄市的山地原住民區（鄉鎮市長／代表分頁在直轄市只列這些）：看有沒有原住民區長／區代表的候選人 */
const indigenousDistricts = computed(() => {
  if (!isSpecialMunicipality.value) return []
  const names = new Set<string>()
  for (const c of electionPoliticians.value.map(withCurrentElectionData)) {
    const type = getElectionType(c)
    if ((type === ElectionType.INDIGENOUS_DISTRICT_CHIEF || type === ElectionType.INDIGENOUS_DISTRICT_REP) && sameRegionName(c.region, selectedRegion.value) && c.subRegion) {
      names.add(townshipOfSubRegion(c.subRegion) ?? c.subRegion.replace(/第\d+選舉區$/, ''))
    }
  }
  return Array.from(names).sort(sortByLengthThenStroke)
})

/** 這個分頁的定位夠不夠：不夠就回「下一層要挑什麼」，夠了回 null */
interface MobilePick { level: 'county' | 'sub' | 'village'; title: string; options: string[] }
function pickFor(type: string): MobilePick | null {
  // 2026-10-31 小良哥：鄉鎮與村里的預設都是「全部」，各分頁一開就直接列出參選人；
  // 唯一例外是村里長分頁沒選鄉鎮：全台先挑縣市、選了縣市先挑鄉鎮（鄉鎮選了就是該鄉鎮全部村里，依村里分組）
  // 全台時：只有縣市長分頁直接列人（依縣市分組）；其餘四個分頁先挑縣市，不列全台灣的人
  if (selectedRegion.value === 'All' && type !== ElectionType.MAYOR) return { level: 'county', title: '選擇縣市', options: [...TAIWAN_COUNTIES] }
  if (type !== ElectionType.CHIEF) return null
  if (selectedSubRegion.value === 'All') {
    // 鄉鎮層一律列該縣市全部鄉鎮市區（不依有沒有該類選舉過濾）；沒有該類選舉的區，內容區顯示「無此類選舉」，定位照樣設定
    return { level: 'sub', title: `選擇${subRegionLabel.value}`, options: [...mobileSubOptions.value] }
  }
  return null
}
const mobilePick = computed(() => pickFor(mobileActiveType.value))
/**
 * 鄉鎮列、村里列最前面的「全部」（縣市列是「全台」、選區列是「全部」）：
 * allSub＝按了鄉鎮列的「全部」（清掉鄉鎮與村里定位，顯示該縣市全部鄉鎮的名單）；allVillage＝按了村里列的「全部」（顯示該鄉鎮全部村里）。
 * 換縣市、挑了具體的鄉鎮／村里就解除。
 */
// 2026-10-31：預設就是「全部」，不再需要旗標——沒挑鄉鎮＝全部鄉鎮、沒挑村里＝全部村里
const allSub = computed(() => selectedSubRegion.value === 'All')
/** 縣市層「全部」／其他檢視要把整個縣市的代表、村里長另外撈進來時，撈的過程中 */
const countyWideLoading = ref(false)
const allVillage = computed(() => selectedVillage.value === 'All')
function pickAll(level: 'sub' | 'village') {
  if (level === 'sub') {
    selectedVillage.value = 'All'
    if (selectedSubRegion.value !== 'All') void router.replace(regionLink(selectedRegion.value))
  } else {
    selectedVillage.value = 'All'
  }
}
/** 鄉鎮列「全部」的內容：該縣市全部鄉鎮的參選人，依鄉鎮（代表再依選區、村里長再依村里）分組；直轄市鄉鎮市長／代表＝山地原住民區長／區代表 */
function allSubSection(type: string): LevelSection | null {
  const realType = isSpecialMunicipality.value
    ? (type === ElectionType.TOWNSHIP_MAYOR ? ElectionType.INDIGENOUS_DISTRICT_CHIEF : type === ElectionType.REPRESENTATIVE ? ElectionType.INDIGENOUS_DISTRICT_REP : type)
    : type
  const base = positionSpec(realType) ?? positionSpec(type)
  if (!base) return null
  const people = peopleOf(realType)
  const townOf = (c: Politician) => (c.subRegion ? townshipOfSubRegion(c.subRegion) ?? c.subRegion.replace(/第\d+選舉區$/, '') : '未標示')
  const labelOf = (c: Politician) => {
    if (realType === ElectionType.CHIEF) return `${townOf(c)} ${c.village || '未標示里別'}`
    if (realType === ElectionType.REPRESENTATIVE || realType === ElectionType.INDIGENOUS_DISTRICT_REP) return repGroupLabel(c)
    return townOf(c)
  }
  const byLabel = new Map<string, Politician[]>()
  for (const c of people) { const k = labelOf(c); const arr = byLabel.get(k); if (arr) arr.push(c); else byLabel.set(k, [c]) }
  const spec: PositionSpec = { ...base, display: 'district' }
  const groups = withAnchors(spec, [...byLabel.entries()].sort((x, y) => sortByLengthThenStroke(x[0], y[0])).map(([label, ps]) => ({ label, people: ps })))
  return { spec, people, shown: people, groups, chips: [], empty: groups.length === 0, anchor: sectionAnchor(spec.type), batch: true }
}
/** 人多的「全部」名單分批畫（一次畫上千張卡片會卡住）：每批約 BATCH 位，捲到底再加一批 */
const BATCH = 90
const mobileShown = ref<Record<string, number>>({})
watch([selectedRegion, selectedSubRegion, selectedVillage, allSub, allVillage], () => { mobileShown.value = {} })
function batchedGroups(panel: MobilePanel) {
  const sec = panel.section!
  if (!sec.batch) return { groups: sec.groups, more: false, shown: 0, total: 0 }
  const limit = mobileShown.value[panel.type] ?? BATCH
  const out: typeof sec.groups = []
  let n = 0
  for (const g of sec.groups) {
    if (n >= limit) break
    out.push(g)
    n += g.people.length
  }
  const remote = nwRemaining(panel.type)
  return { groups: out, more: out.length < sec.groups.length || remote, shown: n, total: sec.people.length, remote }
}
function showMoreOf(type: string) {
  if (nwActive(type)) {
    if (nwLoading.value[nwKey(type)]) return // 還在撈上一批：不重複加碼
    const limit = (mobileShown.value[type] ?? BATCH) + BATCH
    mobileShown.value = { ...mobileShown.value, [type]: limit }
    void fillNationwide(type, limit)
    return
  }
  mobileShown.value = { ...mobileShown.value, [type]: (mobileShown.value[type] ?? BATCH) + BATCH }
}
// ---- 全台（沒挑縣市）的議員、鄉鎮市長、鄉鎮市民代表：伺服器端分頁 ----
// 全台議員約 2,400、代表約 3,400，不能一次撈。依縣市順序（TAIWAN_COUNTIES）一次撈三個縣市（各一個既有的 get_politicians_by_level 請求，
// 只帶該分頁的職位），累積到約一批（BATCH＝90 位）就停，使用者捲近底部才撈下一批。每個縣市整個撈完，才不會一組只出現一半的人。
// 2026-10-31 小良哥更正：全台時議員／鄉鎮市區長／代表／村里長分頁不列全台灣的人，改成先在內容區挑縣市（見 pickFor），
// 所以不再有「全台分批載入」。留空物件讓下面這一整套（nwActive、nationwideSection、fillNationwide）全部停用；縣市內的分批載入不受影響。
const NATIONWIDE_TYPES: Record<string, string[]> = {}
const nwKey = (type: string) => `${electionId.value}|${type}`
/** 這個分頁現在走全台分頁撈法（沒挑縣市、且是那三種分頁） */
const nwActive = (type: string) => selectedRegion.value === 'All' && !!NATIONWIDE_TYPES[type]
/** 已撈到第幾個縣市（TAIWAN_COUNTIES 的索引上界） */
const nwNext = ref<Record<string, number>>({})
const nwLoading = ref<Record<string, boolean>>({})
const nwWant = new Map<string, number>()
const nwInflight = new Map<string, Promise<void>>()
const nwRemaining = (type: string) => nwActive(type) && (nwNext.value[nwKey(type)] ?? 0) < TAIWAN_COUNTIES.length
/** 還沒開始撈、或正在撈第一批：內容區顯示「載入中」而不是「無此類選舉」 */
const nwPending = (type: string) => nwActive(type) && ((nwNext.value[nwKey(type)] ?? 0) === 0 || !!nwLoading.value[nwKey(type)])
function nwCount(type: string): number {
  const types = NATIONWIDE_TYPES[type]!
  let n = 0
  for (const c of politicians.value) {
    if (!c.electionIds?.includes(electionId.value)) continue
    const t = getElectionType(c)
    if (t && types.includes(t)) n++
  }
  return n
}
function fillNationwide(type: string, want: number): Promise<void> {
  const key = nwKey(type)
  if (!NATIONWIDE_TYPES[type] || !electionId.value) return Promise.resolve()
  nwWant.set(key, Math.max(want, nwWant.get(key) ?? 0))
  const running = nwInflight.get(key)
  if (running) return running
  const id = electionId.value
  const run = (async () => {
    nwLoading.value = { ...nwLoading.value, [key]: true }
    try {
      while ((nwNext.value[key] ?? 0) < TAIWAN_COUNTIES.length && nwCount(type) < (nwWant.get(key) ?? 0)) {
        const from = nwNext.value[key] ?? 0
        const counties = TAIWAN_COUNTIES.slice(from, from + 3)
        await Promise.allSettled(counties.map(c => loadPoliticiansByElection(id, c, 'All', NATIONWIDE_TYPES[type])))
        if (electionId.value !== id) return
        nwNext.value = { ...nwNext.value, [key]: from + counties.length }
      }
    } finally {
      nwLoading.value = { ...nwLoading.value, [key]: false }
      nwInflight.delete(key)
    }
  })()
  nwInflight.set(key, run)
  return run
}
watch(electionId, () => { nwNext.value = {}; nwLoading.value = {}; nwWant.clear(); nwInflight.clear() })
/** 全台分頁的內容：已撈到的縣市依 TAIWAN_COUNTIES 順序分組，每組標題帶人數 */
function nationwideSection(type: string): LevelSection | null {
  const base = positionSpec(type)
  if (!base) return null
  const types = NATIONWIDE_TYPES[type]!
  const people = filteredPoliticians.value.filter(c => { const t = getElectionType(c); return !!t && types.includes(t) })
  const by = new Map<string, Politician[]>()
  for (const c of people) {
    const county = TAIWAN_COUNTIES.find(x => sameRegionName(c.region, x)) ?? c.region ?? '未標示'
    const arr = by.get(county); if (arr) arr.push(c); else by.set(county, [c])
  }
  const order = (k: string) => { const i = (TAIWAN_COUNTIES as readonly string[]).indexOf(k); return i < 0 ? 999 : i }
  const spec: PositionSpec = { ...base, display: 'district' }
  const groups = withAnchors(spec, [...by.entries()].sort((x, y) => order(x[0]) - order(y[0])).map(([label, ps]) => ({ label, people: ps })))
  return { spec, people, shown: people, groups, chips: [], empty: groups.length === 0, anchor: sectionAnchor(spec.type), batch: true }
}
const vLoadMore = {
  mounted(el: HTMLElement & { _io?: IntersectionObserver }, b: { value: () => void }) {
    if (typeof IntersectionObserver === 'undefined') return
    // 觸發後暫時取消再重新觀察：按鈕加載後仍在可視範圍內時，才會接著載下一批
    const io = new IntersectionObserver(es => {
      if (!es.some(e => e.isIntersecting)) return
      b.value()
      io.unobserve(el)
      setTimeout(() => { if (el.isConnected) io.observe(el) }, 400)
    }, { rootMargin: '800px' })
    el._io = io
    io.observe(el)
  },
  unmounted(el: HTMLElement & { _io?: IntersectionObserver }) { el._io?.disconnect() },
}
/** 挑完選項：設定共用定位（縣市／鄉鎮走網址，村里走 ?village=） */
function pickLocation(level: 'county' | 'sub' | 'village', value: string) {
  if (level === 'county') void router.replace(regionLink(value))
  else if (level === 'sub') void router.replace(townshipLink(value))
  else selectedVillage.value = value
}

/** 手機版各分頁的內容（定位夠了才有）；人從已載入的資料取，鄉鎮與村里層級用現成的 levelPlan 區塊 */
function sectionFor(type: string): LevelSection | null {
  if (pickFor(type)) return null
  if (selectedRegion.value === 'All' && NATIONWIDE_TYPES[type]) return nationwideSection(type)
  if (selectedSubRegion.value === 'All' && TAB_NEEDS[type] !== 'county' && type !== ElectionType.COUNCILOR) return allSubSection(type)
  if (type === ElectionType.MAYOR) return buildSection(positionSpec(type)!)
  if (type === ElectionType.COUNCILOR) {
    // 整個縣市的議員（不照鄉鎮縮小），依選區分組
    const spec = positionSpec(type)!
    const people = sortPoliticians(electionPoliticians.value.map(withCurrentElectionData)
      .filter(c => getElectionType(c) === ElectionType.COUNCILOR && sameRegionName(c.region, selectedRegion.value)))
    const groups = withAnchors(spec, groupsByDistrict(people, spec.type))
    return { spec, people, shown: people, groups, chips: districtsOf(people, spec.type), empty: groups.length === 0, anchor: sectionAnchor(spec.type) }
  }
  if (type === ElectionType.CHIEF) return nextLevelSections.value.find(s => s.spec.type === ElectionType.CHIEF) ?? null
  const role = type === ElectionType.TOWNSHIP_MAYOR ? 'head' : 'council'
  return thisLevelSections.value.find(s => s.spec.level === 'township' && s.spec.role === role) ?? null
}
const mobileSection = computed(() => sectionFor(mobileActiveType.value))
const mobileSectionTitle = (s: LevelSection) => `${mobileTypeLabel(s.spec.type)}參選人`
/**
 * 標題區下方的晶片列＝該分頁的「同層切換列」（排序列之上），每個分頁只有一排：
 *   縣市長：全台＋各縣市｜議員：該縣市的選區｜鄉鎮市長：該縣市各鄉鎮｜代表：該鄉鎮的選區｜村里長：該鄉鎮各村里
 * 定位缺層時（內容區正在列完整選項），晶片列就顯示該缺的那一層。
 * 縣市／鄉鎮／村里清單來自地圖的點陣靜態檔（data/tw-raster，與 StatsMap 共用 fileCache）：
 *   national.json 只取縣市代碼（約 16KB，縣市名單本身用現成常數），towns/<縣市碼>.json（約 0.5–1KB）、villages/<鄉鎮碼>.json（約 1–3KB）。
 */
const rasterVillageFiles = import.meta.glob<{ default: RasterNames }>('../data/tw-raster/villages/*.json')
interface RasterNames { codes: string[]; names: string[] }
const normName = (n: string) => n.replace(/臺/g, '台')
/**
 * 縣市與鄉鎮清單直接來自精簡名稱索引（data/tw-raster-index.json，約 10KB，由 scripts/build-tw-raster-index.mjs 產生）：
 * 跟著頁面 JS 一起到，預渲染時就算得出來，晶片列不必等任何請求。只有村里清單（每個鄉鎮一個檔）仍是用到才載入。
 */
const rasterTowns = (rasterIndex as { towns: Record<string, RasterNames> }).towns
const rasterCountyCode = computed<string | null>(() => {
  const region = selectedRegion.value
  if (region === 'All') return null
  const ci = rasterIndex.counties.names.findIndex(n => normName(n) === normName(region))
  return ci < 0 ? null : rasterIndex.counties.codes[ci]!
})
const rasterTownList = computed<RasterNames | null>(() => rasterCountyCode.value ? rasterTowns[rasterCountyCode.value] ?? null : null)
/** 目前縣市的鄉鎮名單（索引裡沒有就 null，改用參選資料取得的清單） */
const rasterSubs = computed<string[] | null>(() => rasterTownList.value?.names ?? null)
const rasterTownCode = computed<string | null>(() => {
  const list = rasterTownList.value
  if (!list || selectedSubRegion.value === 'All') return null
  const ti = list.names.findIndex(n => normName(n) === normName(selectedSubRegion.value))
  return ti < 0 ? null : list.codes[ti]!
})
/** 目前鄉鎮的村里名單（來自點陣檔，用到才載入；讀不到就維持 null，改用參選資料取得的清單） */
const rasterVillages = ref<string[] | null>(null)
interface DistrictCache { election: number; council: Record<string, string[]>; rep: Record<string, string[]> }
const districtCache = shallowRef<DistrictCache | null>(districtCacheData as DistrictCache)
let rasterSeq = 0
watch(rasterTownCode, async (code) => {
  const seq = ++rasterSeq
  rasterVillages.value = null
  if (!code || !panelLayout()) return
  try {
    const load = rasterVillageFiles[`../data/tw-raster/villages/${code}.json`]
    const villages = load ? await fileCache.get(`villages/${code}`, () => load().then(m => m.default)) as RasterNames : null
    if (villages && seq === rasterSeq) rasterVillages.value = villages.names
  } catch { /* 讀不到就用參選資料的清單 */ }
}, { immediate: true })
/** 點陣檔的名稱對回網站資料用的寫法（臺／台），對不上就照原樣 */
function siteNames(raster: string[] | null, site: readonly string[]): readonly string[] {
  if (!raster) return site
  return raster.map(n => site.find(x => normName(x) === normName(n)) ?? n)
}
interface MobileChip { key: string; text: string; active: boolean; pick: () => void }
const chipOf = (value: string, text: string, active: boolean, pick: () => void): MobileChip => ({ key: value, text, active, pick })
const mobileSubOptions = computed(() => siteNames(rasterSubs.value, availableSubRegions.value))
const mobileChipRows = computed<MobileChip[][]>(() => {
  const pickRow = (level: 'county' | 'sub' | 'village', options: readonly string[], current: string): MobileChip[] =>
    options.map(o => chipOf(o, o, o === current, () => pickLocation(level, o)))
  const type = mobileActiveType.value
  const countyRow = (): MobileChip[] => [
    ...(type === ElectionType.MAYOR || selectedRegion.value === 'All' ? [chipOf('All', '全台', selectedRegion.value === 'All', () => { void router.replace(regionLink('All')) })] : []),
    ...pickRow('county', TAIWAN_COUNTIES, selectedRegion.value),
  ]
  const s = mobileSection.value
  // 選區：優先用選區快取（data/tw-districts，2026 登記名冊），沒有才用參選資料推；快取的標籤對回參選資料的寫法（臺／台）
  const districtRow = (): MobileChip[] => {
    const code = type === ElectionType.COUNCILOR ? rasterCountyCode.value : rasterTownCode.value
    const cached = electionId.value === 2026 && code ? (type === ElectionType.COUNCILOR ? districtCache.value?.council : districtCache.value?.rep)?.[code] : undefined
    const live = s && !s.empty ? s.chips : []
    const list = cached && cached.length > 0 ? cached.map(d => live.find(x => normName(x) === normName(d)) ?? d) : live
    if (list.length < 2) return []
    return [
      chipOf('All', '全部', selectedDistrict.value === 'All', () => { selectedDistrict.value = 'All' }),
      ...list.map(d => chipOf(d, shortDistrict(d), selectedDistrict.value === d, () => { selectedDistrict.value = d })),
    ]
  }
  // 全台的議員／鄉鎮市區長／代表／村里長分頁：內容區已經是縣市選擇區，不再重複一排縣市晶片
  if (selectedRegion.value === 'All' && type !== ElectionType.MAYOR) return []
  let row: MobileChip[]
  if (selectedRegion.value === 'All') row = countyRow()
  else if (type === ElectionType.MAYOR) row = countyRow()
  else if (type === ElectionType.COUNCILOR) row = districtRow()
  else if (selectedSubRegion.value === 'All' || type === ElectionType.TOWNSHIP_MAYOR) row = [chipOf('All', '全部', allSub.value && selectedSubRegion.value === 'All', () => pickAll('sub')), ...pickRow('sub', mobileSubOptions.value, selectedSubRegion.value)]
  else if (type === ElectionType.REPRESENTATIVE) row = districtRow()
  else row = [chipOf('All', '全部', allVillage.value && selectedVillage.value === 'All', () => pickAll('village')), ...pickRow('village', siteNames(rasterVillages.value, availableVillages.value), selectedVillage.value)]
  return row.length > 0 ? [row] : []
})
const mobileChipsEl = ref<HTMLElement | null>(null)
/**
 * PK 預設挑了某一場（定位選「全部」時）：把它同步回共用定位，晶片與麵包屑就會高亮實際比較的那一項（不得出現晶片寫全部、PK 卻是別場）。
 * 只在 PK 檢視、且 PK 層級就是目前的層級分頁時做；已經有定位（pkWantedLabel 非空）不動。
 */
watch([pkGroup, viewMode], ([g, vm]) => {
  if (vm !== 'comparison' || !g || pkWantedLabel.value || pkMissing.value) return
  const t = pkLevel.value
  if (t !== mobileActiveType.value) return
  if (t === ElectionType.CHIEF) { if (selectedVillage.value === 'All') selectedVillage.value = g.label }
  else if (t === ElectionType.TOWNSHIP_MAYOR) { if (selectedSubRegion.value === 'All') pickLocation('sub', g.label) }
  else if (t === ElectionType.COUNCILOR || t === ElectionType.REPRESENTATIVE) {
    const chip = (mobileChipRows.value[0] ?? []).find(c => c.key !== 'All' && c.key.endsWith(g.label))
    if (chip && selectedDistrict.value === 'All') selectedDistrict.value = chip.key
  }
})
/** 桌面版：縣市那一列（全台頁、縣市長分頁）延伸欄已經有，不重複；鄉鎮／選區／村里列在桌面也顯示 */
const deskChipsHidden = computed(() => selectedRegion.value === 'All' || mobileActiveType.value === ElectionType.MAYOR)
// 選中的晶片自動捲到橫向可見（只動橫向，不動頁面捲動）
watch(mobileChipRows, () => {
  void nextTick(() => {
    mobileChipsEl.value?.querySelectorAll<HTMLElement>('[data-active="true"]').forEach(el => {
      const box = el.parentElement
      if (box) box.scrollLeft = el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2
    })
  })
}, { immediate: true, flush: 'post' })
/** 沒有選項可挑、或定位夠了卻沒有這類選舉時的說明 */
function emptyTextFor(type: string): string {
  if (electionLoading.value || countyWideLoading.value || nwPending(type)) return '載入中…'
  return '尚無參選人'
}

/**
 * 五個分頁各自掛載並保留（2026-10-31 小良哥：左右切換時舊內容不要清掉，拖曳時相鄰頁也要看得到）：
 * - 看過的分頁（mobileVisited）都留在畫面上、用 v-show 切換；切回去不重畫、不重新載入，資料本來就在記憶體快取。
 *   還沒看過的分頁，要等動畫結束切過去時才第一次渲染；閒置時順便預先畫好左右相鄰兩頁（只畫記憶體裡的資料、不發請求），拖曳時才不會是空白。
 * - 換地區（縣市／鄉鎮）時，舊地區的內容留著並淡化，等新地區的資料載好才換掉；換掉後只保留新地區目前這一頁（舊地區的面板釋放，資料快取不動）。
 */
interface MobilePanel { type: string; pick: MobilePick | null; section: LevelSection | null; emptyText: string }
const mobilePanelOf = (type: string): MobilePanel => ({ type, pick: pickFor(type), section: sectionFor(type), emptyText: emptyTextFor(type) })
const mobileVisited = ref<string[]>([])
const mobileRenderTypes = computed(() => {
  const set = new Set([...mobileVisited.value, mobileActiveType.value])
  return MOBILE_TAB_TYPES.filter(t => set.has(t))
})
const mobileLive = computed(() => Object.fromEntries(mobileRenderTypes.value.map(t => [t, mobilePanelOf(t)])) as Record<string, MobilePanel>)
const mobilePanelKey = computed(() => `${electionId.value}|${selectedRegion.value}|${selectedSubRegion.value}`)
const mobileReady = computed(() => mobileLoadedKey.value === mobilePanelKey.value)
// 切到全台的議員／鄉鎮市長／代表分頁（任何檢視：候選人、承諾、PK、串聯），先撈第一批
watch([electionId, selectedRegion, mobileActiveType], () => {
  if (panelLayout() && electionId.value && nwActive(mobileActiveType.value)) void fillNationwide(mobileActiveType.value, BATCH)
}, { immediate: true })
const mobileLastGood = shallowRef<Record<string, MobilePanel> | null>(null)
watch([mobileLive, mobileReady], ([live, ready]) => { if (ready) mobileLastGood.value = live }, { immediate: true })
const mobileStale = computed(() => !mobileReady.value && mobileLastGood.value !== null)
const mobilePanels = computed<MobilePanel[]>(() => {
  const src = mobileStale.value ? mobileLastGood.value! : mobileLive.value
  return mobileRenderTypes.value.map(t => src[t] ?? { type: t, pick: null, section: null, emptyText: '載入中…' })
})
const mobileAdjacent = (type: string) => adjacentPanelClass(MOBILE_TAB_TYPES.indexOf(type) - mobileIndex.value)
let mobilePrerenderTimer: ReturnType<typeof setTimeout> | undefined
const mobilePrerenderIdle = (fn: () => void) => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  if (ric) ric(fn, { timeout: 3000 }); else setTimeout(fn, 0)
}
let mobileVisitedKey = ''
watch([mobileReady, mobileActiveType, mobilePanelKey], ([ready, type, key]) => {
  if (!ready) return
  if (key !== mobileVisitedKey) { mobileVisitedKey = key; mobileVisited.value = [type] }
  else if (!mobileVisited.value.includes(type)) mobileVisited.value = [...mobileVisited.value, type]
  clearTimeout(mobilePrerenderTimer)
  if (typeof window === 'undefined' || !panelLayout()) return
  // 閒置預畫相鄰分頁：等瀏覽器閒下來（requestIdleCallback，逾時 3 秒仍要畫）才掛，且一次只掛一個分頁，不跟首屏、捲動搶主執行緒
  const run = () => {
    if (mobilePanelKey.value !== key) return
    const i = MOBILE_TAB_TYPES.indexOf(mobileActiveType.value)
    const want = [MOBILE_TAB_TYPES[i - 1], MOBILE_TAB_TYPES[i + 1]].filter((t): t is string => !!t && !mobileVisited.value.includes(t))
    if (want.length === 0) return
    mobileVisited.value = [...mobileVisited.value, want[0]!]
    if (want.length > 1) mobilePrerenderTimer = setTimeout(() => { mobilePrerenderIdle(run) }, 600)
  }
  mobilePrerenderTimer = setTimeout(() => { mobilePrerenderIdle(run) }, 1200)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(mobilePrerenderTimer))

/**
 * 預抓相鄰分頁的資料（2026-10-31）：目前分頁的資料到了、瀏覽器閒下來（requestIdleCallback）之後，把左右相鄰分頁需要但還沒載入的職位撈進記憶體
 * （只抓資料、不渲染；同參數的請求有去重與 IndexedDB 快取），滑過去時已有資料。
 * 全台時只有縣市長分頁直接列人、本來就已載入，不預抓；網路省流量（saveData）或 2g／slow-2g 不預抓。
 */
let prefetchKey = ''
function prefetchAdjacent() {
  if (typeof window === 'undefined' || !panelLayout() || !electionId.value || !mobileReady.value) return
  if (selectedRegion.value === 'All' || selectedSubRegion.value !== 'All') return
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType ?? ''))) return
  const key = `${electionId.value}|${selectedRegion.value}|${mobileActiveType.value}`
  if (key === prefetchKey) return
  prefetchKey = key
  const i = MOBILE_TAB_TYPES.indexOf(mobileActiveType.value)
  for (const t of [MOBILE_TAB_TYPES[i - 1], MOBILE_TAB_TYPES[i + 1]]) {
    if (!t) continue
    const types = t === ElectionType.CHIEF ? [ElectionType.CHIEF] : t === ElectionType.REPRESENTATIVE ? [ElectionType.REPRESENTATIVE, ElectionType.INDIGENOUS_DISTRICT_REP] : null
    if (types) loadPoliticiansByElection(electionId.value, selectedRegion.value, 'All', types).catch(() => {})
  }
}
watch([mobileReady, mobileActiveType, selectedRegion, selectedSubRegion], () => { mobilePrerenderIdle(prefetchAdjacent) }, { immediate: true })

// 縣市層以下有定位時，縣市長與議員的資料也要在（分層載入只撈「這一層＋下一層」，直接開鄉鎮網址不會有縣市層）
function ensureCountyLevelLoaded() {
  if (!panelLayout() || !electionId.value || selectedRegion.value === 'All' || selectedSubRegion.value === 'All') return
  loadPoliticiansByElection(electionId.value, selectedRegion.value, 'All').catch(() => {})
}
watch([electionId, selectedRegion, selectedSubRegion], ensureCountyLevelLoaded)
/**
 * 縣市層沒挑鄉鎮、但分頁要看的是鄉鎮層以下的人（鄉鎮列／村里列按「全部」，或承諾／串聯／PK 檢視切到代表、村里長）：
 * 分層載入預設只帶到鄉鎮市長，代表與村里長要另外把整個縣市的撈進來（只撈那幾種職位，已撈過的有快取不重撈）。
 */
async function ensureCountyWideLoaded() {
  if (!panelLayout() || !electionId.value || selectedRegion.value === 'All' || selectedSubRegion.value !== 'All') return
  const type = mobileActiveType.value
  if (TAB_NEEDS[type] === 'county' || type === ElectionType.TOWNSHIP_MAYOR) return
  if (type === ElectionType.CHIEF && viewMode.value === 'politicians') return // 村里長分頁沒選鄉鎮時只列鄉鎮選擇區
  const types = type === ElectionType.CHIEF ? [ElectionType.CHIEF] : [ElectionType.REPRESENTATIVE, ElectionType.INDIGENOUS_DISTRICT_REP]
  countyWideLoading.value = true
  try { await loadPoliticiansByElection(electionId.value, selectedRegion.value, 'All', types) } catch { /* 載不到就維持現有名單 */ } finally { countyWideLoading.value = false }
}
watch([electionId, selectedRegion, selectedSubRegion, mobileActiveType, allSub, viewMode], ensureCountyWideLoaded)

// 頁首正中間的定位麵包屑：點任一段退到那一層（清掉更下層），分頁內容就改列該層的選項
/** 手機版分頁在縣市層（縣市長／議員）不顯示鄉鎮與村里、在鄉鎮層（鄉鎮市長／代表）不顯示村里：共用定位不清掉，換到更下層的分頁再顯示回來 */
const mobileShowSub = computed(() => TAB_NEEDS[mobileActiveType.value] !== 'county')
const mobileShowVillage = computed(() => TAB_NEEDS[mobileActiveType.value] === 'village')
const headerCrumbs = computed(() => {
  const list = [{ label: '全台', go: () => { void router.replace(regionLink('All')) } }]
  if (selectedRegion.value !== 'All') list.push({ label: selectedRegion.value, go: () => { selectedVillage.value = 'All'; void router.replace(regionLink(selectedRegion.value)) } })
  if (mobileShowSub.value && selectedRegion.value !== 'All' && selectedSubRegion.value !== 'All') list.push({ label: selectedSubRegion.value, go: () => { selectedVillage.value = 'All'; void router.replace(townshipLink(selectedSubRegion.value)) } })
  if (mobileShowSub.value && mobileShowVillage.value && selectedVillage.value !== 'All') list.push({ label: selectedVillage.value, go: () => { /* 最深一層，點了不動 */ } })
  return list
})
watch(headerCrumbs, v => setCrumbs(v), { immediate: true })
onActivated(() => setCrumbs(headerCrumbs.value))
onDeactivated(() => setCrumbs(null))
onBeforeUnmount(() => setCrumbs(null))

// localStorage 記住上次的定位（縣市、鄉鎮、村里）：網址是全台、沒有任何定位時，手機版啟動後套回上次的；讀寫都包 try/catch
const LOCATION_KEY = 'zj.location'
function saveLocation() {
  try { localStorage.setItem(LOCATION_KEY, JSON.stringify({ region: selectedRegion.value, sub: selectedSubRegion.value, village: selectedVillage.value, tab: mobileTab.value, area: selectedDistrict.value })) } catch { /* 無痕或封鎖時略過 */ }
}
function restoreLocation() {
  if (!isMobileViewport() || routeRegion.value || selectedRegion.value !== 'All') return
  try {
    const saved = JSON.parse(localStorage.getItem(LOCATION_KEY) || 'null') as { region?: string; sub?: string; village?: string } | null
    if (!saved?.region || !isCounty(saved.region)) return
    const sub = saved.sub && saved.sub !== 'All' ? saved.sub : undefined
    void router.replace({ path: electionPath(electionSeg.value, saved.region, sub), query: { ...tabQuery(), ...(saved.village && saved.village !== 'All' && sub ? { village: saved.village } : {}) } })
  } catch { /* 讀不到就維持全台 */ }
}
onMounted(() => { restoreLocation(); ensureCountyLevelLoaded() })
watch([selectedRegion, selectedSubRegion, selectedVillage, mobileTab, selectedDistrict], saveLocation)

// ---- 桌面版延伸欄的篩選模型（DeskExtNav 讀；點了就是呼叫上面手機版同一批函式，狀態與網址共用） ----
const { setElectionNav } = useDeskNav()
const deskNavModel = computed<DeskNavModel>(() => {
  const item = (key: string, label: string, active: boolean, select: () => void): DeskItem => ({ key, label, active, select })
  const needsSub = TAB_NEEDS[mobileActiveType.value] === 'county'
  // 在縣市層的分頁（縣市長／議員）點鄉鎮或村里＝想看更下層：順手換到對應的分頁
  const toLevel = (type: string) => { if (needsSub || (type === ElectionType.CHIEF && TAB_NEEDS[mobileActiveType.value] !== 'village')) setMobileTab(type) }
  const groups: DeskGroup[] = []
  const views = VIEW_TABS.map(v => item(v.key, v.short, viewMode.value === v.key, () => { viewMode.value = v.key }))
  const matrix: DeskItem[] = hasMatrix.value ? [{ key: 'matrix', label: '矩陣', active: false, to: `/election/${electionSeg.value}/matrix` }] : []
  groups.push({ key: 'views', title: '內容類型', blocks: [views.slice(0, 3), [...views.slice(3), ...matrix]] })
  groups.push({ key: 'levels', title: '層級', blocks: [mobileTabs.value.map(t => item(t.key, t.label, t.key === mobileActiveType.value, () => setMobileTab(t.key)))] })
  groups.push({ key: 'county', title: '縣市', blocks: [[
    item('All', '全台', selectedRegion.value === 'All', () => pickLocation('county', 'All')),
    ...TAIWAN_COUNTIES.map(c => item(c, c, selectedRegion.value === c, () => pickLocation('county', c))),
  ]] })
  // 鄉鎮／村里／選區的選擇不在延伸欄：桌面與手機一樣放在內容區最上面的晶片列（2026-10-31）
  return { title: `${electionYear.value || ''} 選舉`.trim(), groups }
})
onMounted(() => setElectionNav(deskNavModel))
onActivated(() => setElectionNav(deskNavModel))
onDeactivated(() => setElectionNav(null))
onBeforeUnmount(() => setElectionNav(null))

// 右欄（AdRail）上方的統計卡落點：≥1200px 且右欄已渲染才有
const railTarget = ref<HTMLElement | null>(null)
function syncRailTarget() {
  railTarget.value = typeof window !== 'undefined' && window.matchMedia('(min-width: 1200px)').matches ? document.getElementById('desk-rail-top') : null
}
let railTimer = 0
function syncRailSoon() { void nextTick(syncRailTarget); window.clearTimeout(railTimer); railTimer = window.setTimeout(syncRailTarget, 400) }
onMounted(() => { syncRailSoon(); window.addEventListener('resize', syncRailSoon) })
onActivated(syncRailSoon)
onBeforeUnmount(() => { window.removeEventListener('resize', syncRailSoon); window.clearTimeout(railTimer) })
watch(() => route.path, syncRailSoon)

const swipeEl = ref<HTMLElement | null>(null)
useSwipeTabs(swipeEl, {
  index: () => mobileIndex.value,
  count: () => mobileTabs.value.length,
  go: (i) => { const t = mobileTabs.value[i]; if (t) setMobileTab(t.key) },
  onPastStart: openDrawer,
})
</script>

<template>
  <div v-if="election" class="bg-slate-50 min-h-screen">

    <!-- 手機版版面順序：頁首 → 類型分頁條（吸頂，緊接頁首）→ 縮小的標題區（含檢視膠囊）→ 內容 -->
    <div class="md:hidden sticky top-14 z-30 shadow-sm" data-chrome-follow data-testid="mobile-sticky">
      <SwipeTabStrip :tabs="mobileTabs" :model-value="mobileActiveType" @update:model-value="setMobileTab" />
    </div>

    <ElectionHero
      :election="election" :election-seg="electionSeg" :view="viewMode" :has-matrix="hasMatrix"
      :region="selectedRegion" :region-link="regionLink" :county="pageCounty" :township="pageTownship" :mobile-township="mobileShowSub ? pageTownship : undefined"
      @select="viewMode = $event"
    >
      <!-- 桌面排序工具列：放在標題列右側（手機維持在內容區原位置，上面各檢視的排序列在桌面隱藏） -->
      <template #desk-actions>
        <SortIcons v-if="viewMode === 'politicians'" v-model="sortMode" :options="SORT_OPTIONS" />
        <SortIcons v-else-if="viewMode === 'pledges'" v-model="pledgeSort" :options="PLEDGE_SORT_OPTIONS" />
      </template>
    </ElectionHero>


    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 md:py-6">

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
      <div ref="swipeEl" data-testid="swipe-area" :class="['group/sw max-md:min-h-[calc(100dvh-10rem-env(safe-area-inset-bottom))]', 'w-full min-w-0']">

      <!-- 手機版：晶片列放在內容最上面，四個檢視（候選人／承諾／PK／串聯）共用同一組定位與分頁（標題區 → 晶片 → 排序 → 內容） -->
      <div v-if="mobileChipRows.length > 0" ref="mobileChipsEl" :class="deskChipsHidden ? 'md:hidden' : ''" data-testid="mobile-district-chips">
        <!-- 桌面有滑鼠時兩端出現箭頭與漸層（ScrollRow）；所有 class／data 屬性都落在真正捲動的那一層 -->
        <ScrollRow
          v-for="(row, ri) in mobileChipRows"
          :key="ri"
          class="-mx-1 mb-2 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden relative"
          data-no-swipe
          data-testid="mobile-chip-row"
        >
          <button
            v-for="c in row"
            :key="c.key"
            type="button"
            class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold"
            :class="c.active ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600'"
            :data-active="c.active ? 'true' : 'false'"
            @click="c.pick()"
          >{{ c.text }}</button>
        </ScrollRow>
      </div>

      <!-- VIEW: Politicians -->

      <div v-if="viewMode === 'politicians'" class="animate-fade-in">
        <!-- 排序（純圖示）：預設有號次照號次、沒有就姓名筆畫；不讓活動量決定誰排第一 -->
        <div class="flex justify-end mb-2 md:hidden">
          <SortIcons v-model="sortMode" :options="SORT_OPTIONS" />
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
        <div class="hidden">
        <div v-for="section in thisLevelSections" :key="section.spec.type">
          <PoliticianGrid v-if="section.spec.display === 'grid' && section.groups.length === 0 && !section.empty" :id="section.anchor" :politicians="section.shown" :columns="gridColumns" :election-id="electionId" :title="`${displayLabel(section.spec.label)}參選人`"><template #icon><component :is="LEVEL_ICONS[section.spec.icon]" :class="section.spec.iconClass" /></template></PoliticianGrid>
          <ChipFilteredGroups
            v-else-if="(section.spec.display !== 'grid' || section.groups.length > 0) && !section.empty"
            :id="section.anchor"
            :groups="section.groups"
            :columns="gridColumns"
            :election-id="electionId"
            :title-prefix="section.spec.display === 'district' ? section.spec.label : undefined"
          ><template #icon><component :is="LEVEL_ICONS[section.spec.icon]" :class="section.spec.iconClass" /></template></ChipFilteredGroups>
        </div>

        <!-- 直轄市一般區：區長市府指派，這一層沒有職位，一行小字說明，不擋里長名單 -->
        <p v-if="levelPlan.scope === 'township' && isSpecialMunicipality && levelPlan.thisLevel.length === 0" class="text-xs text-slate-400 mb-4">{{ selectedSubRegion }}的區長由市政府指派，不是選舉產生。</p>

        <div v-for="section in nextLevelSections" :key="section.spec.type">
          <PoliticianGrid v-if="section.spec.display === 'grid' && section.groups.length === 0 && !section.empty" :id="section.anchor" :politicians="section.shown" :columns="gridColumns" :election-id="electionId" :title="`${displayLabel(section.spec.label)}參選人`"><template #icon><component :is="LEVEL_ICONS[section.spec.icon]" :class="section.spec.iconClass" /></template></PoliticianGrid>
          <ChipFilteredGroups
            v-else-if="(section.spec.display !== 'grid' || section.groups.length > 0) && !section.empty"
            :id="section.anchor"
            :groups="section.groups"
            :columns="gridColumns"
            :election-id="electionId"
            :title-prefix="section.spec.display === 'district' ? section.spec.label : undefined"
          ><template #icon><component :is="LEVEL_ICONS[section.spec.icon]" :class="section.spec.iconClass" /></template></ChipFilteredGroups>
        </div>

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
        </div><!-- 桌機區塊結束 -->

        <!-- 手機版（X 式）：固定五個類型分頁。定位夠了顯示資料；不夠就在這裡列出下一層的選項（點了設定共用定位） -->
        <div class="relative transition-opacity duration-200" :class="mobileStale ? 'opacity-50' : ''" data-testid="mobile-panel">
          <div v-for="panel in mobilePanels" :key="panel.type" v-show="panel.type === mobileActiveType" :class="mobileAdjacent(panel.type)" :data-testid="`mobile-panel-${panel.type}`">
            <template v-if="panel.pick">
              <h3 class="mb-3 text-base font-bold text-navy-900" data-testid="mobile-pick-title">{{ panel.pick.title }}<span class="ml-2 text-xs font-normal text-slate-400"><span class="md:hidden">從上方選一個，或在下面挑</span><span class="max-md:hidden">從左側選一個，或在下面挑</span></span></h3>
              <div v-if="panel.pick.options.length > 0" class="flex flex-wrap gap-2" data-testid="mobile-pick-options">
                <button
                  v-for="o in panel.pick.options"
                  :key="o"
                  type="button"
                  class="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 active:bg-blue-50"
                  @click="pickLocation(panel.pick.level, o)"
                >{{ o }}</button>
              </div>
              <p v-else class="py-10 text-center text-sm text-slate-500" data-testid="mobile-pick-empty">{{ panel.emptyText }}</p>
            </template>
            <template v-else-if="panel.section && !panel.section.empty">
              <PoliticianGrid v-if="panel.section.spec.display === 'grid' && panel.section.groups.length === 0" :id="panel.section.anchor" :politicians="panel.section.shown" :columns="3" :election-id="electionId" :title="mobileSectionTitle(panel.section)"><template #icon><component :is="LEVEL_ICONS[panel.section.spec.icon]" :class="panel.section.spec.iconClass" /></template></PoliticianGrid>
              <ChipFilteredGroups
                v-else
                :id="panel.section.anchor"
                :groups="batchedGroups(panel).groups"
                :columns="3"
                :election-id="electionId"
                :title-prefix="panel.section.spec.display === 'district' ? mobileTypeLabel(panel.section.spec.type) : undefined"
              ><template #icon><component :is="LEVEL_ICONS[panel.section.spec.icon]" :class="panel.section.spec.iconClass" /></template></ChipFilteredGroups>
            </template>
            <p v-else class="py-10 text-center text-sm text-slate-500" data-testid="mobile-empty">{{ panel.emptyText }}</p>
            <button
              v-if="panel.section && !panel.pick && panel.type === mobileActiveType && batchedGroups(panel).more"
              v-load-more="() => showMoreOf(panel.type)"
              type="button"
              class="mx-auto my-4 block rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600"
              data-testid="mobile-load-more"
              @click="showMoreOf(panel.type)"
            >{{ batchedGroups(panel).remote ? `載入更多（已顯示 ${batchedGroups(panel).shown} 位）` : `載入更多（已顯示 ${batchedGroups(panel).shown} / ${batchedGroups(panel).total} 位）` }}</button>
          </div>
        </div>
      </div>

      <!-- VIEW: Pledges -->
      <div v-if="viewMode === 'pledges'" ref="pledgeListTop" class="flex justify-end mb-4 scroll-mt-24 md:invisible md:mb-0 md:h-0">
        <SortIcons v-model="pledgeSort" :options="PLEDGE_SORT_OPTIONS" />
      </div>
      <div v-if="viewMode === 'pledges'" class="animate-fade-in grid grid-cols-1 md:[grid-template-columns:repeat(auto-fill,minmax(20rem,1fr))] gap-6">
        <PolicyCard
          v-for="policy in pagedCampaignPolicies"
          :key="policy.id"
          :policy="policy"
          :politician="politicianById.get(policy.politicianId)!"
        />
      </div>
      <p v-if="viewMode === 'pledges' && pagedCampaignPolicies.length === 0 && !loading" class="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center text-sm font-bold text-slate-400" data-testid="pledges-empty">尚無承諾</p>
      <Pagination v-if="viewMode === 'pledges'" :page="pledgePage" :total-pages="pledgeTotalPages" @update:page="goPledgePage" />

      <!-- VIEW: Issues -->
      <div v-if="viewMode === 'issues'" class="space-y-8 animate-fade-in">
        <div v-if="selectedRegion === 'All'" class="text-center py-20 bg-white border border-dashed border-slate-300 rounded-xl">
          <Layers :size="48" class="mx-auto mb-4 text-slate-300" />
          <h3 class="text-lg font-bold text-navy-900 mb-2">請選擇特定縣市</h3>
          <p class="text-slate-500 max-w-md mx-auto">「議題串聯」功能需要針對特定行政區進行垂直分析。</p>
        </div>
        <template v-else>
          <div v-if="availableTags.length > 0" class="space-y-6">
            <!-- 議題分類篩選拿掉了（2026-10-19 維護者）：九成以上的政見沒有自由標籤、標籤就是退回的分類，兩排是同一份東西；標籤照筆數排、換行排滿 -->
            <div class="flex flex-wrap items-center gap-2 mb-2">
              <button
                v-for="tag in availableTags"
                :key="tag"
                @click="selectedIssueTag = tag"
                :class="`px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all border flex items-center gap-1 ${selectedIssueTag === tag ? 'bg-blue-600 text-white border-blue-600 shadow-md' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`"
              >
                <Hash :size="12" /> {{ tag }}
              </button>
            </div>
            <div v-if="issuesMdPick" class="flex justify-end -mt-4">
              <a :href="issuesMdPick.path" class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" data-testid="issues-md" @click.prevent="issuesMdOpen = issuesMdPick"><FileText :size="16" />{{ issuesMdPick.title }}</a>
            </div>
            <VerticalStack v-if="selectedIssueTag" :tag="selectedIssueTag" :policies="regionPolicies" :election-politicians="electionPoliticians.map(withCurrentElectionData)" :junk-names="electionPoliticianNames" />
          </div>
          <div v-else class="text-center py-20 text-slate-400 bg-white border border-dashed border-slate-200 rounded-xl">
            <AlertCircle :size="48" class="mx-auto mb-4 opacity-50" />
            <p class="font-bold">尚無資料</p>
          </div>
        </template>
      </div>

      <!-- VIEW: Comparison（政見 PK，2026-10-06 改成多人）：刻意用 v-if、只在瀏覽器端畫——PK 不是正文，不進預渲染 HTML（維護者 10-06）。
           預渲染時 viewMode 一律是「候選人」（網址參數在掛載後才套用），帶 ?view=comparison 的網址 canonical 指回選舉頁本身 -->
      <div v-if="viewMode === 'comparison'" class="animate-fade-in space-y-6">
        <!-- 職位：真連結，換職位時選區與勾選重設 -->
        <div class="flex justify-start overflow-x-auto pb-2 hidden">
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
          <p v-if="pkMissing === 'county'" class="font-bold text-slate-700">先選擇縣市</p>
          <p v-else class="font-bold text-slate-700">先在左側選擇鄉鎮市區</p>
          <p class="text-sm mt-1">{{ levelLabel(pkLevel) }}的政見 PK 是一個{{ pkMissing === 'county' ? '縣市' : '鄉鎮市區' }}一場，選好之後就會並排這一場的參選人。</p>
        </div>
        <PolicyPk
          v-else
          :title="pkTitle"
          :candidates="pkCandidates"
          :picked="pkPicked"
          :matrix="pkMatrix"
          :year="electionYear || ''"
          :region-label="selectedRegion !== 'All' ? selectedRegion : ''"
          :md-pick-for="pkMdPick"
          :md-narrow="pkMdNarrow"
          @toggle="togglePk"
          @all="comparisonPick = ''"
        />
      </div>

        <!-- 地方基本統計：沒有右側面板時放在內容最下面（有面板時在面板最下方，2026-10-16 維護者） -->
        <MdDrawer :pick="issuesMdOpen" @close="issuesMdOpen = null" />
        <!-- 桌面版右側面板拿掉後，地方基本統計一律放在內容最下面（統計數字在瀏覽器端才載入，用 ClientOnly 避免預渲染與 hydrate 不一致） -->
        <!-- 桌面（≥1200px）：搬到右欄、廣告位上方（Teleport 到 AdRail 的 #desk-rail-top）；右欄收起時回到內容最下面 -->
        <ClientOnly><template v-if="pageCounty"><Teleport v-if="railTarget" :to="railTarget"><RegionalStatsPanel :region="pageCounty" :sub-region="pageTownship" compact defer-load /></Teleport><RegionalStatsPanel v-else :region="pageCounty" :sub-region="pageTownship" compact defer-load class="mt-8 md:max-w-sm" /></template></ClientOnly>
      </div><!-- 左側內容結束 -->

      <!-- 右側：篩選區（手機版顯示在上方） -->
      <div v-if="selectedRegion !== 'All' && availableSubRegions.length > 0" class="hidden">
        <div class="md:sticky md:top-[4.5rem] space-y-4">
          <!-- 地區卡：鄉鎮市區 → 村里（連動） -->
          <div class="bg-white rounded-xl border border-slate-200 p-2.5 md:p-4 shadow-sm">
            <div class="flex items-center gap-2 mb-1.5 md:mb-3">
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
            <!-- 村里 -->
            <template v-if="availableVillages.length > 0 && viewMode !== 'comparison'">
              <div class="flex items-center gap-2 mt-4 mb-3">
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
            </template>
          </div>

          <!-- 選區卡（議員、鄉鎮市民代表、原住民區代表各一列；只篩自己那一種卡，不連動鄉鎮／村里；再點一次取消） -->
          <div v-if="districtPanels.length > 0" class="bg-white rounded-xl border border-blue-200 p-2.5 md:p-4 shadow-sm" data-testid="district-panel">
            <template v-for="(panel, i) in districtPanels" :key="panel.type">
              <div :class="`flex items-center gap-2 mb-3 ${i > 0 ? 'mt-4' : ''}`">
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
                >{{ shortDistrict(district) }}</button>
              </div>
            </template>
          </div>

          <!-- 政見 PK 的選區（跟其他頁籤的選舉區、村里同一個位置；真連結，網址 district 參數照舊） -->
          <div v-if="pkDistrictPanel" class="bg-white rounded-xl border border-blue-200 p-2.5 md:p-4 shadow-sm" data-testid="pk-district-panel">
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
