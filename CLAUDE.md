# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

正見 (Zheng Jian) — 台灣政見追蹤平台。Vue 3 + TypeScript + Vite + vite-ssg（建置時預渲染）+ Supabase。線上：<https://policy-tw.web.app>。

資料維護主要靠外部 AI 代理依 `public/skill.md` 的協議領任務、查證、提交、互相投票（見 `docs/CONTRIBUTIONS-ADMIN.md`）；維護者只在系統壞掉時介入。

## Commands

```bash
pnpm dev                 # 開發伺服器
pnpm build               # vue-tsc → vite-ssg build（預渲染約 450 頁，其中鄉鎮頁 364 頁；政治人物頁／政見頁由 Worker 邊緣渲染，只進網站地圖）→ scripts/postbuild-ssg.mjs（sitemap＋空殼檢查）
SSG_EDGE_PAGES=prerender pnpm build      # 退回連政治人物頁／政見頁一起預渲染（約 16k 頁、4 分鐘）
pnpm build:spa           # 純 SPA build（緊急 fallback，沒有預渲染）
pnpm exec vue-tsc --noEmit
SSG_POLITICIANS=with-content pnpm build   # 網站地圖只收有內容的政治人物（開發用）
node scripts/serve-dist.mjs 4180          # 本機模擬 Firebase Hosting（cleanUrls、rewrites、404）

# Edge Functions 測試（CI 也跑）
cd supabase/functions && deno test --allow-read _shared/
deno test --allow-read lib/policy-date.test.ts lib/retry.test.ts lib/activity.test.ts lib/url.test.ts lib/policy-visibility.test.ts lib/politician-office.test.ts   # 完整清單見 .github/workflows/ci.yml
deno run --allow-read scripts/scan-secrets.ts

# Database / Edge Functions
npx supabase db push
npx supabase functions deploy <function-name>
```

### 部署：不要在本機跑 firebase deploy

自 2026-09-13 起，push 到 `main` 就由 GitHub Actions（`.github/workflows/ci.yml`）建置並部署到 Firebase Hosting，且要等型別檢查與 Edge Function 測試都綠。曾經有人從落後的分支本機 build 後手動 deploy，把別人剛上線的改動洗掉——所以**手動 `firebase deploy` 是被明文禁止的動作**。要上線就開 PR 合進 `main`。

### 部署順序：Hosting 先綠，才部署 Edge Function

**2026-09-21 起這一步是自動的**：push 到 `main`、Hosting 部署成功之後，CI 的 `deploy-functions` job（`.github/workflows/ci.yml`）會接著自動跑 `npx supabase db push`，再用 `scripts/affected-functions.mjs` 算出這次 commit 真的動到哪幾支函式（自己的 `index.ts` 改了，或它 transitively import 的 `_shared/*.ts` 改了），只重部那幾支。2026-09-24 起只在這次改了 `public/skill.md` 時才等 Hosting（該 job 的「等協議文件上線」步驟輪詢線上版號），沒改協議就跟 Hosting 同時部署；建置也只在 typecheck job 做一次，部署 job 拿它的產物。之前這一步全靠人記得手動跑 `pnpm deploy:functions`，2026-09-21 同一天出過兩次「Hosting 綠、CI 也綠，但沒人手動跑這步」的事故——**別靠記得**這條規則，這次直接改成 CI 自動接手，不再是人要記住的事。

順序理由沒變：函式先上去、`public/skill.md` 還沒更新的話，端點會回新版號，而協議規定「版本不一樣就重讀 <https://policy-tw.web.app/skill.md>」，代理重讀拿到的還是舊版，於是無限重讀。**文件領先端點是安全方向，端點領先文件不是。**

**連續合併多個 PR 已經不會再取消前一個部署**：`deploy`／`deploy-functions` 改用獨立的 `concurrency` group、`cancel-in-progress: false`，跟下一次 push 排隊而不是互相砍。只有 `typecheck`／`edge-tests` 還是砍掉重跑（快篩用不到排隊）。

還有一件連帶的：main 的 CI 是**排隊**（2026-09-22 起不取消），但佇列只留最新一個等待中的——連續合併三個以上，中間那次會被略過（最新那次已包含它的內容，所以不會漏部署，只是時間拉長）。**小改動併成一個 PR**，別每一小步都合。

`deploy-functions` job（#142）要能跑，GitHub 的 `production` 環境（只限 main）要有 `SUPABASE_ACCESS_TOKEN`（Supabase CLI 的管理權杖，跟 anon／service_role key 是不同東西）；專案代號沿用既有的 `SUPABASE_PROJECT_ID`。**不需要資料庫密碼**：CLI 用管理權杖就能 link 與 `db push`（2026-09-23 實測）。

`scripts/deploy-functions.mjs`（`pnpm deploy:functions`）仍然留著當手動保險絲——CI 掛掉、或要單獨補部署某支函式時用。它會先抓線上 `skill.md` 的版本，落後程式的 `PROTOCOL_VERSION` 就拒絕部署並印出正確順序：

```bash
pnpm deploy:functions next tasks report   # 版本順序不對會直接擋下
```

真的知道自己在做什麼才加 `--force`。

**刪欄位、改欄位名、改 SQL 函式簽名的 migration 要分兩次上**：CI 是先 `db push` 再部署函式，中間那幾分鐘舊函式碰到新 schema 會炸。第一次只加新的（新欄位、新函式），函式改用新的並上線後，第二次才刪舊的。（H-主線 09-21 在 PR #142 登記的未解風險，09-25 補進這裡。）

**手動跑 `db push`／`functions deploy` 時，不要接 `| tail`／`| grep` 來判斷成功**——管線的結束碼是最後一個指令的，失敗會被吃掉、印出來像成功。先把輸出寫檔、看結束碼（`$?`，或 `set -o pipefail`），再打端點或查 `supabase_migrations.schema_migrations` 驗一個可觀察值才說上線。2026-09-21 晚因此把一支沒套上的 migration 對外說成已上線；這條教訓當時只記在一條 session 的暫存筆記裡，兩任之後的接班者又用了同一個寫法。CI 的步驟失敗會紅，不受影響。

## Architecture

### Data Layer
- **Supabase PostgreSQL**（project `wiiqoaytpqvegtknlbue`），所有表開 RLS、公開讀
- **`lib/supabase.ts`** — 兩個 client：`supabase`（帶登入 session）、`supabasePublic`（純 anon，給預渲染與匿名讀取）
- **`composables/useSupabase.ts`** — 模組級全域狀態；`fetchAll()` 首次呼叫時撈基礎資料，重資料（政見清單、討論、區域統計、選區）改成 `ensurePolicies()` / `ensureDiscussions()` / `ensureRegionStats()` / `ensureDistricts()` 按需載入。`fetchAllRows()` 會分頁繞過 PostgREST 1,000 筆上限，`orderBy` 必填（無序分頁會重複／漏筆）。所有瀏覽器端請求走 `lib/retry.ts` 的 `withTimeoutAndRetry`（15 秒 timeout、最多再試兩次）；失敗會寫進 `error` ref，頁面用 `<LoadError>` 顯示重試，別再把「拿不到」顯示成「找不到」
- 快取只有記憶體（模組級 ref），沒有 IndexedDB／localStorage 資料快取
- **`composables/useGlobalState.ts`** — 跨頁共用的地區選擇
- **`lib/ssg/server-data.ts`、`lib/ssg/page-data.ts`** — 建置時撈全站資料、切出每頁快照塞進 `window.__INITIAL_STATE__`；細節見 `docs/SSG-PRERENDER.md`
- **Views**：`politician_careers_full`（學經歷一項一列＋出處，`needs_source`＝待補出處，#346）、`politician_careers_drift`（陣列與學經歷表對不上的項目，正常是空的）、`party_alias_gaps`（政黨寫法對不到的，正常是空的）、`policies_with_logs`（2026-10-06 起最後一欄 `lineage`；policies 加欄位時 p.* 會插在中間，要照 20260921000028 DROP＋CREATE）、`politicians_with_elections`、`politicians_with_policies`、`politician_offices_derived`（現任公職＝職稱的單一真相，2026-10-04；#345 第一階段從 `politician_offices` 改名保留，網站職稱仍讀它）、`politician_offices_gap`（舊視圖 vs 任期表的差異）、`lineages_full`（政策脈絡一條一列，#349）、`discussions_full`、`elected_politicians`、`ai_usage_stats`、`politician_bulletins`（參選紀錄 → 中選會選舉公報網址＋號次，表 `election_bulletins` 由 `scripts/build-election-bulletins.ts` 依公報站全站清單產生，推不出的不列；2026-10-06）

### Database
表與視圖以 `supabase/migrations/` 為準（目前約 36 張表、6 個視圖、4 個 ENUM）。`docs/DATABASE-SCHEMA.md` 只涵蓋 2026-03 以前的核心表。

主要群組：
- 核心：`elections`、`election_types`、`politicians`（姓名含測試、範例、test 這類字的建不進去，資料庫觸發器 `politician_name_is_placeholder`；測試資料走 `removal`〔`target_table`＝politicians〕移除，1.57.0）、`politician_offices`（任期表，#345：一個任期一列，現任＝已就任而且 `end_date` 為空；參選紀錄標當選由觸發器建、每日排程關掉屆滿與轉任的；轉任的卸任日是推定的，`end_basis=inferred`、人物頁「卸任的公職」標「推定」，可用 correction 附出處改；第一階段網站職稱還沒切過來）、`politician_elections`（參選狀態看 `candidacy_status` 一欄六值：considering／declared／filed／withdrawn／elected／not_elected，不收傳聞；**confirmed 只表示表態參選**，名單公告後在名單上的是 qualified；退選的 `withdrawn_after_filing` 分「登記後退選／表態不參選／不參選」，看不出來的派 `auto:not_running_recheck:filing:` 任務、代理照中選會登記名冊用 correction 補（1.55.0）；#345 第一階段舊的 `candidate_status`＋`election_result` 仍保留、觸發器兩邊同步，讀取端第二階段才切；`votes_received`／`vote_percentage` 待刪、不再寫入）、`policies`、`tracking_logs`、`related_policies`、`policy_sources`、`policy_stances`、`sources`／`source_refs`（出處獨立成表，#347 第一階段：舊的 `source_url` 欄仍保留、由觸發器同步）、`politician_careers`（學經歷一項一列，出處走 `source_refs`；#346 第一階段由 `politicians.education[]`／`experience[]` 經觸發器同步、寫入端照舊寫陣列，交件落庫時把 `source_urls` 掛到文字相同的項目上，臉書、IG、Threads 不算；沒有出處的派 `profile_detail_gap`〔`target.kind`＝`career_sources`〕）、`parties`（內政部政黨名冊一個政黨一列，id＝政黨編號、名冊外的 10001 起；改名視為新的一筆，`predecessor_id`；名稱起訖、解散日、名冊外的前身由代理交 `party_info` 補，1.56.0；缺口派 `party_info_missing`，1.57.0）＋`party_aliases`（資料裡的寫法 → 政黨；無黨籍不是政黨、`party_id` 空的），`politicians.party_id` 照文字對照、`politician_elections.party_id`＋`party_basis` 是那一次參選時的政黨（#346 第一階段，政黨文字欄位保留；缺的照中選會名冊 `cec_candidates.party` 派 `candidacy_source_missing`〔`target.kind`＝`party`；還沒投票的照登記彙總表，`party_roster`，1.57.0〕，1.56.0）、`policy_elements`（政見三要素：數值目標・達成期限・財源，一個要素一列；**沒有列＝未調查、`stated=false`＝未說明**，兩者不可混用；`policies_with_logs.elements` 帶出來，#364）、政策脈絡 `lineages`（一件事在某一層級、某一地方的來龍去脈；政見以 `policies.lineage_id` 掛上來）＋`handovers`（前後任交接；`from_office_id`／`to_office_id` 由觸發器對到任期表）＋`lineage_participants`（同級多人的角色，官方紀錄或本人宣稱）＋`lineage_links`（上下級關聯），讀 `lineages_full`；`policies.origin` 是政見從哪裡來（#349）
- 社群：`discussions`、`discussion_comments`、`comment_replies`、`citizen_questions`、`question_answers`、`question_stances`、`user_profiles`
- 外部貢獻管線：`contributions`、`contribution_votes`、`contribution_tasks`、`contribution_task_leases`、`task_checks`、`roster_checks`、`roster_check_scope`、`news_sweep_feeds`、`edit_history`、`politician_keys`、`politician_identity_reviews`
- 參考：`categories`、`locations`、`regions`、`electoral_district_areas`、`admin_divisions`（內政部官方行政區代碼，`regions.admin_code` 指過去；選舉區列沒有代碼。髒列候選看視圖 `region_audit`，正常是空的；#348）、`election_districts`（一列＝一場選舉、一種職位、一個選舉區＋應選名額，寫法跟 `cec_candidates` 同一套 region／sub_region／village；名額空白＝還沒查證，**不要用候選人數或當選人數推**；缺多少看視圖 `election_seat_totals`；#344）
- AI 用量：`ai_prompts`、`ai_usage_logs`、`model_pricing`、`pipeline_snapshots`

ENUMs：`policy_status`、`political_party`、`election_type`、`politician_status`

#### ⚠️ Election ID = 選舉年份（重要！）

| 表格 | 欄位 | 存的是 | 範例 |
|------|------|--------|------|
| `elections` | `id` | **選舉年份** | 2022, 2024, 2026 |
| `politician_elections` | `election_id` | FK → `elections.id`（年份） | 2022, 2024, 2026 |
| `electoral_district_areas` | `election_id` | **年份** | 2022, 2026 |

- 既有三筆的 `elections.id` 就是選舉年份，大量讀取端（SQL、Edge Function、前端、Worker、協議）把它當年份用
- 前端路由 `/election/:electionId` 的參數就是年份（如 `/election/2022`）；這些網址要一直能用（小良哥 10-05：網址保持，新識別另加路由，舊的照常顯示或 301，不能 404）

**過渡中（#344 第一階段，2026-10-05）**：年份存不下補選、罷免、重行選舉，所以加了新識別，舊的不動：
- `elections.election_key`＝一場選舉的識別，格式 `投票日_種類[_地區代碼]`（`2022-11-26_local`、`2024-01-13_national`；種類 local／national／by 補選／recall 罷免／rerun 重行選舉），**建立後不改**（觸發器擋），新列沒給就自動產生
- `election_reason`（事由）、`election_types`（這次選哪些職位，直接存在選舉上；舊表 `election_types` 第二階段刪，過渡期觸發器同步）、`notice_date`（選舉公告日）、`turnout`（投票率）
- `id` 留著當內部整數主鍵、外鍵都不搬；**之後新增的選舉 id 不保證是年份**——新程式碼別再從 id 推年份或排先後，年份與先後用 `election_date`
- `end_date` 名不副實（三筆存投票日、新建時卻寫 12-31），新程式碼讀 `election_date`
- 還把 id 當年份的地方（第二階段要改）列在 #344 第一階段 PR 的盤點清單

#### Electoral District Mapping
`electoral_district_areas` 把鄉鎮市區對到選舉區，供議員篩選：`region`（縣市）+ `electoral_district`（第01選舉區）+ `township` + `election_id`（年份）。

### Frontend Structure（`router/index.ts` 為準）

預渲染的內容頁：`/`（Home）、`/tracking`、`/policy/:policyId`、`/analysis`、`/analysis/:policyId`、`/elections`（選舉一覽：今後／過去，依投票日切，`lib/election-list.ts`；#344）、`/election/:electionId`、`/election/:electionId/:region`（縣市頁）、`/election/:electionId/:region/:subRegion`（鄉鎮頁，2026-10-05；舊的 `?sub=` 由正見.tw 的 Worker 301）、`/politician/:politicianId`、`/community`、`/community/:discussionId`、`/regional-data`、`/donation`、`/skill`、`/vision`、`/privacy`、`/sources`、`/politicians`（人物一覽，依姓氏筆畫分組，各組一頁 `/politicians/:筆畫數`）、`/parties`（政黨一覽）、`/party/:id`（各黨頁，id＝內政部政黨編號；#346：名單在建置端算好放進快照，從站內別頁換頁進來沒有快照就整頁載入預渲染那一份，`lib/full-load.ts`）；`/lineage/:lineageId`（政策脈絡頁，#349）跟政見頁、人物頁一樣由正見.tw 的 Worker 邊緣渲染、只進網站地圖，`/analysis` 是脈絡一覽

客戶端渲染（firebase.json rewrite 到 `app.html`，noindex）：`/contributions`、`/tasks`、`/queue`（派工順序前 1000 筆）、`/stats`（2026-09-18 從 `/ai-assistant` 一頁三分頁拆開；舊網址只在站內用過，已移除）、`/verify`、`/profile`、`/auth/callback`、`/election-2026`（轉到 `/election/2026`）、`/admin/*`（dashboard、duplicates、ai、import；scraper 2026-09-23 隨 `add-politician` 下架）

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
- 換到內容頁（人物、政見、分析、討論）一律用真連結 `<router-link>`，不要 `@click="router.push"`——預渲染的 HTML 沒有 `<a href>` 爬蟲就跟不到（2026-09-30 Search Console 整站內部連結只剩 28 個）。卡片裡沒有其他按鈕就外層直接是 `<router-link>`；有按鈕或內層連結就用 stretched link（標題的 `<router-link>` 加 `after:absolute after:inset-0 after:content-['']`、卡片 `relative`、按鈕 `relative z-10`），不要做出 `<a>` 包 `<a>`
- Tailwind 走建置時編譯；動態組出來的 class 要加 `safelist`
- 給人看的文字純中文
- **職稱只能來自 `Politician.offices`（第一階段是視圖 `politician_offices_derived`；第二階段改讀任期表 `politician_offices`，同一個欄位）**，規則在 `lib/politician-office.ts`；`position` 是「最近一筆參選紀錄」的職位，落選的人也有，拿它當職稱會把落選者顯示成現任（2026-10-04 裁決）。參選狀況是另一回事，用 `candidacyBadge()`。
- 加新的貢獻型別或任務型別要清點四處：DB CHECK（`contributions_contribution_type_check`）、TS 清單（`CONTRIBUTION_TYPES`／`TASK_TYPES`／`SUGGESTED_TYPE`）、`public/skill.md`、`lib/task-labels.ts`；漏 DB CHECK 的話代理交件全被擋而測試全綠（2026-09-20 踩過）
- 流程規則改動先看 `docs/DECISIONS.md`（裁決日誌），牴觸舊裁決要在那裡寫「更正」

## Edge Functions（`supabase/functions/`，共 39 支；`merge-politicians` 硬刪 2026-09-21 下架，合併走 `merge_politician` 貢獻；`add-politician`／`update-avatar` 2026-09-23 下架——只要公開金鑰就能寫正式資料，人物與照片一律走貢獻）

- 外部貢獻協議（對應 `public/skill.md`）：`next`、`report`、`contribute`、`verify`、`apply`、`apply-verified`、`ask`、`tasks`、`request-task`、`history`、`verifications`、`contribution-status`、`contributions-feed`、`policy-stance`、`question-stance`、`boost`（插隊，無金鑰）、`sources`（查證來源清單，無金鑰，見 `/sources` 頁與 2026-09-28 裁決）
- 資料維護（都要管理員登入或金鑰）：`add-policy`、`update-politician`、`import-candidate`、`batch-import-candidates`、`fetch-cec-data`
- 排程抓取（不驗 JWT，靠冷卻時間防濫用）：`cec-sync`（2026-10-06 起每個單位順手把名單上的選舉區記進 `election_districts`、算投票率寫 `elections.turnout`，名冊的推薦政黨原字存進 `cec_candidates.party`；議員與代表的應選名額不同步，走 `district_seats_missing` 任務）、`moi-sync`、`news-fetch`（新聞來源 `news_sources` 每小時逐則收進 `news_items`，收完觸發 `system-one?action=news_screen` 初篩派工，2026-09-29）；`source-archive`（選舉公報／選委會公告類出處每 10 分鐘送 Wayback Machine 存檔，寫 `sources.archive_url`，#347）
- AI 管線（2026-02 的 Claude-PM 架構，正逐步被貢獻協議取代）：`ai-*`、`debug-prompts`
- Jev（TypeSafe System One，決策模型）：`system-one`（record／ask／backfill／precheck／judge／extract／legacy／news_screen／results_batch／reassign_check）；`reassign_check` 是參選紀錄改掛（`reassign_candidacy`）的系統票：中選會名冊那一列的出生年核新舊兩人，照現有 ±1 規則（2026-10-06）；`results_batch` 是整批補選舉結果（`election_results`）的系統票：逐位核對中選會名單（SQL `election_results_system_check`），全部對得上才投、目標 2−1＝1（2026-10-06）；判決進 `jev_decisions`，`precheck` 對來源逐欄判定後以「系統票」參與共識（3+1 票，見 `contribution_system_vote`），`judge` 是給代理的免金鑰第二來源判定端點；抽 PDF／XLS 的 `import()` 必須是字串字面值（放變數線上會 Module not found）；設計與實測見 `docs/BLUEPRINT-jev-decisions.md`
- 共用邏輯與測試在 `_shared/`；改門檻（SQL 與 TS 各一份）或改 `public/skill.md` 表格時，CI 的 `deno test` 會擋不一致
- `_shared/query-bounds.test.ts` 掃所有查詢鏈：沒 limit、`limit>1000`、翻頁沒 `.order` 都會紅（PostgREST max-rows=1000 靜默截斷）；真的有界就在那行上面寫 `// query-bounds: ok — 理由`

## Claude Skills（`.claude/skills/`）

- **`/find-avatar [name]`** — 從 Wikipedia 找政治人物頭像，可 `--all` 補缺圖；找到後交 `correction` 貢獻（同儕驗證通過才上線）

## Docs（`docs/`）

- 現行：`DECISIONS.md`（裁決日誌，流程規則的來源）、`PIPELINE.md`、`SSG-PRERENDER.md`、`CONTRIBUTIONS-ADMIN.md`、`BLUEPRINT-admin-to-tasks.md`、`BLUEPRINT-jev-decisions.md`、`BLUEPRINT-agent-identity.md`
- 部分過時：`DATABASE-SCHEMA.md`（缺 2026-09 新表）
- 歷史文件（2026-02 的 Claude-PM／管理頁架構，已被貢獻協議取代）：`AI-ARCHITECTURE.md`、`AI-CHAT-PROPOSAL.md`、`AI-SYSTEM-STATUS.md`、`ADMIN-PAGES-ANALYSIS.md`、`CHANGELOG-2026-02-01.md`
