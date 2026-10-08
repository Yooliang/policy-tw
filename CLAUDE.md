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
deno test --allow-read lib/ cloudflare/   # 前端純函式；整個資料夾，新的 *.test.ts 不用登記（.github/workflows/ci.yml 同一行）
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

## 主線工作守則（2026-10，接手先讀）

維護者的常設裁決，細節與理由在 `docs/DECISIONS.md`；進度總表 issue #332（選前）、#351（兩站比較 35 項）。

- **資料走流程**：正式資料只能經代理貢獻＋驗證上線。看到資料缺口，不寫 migration 直接補、也不問維護者「要不要補」，去補「為什麼流程沒帶進來」（派工臂、同步排程、交件守門）。只有流程規則本身（門檻、協議、計分）要他裁；改計分合併後要通知日本站（policy-jp）跟著改。
- **讓資料自己說話**：讀者看的頁面不放解釋規則、排序方式、方法論的說明文字；保留標籤（未說明／未調查／推定／結果待補）與出處連結。規則寫進 DECISIONS，不寫在畫面上。
- **網址保持、內容頁可收錄**：改結構時舊網址照常可開或 301，不能 404；內容頁 canonical 指正見.tw。政見 PK 不是正文、不收錄（只在瀏覽器端畫）。
- **子代理**：一律明寫 `model: sonnet`（純機械小改可 haiku）；opus 只用在高風險且要先問維護者。並行數不設上限（10-08 維護者取消），但要顧本機資源：平時只跑相關測試，完整 `_shared/` 推送前跑一次、同時最多一個（先 `tasklist | findstr deno`）。小改動交給已在跑的子代理追加，不另開。小型 UI 改動不要截圖，CI 綠就合併上線，請維護者自己看線上。
- **待辦與排程（2026-10-08）**：功能類開在本 repo 的 issue、維運類（營收、廣告、站務）開在私人 repo `Yooliang/policy-ops` 的 issue；排程與進度在本 repo **#459**。需求先開 issue、排序再依序派，**不是收到就派**；會動同一批檔案（`contribution_auto_tasks_arms()`、`seed_auto_task_queue()`、同一支臂、`contribute-handler`）的工作同時只派一件，其他可並行。派工前先 `gh pr list` 與 ListAgents 看有沒有別的工作階段（含雲端）已在做。migration 時間戳由主線配號，避免並行 PR 撞號。
- **同儕審查與合併（2026-10-08）**：每個 PR 合併前先審。agy（Antigravity CLI）一次只跑一個、40 分鐘上限；大 PR 或安全相關的改用 `feature-dev:code-reviewer` 子代理（sonnet）。成立的意見退回原子代理修；CI 綠就依 migration 時間戳由小到大合併。前一個 PR 被 squash 後，堆疊在它上面的分支用 `git rebase --onto origin/main <前一個的舊頭>` 再推，PR base 一律設 main（否則前一個合併刪分支時會被自動關閉）。主線每 30 分鐘一輪推進（收結果→審查→合併→依 #459 派下一件→自問缺口、流程、優化）；交接檔在 policy-ops `docs/handoff/`。
- **日本站資料（2026-10-08）**：日本站的資料在同一個 Supabase 的 `policy_jp` schema（已開放給 PostgREST；`ditrust` 絕不開放）。日本站的 migration 也放本 repo、由主線審合，檔名帶 `_jp_`；不准碰 `public` 與 `ditrust`。
- **協議版號與 migration 時間戳**：並行的 PR 很容易撞號。合併前以 main 為準：協議版號比 main 大一號、migration 時間戳大於遠端最新一支（`supabase_migrations.schema_migrations` 的 max；`db push` 不收比遠端還早的）。疊在別的 PR 上的分支：先 `gh pr merge <子> --merge` 進母分支，再 squash 母 PR；或子 PR 的 base 就是 main 時直接 `--merge`。
- **派工佇列（2026-10-08 起「加推自動化」）**：驗證與任務在同一條時間軸（`task_dispatches.queue_at`），**驗證：任務＝2:1**（驗證每筆 1 秒、任務每筆 2 秒，`rebalance_queue()` 隨 `seed_auto_task_queue()` 每 10 分鐘重排）。任務排哪一層由 `activity_rules` 的優先層決定（`priority`，活動名 `priority:…`，層與權重種子在 `task_priority_tiers`：前段＝投票日前 180 天內、中段＝預設〔含公報上架前的非縣市長 policy_missing〕、後段＝投票日後 181 天起的歷史補資料；權重 6:3:1，後段永遠保有 1/10 不會餓死；層與規則只走 migration）。同一層內先進先出；**手動插隊（`/boost`，`queue_at` 1980 年段，第 n 次加推＝1980 減 n 分鐘）仍然最前面、一次性**，領走就回到自己那一層的隊尾——要長期偏向某一群，改優先層規則，不要反覆插隊。**open 的手動任務（`contribution_tasks`）是派工臂 `manual_visitor`（網站請求 `source=web_request` ＋公民提問 `task_type=question`）與 `manual_open`（其餘）**（2026-10-08，協議 1.77.0）：`task_id`＝任務 uuid，seed 每 10 分鐘寫進 `task_dispatches`，任務一關閉觸發器立刻收回；`/next` 只讀佇列（`contribution_queue_tasks`，`contribution_auto_tasks` 的複本，多回手動任務；`/tasks`、`/request-task` 仍用只回自動缺口的 `contribution_auto_tasks`），選中手動任務才用 id 單筆查描述。`queue_at`：網站請求與公民提問新進＝1970-01-01（比任何加推都早）、`priority:manual_visitor` 規則放前段；維護者建的與裁決新進＝1980；提議排隊尾；派出後都跟其他缺口一樣回隊尾。**固定時段插隊**：台北 00:00、06:00、12:00、18:00 各前 20 分鐘內跑的 seed（`manual_front_pull()`）把網站請求與公民提問中「從沒派過或最後派出早於本時段開始」的拉回 1970，時段內第二次 seed 冪等，其他時段不動；時段定義是 SQL 函式 `visitor_front_slot_hours()`／`visitor_front_window_minutes()`／`visitor_front_slot_start()`，假時鐘 `SET app.queue_now`。手動任務臂的 task_id 沒有 `auto:` 前綴，所以缺口出生／收回觸發器、seed 的收回都改成「不是 `verify:`」。**已收滿答案的公民提問不是缺口**（任務本身永遠 open，不排除會佔住隊頭而 `/next` 前 30 筆全被濾掉回 none；滿額定義同 `fullQuestionIdsOf`：`answer_count`＋同一題底下在等票的答案 ≥ `question_answer_cap()`＝3，SQL 與 TS 兩份由 `manual-open-arm.test.ts` 對齊）；新建（或重開）的手動任務由觸發器 `contribution_tasks_insert_dispatch` 即時入列、seed 只對帳；貢獻 applied 時 `task_dispatches_drop_applied` 即時收回「補完就關」的手動任務（判斷同 `shouldCloseOnApplied`；一題多份的 question／adjudicate／roster_check 不收）；`/next` 的 `open_tasks` 讀 `contribution_queue_task_counts()`；隊頭手動任務併發失效就跳過往下挑；`task_boost_matches` 不再另算 `contribution_tasks`（總表已含）；`activity_health` 抓得到 `app.queue_now` 假時鐘（`queue_clock_overridden`）。新增派工臂或改窗口時，要想過它在哪一層（沒有選舉的臂＝預設層）。守門 `queue-priority.test.ts`、`manual-open-arm.test.ts`；規劃見 `docs/PLAN-task-activation.md` 第 11 節。
- **頁面流量提層（2026-10-08）**：人物頁（`/politician/<uuid>`）、政見頁（`/policy/<uuid>`）近 7 天不重複訪客 ≥ 5，名下的缺口任務在 seed 時從原層提到前段（`min(原層, 前段)`，不改 `activity_priority()`）；流量退了、資料超過 24 小時沒更新，下一輪 seed 自動回原層，所以效果有時效、不是永久。另有一條上限：被提層後 14 天內提層的任務上都沒有「有產出」的交件〔型別不是 `no_change`／`task_suggestion`、狀態不是 `rejected`；查無與冷卻不算〕，就暫停提層 14 天，期滿重新計時。流量來源：`console-fetch` 每小時多抓一份 GA4（台灣站、`pagePath`、`totalUsers`＋`screenPageViews`），經 service_role RPC `replace_page_traffic` 整批覆寫 `page_traffic`（公開唯讀）。**所有參數在單列表 `traffic_boost_settings`，函式裡沒有寫死的數字**（`window_days` 7、`min_users` 5、`boost_tier` 1、`no_yield_days` 14、`pause_days` 14、`stale_after_hours` 24、`enabled`）；**改值＝一行 migration 的 `UPDATE traffic_boost_settings SET min_users = 8, note = '…' WHERE id = 1;`**（走 migration，與優先層規則同一個慣例；每次修改由觸發器 `activity_audit` 寫進 `edit_history`〔agent_name＝activity-audit〕；改 `window_days` 後到下一次 console-fetch〔≤ 1 小時〕之前，舊窗口的數字不採用，提層暫時退回原層）。狀態在 `page_traffic_boosts`、現況視圖 `page_traffic_boosted_tasks`、達標頁視圖 `page_traffic_hot`（以後想用同一個流量訊號為村里長等預設不追蹤的類別開窗，就讀這個視圖；這次沒做）。守門 `page-traffic-boost.test.ts`、`page-traffic.test.ts`。
- **村里長不主動追進度與補該屆政見、查無公開進度冷卻遞增（2026-10-08，#470，協議 1.80.0，migration `20261009010000`，守門 `village-progress-cooling.test.ts`、`scripts/arms-parity-villages.ts`）**：村里長只收政見與結果。①`raw:progress_stale`、`deadline_due`、`term_policies`（補該屆政見 `term_policy_missing`，維護者追加）的規則（P1 種子，id 5、24、36）加 `activity_rules.except_election_types`＝{村里長}（排除欄，職位未知時不排除；與 `election_types` 二選一）；這兩支臂的 target 沒有職位，總表 keyed 對「有規則要看職位的臂」從 `politician_elections`（人物×`target.election_id`）補，補不到的維持開著。收回記 `window`。②村里長的人物頁或政見頁在 `page_traffic_hot`（#474）達標才開：同一活動另有一條「村里長、永遠開、`requires_traffic`」的規則（`activity_rules.requires_traffic`），總表在列層再問 `politician_id`／`policy_id` 是否在 page_traffic_hot，開著的列 `opened_by.traffic_gate`＝true；`activity_open` 簽名不動。網站請求、公民提問是手動任務臂，不受影響。村里長的 2026 補政見 `policy_missing`、補基本資料、選舉結果不受影響。③進度追蹤類（設定表 `task_cooldown_settings.task_types`，初值 progress_stale、deadline_due）同一個任務第一次 `not_found` 冷卻 `not_found_first_days`（14）天、第二次起 `not_found_repeat_days`（30）天，其他任務型別、其他 outcome 一個字不變；函式 `task_check_cooldown_days_for()`，`refresh_dispatch_blocked` 與標籤共用（回給代理的句子在 `apply-contribution.ts` 寫死型別清單 `PROGRESS_COOLDOWN_TASK_TYPES` 與天數，改設定表型別名單或天數要一起改）。④視圖 `policies_with_logs.no_public_progress`（函式 `policy_no_public_progress(政見 id)`）＝缺口還在派工列、而且有一筆 not_found 還在冷卻內；政見頁與人物頁的政見卡只讀這一欄、只放標籤「查無公開進度」。今天正式庫沒有村里長的進度追蹤任務（0 件），`term_policy_missing` 村里長 300 件在下一輪 seed 收回。
- **seed 與 rebalance 不重寫沒變的派工列（2026-10-09，#465）**：`seed_auto_task_queue()` 的內容 UPDATE 加了條件，`task_type`、`target`、`what_we_need`、`hint_sources`、`reward`、`region` 任一欄真的變了才寫（列比較 `IS DISTINCT FROM`，NULL 安全；不要改成 `<>`）；`rebalance_queue()` 三段 `UPDATE queue_at` 各加「位置真的變了才寫」，回傳值變成「真的改了位置的列數」（沒有呼叫者讀它）。起因：正式庫唯讀實測既有的 8,183 列派工列內容 0 列有變，卻每 10 分鐘整列重寫一遍（`task_dispatches` 累計 2,000 多萬次更新、HOT 只有 15%）；`task_dispatches` 上沒有 UPDATE 觸發器（只有 INSERT 前後與 DELETE 後三個，只管 `auto:` 列的 opened／closed），所以這個改動不影響 `gap_events`。**`task_dispatches.refreshed_at` 的語意改成「內容最後一次被改寫的時間」**（以前每輪全表同一個值，等於沒有資訊）；沒有任何程式讀它（正式庫 `pg_proc`／`pg_views` 與 repo 的 TS／Vue／Edge Function 都查過，守門 `seed-skip-unchanged.test.ts` A6 掃著），要看 seed 有沒有在跑看 `cron.job_run_details`。`rebalance_queue()` 的位置是「起點＋名次」的絕對值：活躍時段只要有一筆被領走或新增／收回，後面的名次整批位移（唯讀實測當下參與重排的 13,116 列全部位置有變），所以這一半主要在沒有領取、缺口也沒變動的時段才省得到寫入；要在活躍時段也省，得改成相對順序，那會動到 `queue_at` 的數值，另開。**往 seed 的內容 UPDATE 加欄位時，條件也要同步加**（`seed-skip-unchanged.test.ts` A5 擋）。守門 `seed-skip-unchanged.test.ts`；正式庫快照 parity 與耗時：`scripts/seed-skip-parity.sql`＋`seed-skip-parity.ts`（不進 CI）。
- **派工憑證（2026-10-08，協議 1.81.0，#484）**：`/next` 派出的那一筆（驗證、手動任務、自動缺口）簽一張 `dispatch_token`（HMAC-SHA256 無狀態，`_shared/dispatch-token.ts`；綁 task_id、派出時間、自報代號、領任務當下的來源網段雜湊；30 分鐘＝`LEASE_MINUTES`）。`/report`（與 `/verify`、`/contribute`）帶了就只驗憑證、不看 IP，解 `GET /next` 與 `POST /report` 跨網段的 409 `not_dispatched`（#482 的 /24 只解同網段）；沒帶照舊；帶了無效回 403 `invalid_dispatch_token`（`reason`：expired／task_mismatch／bad_signature／malformed／no_secret），不退回網段比對。**憑證通過時這一票的來源記領任務的網段**，所以一張憑證只換一票、去重不被繞過；其他規則（至少兩個來源、自己不能驗自己〔兩個網段都比〕、額度）照舊。鑰匙 `DISPATCH_TOKEN_SECRET`，沒設退回 `SUPABASE_SERVICE_ROLE_KEY`（不需要新增 secret）；不寫資料庫、不加欄位、不碰 `/next` 的清單查詢。追查只看 Edge Function log：`dispatch_token_issued`（派出）與 `dispatch_binding`（`binding`＝token／ip／none，task_id、代號、憑證識別碼前 8 碼、領取與回報網段雜湊前 8 碼，不記原始 IP 與憑證原文）。同一個 PR 收掉 #482 的過渡期小洞：`contribution_verify_pool` 多 `p_legacy_ip_hash`（`20261009060000`），自交排除新舊雜湊一起比。撤回（`kind:"withdraw"`）也收憑證（驗 task 相符後用憑證裡的網段認本人）；過期憑證可帶 `revise:true` 改自己那一來源已投的票；鑰匙太短（< 16 字）當沒設、兩個都不能用時 `/next` 冷啟動 `console.warn`。守門 `dispatch-token.test.ts`、`dispatch-token-entry.test.ts`（真的載入入口跑端到端，`entry-harness.ts`）、`verify-pool-legacy-hash.test.ts`；決策與殘餘風險見 `docs/DECISIONS.md`。**⚠️ 手動部署順序（CI 本來就是先 `db push` 再部署函式）：migration `20261009060000` 必須先上，再部署 `next`**——`next` 在 IP 認得時會多傳 `p_legacy_ip_hash`，驗證池還是舊的四參數版本時 rpc 會回 PGRST202（找不到函式）；反過來（migration 先、舊 `next` 後）安全，因為新函式的前四個參數與預設值不變。
- **派工紀錄定時清理（2026-10-09，#485）**：`verify_dispatches`（誰被派了哪一筆待驗證）保留 14 天、`contribution_task_skips`（skip 紀錄，沒有任何程式讀它）保留 7 天，pg_cron `dispatch-records-purge` 每天 UTC 19:50 呼叫 `dispatch_records_purge()`（分批、`FOR UPDATE SKIP LOCKED`）。**保留天數必須大於程式最長回看期**：`/next` 每台機器 2:1 看 `MACHINE_LOOKBACK_HOURS`＝3 小時、驗證池 15 分鐘、`dispatch_recent` 上限 4 小時、派工綁定（沒帶憑證時）`VERIFY_BINDING_DAYS`＝7 天（兩個常數在 `_shared/dispatch.ts`；綁定的時限以前沒有，現在明寫並在 `verify-handler` 的查詢加 `.gte`）。參數在單列表 `dispatch_records_settings`（`verify_dispatches_days`、`task_skips_days`、`batch_size`、`max_batches`、`enabled`；改值＝一行 migration 的 `UPDATE`，每次修改進 `edit_history`；欄位 CHECK 有下限）。**新增任何讀這兩張表的程式或 SQL，一定要有時限**；守門 `dispatch-records-purge.test.ts` 會從原始碼與 migration 抽每一處回看期（SQL 只取每支函式的最後一版），沒時限、抽不出時限、或保留天數 ＋ 1 天不夠都會紅。理由與第一次刪除量見 `docs/DECISIONS.md` 2026-10-08 最後一條。
- **量效能先實測**：`pg_stat_statements` 是從很久以前累計的，平均值會混進已經改善掉的舊查詢。下結論前用唯讀 `EXPLAIN ANALYZE` 實際量一次（10-06 曾因此誤判派工查詢 2.6 秒，實測 2 毫秒）。量派工臂別只量 `SELECT count(*) FROM 臂()`：沒被用到的輸出欄位會被修剪掉（owner_mismatch 量出 480 毫秒、實際在總表裡 1,208 毫秒），要把全部欄位加總；測帶陣列參數的 SQL 函式（例：`election_result_cec_matches(ids[])`）的新寫法，要用 `SET plan_cache_mode = force_generic_plan` ＋ `PREPARE` 模擬：函式本體用「參數值未知」的計畫跑，陣列長度估成 10 筆，直接內嵌成子查詢量不準（10-08 一個改成雜湊連接的寫法，換成未知參數的計畫後超過 20 秒，原本逐列走索引的寫法 0.3 秒），並加 `SET statement_timeout` 當保險。
- **唯讀查正式庫**：`npx supabase db query --linked -f <檔>`，檔案第一行 `SET default_transaction_read_only = on;`。migration 用到的既有欄位先這樣確認存在（10-05 出過引用不存在欄位、正式庫失敗擋住整條部署）。
- **CI 卡住先看 GitHub 狀態**：工作沒有紀錄、排隊 15 分鐘被取消，多半是 GitHub Actions 事故（https://www.githubstatus.com），等恢復後 `gh run rerun`，不要改程式。
- **相關站台與機器**：日本站「政策の系譜」policy-jp.web.app（repo `Yooliang/policy-jp`，P-日本負責；舊名 keifu）、站務主控台 policy-console.web.app（私人 repo `Yooliang/policy-console`，GA4＋AdSense；舊名 site-console。**分工（2026-10-08）：GA 只在這裡跑、AdSense 只在 GitHub 跑**——GA4 抓取在本 repo 的 Edge Function `console-fetch`，pg_cron 每小時第 17 分叫，呼叫憑證由 migration 自己產生在 Vault（`console_fetch_cron_secret`），函式用 RPC `console_fetch_cron_secret_ok` 驗，只需設一個 secret `GCP_SA_KEY`（服務帳號 JSON，GA 與 Firestore 共用），見 migration `20261008030000_console_fetch_cron.sql`；`console-fetch` 完全不碰 AdSense（不讀 `ADSENSE_*`、不呼叫、`meta/status` 只用 updateMask 寫 `updatedAt` 與 `sources.ga-*`，守門在 `console-fetch-wiring.test.ts`），AdSense 由 policy-console 的 GitHub Actions `fetch.yml` 每小時第 17 分抓、只寫 `adsense/*` 與 `meta/status` 的 `sources.adsense.*`，兩邊寫的欄位不重疊）、驗證 VM `policy-verifier`（專案 greenshepherdcomtw，金鑰在 policy-tw 的 Secret Manager `verify-vm-*`，目前由工作機 P-工作機開輪）。**驗證 VM 腳本與交接文件在私人 repo `Yooliang/policy-ops`**（該 repo 的 `scripts/verify-vm/README.md` 是操作手冊）。三個 Firebase 網站都在 Firebase 專案 policy-tw，部署一律 `--only hosting:<site>`。

## Architecture

### Data Layer
- **Supabase PostgreSQL**（project `wiiqoaytpqvegtknlbue`），所有表開 RLS、公開讀
- **`lib/supabase.ts`** — 兩個 client：`supabase`（帶登入 session）、`supabasePublic`（純 anon，給預渲染與匿名讀取）
- **`composables/useSupabase.ts`** — 模組級全域狀態；`fetchAll()` 首次呼叫時撈基礎資料，重資料（政見清單、討論、區域統計、選區）改成 `ensurePolicies()` / `ensureDiscussions()` / `ensureRegionStats()` / `ensureDistricts()` 按需載入。`fetchAllRows()` 會分頁繞過 PostgREST 1,000 筆上限，`orderBy` 必填（無序分頁會重複／漏筆）。所有瀏覽器端請求走 `lib/retry.ts` 的 `withTimeoutAndRetry`（15 秒 timeout、最多再試兩次）；失敗會寫進 `error` ref，頁面用 `<LoadError>` 顯示重試，別再把「拿不到」顯示成「找不到」
- 快取只有記憶體（模組級 ref），沒有 IndexedDB／localStorage 資料快取
- **`composables/useGlobalState.ts`** — 跨頁共用的地區選擇
- **`lib/ssg/server-data.ts`、`lib/ssg/page-data.ts`** — 建置時撈全站資料、切出每頁快照塞進 `window.__INITIAL_STATE__`；細節見 `docs/SSG-PRERENDER.md`
- **Views**：`politician_careers_full`（學經歷一項一列＋出處，`needs_source`＝待補出處，#346）、`politician_careers_drift`（陣列與學經歷表對不上的項目，正常是空的）、`party_alias_gaps`（政黨寫法對不到的，正常是空的）、`source_refs_drift`（出處引用的完整性檢查：一條政見或進度有兩個以上的主要出處、引用指到已不存在的資料，正常是空的；#347 第二階段 B-2 起不再有新舊對照）、`policies_with_logs`（2026-10-08 起最後一欄 `no_public_progress`〔查無公開進度標記，#470〕，前一欄 `sources`〔出處清單，帶等級與存檔網址，#347〕，再前一欄 `lineage`；policies 加欄位時 p.* 會插在中間，要照 20260921000028 DROP＋CREATE）、`politicians_with_elections`、`politicians_with_policies`、`politician_offices_derived`（現任公職＝職稱的單一真相，2026-10-04；#345 第一階段從 `politician_offices` 改名保留；第二階段 A 起網站職稱改讀任期表，這個視圖只剩核對用；第二階段 B〔2026-10-07〕改看 `candidacy_status` 並暫留，2026 投票、結果補齊後才刪）、`politician_offices_gap`（舊視圖 vs 任期表的差異）、`lineages_full`（政策脈絡一條一列，#349）、`related_policies_uncovered`（舊互指裡兩條政見不在同一條脈絡的對，正常是空的；第二階段 B 刪 `related_policies` 前要先確認是空的，#349）、`discussions_full`、`elected_politicians`、`ai_usage_stats`、`politician_bulletins`（參選紀錄 → 中選會選舉公報網址＋號次，表 `election_bulletins` 由 `scripts/build-election-bulletins.ts` 依公報站全站清單產生，推不出的不列；2026-10-06）

### Database
表與視圖以 `supabase/migrations/` 為準（2026-10 約 70 張表、約 20 個視圖、4 個 ENUM）。`docs/DATABASE-SCHEMA.md` 只涵蓋 2026-03 以前的核心表。

主要群組：
- 核心：`elections`、`election_types`、`politicians`（姓名含測試、範例、test 這類字的建不進去，資料庫觸發器 `politician_name_is_placeholder`；測試資料走 `removal`〔`target_table`＝politicians〕移除，1.57.0；**2026-10-08 起測試名人物的任務只走 `placeholder_politician`**：派工總表 `contribution_auto_tasks_arms()` 統一把 target 任何地方出現測試名人物 id（整份 target 文字含人物 uuid，或 `politician_election_ids`／`politician_election_id` 含他的參選紀錄 id）的其他臂任務擋掉，`placeholder_politicians` 在優先層恆為前段〔規則 `priority:placeholder_politicians`〕；2026-10-08 盤點的殘留是 2024 台東縣立委「測試候選人ABC／XYZ／QQQ」三位，不要直接刪，等 removal 通過）、`politician_offices`（任期表，#345：一個任期一列，現任＝已就任而且 `end_date` 為空；參選紀錄標當選由觸發器建、每日排程關掉屆滿與轉任的；轉任的卸任日是推定的，`end_basis=inferred`、人物頁「卸任的公職」標「推定」，可用 correction 附出處改；第二階段 A 起網站職稱讀這張表，`politicians_with_elections.offices` 帶出來）、`politician_elections`（參選狀態看 `candidacy_status` 一欄六值：considering／declared／filed／withdrawn／elected／not_elected，不收傳聞；**confirmed 只表示表態參選**，名單公告後在名單上的是 qualified；退選的 `withdrawn_after_filing` 分「登記後退選／表態不參選／不參選」，看不出來的派 `auto:not_running_recheck:filing:` 任務、代理照中選會登記名冊用 correction 補（1.55.0）；#345 第二階段 A 起讀寫端都只認 `candidacy_status`；第二階段 B（2026-10-07）刪了舊的 `candidate_status`、`election_result`、`votes_received`、`vote_percentage` 四欄與雙向同步觸發器；交件的欄位名（協議）仍是 `candidate_status`／`election_result`，落庫時換算；退選旗標 `withdrawn_after_filing` 由觸發器 `politician_elections_withdrawn_flag` 維護；刪掉的票數備份在表 `politician_election_votes_archive`，沒有程式讀寫）、`policies`、`tracking_logs`、`related_policies`（#349 第二階段 A 起不再讀也不接受寫入，由政策脈絡取代；線上 0 列，第二階段 B 刪；互指沒被脈絡涵蓋的看視圖 `related_policies_uncovered`，正常是空的）、`policy_sources`、`policy_stances`、`sources`／`source_refs`（出處獨立成表，#347；**第二階段 A（2026-10-06）讀寫端已改用它**：政見頁、查核履歷、貢獻看板、任務現況讀它，落庫直接寫它〔`source_write()`〕，等級 official／self／media／other 由網域判斷、只有 `self`〔本人來源，要 `self_evidence`，社群與官方網域不行〕由交件的 `source_details` 決定，引用範圍含政見、進度、參選紀錄、學經歷、政黨等；舊的 `policies.source_url`、`tracking_logs.source_url`、`policy_sources` 與四支同步觸發器已在**第二階段 B-2（2026-10-07）刪除**（B-1 起程式與派工函式就不讀寫它們）：主要出處讀 `policy_primary_url(政見 id)`／視圖 `policies_with_logs.sources`，換主要出處走 `source_set_primary()`（correction 與履歷還原用，service_role），落庫只經 `source_write()`；交件當下登記公報網址由觸發器 `sources_register_contribution` 做；完整性檢查看視圖 `source_refs_drift`〔政見或進度有兩個以上主要出處、引用指到已不存在的資料，正常是空的〕，清單與理由見 `docs/DECISIONS.md` 2026-10-07。給代理的鍵名 `source_url`（任務現況、correction 的欄位名）是協議介面，值來自出處表）、`politician_careers`（學經歷一項一列，出處走 `source_refs`；#346 第一階段由 `politicians.education[]`／`experience[]` 經觸發器同步、寫入端照舊寫陣列，交件落庫時把 `source_urls` 掛到文字相同的項目上，臉書、IG、Threads 不算；沒有出處的派 `profile_detail_gap`〔`target.kind`＝`career_sources`〕）、`parties`（內政部政黨名冊一個政黨一列，id＝政黨編號、名冊外的 10001 起；改名視為新的一筆，`predecessor_id`；名稱起訖、解散日、名冊外的前身由代理交 `party_info` 補，1.56.0；缺口派 `party_info_missing`，1.57.0；只派網站上有人用到的政黨，10-06）＋`party_aliases`（資料裡的寫法 → 政黨；無黨籍不是政黨、`party_id` 空的），`politicians.party_id` 照文字對照、`politician_elections.party_id`＋`party_basis` 是那一次參選時的政黨（#346 第一階段，政黨文字欄位保留；缺的照中選會名冊 `cec_candidates.party` 派 `candidacy_source_missing`〔`target.kind`＝`party`；還沒投票的照登記彙總表，`party_roster`，1.57.0〕，1.56.0）、`policy_elements`（政見三要素：數值目標・達成期限・財源，一個要素一列；**沒有列＝未調查、`stated=false`＝未說明**，兩者不可混用；`policies_with_logs.elements` 帶出來，#364）、政策脈絡 `lineages`（一件事在某一層級、某一地方的來龍去脈；政見以 `policies.lineage_id` 掛上來）＋`handovers`（前後任交接；`from_office_id`／`to_office_id` 由觸發器對到任期表）＋`lineage_participants`（同級多人的角色，官方紀錄或本人宣稱）＋`lineage_links`（上下級關聯），讀 `lineages_full`；`policies.origin` 是政見從哪裡來（#349）
- 社群：`discussions`、`discussion_comments`、`comment_replies`、`citizen_questions`、`question_answers`、`question_stances`、`user_profiles`
- 外部貢獻管線：`contributions`、`contribution_votes`、`contribution_tasks`、`contribution_task_leases`、`task_checks`、`roster_checks`、`cec_registrations`＋`cec_registration_sources`（2026-10-08：中選會 115 年候選人登記彙總表九份解析成資料表，一列一位登記者，現行版合計 19,695〔縣市長 81、縣市議員 1,502、鄉鎮市長 465、鄉鎮市民代表 3,437、區長 16、區民代表 94、村里長 14,100〕；縣市議員（其餘 16 縣市）另收舊版 729644ff，只差一個字，標 `superseded_by`、算缺口看現行版 9ccb6224；公開唯讀；資料 migration 由 `scripts/gen-cec-registrations.ts` 產生〔同一個 parser、同一個抽字法 unpdf，逐份人數＝PDF 的登記日期列數，對不上整支失敗〕；異常列照收並在 `flags` 標記〔`name_empty` 21、`village_empty` 6〕；`system-one` 的 `roster_batch` 先查這張表、查得到不下載 PDF，查不到或列數對不上才讀 PDF；函式 `roster_registration_gap(屆別, 選舉別, 縣市, 鄉鎮)` 把某單位名冊上的人分成已有／要改狀態〔我們有同名但是 considering、withdrawn，用 correction 改〕／缺，「已有」的狀態判準 `candidacy_is_listed` 跟派工判準 `n_listed` 同一個條件，`/next` 的 `roster_check` 現況 `registration` 帶出來〔`ours` 也列出退選的〕；名冊逐位吻合的 `candidacy` 一次交件最多 150 筆〔`MAX_BATCH_ROSTER`，其他型別仍是 20；超過 20 筆時 `contribute-handler` 先用 `roster-batch-gate.ts` 查表逐位核對，有一筆對不上整批 400，協議 1.77.0〕；視圖 `cec_registration_totals` 各類人數、`cec_registration_drift` 列數對不上的〔正常是空的〕；名冊更新＝加新網址、新 migration，舊網址的資料保留；守門 `cec-registrations.test.ts`）、`roster_check_scope`（名單清查 `roster_check` 的重查判準，2026-10-08：最近一次回報的 `cec_count` 大於我們目前的名冊內人數（排除 considering、withdrawn，選後的當選／落選照算）就繼續派、不套 `recheck_days`，落差為 0 才套；嘗試冷卻照舊；守門 `roster-check-gap.test.ts`。**登記截止、名單公告、資格審查、抽號次、直轄市長名單公告五個日期欄是 `election_milestones` 的衍生快取，不能直接寫**〔觸發器 `roster_scope_derive_dates` 擋、`roster_scope_sync_from_milestones` 同步〕：改日期改里程碑那一列，新增一列清查範圍之前先建好里程碑〔`registration_close`、`list_published` 必有，`qualification_review`、`draw` 與直轄市長名單 `list_published`＋`election_type`＝`直轄市長` 可無〕，2026-10-08）、`news_sweep_feeds`、`edit_history`、`politician_keys`、`politician_identity_reviews`
- 參考：`categories`、`locations`、`regions`、`electoral_district_areas`、`admin_divisions`（內政部官方行政區代碼，`regions.admin_code` 指過去；選舉區列沒有代碼。髒列候選看視圖 `region_audit`，正常是空的；#348）、`election_districts`（一列＝一場選舉、一種職位、一個選舉區＋應選名額，寫法跟 `cec_candidates` 同一套 region／sub_region／village；名額空白＝還沒查證，**不要用候選人數或當選人數推**；缺多少看視圖 `election_seat_totals`；#344；議員、代表的名額走 `district_seats_missing` 任務，官方公告 PDF 登錄在 `verification_sources`〔`provides` 含 `seats`、`election_ids` 分屆〕並附進任務與 `district_seats` 驗證項，2026-10-09，協議 1.83.0）、`election_task_config`（一場選舉一列：`term_policy_missing` 對哪些職位的當選人派、這一屆開不開〔`enabled`〕、公報站的民國年；2022、2024 兩列開著、2026 一列預設關，11-29 起由 migration 或主線 `UPDATE ... SET enabled = true` 開；之後的屆別新增一列即可，不用改函式；2026-10-07）、派工時間窗 P0／P1（2026-10-08，規劃見 `docs/PLAN-task-activation.md`；**P1 起派工總表 `contribution_auto_tasks_arms()` 已經在過濾，P2 一臂一個 PR 把臂內寫死的日期條件搬成規則，派工輸出逐件不變：30 條仍是「永遠開」〔種子共 37 條：P1 的 36 條加 #452 新增的 `ballot_numbers`；已是窗口的 7 條＝選舉結果 2 條、`party_gap`、`party_roster`、`not_running`、`raw:candidate_status_stale`、`ballot_numbers`〕，選舉結果這組〔`election_results`、`raw:election_result_missing`，投票日 +1 起、無迄日；`elected_missing` 沒有日期條件、維持永遠開〕、`party_gap`〔投票日 +1 起、無迄日〕、`party_roster`〔只有迄點：到投票日當天為止，第一支有迄日的臂〕、`not_running`〔登記截止 +0 起、投票日 +0 止，起迄兩端都是規則，起點用每職位一列的 `registration_close` 里程碑；沒有該里程碑的舊屆別窗口永遠關，現行輸出本來就是 0〕與 `raw:candidate_status_stale`〔登記截止 +0 起、無迄日；raw 裡的一段，仍 INNER JOIN `roster_check_scope`，所以 2028 要開窗除了里程碑還要有 scope 的那一列〕2026-10-08 已搬，其餘各臂內部的日期條件還在臂裡；缺口收回的原因 `gap_events.reason` 分 `window`〔臂還算得出來、規則的窗口關了〕與 `filled`〔臂已經算不出來〕，做法是總表的交易內旗標 `gap.arms_all`〔預設不設；`on` 時多回傳被規則濾掉的列，`opened_by` 是 NULL，只有 seed 用〕**）：`election_milestones`（每場選舉×里程碑一列；投票日與任期起訖不存這張，併進視圖 `election_milestones_all`）、`activity_rules`／`activity_overrides`（規則只走 migration、覆寫要 reason）、函式 `activity_open()`／`activity_today()`，健康檢查看視圖 `activity_health`（正常是空的）；缺口出生紀錄：`task_dispatches.opened_at／opened_by` 加只增不刪的 `gap_events`（`task_dispatches` 的觸發器寫 opened／closed／reopened）；P1：總表每個 UNION 分支貼臂名（`arm`，28 個分支＝36 個活動名，`raw` 依任務型別拆成 `raw:<型別>`，清單在函式 `activity_arm_names()`），再過 `activity_open()`（沒有開窗的規則＝濾掉）；總表回傳多 `arm`、`opened_by` 兩欄，seed 把 `opened_by`（規則、里程碑、`expected_open_on`）寫進派工列、`gap_events` 抄過去；視圖 `gap_open_lateness` 是出生對帳（規則說該開與實際出生差 > 1 天，P1 全空）、`activity_health` 多一項 `arm_without_rule`。**新增一支派工臂要三處一起加**：總表加 `UNION ALL SELECT '臂名' AS arm, t.* FROM … t`、`activity_arm_names()` 加名字、`activity_rules` 種一條規則（漏哪一處，守門測試 `activity-arms.test.ts` 或健康檢查會紅；規則漏了，總表會 RAISE EXCEPTION 寫明是哪個臂、`seed_auto_task_queue()` 跟著失敗〔cron 失敗紀錄看得到，`task_boost_matches` 也會丟同一個錯〕，而不是缺口整批無聲消失；注意只有「連一列規則都沒有」才丟錯，規則存在但停用或窗口沒開是正常的關）；全站派工輸出改前改後的比對用 `scripts/arms-parity.ts`（正式庫唯讀快照，不進 CI；P2 改到臂本體的用 `scripts/arms-parity-p2.ts gen <步驟> <out.sql>`／`check <步驟> <snapshot.json>`〔步驟＝`election_results`、`party_gap`…，之前各步視為已上線〕，會把 migration 裡的新本體在正式庫上唯讀跑一遍再比；新本體在正式庫沒有多出任何列時腳本會明說「空對空」，窗口行為只靠 CI 合成資料測試守）；**搬一支臂的日期條件＝臂本體照現行定義做一處機械替換、規則原地 UPDATE（rule_id 不變）、守門測試對「緊接在前的那一版」做替換比對、假時鐘＋還原驗證**（樣板：`20261008070000`／`activity-election-results.test.ts`，第二個：`20261008120000`／`activity-party-gap.test.ts`；有迄日＋window／filled：`20261008121000`／`activity-party-roster.test.ts`）；**新增一支臂的樣板是 `ballot_numbers`**（補號次，2026-10-08，`20261008150000`／`activity-ballot-numbers.test.ts`／`scripts/arms-parity-ballot.ts`，協議 1.76.0：總表只多一行 UNION 分支、`activity_arm_names()` 只多一個名字、規則直接種成窗口 `draw` +0 起／`polling` +0 止；`draw` 里程碑由同一支 migration 從 `roster_check_scope.ballot_draw_on` 回填；臂把 2026 已登記〔`filed`〕而 `politician_elections.cand_no` 空的按單位〔屆別×選舉別×縣市，村里長與代表到鄉鎮市區，每 50 位一件〕整批派 `candidacy_source_missing`〔`target.kind`＝`cand_no`〕，**號次不做系統核對**——09-24 名冊例外只涵蓋登記彙總表，登記彙總表沒有號次；帶 `cand_no` 的 `candidacy` 因此不被 `roster_batch` 撿〔`roster_batch_candidates` 在 SQL 裡就排除〕，一律走一般驗證；**號次單位**〔`ballot_number_unit`：縣市長＝縣市、縣市議員＝選舉區、鄉鎮市長與區長＝鄉鎮市區、村里長＝村里、**代表＝鄉鎮市區的選舉區**（`縣市|麥寮鄉第04選舉區`，2026-10-09 #464，協議 1.82.0，`20261009070000`；參選紀錄的選舉區記在 `regions` 的「<鄉鎮>第NN選舉區」那一列，交件帶 `electoral_district`＋`sub_region` 落庫時指過去；補選區臂 `region_gap` 多派「代表只記到鄉鎮、中選會登記彙總表找得到他而且有選舉區」的任務〔2026 連江縣 26 件〕，不新增臂；只記到鄉鎮的照舊不檢查；守門 `rep-district.test.ts`、`rep-district-sql.test.ts`、`scripts/arms-parity-rep-district.ts`）〕的重複由 `cand_no_dup_system_check` 投系統票 not_supported〔`20261008151000`〕，重複與到齊後的跳號看視圖 `ballot_number_anomalies`、派 `cand_no_recheck`、`activity_health` 的 `ballot_number_anomaly` 計數），今天輸出逐件不變、10-22 不開、10-23 開、11-28 開、11-29 關；只改某一支臂內部的非日期條件、輸出只會多不會變的（例：名單清查重查判準）參考 `scripts/raw-roster-parity.ts`：把新定義當子查詢塞進同一個快照，raw 層與總表層逐件比，再用快照裡的原始資料在 JS 獨立重算一遍；**優先層（2026-10-08）**：`task_priority_tiers`（層號、權重、預設層）、`activity_rules.priority`（有填的規則只管排序、不管開關，活動名 `priority:<臂名>`／`priority:*`）、函式 `activity_priority()`、`task_dispatches.priority`（現在的層，seed 每輪重算）、`opened_by.priority`／`priority_rule_id` 與生成欄位 `gap_events.priority`（出生時的層）、視圖 `election_milestones_all` 的公報上架日 `bulletin_published` 一律讀里程碑表（2026-10-08 起不再讀 `elections.bulletin_published_on`）；**公報上架日的單一真相是 `election_milestones` 的 `bulletin_published`（election_type 空；預估＝`expected`／`statutory`，bulletin-watch 偵測到＝`done`／`official`），`elections.bulletin_published_on` 是觸發器衍生的快取、不能直接寫**，要設或改日期改里程碑那一列；優先層「公報之前」的種子規則 `priority:raw:policy_missing` 因此加 `min_status='expected'`（預估日期也算數）；**頁面流量提層（2026-10-08）**：`traffic_boost_settings`（單列參數，審計進 `edit_history`）、`page_traffic`（人物頁／政見頁近 N 天流量，每小時由 `console-fetch` 經 `replace_page_traffic` 覆寫）、`page_traffic_boosts`（一頁一列的提層狀態）、視圖 `page_traffic_hot`、`page_traffic_boosted_tasks`，函式 `traffic_boost_apply()`（seed 在算完每個缺口的層之後呼叫，把達標頁面名下缺口的層壓到 `boost_tier`；target 整份展開成鍵〔任何位置的 uuid、`politician_election_ids`／`politician_election_id`〕再和達標頁的鍵等值連接，人物頁涵蓋他名下政見與參選紀錄）；**名單時程里程碑（2026-10-08，`20261008160000`／`roster-milestones.test.ts`／`scripts/roster-milestones-parity.ts`）**：`candidacy_list_published()` 改讀 `election_milestones_all` 的 `list_published`（職位相同的優先，沒有才取整場），`roster_check_scope` 其餘三個日期搬成里程碑〔新 kind `qualification_review`、`draw`、`list_published`＋里程碑專用的職位值 `直轄市長`〕，單一真相在里程碑表（理由：能表達預估／已公告／已發生與審計，日本站沒有 scope 表），scope 五個日期欄由觸發器衍生；`activity_health` 的 `milestone_scope_drift` 擴到五個欄位。呼叫 `candidacy_list_published` 的 7 支臂（6 支加 #452 的 `ballot_numbers`）仍傳 `CURRENT_DATE`（UTC），換 `activity_today()` 留給各臂自己的 PR
- AI 用量：`ai_prompts`、`ai_usage_logs`、`model_pricing`、`pipeline_snapshots`

ENUMs：`policy_status`、`political_party`、`election_type`、`politician_status`

#### ⚠️ Election ID：舊三屆剛好是年份，之後新增的選舉不是（重要！）

| 表格 | 欄位 | 存的是 | 範例 |
|------|------|--------|------|
| `elections` | `id` | **選舉年份** | 2022, 2024, 2026 |
| `politician_elections` | `election_id` | FK → `elections.id`（年份） | 2022, 2024, 2026 |
| `electoral_district_areas` | `election_id` | **年份** | 2022, 2026 |

- 既有三筆的 `elections.id` 就是選舉年份；之後新增的選舉（補選、罷免投票、重行選舉，例如 2022-12-18 嘉義市長重行選舉，id＝4）id 照序號拿、不是年份。**年份、先後、「最新一屆」、任期起訖一律看 `election_date`**（#344 第二階段 A 起讀取端已切，`lib/election-route.ts`、`election_term_start／end`、`politician_latest_election`）
- 前端路由 `/election/:electionId` 的那一段：舊三屆照舊用 id（`/election/2022`），新增的選舉用 `election_key`（`/election/2022-12-18_rerun_10020`）；舊三屆的 key 寫法由 Worker／Firebase 301 到年份寫法。這些網址要一直能用（維護者 10-05：網址保持，新識別另加路由，舊的照常顯示或 301，不能 404）。站內連結一律從 `lib/election-route.ts` 的 `electionSegment` 取那一段，不要自己拿 id 拼網址

**#344 第一階段（2026-10-05）加新識別、第二階段 A（2026-10-07）讀取端切過去，只加不刪**：年份存不下補選、罷免、重行選舉，所以加了新識別，舊的不動：
- `elections.election_key`＝一場選舉的識別，格式 `投票日_種類[_地區代碼]`（`2022-11-26_local`、`2024-01-13_national`；種類 local／national／by 補選／recall 罷免／rerun 重行選舉），**建立後不改**（觸發器擋），新列沒給就自動產生
- `election_reason`（事由）、`election_types`（這次選哪些職位，直接存在選舉上；舊表 `election_types` 第二階段刪，過渡期觸發器同步）、`notice_date`（選舉公告日）、`turnout`（投票率）
- `id` 留著當內部整數主鍵、外鍵都不搬；**之後新增的選舉 id 不保證是年份**——新程式碼別再從 id 推年份或排先後，年份與先後用 `election_date`
- `end_date` 名不副實（三筆存投票日、新建時卻寫 12-31），新程式碼讀 `election_date`（讀取端已不讀 `end_date`、`election_types` 表，**第二階段 B 才刪**：欄位 `end_date`、表 `election_types` 與同步觸發器 `sync_election_types_array`、`year_or_null`、舊視圖 `politician_offices_derived`／`_gap` 一起刪）
- Edge Function 允許的選舉查 `elections`（`_shared/elections.ts`，找不到退回舊三屆）；交件用 `election_id` 或 `election_key` 擇一指選舉（協議 1.67.0）；cec-sync 由 `elections` 表驅動（場次用投票日對）
- 還把 id 當年份的地方（派工臂裡寫死 2022／2026 的文案與條件、`task-context` 的 `.order("election_id")`）列在 #344 第二階段 A PR 說明的「沒動的」清單

#### Electoral District Mapping
`electoral_district_areas` 把鄉鎮市區對到選舉區，供議員篩選：`region`（縣市）+ `electoral_district`（第01選舉區）+ `township` + `election_id`（年份）。

### Frontend Structure（`router/index.ts` 為準）

內容頁（建置時預渲染；其中 `/policy/:policyId`、`/politician/:politicianId` 與下面的 `/lineage/:lineageId` 預設改由正見.tw 的 Worker 邊緣渲染、只進網站地圖）：`/`（Home）、`/tracking`、`/policy/:policyId`、`/analysis`、`/analysis/:policyId`、`/elections`（選舉一覽：今後／過去，依投票日切，`lib/election-list.ts`；#344）、`/election/:electionId`、`/election/:electionId/:region`（縣市頁）、`/election/:electionId/:region/:subRegion`（鄉鎮頁，2026-10-05；舊的 `?sub=` 由正見.tw 的 Worker 301）、`/politician/:politicianId`、`/community`、`/community/:discussionId`、`/regional-data`、`/donation`、`/skill`、`/vision`、`/privacy`、`/terms`、`/contact`、`/sources`、`/politicians`（人物一覽，依姓氏筆畫分組，各組一頁 `/politicians/:筆畫數`）、`/parties`（政黨一覽）、`/party/:id`（各黨頁，id＝內政部政黨編號；#346：名單在建置端算好放進快照，從站內別頁換頁進來沒有快照就整頁載入預渲染那一份，`lib/full-load.ts`）；`/lineage/:lineageId`（政策脈絡頁，#349）跟政見頁、人物頁一樣由正見.tw 的 Worker 邊緣渲染、只進網站地圖，`/analysis` 是脈絡一覽

客戶端渲染（firebase.json rewrite 到 `app.html`，noindex）：`/election/:electionId/matrix`（政見矩陣：縣市×分類的政見筆數，讀預產快取表；路由要排在縣市頁前面）、`/contributions`、`/tasks`、`/queue`（派工順序前 1000 筆）、`/stats`（2026-09-18 從 `/ai-assistant` 一頁三分頁拆開；舊網址只在站內用過，已移除）、`/ai`（2026-10-03 起 AI 讀取與各模型表現，從統計頁搬來）、`/verify`、`/profile`、`/auth/callback`、`/election-2026`（轉到 `/election/2026`）、`/admin/*`（dashboard、duplicates、ai；`/admin/import` 2026-10-07 起轉到 `/admin/dashboard`；scraper 2026-09-23 隨 `add-politician` 下架）

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

**營運參數（2026-10-07 起，都有預設值、寫壞一律退回預設，不必發版就能調）**：
- 站點網址：Edge Function 的 `SITE_URL`（Supabase secrets，`_shared/site.ts`；人物頁、政見頁、任務看板連結）、前端與 sitemap 的 `VITE_SITE_URL`（`lib/site.ts`、`scripts/postbuild-ssg.mjs`）；預設都是 正見.tw。`index.html` 的 og 標籤是靜態的，換網域要手改（測試盯著）。**`PROTOCOL_URL`（policy-tw.web.app/skill.md）不屬於這一組**，有 `protocol-guard.test` 守
- 邊緣 Worker（`wrangler.toml` 的 `[vars]`，範圍與預設在 `cloudflare/worker-config.js`）：`SSR_CACHE_TTL_S`（600）、`SSR_STALE_TTL_S`（3600）、`SSR_BASE_TTL_S`（600）、`ORIGIN`
- Jev 版本（Supabase secrets，`_shared/system-one.ts`）：`JEV_MODEL`（OpenRouter 退路）、`TYPESAFE_JEV_MODEL`（直連 TypeSafe）；要填具體版本、不要填 alias
- 貢獻榜不列入的測試代號：資料表 `excluded_agents`（`INSERT` 一列就生效）

## Key Conventions

- 所有頁面透過 `useSupabase()` 取資料；重資料一律 `ensure*()` 按需載入，不要在 `fetchAll` 裡加東西
- `ElectionPage.vue` 用 `<KeepAlive>` 保住篩選狀態
- 只能在瀏覽器跑的東西（`vue3-apexcharts`、倒數天數、`window`/`localStorage`）放 `<ClientOnly>` 或 `onMounted`，否則預渲染會炸
- 換到內容頁（人物、政見、分析、討論）一律用真連結 `<router-link>`，不要 `@click="router.push"`——預渲染的 HTML 沒有 `<a href>` 爬蟲就跟不到（2026-09-30 Search Console 整站內部連結只剩 28 個）。卡片裡沒有其他按鈕就外層直接是 `<router-link>`；有按鈕或內層連結就用 stretched link（標題的 `<router-link>` 加 `after:absolute after:inset-0 after:content-['']`、卡片 `relative`、按鈕 `relative z-10`），不要做出 `<a>` 包 `<a>`
- Tailwind 走建置時編譯；動態組出來的 class 要加 `safelist`
- 給人看的文字純中文
- **職稱只能來自 `Politician.offices`（讀任期表 `politician_offices`：已就任而且卸任日為空；#345 第二階段 A 起，之前是視圖 `politician_offices_derived`）**，規則在 `lib/politician-office.ts`；`position` 是「最近一筆參選紀錄」的職位，落選的人也有，拿它當職稱會把落選者顯示成現任（2026-10-04 裁決）。參選狀況是另一回事，用 `candidacyBadge()`。
- 加新的貢獻型別或任務型別要清點四處：DB CHECK（`contributions_contribution_type_check`）、TS 清單（`CONTRIBUTION_TYPES`／`TASK_TYPES`／`SUGGESTED_TYPE`）、`public/skill.md`、`lib/task-labels.ts`；漏 DB CHECK 的話代理交件全被擋而測試全綠（2026-09-20 踩過）
- 流程規則改動先看 `docs/DECISIONS.md`（裁決日誌），牴觸舊裁決要在那裡寫「更正」

## Edge Functions（`supabase/functions/`，共 26 支；`merge-politicians` 硬刪 2026-09-21 下架，合併走 `merge_politician` 貢獻；`add-politician`／`update-avatar` 2026-09-23 下架——只要公開金鑰就能寫正式資料，人物與照片一律走貢獻；2026-02 的舊 AI 管線 13 支〔`ai-*` 九支、`add-policy`、`update-politician`、`import-candidate`、`debug-prompts`〕2026-10-07 下架、後台「資料匯入」頁與 `batch-import-candidates` 同日一併拆除，見 `docs/DECISIONS.md`）

- 代理身分：`ditrust-agent`（登入者向 DiTrust 開戶、看序號、改代號；正見不存序號，見 `docs/BLUEPRINT-agent-identity.md`）
- 外部貢獻協議（對應 `public/skill.md`）：`next`、`report`、`contribute`、`verify`、`apply`、`apply-verified`、`ask`、`tasks`、`request-task`、`history`、`verifications`、`contribution-status`、`contributions-feed`、`policy-stance`、`question-stance`、`boost`（插隊，無金鑰）、`sources`（查證來源清單，無金鑰，見 `/sources` 頁與 2026-09-28 裁決）
- 資料維護（都要管理員登入或金鑰）：`fetch-cec-data`
- 排程抓取（不驗 JWT，靠冷卻時間防濫用）：`cec-verify`（每 10 分鐘，拿中選會資料機器查證 pending 的參選／人物貢獻，對得上直接落庫，見 `docs/CONTRIBUTIONS-ADMIN.md`）、`cec-sync`（2026-10-06 起每個單位順手把名單上的選舉區記進 `election_districts`、算投票率寫 `elections.turnout`，名冊的推薦政黨原字存進 `cec_candidates.party`；議員與代表的應選名額不同步，走 `district_seats_missing` 任務；2026-10-07 起 2022、2024 與補選重行選舉各有既有週排程，2026 年以後的選舉由 `cec_sync_phase(投票日, 事由)` 依投票日自動換頻率〔開票夜每 10 分鐘、之後每 6 小時、兩週後每週〕，場次靠投票日對、不用設定表，開票夜看視圖 `cec_sync_status`，body 可帶 `min_interval_hours`）、`moi-sync`、`news-fetch`（新聞來源 `news_sources` 每小時逐則收進 `news_items`，收完觸發 `system-one?action=news_screen` 初篩派工，2026-09-29）；`source-archive`（選舉公報／選委會公告類出處每 10 分鐘送 Wayback Machine 存檔，寫 `sources.archive_url`，#347）；`bulletin-watch`（2026-10-08，偵測中選會公報站 `?dir=<民國年>` 的資料夾出現了沒：不存在時回首頁〔title「首頁 - …」〕、存在時 title「115 - …」；出現就把 `election_milestones` 的 `bulletin_published` 改成偵測當天、`status=done`、`basis=official`。pg_cron 兩條：每天 01:23 UTC 全部、每小時第 41 分只看預估日前後各 14 天；**要帶憑證**〔`x-cron-secret`，密鑰在 Vault 的 `bulletin_watch_cron_secret`，函式用 RPC `bulletin_watch_cron_secret_ok` 驗，照 console-fetch〕；寫入只經 service_role 專用的 RPC `bulletin_watch_targets`／`bulletin_watch_mark_published`，不直接寫表；抓不到或標題認不得回 502；有公報資料夾、還沒投票卻沒有整場 `bulletin_published` 里程碑的選舉，`activity_health` 的 `bulletin_milestone_missing` 會報出來〔新增選舉要補那一列，否則偵測和降級都悄悄失效〕，見 migration `20261008113000_bulletin_watch.sql`）
- Jev（TypeSafe System One，決策模型）：`system-one`（record／ask／backfill／precheck／judge／extract／legacy／news_screen／results_batch／reassign_check／roster_batch〔逐位核對引用中選會登記名冊的待驗參選紀錄；2026-10-08 起先查 `cec_registrations`，查得到的名冊不下載 PDF，表裡沒有的才讀 PDF 並受 3 MB 保護，查表不佔一輪 3 份 PDF 的名額〕）；`reassign_check` 是參選紀錄改掛（`reassign_candidacy`）的系統票：中選會名冊那一列的出生年核新舊兩人，照現有 ±1 規則（2026-10-06）；`results_batch` 是整批補選舉結果（`election_results`）的系統票：逐位核對中選會名單（SQL `election_results_system_check`），全部對得上才投、目標 2−1＝1（2026-10-06）；判決進 `jev_decisions`，`precheck` 對來源逐欄判定後以「系統票」參與共識（3+1 票，見 `contribution_system_vote`），`judge` 是給代理的免金鑰第二來源判定端點；抽 PDF／XLS 的 `import()` 必須是字串字面值（放變數線上會 Module not found）；設計與實測見 `docs/BLUEPRINT-jev-decisions.md`
- 日本站（schema `policy_jp`，2026-10-09，policy-jp #41）：`jp-next`、`jp-report`——正見 `next`／`report` 的日本版，client 固定 `db.schema=policy_jp`（PostgREST 的 Exposed schemas 要有 `policy_jp`），交件與共識照正見、不落庫（落庫下一個 PR）；複本在 `_shared/jp/`（每檔開頭寫抄自哪裡、拿掉什麼），SQL 複本在 `20261009110000_policy_jp_dispatch.sql`，**正見改了被抄的函式，`policy-jp-dispatch-drift.test.ts` 會紅，要決定日本版跟不跟**；派工憑證用日本站自己的鑰匙（`DISPATCH_TOKEN_SECRET_JP`，沒設就用正見的鑰匙加鹽），兩站的憑證不互通
- 站務主控台資料：`console-fetch`（pg_cron 每小時第 17 分，要帶憑證；抓 GA4 寫 Firestore 給 policy-console，2026-10-08 起順手再抓一份人物頁／政見頁的流量寫進 Supabase `page_traffic`，給派工的流量提層用，細節見「派工佇列」那兩條；流量這一步的成敗不影響 Firestore 的 `meta/status`，只在回應的 `traffic` 欄與日誌）
- 共用邏輯與測試在 `_shared/`；改門檻（SQL 與 TS 各一份）或改 `public/skill.md` 表格時，CI 的 `deno test` 會擋不一致
- `_shared/query-bounds.test.ts` 掃所有查詢鏈：沒 limit、`limit>1000`、翻頁沒 `.order` 都會紅（PostgREST max-rows=1000 靜默截斷）；真的有界就在那行上面寫 `// query-bounds: ok — 理由`

## Claude Skills（`.claude/skills/`）

- **`/find-avatar [name]`** — 從 Wikipedia 找政治人物頭像，可 `--all` 補缺圖；找到後交 `correction` 貢獻（同儕驗證通過才上線）
- 2026-10 起不再有直接寫正式庫的指令：舊的 `/add-policy`、`/research-politician` 教人用 `execute_sql` 直接 INSERT 政見，牴觸「資料走流程」，已移除

## 文件地圖

衝突時的優先序：程式與 migration ＞ `public/skill.md`（對外協議）＞ `docs/DECISIONS.md`（規則的來源與理由）＞ 其他文件。其他文件描述的是某個時間點的設計，開頭有「狀態」說明的以那一行為準。

**根目錄與設定**

- `README.md` — 對外入口：專案是什麼、最需要的三種貢獻、跑起來、架構地圖、送 PR 規則、授權
- `CLAUDE.md` — 本檔：給 Claude Code 的工作守則、指令、架構與慣例
- `public/skill.md` — **對外協議的唯一真相**（AI 代理直接讀；版號規則見上面「協議版號」）
- `SKILL.md`（根目錄）— 只是指路到 `public/skill.md`，刻意不放協議內容
- `public/llms.txt` — 給 AI 爬蟲的站點簡介
- `LICENSE`、`LICENSE-DATA.md`、`NOTICE` — 程式（Apache 2.0）、資料（CC BY 4.0）、貢獻授權
- `cloudflare/README.md` — 正見.tw 的 Worker：憑證與代理設定、邊緣渲染（人物頁、政見頁、脈絡頁）、縣市頁／鄉鎮頁的 ASCII 路徑規則
- `supabase/migrations/` — 資料結構、RLS、派工與計分 SQL 的真相（不是文件，但「表長什麼樣」以它為準）
- `.claude/skills/find-avatar.md` — `/find-avatar` 技能（見下一節）
- `scripts/agent/` — 協議代理的最小參考實作（`agent_round.py`、`relay_jev_verify.py`）；沒有獨立說明檔，用法看檔頭註解

**`docs/` 現行**

- `DECISIONS.md` — 裁決日誌：流程規則的來源，一條一條附日期、理由與錯了的代價；改規則前先讀，牴觸要寫「更正」
- `PIPELINE.md` — 資料怎麼進站：任務來源、派工、共識、落庫、狀態機、自動缺口任務一覽
- `CONTRIBUTIONS-ADMIN.md` — 維護者側的貢獻管線：資料表、自動落庫與裁決、`apply` 端點、查核履歷、插隊（`/boost`）
- `SSG-PRERENDER.md` — 建置時預渲染：指令、哪些頁預渲染／哪些邊緣渲染、`firebase.json` 行為、只能在瀏覽器跑的東西
- `BLUEPRINT-jev-decisions.md` — Jev（TypeSafe System One 決策模型）的導入設計與實測數字
- `BLUEPRINT-agent-identity.md` — 代理身分改由 DiTrust 發序號、正見只消費的設計（已實作，見 `ditrust-agent`）
- `BLUEPRINT-admin-to-tasks.md` — 把管理員頁面拆成任務的藍圖與盤點（2026-09-12 快照，部分已完成）
- `PLAN-term-progress.md` — 「承諾 → 任內 → 逐年進度」合併版規劃（維護者 10-07 裁決：`/data/2026` 範圍由人改為政見、首頁與矩陣只放筆數、任期與進度資料集下一期、狀態欄位拆分排到 2027 年 1–2 月；第 8 節是本次實作現況，第 10 節分已裁與待裁）
- `PLAN-markdown-views.md` — 政見的 Markdown 檢視（人物／縣市／分類／縣市×分類 .md、矩陣頁、預產快取 `data_md_cache`、機器可讀索引；第 12 節是實作現況，主題改用既有分類、第二期取消）
- `PLAN-edge-ssr.md` — 預渲染搬到 Cloudflare 邊緣 SSR 的計畫（第 1 步已上線；第 2、3 步未做）
- `DISTRICT-REGISTRY-2026.md` — 2026 議員選舉區名冊的查證報告（一次性查證，結論已進資料庫）
- `REGION-MISASSIGN-2026-10-04.md` — `20261004000020` 那支 migration 改了哪些參選紀錄地區的逐筆依據
- `2026-09-18-2024-election-results-backfill.md` — `20260918000005` 那支 migration 補 2024 結果的對帳表
- `DATABASE-SCHEMA.md` — 2026-03 以前的核心表說明，**部分過時**（缺 2026-09 起的新表），以 migration 為準

**`docs/` 設計提案（已被取代或仍在影子中，只供查脈絡；現況看 `DECISIONS.md`）**

- `PLAN-tasks-as-rows.md` — 自動缺口實體化成任務列（實際走了「單一佇列＋`task_dispatches`」）
- `PLAN-weighted-consensus.md`、`PROPOSAL-jev-vote-budget.md` — 加權共識與票數預算（目標分數仍一律 3，票數預算在影子模式）
- `REVIEW-deepseek-weighted-consensus.md` — 外部審查上面那份計畫的意見

**`docs/` 歷史（2026-02 的 Claude-PM／管理頁架構，已被貢獻協議取代）**

- `AI-ARCHITECTURE.md`、`AI-CHAT-PROPOSAL.md`、`ADMIN-PAGES-ANALYSIS.md`、`CHANGELOG-2026-02-01.md`

**交接與維運**

- 驗證 VM 腳本與交接文件在私人 repo `Yooliang/policy-ops`（`scripts/verify-vm/`、`docs/handoff/`）。policy-tw 不再放這兩個目錄（2026-10-06 移出）。
