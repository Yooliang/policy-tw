import type { Router, RouteRecordRaw } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import type { PageSnapshot } from '../lib/ssg/page-data'
import { handleChunkLoadError, isChunkLoadError, setPendingPath } from '../lib/chunk-reload'

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
    path: '/election/:electionId',
    name: 'election',
    component: () => import('../pages/ElectionPage.vue'),
  },
  {
    path: '/election-2026',
    redirect: '/election/1',
  },
  {
    path: '/politician/:politicianId',
    name: 'politician',
    component: () => import('../pages/PoliticianProfile.vue'),
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
    path: '/admin/dashboard',
    component: () => import('../pages/AdminDashboard.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/scraper',
    component: () => import('../pages/AdminScraper.vue'),
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
    path: '/ai-assistant',
    name: 'contributions',
    component: () => import('../pages/Contributions.vue'),
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
