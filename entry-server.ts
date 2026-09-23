import { createSSRApp, defineComponent, h, onMounted, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'
import { createHead, renderSSRHead } from '@unhead/vue/server'
import App from './App.vue'
import { routes, installRouterGuards } from './router'
import { applyDataSnapshot } from './composables/useSupabase'
import { loadPageData } from './lib/ssr/loaders'
import type { PageSnapshot } from './lib/ssg/page-data'

/**
 * 邊緣 SSR 入口（Cloudflare Worker 用，docs/PLAN-edge-ssr.md）。
 * 跟 main.ts（vite-ssg 的預渲染／客戶端入口）並存：客戶端照舊由 main.ts hydrate，
 * 讀 window.__INITIAL_STATE__ 裡的 page 快照——所以這裡產出的 state 形狀要跟 vite-ssg 一樣：{ page: PageSnapshot }。
 */

/** vite-ssg 的 ClientOnly：伺服器不渲染、掛載後才出現。自己寫一份，免得把 vite-ssg 的客戶端入口整包拉進 Worker */
const ClientOnly = defineComponent({
  name: 'ClientOnly',
  setup(_, { slots }) {
    const mounted = ref(false)
    onMounted(() => { mounted.value = true })
    return () => (mounted.value ? slots.default?.() : null)
  },
})

export interface RenderResult {
  status: 200 | 404 | 'passthrough'
  html?: string
  headTags?: string
  htmlAttrs?: string
  bodyAttrs?: string
  bodyTagsOpen?: string
  bodyTags?: string
  state?: { page: PageSnapshot }
}

// useSupabase 的狀態是模組級 ref，Worker 的一個 isolate 會同時處理多個請求：渲染一律排隊，
// 一次只有一個請求在「套快照 → 渲染」之間，狀態才不會被別的請求蓋掉。一頁 5～30ms，排隊成本可接受。
let chain: Promise<unknown> = Promise.resolve()

export function render(url: string): Promise<RenderResult> {
  const run = () => renderOnce(url)
  const p = chain.then(run, run)
  chain = p.catch(() => undefined)
  return p
}

async function renderOnce(url: string): Promise<RenderResult> {
  const router = createRouter({ history: createMemoryHistory(), routes, scrollBehavior: () => false })
  const target = router.resolve(url)
  const snapshot = await loadPageData(target)
  if (snapshot === undefined) return { status: 'passthrough' }
  if (snapshot === null) return { status: 404 }

  applyDataSnapshot(snapshot)
  const app = createSSRApp(App)
  const head = createHead()
  app.use(router).use(head)
  app.component('ClientOnly', ClientOnly)
  installRouterGuards(router)
  await router.push(url)
  await router.isReady()

  const html = await renderToString(app, {})
  const payload = await renderSSRHead(head)
  return {
    status: 200,
    html,
    headTags: payload.headTags,
    htmlAttrs: payload.htmlAttrs,
    bodyAttrs: payload.bodyAttrs,
    bodyTagsOpen: payload.bodyTagsOpen,
    bodyTags: payload.bodyTags,
    state: { page: snapshot },
  }
}
