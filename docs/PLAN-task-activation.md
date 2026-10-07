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
| `raw` 的 roster_check | roster_check | `roster_check_scope.enabled`；`recheck_days` 與嘗試冷卻；「登記階段／審定名單階段」文案看 `CURRENT_DATE >= list_announced_on` | 開關表＋日期比較（登記截止「2026-09-04」另寫死在文案裡） |
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
| 落庫當下（≤10 分鐘） | 規則自動成立：`roster_check`（登記期）窗口、`not_running`／`candidate_status_stale`（`registration_close` 起到 `polling`）、`policy_missing`（2028 候選人零政見）、`candidacy_source_missing`…依各規則的偏移算出起迄日；`cec_sync` 三層窗算好；`/data/2028`、矩陣、選舉頁出現新屆別（「預定」標籤） | 規則＋視圖 |
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
  7. `roster_check_scope` 的 `ballot_draw_on`、`qualification_review_by`、`municipal_mayor_list_on` 沒有回填成里程碑（`draw` 等），P2 動 `roster_check` 臂時再一起搬；目前 `activity_health` 的 `milestone_scope_drift` 只比登記截止與名單公告兩個日期。
- 還沒做（P1 起）：每支臂至少一條規則的健康檢查（要先有臂名清單）、`expected_open_on` 與 `opened_at` 的落差視圖（2.5 第 4 點，P1 才有 `expected_open_on`）。
