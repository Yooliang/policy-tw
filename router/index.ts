import type { Router, RouteRecordRaw } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import type { PageSnapshot } from '../lib/ssg/page-data'
import { handleChunkLoadError, isChunkLoadError, setPendingPath } from '../lib/chunk-reload'
// 記下第一次載入的路徑（人物一覽、政黨頁換頁進來要整頁載入預渲染那一份，見 lib/full-load.ts）
import '../lib/full-load'

declare module 'vue-router' {
  interface RouteMeta {
    requiresAdmin?: boolean
    /** SSG 建置時：本路由渲染所用的資料切片（同一份會序列化進 initialState 給客戶端 hydrate）。 */
    ssgSnapshot?: PageSnapshot
  }
}

/**
 * 路由表。router 實例由 vite-ssg 建立（客戶端 web history／建置時 memory history），
 * 這裡只提供 routes 與守衛。`name` 供 SSG 資料切片與 sitemap 判別，頁面程式不依賴它。
 */
// 三條選舉路由（全台／縣市／鄉鎮）共用同一個元件：換縣市、換鄉鎮時是同一個實例（KeepAlive 也認得），篩選狀態與捲動位置不會重來
const ElectionPage = () => import('../pages/ElectionPage.vue')
// 人物一覽的索引與分組（#346）共用同一個元件
const PeopleDirectory = () => import('../pages/PeopleDirectory.vue')

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('../pages/Home.vue'),
  },
  {
    path: '/tracking',
    name: 'tracking',
    component: () => import('../pages/PolicyTracking.vue'),
  },
  {
    path: '/policy/:policyId',
    name: 'policy',
    component: () => import('../pages/PolicyDetail.vue'),
  },
  {
    path: '/analysis',
    name: 'analysis',
    component: () => import('../pages/PolicyAnalysis.vue'),
  },
  {
    path: '/analysis/:policyId',
    name: 'analysis-detail',
    component: () => import('../pages/PolicyDeepAnalysis.vue'),
  },
  {
    // 政策脈絡頁（#349，2026-10-06）：正見.tw 由 Worker 邊緣渲染、進網站地圖；脈絡一覽照舊在 /analysis
    path: '/lineage/:lineageId',
    name: 'lineage',
    component: () => import('../pages/LineagePage.vue'),
  },
  {
    // 選舉一覽（#344，2026-10-05）：今後與過去的選舉；各場的網址照舊是 /election/:electionId
    path: '/elections',
    name: 'elections',
    component: () => import('../pages/ElectionList.vue'),
  },
  {
    path: '/election/:electionId',
    name: 'election',
    component: ElectionPage,
  },
  {
    // 縣市頁（2026-09-30）：同一個元件、預選該縣市；舊的 ?region= 由頁面換成這個網址
    path: '/election/:electionId/:region',
    name: 'election-region',
    component: ElectionPage,
  },
  {
    // 鄉鎮頁（2026-10-05）：同一個元件、預選該縣市與鄉鎮市區；舊的 ?sub= 由正見.tw 的 Worker 301、頁面也會換成這個網址
    path: '/election/:electionId/:region/:subRegion',
    name: 'election-township',
    component: ElectionPage,
  },
  {
    // 以前轉到 /election/1（不存在的選舉，顯示找不到）；網址保持（小良哥 10-05）：轉到 2026 那一場
    path: '/election-2026',
    redirect: '/election/2026',
  },
  {
    path: '/politician/:politicianId',
    name: 'politician',
    component: () => import('../pages/PoliticianProfile.vue'),
  },
  {
    // 人物一覽（#346，2026-10-06）：依姓氏筆畫分組，各組一頁（/politicians/11）；預渲染、進網站地圖
    path: '/politicians',
    name: 'politicians',
    component: PeopleDirectory,
  },
  {
    path: '/politicians/:group',
    name: 'politicians-group',
    component: PeopleDirectory,
  },
  {
    // 政黨一覽與各黨頁（#346）：id＝內政部政黨編號（名冊查無此名稱的從 10001 起）
    path: '/parties',
    name: 'parties',
    component: () => import('../pages/PartyList.vue'),
  },
  {
    path: '/party/:partyId',
    name: 'party',
    component: () => import('../pages/PartyPage.vue'),
  },
  {
    path: '/community',
    name: 'community',
    component: () => import('../pages/Community.vue'),
  },
  {
    path: '/community/:discussionId',
    name: 'discussion',
    component: () => import('../pages/DiscussionDetail.vue'),
  },
  {
    path: '/donation',
    name: 'donation',
    component: () => import('../pages/Donation.vue'),
  },
  {
    path: '/vision',
    name: 'vision',
    component: () => import('../pages/Vision.vue'),
  },
  {
    path: '/privacy',
    name: 'privacy',
    component: () => import('../pages/Privacy.vue'),
  },
  {
    path: '/regional-data',
    name: 'regional-data',
    component: () => import('../pages/RegionalData.vue'),
  },
  {
    path: '/skill',
    name: 'skill',
    component: () => import('../pages/Skill.vue'),
  },
  {
    path: '/sources',
    name: 'sources',
    component: () => import('../pages/Sources.vue'),
  },
  {
    path: '/admin/dashboard',
    component: () => import('../pages/AdminDashboard.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/duplicates',
    component: () => import('../pages/AdminDuplicates.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/ai',
    component: () => import('../pages/AdminAI.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/import',
    component: () => import('../pages/AdminImport.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/verify',
    component: () => import('../pages/VerifyContent.vue'),
  },
  {
    path: '/contributions',
    name: 'contributions',
    component: () => import('../pages/Contributions.vue'),
  },
  {
    path: '/tasks',
    name: 'tasks',
    component: () => import('../pages/Tasks.vue'),
  },
  {
    path: '/queue',
    name: 'queue',
    component: () => import('../pages/Queue.vue'),
  },
  {
    path: '/stats',
    name: 'stats',
    component: () => import('../pages/Stats.vue'),
  },
  {
    path: '/ai',
    name: 'ai',
    component: () => import('../pages/Ai.vue'),
  },
  {
    path: '/profile',
    component: () => import('../pages/UserProfile.vue'),
  },
  {
    path: '/auth/callback',
    component: () => import('../pages/AuthCallback.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
]

/** 後台頁需登入且為管理員；只在瀏覽器端有意義（建置時不預渲染 /admin）。 */
export function installRouterGuards(router: Router): void {
  router.beforeEach(async (to) => {
    setPendingPath(to.fullPath)
    if (to.meta.requiresAdmin) {
      const { isAuthenticated, isAdmin, authReady, initAuth } = useAuth()

      // Wait for auth to initialize
      if (!authReady.value) {
        await initAuth()
      }

      if (!isAuthenticated.value || !isAdmin.value) {
        return '/'
      }
    }
  })
  router.afterEach(() => setPendingPath(null))

  // 部署新版後舊分頁載入舊 chunk 404：硬重載到目標路徑（60 秒內同路徑只一次，再失敗顯示提示）
  if (!import.meta.env.SSR) {
    router.onError((error, to) => {
      if (isChunkLoadError(error)) handleChunkLoadError(to.fullPath)
    })
  }
}
