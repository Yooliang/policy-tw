# Edge Function 內部 REST 呼叫瘦身（Log 量治本）設計與分期計畫

> 狀態：規劃文件，**不含任何 SQL 或程式變更**。日期：2026-11-27（台北）。
> 量測基準：後台 Logs Explorer 2026-11-27 的 24 小時實數（由主線提供，本文沒有重跑查詢）。每支函式的「一次請求幾次查詢」是**讀程式碼數出來的**（行號見第 4 節與附錄 B），沒有在正式庫實跑；rpc 內部再讀幾張表沒有算。
> 數字都會過期。**以第 3 節的對帳方法重算為準**，尤其是第 3.3 節那個「推定」，第 0 期要先驗證它。
> 前置閱讀：`docs/dispatch-arms-event-driven-plan.md`（同一天的另一份治本計畫，格式相同）、`CLAUDE.md`「新增排程／輪詢…每日呼叫量變化」一條。

---

## 1. 一頁摘要（白話）

**現在怎麼跑。** Supabase 的 API 閘道每收到一個 REST 請求就寫一行 `edge_logs`，一天約 190 萬行，是每天約 2.8 GB 記錄量的九成。其中 73.6 萬行（38.6%）是我們自己的 Edge Function 在處理一個請求時，內部再去打資料庫產生的。這份計畫只管這一塊：讓一次函式請求少打幾次資料庫。

**先講一個與預期不同的結果。**

1. **最大戶很可能不是 report，而是 history（查核履歷）。** 一次 history 請求要打約 20 次查詢（讀貢獻、票、修改紀錄、任務、人物名稱、出處…）。用「函式呼叫數乘每次查詢數」去對 24 小時實數，report、next、system-one 等主要函式加起來只解釋貢獻表約三成的讀取量；剩下的缺口，和「history 每天被呼叫約 2.3 萬次」這個推定在五張表上同時對得上（第 3.3 節）。history 不在原本提供的呼叫量清單裡，**這是推定，不是量到的**，第 0 期用一個 Logs 查詢驗證。
2. **report 平均一次約 8 到 10 次查詢，不是幾十次。** 幾十次只出現在批次（名冊 80 筆、一批 20 件）與落庫那一刻（一次約 20 到 30 次）。report 全部加起來一天約 4 萬行，約佔函式內部的 7%。
3. **只靠這份計畫到不了「每月 20 GB」。** 就算函式內部 73.6 萬行全部消失，月記錄量也只從約 84 GB 降到約 55 GB。這份計畫的預期是降到約 58 GB（含已另案處理的 agy 輪詢）。要到 20 GB，還要處理網頁端直讀（36.6 萬瀏覽器加 24.1 萬 SSR）與其餘約 56 萬行的來源，見附錄 A、B。

**做法。** 把「同一個請求裡連續打的多次讀取」合成一支 SQL 函式（RPC）一次回來；寫入路徑合成交易型 RPC；迴圈裡一筆一次的查詢改成一次批次；同一請求重複讀同一列的去掉。**不改協議、不動資料。**

**分幾期、各省多少（估計，詳見第 6 節）。**

| 期 | 做什麼 | 工作天 | 預估每日少幾行 | 月記錄量（GB） | 風險 |
|---|---|---|---|---|---|
| 現況 | 含 agy 輪詢 | | | 約 84 | |
| 已另案 | agy 登入輪詢 | | −13.9 萬 | 約 78 | |
| 第 0 期 | 驗證 history 呼叫量與重複率（零程式改動） | 0.5 | 0 | 78 | 無 |
| 第 1 期 | history／contributions-feed 單 RPC 化＋report 讀取合併 | 7 | −37.4 萬（−31 萬～−42 萬） | 約 61 | 中 |
| 第 2 期 | next 的前置讀取與任務脈絡合併＋system-one | 5.5 | −4.8 萬 | 約 59 | 中 |
| 第 3 期 | tasks／request-task 去 N+1、落庫寫入合併、重複查詢去重 | 4 | −2.6 萬 | 約 58 | 高（落庫） |

**風險一句話。** 最大風險是「RPC 與舊的多次查詢結果不一致」，對策是每支 RPC 上線前用同一份資料把新舊輸出逐案比對（PGlite 守門測試），函式部署回上一版就退回舊做法，SQL RPC 可留著不用。

**需要擁有者拍板的一件事。** 第 1 期要不要把原定的「report 先做」改成「history 先做」（第 6.1 節說明理由）。第 0 期的驗證結果會決定這個答案，所以不需要現在拍板。

---

## 2. 目標與非目標

### 2.1 目標

- 讓一次函式請求在「典型成功路徑」上發出的 REST 次數降到原本的三分之一以下（history 約 20 次降到 3 到 4 次；report、next 降一半左右）。
- 每期有可量的指標：**閘道每日 REST 行數**（Logs Explorer 依路徑與函式分組）。
- 守門：每支被改的函式加「查詢預算」測試，之後有人在同一路徑多加一次查詢會紅。

### 2.2 非目標（明確不做）

- **不改協議。** 代理端 `public/skill.md` 的行為、端點的輸入輸出、版號都不動（不升協議版號）。
- **不動資料。** 沒有任何 migration 寫入或修改既有資料列；只新增 SQL 函式（以及必要時的索引）。
- **不做快取止血**當主線。第 5.8 節把「短快取」列為**可選**、放在最後；先把查詢數降下來。
- **不改網頁端直讀視圖**（附錄 A 只點出來）。
- **不改 seed／派工臂**（另案：`docs/dispatch-arms-event-driven-plan.md`）。第 5.4 節的鎖順序只約定寫入端，不改 seed 本體。
- **不重寫 `apply-contribution.ts`**（2,989 行）。只動最單純的幾個型別，見第 5.4 節。

---

## 3. 現況量測與對帳

### 3.1 24 小時實數（主線提供）

| 項目 | 數量 |
|---|---|
| 閘道 `edge_logs` 總行數 | 約 190 萬 |
| 其中函式內部 REST | 73.6 萬（38.6%） |
| 其中瀏覽器直讀／SSR 直讀 | 36.6 萬／24.1 萬 |
| 內部 REST 依路徑 | contributions 173,767；rpc/agy_login_claim 139,242（已另案）；edit_history 70,940；politicians 56,983；contribution_tasks 52,489；politician_elections 47,135；contribution_votes 43,204；policies 38,105；rpc/source_briefs 24,540；其餘零碎 |
| 函式呼叫數 | report 4,006、next 3,460、system-one 3,420、request-task 714、agents-verify 298、strong-adjudicate 246、tasks 198；cec-verify、roster-reconcile、apply-verified、jp-system-one、source-archive 各約 144 |

扣掉 agy 之後，函式內部約 59.7 萬行。**history、contributions-feed、verifications、contribution-status 的呼叫數不在提供的清單裡**（清單只列到 tasks 為止）。

### 3.2 「函式呼叫數 × 每次查詢數」能解釋多少

每支函式的每次查詢數見第 4 節。對「貢獻表」這一張最大的表，用中位情境估：

| 來源 | 呼叫／天 | 每次打貢獻表 | 行／天（估） |
|---|---|---|---|
| next | 3,460 | 約 6.5（額度、我交過、我答過、在途、查無回報、提問在途、驗證脈絡） | 約 22,000 |
| report | 4,006 | 約 4.5（contribute 約 4 到 5；verify 約 2，最後一票含落庫約 6 到 9） | 約 18,000 |
| tasks | 198 | 每筆任務各跑一次脈絡，預設最多 10 筆，每筆約 2 次 | 約 4,000 |
| request-task、system-one、排程類 | | 零散 | 約 5,000 |
| **合計** | | | **約 49,000** |
| **實測** | | | **173,767** |

**只解釋約 28%。缺口約 12.5 萬行。** 這是整份計畫最重要的一個數字：如果照原本假設只動 report，最多省 1.8 萬行，離目標差得很遠。

### 3.3 缺口的來源：推定是 history（待第 0 期驗證）

`history` 函式（`supabase/functions/history/index.ts` 加 `_shared/history.ts`）每次請求的查詢數，逐行數過（`_shared/history.ts:327-440`、`:446-467`、`_shared/summary-lookup.ts:73-102`）：

| 步驟 | 查詢 | 表 |
|---|---|---|
| 貢獻（直接掛、payload 引用、correction 三條） | 3 | contributions ×3 |
| 子表 id（政見＝追蹤紀錄、人物＝參選紀錄） | 1 | tracking_logs 或 politician_elections |
| 修改紀錄（主表、子表兩條） | 2 | edit_history ×2 |
| 經修改紀錄補撈的貢獻 | 0 到 1 | contributions |
| 票 | 1 | contribution_votes |
| 修改紀錄（依貢獻 id） | 1 | edit_history |
| 裁決貢獻 | 1 | contributions |
| 裁決任務 | 1 | contribution_tasks |
| 來源列（政見多一支 `source_brief_list` rpc；人物多一次參選紀錄） | 2 | policies 或 politicians＋politician_elections |
| 名稱對照第一輪（裁決的原貢獻） | 1 | contributions |
| 名稱對照第二輪（依內容有哪些 id，每張表一次） | 約 3 到 6 | politicians、policies、lineages、parties、politician_elections、admin_divisions |
| 出處摘要 | 1 | rpc source_briefs |
| 網站請求（`collectWebRequests`，這支沒有逐行讀） | 至少 2 | contribution_tasks、contributions |
| **合計** | **約 18 到 24（中位約 20）** | |

**用 24 小時實數反推呼叫量：**

- `edit_history` 實測 70,940。history 每次打它 3 次（兩條加一條），next 一次都不打、report 只有落庫才寫。→ **history 約 2.3 萬次／天。**
- 用這個數字去預測**其他四張表**，和實測比對（這些是獨立的驗證，不是循環推論）：

| 表 | history 貢獻（2.3 萬 × 每次） | next、report 等其他來源 | 合計估 | 實測 | 差 |
|---|---|---|---|---|---|
| contributions | 約 13.8 萬（×6） | 約 4.9 萬 | 約 18.7 萬 | 173,767 | +8% |
| contribution_votes | 約 2.3 萬（×1） | 約 2 萬（next 3 ×3,460、report 2.5 ×4,006） | 約 4.3 萬 | 43,204 | 0% |
| politicians | 約 4.6 萬（×2） | 約 1.1 萬 | 約 5.7 萬 | 56,983 | 0% |
| policies | 約 3 萬（×1.3） | 約 0.8 萬 | 約 3.8 萬 | 38,105 | 0% |
| rpc/source_briefs | 約 2.3 萬 | contributions-feed 約 0.15 萬 | 約 2.45 萬 | 24,540 | 0% |
| politician_elections | 約 3.5 萬 | 約 0.8 萬 | 約 4.3 萬 | 47,135 | −9% |
| contribution_tasks | 約 3.5 萬（含網站請求） | 約 0.5 萬 | 約 4 萬 | 52,489 | −24% |

五張表在 10% 以內，兩張稍差。**這是推定，原因：** 呼叫數是由 edit_history 反推的，所以 edit_history 本身不算驗證；但 votes、politicians、policies、source_briefs 四張是獨立吻合。`source_briefs` 只有 history 與 contributions-feed 兩處會呼叫（`_shared/history.ts:420`、`contributions-feed/index.ts:98`，加日本站兩支），2.45 萬正好等於 history 加 feed 的呼叫量，這是最強的一條旁證。

**推定的 history 約佔函式內部（扣掉 agy）的 70%（約 44 萬行／59.7 萬行）。** 如果第 0 期驗證不成立（history 實際只有幾千次），第 1 期整個重排，預期省的行數要砍掉九成以上，見第 6.4 節。

### 3.4 其他函式的量級（讀碼，附錄 B 有行號）

| 函式 | 呼叫／天 | 每次查詢（典型） | 行／天（估） | 佔內部 |
|---|---|---|---|---|
| history（推定） | 約 23,000 | 約 20（約 18 到 24） | 約 44 萬 | 約 70% |
| next | 3,460 | 回 none 12 到 16、派驗證票約 24 到 32、派自動缺口約 21 到 29 | 約 7.6 萬 | 約 13% |
| report | 4,006 | verify 約 8、contribute 單件 6 到 9、落庫另加 20 到 30 | 約 4 萬 | 約 7% |
| system-one | 3,420 | ask 4、precheck 每候選 4 到 12、cron 空轉 1 到 2 | 約 1.2 萬 | 約 2% |
| tasks | 198 | 固定約 8 加每筆任務 2 到 8（預設 10 筆） | 約 1 萬 | 約 2% |
| request-task | 714 | 11 到 17 | 約 0.9 萬 | 約 1.5% |
| 排程類（cec-verify、roster-reconcile、apply-verified、source-archive、jp-system-one） | 各 144 | 空轉 1 到 7、有件時每件 15 到 30 | 約 0.5 萬 | 約 1% |
| contributions-feed、verifications、contribution-status、其餘 | 未知 | 2 到 4 | 約 0.5 萬 | |

這些加起來約 59 萬，和扣掉 agy 後的 59.7 萬吻合（偏差在估計誤差內）。

---

## 4. 逐支評估

> 下面的行號都是 `supabase/functions/` 底下的相對路徑，是 2026-11-27 的 main。「暖」＝模組級快取命中；冷啟動或 TTL 過期會多 1 次。rpc 內部讀的表沒有算。

### 4.1 history（推定最大戶）

- 一次約 20 次查詢，其中 7 次在 `Promise.all`（`_shared/history.ts:411-418`），前面 6 到 7 次循序（`:402-405`）。
- **同請求重複讀同一張表：** contributions 一次請求讀 5 到 6 次（3 條條件、經修改紀錄補撈、裁決、名稱對照的原貢獻、網站請求）；edit_history 3 次。這些都可以一支 SQL 用 `UNION`／`json_agg` 合成一次。
- `_shared/jp/history.ts` 是日本站的對應（`jp-history` 守門測試逐行比對這支，見附錄 C）。

### 4.2 report（`report/index.ts:43-56` 分派 verify、contribute、withdraw，沒有 skip）

| 路徑 | 暖快取下典型次數 | 主要構成 |
|---|---|---|
| contribute 單件 policy（auto 任務） | 6（手動任務 8） | 額度 count（`contribute-handler.ts:330`）、在途 select（`:111`）、去重 select（`:676`）、precheck 人物（`apply-precheck.ts:65`）、insert（`:970`）、租約歸還（`:1047`）。手動任務多 2 次讀 contribution_tasks（`:110`、`:358`） |
| contribute 單件 candidacy | 9 到 10 | 再加人物（`person-identity-guard.ts:41`）、參選紀錄（`apply-precheck.ts:200`）、claim 候選（`:205`） |
| contribute bundle（最多 30 條） | 9 到 11，與條數無關 | 條目走單次 bulk insert（`:970`）；去重與在途每 40 筆多 1 次 |
| contribute 名冊批次（最多 80 筆） | 14 到 16 加閘門 | 閘門次數沒有追到底（`:323`） |
| contribute no_change 直接落庫 | 單件約 11；N 件約 6＋5N | 每件 insert、task_checks、edit_history、select、update（`:983-1026`），最多 20 件約 106 次 |
| verify agree（有 token，非最後一票） | 8 | 額度 count（`verify-handler.ts:122`）、貢獻（`:132`）、已投票（`:222`）、前一則備註（`:275`）、是否已指認（`identity-pick-gate.ts:47`）、insert 票（`:386`）、重讀貢獻（`:396`）、rpc `contribution_effective_agree`（`:402`） |
| verify 最後一票 | 再加 4 到 5，加落庫本體 | `autoApplyContribution`（`:407`） |
| 落庫（`applyContribution`，`apply-contribution.ts:2870`） | policy 約 8 到 10；candidacy 約 12 到 20；no_change 約 5 | 每型別寫哪些表見附錄 B |

**重複讀同列：** 同一請求內 politician_elections／policies 同一列被讀 3 次（`contribute-handler.ts:613`、`:751`、`apply-precheck.ts:140`）；contribution_votes 同一批票被讀 3 次（`verify-handler.ts:222`、`identity-pick-gate.ts:47`、`auto-apply.ts:53`）；contributions 同一列被讀 3 次（`:132`、`:396`、`auto-apply.ts:116`）。

**N+1：** 沒帶 politician_id 的 policy 每件 1 次（`:477-495`，最壞 20 到 30 次）；correction 每件 1 到 2 次（`:584-666`、`:744-756`，最壞 40 次）；併票每個命中件約 7 次（`:702-730`，最壞 N×7）。

### 4.3 next（`next/index.ts`，773 行）

- **所有路徑共同的前置約 12 次**，連回 `none` 都要付（`:146-221`、`:588-590`）：驗證池 rpc、佇列件數 rpc、佇列候選 rpc、斷路器 rpc；**貢獻表讀 5 次**（額度 count `:170`、我交過的 `:162-164`、我答過的 `:177-180`、在途與查無回報 `:305`、`:308`）；票 2 次（額度 `:172`、我投過票 `mv:40`）；租約清理加讀取 2 次。
- **我交過的／我答過的用 `fetchAllRows` 翻頁**，條件是 `agent_name = 我 OR contributor_ip_hash = 我`。「我答過的」含 applied，**只增不減**（程式註解自己寫「這份只會成長、不會退場」，`:177`）。每多一千筆就多一次請求；這是需要在第 0 期量的潛在放大點（量法見附錄 B）。
- 分路徑：派驗證票約 24（policy 型）到 32（candidacy、politician 型）；派自動缺口 policy_missing 約 29，其中任務脈絡 `fetchTaskContext` 約 14 到 17；profile_gap 約 21 到 23；回 none 12 到 16；帶 `skip=` 另加 4。
- **`agents-verify`** 是另一支 Edge Function，不是標籤（`_shared/actor.ts:84`）：身分是 `ditrust:<序號>` 時 `fetch` 去換身分，**不是 REST**，結果在 isolate 快取 5 分鐘。它內部打幾次 REST 沒有讀。
- **重複讀：** 貢獻表同請求讀 5 到 7 次（上面那五條，條件重疊）；任務脈絡與「在途」重讀同一個人的參選紀錄與貢獻（`task-context.ts:989`、`:994` 與 `pending-on-target.ts`）；租約 purge 加 select 是兩次往返（`:588`、`:590`）。

### 4.4 system-one

- 呼叫者：**全部是 pg_cron 的 `net.http_post`**，加上落庫新政見時 fire-and-forget 打 `action=ask`（`apply-contribution.ts:840`、`:878`），加 news-fetch 收完觸發 `news_screen`（`news-fetch:108`）。**`report` 本身不呼叫它。**
- 每日約 1,900 次來自 cron（約 78 次／小時，依各 migration 的排程字串，頻率可能在 11-19 之後改過分鐘，沒有逐支重核）；其餘約 1,500 次大致是 `ask`（每條新政見一次，約 4 次查詢）與公開的 `judge`、`extract`。
- 查詢數：ask 4、judge 6 到 7、extract 4、precheck 每候選 4 到 5（建新人物 9 到 12、merge 型 9 到 11）；沒有候選也至少 2 次。
- **N+1：** `roster_batch`（`:1011-1013`）對每個候選各 1 次 `contribution_apply_consensus` rpc，最多 500 個；`news_screen` 每則新聞 3 到 4 次（`limit` 上限 400）。

### 4.5 tasks、request-task

- `tasks`（GET）：固定約 8 次，加**每筆任務各跑一次 `fetchTaskContext`**（`tasks/index.ts:125`，預設 `with_current` 開啟、`limit` 預設 10 上限 50），每筆 2 到 8 次。10 筆約 40 到 80 次，50 筆約 110 到 400 次。`?with_current=0` 可以整個省掉。
- `request-task`（POST）：already_queued 約 11 到 14、queued 約 14 到 17；包含 `workCardOf` 兩個 rpc、`findRecentlyHandled`、兩個計數。保險絲關閉的舊路會呼叫一次 `p_limit: 100000` 的 `contribution_auto_tasks` rpc（`:121`，是單次重 rpc，不是迴圈）。

### 4.6 排程類

| 函式 | 頻率 | 空轉 | 有件時（每件） | 上限 |
|---|---|---|---|---|
| cec-verify | 每 10 分鐘（144／天），`limit=20` | 3 到 4 | skip 1；reject 2；apply 約 20 到 30 | 20 件 |
| roster-reconcile | 每 10 分鐘（144／天） | 2（開關關閉）或 7 到 8（開著） | 每位建人 15 到 22；補地區 3 到 5 | `batch_limit` 預設 100、最大 500 |
| source-archive | 每 10 分鐘 | 1 | 2 | 4 件 |
| apply-verified | 每 10 分鐘 | 約 5 | 每件 5 到 25 | `limit` 20（最大 100） |
| jp-system-one | 每 10 分鐘 | 3 | 逐筆 | 60 |

空轉每日加總約 3,000 行，不值得動；有件時的落庫成本是第 5.4 節的對象。

### 4.7 jp-* 與共用關係

見附錄 C。結論：`contribute-handler`、`verify-handler`、`apply-contribution`、`auto-apply`、`roster-reconcile` 在日本站各有複本（`_shared/jp/`），改正見這幾支**不會**連帶改變日本站；但 `dispatch.ts`、`actor.ts`、`quota-settings.ts`、`my-votes.ts`、`source-read.ts` 等通用檔是共用的，改了日本站會一起變。history 與 contributions-feed 各有逐行比對日本站複本的守門測試，**改正見版要同步改日本站複本或調整測試的比對範圍**。

---

## 5. 方案

每條方案列：省多少（行／天，估）、風險、改哪些檔、守門測試。「省」都以 3.4 節的基準算，並且**只算 REST 行數**（rpc 內部多打的表不算、本來就不進閘道 log）。

### 5.1 M1：history 一支 RPC 回全部（第 1 期，預期最大）

**做什麼。** 新增 SQL 函式 `history_collect(p_target text, p_id uuid)`，回一個 jsonb：貢獻（直接、引用、correction、經修改紀錄補撈合併去重）、票、修改紀錄（主表、子表、依貢獻 id）、裁決貢獻、裁決任務、來源列、出處摘要（內含 `source_briefs` 與 `source_brief_list` 的結果）、網站請求。名稱對照因為要先看內容才知道要查哪些 id，**保留為第二個 RPC** `history_summary_lookup(p_ids jsonb)`，把現在 6 張表各查一次合成一次。**一次請求從約 20 次降到 2 到 3 次。**

- **省多少：** 每次 −17（保守 −12，若名稱對照仍留 4 次），× 約 2.3 萬 ＝ **約 −35 萬行／天（範圍 −29 萬～−39 萬）**。前提是第 0 期證實呼叫量。
- **改哪些檔：** 新增 migration（時間戳由主線配號，大於遠端最新一支）；`_shared/history.ts` 的 `collectHistory`、`contributionIdsFromEdits`、`contributionsForTarget`、`originRowFor` 改成呼叫 RPC 並把結果餵給原本的純函式 `buildHistory`（**輸出組裝的純函式不動**，所以前端與日本站拿到的 JSON 不變）；`history/index.ts` 不動。
- **風險：**
  1. **語意不一致。** 現在有 `.limit(500)`／`.limit(1000)` 的截斷點、`effective_agree` 計算欄位（`HISTORY_ENTRY_COLUMNS`，每列多跑一次函式）、排序。RPC 必須逐項複製，不然履歷會少筆或順序變。緩解：新舊輸出逐案比對測試（第 5.9 節）。
  2. **單次更久、statement_timeout。** 20 次小查詢合成一支大查詢，單次變慢是預期；但實測前沒有數字。要用 `SET plan_cache_mode = force_generic_plan` 加 `PREPARE` 模擬（`CLAUDE.md`「量效能先實測」）。函式本體各子查詢用 `LATERAL` 或獨立 CTE，不要互相 join 成大笛卡兒積。
  3. **日本站複本。** `_shared/jp/history.ts` 沒有跟著改、`jp-history.test.ts` 逐行比對正見版，要連同處理（附錄 C）。
- **守門測試：** ①`history-collect.test.ts`：同一份假資料（PGlite 建表）跑「舊的多次查詢路徑」與「RPC」，輸出 jsonb 逐欄相等，涵蓋 policy、politician、contribution、question 四種 target、無貢獻、有裁決、有還原的修改紀錄、有 correction。②查詢預算測試：`createFakeSupabase` 計數，`collectHistory` 在典型路徑 ≤ 3 次，加一次就紅（樣板見附錄 D）。

**PR-1 已上（2026-11-27，migration `20261127073000_history_bundle_rpc.sql`，守門 `_shared/history-bundle.test.ts`）。** 與上面的設計不同的地方：
- **一支 RPC，不拆兩支。** `history_bundle(p_target text, p_id text, p_limit int)` 回 jsonb，名稱對照也在 SQL 裡一次做完（規則同 `summary-lookup.ts`），所以政見／人物／單筆貢獻每次請求只打 1 次 REST（含網站請求）。回傳形狀：`contributions`、`votes`、`edits`、`adjudications`、`tasks`、`summary`（名稱對照原料）、`source_briefs`、`origin_row`、`election_notes`、`web_requests`（`rows`、`parked`、`reports`），各自對應原本各查詢的結果；組裝的純函式不動。
- **question 對象不做進 RPC**，仍走多次查詢（量小）。`p_limit` 只夾 0～100 後原樣帶回，不影響撈取範圍（分頁在 `buildHistory` 之後，`total` 要看全部）。
- **權限：`SECURITY INVOKER`，只給 `service_role`**（history 用 service role 讀；不開給 anon，避免繞過函式前的快取與參數檢查直接打資料庫）；Supabase 預設會把新函式開給 anon／authenticated，migration 明寫 `REVOKE`。
- **舊路徑留著當退路。** RPC 回錯（`PGRST202`、例外、形狀不對）就退回多次查詢並 `console.warn`；舊函式 `collectHistoryLegacy`／`collectWebRequestsLegacy` 保留。**一週後另一支 PR 拆掉退路**（連同守門測試裡的「新舊逐 byte 相同」改成只測新路徑）。`history/index.ts` 沒動（日本站複本逐行比對）；網站請求的資料由 `collectHistory` 帶回後暫存在 client 上、`collectWebRequests` 取用一次。
- **守門：** 三種 target 與無貢獻、找不到、分頁的整份回應 JSON 新舊逐 byte 相同；limit 邊界；RPC 失敗退回舊路徑；權限（PUBLIC／anon／authenticated 不行）；計數（新路徑 ≤ 2 次、舊路徑 ≥ 10 次；測試資料上舊路徑人物 26 次、政見 19 次，新路徑 1 次）。
- **待上線後量：** 單次 RPC 耗時與 `statement_timeout`（8 秒）餘裕，用 `PREPARE` 加 `force_generic_plan` 在正式庫唯讀實測；欄位型別（`politician_elections.id`、`tracking_logs.policy_id` 等）依 migration 推得，沒在正式庫核對過，型別不符時 RPC 會回錯、自動退回舊路徑，不會壞頁面。

### 5.2 M2：contributions-feed 對應處理（第 1 期，量小）

`contributions-feed/index.ts` 每次 2 次查詢加 `loadSummaryLookup`（第一輪加第二輪，3 到 7 次）加 `fetchSourceBriefs`（1 次），共約 6 到 10 次。把「名稱對照」與「出處摘要」併入 M1 的 `history_summary_lookup`／出處 RPC 共用。

- **省多少：** 約每次 −4；呼叫量未知（source_briefs 扣掉 history 後約 1,500）→ **約 −0.6 萬行／天**。
- **風險：** 低。`jp-contributions-feed.test.ts` 去掉 `jp-only` 區段後逐行比對正見版（見 `CLAUDE.md` 日本站一段），要同步。
- **守門：** 同 M1 的新舊比對加查詢預算。

### 5.3 M3：report 的讀取合併（第 1 期）

**verify 路徑**（約 8 次）：把「額度 count、貢獻、已投票、前一則備註、是否已指認、（沒帶 token 時）派發綁定」合成 `verify_context(p_contribution_id, p_voter_keys…)` 一次回；insert 票之後的「重讀貢獻加 `contribution_effective_agree`」合成一支 `verify_cast_result(p_contribution_id)`。**8 次降到 3 次。** candidacy／politician 型的 `resolvePolitician` 次數沒有追，不列。

**contribute 路徑**（6 到 9 次）：把「額度 count、在途、去重、precheck 人物、（手動任務）contribution_tasks 兩次」合成 `contribute_precheck(p_items jsonb, p_actor jsonb)` 一次回每件的判定材料。保留 insert 與租約歸還。**降到約 3 到 4 次。**

**N+1 去掉：** 沒帶 politician_id 的 policy 改 `.in("name", […])` 一次；correction 的三處讀取共用一次（第 4.2 節重複清單）。

- **省多少：** verify 約 2,200 次／天 × 5 ＋ contribute 約 1,800 次／天 × 4 ≈ **約 −1.8 萬行／天**（verify 與 contribute 的比例是假設，沒有實測；去 Logs 看 `/report` 的 `kind`）。
- **改哪些檔：** 新增 migration；`_shared/verify-handler.ts`、`_shared/contribute-handler.ts`、`_shared/identity-pick-gate.ts`、`_shared/apply-precheck.ts`、`_shared/auto-apply.ts`（讓 `autoApplyContribution` 接受預讀的列，省 1 次）。
- **風險：** 中。這是**交件主路徑**，錯誤會讓代理交件被誤擋或誤收。額度與去重的判定語意（「先數再寫、沒有原子保留」，`CLAUDE.md` 常被誤解的行為一段）**必須逐字保持**，不能趁機改成有鎖的版本（那是另一件事、另一個裁決）。
- **守門測試：** 既有的 `dispatch-token-entry.test.ts`、`verify-*` 系列（真的載入入口跑端到端，`entry-harness.ts`）要全綠不改；新增查詢預算測試：verify 典型路徑 ≤ 4、contribute 單件 policy ≤ 5。

### 5.4 M4：落庫寫入合併成交易型 RPC（第 3 期，只做最單純的型別）

**範圍限定。** `apply-contribution.ts` 有 2,989 行、每型別各自寫幾張表（附錄 B 表 4）。**只對兩種做**：`no_change`（auto 任務，約 5 次：task_checks、edit_history、select、update…）與 `policy`（約 8 到 10 次：select、insert、edit_history、出處 rpc、任務結案）。candidacy 約 12 到 20 次、牽涉身分比對與選區解析，風險與收益比太差，**不做**。

**做法。** `apply_no_change_tx(...)`、`apply_policy_tx(...)`：`SECURITY DEFINER`，**同一個交易**寫 contributions 狀態、edit_history、task_checks／policies、任務結案；固定鎖順序。

**順帶：死鎖（今天 11:50 那次）。** 現在 seed 的 `task_dispatches` 批次更新與交件寫入（觸發器 `contribution_queue_row` 等會寫 `task_dispatches`）互等。合併成一個交易之後，可以**約定固定鎖順序：`task_dispatches`（依 task_id 升冪）→ `contributions` → `edit_history` → `contribution_votes`**。這只約定了寫入端；**seed 本體要照同一順序加鎖才算解**，那不在本計畫範圍（見非目標）。所以這條是「讓寫入端不再製造反向鎖」，**不保證單獨解掉死鎖**；要先拿到那次死鎖的 `pg_stat_activity`／日誌，確認另一端是不是 seed，再決定。沒有這份證據前，不把「解死鎖」當成這一條的驗收。

- **省多少：** 落庫次數／天沒有量到（假設約 1,500 次，約 −10 次）→ **約 −1 萬行／天**，不確定性大。
- **風險：高。** `SECURITY DEFINER` 的權限邊界見第 7.2 節；落庫失敗的回滾粒度改變（現在是逐步寫、中途失敗會留半套；合併後是全有全無，行為更好但**和現有「寫失敗只記 WARNING 不擋主流程」的容錯習慣不同**，要逐處確認）。
- **改哪些檔：** 新 migration；`_shared/apply-contribution.ts` 的 `recordInsert`、`closeTask`、`applyNoChange`、`applyPolicy` 呼叫端；`_shared/edit-history.ts`。**日本站不動**（它自己的 SQL `policy_jp.apply_contribution` 已經是 rpc 版）。
- **守門測試：** 還原驗證（`edit_history` 可整筆還原是既有承諾）：用 PGlite 對同一份資料跑舊路徑與 RPC，比對 contributions、edit_history、task_checks、policies 四張表的**寫後狀態**逐列相等；加一個「中途故意失敗，確認全數回滾」的測試；既有 `seed-*`、`queue-*` 守門測試全綠。

### 5.5 M5：next 的前置讀取與任務脈絡合併（第 2 期）

- **前置：** 把貢獻表的五次讀取（額度 count、我交過、我答過、在途、查無回報）加票的兩次，合成 `next_actor_state(p_agent, p_ip_hash, p_window_start, p_candidate_task_ids…)`，回 `{submit_count, vote_count, my_submitted_task_ids, my_answered_task_ids, inflight, dead_ends, my_voted}`。同時解掉「我答過的」只增不減的翻頁。租約 purge 加讀取合成一支。**約 −6 到 −7 次。**
- **任務脈絡：** `fetchTaskContext`（`task-context.ts:843`）對 `policy_missing` 約 14 到 17 次，合成 `task_context_policy_missing(p_politician_id…)` 一次回人物、參選紀錄、政見、在途貢獻、公報網址、里程碑；加 `fetchPendingOnTarget` 一起併入（現在與脈絡重讀同一個人）。**約 −10 到 −14 次。**
- **省多少：** 每次平均 −12 到 −13，× 3,460 ＝ **約 −4 萬行／天**。路徑比例（驗證票、自動缺口、none）沒有實測，是假設。
- **改哪些檔：** `next/index.ts`、`_shared/dispatch.ts`（**日本站共用**，`jp-next` 也 import）、`_shared/task-context.ts`、`_shared/pending-on-target.ts`、`_shared/my-votes.ts`（**日本站共用**）。
- **風險：中。** ①`dispatch.ts`、`my-votes.ts` 日本站也用，不能改簽名，要新增函式、讓正見版改用新的，日本站維持舊的（drift 測試 `policy-jp-dispatch-drift.test.ts` 要登記）。②`next` 是整個系統的心臟，回 `none` 的邏輯有大量細節（額度滿先試派驗證票、斷路器、冷卻）；**RPC 只回資料，判斷仍留在 TS**，不把判斷搬進 SQL。
- **守門測試：** 既有 `dispatch-token-entry.test.ts`、`verify-first-rank.test.ts`、`agent-breaker-skip-cooldown.test.ts` 全綠；新增 `next` 典型路徑查詢預算（回 none ≤ 6、派自動缺口 ≤ 12）。

### 5.6 M6：system-one 與 N+1（第 2 期）

- `ask`：4 次合成 2 次（同人政見與參選紀錄一次回）。
- `roster_batch`：每候選 1 次 `contribution_apply_consensus` 改成一支批次 rpc（`contribution_apply_consensus_batch(p_ids uuid[])`），內部迴圈呼叫原函式（**不重寫計分邏輯**，兩處計分 SQL 與 TS 要逐案一致的限制照舊）。
- `precheck`：每候選 4 到 5 次，`newPersonAskFor` 對每個走到 Jev 的候選先打一次貢獻表（`system-one/index.ts:107`），改成整批預讀。
- **省多少：** **約 −0.8 萬行／天**（候選數沒有量到，保守）。
- **風險：低到中。** system-one 是排程，不在交件即時路徑；但 `contribution_apply_consensus` 是**計分核心**，批次包裝版必須只是迴圈呼叫，不能改語意。
- **守門測試：** `unsure-penalty.test.ts` 的「SQL 與 TS 逐案比對」不動；新增批次版與逐筆版輸出相等測試。

### 5.7 M7：tasks 的 N+1、request-task 合併（第 3 期）

- `tasks` 的 `with_current`：不再每筆各跑一次脈絡，改成對挑出的 N 筆任務一次批次取（用 M5 的 `task_context_*`，傳 id 陣列）。**10 筆約 40 到 80 次降到 4 到 6 次。**
- `request-task`：`workCardOf` 兩個 rpc、`findRecentlyHandled`、兩個計數合成 `request_task_state(...)`。**13 次降到約 5 次。**
- **省多少：** `tasks` 198 × 約 −35 ＋ `request-task` 714 × −8 ≈ **約 −1.2 萬行／天**。
- **風險：低。** 兩者都是代理端偶爾呼叫、沒有熱路徑。
- **守門測試：** 查詢預算（`tasks` 在 `limit=10` 時 ≤ 8；`request-task` ≤ 6）。

### 5.8 M8：重複查詢去重與短快取（第 3 期，快速收益，可選）

- **去重**（第 4 節各支列出的「同一請求內讀同一列兩次以上」）：contributions 同列 3 讀、politician_elections／policies 同列 3 讀、contribution_votes 同批 3 讀、roster-reconcile 的 `politician_elections` 同列讀 2 次（`apply-contribution.ts:674` 與 `candidate-import.ts:249`）。每一處 −1 到 −2 次，**合計約 −0.4 萬行／天**。每處獨立、各自一個小 PR。
- **短快取（可選，不計入預期）：** history 是公開唯讀、已經回 `Cache-Control: public, max-age=30`，但閘道不會替函式快取。可以在 isolate 內加 60 秒的 LRU，鍵＝target、id、limit、cursor（`next` 已有同樣做法：`cachedQueueCounts`、`cachedPendingAdjudications`）。**效益取決於同一個 id 的重複率**，第 0 期從 Logs 量；過期期間履歷頁會晚 60 秒看到新的投票或落庫，與「讓資料自己說話」不衝突但要擁有者知道。M1 做完之後 history 每次只剩 3 次，快取的邊際效益已經小。

### 5.9 新舊輸出比對與查詢預算（所有方案共用的守門）

**比對：** 每支新 RPC 一個測試檔，`PGlite` 建最小 schema、塞一份涵蓋邊界的資料，**先跑舊的 TS 多次查詢路徑（保留在測試裡當對照），再跑 RPC，輸出逐欄相等**。這是 `CLAUDE.md` 既有的做法（例：`unsure-penalty.test.ts` 真的跑 SQL 與 TS 逐案比對）。

**預算：** 用既有的 `createFakeSupabase`（`_shared/source-read.test.ts` 在用）包一層計數器，對「典型成功路徑」斷言 `呼叫次數 ≤ 預算`。樣板見附錄 D。測試放在對應函式旁，`_shared/` 底下的新 `*.test.ts` CI 會自動跑。

---

## 6. 分期

### 6.1 期別、工作量與順序理由

| 期 | 內容 | 工作天（估） | 順序理由 |
|---|---|---|---|
| 第 0 期 | 驗證：用 Logs Explorer 取 24 小時 history／contributions-feed／verifications／contribution-status 的呼叫數與 id 重複率；量「我答過的」翻頁頁數的分布；量 verify 與 contribute 在 report 的比例 | 0.5 | 零風險；決定第 1 期內容與預期，**必須最先做** |
| 第 1 期 | M1＋M2 history、contributions-feed；M3 report 讀取合併 | 7（history 3、feed 1、report 3） | **與主線原訂「先做 report」不同**：依第 3 節對帳，history 是推定最大戶（約 70%）、report 約 7%。若第 0 期證實，先做 history；若證偽，回到 report 先做、history 降到第 3 期 |
| 第 2 期 | M5 next；M6 system-one | 5.5（next 4、system-one 1.5） | `next` 是第二大戶，但它是心臟、日本站共用檔多，放在第 1 期驗證 RPC 手法之後 |
| 第 3 期 | M4 落庫合併（只 no_change、policy）；M7 tasks／request-task；M8 去重 | 4 | 收益小、落庫風險最高，最後做；M4 先要有死鎖的證據 |

### 6.2 現況 vs 各期後（每日 REST 行數）

> 「函式內部」是 24 小時實數 73.6 萬；各期是減法估計。表中「閘道總行數」的其餘部分（網頁直讀與其他，約 116 萬）**不變**。

| 時點 | 函式內部 | 其中 history | 閘道總行數 | 月記錄量（GB） |
|---|---|---|---|---|
| 現況（2026-11-27） | 73.6 萬 | 約 44 萬（推定） | 約 190 萬 | 約 84 |
| agy 另案解掉後 | 59.7 萬 | 約 44 萬 | 約 177 萬 | 約 78 |
| 第 1 期後 | 約 22.3 萬 | 約 9 萬 | 約 139 萬 | 約 61 |
| 第 2 期後 | 約 17.5 萬 | 約 9 萬 | 約 134 萬 | 約 59 |
| 第 3 期後 | 約 14.9 萬 | 約 9 萬 | 約 131 萬 | 約 58 |

**換算說明。** 主線給的「每行約 2.4 KB」乘上 190 萬行等於每天約 4.6 GB，與實際每天約 2.8 GB（其中 edge_logs 約九成）對不上。這裡改用**實際校正值：2.52 GB ÷ 190 萬行 ≈ 1.3 KB／行**，每少 10 萬行／天約少 3.9 GB／月。若用 2.4 KB，各期省下的 GB 會多約 80%，但現況月量就不是 84 而是 137，與觀察不符，所以不用。

**各期省的量（行／天）。**

| 方案 | 省（中位） | 範圍 | 依據 |
|---|---|---|---|
| M1 history | −35.0 萬 | −29 萬～−39 萬 | 2.3 萬次 × 每次 −12～−17（第 3.3、5.1 節） |
| M2 feed | −0.6 萬 | | 約 1,500 次 × −4 |
| M3 report | −1.8 萬 | −1.2 萬～−2.4 萬 | 第 5.3 節，verify／contribute 比例是假設 |
| M5 next | −4.0 萬 | −3 萬～−5 萬 | 3,460 次 × −12～−13，路徑比例是假設 |
| M6 system-one | −0.8 萬 | | 候選數未量 |
| M7 tasks、request-task | −1.2 萬 | | 198 次 × −35、714 次 × −8 |
| M4 落庫 | −1.0 萬 | −0.3 萬～−1.5 萬 | 落庫次數未量 |
| M8 去重 | −0.4 萬 | | |

### 6.3 回滾

| 期 | 回滾方式 |
|---|---|
| 第 0 期 | 無需回滾 |
| 第 1 到 3 期 | **函式部署回上一版即可**（`pnpm deploy:functions <名>` 或在 main 還原該提交，CI 自動重部）。新增的 SQL RPC 沒有人呼叫就無害，**可留**，不必同一天 DROP。要刪時另開 migration，且遵守「改函式簽名要分兩次上」（`CLAUDE.md` 部署順序一段）：新 RPC 簽名一旦上線就不要改，要改就新增 `_v2`。 |
| M4（寫入） | 同上；額外確認回滾後新舊兩條路徑對同一個任務的寫入沒有重複（用 `edit_history` 的 contribution_id 唯一性查一次）。 |

**部署順序提醒。** CI 是先 `db push` 再部署函式，所以「先上 RPC、再上呼叫它的函式」是安全方向；反過來會有一段時間函式呼叫不存在的 RPC（PGRST202）。同一個 PR 內兩者一起上，順序由 CI 保證；**不要把新 RPC 與舊 RPC 的刪除放同一個 PR**。

### 6.4 如果第 0 期證偽 history 的推定

- 呼叫量遠低於 2.3 萬（例：幾千次）：第 3.2 節的缺口 12.5 萬行就**沒有來源**，要先找缺口（附錄 B 的備選清單）再排期，**不得先動手**。
- 這種情況下第 1 期改為 report 加 next，預期省 −6 萬行／天上下（月約 −2 GB），整份計畫的總量目標要重新評估。

---

## 7. 風險

### 7.1 RPC 合併後單次更久、statement_timeout

- 20 次各 5 到 30 毫秒的小查詢合成一支，總時間通常差不多或更短（省網路往返），但**最壞情況是一個人物底下貢獻很多**（現在各條有 `limit 500／1000` 保護）。RPC 內每個子查詢必須保留同樣的 `LIMIT`，不要因為「在資料庫裡」就拿掉。
- 函式用 `service_role` 呼叫，`statement_timeout` 以角色設定為準；**要確認 service_role 的逾時值**（`anon` 只有 3 秒，`CLAUDE.md` 已記）。每支 RPC 自己加 `SET statement_timeout = '…'`，並記得 `CREATE OR REPLACE FUNCTION` 會洗掉函式層級的 SET（`CLAUDE.md` seed 一條的教訓），測試要擋。
- 上線前用 `EXPLAIN ANALYZE` 實測，帶陣列參數的函式要用 `force_generic_plan` 加 `PREPARE` 模擬（陣列長度會被估成 10 筆）。

### 7.2 `SECURITY DEFINER` 的權限邊界

- 這些 RPC 只該由 Edge Function（`service_role`）呼叫，**不能讓 `anon`、`authenticated` 直接呼叫**：Postgres 預設 `EXECUTE` 給 `PUBLIC`，每支都要 `REVOKE ALL ON FUNCTION … FROM PUBLIC` 再 `GRANT EXECUTE … TO service_role`。這條要有守門測試（掃新 migration 裡每個新函式有沒有 REVOKE，樣板在既有的 `console_admin_*` 與 `bulletin_watch_*` 測試）。
- 只讀的 RPC（history 系列）**優先用 `SECURITY INVOKER`**：本來就用 service role 讀，不需要提權；`SECURITY DEFINER` 只用在 M4 的寫入。
- 所有 `SECURITY DEFINER` 函式加 `SET search_path = public, pg_temp`，內部引用的表一律不依賴呼叫者的 search_path。
- history 是**公開端點**。RPC 回傳的欄位必須和現在 `buildHistory` 輸出的集合一致，**不能多帶** `contributor_ip_hash`、`agent_name` 以外的來源識別（現在的欄位白名單在 `EDIT_COLUMNS`、`CONTRIBUTION_COLUMNS`、`VOTE_COLUMNS`，RPC 要用同一份）。守門：比對測試加一條「輸出 jsonb 不含 `ip_hash` 字樣的 key」。

### 7.3 PostgREST schema 快取

新增函式不改既有函式簽名時，PostgREST 的 schema cache 會在 migration 之後自動重載，**不影響既有請求**。「改簽名要分兩次上」的限制只適用於改既有函式，本計畫全是新增。

### 7.4 日本站

見附錄 C。**原則：** 共用的檔不改簽名；日本站複本自己的函式不動；逐行比對測試同步調整。日本站本計畫**不跟**（`policy_jp` 的流量小，量不到再說），在 `policy-jp-dispatch-drift.test.ts` 與 history／feed 比對測試登記偏離。

### 7.5 協議與外部行為

端點輸入輸出不變、不升協議版號。唯一的行為差異來源是「RPC 與舊多次查詢的邊界條件不同」，由第 5.9 節的逐案比對守住。

### 7.6 本計畫自己的前提風險

- **「history 約 2.3 萬次」是推定。** 第 0 期先驗證。
- 每次查詢數是讀程式碼數的，不是量到的；`resolvePolitician`、`rosterBatchProblems`、`collectWebRequests`、`agents-verify` 內部沒有追到底，這些是**往少數**的方向（實際可能更多）。
- 各期的省量乘以「路徑比例」，比例沒有實測（next 的驗證票／自動缺口／none；report 的 verify／contribute）。第 0 期一併量。

---

## 附錄 A. 網頁端直讀（不在本計畫範圍，只點出來）

網頁端（瀏覽器 36.6 萬加 SSR 24.1 萬，約 60 萬行／天）直接讀視圖：`politician_election_policy_counts`、`policies_with_logs`、`politicians_with_elections` 等。這一塊本計畫不動，但**不處理它，月記錄量到不了 20 GB**（第 1 節）。方向（另案）：①SSR 讀的資料在邊緣 Worker 層快取；②視圖加計數快取小表（做法同 `queue_task_counts_cache`）；③瀏覽器端列表按需載入（`/tracking` 已按縣市載入）。

## 附錄 B. 查詢數明細、對不上的缺口與未確認項

### B.1 落庫每型別寫哪些表（一次，`apply-contribution.ts`）

| 型別 | contributions | edit_history | 其他 |
|---|---|---|---|
| policy | select 1、認領 update 1 到 2、最終 update 1 | insert 1（`:836`）；手動任務另加結案一筆 | policies select 1 與 insert 1（`:799`、`:833`）、politicians select 2、手動任務 contribution_tasks select 1 與 update 1、rpc `source_write` 1 |
| candidacy | 同上，加 supersede select 1（`:2940`） | 建立 insert 1；更新每個變更欄位 1 次（`:749-751`） | politicians select 1 到 3＋、politician_elections 3 到 4、regions 2 到 4、rpc `candidacy_list_published` 0 到 2 |
| no_change（auto） | 同上 | task_checks insert 1；legacy_audit 另加 1 | not_running 另有 update 1 |

### B.2 對不上的缺口

1. **貢獻表缺口約 12.5 萬行**：推定來自 history（第 3.3 節）。備選來源：`next` 的「我交過的／我答過的」翻頁頁數比預期多（單一代理歷史很長時每次請求多頁）；`contributions-feed`、`verifications`、`contribution-status` 的呼叫量也未知；pg_cron 或 pg_net 打函式的次數比預期多。
2. **contribution_tasks 缺口約 1.2 萬行**（估 4 萬、實測 5.2 萬）：`collectWebRequests` 沒有逐行讀，可能每次多打 1 到 2 次。
3. **政治人物／政見頁在 `agents-verify`**（298 次／天）內部的 REST 沒有讀。
4. **rpc 內部讀取**不進閘道 log，但**影響資料庫負載**，與本計畫的「Log 量」目標無關；若之後目標改成降資料庫負載，要另外量。
5. **pg_cron 呼叫函式的實際現況**：排程字串取自各 migration 的最後一版，11-19、11-21 兩次搬分鐘之後有沒有 job 被取消沒有逐支重核。

### B.3 第 0 期要跑的查詢（唯讀）

1. 近 24 小時依函式名分組的呼叫數（`function_edge_logs`），重點：history、contributions-feed、verifications、contribution-status。
2. history 的請求網址中 `id` 的不同值數量與總數（重複率，決定短快取值不值得做）。
3. 近 24 小時 `rest/v1/contributions` 依「呼叫它的函式」分組（若 Logs 帶 user-agent 或 referer 可分；不行就用呼叫時間點與函式呼叫時間點對）。
4. `/report` 依 body 的 `kind` 分組比例（若 Logs 沒有 body，就用 `contribution_votes` 與 `contributions` 的 24 小時新增筆數反推）。
5. 「我答過的」翻頁頁數：同一個 agent 在 `rest/v1/contributions?...range` 的 `Range` 標頭分布。

## 附錄 C. 日本站共用關係

- **複本（改正見版不影響日本站）：** `_shared/jp/contribute-handler.ts`、`verify-handler.ts`、`withdraw-handler.ts`、`apply-contribution.ts`（薄的 rpc 殼）、`precheck.ts`、`history.ts`、`consensus.ts`、`contribution-schema.ts`、`machine-verify.ts`、`commons-avatar.ts`。`jp-next`、`jp-tasks` 自己寫在入口檔。
- **共用（改了日本站會一起變，不能改簽名）：** `_shared/dispatch.ts`（`jp-next` 與 `jp/verify-handler.ts` 都 import）、`actor.ts`、`dispatch-token.ts`、`quota-window.ts`、`quota-settings.ts`、`my-votes.ts`、`fetch-all.ts`、`system-one.ts`、`same-claims.ts`、`verify-claim.ts`、`dispute-verify.ts`、`task-admin.ts`、`task-votes.ts`、`duplicate-claim.ts`、`self-hosts.ts`、`source-read.ts`（`fetchSourceBriefs`，`jp-contributions-feed` 與 `jp/history.ts` 都用）。
- **逐行比對的守門測試：** `jp-history.test.ts`（比對 `history`）、`jp-contributions-feed.test.ts`（去掉 `jp-only` 區段後比對）、`policy-jp-dispatch-drift.test.ts`（SQL 複本與 TS 複本的漂移）。**動正見的 history 與 feed 要同步改這三處。**
- 日本站典型請求量級：`jp-next` 約 10 到 16 次；`jp-report` 交件 4 到 8 次加每個 item 兩個 rpc、驗證投票 8 到 10 次；`jp-tasks` 4 到 7 次；`jp-system-one` 排程空轉 3 次。**日本站流量小，本計畫不跟。**

## 附錄 D. 查詢預算守門測試樣板

```ts
// supabase/functions/_shared/history-rest-budget.test.ts（樣板，實作時依實際 fake 介面調整）
import { assertLessOrEqual } from "jsr:@std/assert";
// 用既有的 createFakeSupabase 包一層計數；每次 .from()／.rpc() 算一次。
// 預算寫在測試裡，加一次查詢就紅，要加就得同時改預算並寫理由。
Deno.test("history collect：典型 policy 路徑查詢數在預算內", async () => {
  const { client, calls } = withCallCounter(createFakeSupabase(FIXTURE_POLICY_WITH_VOTES, RPC_STUBS));
  await collectHistory(client, "policy", POLICY_ID);
  assertLessOrEqual(calls.length, 3);
});
```

預算數字參考：history ≤ 3；report verify 典型路徑 ≤ 4、contribute 單件 policy ≤ 5；next 回 none ≤ 6、派自動缺口 ≤ 12；tasks（limit=10）≤ 8；request-task ≤ 6。

## 附錄 E. 每期 PR 說明要填的欄位

- 「每日呼叫量變化：」寫**負數**加依據（例：「−35 萬／天，history 約 2.3 萬次 × 每次少 15 次」）。本計畫沒有新增排程、輪詢、觸發器或對外呼叫，`scripts/ci-migration-usage-note.mjs` 不會因本計畫觸發，但這欄照填方便之後對帳。
- 動 `supabase/migrations` 的 PR：同一張 PR 檢查 `CLAUDE.md`，要加一條「REST 呼叫瘦身」的現況說明，或寫「CLAUDE.md 無需更新」（claude-md-sync 守門）。
- migration 時間戳由主線配號；每支新 RPC 都要有 `REVOKE`／`GRANT` 與 `SET search_path`。
