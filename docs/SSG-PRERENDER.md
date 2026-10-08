# 建置時預渲染（SSG）

2026-09 起 `pnpm build` 不再只出 SPA 空殼，而是用 [vite-ssg](https://github.com/antfu-collective/vite-ssg) 在建置時把每個內容頁渲染成含真實文字的 HTML。動機：AdSense 審核判「畫面沒有發布商內容」，以及 SEO。

## 指令

| 指令 | 說明 |
|---|---|
| `pnpm build` | `vue-tsc` → `vite-ssg build`（預渲染內容頁，約 450 頁；**人物頁、政見頁、脈絡頁預設不預渲染**，由正見.tw 的 Worker 邊緣渲染，只進網站地圖，見下一節）→ `scripts/postbuild-ssg.mjs`（產 sitemap、驗證不是空殼，失敗就紅） |
| `SSG_EDGE_PAGES=prerender pnpm build` | 退回把人物頁、政見頁、脈絡頁也一起預渲染（約 16k 頁、4 分鐘）；邊緣渲染出問題時的退路 |
| `SSG_POLITICIANS=with-content pnpm build` | 人物頁只收有簡介／口號／照片／政見或非村里長的政治人物（約 2,500 人）。預設下只影響網站地圖；搭配 `SSG_EDGE_PAGES=prerender` 才影響預渲染（約 1 分鐘），開發時用 |
| `SSG_DEBUG_HYDRATION=1 pnpm build` | 客戶端 bundle 會在 console 印 hydration mismatch 細節，驗證用；正式 build 不要開 |
| `pnpm build:spa` | 舊的純 SPA build（緊急 fallback，沒有預渲染、沒有殼檔） |
| `pnpm preview` | 預覽 dist（已設 `appType: mpa`，`/politician/:id` 會對到 `politician/:id/index.html`；但無法模擬 firebase rewrites 與 404.html） |
| `node scripts/serve-dist.mjs 4180` | 本機模擬 Firebase Hosting：cleanUrls、firebase.json rewrites、找不到回 `404.html`（HTTP 404）。驗 404／工具頁殼用這個。預設連 Worker 的縣市頁／鄉鎮頁規則一起模擬，加 `--no-worker` 只模擬 Firebase |

## 建置時發生什麼

1. `main.ts` 匯出 `includedRoutes`：vite-ssg 從 server bundle 呼叫它，`lib/ssg/server-data.ts` 一次撈齊全站資料（`fetchAll` ＋ `politicians_with_elections` 全表，**必須 `order('id')`**，否則 PostgREST 分頁會重複／漏筆），回傳所有要預渲染的路徑。
2. 每條路由渲染前，`router.beforeEach` 用 `lib/ssg/page-data.ts` 算出「這頁需要的資料切片」，套進 `useSupabase` 的全域狀態（`applyDataSnapshot`），渲染後同一份切片序列化進 `window.__INITIAL_STATE__`。
3. 客戶端啟動時先 `applyDataSnapshot(initialState.page)` 再 hydrate，所以第一次渲染與 HTML 完全一致。快照帶 `generatedAt`（建置時間）：7 天內且有基礎資料就直接視為 `loaded`，不再重撈 elections／categories／locations 那四個小請求；重資料（政見清單等）照舊由 `policiesComplete` 等旗標決定要不要撈。
4. `ssgOptions.concurrency` 必須是 1：資料層是模組級全域狀態，並行渲染會讓各頁切片互相覆蓋。
5. `onBeforePageRender` 第一次被叫到時，把 vite 產出的模板（空 `#app`）寫成 `dist/404.html` 與 `dist/app.html`，並加 `noindex`。

## 哪些頁面會預渲染

- 靜態：`/`、`/tracking`、`/analysis`、`/elections`、`/community`、`/regional-data`、`/donation`、`/skill`、`/vision`、`/privacy`、`/terms`、`/contact`、`/sources`、`/politicians`、`/parties`（`lib/ssg/server-data.ts` 的 `STATIC_CONTENT_ROUTES`）
- `/politicians/:筆畫數`（人物一覽各組）、`/party/:id`（各黨頁，#346；網址都是 ASCII）
- **邊緣渲染，不預渲染**（2026-09-24 起；清單由 `server-data.ts` 寫進 `dist/.edge-routes.json` 給 postbuild 產網站地圖，規則在 `cloudflare/ssr-worker.js` 的 `SSR_ROUTES`）：`/politician/:id`、`/policy/:id`、`/lineage/:id`。下面其餘各條都還是預渲染
- `/election/:id`（每個選舉；網址那一段：舊三屆用 id、新增的選舉用 `election_key`，`lib/election-route.ts` 的 `electionSegment`，#344 第二階段 A；舊三屆的 key 寫法 301 到年份寫法，不預渲染）、`/election/:id/:縣市`（2026-09-30：每屆有候選人的縣市各一頁，含該縣市所有候選人的連結；vite-ssg 寫在中文目錄，postbuild 搬到 `election/:id/_r/<UTF-8 十六進位>/`，正見.tw 的 Worker 代理時換路徑，見 `cloudflare/region-path.js`；舊的 `?region=` 由 Worker 301、客戶端也會換成路徑）、`/election/:id/:縣市/:鄉鎮`（2026-10-05：每屆「鄉鎮頁會列出的職位」——鄉鎮市長、代表、原住民區長、區代表、村里長——有人在選的鄉鎮市區各一頁，規則在 `lib/election-townships.ts`；搬到 `election/:id/_r/<縣市十六進位>/<鄉鎮十六進位>/`；舊的 `?sub=` 由 Worker 301、客戶端也會換成路徑；一位都沒有的鄉鎮不出頁，舊網址轉過去落到 app 殼，見下面 Firebase 那節）、`/community/:id`（每個討論串）
- `/analysis/:id` 只出「分析列表實際會連到」的那幾條（與 `PolicyAnalysis.relayCases` 同邏輯），不是全部政見
- **不**預渲染：`/admin/*`、`/auth/callback`、`/verify`、`/contributions`、`/tasks`、`/stats`、`/profile`、`/election-2026`（redirect）、catch-all

## Firebase Hosting 行為（firebase.json）

- `cleanUrls: true`，輸出為 `dirStyle: nested`（`/politician/123` → `dist/politician/123/index.html`），有無尾斜線都命中
- 拿掉 `** → /index.html` 萬用 rewrite；工具頁與 `/admin/**` rewrite 到 `/app.html`（200 ＋ noindex，客戶端渲染）
- 其餘找不到的路徑 Firebase 自動回 `404.html`（HTTP 404），殼會啟動 app 在客戶端渲染，所以建置後才新增的政治人物頁直接打開仍能顯示，只是狀態是 404
- 選舉頁的縣市頁／鄉鎮頁（2026-10-05 起三條，`lib/election-regions.test.ts` 守著）：
  - `/election/*/*`、`regex ^/election/[^/]+/[^/_][^/]*/[^/]+/?$` → `app.html`：直接打 policy-tw.web.app 的中文縣市頁、鄉鎮頁網址只給 app 殼（200＋noindex），預渲染檔在 ASCII 路徑、只有正見.tw 的 Worker 會去拿。regex 刻意排除 `_r` 開頭的第二段，不然亂打的縣市（Worker 換成 `_r/<十六進位>`）會從 404 變 200
  - `/election/*/_r/*/*` → `app.html`：正見.tw 上沒預渲染的鄉鎮頁（例如 2026 還沒人登記的鄉鎮；舊的 `?sub=` 照樣 301 過來）回 app 殼、客戶端渲染、noindex，不 404——舊網址不能壞（10-05 常設裁決），空頁也不該被收錄

## 只能在瀏覽器跑的東西

- `vue3-apexcharts`（578 KB）：不全域註冊，用到的元件自己 `defineAsyncComponent(() => import('vue3-apexcharts'))`，模板中的 `<apexchart>` 包 `<ClientOnly>`。以前在 `main.ts` 全域 `await import`，vite-ssg 會等它才 mount，害每一頁都得先載完圖表函式庫才能互動
- 選舉頁倒數天數：包 `<ClientOnly>`（建置時算的會過期）
- `useAuth` 在 SSR 不初始化
- 新增頁面若在 `setup` 期碰 `window`／`document`／`localStorage`，建置會直接炸；放進 `onMounted` 或 `<ClientOnly>`

## 每頁 head

`composables/usePageHead.ts` 統一給 `<title>`、description、Open Graph；工具頁與後台傳 `noindex: true`。`App.vue` 用 `useHead` 釘 `<html lang="zh-TW">`（unhead 預設會寫成 `en`）。

## Tailwind

Play CDN 已移除，改為建置時 Tailwind（`tailwind.config.js` ＋ `postcss.config.js` ＋ `styles/main.css`）。動態組出來的 class（目前只有 `focus:ring-${ringColor}`）掃不到，要加進 `safelist`。
