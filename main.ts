import { ViteSSG } from 'vite-ssg'
import App from './App.vue'
import { routes, installRouterGuards } from './router'
import { applyDataSnapshot } from './composables/useSupabase'
import { buildPageSnapshot, type PageSnapshot } from './lib/ssg/page-data'
import './styles/main.css'

/**
 * 建置時預渲染（vite-ssg）：
 * - 建置端：每條路由渲染前，把「這頁需要的資料切片」套進全域狀態，渲染後放進 initialState。
 * - 客戶端：hydrate 前先套回同一份切片，第一次渲染與 HTML 完全一致；之後 useSupabase 照常抓最新資料。
 * 只能在瀏覽器跑的東西（ApexCharts、Monetag、IndexedDB、localStorage）都留在客戶端分支或 onMounted。
 */
export const createApp = ViteSSG(
  App,
  {
    routes,
    base: import.meta.env.BASE_URL,
    scrollBehavior: () => false,
  },
  async ({ app, router, initialState, onSSRAppRendered }) => {
    installRouterGuards(router)

    if (!import.meta.env.SSR) {
      const page = initialState.page as PageSnapshot | undefined
      if (page) applyDataSnapshot(page)
      // vue3-apexcharts 在 import 時就碰 window，只能在瀏覽器載入
      const { default: VueApexCharts } = await import('vue3-apexcharts')
      app.use(VueApexCharts)
      return
    }

    const { ensureFullDataset } = await import('./lib/ssg/server-data')
    router.beforeEach(async (to) => {
      const full = await ensureFullDataset()
      const snapshot = buildPageSnapshot(to, full)
      applyDataSnapshot(snapshot)
      to.meta.ssgSnapshot = snapshot
    })
    onSSRAppRendered(() => {
      initialState.page = router.currentRoute.value.meta.ssgSnapshot
    })
  },
  { hydration: true },
)

/** vite-ssg 從 server entry 讀這個 export 決定要預渲染哪些路徑（動態路由要真的撈 id）。 */
export const includedRoutes = import.meta.env.SSR
  ? async (): Promise<string[]> => {
      const { ensureFullDataset, collectRoutePaths } = await import('./lib/ssg/server-data')
      return collectRoutePaths(await ensureFullDataset())
    }
  : undefined
