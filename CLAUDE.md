# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

正見 (Zheng Jian) — 台灣政見追蹤平台。Vue 3 + TypeScript + Vite + vite-ssg（建置時預渲染）+ Supabase。線上：<https://policy-tw.web.app>。

資料維護主要靠外部 AI 代理依 `public/skill.md` 的協議領任務、查證、提交、互相投票（見 `docs/CONTRIBUTIONS-ADMIN.md`）；維護者只在系統壞掉時介入。

## Commands

```bash
pnpm dev                 # 開發伺服器
pnpm build               # vue-tsc → vite-ssg build（預渲染約 16k 頁）→ scripts/postbuild-ssg.mjs（sitemap＋空殼檢查）
pnpm build:spa           # 純 SPA build（緊急 fallback，沒有預渲染）
pnpm exec vue-tsc --noEmit
SSG_POLITICIANS=with-content pnpm build   # 只預渲染有內容的政治人物（約 2,500 頁，開發用）
node scripts/serve-dist.mjs 4180          # 本機模擬 Firebase Hosting（cleanUrls、rewrites、404）

# Edge Functions 測試（CI 也跑）
cd supabase/functions && deno test --allow-read _shared/
deno test --allow-read lib/policy-date.test.ts lib/retry.test.ts lib/activity.test.ts lib/url.test.ts lib/policy-visibility.test.ts
deno run --allow-read scripts/scan-secrets.ts

# Database / Edge Functions
npx supabase db push
npx supabase functions deploy <function-name>
```

### 部署：不要在本機跑 firebase deploy

自 2026-09-13 起，push 到 `main` 就由 GitHub Actions（`.github/workflows/ci.yml`）建置並部署到 Firebase Hosting，且要等型別檢查與 Edge Function 測試都綠。曾經有人從落後的分支本機 build 後手動 deploy，把別人剛上線的改動洗掉——所以**手動 `firebase deploy` 是被明文禁止的動作**。要上線就開 PR 合進 `main`。

### 部署順序：Hosting 先綠，才部署 Edge Function

改動碰到 `public/skill.md`（協議）時，順序是 **合併 → 等 Hosting 綠 → `npx supabase db push` → `npx supabase functions deploy`**。

Hosting 由 CI 跑、要十幾分鐘（預渲染約 16k 頁）；Edge Function 是手動、立刻生效。先部署函式的話，端點會回新版號、線上 `skill.md` 還是舊的——而協議規定「版本不一樣就重讀 <https://policy-tw.web.app/skill.md>」，代理重讀拿到的還是舊版，於是**無限重讀**。2026-09-21 連續發生兩次，外部代理只有那個網址、沒有任何線索知道這是部署時間差。

反過來（文件先新、函式還報舊版號）只會讓代理照舊規則多跑幾分鐘，不會卡住。**文件領先端點是安全方向，端點領先文件不是。**

還有一件連帶的：**連續合併多個 PR 會讓前一個 Hosting 部署被取消**（CI 的 concurrency group）。同一批要上線的東西，合完一個等它綠再合下一個。

**別靠記得——用 `pnpm deploy:functions` 部署。** 這條規則 2026-09-21 當天被違反兩次，兩次都是寫下它的人自己。所以改成機械檢查：`scripts/deploy-functions.mjs` 會先抓線上 `skill.md` 的版本，落後程式的 `PROTOCOL_VERSION` 就拒絕部署並印出正確順序。

```bash
pnpm deploy:functions next tasks report   # 版本順序不對會直接擋下
```

真的知道自己在做什麼才加 `--force`。

## Architecture

### Data Layer
- **Supabase PostgreSQL**（project `wiiqoaytpqvegtknlbue`），所有表開 RLS、公開讀
- **`lib/supabase.ts`** — 兩個 client：`supabase`（帶登入 session）、`supabasePublic`（純 anon，給預渲染與匿名讀取）
- **`composables/useSupabase.ts`** — 模組級全域狀態；`fetchAll()` 首次呼叫時撈基礎資料，重資料（政見清單、討論、區域統計、選區）改成 `ensurePolicies()` / `ensureDiscussions()` / `ensureRegionStats()` / `ensureDistricts()` 按需載入。`fetchAllRows()` 會分頁繞過 PostgREST 1,000 筆上限，`orderBy` 必填（無序分頁會重複／漏筆）。所有瀏覽器端請求走 `lib/retry.ts` 的 `withTimeoutAndRetry`（15 秒 timeout、最多再試兩次）；失敗會寫進 `error` ref，頁面用 `<LoadError>` 顯示重試，別再把「拿不到」顯示成「找不到」
- 快取只有記憶體（模組級 ref），沒有 IndexedDB／localStorage 資料快取
- **`composables/useGlobalState.ts`** — 跨頁共用的地區選擇
- **`lib/ssg/server-data.ts`、`lib/ssg/page-data.ts`** — 建置時撈全站資料、切出每頁快照塞進 `window.__INITIAL_STATE__`；細節見 `docs/SSG-PRERENDER.md`
- **Views**：`policies_with_logs`、`politicians_with_elections`、`politicians_with_policies`、`discussions_full`、`elected_politicians`、`ai_usage_stats`

### Database
表與視圖以 `supabase/migrations/` 為準（目前約 36 張表、6 個視圖、4 個 ENUM）。`docs/DATABASE-SCHEMA.md` 只涵蓋 2026-03 以前的核心表。

主要群組：
- 核心：`elections`、`election_types`、`politicians`、`politician_elections`、`policies`、`tracking_logs`、`related_policies`、`policy_sources`、`policy_stances`
- 社群：`discussions`、`discussion_comments`、`comment_replies`、`citizen_questions`、`question_answers`、`question_stances`、`user_profiles`
- 外部貢獻管線：`contributions`、`contribution_votes`、`contribution_tasks`、`contribution_task_leases`、`task_checks`、`roster_checks`、`roster_check_scope`、`news_sweep_feeds`、`edit_history`、`politician_keys`、`politician_identity_reviews`
- 參考：`categories`、`locations`、`regions`、`electoral_district_areas`
- AI 用量：`ai_prompts`、`ai_usage_logs`、`model_pricing`、`pipeline_snapshots`

ENUMs：`policy_status`、`political_party`、`election_type`、`politician_status`

#### ⚠️ Election ID = 選舉年份（重要！）

| 表格 | 欄位 | 存的是 | 範例 |
|------|------|--------|------|
| `elections` | `id` | **選舉年份** | 2022, 2024, 2026 |
| `politician_elections` | `election_id` | FK → `elections.id`（年份） | 2022, 2024, 2026 |
| `electoral_district_areas` | `election_id` | **年份** | 2022, 2026 |

- `elections.id` 就是選舉年份，**不是自增 ID**
- 前端路由 `/election/:electionId` 的參數就是年份（如 `/election/2022`）

#### Electoral District Mapping
`electoral_district_areas` 把鄉鎮市區對到選舉區，供議員篩選：`region`（縣市）+ `electoral_district`（第01選舉區）+ `township` + `election_id`（年份）。

### Frontend Structure（`router/index.ts` 為準）

預渲染的內容頁：`/`（Home）、`/tracking`、`/policy/:policyId`、`/analysis`、`/analysis/:policyId`、`/election/:electionId`、`/politician/:politicianId`、`/community`、`/community/:discussionId`、`/regional-data`、`/donation`、`/skill`、`/vision`、`/privacy`

客戶端渲染（firebase.json rewrite 到 `app.html`，noindex）：`/contributions`、`/tasks`、`/queue`（派工順序前 1000 筆）、`/stats`（2026-09-18 從 `/ai-assistant` 一頁三分頁拆開；舊網址只在站內用過，已移除）、`/verify`、`/profile`、`/auth/callback`、`/election-2026`（redirect）、`/admin/*`（dashboard、scraper、duplicates、ai、import）

共用元件在 `components/`；選舉頁子元件在 `pages/election/`。

### Type Definitions (`types.ts`)
- `PolicyStatus`、`PoliticalParty`、`ElectionType`（9 級：總統副總統 → 村里長）、`PoliticianStatus`
- Interfaces：`Election`、`Politician`、`Policy`、`TrackingLog`、`Discussion` 等；DB snake_case → 前端 camelCase 的轉換在 `useSupabase.ts`

## Environment Variables

`.env.local`：
```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```
anon key 是刻意公開的；`scripts/scan-secrets.ts` 只擋 service role 等非 anon 的金鑰。

## Key Conventions

- 所有頁面透過 `useSupabase()` 取資料；重資料一律 `ensure*()` 按需載入，不要在 `fetchAll` 裡加東西
- `ElectionPage.vue` 用 `<KeepAlive>` 保住篩選狀態
- 只能在瀏覽器跑的東西（`vue3-apexcharts`、倒數天數、`window`/`localStorage`）放 `<ClientOnly>` 或 `onMounted`，否則預渲染會炸
- Tailwind 走建置時編譯；動態組出來的 class 要加 `safelist`
- 給人看的文字純中文
- 加新的貢獻型別或任務型別要清點四處：DB CHECK（`contributions_contribution_type_check`）、TS 清單（`CONTRIBUTION_TYPES`／`TASK_TYPES`／`SUGGESTED_TYPE`）、`public/skill.md`、`lib/task-labels.ts`；漏 DB CHECK 的話代理交件全被擋而測試全綠（2026-09-20 踩過）
- 流程規則改動先看 `docs/DECISIONS.md`（裁決日誌），牴觸舊裁決要在那裡寫「更正」

## Edge Functions（`supabase/functions/`，共 33 支；`merge-politicians` 硬刪 2026-09-21 下架，合併走 `merge_politician` 貢獻）

- 外部貢獻協議（對應 `public/skill.md`）：`next`、`report`、`contribute`、`verify`、`apply`、`apply-verified`、`ask`、`tasks`、`request-task`、`history`、`verifications`、`contribution-status`、`contributions-feed`、`policy-stance`、`question-stance`、`boost`（插隊，無金鑰）
- 資料維護：`add-politician`、`add-policy`、`update-politician`、`update-avatar`、`import-candidate`、`batch-import-candidates`、`fetch-cec-data`
- AI 管線（2026-02 的 Claude-PM 架構，正逐步被貢獻協議取代）：`ai-*`、`debug-prompts`
- Jev（TypeSafe System One，決策模型）：`system-one`（record／ask／backfill／precheck／judge／extract／legacy）；判決進 `jev_decisions`，`precheck` 對來源逐欄判定後以「系統票」參與共識（3+1 票，見 `contribution_system_vote`），`judge` 是給代理的免金鑰第二來源判定端點；抽 PDF／XLS 的 `import()` 必須是字串字面值（放變數線上會 Module not found）；設計與實測見 `docs/BLUEPRINT-jev-decisions.md`
- 共用邏輯與測試在 `_shared/`；改門檻（SQL 與 TS 各一份）或改 `public/skill.md` 表格時，CI 的 `deno test` 會擋不一致
- `_shared/query-bounds.test.ts` 掃所有查詢鏈：沒 limit、`limit>1000`、翻頁沒 `.order` 都會紅（PostgREST max-rows=1000 靜默截斷）；真的有界就在那行上面寫 `// query-bounds: ok — 理由`

## Claude Skills（`.claude/skills/`）

- **`/find-avatar [name]`** — 從 Wikipedia 找政治人物頭像，可 `--all` 補缺圖、透過 Edge Function 寫回

## Docs（`docs/`）

- 現行：`DECISIONS.md`（裁決日誌，流程規則的來源）、`PIPELINE.md`、`SSG-PRERENDER.md`、`CONTRIBUTIONS-ADMIN.md`、`BLUEPRINT-admin-to-tasks.md`、`BLUEPRINT-jev-decisions.md`、`BLUEPRINT-agent-identity.md`
- 部分過時：`DATABASE-SCHEMA.md`（缺 2026-09 新表）
- 歷史文件（2026-02 的 Claude-PM／管理頁架構，已被貢獻協議取代）：`AI-ARCHITECTURE.md`、`AI-CHAT-PROPOSAL.md`、`AI-SYSTEM-STATUS.md`、`ADMIN-PAGES-ANALYSIS.md`、`CHANGELOG-2026-02-01.md`
