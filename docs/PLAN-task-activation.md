# 派工與排程的啟用時間窗：以「選舉里程碑」為座標的通用規劃

> 狀態：**已裁決，照 P0→P2 實作**（2026-10-07 維護者裁示第 10 節 1、2、5 項；其餘照本檔建議）。
> 起因：#425 為 `term_policy_missing` 建了 `election_task_config`，維護者的回應是「不要一次一次手動調整——台灣一年只有一次選舉，日本一年有很多次」。
> 所以這份規劃的主軸不是「幫每一支臂加啟用日期」，而是：**每場選舉有自己的里程碑日期；每種任務、每支排程只寫「相對於里程碑的規則」；新增一場選舉只要在 `elections` 填一列，所有時間窗自動成立。絕對日期只當例外覆寫。**

事實標記：【查】＝2026-10-07 唯讀查正式庫、讀正式庫函式定義或讀程式確認過；【未查】＝合理推測或要向外部確認的，列在待決事項。

---

## 0. 十行重點

1. 現況：28 支 `contribution_auto_tasks_*` 臂＋34 條 cron，「何時派」散在四種寫法——**寫死 `election_id = 2026`**（5 支臂）、**拿 `election_date`／登記截止日跟 `CURRENT_DATE` 比**（約 12 處，已經是「事件相對」，只是各寫各的）、**開關表**（`roster_check_scope.enabled`、`news_settings.enabled`、`news_sweep_feeds.enabled`、#425 的 `election_task_config.enabled`）、**純 cron**。沒有任何一處能讓「新增一場選舉」自動長出時間窗。
2. 設計：三張表＋一個判斷函式——`election_milestones`（每場選舉×里程碑一列，帶日期與日期的依據）、`activity_rules`（每支臂／排程一到多條「里程碑＋偏移天數」的規則，可限定選舉事由、層級、職位）、`activity_overrides`（例外覆寫的絕對日期，每筆留紀錄）、`activity_open(活動, 選舉, 職位, 今天)`。
3. 判斷放在 `contribution_auto_tasks_arms()` 這個唯一的入口：它本來就把所有臂 UNION 起來，在每個分支貼上「臂名」標籤、再過一道規則過濾；**不用改 28 支臂的簽名**。`seed_auto_task_queue()` 本來就會把「缺口不存在了」的派工列收回，所以窗口關閉＝自動收回，不用另寫收回邏輯。
4. 時間：台北時間（日本站東京時間）的日界、含頭含尾、以日曆天計；里程碑缺日期＝窗口關閉（寧可不派）。
5. 誰能改：**規則改 migration**（它是流程規則，跟門檻同級，要維護者裁、要有 PR 與差集守門）；**里程碑日期走貢獻流程**（代理交件、官方來源、投票通過才落庫，延期／補選照同一條路）；**覆寫表只寫得進去的是 service_role 經端點，每筆進 `edit_history`**。
6. 遷移：每一步「今天派工結果逐件不變」——先建表與入口（所有規則種子＝永遠開），再一支臂一支臂把現有條件翻成規則，每步用 `scripts/term-policy-parity.ts` 的方法（PGlite 灌正式庫唯讀快照、全欄雜湊三方相等）加假時鐘測試守門。
7. **選舉本身也自動收錄**（第 7 節）：每月掃描，官方結構化來源（中選會場次清單）能讀的由系統比對，讀不到的派新任務型別 `election_discovery` 給代理；2028 總統立委選舉當驗收案例（第 8 節）。
8. 日本站（policy-jp）目前是虛構樣品、純 JSON、沒有派工，但它的選舉結構（每個自治体各自選舉、`notice_date`、任期各自起算、一年多場）正是這個模型要吃得下的。第 6 節把兩國共用的欄位詞彙定下來。
9. 與既有表：`election_task_config` 併進規則（參數留在 `params`）、`roster_check_scope` 的兩個日期搬成里程碑（其餘欄位保留）、`news_settings`／`news_sweep_feeds` 保留（它們是「全域開關與來源清單」，不是時間窗）、`cec_sync_phase()` 的三層窗改成規則。
10. 需要維護者決定的事在第 10 節，最重要三件：里程碑用「窄表」還是「寬欄位」、預估日期的選舉列要不要先建（影響 `election_key` 不可變的規則）、`election_discovery` 的票數門檻。

---

## 1. 盤點：現在每種任務怎麼決定「何時派」

### 1.1 派工臂（`contribution_auto_tasks_arms()` 目前 UNION 的 28 支，【查】正式庫函式定義；另有 `contribution_auto_tasks_profile_details` 這支函式還在、但已不在入口裡）

`seed_auto_task_queue()` 每 10 分鐘算一次全部（函式註解「約 1.5 秒」），把結果寫進 `task_dispatches`；`/next` 只讀 `task_dispatches`。

| 臂（函式） | 產出的 task_type | 「何時派」現況 | 寫法 |
|---|---|---|---|
| `raw` 的 policy_missing | policy_missing | 2026 候選人、非退選、名下零政見 | **寫死 `election_id = 2026`** |
| `raw` 的 profile_gap | profile_gap | 2026 候選人缺生年／現職／照片 | **寫死 2026** |
| `raw` 的 candidacy_source_missing | candidacy_source_missing | 2026 參選紀錄沒有可查證的網址 | **寫死 2026** |
| `raw` 的 roster_check | roster_check | `roster_check_scope.enabled`；`recheck_days` 與嘗試冷卻（2026-10-08 起：最近一次回報的 `cec_count` 大於我們的名冊內人數 時不套 `recheck_days`，見 DECISIONS 10-08）；「登記階段／審定名單階段」文案看 `CURRENT_DATE >= list_announced_on` | 開關表＋日期比較（登記截止「2026-09-04」另寫死在文案裡） |
| `raw` 的 candidate_status_stale | candidate_status_stale | `registration_closed_on <= CURRENT_DATE` 而狀態還是傳聞／考慮 | 日期比較 |
| `raw` 的 progress_stale | progress_stale | 90 天沒進度；**競選承諾要 `election_date < CURRENT_DATE`**；落選／退選排除 | 日期比較 |
| `raw` 的 election_result_missing | election_result_missing | `election_date < CURRENT_DATE`＋結果空白＋名下有政見 | 日期比較 |
| `raw` 的 policy_validity／policy_election_missing | 同名 | 全站、無時間窗 | — |
| `dup`／`policy_dup`／`legacy` | duplicate_politician／duplicate_policy／legacy_audit | 全站、無時間窗（`jev_pair_exclusion_days` 冷卻） | — |
| `mismatch` | policy_election_mismatch | 提出日期晚於所屬屆別投票日；當選者任內施政排除 | 日期比較 |
| `not_running` | not_running_recheck | **登記截止日 ≤ 今天 且 投票日 ≥ 今天**（登記截止→投票日的窗，已經是事件相對） | 日期比較 |
| `withdrawn_filing` | not_running_recheck | 同上一支的「退選前有沒有登記」；`voted` 旗標決定文案 | 日期比較 |
| `mayor_policies` | policy_missing（縣市長） | 2026 屆政見＋佇列中少於 5 筆 | **寫死 2026** |
| `term_policies` | term_policy_missing | #425 起讀 `election_task_config`（2022、2024 開、2026 關）；去重條件仍寫死 `c.election_id = 2026` | 開關表＋1 處寫死 |
| `roster_villages` | roster_check（村里長） | 2026 村里長＋`roster_check_scope` | **寫死 2026**＋開關表 |
| `township_gap` | candidacy_source_missing | 2026 鄉鎮層級缺鄉鎮 | **寫死 2026** |
| `region_gap` | candidacy_source_missing | 缺縣市／選區（說明文字有 2026 條件） | 部分寫死 |
| `elected_missing` | election_result_missing（名冊有、我們沒有） | `cec_candidates` 有該屆的列才算得出——隱含「已投票且已同步」 | 資料出現 |
| `roster_cec_gap` | roster_check | `election_id IN (SELECT election_id FROM cec_candidates)`；30 天冷卻 | 資料出現 |
| `district_seats` | district_seats_missing | 所有屆別；`election_date < CURRENT_DATE` 只切文案 | 日期（只切文案） |
| `policy_elements` | policy_elements_missing | 未投票：在選的人；已投票：當選且未達成 | 日期比較 |
| `deadline_due` | deadline_due | 達成期限已過；競選承諾要 `election_date < CURRENT_DATE` | 日期比較 |
| `lineage_candidates`／`lineage_links` | lineage_candidate／lineage_link_candidate | 無時間窗 | — |
| `handover_missing` | handover_missing | `from_term_end < CURRENT_DATE`（前一任的任期已結束；**任期相對**） | 日期比較（任期） |
| `lineage_roles` | lineage_roles_missing | 當選者、`election_date < CURRENT_DATE` | 日期比較 |
| `career_sources` | profile_detail_gap | 無時間窗 | — |
| `party_gap` | candidacy_source_missing（缺政黨） | 已投票屆（`election_date < CURRENT_DATE`）照中選會名冊 | 日期比較 |
| `party_roster` | candidacy_source_missing（缺政黨） | 未投票屆（`election_date >= CURRENT_DATE`）照登記彙總表 | 日期比較 |
| `party_info` | party_info_missing | 無屆別，只派網站有用到的政黨 | — |
| `placeholder_politicians` | placeholder_politician | 無 | — |
| `election_results` | election_results_missing／election_result_missing | `election_date < CURRENT_DATE`、中選會名單唯一對上的依單位整批 | 日期比較 |
| `owner_mismatch` | candidacy_owner_mismatch | 無時間窗（文案提到 2026） | — |

小計：寫死 2026 的 5 支（`raw` 三段、`mayor_policies`、`roster_villages`、`township_gap`、`region_gap` 的條件；另 `term_policies` 的去重 1 處）；已經用 `election_date`／登記截止日比較的約 12 處；完全沒有時間窗的約 9 支；其餘靠開關表或資料出現。

### 1.2 不經過 `contribution_auto_tasks_arms()` 的派工與排程（【查】`cron.job` 共 34 條）

| 活動 | 現況 | 「何時」怎麼決定 |
|---|---|---|
| `cec-sync`（5 條週排程＋#423 的 3 條） | 2022、2024、補選重行選舉各一條硬寫屆別的週排程；2026 起由 `cec_sync_phase(投票日, 事由, 現在)` 決定 live／settle／weekly 三層 | **一支 SQL 函式裡的三個窗口**（投票日 08:00 UTC 起 3 天、到第 14 天…）；2022、2024 仍寫死 |
| `cec-reconcile-weekly` | 每週六 20:30 開「查無此人／縣市不符」任務（`contribution_tasks` 手動型任務） | cron |
| `news-sweep-refresh`（每小時 15 分） | 對 `news_sweep_feeds.enabled` 的來源各開一件 `news_sweep` 任務，`recheck_hours` 過期才重開；說明文字寫「2026 候選人」 | 開關表＋冷卻＋文案寫死 |
| `news-fetch-hourly`＋`system-one?action=news_screen` | `news_settings.enabled`、`daily_task_cap`（每日上限）、`screen_every_hours` | 全域開關（單列表） |
| `results-batch-10min`／`roster-batch-10min`／`reassign-check-10min`／`system-one-*` 系統票排程 | 撿「還沒核過的」交件，不看選舉 | 資料出現；不屬時間窗 |
| `politician-offices-close-daily`（每日 00:05 UTC） | `scheduled_end_date < 今天` 的任期寫 `end_date` | **任期相對**（`election_term_end`） |
| `seed-auto-task-queue-10min` | 上面所有臂的總入口 | 每 10 分鐘 |
| `cec-verify-10min`、`apply-verified-10min`、`source-archive-10min`… | 處理佇列 | 與選舉無關 |

### 1.3 現有的各種「設定表」（【查】欄位）

| 表 | 欄位 | 範圍 |
|---|---|---|
| `elections` | `id, election_key, election_date, election_reason, election_types[], notice_date（目前全空）, start_date, end_date（舊欄位，名不副實）, turnout` | 一場一列：2022、2024、2026、4（嘉義市重行） |
| `roster_check_scope` | `election_id, election_type, enabled, regions[], recheck_days, registration_closed_on, list_announced_on` | 2026 七種職位各一列，兩個日期是「所有職位同一天」 |
| `election_task_config`（#425） | `election_id, positions[], bulletin_roc_year, bulletin_hint, scope_note, enabled, note` | 只管 `term_policy_missing` |
| `news_settings` | 單列：`enabled, daily_task_cap, screen_every_hours` | 全域 |
| `news_sweep_feeds` | `feed_url, label, enabled, recheck_hours` | 來源清單 |
| 函式 `election_term_start/end(election_id, type)`、`office_term_start/end` | 就任日、屆滿日由「投票年份＋職位」算（地方 12/25、立委 2/1、總統 5/20）；補選暫以投票日 | 程式碼裡的規則 |

**缺什麼（對照維護者要的里程碑）**：登記開始、登記截止（只在 `roster_check_scope`，且 2022／2024 沒有）、名單公告（同上）、號次抽籤、公報上架、結果公告、當選確定（當選證書）、就任日（有函式、沒有列）。`elections.notice_date` 欄位在、但 4 列全是空的。

---

## 2. 設計主軸：里程碑＋偏移天數的規則

### 2.1 里程碑（每場選舉×里程碑一列，窄表）

建議用一張**窄表**而不是在 `elections` 上一直加欄位，理由：兩國的里程碑不一樣（日本沒有「登記截止」那麼長的登記期，告示日當天就是登記日；台灣有抽籤、公報上架），窄表加一種里程碑只是加一個種類值，不用 migration。

```
election_milestones (
  election_id   integer  -> elections(id),
  kind          text     -- 見下表的通用詞彙
  election_type text NULL -- 只對某個職位有效時填（縣市長的名單公告可能比議員早）；空＝整場選舉
  on_date       date     -- 當地時區的日期
  basis         text     -- statutory（法定推算）｜official（官方公告）｜agent（代理交件、投票通過）｜override（維護者例外覆寫）
  status        text     -- expected（預估）｜announced（已公告）｜done（已發生）
  source_id     bigint NULL  -> sources
  note          text
  updated_at    timestamptz
  PRIMARY KEY (election_id, kind, COALESCE(election_type, ''))
)
```

通用里程碑詞彙（**兩國共用**；台灣沒有的留空、日本沒有的留空）：

| kind | 台灣（正見） | 日本（policy-jp） | 現況來源 |
|---|---|---|---|
| `announced` | 選舉公告日 | 告示日（公示） | `elections.notice_date`（全空）|
| `registration_open` | 候選人登記開始 | 告示日＝届出受付日 | 無 |
| `registration_close` | 登記截止 | 告示日當天（同一日） | `roster_check_scope.registration_closed_on` |
| `list_published` | 審定名單公告 | 告示日（立候補届出後即公示） | `roster_check_scope.list_announced_on` |
| `draw` | 號次抽籤 | （無，日本以届出順或抽籤，各選管） | 無 |
| `bulletin_published` | 選舉公報上架 | 選挙公報発行 | 無 |
| `polling` | 投票日 | 投票日 | `elections.election_date` |
| `result_announced` | 開票結果公告 | 当選告示 | 無 |
| `certified` | 當選確定（當選證書、爭訟期結束） | 当選確定 | 無 |
| `term_start` | 就任日 | 任期開始（各自治体各職位不同） | 函式 `election_term_start` |
| `term_end` | 任期屆滿日 | 任期満了日 | 函式 `election_term_end`／`politician_offices.scheduled_end_date` |

- `polling` 同步自 `elections.election_date`（單一真相仍是 `elections.election_date`，視圖補成里程碑），不重複存。
- `term_start`／`term_end` **不存在窄表裡**，由視圖 `election_milestones_all` 從 `election_term_start/end`（台灣）與 `politician_offices`（日本：每個任期各自起訖）算出來並 UNION 進來——這樣規則「就任日 +90 天」對兩國一致，也不會有兩份任期日期。
- 日期要有「依據」：`basis`＋`status` 表達**這個日期有多確定**。規則可以要求「至少 announced 才算數」（見 2.2 的 `min_status`），避免用預估日期就把大量任務派出去。

### 2.2 規則（每支臂／排程一到多列）

```
activity_rules (
  id             bigserial PK
  activity       text       -- 活動名：臂名（例 'term_policies'、'progress_stale'）或排程名（'cec_sync'）
  window_kind    text       -- 'event'（相對事件）｜'term'（相對任期）｜'recurring'（任期內每年的某段月份）｜'always'
  from_kind      text NULL  -- 里程碑 kind；NULL＝不設起點
  from_offset    integer    -- 日曆天，可為負（登記截止 −0、投票日 +1、就任日 +90）
  until_kind     text NULL
  until_offset   integer
  min_status     text DEFAULT 'announced'  -- 起點里程碑至少要到這個確定程度
  recur_months   int4range NULL            -- window_kind='recurring'：任期內每年 1–3 月
  -- 限定範圍（全空＝不限）
  reasons        text[] NULL   -- election_reason（regular／by_election／rerun／recall／日本的 resignation…）
  levels         text[] NULL   -- national／regional／local（見第 6 節）
  election_types text[] NULL   -- 職位
  jurisdictions  text[] NULL   -- 'tw'、'jp'、'jp:130001'
  params         jsonb         -- 臂自己的參數（term_policies 的 positions、bulletin_hint、scope_note；roster_check 的 recheck_days、regions）
  enabled        boolean DEFAULT true   -- 全域開關（這條規則關掉＝該活動在這個範圍內不派）
  note           text
)
```

- **同一個活動可以有多條規則（OR）**：例如 `progress_stale` 對「競選承諾」是 `from polling +1`，對「任內承諾」是 `window_kind='term'`、`from term_start +90`；`not_running` 是 `from registration_close` 到 `polling`；`election_results` 是 `from polling +1`、到 `certified`（之後還沒補齊的交給 `weekly` 規則）。
- **同一條規則吃所有選舉**：規則不指名 `election_id`，而是「對每一場符合範圍的選舉各自算窗口」。2026 與 2028 用同一條規則，各自有各自的投票日。這就是維護者要的「不用一次一次調」。
- **例外覆寫**才指名選舉與絕對日期（2.3）。

窗口判斷函式（概念）：

```
activity_open(p_activity text, p_election_id int, p_election_type text, p_today date) RETURNS boolean
-- = 存在一條 enabled 的規則，範圍符合這場選舉／職位，
--   且 (從起點里程碑算出的起日 <= p_today <= 迄日算出的迄日，兩端都含)，
--   且起點里程碑的 status >= min_status
--   且沒有被 activity_overrides 關閉；若有覆寫日期則以覆寫日期為準。
```

不屬於任何選舉的臂（`dup`、`policy_validity`、`lineage_*` 等約 9 支）：規則 `window_kind='always'`、`levels` 空——種子一律寫「永遠開」，只是讓「所有活動都在同一張表裡看得到」。

### 2.3 例外覆寫（絕對日期只在這裡）

```
activity_overrides (id, activity, election_id NULL, election_type NULL,
                    force text  -- 'open'｜'closed'｜'window'
                    open_from date NULL, open_until date NULL,
                    reason text NOT NULL, created_by text, created_at, expires_at NULL)
```

用途：某次延期、某場選舉要提早啟動、緊急關掉一支出問題的臂（不用等 migration）。`reason` 必填、`expires_at` 建議必填；每次寫入記 `edit_history`（見第 4 節）。**覆寫不是常態**：如果同一個覆寫反覆出現，代表規則寫錯了，回頭改規則。

### 2.5 每個缺口都有出生紀錄（2026-10-07 維護者裁示）

> 維護者：「所有的缺口都要有一筆記錄去計算它什麼時候產出這個缺口。」

現況【查】：`task_dispatches` 只有 `queue_at`、`last_dispatched_at`、`refreshed_at`，**沒有「這個缺口何時出現、因為哪一筆資料出現」**；缺口補上時派工列被 DELETE，歷史也跟著消失。

規則：
1. **缺口的開啟日一定由一筆資料算出來**：`activity_open()` 回傳的不只是真假，而是「開窗的那條規則＋那筆里程碑（`election_id`、`kind`、`on_date`）」。沒有對應里程碑就不開（fail closed）；P1 的 `always` 種子也要是一條有名字的規則列，不是程式裡的常數。
2. **派工列記出生**：`task_dispatches` 加 `opened_at`（第一次被 seed 看到的時間，之後不改）與 `opened_by`（`rule_id`、`election_id`、`milestone_kind`、`milestone_on_date`、`expected_open_on`＝里程碑日期＋偏移）。
3. **開關事件只增不刪**：新表 `gap_events (task_id, task_type, event 'opened'|'closed'|'reopened', at, rule_id, election_id, milestone_kind, milestone_on_date, reason 'window'|'filled'|'override'|'rule_change')`，由 `seed_auto_task_queue` 在新增／收回派工列的同一個交易裡寫入。派工列被收回後，從這張表仍查得到它何時出生、何時、為何關閉。
4. **對帳**：`expected_open_on` 與 `opened_at` 的差距就是「規則說該開、實際晚了多久才派」，健康檢查視圖列出差距 > 1 天的缺口（排程漏跑、規則寫錯都會在這裡現形）。
5. **既有約 7,000 筆**：P0 回填 `opened_at = LEAST(queue_at, refreshed_at)`、`opened_by.basis = 'backfill'`，`gap_events` 補一筆 `opened`（標 backfill），不假裝知道真正出生時間。

### 2.4 與既有設定表的整合（建議）

| 既有 | 建議 | 理由 |
|---|---|---|
| `election_task_config`（#425） | **併進 `activity_rules`**：`positions`、`bulletin_hint`、`scope_note`、`bulletin_roc_year` 搬到 `params`；`enabled` 與（被撤回的）`enabled_from` 變成規則的窗口；2026 那列改成 `from polling +1`。遷移完刪表（分兩次，見第 5 節） | 它只是「這支臂的規則＋參數」；留著就有兩個地方決定同一件事 |
| `roster_check_scope` | **保留表、搬走日期**：`registration_closed_on`／`list_announced_on` → `election_milestones`（`registration_close`／`list_published`，`election_type` 填職位）；`enabled`、`regions`、`recheck_days` 留著（它是「清查範圍」不是時間窗）；加 `activity_rules` 的 `roster_check` 規則「從 `announced` 或 `registration_open` 到 `list_published`+N」。過渡期用視圖讓舊欄位仍可讀 | 日期是里程碑，範圍是臂的參數；兩者混在一張表是它現在讀起來吃力的原因 |
| `news_settings` | **保留**，不併 | 單列的全域開關與日額度（`daily_task_cap`），不是時間窗；但「新聞系統在哪個階段開」可以由一條 `activity_rules`（`activity='news_sweep'`）決定，`news_settings.enabled` 仍是總開關（兩者都要通過） |
| `news_sweep_feeds` | **保留** | 來源清單，不是時間窗 |
| `cec_sync_phase()`（#423） | **改成規則**：`cec_sync` 活動三條規則（`from polling +0（08:00 UTC 之後）` 到 `+3`、`+3` 到 `+14`、`+14` 起每週），`params` 放 `min_interval_hours` 與 cron 頻率；2022、2024 的硬寫週排程改成「規則 `weekly`、`jurisdictions=tw`」讓三屆走同一條路 | 目前 `cec_sync_phase` 是一支寫死 3 天／14 天的函式，排程是第二處要維護的「時間窗」 |
| `election_term_start/end`、`politician_offices_close_ended` | 保留函式，結果以視圖放進里程碑詞彙 | 任期日期有兩國不同的算法，函式是對的位置 |

---

## 3. 判斷放在哪一層

### 3.1 建議：統一在入口過濾（第一期），熱點臂再下推（第二期）

選項比較：

| | A. 每支臂 SQL 自己讀設定 | B. 在 `contribution_auto_tasks_arms()` 統一過濾（建議） |
|---|---|---|
| 改動 | 改 28 支函式（又是 `CREATE OR REPLACE` 整份重寫，容易漏抄；每次都要差集守門） | 改 1 支入口函式；各臂不動 |
| 規則集中 | 散在 30 處，看不全 | 一處，加一個 `SELECT * FROM activity_rules` 就看到全貌 |
| 效能 | 臂內可以提早剪枝（少算） | 臂照算再過濾；全站缺口約 1.5 秒（函式註解），過濾本身是對一張小表的 join，可忽略 |
| 風險 | 每支臂的改寫都可能順手改到別的行為 | 只過濾輸出，語意單純 |

做法（不改任何臂的簽名）：`contribution_auto_tasks_arms()` 目前就是一串 `UNION ALL SELECT * FROM contribution_auto_tasks_<臂>()`。改成每個分支貼臂名：

```sql
SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_term_policies() t
UNION ALL SELECT 'progress_stale' AS arm, ...   -- raw 的各段 task_type 各自成一個 arm 名
```

再外面包一層：

```sql
SELECT g.task_id, g.task_type, ... FROM (上面的 UNION) g
JOIN LATERAL (選舉與職位 = target->>'election_id'、target->>'election_type'，缺就是「不屬於任何選舉」) ...
WHERE activity_open(g.arm, election_id, election_type, activity_today(...))
```

為了不是每一列各算一次，先算好一張小表 `activity_open_now`（活動×選舉×職位 → 開／關，目前 4 場選舉×約 40 個活動×最多 9 個職位，不到 2000 列）再 join。`raw` 一支函式產出多種 task_type，所以「臂名」用 `task_type` 加後綴（`raw:policy_missing`）由入口外層的 CASE 決定——**這是入口方案唯一需要碰的粗糙處**，可在第 3 期把 `raw` 拆成每種一支函式時順手解決。

### 3.2 對 `seed_auto_task_queue`（每 10 分鐘）的影響

- **窗口關閉＝自動收回**：`seed_auto_task_queue` 已經有「已經不存在的缺口（補上了）：收回號碼牌」那一段（`DELETE FROM task_dispatches … NOT EXISTS (SELECT 1 FROM _gaps …)`）。窗口一關，入口不再輸出那些缺口，下一輪（≤10 分鐘）派工列就被收回，**不用新增收回邏輯**。
- **窗口重新打開**：缺口重新出現，派工列重建、排進隊尾；`task_checks`／冷卻是以 `task_id` 記的，不會因為窗口開關而重置。
- **成本**：每輪多一次對規則與里程碑的 join；不改變算全站缺口的主要成本。若以後規則變多，第二期把「窗口一定關閉的臂」在 `arms()` 裡用 `WHERE activity_open_any(arm)` 擋掉整支函式（不呼叫它），連 1.5 秒都省——日本站一年幾十場選舉並行時這個很重要（見 6.3）。
- **未完成的任務**（以下是從程式碼讀到的行為，實作前要用測試確認【未查：需要一個端到端測試】）：
  - 還沒被領走的：派工列被收回，`/next` 不再給。
  - 已經被領走（有租約）、代理還在做：代理交件時 `contribute` 對 `auto:` 任務不檢查派工列是否還在（`contribute-handler.ts` 只對手動任務的 UUID 查 `contribution_tasks`），交件照收、照驗證、照落庫。窗口關閉不會讓「已經在路上」的交件被拒。
  - 已經交了、在等票的：不受影響（驗證列是 `verify:<id>`，獨立於缺口）。
  - **建議不做「強制收回進行中的任務」**：沒有東西可收，只會浪費代理的工。如果某支臂出問題要立刻止血，用覆寫 `force='closed'`（下一輪生效）。
- **寬限**：規則有 `until_offset`，要寬限就把迄日往後排（例：`election_results` 到 `certified +30`），不另設「寬限天數」欄位。

### 3.3 非派工臂的排程

`cec-sync` 等排程用同一個判斷函式，但**不能**靠「缺口消失」收回——它們的 cron 命令本來就是 `SELECT net.http_post(...) FROM elections WHERE cec_sync_phase(...) = 'live'`。作法：cron 命令改成 `... FROM activity_open_now WHERE activity='cec_sync' AND window_tag='live'`，規則的 `params` 放頻率與 `min_interval_hours`。

---

## 4. 時間的定義、停用後、誰能改

### 4.1 時間

- **日界**：每場選舉有自己的時區（台灣 `Asia/Taipei`、日本 `Asia/Tokyo`；放在 `elections.timezone`，預設由 `jurisdiction` 決定）。`activity_today(election)` ＝ `(now() AT TIME ZONE tz)::date`。取代現在散落的 `CURRENT_DATE`（那是資料庫 UTC 的日期，在台灣 00:00～08:00 會比台北慢一天——現有規則多半差一天沒有後果，但「投票日 +1」這種窗口要精確）。
- **含頭含尾**：起日當天（當地 00:00）開，迄日當天（當地 23:59:59）仍開；`from_offset=+1` 就是「投票日隔天起」。
- **偏移用日曆天**，不用工作日。
- **缺里程碑＝窗口關閉**（fail closed）。規則可設 `if_missing='open'` 例外，預設不開。理由：寧可晚派，不要在沒有日期時把數千件任務倒出去。
- **預估與確定**：`status=expected` 的里程碑只有在規則明寫 `min_status='expected'` 才會讓窗口開（例如「投票前 120 天起開始補候選人名單」可以用預估日期；而「投票日 +1 起查結果」必須是 `announced` 以上）。

### 4.2 停用後

見 3.2：不再新派、未領的收回、已在路上的交件照收。再加兩條：
- 同一場選舉重新啟用（延期後日期移動）：派工列自動回來，沒有「半開」狀態。
- `activity_rules.enabled=false` 與覆寫 `force='closed'` 同樣是「下一輪收回」，語意一致。

### 4.3 誰可以改（依「資料走流程」）

| 東西 | 誰改 | 怎麼改 | 留紀錄 |
|---|---|---|---|
| **規則**（`activity_rules`） | 維護者 | migration（走 PR、差集守門、DECISIONS 一條）；**不開維護者介面** | git 歷史＋DECISIONS |
| **里程碑日期** | 代理／官方資料同步 | 新貢獻型別 `election_milestone`（或 `correction`，見第 7 節）＋官方來源＋投票通過才落庫；官方結構化資料由系統票核對 | `edit_history`（落庫時自動記，可還原） |
| **覆寫** | 維護者 | 一個要管理員身分的端點（寫入走 service_role、`reason` 必填），不是直接寫庫 | `edit_history` 每筆記 |
| **開關**（`enabled`） | 維護者 | 同規則（migration）；緊急止血用覆寫 | 同上 |

理由：規則是「流程規則本身」，CLAUDE.md 主線守則明定要維護者裁；里程碑是資料，要走資料流程；覆寫是例外，必須留下理由與到期日。**不建議開網頁編輯介面**：頻率低，介面本身是新的攻擊面與新的維護面。若日後覆寫變成日常，才回頭評估。

審計：三張表都加一個 AFTER INSERT/UPDATE/DELETE 觸發器寫 `edit_history`（`table_name`＝表名），沿用既有的還原機制；這是 #425 的 `election_task_config` 目前沒有的（它的 `updated_at` 要靠人記得填）。

---

## 5. 遷移：今天派工結果逐件不變

守門方法沿用 #425 已經驗證過的（`scripts/term-policy-parity.ts`）：**PGlite 灌正式庫唯讀快照、同一個查詢快照裡算出現行輸出的筆數與全欄雜湊、舊新逐件比對、再加負向對照確認守門會紅**。差別是這次比對的是整個 `contribution_auto_tasks_arms()`（約 7,000 件 `auto:` 派工列，10-07 實測 6,993；快照要加 `cec_candidates`、`roster_check_scope` 等表）。另外加**假時鐘測試**：`activity_today()` 可以被測試覆寫成固定日期，在 2026-11-16／17／27／28／29、2026-12-25、2027-03-25 等關鍵日確認每一支臂的窗口都開關正確。

分期：

| 期 | 內容 | 行為變化 | 守門 |
|---|---|---|---|
| **P0** | 建 `election_milestones`、`activity_rules`、`activity_overrides`、`activity_today()`、`activity_open()`；`task_dispatches.opened_at`／`opened_by` 與 `gap_events`（2.5，含回填與 seed 寫入事件）；回填里程碑（`election_date`→polling、`roster_check_scope` 的兩個日期、`election_term_*` 視圖）；建 `activity_open_now`；三表的審計觸發器 | **無**（沒有人呼叫） | 回填對照：新里程碑視圖與舊欄位逐列相同 |
| **P1** | `contribution_auto_tasks_arms()` 改成貼臂名＋過濾；所有活動的規則種子＝`always`（永遠開） | **無** | 全站派工清單差集為空（全欄雜湊三方相等） |
| **P2** | **一支臂一個 PR**，把現有條件翻成規則（`progress_stale` 的投票日條件、`not_running`／`withdrawn_filing` 的登記截止→投票日、`election_results`／`election_result_missing` 的投票後、`party_gap`／`party_roster`、`policy_elements` 的已投票／未投票兩個窗…），臂內的日期比較拿掉；`term_policies` 併入 `election_task_config`（再開一個 PR 刪舊表，分兩次上） | 每支臂**今天**輸出不變；之後的日期自動依規則走 | 同 P1，加該臂的假時鐘測試與還原驗證 |
| **P3** | **寫死 2026 的臂**（`raw` 三段、`mayor_policies`、`roster_villages`、`township_gap`、`region_gap`；`term_policies` 的去重也在這一期）改成「對規則開著的每一場選舉各算一遍」（臂內的 `election_id = 2026` 改成 JOIN `activity_open_now`）；先把 `raw` 拆成一個 task_type 一支函式；`cec_sync_phase` 與 `cec-sync` 排程改讀規則 | 今天只有 2026 開著，輸出不變；2028 自動涵蓋 | 同上；這是最大的一期，要拆小 PR |
| **P4** | 選舉自動收錄（第 7 節） | 新增（不改既有輸出） | 第 8 節的驗收 |

**P3 的時間壓力**：2026-11-28 之前不需要完成；但 11-29 起「2026 當選者」的臂（`term_policies` 已經改好）要能開。P0～P2 在選舉前完成就足夠；P3 可以選後做，但要在 2028 選舉的登記期（約 2027 年底，【未查】）之前。

**風險**：
1. 臂的行為是「CREATE OR REPLACE 整份重寫」，每一期都可能順手改到文字——#425 的 CI 測試「新函式＝舊函式加機械替換、其餘一字不差」要成為每一支臂的標準做法。
2. 規則表一旦成為單一真相，**規則寫錯會讓整類任務無聲消失**（沒有錯誤、只是沒派）。對策：視圖 `activity_open_now` 加一個健康檢查（每個活動至少有一條規則；每場選舉至少有 `polling` 里程碑；窗口起迄不顛倒），並在 `cec_sync_status` 同款的視圖裡顯示「這個活動現在對哪幾場選舉開著」。
3. 回溯相容：`task_id` 不變，所以 `task_checks`、冷卻、驗證不受影響。

---

## 6. 兩國共用同一套模型（policy-jp 評估）

**怎麼讀的**：`gh api` 唯讀讀了 `Yooliang/policy-jp` 的 `docs/SCHEMA.md`（v0.7）、`src/data/elections.json`、`src/lib/constants.ts`、`README.md`、`SKILL.md` 的結構。結論：日本站**目前是虛構樣品、純 JSON、沒有資料庫、沒有派工**（README：「樣品站…不接資料庫」），所以這份規劃對它是「先把詞彙與欄位對齊，將來接資料庫時直接用」，不是要現在改它。

日本選舉結構的特性（【查】SCHEMA.md）：
- `elections`：`id`（字串 `2026-03-15_governor_390003`＝日期＋種類＋地區代碼，**建立後不改**）、`election_date`、`election_type`（governor／mayor／ward_mayor／town_mayor／national_lower／national_upper／pref_assembly／muni_assembly）、`election_reason`（regular／resignation／death／recall／dissolution／by_election／increase）、`lg_code`（自治体；國政為 null）、`notice_date`（告示日）、`seats`、`is_uncontested`、`turnout`。
- `politician_offices`：任期起訖**每個任期各自記**（日本沒有全國統一的 12/25）。
- 一年多場：每個自治体的首長選各自的 4 年週期；統一地方選挙（4 年一次、前半後半兩個投票日，樣品站寫在 `constants.ts` 的 `UNIFIED_ELECTIONS`，是手寫常數）；補欠選舉隨時發生。

與本規劃的對齊：

| 面向 | 台灣現況 | 日本樣品站 | 共用詞彙（建議） |
|---|---|---|---|
| 選舉識別 | `election_key`＝`日期_種類[_地區代碼]`，不可變 | `id`＝`日期_種類_自治体代碼`，不可變 | **同一個規則**，兩國用 `election_key`；日本的 `id` 就是 key（接資料庫時另給整數 PK 或沿用字串） |
| 事由 | regular／by_election／rerun／recall | 七種 | 事由是**開放列舉**（`election_reason` 一個文字欄＋各國自己的清單），規則的 `reasons[]` 比對字串 |
| 層級 | 9 種職位（`election_types[]`） | 8 種 `election_type` | 規則用 **層級** `national／regional／local` 加**職位清單**（`election_types[]`）：台灣縣市長＝local、立委＝national；日本 governor＝regional、mayor＝local、national_lower＝national。層級放在 `elections.level`（新欄），由 `jurisdiction`＋職位推得 |
| 地區範圍 | `election_key` 末段是行政區代碼（補選、重行選舉） | `lg_code` | `elections.scope_code`（新欄，空＝全國同日），key 末段與它一致 |
| 時區 | Asia/Taipei | Asia/Tokyo | `elections.timezone` |
| 里程碑 | `roster_check_scope` 兩個日期 | 只有 `notice_date`（告示日） | 同一份 `election_milestones`；日本的 `announced`＝`registration_open`＝`registration_close`＝`list_published`＝告示日（同一天，4 列或規則視為相同），其餘留空 |
| 任期 | `election_term_start/end` 函式 | `politician_offices` 各任期 | 視圖統一成 `term_start`／`term_end` 里程碑 |
| 派工 | 28 支臂 | 尚未有 | 臂是各國自己的（日本的「從選挙公報補公約」「議員定數」等），**規則表與判斷函式是共用的**——這就是共用的部分 |

**6.3 規模提醒**：日本站規劃「三萬席」（SCHEMA 的版本註記提到三萬席規劃），同時開著的選舉窗口會是台灣的幾十倍。因此（a）`activity_open_now` 要依 `jurisdiction` 分區並有索引；（b）每個活動要有**同時開啟件數上限**（`params.cap`，仿 `term_policy_village_cap()` 的 300 件）——否則一個全國統一地方選挙就把佇列塞爆；（c）第 3.2 節「整支臂不呼叫」的下推優化要在日本站上線前做。

**怎麼落地**：兩個站台各自的資料庫（日本站未來接的庫）建**同一組表與函式**，用同一份 migration 檔（放進哪個 repo、誰是來源由維護者決定，見第 10 節）。規則的種子各國自己寫。文案（日文／中文）不進資料庫，仍在各站程式碼。

---

## 7. 選舉本身自動收錄

### 7.1 來源：哪些程式可直接讀、哪些要派任務

| 來源 | 內容 | 程式可讀？ | 實況（【查】10-07） |
|---|---|---|---|
| 中選會 `db.cec.gov.tw/static/elections/list/ELC_<科目>.json` | 歷屆場次清單（`theme_id`、名稱、`vote_date`、`legislator_type_id`） | **可以**（cec-sync 已經在讀） | 11 個科目全部可讀，**最新一筆仍是 111 年（2022）／第 16 任總統／第 11 屆立委**——這個清單**只在選舉辦完之後才長出新場次**，所以它只能「確認一場已經發生的選舉」，不能「預告」 |
| 中選會「選務日程」「選舉公告」頁（web.cec.gov.tw） | 全國性選舉的公告日、登記期、投票日、補選公告 | 網頁（HTML／PDF），結構不穩，**不建議程式直接解析** | 【未查】實際頁面結構與是否有 RSS |
| 各縣市選舉委員會網站 | 補選、重行選舉、罷免的公告（各縣市各自一個站） | 同上，格式不一 | 【未查】 |
| 法規推算 | 定期選舉的投票日有法定規則（地方：2014-11-29、2018-11-24、2022-11-26 都是 11 月的星期六；總統立委：2016-01-16、2020-01-11、2024-01-13 都是 1 月的星期六） | 可以寫成「推算規則」 | 規則本身**需要查公職人員選舉罷免法與總統副總統選舉罷免法的條文確認**，不能只靠三個樣本歸納【未查】 |
| 新聞（`news_sweep`） | 補選、重行選舉的消息 | 已有新聞管線 | 只當線索 |
| 日本：総務省・各選管 | 統一地方選挙日程、各自治体の告示・選挙日程 | 各選管網站格式不一；総務省有統一地方選挙の日程頁【未查】 | policy-jp 現在**沒有**自動取得：`elections.json` 是虛構樣品，統一地方選挙日程是 `constants.ts` 的手寫常數 |

**結論**：沒有「一個官方結構化來源就能預告未來選舉」。所以流程是**三條線並行**：
1. **法規推算**（定期選舉）：建立「預估」的選舉列，日期標 `basis=statutory`。
2. **官方結構化資料**（中選會場次清單）：選舉辦完後**確認**（`polling` 里程碑變 `done`、補上 `theme` 對應），用系統票核對。
3. **代理查證**（公告、補選、重行選舉、延期）：新任務型別 `election_discovery`。

### 7.2 流程（照「資料走流程」）

```
每月（cron，日本站每週）：election_discovery_scan()
  ├─ ① 規則推算：對每個「職位的任期即將屆滿」（term_end 在 24 個月內）且還沒有下一場選舉列的，
  │     依法規推算規則算出預估投票日 → 在 elections 建一列 status='expected'、
  │     date_basis='statutory'（見 7.4 的 key 規則）。不經代理，因為這是系統自己的推算，不是外部事實；
  │     畫面標「預定」，所有規則的 min_status 預設要求 announced，所以不會因此開窗。
  ├─ ② 結構化比對：讀 ELC_*.json，有 vote_date 不在 elections 裡的 → 建一列 status='held'、
  │     date_basis='official'，並以「這個場次的 theme 在中選會清單上」當系統票的依據（對得上＝1 票，目標 2−1＝1，
  │     再一張代理同意就上線，跟 election_results 同一套 3+1）。
  └─ ③ 派任務：對每個「預估日期的前後 12 個月內、而且還沒有 announced 里程碑」的選舉，
        以及每個「沒有預估、但歷史上常有補選」的區域（議員、首長出缺），派 `election_discovery`：
        「查某某選舉委員會有沒有 [年] 的公告；有就交 election（建立或更正）與 election_milestone（各里程碑日期）」。
```

- **新貢獻型別**（四處清點，見 CLAUDE.md「加新的貢獻型別」）：`election`（建立一場選舉：`election_key`、事由、層級、地區範圍、職位清單、投票日）與 `election_milestone`（補里程碑日期）。第一期可以合成一種 `election`，items 內含里程碑。**官方來源必填**（`source_kind=official`，選委會公告頁；新聞不能當唯一出處）。
- **驗證**：沿用共識機制；系統票用 Jev 讀官方公告頁核對日期；目標分數建議 **2**（跟 `election_results` 同），因為一場選舉一旦建立會長出一整串任務與同步排程，影響面大於一般資料——見待決事項。
- **更新與更正**：
  - 里程碑日期改了（延期、公告更正）＝對 `election_milestones` 的 `correction`（附官方公告）；規則窗口自動跟著移動，派工列在下一輪（≤10 分鐘）跟著收回或回來。
  - `election_key` 不可變，但**日期錯了**怎麼辦？見 7.4。
  - 重複：同一個（`election_key`）建立兩次＝唯一鍵擋住；**近似重複**（同層級、同範圍、投票日差 ≤ 3 天，例如有人把延期當成新選舉）→ 落庫前系統比對，命中就不自動建，改派 `adjudicate` 給代理判斷「更正既有」還是「另一場」。
  - 選舉被取消或合併：`status='cancelled'`，所有規則自動視為窗口關閉。
- **日本站同一套**：掃描器的來源清單由各國註冊（台灣：中選會清單＋法規推算；日本：総務省統一地方選挙日程＋各選管告示頁＋推算「任期満了日前 30 日以內」的規則），任務型別與貢獻型別共用。

### 7.3 建立後自動接上（不改任何程式）

一場 `announced` 的 `elections` 列出現後，下面全部自動成立：
1. **任務時間窗**：所有 `activity_rules` 對它各自算窗口（第 2 節）。
2. **cec-sync**：排程已讀 `elections`（#423），`cec_sync` 規則在投票日 08:00 UTC 起自動開三層頻率；場次靠 `vote_date` 對 `election_date`。
3. **`/data/` 與矩陣**：讀 `elections` 與派工快取，新屆別自動出現（依 `docs/PLAN-term-progress.md` 與 `PLAN-markdown-views.md` 的現行寫法；若有寫死屆別的地方，列入 P3 清單）。
4. **候選人名單清查**：`roster_check_scope` 的範圍（regions、recheck_days）來自規則的 `params`；`regions` 可由 `elections.scope_code` 推出。
5. **任期**：`election_term_start/end` 與觸發器 `sync_politician_office_from_election` 本來就讀 `elections`。

### 7.4 需要的欄位、唯一鍵與「預估日期」的矛盾

`elections` 需要新增（只加不刪；第一期可先只加前四個）：

| 欄位 | 用途 |
|---|---|
| `status` | `expected`（預估）｜`announced`（已公告）｜`held`（已投票）｜`cancelled` |
| `date_basis` | `statutory`（法規推算）｜`official`（官方公告）｜`confirmed`（已發生且核對過） |
| `level` | `national`／`regional`／`local`（兩國共用，由職位與管轄推得，可先用視圖算） |
| `jurisdiction` | `tw`／`jp`（或 `jp:<lg_code>`） |
| `scope_code` | 補選、重行選舉的行政區代碼（現在藏在 `election_key` 末段）；全國同日為空 |
| `timezone` | 見 4.1 |

**唯一鍵與 `election_key` 不可變的矛盾**：`election_key` 是 `投票日_種類[_地區]` 且建立後不改（觸發器擋，因為網址 `/election/<key>` 要永久可用）。但**預估日期可能不準**（法規推算、公告前）。建議：
- 預估列的 `election_key` 用**暫時鍵** `預估年月_種類`（例 `2028-01_national_expected`），`status='expected'`；
- 公告確定日期時，由 `election` 貢獻**把暫時鍵換成正式鍵**（觸發器只在 `status='expected'` 時允許改 key），舊鍵寫進別名表 `election_key_aliases`，網址 301 到新鍵（沿用 Worker／Firebase 既有的 301 機制）；
- `announced` 之後鍵不可變，日期改了只改 `election_date` 欄位與里程碑（`election_key` 不改——跟 SCHEMA.md 日本站的「id 建立後就不改：事後發現日期或種類填錯，只改欄位」同一個原則）。
- 另一個做法（待決）：不建預估列，只在公告後才建；缺點是 2028 的登記期之前沒有東西可以掛規則（`roster_check` 想提早啟動就沒有選舉列）。

---

## 8. 驗收案例：2028 年 1 月總統、立法委員選舉

**前提與日期假設**：以下日期**除標【查】者外都是假設**，驗收時用真實日期替換。投票日 D 假設為 2028 年 1 月的某個星期六（【未查】實際日期要等中選會公告）；總統就任 2028-05-20、立委就任 2028-02-01（【查】`election_term_start` 函式裡的現行規則）；2024 任期屆滿 2028-01-31、2028-05-19（【查】`politician_offices.scheduled_end_date`）。

| 時間 | 發生什麼 | 誰／什麼 |
|---|---|---|
| **2026-12-25 前** | P0～P2 已上線；規則表就位。這一步**不需要 2028 的任何資料** | 本規劃 |
| 每月 1 日（2026-12 起） | `election_discovery_scan` ①：2024 立委任期 2028-01-31 屆滿、在 24 個月內，且沒有下一場選舉列 → 建 `2028-01_national_expected`（`status=expected`、`date_basis=statutory`、職位＝總統副總統＋立法委員）。**任何規則都不因此開窗**（`min_status=announced`） | 系統（不經代理） |
| 2027-01 起每月 | ③ 派 `election_discovery`：「查中選會有無 2028 年總統、立委選舉公告」。查不到回 `no_change`（附實際查過的公告頁，沿用既有查無守門）；每月最多一件，不洗版 | 代理 |
| **約 D−12 個月** 【未查】 | 中選會公告選舉日程（若有）→ 代理交 `election`（暫時鍵換正式鍵 `2028-01-XX_national`）＋`election_milestone`（`announced`、`registration_open`、`registration_close`、`list_published`、`draw`、`bulletin_published`、`polling` 各日）＋官方來源；系統票核對、一張代理同意 → 落庫，`status=announced` | 代理＋系統票 |
| 落庫當下（≤10 分鐘） | 規則自動成立：`roster_check`（登記期）窗口、`not_running`（`registration_close` 起到 `polling`）、`candidate_status_stale`（`registration_close` 起、無迄日）、`policy_missing`（2028 候選人零政見）、`candidacy_source_missing`…依各規則的偏移算出起迄日；`cec_sync` 三層窗算好；`/data/2028`、矩陣、選舉頁出現新屆別（「預定」標籤） | 規則＋視圖 |
| 登記期 | `roster_check` 派出；`election_districts` 由 `cec-sync` 順手記（只新增）；各職位的 `list_published` 日若與預設不同，代理另交 `election_milestone` 更正 | 規則、代理 |
| **D（投票日）08:00 UTC（台灣 16:00）起 3 天** | `cec_sync` `live` 每 10 分鐘（#423 的現行行為，改由規則決定）；`cec_sync_status` 看得到名單與當選數；② 結構化比對：中選會場次清單長出 `vote_date=D` → `polling` 變 `done`、`date_basis=confirmed` | 排程、系統票 |
| D+1（隔天 00:00 台北時間） | `election_results_missing`（依單位整批）、`election_result_missing` 窗口打開；`progress_stale` 對 2028 競選承諾開始可算 | 規則 |
| D+3～D+14 | `cec_sync` `settle`；D+14 起 `weekly` | 規則 |
| 2028-01-31 | 立委 2024 任期屆滿：`politician-offices-close-daily` 在 2028-02-01 00:05 UTC 關閉；`handover_missing` 的前一任窗口（`term_end` 已過）打開 | 現有排程＋規則 |
| 2028-02-01 | 立委 2028 任期開始（`term_start`）；`term_policy_missing` 對 2028 立委當選者開（規則 `from polling +1`、職位＝立委），**不需要任何人去按開關** | 規則 |
| 2028-05-20 | 總統任期開始；`term_agenda_missing`、`progress_year` 這類 PLAN-term-progress 規劃的新臂用「就任日 +30／+90 天」的規則（`window_kind='term'`）自動開 | 規則 |

驗收項（實作完成後逐條勾）：
1. 在測試資料庫插入一列 `2028-01-13_national`（只填 `elections` 與里程碑，**不改任何函式、規則、排程**），假時鐘跑過上表的每個時間點，派工清單的差異恰好是預期的那些臂。
2. 同一個測試對日本樣本資料（`2026-03-15_governor_390003` 之類）也成立。
3. 把投票日延期 7 天（`correction` 里程碑），窗口整體後移、派工列在下一輪收回／回來。
4. 刪掉 `activity_rules` 某活動的唯一規則 → 健康檢查視圖紅。

---

## 9. 不採用的做法（與理由）

- **為每支臂加 `enabled_from`／`enabled_until` 絕對日期欄**（上一版的 #425 後續）：每場選舉每支臂都要有人記得填一次，正是維護者說的「不可能一次一次手動調整」；也不能表達「投票日 +1」這種相對關係。
- **在每支臂 SQL 裡各讀設定表**：改 28 支函式、規則散落；入口過濾能做到同樣的事且不碰臂。
- **維護者網頁介面編輯規則**：頻率低、新增攻擊面；規則是流程規則，本來就要維護者裁、走 PR。
- **把里程碑做成 `elections` 的一堆寬欄位**：日本與台灣里程碑不同；窄表加種類不用 migration。
- **強制收回進行中的任務**：沒有東西可收，只浪費代理的工；需要止血用覆寫。

---

## 10. 需要維護者決定的事

> **2026-10-07 維護者裁示**：
> - 第 1 項：里程碑**另開一張表**（窄表 `election_milestones`，2.1）。
> - 第 2 項：**先用預估日期建選舉列**（7.4 的暫時鍵＋`status='expected'`，公告後換正式鍵、舊鍵進別名表 301）。
> - 第 5 項：`election_discovery` **目標 3 票**（照預設門檻，不放寬成 2）；系統結構化比對照一般系統票規則計分。
> - 其餘各項（3、4、6～11）照本檔建議執行，實作中有疑義再提。

1. **里程碑存法**：窄表（建議，2.1）還是在 `elections` 加寬欄位（簡單但兩國不一致、每加一種都要 migration）。
2. **預估日期的選舉列**：要不要先建「預估」列（建議，7.4，需要 `status`／`date_basis` 與「預估時可換鍵」的例外）還是公告後才建。影響 `election_key` 不可變原則的一個例外。
3. **規則寫在哪、誰能改**：同意「規則只走 migration、覆寫走管理員端點且 `reason` 必填、每筆進 `edit_history`」（第 4.3 節）？還是要維護者可改的介面？
4. **時間定義**：台北時間日界、含頭含尾、缺里程碑＝不派（fail closed）、預設要求里程碑至少 `announced`（4.1）。
5. **`election_discovery` 票數門檻**：建議目標 2（建立一場選舉影響面大）；以及「結構化比對」由系統自動建立 `held` 選舉列是否可接受（因為是辦完的事實、有官方清單，建議可以，系統票＋一張代理同意）。
6. **法定推算規則誰查**：定期選舉投票日的法規條文（公職人員選舉罷免法、總統副總統選舉罷免法）要有人（或一個一次性的查證任務）確認；在確認前，預估日期只標「預定」、不開任何窗。
7. **`election_task_config` 的命運**：併進 `activity_rules`（建議，兩次 migration 刪表）還是保留（兩個地方決定同一件事）。
8. **日本站共用**：規則表與判斷函式的 migration 放在哪個 repo、誰是來源（建議 policy-tw 為來源，policy-jp 接資料庫時整份複製）；日本站是否要先對齊 `jurisdiction`／`level`／`timezone` 詞彙（只是 SCHEMA.md 的文字修改，不動資料）。
9. **同時開啟件數上限**（`params.cap`）的預設值與誰決定（日本三萬席規模前要有）。
10. **P3 的時機**：寫死 2026 的臂（5 支）要在選前改、還是選後（建議選後、2028 登記期之前）。選前只做 P0～P2（#425 的 `term_policy_missing` 已經是 P2 的第一支）。
11. **cec-sync 2022、2024 的硬寫週排程**：併進規則（三屆走同一條路）還是維持（零風險、兩處維護）。

---

## 附：本規劃用到的查證

- 正式庫（唯讀）：`cron.job` 34 條；`pg_proc` 裡 `contribution_auto_tasks%`、`seed_auto_task_queue`、`news_sweep_refresh_tasks`、`refresh_dispatch_blocked` 等 43 支函式定義；`elections`、`roster_check_scope`、`news_settings`、`news_sweep_feeds`、`election_bulletins`、`task_dispatches` 的欄位；`task_dispatches` 各 `task_type` 現有件數（`term_policy_missing` 2,058、`policy_elements_missing` 1,024、`policy_missing` 929、`profile_gap` 764、`roster_check` 641…）。
- `https://db.cec.gov.tw/static/elections/list/ELC_{C1,C2,T1,T2,D1,D2,R1,R2,V0,P0,L0}.json`：全部 200，最新場次 2022-11-26／2024-01-13。
- `Yooliang/policy-jp`（私人 repo，`gh api` 唯讀）：`docs/SCHEMA.md`、`src/data/elections.json`、`src/lib/constants.ts`、`README.md`。
- 程式：`supabase/functions/_shared/contribute-handler.ts`（對 `auto:` 任務不查派工列）、`_shared/elections.ts`、`_shared/cec-sync.ts`、migration `20261007220000`（`cec_sync_phase`）與 `20261007225000`（`election_task_config`）。
- **沒查**：中選會選務日程頁／各縣市選委會公告的實際格式、法定投票日規則的條文、日本総務省的日程頁、`/data/` 與矩陣有沒有寫死屆別的地方（P3 時逐一盤點）。

---

## 11. 實作現況

- **P0（2026-10-08，migration `20261008001000_activity_windows_p0.sql`，守門 `supabase/functions/_shared/activity-windows.test.ts`）**：已建 `election_milestones`、`activity_rules`、`activity_overrides`、`gap_events`；`activity_today()`、`activity_open()`（回傳開窗的規則＋里程碑列，零列＝關）、`activity_level()`／`activity_jurisdiction()`（P4 加欄位前的過渡）；視圖 `election_milestones_all`、`activity_open_now`、`activity_health`（正常是空的）；三張表的審計觸發器與 `updated_at` 觸發器；`task_dispatches.opened_at`／`opened_by`；`task_dispatches` 上的觸發器（只管 `auto:` 列，涵蓋 seed、貢獻 applied 收回、`/next` 的 `task_dispatched` 三條路）寫 `opened`／`closed`／`reopened`，關閉原因由交易內設定 `gap.close_reason`／`gap.close_detail` 帶入。**沒有任何一支臂讀這些表，`activity_rules` 沒有種子**（P1 才種）。
- 與本檔設計的差異：
  1. `election_milestones` 主鍵是 `id`（BIGSERIAL）加 `(election_id, kind, COALESCE(election_type, ''))` 的唯一索引（2.1 寫的 PRIMARY KEY 含 COALESCE 運算式，PostgreSQL 不允許）。
  2. `polling`、`term_start`、`term_end` 不能存進這張表（CHECK 擋），只存在視圖裡（單一真相仍在 `elections.election_date` 與 `election_term_start／end()`）。
  3. `window_kind` 的形狀有 CHECK：`always` 不掛里程碑；`event` 不掛任期里程碑；`term`／`recurring` 只掛任期里程碑；`recurring` 要有月份。
  4. `activity_overrides.expires_at` 用 `DATE`（含當天），方便假時鐘測試。
  5. P0 的 `gap_events` 收回一律記 `reason='filled'`——還沒有規則在過濾，分不出「窗口關了」與「缺口補上了」；P1 起帶規則後才分。
  6. 回填 `opened_at`：插隊哨兵值 `queue_at = 1980-01-01` 的列（線上 865 筆）改取 `refreshed_at`，`opened_by` 記 `queue_at_sentinel`，不把出生時間填成 1980。
  7. `roster_check_scope` 的 `ballot_draw_on`、`qualification_review_by`、`municipal_mayor_list_on` 沒有回填成里程碑（`draw` 等），P2 動 `roster_check` 臂時再一起搬；目前 `activity_health` 的 `milestone_scope_drift` 只比登記截止與名單公告兩個日期。（2026-10-08 已搬，見下面「P2 名單時程」。）
- **P1（2026-10-08，migration `20261008060000_activity_windows_p1.sql`，守門 `supabase/functions/_shared/activity-arms.test.ts`＋`scripts/arms-parity.ts`）**：`contribution_auto_tasks_arms()` 每個 UNION 分支貼臂名、整串包進 CTE 後對「臂×選舉×職位」各問一次 `activity_open()`，沒有開窗的規則就濾掉；新函式 `activity_arm_names()`（36 個活動名）；`activity_rules` 種 36 條 `always`（note 寫「P1 種子」）；seed 新增派工列時 `opened_by` 改帶規則（basis／arm／rule_id／override_id／election_id／milestone_kind／milestone_on_date／expected_open_on，沒有的欄位不寫），P0 的觸發器把它抄進 `gap_events`；健康檢查多 `arm_without_rule`、新視圖 `gap_open_lateness`。**派工輸出逐件不變**；28 支臂的簽名與內容一字沒動；各臂內部的日期條件沒動（P2）；`elections` 沒動（P4）。
  - 實測（正式庫唯讀快照 2026-10-07 17:14 UTC，PGlite 回放 28 個分支的真實輸出）：舊總表 7,489 件、全欄雜湊 `1d6c430069d84def0bfd1617ac1f4eb3`＝正式庫現行總表＝改名複本＝新總表（去掉 arm、opened_by），逐件 EXCEPT 兩個方向 0 件，逐件 md5 全部對得上；負向對照（關掉 term_policies／election_results／policy_elements／raw:roster_check／raw:progress_stale 的規則、刪光 roster_villages 的規則、mayor_policies 下 closed 覆寫、刪光所有規則）輸出剛好少該臂的件數；窗口「投票日 +1」在六個假日期下開著的件數＝依各場投票日手算的預期；三種改壞的 migration（偷改 raw 過濾、漏種一條規則、join 少職位）腳本都紅。
  - 效能：正式庫現行總表 `EXPLAIN ANALYZE` 實測 3.9／4.5／3.9 秒（函式註解寫的 1.5 秒是舊數字）。規則過濾對 84 個「臂×選舉×職位」各問一次 `activity_open()`，PGlite 上多約 170 毫秒（PGlite 比原生慢約 9 倍：同樣 84 次空規則呼叫，正式庫 0.75 毫秒、PGlite 6.6 毫秒），換算正式庫約 20 毫秒，不到 1%。
- 與本檔設計的差異（P1）：
  1. **總表回傳型別多了兩欄 `arm`、`opened_by`**（原本 7 欄不變、順序不變），所以是 `DROP FUNCTION` ＋ `CREATE`，沒走 CLAUDE.md 的「改函式簽名分兩次上」：那條規則防的是「CI 先 db push、舊 Edge Function 碰到新簽名會炸」，唯讀查正式庫確認呼叫總表的只有 `seed_auto_task_queue()`（pg_cron）與 `task_boost_matches(jsonb)`（用欄位名取值），沒有 Edge Function 直接 RPC、沒有視圖或其他物件相依，ACL 是預設值，同一支 migration 內單一交易完成。
  2. 活動名：`raw` 依任務型別拆成 `raw:<型別>` 九個（policy_missing、profile_gap、policy_validity、progress_stale、candidacy_source_missing、roster_check、policy_election_missing、candidate_status_stale、election_result_missing），其餘 27 個用函式名去掉 `contribution_auto_tasks_` 前綴（`deadline_due` 那個 CTE 也叫 deadline_due）。P2 寫「`progress_stale` 的規則」時活動名是 `raw:progress_stale`。
  3. 活動名清單 `activity_arm_names()` 是手維護的第二份清單，由守門測試對帳：必須等於總表本體實際貼的標籤＋最新 `contribution_auto_tasks_raw()` 實際會產出的任務型別。**新增一支臂要三處一起加**（總表標籤、清單、規則種子），漏任一處測試會紅；規則漏了，總表過濾時會對該臂 `RAISE EXCEPTION`（函式 `activity_require_rule()`，訊息寫明臂名；只有「連一列規則都沒有」才丟，規則存在但停用或窗口沒開是正常的關）——seed 失敗、cron 失敗紀錄看得到，`task_boost_matches` 也會丟同一個錯，而不是缺口整批無聲消失（同儕審查提出）；migration 內另有一道檢查：有活動沒有啟用中的規則就整支失敗。
  4. `gap_events` 的關閉原因仍一律記 `filled`，沒分 `window`：P1 規則全是永遠開，收回只可能是缺口補上了；要等 P2 第一支真的用窗口關掉缺口的臂，才需要 seed 同時知道「臂自己算出的缺口」與「被規則濾掉的」，那是 P2 的事。
  5. `gap_open_lateness` 是「要看的清單」不是警報：差距也可能只是資料晚到（窗口 11-29 開、那位候選人 12-20 才進資料庫）。P1 規則全是永遠開、沒有 `expected_open_on`，所以現在是空的。
  6. 回填的既有派工列（約 7,000 筆）的 `opened_by` 仍是 `backfill`：seed 對既有列只更新內容、不動出生紀錄；P1 之後新出現的缺口才帶規則。
- 已知限制：
  1. `scripts/arms-parity.ts` 用的是正式庫唯讀快照，不進 CI；CI 只有合成資料（`activity-arms.test.ts`）。每支改到總表或臂的 PR 要在 PR 說明附該腳本的結果。
  2. `activity-arms.test.ts` 的 A1 尾端守門（P1 之後有人重新定義總表或 seed 就紅）是刻意的：P2 每支臂的 PR 若動到總表或 seed，都要同步更新 A1 與機械式替換的比對。（`party_roster` 那支 P2 動了總表與 seed：A1 現在允許總表只由 `20261008121000` 再定義、seed 只由優先層 `20261008090000` 與它再定義；之後再動的，守門 `activity-party-roster.test.ts` 的文字層比對會紅，要以最新那版為底重做。優先層與 party_roster 的 seed 插入是不同區段，互不相撞，都已疊在 main 上。）
- **P2「選舉結果」（2026-10-08，migration `20261008070000_activity_windows_p2_election_results.sql`，守門 `supabase/functions/_shared/activity-election-results.test.ts`＋`scripts/arms-parity-p2.ts check election_results <snapshot.json>`）**：`election_results` 與 `raw:election_result_missing` 兩支臂臂內的 `election_date < CURRENT_DATE` 拿掉（現行定義＋一處機械替換），兩條 P1 種子規則原地（rule_id 不變）改成 `event`／`polling`／+1／無迄日／不限範圍／`min_status=announced`（迄日不設：結果補上缺口自己消失，2022、2024、重行選舉的空白要持續派）；`elected_missing` 沒有日期條件，規則維持永遠開（它靠 `cec_candidates` 的列出現，開票夜就該派）；今天輸出逐件不變（正式庫唯讀快照 7,521 件、全欄雜湊與逐件 md5 相等；2026-11-28 當天不開、11-29 開 +1,442 件；偏移 0／不改規則／加迄日三種改壞版都紅）；窗口用台北日界，比原本 UTC 的 `CURRENT_DATE` 早 8 小時開。其餘臂的日期條件盤點清單見 PR 說明。
- **P2「party_gap」（2026-10-08，migration `20261008120000_activity_windows_p2_party_gap.sql`，守門 `supabase/functions/_shared/activity-party-gap.test.ts`＋`scripts/arms-parity-p2.ts check party_gap <snapshot.json>`）**：`party_gap` 臂臂內的 `JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE`（唯一一處）拿掉（現行定義＋一處機械替換，本體與正式庫 `pg_get_functiondef` 一字不差），`party_gap` 那條 P1 種子規則原地（rule_id 不變）改成 `event`／`polling`／+1／無迄日／不限範圍／`min_status=announced`，跟選舉結果同型。`candidacy_list_published(…, CURRENT_DATE)`（算 `candidate_status` 字眼用）不是「這支臂何時開」，不動。與 `party_roster` 產出同形狀 task_id（`auto:candidacy_source_missing:party:<pe_id>`），原本靠臂內日期分工，下一個 PR 把 `party_roster` 改成迄於投票日當天後，兩條規則在台北日界下不重疊也不留縫。**今天輸出逐件不變，但這一步在正式庫是「空對空」**：現行 `party_gap` 輸出 0 件（已投票屆別缺政黨而中選會名冊又對得到的目前沒有），新本體也是 0 件（2026 還沒有名冊），總表 7,570 件、全欄雜湊 `405c6f0826b10fc6c953b3dcbe66eb18` 前後相等；窗口行為（11-28 不開、11-29 開、舊選舉各自從投票日 +1 起、之後一直開、seed 等窗口）由 CI 的合成資料測試守。新本體在正式庫的 `EXPLAIN ANALYZE` 中位數 33.6 毫秒（舊 25.4 毫秒），多算的 314 列是 2026 的缺政黨列，在 cec_candidates 對不到名冊就停了。
- **P2「party_roster」＋收回原因 window／filled（2026-10-08，migration `20261008121000_activity_windows_p2_party_roster.sql`，守門 `supabase/functions/_shared/activity-party-roster.test.ts`＋`scripts/arms-parity-p2.ts party_roster`）**：第一支**有迄日**的臂。`party_roster` 臂內的 `JOIN elections e ON e.id = pe.election_id AND e.election_date >= CURRENT_DATE`（唯一一處）拿掉（現行定義＋一處機械替換），`party_roster` 那條 P1 種子規則原地（rule_id 不變）改成 `event`／**只有迄點**（`from_kind` 空、`until_kind='polling'`、`until_offset=0`）／不限範圍：投票日當天仍開、隔天關（2026：11-28 開、11-29 關），跟 `party_gap`（投票日 +1 起）在台北日界下剛好銜接。只有迄點的形狀 P0 的 `activity_rules_shape` 本來就允許（`event` 掛事件，起點與迄點至少一端）、`activity_open()` 也處理（沒有起點＝一直開到迄日當天，確定程度看迄點里程碑），不需要另找表示法；沒有起點里程碑，所以這種缺口的 `opened_by` 不帶 `milestone_kind`／`milestone_on_date`／`expected_open_on`（沒有「該開的日期」可對帳，`gap_open_lateness` 不列），改帶 `open_until`（迄日）。窗口比原本（UTC 的 `CURRENT_DATE`）早 8 小時關。
  - **收回原因 window／filled**（P1 已知限制 4 記的待辦）：`seed_auto_task_queue()` 收回缺口時，臂自己還算得出來、只是規則的窗口關了＝`window`；臂已經算不出來（補上了）＝`filled`。做法：`contribution_auto_tasks_arms()` 多一個交易內旗標 `gap.arms_all`，沒設（預設）行為與原本完全相同、`on` 時多回傳被規則濾掉的列（那些列的 `opened_by` 是 NULL，開著的列一定不是 NULL）；seed 開旗標算一次總表存進 `_gaps_all`，`_gaps` 取其中 `opened_by IS NOT NULL` 的列，收回前先對「不在 `_gaps`、但在 `_gaps_all`」的派工列設 `gap.close_reason='window'` 刪掉再清掉，其餘走原本那段 DELETE（預設記 `filled`）。總表以 #448（測試名人物隔離）的現行版為底只改幾處（`CROSS JOIN LATERAL`→`LEFT JOIN LATERAL … ON true`、`opened_by` 有開窗才組並多帶 `open_until`、WHERE 前面多一個「開著或旗標開著」的條件，#448 的 `ph`／`phe` 與過濾整段包在外層 AND 裡一字不動，所以旗標開著時測試人物的任務一樣不出現——那是「臂不再算它」，收回記 `filled`）、seed 只多兩段插入，28 個分支與臂名標籤一個沒動，UNION 清單仍只有一份（新增派工臂的三處登記照舊），不另建「完整輸出」函式、不用把臂算兩遍。貢獻 applied 的收回（`task_dispatches_drop_applied`）仍記 `filled`；被 `party_gap` 接手的（同 task_id）留在 `_gaps` 裡、不收回也不產生 closed 事件。
  - **今天輸出逐件不變，而且這一步在正式庫不是空對空**：現行 `party_roster` 輸出 314 件（2026 已登記缺政黨），新本體 394 件，多的 80 列是已投票屆別（2022 的 79 件、2024 的 1 件，還停在 `filed` 而缺政黨），由規則濾掉；總表 7,934 件、全欄雜湊 `1c79bf71e8339c2d53168c893d99be9f`（回放環境已套 #443、#448） 前後相等，逐件 md5 全對。假時鐘（PGlite 回放快照）：11-28 筆數＝基準、11-29 少 314 件（2026 的列關了）。改壞版（迄日 -1、+1、規則沒改）腳本都紅。這 80 列在窗口關掉後沒有任何臂接手（`party_gap` 只收中選會名冊對得到的），今天本來就沒有進派工列，不是新缺口。
  - 成本（正式庫唯讀 `EXPLAIN ANALYZE`，中位數）：總表現行 4,124 毫秒→新（預設）4,096 毫秒→旗標開著 4,135 毫秒，差在雜訊內；`party_roster` 臂 6.5→11.4 毫秒（多算的 80 列）；seed 多一張暫存表與一次 `EXISTS`（只對「不在 `_gaps` 的既有派工列」），量不出來。
- **公報上網日自動偵測（2026-10-08，migration `20261008113000_bulletin_watch.sql`、Edge Function `bulletin-watch`，守門 `supabase/functions/_shared/bulletin-watch.test.ts`＋`bulletin-watch-db.test.ts`）**：第 7 節「官方結構化來源由系統確認」的第一個實例，也是 2.1 的 `bulletin_published` 里程碑第一次真的有人寫。中選會公報站 `?dir=<民國年>` 資料夾不存在時回首頁、title「首頁 - …」，存在時 title「115 - …」；pg_cron 每天一次（全部）、每小時一次（預估日前後各 14 天）叫函式，出現就把里程碑改成偵測當天、`done`、`official`。**單一真相＝`election_milestones` 的 `bulletin_published`（整場、election_type 空）**；`elections.bulletin_published_on`（20261008000002）降為觸發器衍生的快取（任務說明函式照讀、不用改），直接寫被守門觸發器擋；2026 的預估列（11-18、`expected`／`statutory`）由 migration 從舊欄位回填。2022、2024 的欄位是 NULL＝已上架，不建里程碑列、不偵測。與佇列優先層（#443，已在 main）接起來：它在 `election_milestones_all` 加的「讀 elections.bulletin_published_on」那一段，欄位改衍生後永遠被表擋掉，所以這支 migration 把視圖拿回 P0 的寫法（`bulletin_published` 只來自里程碑表）；預估列是 `expected`，它的種子規則 `priority:raw:policy_missing`（until＝`bulletin_published` −1，「公報之前」降級）預設的 `min_status='announced'` 會讓偵測前的降級無聲失效，所以同一支 migration 把那一條規則改成 `min_status='expected'`；守門測試裝 #443 的原版視圖與種子規則，比對套之前之後降級規則的逐日開關（11-17 含以前開、11-18 起關）完全相同，偵測到 11-12 則 11-11 為止。偵測日是「我們看到的那天」，不是中選會的上架時間。新增選舉漏建這一列時，`bulletin_watch_targets`（INNER JOIN 里程碑表）不會偵測、降級規則也開不起來，所以 `activity_health` 多一項 `bulletin_milestone_missing`（有 `bulletin_dir`、還沒投票、沒有整場 `bulletin_published` 列就報）。
- **新臂「補號次」`ballot_numbers`（2026-10-08，缺口盤點 R8，migration `20261008150000_ballot_numbers_arm.sql`，守門 `supabase/functions/_shared/activity-ballot-numbers.test.ts`＋`scripts/arms-parity-ballot.ts`）**：第一支**新增**的派工臂（前面 P2 都是搬既有臂的日期條件），按「新增一支臂要三處一起加」走：總表加一行 `UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t`（以 main 最新版 `20261008121000` 為底只多這一行，#448 的 `ph`／`phe` 與 `gap.arms_all` 旗標一字不動）、`activity_arm_names()` 加名字（P1 的清單只多一個）、規則直接種成窗口（不經過「永遠開」；要在換總表之前種，否則總表對沒有規則的臂 RAISE）。規則：`event`／`draw` +0 起／`polling` +0 止／`min_status=announced`／範圍不限，台北日界含頭含尾——10-22 不開、10-23 開、11-28 開、11-29 關（迄點的做法同 `party_roster`，關窗由 seed 收回記 `window`）。**`draw` 里程碑**：這支 migration 從 `roster_check_scope.ballot_draw_on` 回填（照 P0 回填登記截止與名單公告的寫法，一個職位一列、`basis=official`、`status` 依日期、`ON CONFLICT DO NOTHING`），P0 第 7 點記的「`ballot_draw_on` 沒有回填成里程碑」因此補上；別的 PR 也搬了同一個里程碑時誰先上線誰贏、內容相同；`roster_check_scope.ballot_draw_on` 欄位本身不動（`roster_check` 臂還在讀它）。優先層照 #443 通則，沒有新規則。臂的條件、單位、拆件、target 形狀與「不做系統核對」的理由見 `docs/DECISIONS.md` 2026-10-08「補選票號次」。**這一步在正式庫是「新臂輸出全在窗口以外」**：唯讀快照（2026-10-08 台北 07:19）新臂本體輸出 98 件（2026 屆 88 件、1,604 位；2022、2024 與重行選舉的列沒有 draw 里程碑所以永遠不開），總表 7,934 件、全欄雜湊 `b1b7e5870352c8cda4461ce40387d012`，套 migration 前後相等、逐件 md5 全對；假時鐘 10-22 不開、10-23 +88、11-28 +88、11-29 關。活動名現在 37 個、規則 37 條。**同一支 migration 另含**：號次單位函式 `ballot_number_unit` 與視圖 `ballot_number_units`／`ballot_number_anomalies`（重複與跳號，名單未到齊不算跳號）、臂的第二種任務 `cand_no_recheck`（照派工單位聚成一件，一件最多 25 個號次單位）、`activity_health` 多一段 `ballot_number_anomaly`（只列還沒投票的選舉；現行定義加一段）、`task_dispatches_drop_applied` 對 `auto:candidacy_source_missing:cand_no%` 不在單筆落庫時收回（現行定義加一個條件）、`roster_batch_candidates` 排除帶 `cand_no` 的（現行定義加一個條件）；`20261008151000_cand_no_dup_check.sql` 是號次重複的系統票（`cand_no_dup_system_check`，排程 `cand-no-check-10min`，系統票 not_supported）。鄉鎮市民代表與區民代表的號次單位是選舉區、我們沒記，不檢查。守門另有 `ballot-number-checks.test.ts`；D 組端到端測試跑真的臂本體。第二輪同儕審查後：分件後綴穩定（名次算在全部已登記者上）、視圖與臂只算還沒投票的選舉（投票日隔天還算，視圖 147→21 毫秒、整支臂 304→76 毫秒）、臺／台全欄位正規化、重複檢查用戳記表輪替（`cand_no_dup_checks`，無衝突不投系統票）、`cand_no_dup_conflicts` 撤公開執行權限。
- **P2「名單時程」（2026-10-08，migration `20261008160000_roster_milestones.sql`，守門 `supabase/functions/_shared/roster-milestones.test.ts`＋`scripts/roster-milestones-parity.ts`）**：兩件事一個 PR。① `candidacy_list_published(election_id, election_type, p_on)`（7 支臂 `party_gap`、`party_roster`、`raw`、`region_gap`、`township_gap`、`withdrawn_filing`，加 #452 的 `ballot_numbers`，用它算 `candidate_status` 的字眼）改讀 `election_milestones_all` 的 `list_published`——現行定義＋一處機械替換（第二個 EXISTS），前一版與正式庫 `pg_get_functiondef` 一字不差；查找順序同 `activity_open()`：職位相同的優先，沒有才取整場（election_type 空），線上沒有整場列所以今天結果相同，以後代理交「整場名單公告日」不會被默默忽略。② `roster_check_scope` 剩下三個日期搬成里程碑：資格審查完成日 → 新 kind `qualification_review`（每職位一列）、抽號次日 → `draw`（每職位一列）、直轄市長名單公告日 → `list_published` 加里程碑專用的職位值 `直轄市長`（整場一列；`election_milestones.election_type` 的 CHECK 多放一個值，`activity_rules`／`activity_overrides` 的職位 CHECK 不動）。為什麼不用縣市長那一格：(選舉, kind, election_type) 唯一，縣市長的 `list_published` 已經是 11-17（含直轄市議員、縣市長、縣市議員），直轄市長 11-12 早五天，我們的參選紀錄把直轄市長併在縣市長，所以細分職位只活在里程碑表；`activity_open()` 與 `candidacy_list_published()` 的查找都是「職位相同或整場」，這個值不會被縣市長的查詢誤取。規則的 `from_kind`／`until_kind` 與里程碑的 `kind` 一併放行 `qualification_review`。
  - **單一真相：里程碑表為真，`roster_check_scope` 的五個日期欄（`registration_closed_on`、`list_announced_on`、`qualification_review_by`、`ballot_draw_on`、`municipal_mayor_list_on`）由觸發器衍生**（做法照 #446 的公報上網日）。理由：里程碑有 basis／status（預估→公告→改期的生命週期）與審計，scope 的日期只是一個日期；規則讀的是里程碑，日本站沒有 scope 這張表；且只有一個方向（里程碑 → 欄位），沒有雙向同步的「誰贏」問題。欄位留著是因為 raw 的 `roster_check`／`candidate_status_stale`、`not_running`、`roster_villages`、`roster_scope_covers`、Edge Function（`elections.ts`、`contribute-handler`）都讀它們，留著就一個都不用改（這支不碰任何臂）。實作：AFTER 觸發器 `roster_scope_sync_from_milestones`（里程碑表）一變就讓同一場選舉的 scope 列重算；BEFORE 觸發器 `roster_scope_derive_dates`（scope 表）永遠把五欄填成從里程碑算出來的值，直接寫成別的值被擋（`pg_trigger_depth() < 2` 才檢查，同 #446）；新增一列 scope 時五欄可以不給，**兩個 NOT NULL 欄（登記截止、名單公告）找不到里程碑就整列失敗**——下一屆選舉的順序變成「先建里程碑、再建清查範圍」（原本 NOT NULL「強迫填日期」的用意不變）；刪掉 scope 還在用的登記截止／名單公告里程碑被擋，另外三個欄位可為 NULL（＝說明裡不提那一項），刪里程碑就回到 NULL。健康檢查 `milestone_scope_drift` 保留並擴到五欄（觸發器被停掉或繞過時看得到）。
  - **與 #452（補號次）的關係**：#452 先把 `draw` 搬成里程碑（每職位一列、與欄位相同、`ON CONFLICT DO NOTHING`），這支對 `draw` 的回填同樣 `ON CONFLICT DO NOTHING`，所以兩支誰先上都行；migration 的檢查會確認已有的 `draw` 與 scope 欄位一致（快照：已有 7 列、日期全相同）。#452 也把 `activity_health` 加了一段 `ballot_number_anomaly`，這支的視圖以 #452 的版本為底、只換 `milestone_scope_drift` 一段。
  - **migration 內建的檢查**（不一致就整支失敗，不替人決定誰對）：已有的登記截止／名單公告里程碑要與 scope 相同；直轄市長名單日在同一場選舉的幾列必須一致（都有值而且相同，或都沒有）才搬得成一列整場里程碑；回填完每個欄位都等於衍生值。
  - **今天輸出逐件不變**：這支只改 `candidacy_list_published` 與 scope 欄位的來源，不碰任何臂、總表、seed、規則。正式庫唯讀快照（2026-10-08 02:14 UTC，#452 已上線後重跑，總表 7,889 件、全欄雜湊 `c6673392e5ed2b95261dd5291703a292`，`roster-milestones-parity.ts`）：新舊函式在 24,520 格（40 組選舉×職位 × 2026-08～12 每一天＋各屆投票日前後＋2022～2030 每 7 天）逐格相同；`politician_elections` 17,573 列在今天與 09-04／10-16／10-23／11-12／11-16／11-17／11-28／11-29 算出的 `candidate_status`（`candidacy_protocol_status` 套新舊函式）新舊相同；七列 scope 的五個日期欄現值與「回填後由里程碑推回來的值」相同；`activity_health` 目前是空的；負向對照（`<=` 改 `<`）7 格不一致，比對會紅。效能（唯讀 `EXPLAIN ANALYZE`，17,573 列 × 函式，各三次）：舊版 197–203 毫秒 → 新版 43–45 毫秒（新版走索引、比逐列掃 scope 快）。
  - **假時鐘守門**（PGlite）：`roster_schedule_text()` 在 09-04（登記截止當天）、10-16（資格審查完成當天，含）、10-17、10-23（抽號次當天，含）、10-24、11-12（直轄市長名單當天，含）、11-13、11-17 的輸出逐字對照；`candidacy_list_published` 在 09-04、10-16、10-23、11-12、11-16 為 false，11-17、11-28、11-29 為 true；移動里程碑（抽籤改 10-30、直轄市長名單改 11-14）後說明文字跟著變；24 條測試（文字層 5、行為層 3、還原驗證 16），每條還原驗證都確認對應的守門變紅。
  - **沒做／已知限制**：① 6 支臂仍傳 `CURRENT_DATE`（資料庫 UTC 日期）給 `candidacy_list_published`，換成 `activity_today()`（台北日界）要改這 7 支臂，留給各臂自己的 PR；差別只在名單公告日當天台北 00:00～08:00。② raw 的 `roster_check` 臂仍用 `CURRENT_DATE >= s.list_announced_on`、`roster_schedule_text()` 的預設 today 也是 `CURRENT_DATE`，同上。③ `直轄市長` 只用在 `list_published`，沒有別的 kind 用它；它不是參選紀錄的職位，`activity_rules.election_types` 不能填。④ `qualification_review`／`draw` 目前沒有規則在用（只有說明文字用），放行 `activity_rules` 的 kind 是為了字彙一致。⑤ 這支與其他碰 `activity_health` 視圖的 PR 會在視圖文字上相撞（後合併的以先合併的為底，只換 `milestone_scope_drift` 那一段）。
- **P2「not_running」（2026-10-08，migration `20261008161000_activity_windows_p2_not_running.sql`，守門 `supabase/functions/_shared/activity-not-running.test.ts`＋`scripts/arms-parity-p2.ts check not_running <snapshot.json>`）**：`not_running`（產出 `not_running_recheck`，被標成不參選而沒人對過登記名冊的參選紀錄）臂內 WHERE 裡兩個日期條件——`s.registration_closed_on <= CURRENT_DATE` 與 `(e.election_date IS NULL OR e.election_date >= CURRENT_DATE)`——拿掉（現行定義＋一處機械替換，本體與正式庫 `pg_get_functiondef` 一字不差；`JOIN elections e` 留著，拿掉是另一個改動），`not_running` 那條 P1 種子規則原地（rule_id 20 不變）改成 `event`／起點 `registration_close` +0／迄點 `polling` +0／不限範圍／`min_status=announced`。第二支有迄日的臂，第一支起點不是投票日的臂。**規則**：2026-09-03 關、09-04（登記截止當天）開、11-28（投票日當天）仍開、11-29 關；登記截止的里程碑是每職位一列，臂的 target 帶 `election_id`＋`election_type` 所以找得到同職位的那一列。窗口用台北日界，比原本 UTC 的 `CURRENT_DATE` 早 8 小時開、早 8 小時關。`min_status` 用預設 `announced`：預估的登記截止日不開窗（原條件把 scope 欄位當事實，欄位現在只有官方公告過的日期）。
  - **舊屆別（任務指示：「先確認舊屆今天輸出為 0，不為 0 要想辦法」）**：2022、2024、重行選舉沒有 `registration_close` 里程碑，窗口永遠關。**今天輸出本來就是 0，不需要另想辦法**：臂本來就 `JOIN roster_check_scope`（正式庫只有 2026 七列），舊屆別的現行輸出是 0；唯讀快照裡 `not_running` 分支 7 列，全是 2026（縣市長、縣市議員），舊屆別 0 列；而且舊屆別投票日都過了，原條件的迄日也不成立。窗口對舊屆別「永遠關」與臂內原本「scope 沒列所以沒輸出」結果一致。以後新增一場選舉：要先有該選舉的 scope 列（PR #451 之後要先建里程碑）才有輸出，窗口自然跟著那一列的 `registration_close`。沒有 `election_date` 的選舉：原條件把 NULL 當「還沒投票」而開著，規則找不到 `polling` 迄點＝關（fail closed），正式庫每場選舉都有投票日（`activity_health` 的 `election_without_polling` 是空的），所以今天沒有差別。
  - **今天輸出逐件不變，但這一步在正式庫是「空對空」**：現行 `not_running` 輸出 7 件（2026 縣市長、縣市議員，窗口開著），新本體也是 7 件、沒有多算窗口以外的列；總表 7,891 件、全欄雜湊 `adf02332ec3f449df8e638dfbf2890a9` 前後相等，逐件 md5 全對（快照 2026-10-08 02:20 UTC，#452 已上線後重跑，回放環境已套 #443、#448 與前三步）。**窗口邊界用假時鐘逐日比對**（PGlite 回放快照，預期＝這一步還沒動時的總表筆數－舊輸出裡窗口已關的列＋新輸出多出且窗口開著的列，窗口開關是原臂內條件的轉寫）：09-03 −7、09-04 0、10-08 0、11-28 0、11-29 −7（相對基準），全部等於預期；開著的列 `opened_by` 帶規則、`milestone_kind=registration_close`、`milestone_on_date=2026-09-04`、`expected_open_on=2026-09-04`、`open_until=2026-11-28`。改壞版（起點晚一天、迄點早一天、規則沒改）腳本都紅。**正式庫快照上這一步是空對空（現行 7 件全在窗口內），所以 CI 多一個臂層端到端等價測試（B5）**：把 `not_running` 真實的 SQL 文字在 PGlite 的合成資料上跑（14 筆參選紀錄：2026 各職位、2028、2022、2024、重行選舉，withdrawn 的各種 `verified`／`withdrawn_after_filing`／已合併／已有更正〔還原與否〕的組合，縣市議員的登記截止錯開到 09-10）——舊本體把 `CURRENT_DATE` 換成假日期，新本體不比日期、輸出再用 `activity_open()` 依同一個假日期過濾——24 個日期每一天兩邊逐列相同（列數 0／2／3／3／0／1／1／0，不是空對空）；不靠 stub，直接驗「規則＝被拿掉的那兩個條件」。腳本多了 `window` 型步驟（起迄兩端都是規則、起點不是投票日）：要給 `openAt`（原條件轉寫）與 `probeDays`。
  - **seed 的收回原因**：沿用 party_roster 那支做好的 `window`／`filled`，這支不動總表與 seed（另一支 PR 同時在改 `arms()`）。投票日 +1 起，所有還沒補上的 2026 不參選重查派工列在下一輪 seed（≤10 分鐘）被收回，原因 `window`（臂還算得出來、規則窗口關了）；補上的記 `filled`。
  - 成本（正式庫唯讀 `EXPLAIN ANALYZE`，各三次）：臂 0.72–0.78 毫秒 → 0.77–0.83 毫秒，雜訊內。
  - 測試 27 條（文字層 5、行為層 4〔含臂層端到端等價〕、還原驗證 18）：文字層＝臂前一版（20261006220000）加一處機械替換、這支只動這一臂一條規則；行為層＝今天總表與 P1 逐件相同、假時鐘 09-03／09-04／10-23／11-12／11-17／11-28／11-29、每職位用自己的登記截止、2028 新選舉各自的窗口、舊屆別永遠關、沒有投票日就關、seed 等窗口／window／filled；還原驗證（起迄偏移 ±1、不改規則、拿掉起點或迄點、起點掛錯里程碑、min_status、限定職位、改錯活動、停用）每條確認對應守門變紅（會改變窗口的 12 條連臂層等價也要紅）或 migration 自己的檢查整支失敗。
- **P2「raw:candidate_status_stale」（2026-10-08，migration `20261008162000_activity_windows_p2_candidate_status_stale.sql`，守門 `supabase/functions/_shared/activity-candidate-status-stale.test.ts`＋`scripts/arms-parity-p2.ts check candidate_status_stale <snapshot.json>`）**：改 raw 的方式照 #447：raw 的底版是 main 最新一版（`20261008112000`，#447；與正式庫 `pg_get_functiondef` 一字不差），現行定義＋一處機械替換——candidate_status_stale 那一段 WHERE 的 `AND s.registration_closed_on <= CURRENT_DATE` 換成一行說明註解，其餘（#447 重查判準、名單時程句、選舉結果日期條件已移走）一字不動；同簽名、同回傳型別，不用分兩次上。`raw:candidate_status_stale` 那條 P1 種子規則原地（rule_id 2 不變）改成 `event`／起點 `registration_close` +0／**無迄點**／不限範圍／`min_status=announced`：登記截止當天起、之後一直問到結論為止（投票日之後也一樣，原條件本來就沒有迄日）。起點用每職位一列的 `registration_close` 里程碑，target 帶 `election_id`＋`election_type` 所以找得到同職位那一列；窗口用台北日界，比原本 UTC 的 `CURRENT_DATE` 早 8 小時開。不動總表與 seed。
  - **舊屆別**：2022、2024、重行選舉沒有 `registration_close` 里程碑，窗口永遠關。這一段本來就 `JOIN roster_check_scope`（正式庫只有 2026 七列），舊屆別現行輸出就是 0，不需要另想辦法。
  - **今天輸出逐件不變，但這一步在正式庫是「空對空」**：正式庫現在 **候選狀態過期（candidate_status_stale）的列是 0 件**（現在沒有 `candidacy_status` 為空或 considering 的 2026 參選紀錄在範圍內），raw 現行輸出 2,897 件與新本體逐列相同；總表 7,886 件、全欄雜湊 `6cf97a2ae5ffff32e12b9191826d1f2c` 前後相等，逐件 md5 全對（快照 2026-10-08 02:24 UTC，#452 已上線）。快照比對因此只證明了「raw 其他段沒被動到」與「今天不變」，**這條規則管的列在正式庫是 0 件，邊界日的開關、`opened_by` 沒有東西可驗**（腳本會印出提示）。為了補這個洞，CI 多了**臂層端到端等價測試**（B3）：把 raw 裡 candidate_status_stale 那一段的真實 SQL 文字抽出來，在 PGlite 的合成資料上（12 筆參選紀錄：傳聞／considering／filed／withdrawn、2026／2028／2022／2024／重行、縣市議員的登記截止錯開到 09-10）跑——舊本體把 `CURRENT_DATE` 換成假日期，新本體不比日期、輸出再用 `activity_open()` 依同一個假日期過濾——23 個日期（登記截止前後各幾天、縣市議員的 09-10、投票日前後、2027-11-30／12-01／12-02、2030）每一天兩邊逐列相同（列數 0／3／5／6，不是空對空）；這一項不靠 stub，直接驗「規則＝被拿掉的那個條件」。
  - 假時鐘（總表層，raw 換成 stub）：09-03 關、09-04 開、投票日 11-28 與 11-29 與 2027、2030 照開（無迄日）；每職位用自己的登記截止；2028 立法委員（登記 2027-12-01）各自從自己的登記截止起；raw 的其他任務型別（policy_missing、roster_check、progress_stale、candidacy_source_missing）與別的臂每天都不受影響；`opened_by` 帶規則、`registration_close`／2026-09-04、`expected_open_on` 2026-09-04，沒有 `open_until`；seed 窗口沒開不建、開了才建並寫 gap_events，窗口不會關所以投票日後仍在、補上了記 `filled`。
  - **2028 要開窗，除了 `registration_close` 里程碑，還要有 `roster_check_scope` 的那一列**：raw 這一段仍然 INNER JOIN `roster_check_scope`（target 與說明文字用它的 `registration_closed_on` 欄位），沒有那一列臂就不輸出，規則也就無從開窗；#451 之後 scope 的日期欄由里程碑衍生，新增 scope 列前本來就要先建里程碑，兩者一起就位。
  - 成本（正式庫唯讀 `EXPLAIN ANALYZE`，各三次）：raw 107–126 毫秒 → 105–108 毫秒，雜訊內。
  - 測試 22 條（文字層 5、行為層 3、還原驗證 14）：文字層＝raw 前一版加一處機械替換、前一版已上線的修改一個都沒丟、這支只動 raw 與一條規則；還原驗證（起點偏移 ±1、不改規則、加迄點、起點掛錯里程碑、`min_status=done`、限定職位／事由、改錯活動、停用）每條確認對應守門變紅**且臂層等價變紅**，偏移、加迄點、`min_status`、改錯活動這幾種另有 migration 自己的檢查整支失敗。#447 的守門 `roster-check-gap.test.ts` R2-1（「它是 raw 的最後一版」）改成只允許這一支接在後面，並指向這支的守門。
- 還沒做：各臂內部的日期條件翻成規則（P2，一臂一個 PR；第一支「有迄日」的臂 `party_roster` 已經讓 seed 分得出 `window` 與 `filled`，`not_running` 是第二支、`raw:candidate_status_stale` 是第三支；`candidacy_list_published` 與 `roster_check_scope` 的日期搬成里程碑已做）；寫死 2026 的臂（P3）；`elections` 的 status／key（P4）。
- **測試名人物的任務隔離（2026-10-08，migration `20261008114000_placeholder_task_isolation.sql`，守門 `placeholder-isolation.test.ts`＋`scripts/arms-parity-placeholder.ts`）**：不屬於時間窗，但動到同一個入口。總表 `contribution_auto_tasks_arms()` 最後多一道過濾（`ph`、`phe` 兩個 `MATERIALIZED` CTE＋ WHERE，P1 定義的機械替換，簽名不變）：target 任何地方出現 `politician_name_is_placeholder` 人物的 id（整份 target 文字含人物 uuid——各臂放不同的鍵：`politician_id`、dup 的 a／b、handover 的 from_／to_、lineage_roles 的 people 陣列；或 `politician_election_ids`／`politician_election_id` 含他的參選紀錄 id，jsonb 包含比對、不做子字串），只留 `placeholder_politicians` 臂的任務（整批任務含測試人物時整批先不派）；另種一條優先規則 `priority:placeholder_politicians`（always、層 1）。**CTE 必須 MATERIALIZED**：比對是 strpos，沒有它每一列重掃 politicians 的姓名正則，正式庫實測撞 statement timeout；加了之後 7,913 列 177 毫秒。正式庫快照比對：7,914 → 7,911 件，少的剛好是 3 件 `election_result_missing`，多 0 件。**已知限制**：`activity_priority()` 取號碼最大的規則；`priority:placeholder_politicians` 不掛選舉，目前臂的 target 沒有頂層 election_id 所以只有它相符，日後若測試人物任務帶上 election_id，選舉通則（例如投票日後 181 天起的後段）會蓋掉它、任務掉回後段——這次不改 `activity_priority()`，測試 `known_limitation_election_id_overrides_front_tier` 把現況釘住，改了那邊要同步改這段。**之後任何人再重定義總表，要以這支為底**（`activity-arms.test.ts` A1 與 `placeholder-isolation.test.ts` A1 都守）。

- **優先層（2026-10-08，維護者「加推自動化」；migration `20261008090000_queue_priority_tiers.sql`，守門 `supabase/functions/_shared/queue-priority.test.ts`）**：任務在佇列裡排前排後改由 `activity_rules` 決定，人只在要特別插隊時才用 `/boost`（插隊的行為一點沒動）。
  - **欄位**：`activity_rules.priority`（SMALLINT，指向新表 `task_priority_tiers.id`，越小越前面），不放 `params`——要被查、被限制範圍、被外鍵擋寫錯，`params` 是沒有型別的 jsonb 袋。**有填 `priority` 的規則只管排序、不管開關**：活動名一律 `priority:<臂名>` 或 `priority:*`（CHECK 雙向擋），所以 `activity_open()`、`activity_require_rule()`、健康檢查一個字沒動，不會把它們當開窗規則（「規則是窗口」的語意沒被稀釋）；窗口怎麼算與開窗規則完全相同，因為就是同一支 `activity_open()` 在算。新函式 `activity_priority(臂名, 選舉, 職位, 今天)` 回傳層與依據的規則：同時相符取**號碼最大**的（用法是「通則＋個案降級」，沒有個案升級；取最小會讓降級永遠輸給通則），都不符＝預設層（`task_priority_tiers.is_default`）。
  - **種子值（只在 migration 的資料段，函式裡沒有年份、職位、天數、權重，文字守門 A4 擋）**：層 1 前段 權重 6／層 2 中段 權重 3（預設）／層 3 後段 權重 1；規則 ① `priority:*` 投票日 −180～0 → 前段；② `priority:*` 投票日 +181 起 → 後段；③ `priority:raw:policy_missing`、職位＝縣市長以外 8 種、到公報上架日 −1 為止 → 中段（個案降級，公報日當天起回到前段）。全部是「相對於投票日／公報日的天數」，不指名選舉：2028 年新增一場選舉就自動走同一套；2026 過了投票日 +181 天（2027-05-28）也會自動落到後段。
  - **佇列怎麼用層**：`seed_auto_task_queue()` 每輪對每組「臂×選舉×職位」問一次 `activity_priority`，把層寫進 `task_dispatches.priority`（既有列也換，所以過了里程碑下一輪就反映）；`rebalance_queue()` 把可派的任務依層用權重交錯（第 k 筆的虛擬完成時間＝k／權重，同時間層號小的先；同一層內照 `queue_at`、`task_id` 先進先出），任務位置的間距仍是每筆 2 秒、驗證每筆 1 秒，所以 **驗證：任務＝2:1 不變**；1980 年段的插隊 rebalance 本來就不碰，領走後 `task_dispatched` 排回隊尾、下一輪歸到自己那一層的隊尾。seed 裡新缺口的 `queue_slot`／`v_base` 只決定同一層內的到達先後，真正落在哪是同一個交易裡緊接著的 rebalance 決定（沒有「先掉到隊尾、下一輪才歸位」的空窗）；`task_dispatched` 與 `queue_slot` 沒動。
  - **防餓死**：就是權重。三層都有積壓時每 10 筆約 6 前段、3 中段、1 後段；某一層沒東西，份額自然流給後面的層。後段的第 k 筆最慢排在第 10k 個位置，與前段多大無關。刻意不用嚴格優先：嚴格優先會讓約 2,800 件歷史補資料在 2026 任務永遠有得做的選前完全不動。要調比例改 `task_priority_tiers.weight` 的種子（migration）。
  - **記錄**：新缺口的 `opened_by` 多 `priority`（出生時的層）與 `priority_rule_id`（依據的規則，預設層沒有），P0 的觸發器本來就把 `opened_by` 抄進 `gap_events.detail`；`gap_events.priority` 是由 `detail` 算出的生成欄位（opened／reopened 讀 `detail.priority`、closed 讀 `detail.opened_by.priority`）。`task_dispatches.priority` 是現在的層，兩者不同＝出生後換過層。
  - **公報里程碑**：`election_milestones_all` 多一段 `bulletin_published`（讀 `elections.bulletin_published_on`，單一真相；空＝已上架，不產生里程碑，所以公報日清成空，個案降級就解除；`election_milestones` 表裡有同一場選舉整場的同名列時以表為準）。**（2026-10-08 更正：單一真相搬到 `election_milestones`，視圖那一段拿掉，欄位變衍生快取；規則 `priority:raw:policy_missing` 的 `min_status` 改 `expected`——見上面「公報上網日自動偵測」。）**
  - **實測**：PGlite，真的 `queue_slot`／`rebalance_queue`／`contribution_auto_tasks`／`task_dispatched`／seed／P0／P1，28 個分支換 stub；前段 12、中段 9（6 降級＋3 無選舉）、後段 10 筆，連續 10 輪「派 10 筆＋seed」，每輪都是 6／3／1，每一層內都是先進先出的循環，後段 10 筆各派到一次；驗證：任務＝VVT 重複；插隊的 queue_at 1980 年段仍是隊頭；公報日、投票日後、投票日後 181 天各自換層，下一輪 rebalance 對得上獨立的 TS 版加權公平排隊。沒有任何優先規則時輸出與舊 `rebalance_queue` 逐件相同（含不可派的任務與驗證列）。正式庫現況（唯讀 2026-10-07 18:30Z）依規則推算：可派且沒被插隊的任務前段 1,783、中段 708、後段 2,815；被插隊的另有 1,394 筆在最前面。
  - 與本檔設計的差異：優先規則放在 `activity_rules` 但活動名帶 `priority:` 前綴（不另開表、也不污染開窗規則）；`election_milestones_all` 多了公報日（P0 的視圖只有投票日與任期）。
  - 還沒做／要注意：① 優先層沒進 `/queue` 頁與 `/next` 回傳（代理看不到，只有順序變）；② 同時相符取最大號的規則沒有「例外升級」的寫法，真有需要再加 `precedence`；③ 這一版動了 `seed_auto_task_queue`，與 P2 各臂的 PR 會在 `activity-arms.test.ts` A1 與 seed 的機械式比對上相撞，後合併的要以先合併的為底重做。
- **派工總表效能整理（2026-10-08，migration `20261008180000_arms_perf.sql`，守門 `arms-perf.test.ts`＋`scripts/arms-perf-parity.ts`）**：不是時間窗，但同一個入口。`contribution_auto_tasks_arms()` 一次約 4.6 秒、`seed_auto_task_queue()`（pg_cron 每 10 分鐘）一次 6.8～10.5 秒（最近 12 次中位數 7.1、平均 7.7）。**不動總表 arms()、seed、規則，輸出逐件不變。**
  - **量測**（正式庫唯讀 `EXPLAIN ANALYZE`；28 個分支各自包成 `MATERIALIZED` CTE、**把全部輸出欄位加總**，三次取中位數）：分支合計 4,121 毫秒，總表整體 4,587 毫秒。排行（毫秒、占比）：owner_mismatch 1,187（29%）、term_policies 629（15%）、roster_cec_gap 570（14%）、mayor_policies 540（13%）、election_results 509（12%）——前五名 83%；其後 policy_elements 140、raw 126、elected_missing 60、region_gap 51、party_roster 46、dup 44、legacy 43、lineage_candidates 43，其餘 15 支各 31 毫秒以下、合計約 130。總表在分支之外還有約 450 毫秒的後處理：`activity_open()` 被推到每一列各問一次（約 180；`opened` 的 `LATERAL` 被展開到輸出列，不是每組一次）、測試名人物過濾的兩個子查詢（約 175）。**資料表都很小**（task_dispatches 1.3 萬列、politicians 1.6 萬列、politician_elections 1.7 萬列、cec_candidates 2 萬列），慢的是「同一件事做很多遍」，不是缺索引。
  - **seed 其餘部分**（不經總表）：能唯讀量的只有 SELECT 半邊——`refresh_verify_targets` 的 `contribution_effective_agree()` 244、`rebalance_queue` 的可派清單約 20＋三段窗口排序約 50、`refresh_dispatch_blocked` 24、補驗證列與清驗證列各約 10，合計約 360 毫秒；`activity_priority` 一輪只問約 99 組、可忽略。7.1 秒扣掉總表（`gap.arms_all` 開著 9,590 列約 4.4 秒）與上面的約 0.4 秒，**剩下約 2.2 秒是寫入**：`UPDATE task_dispatches … FROM _gaps` 把約 7,900 列整列重寫（`refreshed_at = now()`）、`rebalance_queue` 三段 `UPDATE` 改 `queue_at`（約 1.3 萬列，`queue_at` 有索引所以不是 HOT）、每列的觸發器（`gap_events`）。`pg_stat_user_tables`：task_dispatches 累計 1,873 萬次更新、只有 15% 是 HOT，堆積 59 MB 裝 1.26 萬列（每列約 4.7 KB，`target` jsonb 大）。**這一塊沒動**（在 seed 與 `rebalance_queue` 裡，`activity-arms.test.ts` 的 A1 與 seed 機械式比對守著，#452、#453 也在改）；要動的方向是「內容沒變的列不重寫」（`IS DISTINCT FROM`）——`refreshed_at` 目前只有測試與回填讀它，但那是 seed 的行為，由維護者或下一個動 seed 的 PR 裁。
  - **改動**（只重寫四支臂，簽名、回傳型別、語言、穩定度不動；現行定義與正式庫 `pg_get_functiondef` 本體一字不差〔空白正規化後〕，新定義＝現行定義加固定幾處機械式替換；單臂毫秒＝現行 → 新本體，三次中位數）：
    1. `mayor_policies` **540 → 14**：`WHERE … is_2026_mayor_candidate(p.id)` 是純量函式、對 politicians 每列呼叫一次（1.6 萬次 × 約 30 微秒）→ 本體原樣寫成 `EXISTS`（半連接；函式本身沒動，守門 A5 盯條件一致）；等票數 `queued` 原本每位候選人掃一次 contributions（payload 沒索引，每次約 3 毫秒，而且 `m` 被展開三次）→ 整張掃一次依人物分組（`queued_by`）＋`COALESCE(…, 0)`；`m` 加 `MATERIALIZED`。
    2. `roster_cec_gap` **570 → 236**：`ours`（DISTINCT，75 毫秒）被 `marked` 的 `matched` EXISTS 用，`matched` 又被四個聚合與一個過濾各引用一次，計畫裡 EXISTS 子查詢被複製五份、`ours` 建了五遍 → `ours`、`marked` 加 `MATERIALIZED`。
    3. `owner_mismatch` **1,187 → 553**：`same_name` 對每筆缺口掃全部人物並重算兩次 `cec_name_key`（14 筆 × 約 50 毫秒）→ 姓名鍵全部人物算一次（`pk`，`MATERIALIZED`），外層姓名鍵用 `(SELECT cec_name_key(p.name))` 讓它每筆缺口只算一次（直接寫會被內嵌成每個 `pk` 列各算一次，實測還是 400 毫秒）。剩下約 400 毫秒是 `candidacy_owner_mismatch_signals()` → `election_result_cec_matches()` 對 1.6 萬筆參選紀錄配對名單（見下）。
    4. `policy_elements` **140 → 87**：`cand` 加 `MATERIALIZED`（缺的要素陣列三個子查詢、`policy_primary_url()` 不再因被輸出欄位與過濾各引用而重算）。
    - **總表整體 4,587 → 3,171 毫秒（-31%）**（現行 `contribution_auto_tasks_arms()` vs 把這四支臂的呼叫換成新本體的總表，各三次：4,587／4,547／4,596 → 3,182／3,155／3,171）；seed 預期從 7.1 秒降到約 5.7 秒（同一次總表呼叫少了約 1.4 秒，寫入不變）。
  - **rebase 到 #451／#452／#453／#454／#456 之後重跑**（四支臂 main 沒有人重定義，本體與正式庫仍一字不差；總表多了 manual、ballot_numbers 兩支臂與 raw 的改動）：單臂 mayor_policies 571 → 14、roster_cec_gap 565 → 235、owner_mismatch 1,209 → 568、policy_elements 151 → 93；**總表整體 4,937 → 3,426 毫秒**（三次中位數，-31%）。parity 重跑全過：四支臂 25／211／14／1,186 件雙向 0 差異；總表 `gap.arms_all` 關著 8,479 件、開著 10,268 件，雙向 0 差異、雜湊相同。
  - **索引：沒有建**。熱點全是求值方式，不是存取路徑；唯一想到的 `politicians (cec_name_key(name))` 運算式索引在唯讀環境量不出效果（沒辦法建索引或假索引），而 `pk` 的寫法已把同名比對降到約 30 毫秒（全部人物算一次），所以不建不能驗證的索引。若將來人物表長到幾十萬筆，`pk` 那一掃會變成瓶頸，再加這支索引並把 `pk` 換回直接比對。
  - **量過、沒做的**：① `election_result_cec_matches()`（election_results 330、owner_mismatch 400，各被呼叫一次、每次 1.5～1.6 萬筆）：把逐列 `LATERAL` 改成一次連接＋分組，內嵌量到 77 毫秒（`count(*)` 修剪了未用欄位）、實際輸出欄位全加總的內嵌版 35 秒；用函式實際跑的計畫模擬（`SET plan_cache_mode = force_generic_plan` ＋ `PREPARE`，陣列參數長度未知、估成 10 筆）超過 20 秒被 `statement_timeout` 中止，原寫法同條件 311 毫秒——**對陣列參數的函式，雜湊連接的寫法不穩**，維持逐列走索引。新寫法逐筆輸出與舊的完全相同（全部 17,573 筆參選紀錄、缺口 15,561 筆、40 筆抽樣、1 筆、0 筆五組雙向 EXCEPT 都是 0），差的只是計畫。若要降這 700 毫秒，方向是少傳列（election_results 傳的 1.5 萬筆裡約 85% 是還沒有名冊的 2026，每列仍付姓名鍵與一次空探測），但那會動到「被窗口濾掉的列也要由臂算出來」（`gap.arms_all`）的輸出，需要另外設計。② `term_policies`（629）：大頭是視圖 `politician_bulletins`（約 270，其中對 `election_bulletins` 的 1.6 萬次索引探測約 95、規劃器把該連接估成 1 列所以不選雜湊）與村里長限量那段（約 100）；視圖是共用物件，這一支不動。③ 總表後處理約 450 毫秒（`activity_open()` 對輸出列各問一次、測試名人物過濾的子查詢）：可以另開一個只動 `arms()` 的 PR（`opened` 加 `MATERIALIZED` 讓它一組問一次、`ph`／`phe` 改成半連接），但會跟 #452、#453 在 `arms()` 上相撞，由後合併的以 main 最新版重做；這次沒做。
  - **parity**（`scripts/arms-perf-parity.ts parity`，正式庫唯讀快照、同一個查詢快照內比，新本體以子查詢原樣執行）：① 四支臂現行函式 vs 新本體，雙向 `EXCEPT ALL` 都是 0、全欄雜湊相同（mayor_policies 25 件、roster_cec_gap 211、owner_mismatch 14、policy_elements 1,120）；② 總表（現行 vs 四支臂換新本體）`gap.arms_all` 關著 7,902 件、開著 9,590 件，兩種模式雙向 0 件差異、全欄雜湊相同；③ 補充：目前 owner_mismatch 的 `same_name` 全空、等票數多半 0，所以另挑同名人物 150 位的 `same_name`（150 位都有內容）、有政見提交的 200 位人物的等票數（26 位非 0）、全部 16,490 位人物的 `is_2026_mayor_candidate` 對 `EXISTS`（84 位是候選人）逐筆比，差異 0。還原驗證：把 migration 裡 `IN ('declared', 'filed')` 改成 `IN ('declared')` 後腳本三項紅（mayor_policies 25 → 0、總表兩種模式 7,900 → 7,875 與 9,588 → 9,563）。
  - **守門 `arms-perf.test.ts`（11 項）**：A1 前一版是預期的那支 migration 且這支是最後一版；A2 每支新定義＝前一版加固定幾處機械式替換；A3 這支只重寫這四支臂、沒有索引或資料寫入、不碰總表／seed／規則表／兩支共用函式；A4 還原驗證（逐處還原、偷改條件，A2 要紅）；A5 寫進臂裡的 `is_2026_mayor_candidate` 條件與函式現行定義一致；A6 `MATERIALIZED` 都在；B1～B5 PGlite 合成資料跑舊定義 vs 新定義（等票數的各種邊界：空字串屆別、別的屆別、rejected、別的型別、已合併、已移除的政見；`same_name` 的排序、出生年空白、已合併者排除、空白與大小寫寫法）逐件相同，並各自改壞新定義五處／四處，比對必須變紅。
  - **之後再重定義這四支臂的人**：以這支為底（A1 會紅）。後處理那一塊與 seed 的寫入若要做，建議各開一個 PR。
- **村里長進度關窗＋流量開窗＋查無冷卻遞增＋標籤（2026-10-08，#470，migration `20261008200000_village_chief_progress_cooling.sql`，守門 `supabase/functions/_shared/village-progress-cooling.test.ts`＋`scripts/arms-parity-villages.ts`，協議 1.79.0）**：維護者四點裁示的實作（理由與取捨見 DECISIONS 2026-10-08）。
  - **規則形狀**：`activity_rules` 多兩欄——`except_election_types TEXT[]`（排除職位，與 `election_types` 二選一；職位未知時不排除）、`requires_traffic BOOLEAN`（這條規則開窗要「該列的人物頁或政見頁在 `page_traffic_hot`」）。`raw:progress_stale`、`deadline_due` 的 P1 種子規則（id 5、24）原地加 `except_election_types`＝{村里長}，另各種一條「村里長、永遠開、`requires_traffic`」（開窗規則 39 → 41 條，加優先層 5 條共 46 條）。`activity_open` 現行定義＋一行排除條件（簽名、回傳欄位不動）。
  - **總表**（`contribution_auto_tasks_arms`，簽名不變）：以 `20261008165000` 的現行定義為底三處機械替換——keyed：有規則要看職位的臂（目前只有這兩個活動），target 沒有 `election_type` 的列從 `politician_elections`（人物×`target.election_id`）補職位，其餘臂不補；opened：帶出規則的 `requires_traffic`；列層：`requires_traffic` 的規則要 `politician_id`／`policy_id` 在 `page_traffic_hot`，沒達標的列跟其他窗口關著的列一樣處理（旗標 `gap.arms_all` 開著時留下、`opened_by` 是 NULL，seed 收回記 `window`）；開著的列 `opened_by` 多 `traffic_gate: true`。seed、`activity_priority`、`rebalance_queue`、臂本體一個字沒動。暫時無法限定職位的：`target` 沒有 `election_id` 的列、人物在那一屆沒有參選紀錄的列（維持開著；正式庫沒有村里長的）。
  - **冷卻**：新表 `task_cooldown_settings`（單列：`enabled`、`not_found_first_days` 14、`not_found_repeat_days` 30、`task_types` progress_stale／deadline_due）、函式 `task_check_cooldown_days_for(task_id, outcome, checked_at, id)`；`refresh_dispatch_blocked` 現行定義（`20261002000006`）＋一處機械替換。範圍只套進度追蹤類（不改既有其他任務行為），「查無」＝`not_found`。
  - **標籤**：`policy_no_public_progress(政見 id)`＋視圖 `policies_with_logs` 最後一欄 `no_public_progress`；前端 `Policy.noPublicProgress`（政見頁「執行歷程追蹤」標題旁、政見卡進度區塊）。
  - **parity**（正式庫唯讀快照 2026-10-08，`scripts/arms-parity-villages.ts parity`）：總表現行 vs 新定義（activity_open 用新本體、規則表換成帶新欄位的替身）8,494 件→8,494 件（旗標開著 10,282 件→10,282 件），雙向 `EXCEPT ALL` 都是 0、全欄雜湊相同；**被收回的村里長進度類任務 0 件**（現行總表的進度追蹤 43 件——progress_stale 立委 16、縣市長 16、縣市議員 6、鄉鎮市長 2、職位未知 3——沒有任何一件屬於有村里長參選紀錄的人；有村里長參選紀錄的人名下 6 條政見都不在進度類缺口裡），所以上線當下是「空對空」，村里長的關窗與流量開窗只靠 CI 合成資料守；冷卻集合今天 1,626 件→1,626 件相同，往後 0～45 天逐日看，差異只有兩件進度追蹤任務（各多冷卻 16 天）；標籤今天標上 23 條政見。已知限制：視圖 `activity_open_now` 對「村里長」會顯示開著（那是「要流量」那條規則；它在列層才判斷頁面有沒有流量）。負向對照：排除寫成對職位未知也關（NULL 不安全）→ 總表被收回 3 件；遞增套到所有型別 → 冷卻集合往後第 10～29 天多出幾十件 policy_missing／legacy_audit，腳本都紅。假設也把 `term_policy_missing` 對村里長關窗會收回 300 件（`--also-term`，不是這支的行為）。
  - **量測**（正式庫唯讀 `EXPLAIN ANALYZE`，5 次中位數；新定義以就地展開＋規則表替身執行，所以同樣展開的「現行」當對照組）：總表整體現行 3,291 毫秒、現行同樣展開 3,392、新定義 3,491——新增的邏輯約 +100 毫秒（約 3%）；`refresh_dispatch_blocked` 的冷卻集合 3.3→5.2 毫秒（每筆查核紀錄多問一次天數函式）；標籤對 1,604 條政見各算一次 15 毫秒。
  - **測試**：`village-progress-cooling.test.ts`（文字層 A1～A9、行為層 B1〔PGlite，真的 P0／P1／優先層／P2×3／手動任務臂／流量提層／這支，42 條守門〕、還原驗證 C1～C32＋C0）。
- **頁面流量提層（2026-10-08，migration `20261008190000_page_traffic_boost.sql`，守門 `supabase/functions/_shared/page-traffic-boost.test.ts`、`page-traffic.test.ts`）**：維護者 10-08 同意「人物頁或政見頁在一段時間內有真實流量時，把它們名下的缺口任務提到前段；流量退了自動回原層」，強調「一定時間內」（滾動時間窗、效果有時效）與「參數可調」。
  - **資料流（每小時）**：`console-fetch` 抓完 GA4 後多打一份 `runReport`（台灣站 property 521879439、近 N 天含今天、維度 `pagePath`、指標 `totalUsers`＋`screenPageViews`，在 GA 端用 `FULL_REGEXP` 先濾成 `/politician/<uuid>`、`/policy/<uuid>`；正見.tw 與 web.app 路徑相同，GA 沒有 `hostName` 維度就已合併，`totalUsers` 是去重後的人數）→ 解析成 `{kind, target_id, users, views}` → service_role RPC `replace_page_traffic(rows, window_days)` 整批覆寫 `page_traffic`（upsert、清掉這次沒出現的；`window_days` 要等於設定，不符就拒絕）。GA 沒抓成功就不呼叫 RPC（保留上一輪，過了 `stale_after_hours` 自己失效）。併發沿用 console-fetch 的 `callJson`（429 指數退避、60 秒上限），且一次只送一個請求。
  - **提層方式（擇一：seed 裡 `min(原層, 前段)`，不擴充 `activity_priority()`）**：`activity_priority()` 取號碼最大的規則，語意是「通則＋個案降級」，沒有升級；若讓它也看流量，要嘛改成取最小（#443 已說明會讓個案降級永遠輸給通則，牴觸現行設計），要嘛加 `precedence`（本檔「還沒做」第②點）並讓它讀 target——但它的簽名只有（臂、選舉、職位），一次問一組，不知道哪個人物。流量是「缺口層級」的訊號，不是「規則窗口」的訊號，所以放在 seed 算完層之後：`traffic_boost_apply()` 把達標頁面名下、現在的層比 `boost_tier` 靠後的缺口壓到 `boost_tier`（只升不降）。`activity_priority()`、`rebalance_queue()`、總表、`/next` 都沒動；seed 只多一個標記起訖的區塊（`PERFORM traffic_boost_apply()`），其餘照 #453（`20261008165000`，手動任務變一支臂）的現行定義一字不差。
  - **target 怎麼對到人物或政見**：各臂的 target 形狀不同（`politician_id`、`policy_id`、dup 的 `a`／`b`、handover 的 `from_`／`to_politician_id`、lineage_roles 的 `people[]`、`items[]`、`politician_election_ids`／`politician_election_id`……），沿用 #448 的「不挑鍵、整份 target 比對」，但不做 `strpos`（缺口數 × 達標頁數）：先把每個缺口的 target 文字用 `regexp_matches` 展開成 uuid 鍵（加上參選紀錄 id 的 `pe:<id>` 鍵），達標頁也展開成鍵（頁面本身、人物頁另含他名下政見的 uuid 與他的參選紀錄 id），兩邊做等值連接（達標頁只有幾百列，建在暫存表上）。人物頁涵蓋他名下政見的缺口。
  - **時效與參數（全部在 `traffic_boost_settings` 單列，函式裡沒有數字）**：`window_days` 7（滾動時間窗）、`min_users` 5（近 N 天不重複訪客）、`boost_tier` 1（前段）、`no_yield_days` 14、`pause_days` 14、`stale_after_hours` 24（流量資料的有效期）、`enabled`。達標＝時間窗與設定一致、人數 ≥ 門檻、資料不比有效期舊；任何一項不成立，下一輪 seed（≤ 10 分鐘）就回原層。改值是一行 `UPDATE`，每次修改進 `edit_history`。
  - **無產出上限**：頁面因流量被提層後，若 `no_yield_days` 天內提層的任務上都沒有「有產出」的交件（`contributions.task_id` 對得上、型別不是 `no_change`／`task_suggestion`、狀態不是 `rejected`；查無與冷卻不算產出），就暫停提層 `pause_days` 天；期滿重新計時（新的一期）。觀察起點是「這一期開始」與「最近一次有產出」較晚的那個（滾動）。已經在前段的缺口提層沒有效果，不開始計時。頁面達標與否分開記：流量退了再回來，只要距上次達標不到 `no_yield_days`，就接續同一期（在門檻附近忽上忽下的頁面繞不過這條上限）；超過就清掉狀態列、下次是全新的一期。狀態在 `page_traffic_boosts`，現況視圖 `page_traffic_boosted_tasks`。
  - **不做**：村里長等預設不追蹤的類別，目前還沒有限定職位的關窗規則（維護者還在決定），這次不做；以後可以讀同一個視圖 `page_traffic_hot` 當新的開窗規則的條件。優先層與流量提層都沒進 `/next` 回傳。
  - **實測**：PGlite（P0、P1、#443、P2×3、這支、真的 `rebalance_queue`），門檻剛好 5 人、人物頁／政見頁、各種 target 形狀（`politician_id`、dup 的 `a`、`to_politician_id`、`people[]`、`items[]`、參選紀錄 id 陣列與單值）、退了回層、資料過期與時間窗改變、暫停與期滿重算、交件算產出（`no_change`／`rejected`／別頁任務不算）、接續同一期、設定改值行為跟著變、停用、`page_traffic` 空或沒有對得到缺口的頁時與舊 seed 輸出逐件相同、新缺口出生就在前段（`opened_by.traffic_boost`、`gap_events.priority`），每條守門都有還原驗證。seed 以 #453 為底（#455、#458 若也改 `seed_auto_task_queue`，後合併的以先合併的為底重做機械式替換，並更新 `activity-arms.test.ts`、`queue-priority.test.ts`、`activity-windows.test.ts`、`page-traffic-boost.test.ts` 四份 A1 的 seed 定義歷史）。
  - **審查補強（agy 審查 #474）**：①`traffic_boost_apply()` 與 `replace_page_traffic` 一樣逐一收回 PUBLIC／anon／authenticated、只授 service_role（內部函式不能是公開 RPC；測試環境用 `ALTER DEFAULT PRIVILEGES` 模擬 Supabase 的預設授權，拿掉任一條 REVOKE 守門就紅）；②`last_yield_at` 每輪依「現在仍有效的交件」重算，交件事後被駁回就清成 NULL，暫停機制不會被一筆隨後被駁回的交件繞過；③暫停期滿：還達標的開新的一期，已冷卻的直接清掉狀態列，等再次達標才開始計時；新的一期從第一次真的提層才起算，沒有提層過任何任務的不算「無產出」；④視圖 `page_traffic_boosted_tasks` 只列現在仍達標（`page_traffic_hot`）而且功能開著的頁面；⑤`replace_page_traffic` 的 `users`／`views` 為 NULL 或缺欄時當 0。
