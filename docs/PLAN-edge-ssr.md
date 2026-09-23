# 計畫：預渲染搬到 Cloudflare Worker 邊緣 SSR（2026-09-23）

小良哥 09-23 點頭：「Cloudflare 的函式可以處理 SSG 嗎」→ 走「SSR＋邊緣快取」，分兩步搬，Firebase 預渲染留著當退路。

## 為什麼

- 現況：`vite-ssg` 在 CI 預渲染約 16k 頁，12 分鐘一次；連續合併排隊；資料落庫要等下一次建置才反映（09-22「83 個 0 項政見」就是預渲染快照沒帶政見）。
- Firebase Hosting 對中文域名驗不過，`正見.tw` 已經是 Cloudflare Worker 代理到 web.app（`cloudflare/worker.js`）。
- 目標：**沒有 16k 頁建置這回事**——每頁請求時現場向 Supabase 拿「那一頁」的資料、渲染、進邊緣快取；資料落庫時清掉相關頁。部署幾秒，內容永遠是當下的。

## 現況怎麼運作（要改的東西都在這裡）

| 檔 | 現在 | 之後 |
|---|---|---|
| `main.ts` | `ViteSSG(...)`，`includedRoutes` 在 SSR 時列出全部路由；client 啟動讀 `window.__INITIAL_STATE__` 進 `applyDataSnapshot` | 拆成 `entry-client.ts`／`entry-server.ts`（標準 Vue SSR）；client 照舊吃 `__INITIAL_STATE__` |
| `lib/ssg/server-data.ts` | 建置時 `ensureFullDataset()` 撈整庫（politicians_with_elections、policies_with_logs…），`collectRoutePaths()` 產 16k 路由 | 拿掉全庫快照；`collectRoutePaths` 只剩 sitemap 用（改成 DB 函式 `sitemap_entries()`） |
| `lib/ssg/page-data.ts` | 從全庫快照切每頁的 `PageSnapshot`（home／tracking／analysis／policy／election／politician／community／discussion／regional-data） | **每個 case 改成「按需查」的 loader**：`loadPageData(route, supabasePublic)`，只撈那一頁需要的表 |
| `composables/useSupabase.ts` | 模組級全域 state，`applyDataSnapshot(page)` 塞快照，`policiesComplete` 決定要不要再抓整份 | 不動介面；Worker 端每個請求 new 一份 state（不能共用模組級 ref，Worker 是多請求同一個 isolate） |
| `composables/usePageHead.ts` | `@unhead` 在 SSG 產 `<title>`／OG | 同一套，SSR 用 `renderSSRHead` |
| `scripts/postbuild-ssg.mjs` | 掃 dist 產 sitemap、空殼檢查 | sitemap 改由 Worker 動態回（`/sitemap.xml` 讀 DB），空殼檢查改成 e2e 打幾個網址 |
| `cloudflare/worker.js` | 反向代理到 web.app | 變成正式的 SSR Worker：靜態資源走 Static Assets，內容路由走 SSR＋快取，工具頁回 `app.html` |
| `.github/workflows/ci.yml` | `pnpm build`（16k 頁）→ Firebase deploy | `vite build`（client＋ssr 兩個 bundle，約 1 分鐘）→ `wrangler deploy`；Firebase 那段第一階段保留 |

## 架構

```
瀏覽器 → Cloudflare（憑證）→ Worker
  ├─ /assets/*、/brand/*、/skill.md、/ads.txt、/robots.txt → Static Assets（build 產物）
  ├─ /contributions /tasks /queue /stats /verify /profile /auth/* /admin/* → app.html（客戶端渲染，照舊）
  ├─ /sitemap.xml → DB 函式 sitemap_entries()（快取 1 小時）
  └─ 其餘（/、/election/:id、/politician/:id、/policy/:id、/analysis…）
       → Cache API 命中就回；沒命中或過期 → loadPageData → renderToString → 塞 __INITIAL_STATE__ → 回應並寫入快取
```

- 快取鍵＝完整網址；TTL 10 分鐘＋`stale-while-revalidate`（過期先回舊的、背景重算）。
- **落庫就清**：`apply-contribution.ts` 上線一筆後打 `POST /__purge {politician_id?, policy_id?}`（帶共用密鑰），Worker 清人物頁、該政見頁、所屬選舉頁與首頁。沒清到的最多舊 10 分鐘。
- 每個請求只撈那一頁：人物頁＝1 人＋他的政見＋參選紀錄（3 個查詢）；政見頁＝1 筆＋接力鏈＋人物；選舉頁＝該屆候選人＋該屆政見（最重，223 筆政見級別，仍在 1 秒內）。

## 分段

### 第 1 步（本週）：人物頁＋政見頁（16k 頁裡的 15k 頁）
1. `entry-server.ts`／`entry-client.ts`，`vite.config.ts` 加 SSR build（target `webworker`）。
2. `lib/ssr/loaders.ts`：`politician(id)`、`policy(id)` 兩個 loader，回 `PageSnapshot` 同型別（既有元件零改動）。
3. `cloudflare/worker.js` 改成路由：這兩種路由走 SSR；其餘照舊代理 web.app（退路）。
4. `wrangler.toml`（Workers Paid，$5/月）＋ CI 的 `wrangler deploy`（token 進 GitHub secrets）。
5. 驗收：同一個人物頁，web.app 與正見.tw 的 HTML 一致（title、canonical、卡片內容），新提交上線後 1 分鐘內人物頁看得到。

### 第 2 步：首頁、選舉頁、追蹤、分析、社群、縣市數據
- 各寫 loader；選舉頁的 `__INITIAL_STATE__` 帶該屆政見（09-22 的「0 項政見」在這裡自然解掉）。
- `/sitemap.xml` 動態化；Search Console 的 sitemap 不用換網址。

### 第 3 步：拆掉 CI 預渲染
- `pnpm build` 改成 `vite build`（1 分鐘）；`postbuild-ssg.mjs` 退場；Firebase 只留 `app.html` 殼與 `skill.md`（或也搬 Static Assets，web.app 由 Worker 代理反向指回——看要不要保留舊網址）。

## 風險與對策

- **Worker 是多請求共用的 isolate**：`useSupabase` 的模組級 ref 不能直接用；SSR 端要用 `createApp` 時注入一份新的 state（pinia 風格），client 端不變。這是第 1 步最主要的工程。
- **CPU 時間**：Vue SSR 一頁 5～30ms；免費方案 10ms 不夠，Paid 30 秒綽綽有餘。
- **快取失效漏網**：TTL 兜底 10 分鐘；purge 失敗只是舊一點。
- **`ClientOnly`／`window`**：現有規範照舊（圖表、倒數、localStorage 都在 `onMounted`）。
- **回滾**：Worker 一行改回「全部代理 web.app」，Firebase 預渲染還在。

## 不做的事

- 不改資料流程、不改協議、不改 Supabase schema（除了 `sitemap_entries()` 一個唯讀函式）。
- 第 1 步不碰 web.app：它仍由 CI 預渲染，兩邊可對照。
