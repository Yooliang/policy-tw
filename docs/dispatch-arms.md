# 派工臂總覽（單一佇列怎麼排、每條臂從哪來、怎麼查）

> 快照日期：2026-11-07（台北約 08:20）。程式與 migration 是真相（見 `CLAUDE.md`「文件地圖」的優先序）；
> 本文的規則段落以 2026-11-07 的 `main`（PR #877 之後）與正式庫函式定義（`pg_get_functiondef`）對過；第 3 節的數字是當下快照，會過期。
> 標「未查證」的是沒有逐行對過的部分，改之前先看原始碼。
> 「派工臂」＝一類會往佇列裡放任務的來源：待驗證貢獻、自動缺口、手動任務。日本站 `policy_jp` 有同名的複本函式，本文只講台灣站。

## 1. 一條佇列、一把尺

### 1.1 表與排序鍵

- 所有可派的東西都在 `task_dispatches`，一列一張「號碼牌」。`task_id` 看開頭分三種：
  - `verify:<貢獻 id>` ＝ 驗證票（某筆 pending 貢獻等人投票）。
  - `auto:<臂>:...` ＝ 自動缺口（`seed_auto_task_queue()` 算出來的，缺口補上就收回）。
  - uuid ＝ 手動任務（`contribution_tasks` 的一列）。
- 排序鍵是 `queue_at`，越早越先派，**沒有別的優先權**。任務列由觸發器 `task_dispatches_queue_key` 每次寫入時重算：

  ```
  queue_at = task_queue_key(進隊時間, priority_seconds, cool_until, boost_seconds)
           = GREATEST(進隊時間 − priority_seconds, cool_until) − boost_seconds
  ```

  - 進隊時間 ＝ `last_dispatched_at`（新列＝出生當下；派出後＝派出的當下，所以派過就回到隊尾）。
  - `priority_seconds`：缺口的優先秒數，正數＝往前、負數＝往後（第 2.2 節）。
  - `cool_until`：冷卻結束時間，**沒插隊時**是排序鍵下限——冷卻沒過，鍵不會比它早；有 `boost_seconds` 時是在 `GREATEST` 外層扣減，鍵會早於它（第 1.2、2.5 節）。
  - `boost_seconds`：插隊秒數，一次性，**派出就歸零**（觸發器在 `dispatch_count` 變動時清）。
- 設定在單列表 `queue_settings`（2026-11-07 正式庫）：`dispatch_horizon_seconds` 86400（1 天）、`boost_seconds` 157680000（5 年，維護者 `/boost` 一次加的份量）、`manual_front_seconds` 157680000（5 年）、`visitor_front_seconds` 315360000（10 年）、`verify_priority_seconds` 1209600（14 天）、`verify_redispatch_seconds` 604800（7 天）、`verify_no_change_redispatch_seconds` 1209600（14 天）、`verify_inherit_negative` false。
- 來源：`20261011320000_queue_priority_seconds.sql`（秒數制）、`20261011350000_queue_priority_cleanup.sql`、`20261104120000_verify_ticket_key.sql`（驗證票）。

### 1.2 `cooling` 與 `blocked`（`refresh_dispatch_blocked()`，seed 每 10 分鐘叫一次）

- `blocked`：只管 `auto:` 列。該任務底下在途（pending／verified／disputed）貢獻 ≥ 5 筆，或有 `no_change` 在等票／已通過未落庫，就是 blocked；其他列照舊。
- `cooling`：`task_queue_key(last_dispatched_at, priority_seconds, cool_until, boost_seconds) > now() + dispatch_horizon_seconds`。所有任務列（不含 `verify:`）都算。
  - **它是「排序鍵的視界」，不是硬閘門。** 鍵比「現在＋1 天」還晚就先不派；鍵早於這條線（例如被插隊秒數拉到幾年前）`cooling` 就算出 false，**插隊會蓋過冷卻**——這是第 4 節那個坑的根因。
  - 副作用：冷卻只有 2 天時，`cool_until` 超過「現在＋1 天」的前 24 小時是 cooling，之後 `cooling` 變 false，但 `queue_at` 仍被 `cool_until` 墊著，所以排在接近隊尾的位置。（由公式推得，未另外實測。）
  - `task_boost` 與一次性插隊 migration 也直接把 `cooling` 設成 false。
- `contribution_queue_tasks(...)`（`/next` 讀的 RPC）的過濾，**全部在 `LIMIT` 之前**（`20261017000301_queue_tasks_eligibility_before_limit.sql` 起，不合格的列不佔窗口）：
  - `NOT blocked`，且 `NOT cooling OR queue_at < '2000-01-01'`（早於 2000 年＝被明確插隊的，跳過冷卻——現在的插隊秒數制下 `queue_at` 多半會落到 2000 年前，所以這條讓插隊的列直接放行）。
  - 排除：認領（lease）中且不是自己、同機器／同代號已交過的、任務停放（底下有在途交件；`question`／`adjudicate`／`roster_check` 三型例外）、有 `no_change` 在等票、在途額滿 5 筆、公民提問答案額滿或這台答過、裁決任務不合格（已有裁決在等、或原貢獻是自己交的／投過票）。
  - 排序 `queue_at ASC`，同鍵時公民提問依 `target.stance_up` 高的先，再 `opened_at`、`task_id`。

### 1.3 `/next` 怎麼挑（`supabase/functions/next/index.ts`、`supabase/functions/_shared/dispatch.ts`）

1. 驗證池 `contribution_verify_pool`（排除自己交的、已投過、分數已達目標；在 SQL 的 LIMIT 之前）出一個最前的候選。2026-11-09 起（協議 1.124.0）多一條「沒人在做的先派」：被別的代理握著（30 分鐘內派到、未投票）的人數 >= 還缺票數（目標 − 分數）的票先不出（`p_skip_held`），零人握著的排前面；沒有別的可派時 `/next` 用 `p_skip_held=false` 再取一次，維持原行為。任務列本來就跳過別人認領中的。
2. 任務佇列 `contribution_queue_tasks` 一次取一個窗口（`QUEUE_WINDOW`），程式再過濾一輪（`filterLeasedTasks` 等，應與 SQL 重複；若全被剔光會 `console.error`，代表有過濾器沒搬進 SQL）。
3. 任務窗口依 id 分手動（uuid，`isManualTaskId`）與自動（`auto:`）各取最前一個。
4. `pickQueueHead`：三個候選（verify／manual／auto）比 `queue_at`，**最早的先**；同時刻 `verify` ＞ `manual` ＞ `auto`。時間用 `Date.parse` 比，不用字串比。
5. 沒有 2:1 或 3:1 交錯（2026-10-13 起全拿掉）；沒有候選時回 `none`。

## 2. 每條臂

### 2.1 驗證票（`verify:<貢獻 id>`）

- **怎麼來**：貢獻交件時由觸發器寫入；seed 每 10 分鐘補漏的、收掉已不是 pending 的。
- **排序**（`20261104120000`，維護者 2026-11-04 裁定）：

  ```
  queue_at = 基準 B − verify_priority_seconds(14 天) − boost_seconds + 步長 × 這張票被領走的次數
  ```

  - 步長：一般 7 天（`verify_redispatch_seconds`）；`no_change` 的票 14 天。
  - 基準 B：「新東西」型（`policy`、`question_answer`、`task_suggestion`，以及任務是 `roster_check` 的 `candidacy`／`politician`）＝貢獻的 `created_at`；其餘（補欄位、更正、查無、照片、裁決……）＝**母任務被派出前的排序位置**（記在任務列 `dispatch_base_at`，含插隊秒數），母任務找不到時退回 `created_at`。
  - `verify_inherit_negative=false`：母任務優先秒數為負時當 0 繼承。
  - `task_dispatches.priority_seconds`：新東西型為 0，其餘＝母任務的非負優先秒數（`verify_ticket_priority_seconds`）。`verify_follows_task` 欄位保留但排序鍵已不看它。
- **冷卻／停放**：驗證票沒有 `cooling`／`blocked`（`refresh_dispatch_blocked` 排除 `verify:%`）。能不能領由驗證池的 SQL 決定。
- **插隊**：`/boost`、`cand_no_front_pull`（第 2.4 節）會加 `boost_seconds`；驗證列的插隊不因派出歸零（`20261104120000` 註解；與任務列相反）。
- 2026-11-07 起：`no_change` 的 `not_found` 不再進驗證（第 2.5 節），所以票只剩其他型別（`confirmed` 的 `no_change` 2026-11-09 起也不進驗證）。

### 2.2 優先秒數（自動缺口的 `priority_seconds`）

seed 對每組「臂 × 選舉 × 職位」問一次 `activity_priority_seconds`：取 `activity_rules` 裡 `priority:<臂>` 與 `priority:*` 規則中**秒數最小**的一條；規則沒填 `priority_seconds` 就用 `task_priority_tiers`。沒有任何規則相符＝預設層（中段 0）。現行（2026-11-07）：

| 層／規則 | 秒數 | 適用 |
|---|---|---|
| 前段（tier）規則 37 | +259200（+3 天） | `priority:*`，投票日前 180 天到投票日（2026 選舉前的任務先做） |
| 中段（預設） | 0 | 沒有規則相符 |
| 後段（tier）規則 38 | −2592000（−30 天） | `priority:*`，投票日後 181 天起（2022、2024 歷史補資料） |
| 規則 39 | 0 | `priority:raw:policy_missing`，非縣市長的職位、公報上架日之前；因取最小值，**把 policy_missing 壓在 0、不吃前段 +3 天** |
| 規則 40 | +259200 | `priority:placeholder_politicians`（移除測試人物） |
| 規則 44 | +259200 | `priority:manual_visitor`（網站請求／公民提問的手動任務） |
| 規則 50 | −2592000 | `priority:regional_stats_missing`（地方統計，2026-10-26 維護者降後段） |

另有「流量提層」：人物頁／政見頁近 7 天訪客 ≥ 5 的缺口，優先秒數至少 `traffic_boost_settings.boost_seconds`（+3 天），細節見 `CLAUDE.md`「頁面流量提層」。

### 2.3 自動缺口 `auto:<臂>:...`

- **怎麼來**：`seed_auto_task_queue()`（pg_cron `seed-auto-task-queue-10min`，`*/10 * * * *`）呼叫 `contribution_auto_tasks_arms()` 算全站缺口：新缺口 `INSERT`、內容變了才 `UPDATE`、缺口補上了就 `DELETE`（原因 `filled`／規則窗口關了 `window` 記進 `gap_events`）。帶清單指紋的臂換號時沿用舊列的排隊位置（`20261019040000`）。
- **每條臂是否開、何時開**由 `activity_rules`（窗口）控制；表在主控台可改。
- 2026-11-07 佇列裡的臂（`task_id` 第二段）與意思，數量見第 3 節：

| 臂 | 是什麼 |
|---|---|
| `profile_gap` | 人物基本資料缺口（出生、學歷、經歷等）；佇列最大宗 |
| `policy_missing` | 候選人沒有政見；中位優先秒數 0（見第 4 節） |
| `policy_elements_missing` | 政見缺要素欄位 |
| `term_policy_missing` | 任內政見缺口 |
| `duplicate_policy` / `duplicate_politician` | 重複政見／重複人物（同名合併；`target.cand_no_gap` 的同名合併任務會被號次插隊） |
| `lineage_candidate` / `lineage_link_candidate` / `lineage_roles_missing` | 政見脈絡的候選、連結、角色缺口 |
| `candidacy_source_missing` | 參選紀錄缺來源；`target.kind` 為 `cand_no`（補號次）或 `cand_no_recheck`（複查），其餘為一般來源缺口 |
| `roster_check` | 名冊對帳（中選會登記彙總 vs 我們的參選紀錄，多／缺／重複） |
| `progress_stale` / `deadline_due` | 進度追蹤（逾期未更新、到期）；冷卻走設定表（第 2.5 節）；村里長不主動追進度，有人看才追（`20261009010000`：規則 5／24／36 以 `except_election_types=ARRAY['村里長']` 排除村里長；規則 45／46／47 對村里長設 `requires_traffic=true`，人物或政見進 `page_traffic_hot` 才開窗；`village-progress-cooling.test.ts`） |
| `regional_stat_missing` | 地方統計（人口・面積・總預算歲出・65 歲以上比例） |
| `policy_election_mismatch` / `policy_election_missing` | 政見的選舉歸屬錯／缺 |
| `legacy_audit`、`profile_detail_gap`、`party_info_missing`、`policy_validity`、`district_seats_missing` | 量少的雜項臂（`legacy_audit` 為舊資料稽核） |

> 第 2.3 節臂名表是依 2026-11-07 佇列內容與臂的命名整理，「是什麼」欄為意譯；確切欄位語意以 `contribution_auto_tasks_arms()` 與 `public/skill-types.md` 為準（未逐臂查證）。
>
> `activity_rules` 還有 `policy_missing` 相關的 `raw:policy_missing`（規則 3、49）等窗口規則；窗口條件細節不在本文範圍。

### 2.4 手動任務（uuid，`contribution_tasks`）與插隊

`contribution_tasks.source` 四種（`closed`/`open` 為 2026-11-07 筆數）：

| source | 是什麼 | open／closed | 出生時的插隊 | 備註 |
|---|---|---|---|---|
| `web_request` | 網站請求：訪客在網頁按「請 AI 幫忙查」等；visitor 臂 | 1,076／4,571 | `visitor_front_seconds`（10 年） | 村里長／鄉鎮市民代表 × 缺政見，在選舉公報上架前**停放**（`web_request_parked`，`20261028130000`）：不出現在臂輸出、不被拉回；`elections.bulletin_published_on` 一填自動放出；**同一人已有開著的 `policy_missing`／`term_policy_missing` 缺口的缺政見請求併入缺口**（`web_request_coverage`，`20261111010000`）：請求不單獨派（臂不輸出、仍 open），缺口拿一次 `visitor_front_seconds` 插隊（標記 `opened_by.web_request_boost_ids`，冷卻中的缺口不插），請求只在「缺口已不覆蓋它、而且人物現在有承諾」時由 10 分鐘對帳關閉（`closed_reason='gap_filled:…'`，不單憑 gap_events 的 filled），`window` 關閉則請求回到可派並接回派出歷史（`web_request_dispatch_memory`） |
| `question`（`task_type='question'`） | 公民提問：訪客的提問；`manual_task_is_visitor` 視同 visitor | 現無列 | 同 visitor | 一題最多收 3 份答案（`question_answer_cap()`）；同鍵時支持度高的先 |
| `suggested` | AI 提議：代理交 `task_suggestion` 或系統（`system-one?action=followups`，每小時）從投票備註產生的跟進；多數 `task_type='other'` | 2,273／533 | 0 | 佇列中最大的手動來源；出生來源屬推測（見下） |
| `manual` | 維護者建的 | 168／462 | `manual_front_seconds`（5 年） | 例：`news_sweep`、`candidate_status_stale` |
| `auto_dispute` | 裁決：貢獻被爭議後自動開（`adjudicate`、`avatar_choice` 二選一） | 7／233 | `manual_front_seconds`（5 年） | `created_by='auto-overvoted'` 的不插隊（0） | **`target.requires_tier='strong'`（強模型待辦，`20261109230000`）的不進一般派工**：`contribution_queue_tasks` 排除，只能持 `STRONG_LANE_KEY` 用 `/next?lane=strong` 認領，見 `docs/decisions/2026-11-09-難題只給持鑰匙的強模型認領單一裁決即定案.md` |

（`manual_front_seconds(task_id)` 定義：`auto-overvoted` 0；visitor 10 年；`manual`／`auto_dispute` 5 年；其餘 0。）

> `suggested` 的寫入點（2026-11-07 Gemini審查核對）：① `task_suggestion` 貢獻通過後 `applyTaskSuggestion`（`_shared/apply-contribution.ts` 約 1757 行，`created_by`＝提議代理）；② `system-one?action=followups`：交件說明跟進 `settleSubmissionFollowup`（`system-one/index.ts` 約 130 行）與投票備註跟進 `settleVoteFollowup`（約 220 行），`task_type='other'`、`created_by='jev-followup'`——佔絕大多數；③ `system-one?action=bio-gap` 的 `bioGapTask`（約 1332 行，`created_by='jev-bio'`）。

**插隊來源一覽**

| 機制 | 做什麼 | 注意 |
|---|---|---|
| 維護者 `/boost`（Edge Function `boost`，RPC `task_boost`） | 對命中的列加一份 `queue_settings.boost_seconds`（5 年），`cooling=false`；**已存在的驗證票不隨母任務移位**（`20261104120000` 起票的基準凍結在 `dispatch_base_at`），要插某張票用 `/boost` 的 `task_ids` 指定票本身；母任務在派出前被插隊，派出後新產生的票基準會繼承那個位置 | 2026-11-04 起 POST 要維護者憑證（`20261104110000`，`boost-auth`）；不再先跑 seed（`20261019050000`，否則逾時）；只對已在佇列的列生效。**明確的 `/boost` 照舊可蓋過冷卻** |
| `cand_no_front_pull()` | 每小時 :03（pg_cron `cand-no-front-pull-hourly`）把補號次的任務、`cand_numbers`／含號次的 `candidacy` 驗證票、補號次的 `no_change` 驗證票，以及擋住號次缺口的同名人物合併任務（`target.cand_no_gap`，3×）往前拉：一般 2×`visitor_front_seconds`、縣市長／縣市議員 3×、當前提前職位（鄉鎮市長→原住民區長→鄉鎮市民代表→原住民區民代表→村里長，第一個還有缺口的）2.5× | **2026-11-28 之後直接回 0**；2026-11-07（`20261107000000`）起，`cool_until` 未過或 `task_in_check_cooldown`（查核階梯，2026-11-09 起）的不拉；補號次臂也不派不在中選會名冊上的人（`20261109190000`） |
| `manual_front_pull()` | seed 內叫；台北時間每小時前 20 分鐘（`visitor_front_slot_start()`，`visitor_front_slot_hours()`=1、`visitor_front_window_minutes()`=20（`20261008165000`），即每小時 :00、:10 兩輪 seed）把 visitor 臂 open 的列（從沒派過、或最後派出早於本時段）設成 `visitor_front_seconds` | 2026-11-07（`20261107010000`）起，2 天內有 `not_found` 查核的不拉 |
| 出生插隊 | 新手動任務的 `boost_seconds ＝ manual_front_seconds(task_id)`（上表） | BEFORE INSERT 觸發器 `trg_task_dispatches_nf_cooling_no_boost`（`20261107010000`）：uuid 任務出生時若 2 天內有 `not_found`，插隊歸零 |
| 一次性 migration | `20261029010000`（補號次 5 年）、`20261029040000`（號次驗證票）、`20261101050000` 與 `20261107020000`（`auto:roster_check:2026*` 沒插隊的各加一份；後者略過查無冷卻中與 blocked 的） | 只動當時已在佇列的列；派出歸零所以是一次性；7 天重開的新列不會自動插隊 |

### 2.5 冷卻與查無

- `task_checks`（每次查核一筆：`task_id`、`outcome`、`checked_at`）決定冷卻；`refresh_dispatch_blocked` 取同一任務**最晚**的結束時間為 `cool_until`。天數函式 `task_check_cooldown_days_for(task_id, outcome, checked_at, id)`（`20261107000000`）：

  | outcome | 天數 |
  |---|---|
  | `not_found`／`confirmed`（非例外任務，2026-11-09 起，協議 1.123.0） | **查核階梯**：同一任務兩種合計的第 n 次，天數取該筆 outcome 在 `task_check_ladder_settings.days` 的第 n 格（初值 `not_found`＝5／10／20、`confirmed`＝5／10），超過格數＝**結案**（`task_check_ladder_days()` 回 NULL；視圖 `task_ladder_closed` 列出；`auto:` 任務由 `refresh_dispatch_blocked` 永久 `blocked`、手動任務關閉） |
  | 例外任務（`task_check_ladder_exempt()`）的 `not_found` | 2（`task_not_found_cooldown_days()`）；進度類同任務第 2 次起 30（`not_found_repeat_days`）；**不結案** |
  | 例外任務的 `confirmed` 與其他 | 14（`task_check_cooldown_days()`） |
  | `unreachable`（連不上） | 2（`task_unreachable_cooldown_days()`），不進階梯 |

  例外（週期性重查、等官方公告）：`task_cooldown_settings.task_types`（`progress_stale`、`deadline_due`）、`not_running_recheck`、`roster_check`、`candidate_status_stale`、`election_result_missing`（`candidacy_source_missing` 的 `cand_no*` 號次缺口 2026-11-09 起不再是例外、走階梯，`20261109190000`）。TS 同一份 `LADDER_EXEMPT_TASK_TYPES`／`CHECK_LADDER_DAYS`（`apply-contribution.ts`），守門 `confirmed-direct.test.ts`。改階梯數字＝一行 `UPDATE task_check_ladder_settings`（TS 初值一起改）。

- 2026-11-07 起 `not_found` 的 `no_change` **不進投票**：交件當下直接 `applied`（`reviewed_by='system:not-found-direct'`），任務冷卻 2 天後回來；手動任務也只記一筆 `task_checks`、不關任務。2026-11-09 起 `confirmed` 的 `no_change` 也不進投票（`reviewed_by='system:confirmed-direct'`，協議 1.123.0），走同一條階梯；舊的等票中 confirmed 在 `20261109150000` 一次清掉。
- 設定表的 `not_found_first_days`（14）已不被函式讀（進度類第一次也是 2 天），僅 `task_cooldown_max_days()` 取最大值時還看得到。
- 「有人回報查無、在等票」的任務（`no_change` pending／verified）：`blocked`（auto）且 `contribution_queue_tasks` 也排除（手動任務），不派給任何人。

## 3. 即時快照（2026-11-07 約 08:22 台北；唯讀查詢，會過期）

欄位：`rows`＝佇列列數；`ready`＝不 blocked、不 cooling（**還沒套用認領／在途／已交過等逐請求過濾**，真實可派量更少）；`boosted`＝`boost_seconds>0`；`中位優先秒`＝`priority_seconds` 中位；`3h`／`24h`＝`dispatch_count>0` 且 `last_dispatched_at` 落在最近 3／24 小時的列數（**只看每列最後一次派出，一列多次派出只算一次，是下限**）。

| 臂／型 | rows | ready | boosted | 中位優先秒 | 3h | 24h |
|---|---:|---:|---:|---:|---:|---:|
| auto:profile_gap | 10,655 | 10,225 | 0 | 259200 | 4 | 34 |
| manual:suggested/other | 2,253 | 2,234 | 0 | 0 | 2 | 2 |
| auto:policy_missing | 1,832 | 1,719 | 0 | 0 | 1 | 4 |
| auto:term_policy_missing | 1,745 | 995 | 0 | −2592000 | 0 | 3 |
| verify（驗證票） | 1,049 | 1,049 | 100 | 259200 | 71 | 84 |
| auto:policy_elements_missing | 762 | 762 | 0 | 259200 | 0 | 0 |
| auto:duplicate_policy | 548 | 437 | 0 | 0 | 0 | 2 |
| auto:roster_check | 311 | 105 | 93 | −2592000 | 2 | 2 |
| auto:regional_stat_missing | 310 | 0 | 0 | −2592000 | 0 | 0 |
| auto:lineage_candidate | 202 | 185 | 0 | 0 | 2 | 10 |
| auto:policy_election_mismatch | 129 | 31 | 0 | −2592000 | 0 | 0 |
| manual:manual/candidate_status_stale | 120 | 117 | 0 | 259200 | 0 | 0 |
| auto:duplicate_politician | 110 | 110 | 0 | 0 | 0 | 0 |
| auto:policy_election_missing | 40 | 33 | 0 | 0 | 0 | 0 |
| manual:manual/news_sweep | 40 | 37 | 0 | 0 | 2 | 6 |
| auto:progress_stale | 37 | 26 | 0 | −2592000 | 0 | 0 |
| auto:lineage_roles_missing | 33 | 32 | 0 | 0 | 0 | 0 |
| manual:web_request/policy_missing | 33 | 25 | 25 | 259200 | 3 | 21 |
| auto:candidacy_source_missing | 32 | 22 | 2 | 259200 | 1 | 5 |
| auto:legacy_audit | 24 | 23 | 0 | 0 | 0 | 0 |
| manual:web_request/profile_gap | 21 | 15 | 15 | 259200 | 2 | 5 |
| auto:profile_detail_gap | 10 | 10 | 0 | 0 | 0 | 0 |
| auto:policy_validity | 10 | 10 | 0 | 259200 | 0 | 0 |
| auto:lineage_link_candidate | 10 | 10 | 0 | 0 | 0 | 0 |
| manual:manual/other | 8 | 3 | 0 | −2592000 | 0 | 0 |
| 其餘（各 ≤ 5 列：suggested/source_mismatch、suggested/candidacy_source_missing、auto_dispute/avatar_choice 5、auto_dispute/adjudicate 2、auto:party_info_missing 5、suggested/policy_missing 3、suggested/policy_source_missing 3、suggested/profile_gap 2、suggested/term_policy_missing 1、suggested/policy_election_mismatch 1、web_request/progress_stale 1、auto:deadline_due 1、auto:district_seats_missing 1） | 約 36 | 約 33 | 1 | — | 1 | 1 |

補充（同時間查）：

- `candidacy_source_missing` 的 32 列：`cand_no` 10（村里長 8、鄉鎮市民代表 1、原住民區民代表 1）、`cand_no_recheck` 22（村里長 15、縣市議員 2、鄉鎮市民代表 5）；其中 cooling 11。號次已幾乎補完。
- `roster_check` 311 列依職位：鄉鎮市民代表 144（cooling 134）、村里長 113（boosted 70）、縣市議員 23、縣市長 17、原住民區民代表 7、鄉鎮市長 3、立委 2、總統 1、原住民區長 1。
- `contribution_tasks`（手動任務表）open／closed：`web_request` 1,076／4,571、`suggested` 2,273／533、`manual` 168／462、`auto_dispute` 7／233；本表 open 比佇列列數多，差在停放（`web_request_parked`）與已被臂輸出濾掉的。差額來自 `contribution_auto_tasks_manual`（`20261028130000`）的兩道過濾：`NOT web_request_parked(t.id)`（村里長、鄉鎮市民代表缺政見的網站請求在公報前停放，佔絕大部分）與已收滿答案的公民提問；`20261111010000` 起再多一道 `NOT EXISTS web_request_coverage`（缺政見請求被同一人的既有缺口覆蓋，2026-11-10 正式庫 57 件）。
- 以 `policy_missing` 的**中位列**為準，它前面（可派、`queue_at` 更早）有：`profile_gap` 4,058、`policy_missing` 自己 857、驗證票 653、手動任務 228、`duplicate_policy` 196、`roster_check` 92、`lineage_candidate` 90，其餘各 ≤ 17。

## 4. 已知的坑（2026-11-07 查到的）

1. **插隊蓋過冷卻，查無的任務每小時被重派**（已修）。`cooling` 是排序鍵視界、不是閘門（第 1.2 節）；`cand_no_front_pull` 與 `manual_front_pull` 每小時把列的插隊秒數拉到幾年以上，鍵變成遠古、`cooling` 算出 false，查無剛記完的任務下一小時又回隊頭。實例：補號次的任務一輪裡被派了 49 次。修法：PR #875（`20261107000000`：查無 2 天不進票、冷卻 2 天、`cand_no_front_pull` 冷卻中不拉）與 PR #876（`20261107010000`：`manual_front_pull`、出生插隊、舊資料清理同樣略過查無冷卻）。**教訓**：新增任何「加 `boost_seconds`」的路徑，都要自己判斷 `cool_until`／近期 `not_found`；佇列不會替你擋。
2. **`policy_missing` 優先秒數 0，排在 `profile_gap` 後面**。規則 39 把非縣市長 × 公報前的 `policy_missing` 壓在 0（原因：政見原文多半要等選舉公報，2026-10-08 盤點 607 筆查無），而同一個 `priority:*` 前段讓 `profile_gap` 等多數臂拿到 +3 天，加上驗證票（−14 天基準）也在前面；實測中位 `policy_missing` 列前面有約 4,000 件 `profile_gap`（第 3 節）。24 小時內被領走的 `policy_missing` 只有 4 列。**開放問題（待維護者裁示）**：公報上架日（`elections.bulletin_published_on`）之後規則 39 自動停用、回到前段；在那之前要不要手動提層，屬規則本身（流程規則歸維護者決定）。本文只記現況，不建議改。
3. **`roster_check` 餓死**。名冊對帳臂在 +3 天前段之外（歷史上落在後段 −30 天或排在 1.2 萬件可派列之後），2026-11-01 與 11-07 各用一次性插隊救一次（`20261101050000`、`20261107020000`/PR #877）。現況 311 列中 93 列 boosted；插隊是一次性的，派出後歸零，要再救要再插一次。
4. **多人手動任務與名冊對帳暫停**（2026-11-07，`20261107030000`）。`target.multi_person = true` 的手動任務（created_by `roster-group-2026-11-07`，一張 6～8 位）跟 `question`／`adjudicate`／`roster_check` 一樣不因一筆交件而停放或被 `task_dispatches_drop_applied` 收回（SQL `task_target_multi_person()`、TS `isMultiPersonTarget()`），仍受在途 5 筆上限；`roster_group_tasks_sweep()` 每小時對帳，差異消失才關。**逐人查核階梯（2026-11-09，`20261109210000`，協議 1.125.0）**：多人任務的 `no_change`（not_found／confirmed／unreachable）逐位寫 `task_checks`（鍵 `roster_group_check_task_id()`：掛錯人＝`auto:candidacy_owner_mismatch:<pe_id>`、其餘＝`auto:roster_group_person:<person_key>`），階梯（not_found 5/10/20、confirmed 5/10）逐位累計；冷卻中的人不寫進說明、結案的人對帳時移出且不再開新任務；`refresh_dispatch_blocked()` 只有剩下的人全部冷卻時才冷卻分組任務（`cool_until`＝最早結束的那位）。dup 另排除已有 `politician_pair_resolutions`＝different 的一對。2026 名冊對帳由 `activity_overrides`（`raw:roster_check`、`roster_villages`，election_id 2026，closed）暫停，`auto:roster_check:2026:*` 派工列隨 seed 收回；回復＝`DELETE FROM activity_overrides WHERE created_by = 'roster-group-2026-11-07'`。第 3 節快照裡的 `auto:roster_check` 與 `manual:manual/candidate_status_stale` 兩列因此會消失。
5. 政策：不寫 migration 直接補資料（見 `CLAUDE.md`「資料走流程」）；缺口先看是哪個臂、排在哪裡，再決定要調規則、插隊或補臂。

（gcloud metadata 之類的環境問題不在本文範圍。）

## 5. 怎麼查（唯讀；`npx -y supabase@2 db query --linked -f <檔>`，檔案第一行 `SET default_transaction_read_only = on;`，一檔一句）

**A. 佇列組成與健康度（每臂列數、可派、冷卻、插隊、近期派出）**

```sql
WITH x AS (
  SELECT d.*, CASE WHEN d.task_id LIKE 'verify:%' THEN 'verify'
                   WHEN d.task_id LIKE 'auto:%' THEN 'auto:' || split_part(d.task_id, ':', 2)
                   ELSE 'manual:' || coalesce(t.source, '?') || '/' || coalesce(d.task_type, '?') END AS arm
    FROM task_dispatches d LEFT JOIN contribution_tasks t ON t.id::text = d.task_id
)
SELECT arm, count(*) n,
       count(*) FILTER (WHERE NOT blocked AND NOT cooling) ready,
       count(*) FILTER (WHERE blocked) blocked, count(*) FILTER (WHERE cooling) cooling,
       count(*) FILTER (WHERE boost_seconds > 0) boosted,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY priority_seconds) med_pri,
       count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at > now() - interval '3 hours') d3h,
       count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at > now() - interval '24 hours') d24h
  FROM x GROUP BY arm ORDER BY n DESC;
```

**B. 某一臂前面排了誰**（把 `'auto:policy_missing'` 換成要看的臂；用中位列當基準，改 `min(queue_at)` 看隊頭）

```sql
WITH q AS (
  SELECT task_id, queue_at,
         CASE WHEN task_id LIKE 'verify:%' THEN 'verify'
              WHEN task_id LIKE 'auto:%' THEN 'auto:' || split_part(task_id, ':', 2) ELSE 'manual' END AS arm
    FROM task_dispatches
   WHERE NOT blocked AND (NOT cooling OR queue_at < '2000-01-01')
), head AS (
  SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY queue_at) h FROM q WHERE arm = 'auto:policy_missing'
)
SELECT arm, count(*) ahead FROM q, head WHERE q.queue_at < head.h GROUP BY arm ORDER BY ahead DESC;
```

**C. 找「冷卻還沒過卻被插隊」的列**（第 4 節第 1 點的檢查；正常應為 0 或只有維護者明確 `/boost` 的）

```sql
SELECT task_id, boost_seconds, cooling, cool_until, dispatch_count, queue_at
  FROM task_dispatches WHERE boost_seconds > 0 AND cool_until > now() ORDER BY queue_at LIMIT 50;
```

2026-11-07 查到 1 列：`auto:candidacy_source_missing:cand_no:2026:村里長:新竹市:香山區`（`boost_seconds` 630720000＝20 年，`cool_until` 11-15、`dispatch_count` 0）。原因：`20261107000000` 之前被 `cand_no_front_pull` 拉到 20 年；它最近的查核是 `confirmed`（冷卻 14 天）而不是 `not_found`，該 migration 第 4 節只清「2 天內有 `not_found`」的列的殘留秒數，所以沒被清。現在的 `cand_no_front_pull` 不會再拉它，派出一次就歸零。

**D. 現在真正的隊頭是誰、哪些是同機器可領的**（隊頭預覽；真實 `/next` 還要再套認領與同機器過濾）

```sql
SELECT task_id, task_type, queue_at, boost_seconds, priority_seconds, dispatch_count
  FROM task_dispatches
 WHERE task_id NOT LIKE 'verify:%' AND NOT blocked AND (NOT cooling OR queue_at < '2000-01-01')
 ORDER BY queue_at LIMIT 30;
```

（驗證票的隊頭另看 `WHERE task_id LIKE 'verify:%' ORDER BY queue_at`；真正可領還要過 `contribution_verify_pool`。）

要看即時的 `/next` 會派什麼，直接呼叫 `contribution_queue_tasks(p_limit => 20)`（`p_ip_hash`、`p_agent` 不帶就不套同機器過濾）。

## 6. 對照檔案

- 排序鍵、冷卻、`cooling`：`supabase/migrations/20261011320000_queue_priority_seconds.sql`、`20261107000000_not_found_no_verify_2d.sql`、`20261107010000_manual_front_pull_skips_not_found_cooling.sql`
- `contribution_queue_tasks` 合格條件：`20261017000301_queue_tasks_eligibility_before_limit.sql` 與其後的修訂（以正式庫 `pg_get_functiondef` 為準）
- 驗證票：`20261017010000_verify_ticket_follows_task.sql`、`20261104120000_verify_ticket_key.sql`、`20261028140000_no_change_verify_defer.sql`（延後欄位已不用）
- 插隊：`20260921000030_single_queue_boosts.sql`、`20261019050000_boost_no_seed.sql`、`20261104110000_boost_maintainer_only.sql`、`20261029050000_cand_no_front_pull_hourly.sql`（之後多次改定義，現行見 `pg_get_functiondef`）
- 停放：`20261028130000_park_village_policy_web_requests.sql`
- 網站請求併入缺口：`20261111010000_web_request_merge_gap.sql`（視圖 `web_request_coverage`、函式 `web_request_gap_sync()`／`web_request_gap_boost()`／`web_request_close_filled()`、pg_cron `web-request-gap-sync-10min`；決策 `docs/decisions/2026-11-11-網站請求併入既有缺口.md`）
- `/next`：`supabase/functions/next/index.ts`、`supabase/functions/_shared/dispatch.ts`（`pickQueueHead`）
- 規則與決策的來源：`CLAUDE.md`「派工佇列」條目、`docs/DECISIONS.md`、`docs/PIPELINE.md`（自動缺口任務一覽）、`docs/PLAN-tasks-as-rows.md`（歷史設計）

## 7. 任務分類（Jev 估難度／時間／模型強度，2026-11-08，階段 1）

- 派工列（不含 `verify:`）由 `system-one?action=task_estimate` 請 Jev 一次問四題：難度（簡單／中等／困難）、預估時間（≤10／10–30／30–60／>60 分）、需要的模型（便宜模型可／要強模型）、主要難點（OCR／跨來源比對身分／找新聞／只查一個官方頁／其他）。state 由 `task_type`、`target` 摘要（人數、項目數、前幾個名字）、`what_we_need` 組成（`_shared/task-estimate.ts`）。
- 存：側表 `task_estimates`（每任務一列、現行答案）＋ `jev_decisions`（`subject_type=task`，題目 `task_difficulty`／`task_time`／`task_model`／`task_hardness`，成本照舊記在這）。重問條件由 `task_estimate_candidates()` 判：沒估過、`target_hash`（task_type＋target）變了、或題目版本 `TASK_ESTIMATE_VERSION` 不同。
- 曝露：`/next` 的 `item.estimate`（沒估過是 `null`）。**階段 1 不影響派工順序、不排程（沒有 cron）。**
- 守門 `task-estimate.test.ts`（Jev 與資料庫 stub）。

## 8. work_key：工作卡鍵（2026-11-11，migration `20261111100000`，不升協議版）

- **是什麼**：同一人×同一件事同一個鍵，跨臂、跨指紋、跨手動任務。SQL 函式 `task_work_key(task_id, target)` 從現有 `task_id`（手動任務查 `contribution_tasks`）算，不改任何臂的輸出；對應表在 migration 檔頭（`activity_arm_names()` 逐臂列出）。形狀：`politician:<pid>:policies:<屆>`（`policy_missing` 與 `term_policy_missing` 同人同屆同鍵，網站請求缺政見也是同一張）、`politician:<pid>:profile`、`policy:<policy_id>:<臂>`、`unit:<屆>:<型>:<縣市[:鄉鎮]>:<need>[:pN]`、帶指紋的臂去掉末段指紋、其餘 auto 臂原樣；`verify:<id>` 取母任務的鍵。
- **存在哪**：`task_dispatches.work_key`（BEFORE INSERT／UPDATE OF task_id, target 觸發器）、`task_checks.work_key`、`contribution_task_leases.work_key`（BEFORE INSERT 觸發器，TS 不算；算不出來的 task_checks 用 `task:<task_id>`）。
- **誰認它**：①查核階梯（視圖 `task_ladder_closed`、`task_check_cooldown_days_for` 按 `work_key` 累計，結案輸出這張卡現在的每個任務代號）②`refresh_dispatch_blocked` 的 `cool_until` 取同一張卡最晚的查核 ③租約：`contribution_queue_tasks` 與 `_shared/dispatch.ts` 的 `filterLeasedTasks` 除了原本的 `target_key`（整個人／整條政見）也比 `work_key`（只多擋、不少擋）。換號（指紋變）不用搬資料：新列鍵相同，`task_checks` 自然延續。
- **階梯狀態與插隊拉回**：`work_key_ladder_state(p_work_key)`（可下推，只掃這個鍵）算一張卡的累計次數、是否結案、最晚冷卻；視圖 `task_ladder_closed`、`task_in_check_cooldown`、`refresh_dispatch_blocked` 都呼叫它。`manual_front_pull`、`cand_no_front_pull`、手動任務出生觸發器、#912 的請求併入缺口本來就問 `task_in_check_cooldown`，所以插隊拉回也按卡判冷卻。**auto: 任務同卡一起永久 blocked 是刻意的；手動任務（網站請求、提議）只在它自己的查核結案時才被關，卡結案時留 open、不派。**租約：驗證票的租約不帶 work_key（驗證者領票不擋母任務的卡）；`contribution_queue_tasks` 的 SQL 在 `p_ip_hash` 為 NULL 時也排除別人的 work_key 租約；TS `filterLeasedTasks` 的 work_key 比對目前不生效（佇列函式回傳型別沒有這欄，等第二次上再接）。
- **換屆流程要跑 `SELECT * FROM work_key_recompute();`**：`policy_missing` 的鍵含 `campaign_election_id()`，2028 新增進 elections 之後舊列的鍵不會自己重算；這支重算三張表、只動鍵變了的列。觸發器在 `UPDATE OF task_id` 時直接重算。
- **上線前可查（唯讀，migration 套用後跑；先 `SET default_transaction_read_only = on;`）**：新視圖會讓幾張卡結案、幾件 auto 列會變永久 blocked——`SELECT count(*) AS closed_cards FROM (SELECT DISTINCT work_key FROM task_checks) k CROSS JOIN LATERAL work_key_ladder_state(k.work_key) s WHERE s.closed;` 與 `SELECT count(*) FILTER (WHERE d.task_id LIKE 'auto:%') AS auto_rows_blocked_by_card FROM task_dispatches d WHERE EXISTS (SELECT 1 FROM task_ladder_closed lc WHERE lc.task_id = d.task_id);`（後者與改前的 `blocked` 欄位現況相比）。
- **注意**：`policy_missing` 的屆別用 `campaign_election_id()`，換屆（2028 新增）時舊列的鍵不會回頭改。新增派工臂：task_id 長相若不是既有形狀，要在 `task_work_key` 補一段並在 `work-key.test.ts` 加樣本。守門 `_shared/work-key.test.ts`。
