<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Heart, X, CircleUserRound, Loader2, Menu, ChevronRight, Search } from 'lucide-vue-next'
import { useAuth } from '../composables/useAuth'
import GlobalSearch from './GlobalSearch.vue'
import AppearanceMenu from './AppearanceMenu.vue'
import { useDeskNav } from '../composables/useDeskNav'
import { useSupabase } from '../composables/useSupabase'
import { sectionOfRoute } from '../lib/desk-sections'
import MobileDrawer from './MobileDrawer.vue'
import { useMobileShell } from '../composables/useMobileShell'
import { useMobileHeader } from '../composables/useMobileHeader'
import { searchPageTerm } from '../composables/useGlobalSearch'

const isLoginModalOpen = ref(false)
const { openDrawer } = useMobileShell()
const isLoggingIn = ref(false)
const route = useRoute()
const router = useRouter()
const { isAuthenticated, userDisplayName, userAvatarUrl, signInWithGoogle, loading: authLoading } = useAuth()

const handleGoogleLogin = async () => {
  isLoggingIn.value = true
  try {
    await signInWithGoogle()
  } catch (error) {
    console.error('Login failed:', error)
  } finally {
    isLoggingIn.value = false
  }
}


// ---- 手機版頁首正中間（X 式，每頁不同）：首頁＝站徽；選舉頁＝定位麵包屑；候選人頁＝姓名；其他頁＝頁面名稱 ----
const { crumbs, person, pageCrumbs } = useMobileHeader()
const PAGE_TITLES: Record<string, string> = {
  tracking: '政見追蹤', policy: '政見', analysis: '跨任期接力', 'analysis-detail': '跨任期接力', lineage: '政見脈絡',
  elections: '選舉', election: '選舉', 'election-region': '選舉', 'election-township': '選舉', 'election-matrix': '政見矩陣',
  politicians: '政治人物', 'politicians-group': '政治人物', parties: '政黨', party: '政黨', community: '公民提問', discussion: '公民提問',
  donation: '贊助', vision: '願景', privacy: '隱私權政策', terms: '服務條款', contact: '聯絡我們', 'regional-data': '地方資料',
  skill: 'Skill', sources: '資料來源', stats: '參與貢獻', search: '搜尋', 'stats-map': '參與貢獻', contributions: 'AI 協作動態牆', profile: '帳號',
}
const isHome = computed(() => route.name === 'home' || route.path === '/')
const isElectionRoute = computed(() => ['election', 'election-region', 'election-township'].includes(String(route.name)))
const pageTitle = computed(() => (route.name === 'tracking' && route.query.view === 'mine' ? '我的關注' : PAGE_TITLES[String(route.name)] ?? '正見'))
// 麵包屑、姓名、返回鈕都來自模組級狀態或 history.state：預渲染時是別頁殘留的（或空的）、瀏覽器第一次渲染時又不同，
// 直接渲染會造成 hydration 不一致（全台頁的警告）。掛載完才採用，之前兩邊都畫頁面名稱。
const mounted = ref(false)
onMounted(() => { mounted.value = true })
const personOnRoute = computed(() => mounted.value && route.name === 'politician' ? person.value : null)
/** 麵包屑太長（超過 14 字）就只留最後兩段 */
const shownCrumbs = computed(() => {
  const list = mounted.value && isElectionRoute.value ? crumbs.value : null
  if (!list || list.length === 0) return null
  const total = list.reduce((n, c) => n + c.label.length, 0)
  return total > 14 && list.length > 2 ? list.slice(-2) : list
})
// 搜尋頁：頁首正中是搜尋框，進頁面自動聚焦
const isSearchRoute = computed(() => route.name === 'search')
const searchInput = ref<HTMLInputElement | null>(null)
watch(isSearchRoute, async (on) => {
  if (!on) return
  await nextTick()
  searchInput.value?.focus()
}, { immediate: true, flush: 'post' })

// ---- 桌面版細頁首的麵包屑：首頁 › 區塊 › 頁面（選舉頁接定位麵包屑、候選人頁接姓名） ----
const { openDeskDrawer } = useDeskNav()
const SECTION_ROOT: Record<string, { label: string; to: string }> = {
  policy: { label: '政見', to: '/tracking' }, election: { label: '選舉', to: '/elections' }, join: { label: '參與', to: '/stats' },
  search: { label: '搜尋', to: '/search' }, about: { label: '關於', to: '/vision' },
}
const deskSection = computed(() => sectionOfRoute(route.name))
// 選舉頁的細頁首第二段寫具體選舉名稱（「2026 九合一選舉」），連回該場選舉的全台頁 /election/2026（不是選舉一覽）
const { getElectionBySegment } = useSupabase()
const electionSegParam = computed(() => { const p = route.params.electionId; return Array.isArray(p) ? p[0] : p })
const electionOnRoute = computed(() => (electionSegParam.value ? getElectionBySegment(electionSegParam.value) : undefined))
const deskHasExt = computed(() => deskSection.value !== null)
interface DeskCrumb { label: string; to?: string; go?: () => void }
const deskCrumbs = computed<DeskCrumb[]>(() => {
  const list: DeskCrumb[] = [{ label: '首頁', to: '/' }]
  const sec = deskSection.value
  if (!sec || sec === 'home') return [{ label: '正見' }]
  // 候選人頁、政見詳情頁：頁面自己算好的路徑（選舉名稱 › 地區 › 人物 › 政見標題）
  if (mounted.value && pageCrumbs.value && (route.name === 'politician' || route.name === 'policy')) {
    return [...list, ...pageCrumbs.value.map(c => ({ label: c.label, to: c.to }))]
  }
  const root = SECTION_ROOT[sec]
  const named = sec === 'election' && electionOnRoute.value && electionSegParam.value
  if (named) list.push({ label: electionOnRoute.value!.shortName || electionOnRoute.value!.name, to: `/election/${electionSegParam.value}` })
  else if (root) list.push({ label: sec === 'election' ? '選舉一覽' : root.label, to: root.to })
  if (isElectionRoute.value && mounted.value && crumbs.value && crumbs.value.length > 0) {
    crumbs.value.slice(1).forEach((c, i, all) => list.push(i === all.length - 1 ? { label: c.label } : { label: c.label, go: c.go }))
  } else if (route.name === 'politician') {
    list.push({ label: personOnRoute.value?.name ?? '候選人' })
  } else if (route.name === 'tracking') {
    list.push({ label: route.query.view === 'mine' ? '我的關注' : '全部政見' })
  } else if (sec !== 'search' && PAGE_TITLES[String(route.name)] && PAGE_TITLES[String(route.name)] !== root?.label) {
    list.push({ label: PAGE_TITLES[String(route.name)]! })
  }
  // 全台頁自己：最後一段是目前所在，不可點
  if (named && isElectionRoute.value && list.length === 2) list[1] = { label: list[1].label }
  return list
})
</script>

<template>
  <!-- 桌面（md 以上）頁首改 fixed（左邊讓出窄欄 72px、lg 再讓出延伸欄 176px，右邊到頭，橫跨內容與右欄），高度固定 48px，內容欄用 md:pt-12 佔位（App.vue）：
       sticky 在 125%／150% 縮放下捲動時邊界會在像素之間吸附而抖；fixed 不參與捲動。下框線改用不佔版面的 box-shadow（深色版見 styles/main.css），border-b 在縮放下是 0.8／0.67px、會讓高度變小數 -->
  <nav data-chrome="top" class="bg-white text-navy-900 sticky top-0 z-50 shadow-sm border-b border-slate-200 md:fixed md:inset-x-auto md:left-[72px] md:right-0 md:h-12 md:border-b-0 md:shadow-[0_1px_0_0_#e2e8f0] lg:left-[248px]">
    <!-- 手機版頁首（md 以下，X 式）：左選單鈕（開左側抽屜）、正中間站徽、右搜尋；主選單搬到畫面下方的 MobileTabBar -->
    <div class="md:hidden relative flex items-center h-14 px-2" data-testid="mobile-header">
      <button
        type="button"
        class="w-10 h-10 rounded-full flex items-center justify-center text-navy-900 active:bg-slate-100"
        aria-label="開啟選單"
        data-testid="mobile-menu-open"
        @click="openDrawer"
      >
        <Menu :size="24" />
      </button>
      <RouterLink v-if="isHome" to="/" class="absolute left-1/2 -translate-x-1/2 flex items-center" aria-label="正見 首頁">
        <img src="/brand/logo-zhengjian.png" srcset="/brand/logo-zhengjian.png 1x, /brand/logo-zhengjian@2x.png 2x" alt="正見" width="72" height="40" class="h-8 w-auto object-contain" />
      </RouterLink>
      <div v-else-if="isSearchRoute" class="min-w-0 flex-1 flex items-center gap-2 rounded-full bg-slate-100 px-3 h-9" data-testid="header-search">
        <Search :size="16" class="shrink-0 text-slate-400" />
        <input ref="searchInput" v-model="searchPageTerm" type="text" enterkeyhint="search" autocomplete="off" placeholder="搜尋人物或政見…" class="flex-1 min-w-0 bg-transparent outline-none text-base placeholder:text-slate-400" data-testid="global-search-input" />
        <button v-if="searchPageTerm" type="button" class="shrink-0 text-slate-400" aria-label="清除" @click="searchPageTerm = ''"><X :size="16" /></button>
      </div>
      <nav v-else-if="shownCrumbs" class="min-w-0 flex-1 flex items-center justify-center gap-0.5 px-1 text-[15px] font-bold text-navy-900" aria-label="目前定位" data-testid="header-crumbs">
        <template v-for="(c, i) in shownCrumbs" :key="i">
          <ChevronRight v-if="i > 0" :size="14" class="shrink-0 text-slate-400" />
          <button type="button" class="truncate rounded px-1 py-1.5 active:bg-slate-100" :class="i === shownCrumbs.length - 1 ? 'text-navy-900' : 'text-slate-500'" @click="c.go()">{{ c.label }}</button>
        </template>
      </nav>
      <div v-else-if="personOnRoute" class="min-w-0 flex-1 px-1 text-center leading-tight" data-testid="header-person">
        <div class="truncate text-[15px] font-bold text-navy-900">{{ personOnRoute.name }}</div>
        <div v-if="personOnRoute.sub" class="truncate text-[11px] text-slate-500">{{ personOnRoute.sub }}</div>
      </div>
      <div v-else class="min-w-0 flex-1 truncate px-1 text-center text-[15px] font-bold text-navy-900" data-testid="header-title">{{ pageTitle }}</div>
      <div v-if="!isSearchRoute" class="w-10 shrink-0" :class="isHome ? 'ml-auto' : ''" aria-hidden="true"></div>
    </div>

    <!-- 桌面版細頁首（md 以上）：左邊麵包屑（窄桌面多一顆開延伸欄抽屜的鈕），右邊顯示設定／登入／贊助；主選單在最左窄欄（DeskRail） -->
    <div class="hidden md:flex h-12 items-center gap-3 px-4 lg:px-6" data-testid="desk-header">
      <button v-if="deskHasExt" type="button" class="lg:hidden flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-navy-900 hover:bg-slate-100" aria-label="開啟子選單" data-testid="desk-drawer-open" @click="openDeskDrawer"><Menu :size="20" /></button>
      <nav class="min-w-0 flex-1 flex items-center gap-0.5 text-sm font-bold text-slate-500" aria-label="目前位置" data-testid="desk-crumbs">
        <template v-for="(c, i) in deskCrumbs" :key="i">
          <ChevronRight v-if="i > 0" :size="14" class="shrink-0 text-slate-300" />
          <RouterLink v-if="c.to" :to="c.to" class="truncate rounded px-1 py-1 hover:text-navy-900">{{ c.label }}</RouterLink>
          <button v-else-if="c.go" type="button" class="truncate rounded px-1 py-1 hover:text-navy-900" @click="c.go()">{{ c.label }}</button>
          <span v-else class="truncate px-1 py-1 text-navy-900">{{ c.label }}</span>
        </template>
      </nav>
      <div class="flex shrink-0 items-center gap-2">
        <GlobalSearch bare />
        <AppearanceMenu />
        <button v-if="isAuthenticated" @click="router.push('/profile')" class="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-navy-900 p-1.5 lg:px-3 lg:py-1.5 rounded-full text-sm font-bold transition-all border border-slate-200">
          <img v-if="userAvatarUrl" :src="userAvatarUrl" :alt="userDisplayName" class="w-7 h-7 rounded-full object-cover" />
          <div v-else class="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold">{{ userDisplayName.charAt(0).toUpperCase() }}</div>
          <span class="hidden lg:inline max-w-[100px] truncate">{{ userDisplayName }}</span>
        </button>
        <button v-else @click="isLoginModalOpen = true" class="flex bg-slate-100 hover:bg-slate-200 text-navy-900 w-9 h-9 rounded-full items-center justify-center transition-colors border border-slate-200" aria-label="登入" title="登入"><CircleUserRound :size="22" /></button>
        <RouterLink to="/donation" class="flex bg-red-500 hover:bg-red-600 text-white w-8 h-8 rounded-full items-center justify-center transition-all shadow-lg hover:shadow-red-500/20" aria-label="贊助平台" title="贊助平台"><Heart :size="16" class="fill-current" /></RouterLink>
      </div>
    </div>

    <!-- Login Modal (only for non-logged-in users) -->
    <div v-if="isLoginModalOpen && !isAuthenticated" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" @click="isLoginModalOpen = false">
      <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-8" @click.stop>
          <div class="flex items-center justify-between mb-6">
            <h2 class="text-2xl font-bold text-navy-900">登入</h2>
            <button
              @click="isLoginModalOpen = false"
              class="text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X :size="24" />
            </button>
          </div>

          <div class="space-y-4">
            <p class="text-slate-600 text-center mb-6">
              使用 Google 帳戶快速登入，參與公民討論與政見追蹤。
            </p>

            <button
              @click="handleGoogleLogin"
              :disabled="isLoggingIn"
              class="w-full bg-white hover:bg-slate-50 text-slate-700 font-bold py-3 px-4 rounded-xl transition-colors shadow-md border border-slate-200 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <template v-if="isLoggingIn">
                <Loader2 :size="20" class="animate-spin" />
                <span>登入中...</span>
              </template>
              <template v-else>
                <svg class="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                <span>使用 Google 登入</span>
              </template>
            </button>

            <p class="text-center text-xs text-slate-400 mt-6">
              登入即表示您同意我們的<RouterLink to="/terms" class="underline underline-offset-2 hover:text-slate-600" @click="isLoginModalOpen = false">服務條款</RouterLink>與<RouterLink to="/privacy" class="underline underline-offset-2 hover:text-slate-600" @click="isLoginModalOpen = false">隱私政策</RouterLink>
            </p>
          </div>
      </div>
    </div>
  </nav>
  <MobileDrawer
    :is-authenticated="isAuthenticated"
    :user-display-name="userDisplayName"
    :user-avatar-url="userAvatarUrl"
    @login="isLoginModalOpen = true"
    @profile="router.push('/profile')"
  />
</template>
