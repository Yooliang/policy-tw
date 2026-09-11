# 建置時預渲染（SSG）

2026-09 起 `pnpm build` 不再只出 SPA 空殼，而是用 [vite-ssg](https://github.com/antfu-collective/vite-ssg) 在建置時把每個內容頁渲染成含真實文字的 HTML。動機：AdSense 審核判「畫面沒有發布商內容」，以及 SEO。

## 指令

| 指令 | 說明 |
|---|---|
| `pnpm build` | `vue-tsc` → `vite-ssg build`（預渲染全部路由）→ `scripts/postbuild-ssg.mjs`（產 sitemap、驗證不是空殼，失敗就紅） |
| `SSG_POLITICIANS=with-content pnpm build` | 只預渲染有簡介／口號／照片／政見或非村里長的政治人物（約 2,500 頁，1 分鐘），開發時用 |
| `SSG_DEBUG_HYDRATION=1 pnpm build` | 客戶端 bundle 會在 console 印 hydration mismatch 細節，驗證用；正式 build 不要開 |
| `pnpm build:spa` | 舊的純 SPA build（緊急 fallback，沒有預渲染、沒有殼檔） |
| `pnpm preview` | 預覽 dist（已設 `appType: mpa`，`/politician/:id` 會對到 `politician/:id/index.html`；但無法模擬 firebase rewrites 與 404.html） |
| `node scripts/serve-dist.mjs 4180` | 本機模擬 Firebase Hosting：cleanUrls、firebase.json rewrites、找不到回 `404.html`（HTTP 404）。驗 404／工具頁殼用這個 |

## 建置時發生什麼

1. `main.ts` 匯出 `includedRoutes`：vite-ssg 從 server bundle 呼叫它，`lib/ssg/server-data.ts` 一次撈齊全站資料（`fetchAll` ＋ `politicians_with_elections` 全表，**必須 `order('id')`**，否則 PostgREST 分頁會重複／漏筆），回傳所有要預渲染的路徑。
2. 每條路由渲染前，`router.beforeEach` 用 `lib/ssg/page-data.ts` 算出「這頁需要的資料切片」，套進 `useSupabase` 的全域狀態（`applyDataSnapshot`），渲染後同一份切片序列化進 `window.__INITIAL_STATE__`。
3. 客戶端啟動時先 `applyDataSnapshot(initialState.page)` 再 hydrate，所以第一次渲染與 HTML 完全一致；之後 `useSupabase()` 照常 `fetchAll()` 換成最新資料（`loaded` 不會被快照設成 true）。
4. `ssgOptions.concurrency` 必須是 1：資料層是模組級全域狀態，並行渲染會讓各頁切片互相覆蓋。
5. `onBeforePageRender` 第一次被叫到時，把 vite 產出的模板（空 `#app`）寫成 `dist/404.html` 與 `dist/app.html`，並加 `noindex`。

## 哪些頁面會預渲染

- 靜態：`/`、`/tracking`、`/analysis`、`/community`、`/regional-data`、`/donation`
- `/election/:id`（每個選舉）、`/policy/:id`（每條政見）、`/politician/:id`（每位政治人物）、`/community/:id`（每個討論串）
- `/analysis/:id` 只出「分析列表實際會連到」的那幾條（與 `PolicyAnalysis.relayCases` 同邏輯），不是全部政見
- **不**預渲染：`/admin/*`、`/auth/callback`、`/verify`、`/ai-assistant`、`/profile`、`/election-2026`（redirect）、catch-all

## Firebase Hosting 行為（firebase.json）

- `cleanUrls: true`，輸出為 `dirStyle: nested`（`/politician/123` → `dist/politician/123/index.html`），有無尾斜線都命中
- 拿掉 `** → /index.html` 萬用 rewrite；工具頁與 `/admin/**` rewrite 到 `/app.html`（200 ＋ noindex，客戶端渲染）
- 其餘找不到的路徑 Firebase 自動回 `404.html`（HTTP 404），殼會啟動 app 在客戶端渲染，所以建置後才新增的政治人物頁直接打開仍能顯示，只是狀態是 404

## 只能在瀏覽器跑的東西

- `vue3-apexcharts`：`main.ts` 客戶端分支動態 import；模板中的 `<apexchart>` 包 `<ClientOnly>`
- Monetag（`lib/ads.ts`）：`App.vue` 的 `onMounted` 才呼叫
- 選舉頁倒數天數：包 `<ClientOnly>`（建置時算的會過期）
- `useAuth` 在 SSR 不初始化；`useIndexedDB` 沒有 `indexedDB` 時直接走既有 catch
- 新增頁面若在 `setup` 期碰 `window`／`document`／`localStorage`，建置會直接炸；放進 `onMounted` 或 `<ClientOnly>`

## 每頁 head

`composables/usePageHead.ts` 統一給 `<title>`、description、Open Graph；工具頁與後台傳 `noindex: true`。`App.vue` 用 `useHead` 釘 `<html lang="zh-TW">`（unhead 預設會寫成 `en`）。

## Tailwind

Play CDN 已移除，改為建置時 Tailwind（`tailwind.config.js` ＋ `postcss.config.js` ＋ `styles/main.css`）。動態組出來的 class（目前只有 `focus:ring-${ringColor}`）掃不到，要加進 `safelist`。
