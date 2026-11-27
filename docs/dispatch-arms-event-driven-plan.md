# 派工臂事件驅動化（治本）設計與分期計畫

> 狀態：規劃文件，**不含任何 SQL 或程式變更**。日期：2026-11-26（台北）。
> 決策來源：擁有者 2026-11-26 拍板「不加硬體、不做快取止血，直接治本＝事件驅動」。
> 量測基準：正式庫唯讀查詢（2026-11-26，台北中午前後）。探針耗時只有 1 個樣本（探針每小時才跑一次、剛上線），seed 各段耗時是 7 輪平均。數字會過期，**以 `seed_arm_timings` 現值為準**。
> 前置閱讀：`docs/dispatch-arms.md`（佇列怎麼排）、`CLAUDE.md`「seed 排程兩支臂瘦身」「seed 各段／各臂計時」兩條。

---

## 1. 一頁摘要（白話）

**現在怎麼跑。** 網站有約 3 萬個「缺口」（某人缺政見、某政見缺出處、某選區缺名額……），每個缺口對應一張派給 AI 代理的工作單。目前每 10 分鐘，系統把約 35 套「找缺口的規則」全部對整個資料庫重新算一遍，算出完整名單，再跟昨天的名單比對：新的就開單、消失的就收單。**不管資料有沒有變，每次都從頭算。** 實際上 10 分鐘內只有很少的資料變動，絕大部分是白算。

**為什麼會把資料庫撐死。** 重算一輪平均 53 秒，最長 94 秒。其中「找缺口」這一段平均 36 秒，最貴的三套規則（政見屆別對不上、名單清查、議題過寬）就佔去一半以上。重算期間資料庫要暫存大量中間結果、佔用記憶體，Supabase（Medium 4 GB）的記憶體承諾值因此逼頂，24 小時內被主機層硬殺 3 次。

**治本後怎麼跑。** 缺口改成「常駐在一張表裡」。資料一變（有人交件、政見被改、名單同步），系統只重算**受影響的那一筆**缺口，開單或收單。排程每 10 分鐘只是把表裡現有的缺口讀出來派工，不再重算。每天凌晨再全量算一次、跟常駐表比對，漏掉的補上，並把「漏了幾筆」記成健康指標。

**分幾期、各省多少（估計，詳見第 5 節）。**

| 期 | 做什麼 | 預估單輪秒數 | 風險 |
|---|---|---|---|
| 第 0 期 | 地基：缺口表、事件佇列、對帳、巡檢、雙軌比對，不改任何派工結果 | 53 秒（不變） | 低 |
| 第 1 期 | 三套最貴的規則：政見屆別對不上、舊資料稽核、議題過寬 | 約 39 秒 | 中 |
| 第 2 期 | 名單清查整族（含補號次、缺名額） | 約 32 秒 | 高（外部名單同步） |
| 第 3 期 | 其餘約 20 套人物／政見層級規則，外層檢查改讀常駐欄位 | 約 20 秒 | 中 |
| 第 4 期 | 優先秒數、流量提層、阻擋標記改增量 | 約 7 到 10 秒 | 中 |

**風險一句話。** 最大的風險是「漏接事件」，也就是資料變了但沒人通知缺口表，造成多派或漏派；對策是新舊兩套同跑只比不派、連續 7 天零差異才切換，切換後每天凌晨全量對帳兜底，任何一期都能一行指令退回舊算法。

**兩個要先讓擁有者知道的事。**
1. 「每輪寫約 3 GB 暫存檔」與量測不同：`pg_stat_statements` 顯示 seed 8 次累計寫暫存約 2.3 GB，**平均每輪約 284 MB**（3 GB 比較像累計值）。而且**暫存檔主要不是「找缺口的規則」寫的**：把 40 支規則各單獨跑一遍只寫約 21 MB。寫暫存檔的是規則之後的 13 秒整理步驟與 seed 本體各段。所以第 2.9 節把這兩塊也納入目標架構，不只改規則。
2. 另有一個與 seed 無關的記憶體大戶：派工計數函式 `contribution_queue_task_counts`（由 `/next` 呼叫），累計寫暫存約 2.9 GB，是 seed 以外最大的一筆，見第 6.8 節。
3. 「窗口型」規則（例如「公報上架後才開」）本文**不改成排程事件**，理由與替代做法見第 4 節。

---

## 2. 目標架構

### 2.1 一張圖

```
 資料表變動（contributions／policies／politician_elections／…）
        │  觸發器：只做「入列」，不重算
        ▼
 dispatch_gap_dirty（待重算清單，主鍵 arm＋scope_key，同鍵自動合併）
        │  gap_drain()：pg_cron 每 5 分鐘一次，seed 開頭也先呼叫一次
        ▼
 臂的「按鍵重算」函式 xxx_for(keys)  ──→  dispatch_gaps（常駐缺口表）
                                              │  讀（外層窗口檢查仍在讀取時做）
 每日凌晨 gap_reconcile_all()：全量算一次 ──diff──┤
   （用現有的整表臂函式，補漏＋記差異量）          ▼
                                    seed_auto_task_queue()（結構不變）
                                    收回／開單／優先秒數／冷卻照舊
                                              ▼
                                       task_dispatches（佇列）
```

### 2.2 常駐缺口表 `dispatch_gaps`

一列＝一個缺口在「臂函式輸出」那一層的樣子，**還沒套上規則窗口**（見 2.5）。

| 欄位 | 意思 |
|---|---|
| `arm`、`gap_key` | 主鍵。`gap_key` 就是現在的 `task_id`（例如 `auto:policy_missing:<人物 id>`）。同一個 task_id 可由兩支臂產生（政見缺口），所以主鍵含 `arm` |
| `scope_key` | 這列屬於哪個「重算單位」（一個人、一條政見、一個名單單位…），重算時以它為界：該單位算出來有的就更新、沒有的就關 |
| `payload` | 臂函式的輸出：task_type、target、what_we_need、hint_sources、reward、region |
| `eid`、`etype`、`person_ids` | 寫入時順手算好：選舉、職位、涉及的人物 id。給外層窗口檢查與「測試名人物過濾」直接讀，不再每輪對 3 萬列做字串比對 |
| `opened_at`、`closed_at`、`closed_reason` | 開關時間與原因：`filled`（補上了）、`reconcile`（凌晨對帳補收）、`superseded`（指紋換號） |
| `source_version` | 每次內容變動遞增，雙軌比對與除錯用 |
| `recomputed_at` | 最後一次被重算的時間，巡檢看「最舊的未重算」用 |

- 同一個缺口只留一列，關閉後保留 7 天再清（缺口歷史已經在 `gap_events`，不重複記）。
- 部分索引：`(arm, scope_key) WHERE closed_at IS NULL`，以及 `person_ids` 的 GIN 索引（給「人物改名成測試名」時反查）。
- RLS 開、只有 service_role 讀寫，與 `seed_arm_timings` 同規格。

### 2.3 事件入列（開缺口、關缺口都從這裡進）

- 待重算清單 `dispatch_gap_dirty(arm, scope_key, enqueued_at, attempts, last_error)`，主鍵 `(arm, scope_key)`，`INSERT … ON CONFLICT DO NOTHING`。**同一個單位在 5 分鐘內被改一百次，只入列一筆**，事件風暴自然壓平。
- 觸發器只做兩件事：判斷「這次改的欄位會不會影響缺口」（用 `WHEN` 或函式內 `IS DISTINCT FROM`）、算出受影響的 `(arm, scope_key)` 清單入列。**不呼叫任何臂函式、不查大表。**
- 事件來源與受影響單位的對照，見附錄 A.1。
- 緊急開關：`dispatch_gap_settings.events_enabled`。關掉時觸發器直接返回，不需要 DDL。

### 2.4 消化事件 `gap_drain()`

1. 取最舊的一批（每批上限 500 個鍵），`FOR UPDATE SKIP LOCKED`，依臂分組。
2. 對每支臂呼叫它的「按鍵重算」版本（`xxx_for(keys)`），拿到這些單位現在的完整缺口。
3. 與 `dispatch_gaps` 比：新的就開（寫 `opened_at`）、內容變了就更新（`source_version`＋1）、這些單位裡原本有、現在沒有的就關（`closed_reason='filled'`）。
4. 成功就從待重算清單刪除；失敗則 `attempts`＋1 並退避，超過 5 次進巡檢（第 2.8 節）。
5. 排程：pg_cron 每 5 分鐘，分鐘欄用 `3-58/5`（落在 3、8、13…，不落整十分鐘，符合既有 cron 守門）；**seed 開頭也先呼叫一次 `gap_drain()`**，確保讀表前已消化完。
6. 事件風暴保護：某臂待重算筆數超過門檻（初值 2,000）時，該臂的所有待重算鍵合併成一筆「整臂重算」，改走整表函式，不逐鍵呼叫。

**「按鍵重算」函式怎麼寫：同一份臂定義、多一個鍵參數。** 不另寫第二份邏輯。每支臂現有函式 `contribution_auto_tasks_xxx()` 改成 `contribution_auto_tasks_xxx(p_keys text[] DEFAULT NULL)`：不給鍵就是現在的整表行為（對帳用），給鍵就把鍵條件推進最底層的候選集。這樣「按鍵算」與「整表算」天生同源，雙軌比對有意義。已知的技術風險：帶陣列參數的 SQL 函式在 PostgREST／generic plan 下會把陣列長度估成 10 筆（`CLAUDE.md`「量效能先實測」已記），每支臂改完要用 `plan_cache_mode = force_generic_plan` 驗過。

### 2.5 seed 怎麼改（結構不動，只換缺口來源）

- seed 的後半段（優先秒數、收回、更新、開單、驗證票、阻擋標記）**第 0～3 期一個字不改**。只把 `_gaps_all` 的來源從「呼叫總表重算」換成「總表函式內，已切換的臂改讀常駐表、未切換的臂照舊呼叫臂函式」。
- 做法：總表 `contribution_auto_tasks_arms()` 每個臂的分支變成兩段 `UNION ALL`，各帶一個一次性條件：

  ```sql
  SELECT 'legacy' AS arm, t.* FROM contribution_auto_tasks_legacy() t WHERE gap_arm_mode('legacy') <> 'live'
  UNION ALL
  SELECT 'legacy', g.* FROM dispatch_gaps_open('legacy') g WHERE gap_arm_mode('legacy') = 'live'
  ```

  總表現在已經有同型寫法（七支臂掛 `WHERE NOT roster_unify_on()`，探針量到 0 毫秒），代表一次性條件確實讓函式掃描整段不執行；每期上線前仍要用 EXPLAIN 確認。
- **窗口檢查維持在讀取時做。** 常駐表存的是「臂函式輸出」，規則窗口（`activity_open()`，約 84 組臂×選舉×職位）仍在總表外層、每次讀取時問一次。這與現況完全等價：窗口關閉時缺口仍存在於 `_gaps_all`（`opened_by` 為空），seed 收回時記成 `window`；缺口補上才記成 `filled`。**所以窗口開關不需要事件。**
- 降級保護：若 `gap_drain()` 超過 30 分鐘沒成功、或待重算清單最舊一筆超過 30 分鐘，`gap_arm_mode()` 對該臂回傳 `full`（自動退回整表算），seed 變慢但結果仍然正確，同時進巡檢。

### 2.6 每日凌晨全量對帳 `gap_reconcile_all()`

- 排程：台北凌晨約 05:00（UTC 21 點，分鐘不落整十、避開週六中選會同步那批；實際分鐘由主線配號）。
- 對每支已切換的臂：呼叫現有的整表函式算一次，與 `dispatch_gaps` 比，得到三種差異：只在新算的有（漏開）、只在常駐表有（漏關）、內容不同（漏更新）。
- 處理：以整表結果為準，補開、補關（`closed_reason='reconcile'`）、補更新；每臂每天一筆寫入 `gap_reconcile_log(run_at, arm, only_new, only_old, changed, took_ms)`。
- 這一步同時是**健康指標**：差異數應該長期為 0。連續非零代表有事件來源漏接，要追到哪張表。
- 單次成本約等於現在探針總和（約 25 秒），一天一次，相對現在每天 144 次。

### 2.7 雙軌比對（切換前的驗證機制）

每支臂有三種模式，存在 `dispatch_gap_arms(arm, mode, recompute_fn, full_fn, cadence)`：

| 模式 | 派工用什麼 | 常駐表 | 用途 |
|---|---|---|---|
| `off` | 臂函式（現況） | 不維護 | 預設 |
| `shadow` | 臂函式（現況） | 維護，並每小時比對 | 新舊同跑只比不派 |
| `live` | 常駐表 | 維護，每天對帳 | 切換後 |

- shadow 比對：每小時一次，先 `gap_drain()` 清空、再算整表、與常駐表比（排除最近 2 分鐘內才重算的鍵，避免暫態誤報），差異寫入 `gap_reconcile_log`。
- **切 `live` 的門檻：連續 7 天每小時比對差異皆為 0**（含一個週六的中選會同步與凌晨名冊鏡像窗口；第 2 期要求涵蓋兩個週六）。暫態差異若需列入白名單，必須在 PR 寫明原因。
- 回滾：`UPDATE dispatch_gap_arms SET mode='shadow' WHERE arm='…'`，下一輪 seed（10 分鐘內）起該臂回到呼叫臂函式，常駐表仍繼續維護，可隨時再切回。
- **live 臂的每小時比對會順手修正（`20261127061500`，老闆 11-27 要縮短 shadow 期）**：同一支每小時 job（`dispatch_gap_shadow_compare()`）對 `live` 臂改成比對並修正（補開、補關、補更新，只動 `dispatch_gaps`、不碰 `task_dispatches`），`reconcile_runs.mode`＝`hourly`；`shadow` 臂照舊只記錄（mode＝`shadow`）。漏事件的影響上限因此從 24 小時（每日對帳）縮成 1 小時；修正前先取與 drain、每日對帳同一把 advisory lock，撞上 drain 時這一輪 live 臂退回只記錄、下一小時再補。
- 差異樣本（`20261127044115`）：`dispatch_gap_reconcile_runs.diff_sample`（JSONB）在 missing／extra／changed 任一大於 0 時存每類最多 20 個鍵，`{"missing":[鍵],"extra":[鍵],"changed":[{"key","table","live"}]}`，`table`／`live` 只放 payload 裡值不同的欄位；全 0 時為 NULL。查法：`SELECT arm, run_at, diff_sample FROM dispatch_gap_reconcile_runs WHERE changed > 0 ORDER BY id DESC`。

### 2.8 觀測（進巡檢）

沿用既有 `activity_health` 視圖（「正常是空的」那一套），新增項目：

| 項目 | 何時出現 |
|---|---|
| `gap_drain_stale` | 待重算清單最舊一筆超過 15 分鐘 |
| `gap_reconcile_drift` | 任一臂最近一次對帳差異數大於 0 |
| `gap_shadow_drift` | shadow 臂最近 24 小時比對差異連續非零 |
| `gap_dirty_failing` | 有鍵重試超過 5 次 |
| `gap_event_flood` | 某臂 1 小時內事件數超過平常 10 倍（疑似批次匯入） |

另有每臂每小時事件數、重算耗時，寫進既有 `seed_arm_timings`（`arm` 欄用 `gap:<臂名>`，沿用 7 天保留）。

### 2.9 規則之外的兩大塊：外層整理與 seed 本體各段

事件驅動只拿掉「規則重算」那一塊。依 5 輪均值（整輪 55.0 秒）拆開看：

| 區塊 | 秒數 | 佔比 | 事件驅動後 |
|---|---|---|---|
| 40 支規則重算（探針總和 25.2） | 25.2 | 46% | 改讀常駐表（第 1 到 3 期） |
| 總表後半 CTE 鏈（`arms_all` 38.5 減探針總和 25.2） | 約 13 | 24% | 第 3 期起改讀常駐欄位（下表） |
| priority（優先秒數） | 8.4 | 15% | 第 4 期改增量 |
| traffic_boost | 2.8 | 5% | 第 4 期改增量 |
| refresh_blocked_targets | 2.5 | 5% | 第 4 期評估 |
| update_existing | 1.0 | 2% | 隨 `source_version` 只處理有變的列 |
| 其餘（換號、收回、插入等） | 約 2.5 | 4% | 不動 |

**暫存檔來源判斷方法（第 0 期執行）。** 目前已知：臂本身不寫（單獨跑只寫約 21 MB，只有 `roster_unit_findings` 寫 2,699 區塊，其餘 Sort 與 Hash 都在 16 MB 工作記憶體內）；seed 整輪平均寫約 284 MB。要在第 0 期用兩種量法鎖定是哪一段：①對總表後半 CTE 鏈與 seed 各段 SQL 逐段 `EXPLAIN (ANALYZE, BUFFERS)`（唯讀）；②在 seed 每段前後記 `pg_stat_database.temp_bytes` 差值，寫進既有 `seed_arm_timings`（與各段計時同一處）。

**缺口常駐後，各段怎麼改（設計方向，數字待第 0 期量證）**

| 現在的步驟 | 為什麼貴 | 常駐後的做法 |
|---|---|---|
| 測試名人物過濾：對每一列把整份 target 轉成文字、與每個測試名 id 做 `strpos` | 約 3 萬列乘上測試名人物數，文字轉換與比對都在 CTE 鏈裡 | 缺口寫入時就把涉及的人物 id 存成 `person_ids`；人物改名成（或改離）測試名時，用 GIN 索引反查名下缺口、入列重算。讀取時不再比對字串 |
| 開窗：對每個（臂，選舉，職位）組問一次 `activity_open()`，再把結果 join 回 3 萬列 | 本身只有約 84 組，成本在 join 與 `DISTINCT` 的 7 千多列物化 | 缺口存 `eid`、`etype`，窗口組數仍是約 84，只剩一次小 join；規則窗口仍在讀取時判斷（第 4.4 節） |
| 名單收斂的 `tagged`／`tagged_g`：臂輸出與名單差異合併、附加 items | 兩個 `MATERIALIZED` 子查詢加多次 UNION 後再 join | 名單族整單位重算（第 2 期）時就產出最終列，讀取端不再合併 |
| 流量開窗：每列查 `page_traffic_hot` | 每列一次 `EXISTS` | `page_traffic` 每小時覆寫後，比較熱頁集合差異，只對新增或移除的人物與政見重算（第 4 期） |
| priority：每輪對全部缺口呼叫 `task_year_priority_seconds`、`task_band_seconds`，且要查 `task_dispatches` 看是否插隊中 | 3 萬列乘函式呼叫，8.4 秒；`_gaps` 還要被 UPDATE 好幾次，每次整列重寫 | 屆基準、層級、種類只取決於 target 與選舉，缺口開啟或內容變動時算一次存起來（`dispatch_gaps` 加 `band_seconds`）；每輪只補上「流量人數、需求疊加、插隊狀態有變」的列。`_gaps` 不再被多次 UPDATE |
| 排序：`queue_at` 由 `task_dispatches` 觸發器在每次寫入時重算 | 只有被寫入的列才會重算，本身不是大戶 | 維持現狀；因為增量化後被寫入的列變少，觸發器自然只處理變動的列。**不需要**把開窗改成在缺口表維護 `queue_at`：窗口不影響排序鍵 |
| `update_existing`：比對 6 個內容欄 | 對全部缺口逐列比對 | 缺口表 `source_version` 與 `task_dispatches` 對應欄位比較，只處理版本不同者 |

這一節的前提是「seed 後半仍維持現有結構」。若第 4 期評估後決定讓 `gap_drain()` 直接同步 `task_dispatches`（第 5 節末的可選項），這些步驟會進一步縮到幾乎只剩對帳。

---

## 3. 派工臂逐一評估

> 欄位說明：**判斷**＝能（逐列／逐鍵可算）／部分（需單位重算、有跨列聚合或要每日掃描）／不能（排名取前 N、外部資料或純時間到期，值得不改）。
> **探針耗時**＝2026-11-26 台北 12:35 單一樣本，各臂單獨 `count(*)`，**與總表內實跑成本不同**（探針會修剪沒用到的欄位；探針總和約 25.2 秒，總表段 `arms_all` 平均 36.3 秒，差的約 11 秒是外層整理，見 6.7）。列數是同次輸出。
> 「期別」＝計畫在哪一期改；「不改」＝成本低、不值得，維持現況每 10 分鐘全算。

### 3.1 `raw` 分支（8 個任務型別；整體探針 1,430 ms／16,238 列，各型別未分開量）

| 臂 | 缺口在找什麼 | 來源表與欄位 | 觸發事件 → 缺口鍵 | 判斷 | 期別 |
|---|---|---|---|---|---|
| raw:profile_gap | 當屆候選人缺出生年、現職或照片（一人一列，量最大） | politicians（birth_year、current_position、avatar_url）、politician_elections | politicians UPDATE、politician_elections 增改刪 → 人物 id | 能 | 3 |
| raw:policy_missing | 當屆候選人沒有當屆承諾；與 mayor_policies 共用同一個 task_id | policies、politician_elections、activity_rules | policies／politician_elections 變動 → 人物 id；activity_rules 變動 → 整臂重算 | 能 | 3 |
| raw:policy_validity | 政見沒有主要出處 | policies、source_refs（role=primary） | policies、source_refs → 政見 id | 能 | 3 |
| raw:progress_stale | 政見太久沒更新進度 | policies.last_updated、tracking_logs、politician_elections；用到今天日期 | 同上 → 政見 id；「第 91 天」翻轉無事件 | 部分：事件＋每日掃 | 3 |
| raw:candidacy_source_missing | 參選紀錄的來源欄沒有網址 | politician_elections.source_note | politician_elections → 人物 id | 能 | 3 |
| raw:roster_check | 縣市×選舉別的名單待清查 | roster_check_scope、locations、politician_elections 聚合、roster_checks、roster_reconcile_units | 見 3.3 名單族；到期冷卻是時間窗 | 部分 | 2（隨名單族） |
| raw:policy_election_missing | 政見沒有掛選舉屆別 | policies.election_id | policies → 政見 id | 能 | 3 |
| raw:candidate_status_stale | 登記截止後參選狀態仍是考慮中或空白 | politician_elections、roster_check_scope | politician_elections → 參選紀錄 id；窗口由規則層處理 | 能 | 3 |

### 3.2 其餘 35 個 UNION 分支（含 7 支目前停用）

| 臂 | 缺口在找什麼 | 來源表與欄位 | 觸發事件 → 缺口鍵 | 判斷 | 期別 | 探針 ms／列數 |
|---|---|---|---|---|---|---|
| mismatch | 政見的屆別與參選紀錄、日期對不上（五種訊號） | policies、politician_elections、elections、jev_decisions（屆別判決）；用到今天日期 | policies、politician_elections、jev_decisions（只限政見×屆別題）、elections.election_date → 政見 id；**「投票日當天翻轉」要每日掃** | 部分：事件＋每日掃 | **1** | 8,386／991 |
| legacy | 早期匯入、從未被核對過的政見 | policies、edit_history（audit）、contributions（applied_policy_id）、source_refs、politicians.merged_into | 這幾張表的對應列 → 政見 id | 能 | **1** | 2,379／6 |
| issue_too_broad | 某縣市某議題下沒有細項的承諾數超過門檻 | policies、policy_subtopics、politician_elections、regions、issues_scoped() | policies、policy_subtopics → （縣市，議題）；缺口取決於整組筆數 | 部分：單位重算 | **1** | 3,377／86 |
| roster_unit_findings（輔助） | 名冊差異彙成單位（內含已停用的七支臂的邏輯） | cec_roster_2026 鏡像、cec_candidates、politician_elections 等 | 鏡像單位更新、politician_elections → 單位（選舉，縣市，鄉鎮，職位） | 部分：單位重算 | 2 | 4,434／78 |
| roster_gap_units（輔助） | 官方名冊有而本站沒有的人／缺號次 | cec_roster_diff()、cec_roster_units | 同上；「鏡像 3 天過期」是時間 | 部分 | 2 | 1,232／7 |
| roster_gap_fresh_units（輔助） | 哪些單位的鏡像還新鮮 | cec_roster_units.fetched_at | 純時間＋外部抓取 | 不能（成本 1 ms，讀取時算） | 不改 | 1／442 |
| ballot_numbers | 已登記但沒號次的人，彙成單位、每 50 人一件 | politician_elections、cec_roster_2026、election_milestones_all；**ROW_NUMBER 切 50 人** | politician_elections.cand_no／狀態、鏡像重抓 → 單位（整單位重算） | 部分：單位重算 | 2 | 980／4 |
| roster_cec_gap | 中選會名單明顯比我們多的單位 | cec_candidates、politician_elections、roster_checks | 同名單族 | 部分 | 2 | 181／151 |
| roster_villages | 各鄉鎮村里長名單待清查 | roster_check_scope、electoral_district_areas、roster_checks | 同名單族；冷卻是時間 | 部分 | 2 | 96／41 |
| district_seats | 議員／代表選舉區的應選名額缺漏 | election_districts、cec_registrations、contributions | election_districts、cec_registrations → （選舉，縣市，職位） | 部分：單位重算 | 2 | 86／24 |
| term_policies | 當選人在該屆沒有任何政見 | politician_elections、policies、politician_bulletins、election_task_config、task_dispatches；**村里長有 ROW_NUMBER 配額** | policies、politician_elections → （人物，屆別）；村里長配額要整體算 | 部分：非村里長逐鍵；村里長每小時整臂算 | 3 | 926／261 |
| policy_dup | 某人名下政見 2 筆以上、目前清單指紋沒審過 | policies（COUNT）、policy_dupe_reviews | policies 增刪改 → 人物 id（指紋變＝換號，舊列關） | 部分 | 3 | 488／9,217 |
| dup | 同名人物疑似同一人（自連接配對） | politicians、politician_elections、jev_decisions、contributions | politicians 改名／出生年／合併 → 該同名組全部配對 | 部分：鍵集合＝同名組 | 3 | 455／20 |
| placeholder_politicians | 測試名人物與被改掛走的空殼人物 | politicians＋約 10 張關聯表的 NOT EXISTS | 各表對該人物的增刪 → 人物 id | 部分：觸發表多 | 3 | 175／0 |
| lineage_candidates | 同一格政見可歸成脈絡 | lineage_candidate_scope()、lineages、lineage_candidate_reviews；指紋、LIMIT 30 | policies、lineages、reviews → 格（block_key） | 部分 | 3 | 102／22 |
| manual_open | 開著的手動任務 | contribution_tasks、citizen_questions | **已有觸發器入列**（contribution_tasks_insert_dispatch）；臂只是對帳 | 能 | 不改（已事件式） | 101／2,443 |
| manual_visitor | 網站請求與公民提問 | 同上、web_request_coverage（讀 task_dispatches） | 同上；覆蓋判斷有循環依賴 | 能（有循環依賴例外） | 不改 | 78／219 |
| career_sources | 學經歷項目沒有出處 | politician_careers、source_refs | 同左 → 人物 id | 能 | 3 | 69／6 |
| party_info | 政黨的改名日／名冊外對應／解散日未填 | parties、politicians.party_id、politician_elections.party_id | parties、使用者人物 → 政黨 id | 部分：「有人用到」要查有沒有其他使用者 | 3 | 43／5 |
| regional_stats_missing | 縣市、鄉鎮缺最新年度統計 | admin_divisions、regional_stats、contributions、activity_rules.params | regional_stats 等 → admin_code；規則參數變動整臂重算 | 能 | 3 | 33／310 |
| mayor_policies | 縣市長候選人政見件數偏少 | politician_elections、policies、contributions（聚合）、activity_rules | 同 policy_missing，兩臂要一起重算 | 能 | 3 | 32／5 |
| not_running | 退選但從未核對 | politician_elections、edit_history | → 參選紀錄 id | 能 | 3 | 26／0 |
| policy_elements | 當選者政見缺三要素 | policies、policy_elements、politician_elections、contributions；用到投票日是否已過 | → 政見 id；「投票日已過」翻轉要每日掃 | 能＋每日掃 | 3 | 15／0 |
| lineage_status | 脈絡現況缺漏或過期 | lineages、lineage_statuses、task_checks；**ROW_NUMBER 上限 20＋純時間到期** | — | 不能（成本 12 ms） | 不改 | 12／0 |
| lineage_roles | 脈絡內民代缺參與角色 | lineage_participants、policies | → 脈絡 id | 部分 | 3 | 10／99 |
| handover_missing | 首長卸任卻沒有交接紀錄（取下一任＝DISTINCT ON） | policies、politician_elections、handovers | 當選者變動 → 同職位全部重算 | 部分 | 3 | 10／0 |
| lineage_stances | 脈絡內該表態的人缺立場（**ROW_NUMBER 前 30 人＋上限 20**） | lineage_stances 等 | — | 不能（成本 9 ms） | 不改 | 9／0 |
| lineage_links | 上下級脈絡缺關聯（自連接＋指紋） | lineages、lineage_links | → 脈絡 id＋可能的上級候選 | 部分 | 3 | 5／21 |
| lineage_events | 脈絡沒有事件或太久沒新事件 | lineage_events、lineage_statuses | — | 不能（成本 3 ms） | 不改 | 3／0 |
| withdrawn_filing | 退選但看不出退選前有沒有登記 | politician_elections、contributions | → 參選紀錄 id | 能 | 3 | 3／1 |
| deadline_due | 達成期限已過卻沒有追蹤 | policy_elements、tracking_logs、policies；用到今天日期 | → 政見 id；「期限當天」翻轉要每日掃；**同時影響 progress_stale** | 能＋每日掃 | 3 | 3／1 |
| township_gap、region_gap、elected_missing、party_gap、party_roster、election_results、owner_mismatch | **七支目前被「名單清查收斂」開關整支停用（輸出 0）；它們的邏輯改在 roster_unit_findings 內執行** | — | — | 停用（不單獨處理，隨名單族） | 2 | 0 |

### 3.3 數量統計

| 判斷 | 支數 | 組成 |
|---|---|---|
| 能 | 16 | raw 6 型（policy_missing、profile_gap、policy_validity、policy_election_missing、candidate_status_stale、candidacy_source_missing）、legacy、not_running、mayor_policies、career_sources、withdrawn_filing、regional_stats_missing、policy_elements、deadline_due、manual_open、manual_visitor |
| 部分 | 17 | raw 2 型（progress_stale、roster_check）、mismatch、issue_too_broad、ballot_numbers、roster_cec_gap、roster_villages、district_seats、term_policies、policy_dup、dup、placeholder_politicians、lineage_candidates、lineage_roles、handover_missing、lineage_links、party_info |
| 不能 | 3 | lineage_status、lineage_stances、lineage_events（排名上限加純時間到期；合計成本 24 ms，不改） |
| 停用 | 7 | 名單收斂停用的七支，邏輯併入名單清查輔助函式 |
| 輔助（不計入上表） | 3 | roster_unit_findings（部分）、roster_gap_units（部分）、roster_gap_fresh_units（不能，成本 1 ms） |

另有 4 處需要每日掃描補時間翻轉：progress_stale、deadline_due、policy_elements，以及 mismatch 的兩種日期訊號，見第 4.3 節。

---

## 4. 收回語意

### 4.1 現在怎麼收

seed 是「總表這一輪沒回這個缺口＝缺口消失」：

| seed 段落 | 現在做什麼 | 依賴「這輪沒回＝消失」嗎 | 事件驅動後 |
|---|---|---|---|
| arms_all | 全部臂算一次，含被規則窗口濾掉的列 | 是，來源 | 改讀常駐表（已切換的臂） |
| gaps | 取窗口開著的列，依 task_id 去重 | 否 | 不改 |
| traffic_boost／priority | 對全部缺口算優先秒數 | 否（看缺口內容） | 第 4 期改增量 |
| rekey_prev | 指紋換號：舊列被收回前，把排隊位置交給新列 | 是，舊 task_id 不在這輪輸出 | 不改，但 `gap_drain()` 必須在**同一次**重算裡同時關舊鍵、開新鍵 |
| close_gaps（window） | 臂仍算得出、窗口關了 → 收回，記 `window` | 是 | 不改，窗口仍在讀取時判斷 |
| close_gaps（filled） | 臂算不出來了 → 收回，記 `filled` | **是，核心依賴** | 改成：缺口在常駐表被關閉（`closed_at` 非空）＝這輪不回。seed 這段程式不用改 |
| update_existing／insert_new | 內容變了才改、沒有才開 | 否 | 不改 |
| verify_insert／刪除 | 驗證票與缺口無關 | 否 | 不改 |
| refresh_dispatch_blocked／verify_targets | 依在途交件標阻擋 | 否 | 第 4 期評估增量 |

### 4.2 「關閉事件」從哪來

- **資料事件關閉**：補上缺口的資料寫進來（政見進庫、出處掛上、名冊對上），觸發器入列，`gap_drain()` 重算後該缺口不在輸出裡 → 關閉。
- **既有的即時收回保留**：`contributions_drop_dispatch`（交件落庫時直接刪 `task_dispatches` 的列）與手動任務的三支觸發器已經是事件式，不動。**但要小心一種競態**：落庫後佇列的列被立刻刪掉，若常駐表的缺口還沒被關，下一輪 seed 會把它重新開回來。對策是 seed 開頭先 `gap_drain()`，同交易就看得到落庫後的資料。
- **兜底**：每日凌晨對帳補收漏關的（`closed_reason='reconcile'`）。
- **關閉的延遲**：事件到關閉最長約 5 分鐘（worker 週期）；再到佇列收回最長約 10 分鐘（seed 週期）；與現況相同或更好。

### 4.3 純時間造成的缺口翻轉

有些缺口會因為「日期到了」而出現或消失，沒有任何資料列變動：政見超過 90 天沒更新（progress_stale）、達成期限當天（deadline_due）、投票日當天（mismatch 的兩種訊號、policy_elements 的「投票日已過」）、三支脈絡臂的到期。對策：

- 臂註冊時標記 `cadence = 'event+daily'`，**每日凌晨對帳那一次全量算，同時負責補這類翻轉**。
- 這些翻轉的容許延遲是「最長一天」。對照現況每 10 分鐘，但這類缺口的意義是「這件事很久沒人看」，晚一天不影響派工品質。需要當天零時就出現的（投票日、期限日），另可在台北 00:05 加跑一次該臂的整表重算（只含這 4 支臂，成本極小）。

### 4.4 為什麼不把「規則窗口」做成排程事件

原先構想是最後一期把窗口型臂改成「里程碑到期時由每日 job 發事件」。查證後我們**建議不採用**：

1. 窗口只決定「缺口要不要被看見」，不決定「缺口存不存在」。現在 seed 已經把這兩件事分開記成 `window` 與 `filled` 兩種收回原因。
2. 常駐表存的是窗口之前的臂輸出，窗口由總表外層讀取時對約 84 組（臂×選舉×職位）各問一次，成本是毫秒級。這樣窗口設定變動（主控台改規則、里程碑日期改）**立即生效**，不需要任何事件。
3. 若把窗口寫進缺口表，就得在里程碑日期、規則、覆寫三處任一變動時重寫大量缺口，反而多出一類事件風暴。

只有臂函式**內部**的日期條件（上節）需要每日掃描。

---

## 5. 分期計畫

> 耗時估計以「秒／單輪」表示，來源是第 3 節探針（單樣本）與 seed 各段 7 輪平均（總計平均 53.0 秒：找缺口 36.3、優先秒數 8.6、流量提層 2.9、阻擋標記等 2.4、更新 0.9、換號 0.7、收回 0.4、其餘 0.7）。**每期的預估是「該期臂的探針耗時」直接扣除，並假設切換後讀表成本小於 1 秒；實際值以每期上線後的 `stage:arms_all` 為準。**
> 工時以工作天粗估，只用來排序，不是承諾。

### 第 0 期：地基（約 4 到 5 個工作天，2 到 3 個 PR）

> **PR-1 已上（2026-11-26，`20261126170000_dispatch_gaps_phase0.sql`，守門 `dispatch-gaps-phase0.test.ts`）**：建了 `dispatch_gaps`、`dispatch_gap_events`（附錄的 dirty 表，改名並保留處理歷史）、`dispatch_gap_reconcile_runs`（附錄的 gap_reconcile_log）、`dispatch_gap_arm_keys`（臂登記與缺口鍵規則，三支第 1 期臂已登記）、`dispatch_gap_settings`；函式 `dispatch_gap_enqueue`、`dispatch_gap_drain`（保底實作＝整表跑一次只取該批鍵的缺口；登記了按鍵版函式就自動改走它）、`dispatch_gap_reconcile_all`、`dispatch_gap_shadow_compare`、觸發器函式 `dispatch_gap_on_change`（不掛正式表）。**只建不派**：沒掛觸發器、沒排 cron、seed 與總表未動。
> **PR-2 已上（2026-11-26，`20261126180000_dispatch_gaps_phase0b.sql`，守門 `dispatch-gaps-phase0b.test.ts`；預設狀態下派工行為一字不變）**：
> - **臂模式表** `dispatch_gap_arms`（off／shadow／live，查不到＝off；總表所有臂含 raw 八型與七支停用臂都登記成 off，`traffic:*` 不是獨立臂不登記）、`gap_arm_mode()`、切換用 `dispatch_gap_set_mode(臂, 模式, 備註)`（shadow／live 要求臂已登記在 `dispatch_gap_arm_keys`）。
> - **總表二段式**：新版 `contribution_auto_tasks_arms()` 開頭多一個 `live_arms` CTE（模式是 live 的臂；全 off 時是空集合），每支臂分支多一個「沒被切成 live」條件，並有一個共用的 live 分支改讀 `dispatch_gaps` 開著的列（`dispatch_gap_rows_all()`，還原成臂函式輸出的形狀）；raw 與 deadline_due 因為是 CTE，在 CTE 裡二選一。**前一版整支保留成 `contribution_auto_tasks_arms_v20261126()`**。全 off 等價的證明：PGlite 同一組假資料新舊兩版 EXCEPT 雙向 0（含旗標 `gap.arms_all`、名單清查收斂開關兩種情況），另有文字層守門：前一版與 20261120170000 逐字相同、新版拿掉二段式標記後與前一版逐字相同。
> - **seed 開頭 drain**：`seed_auto_task_queue()` 開頭受 `dispatch_gap_settings.seed_drain_enabled`（預設 false）控制呼叫 `dispatch_gap_drain()`，失敗只丟 WARNING；拿掉標記區塊後與 20261126150000 逐字相同。
> - **排程**（pg_cron 以 UTC 計時，分鐘都避開整十、:29、:35 與奇數分鐘）：`dispatch-gap-shadow-compare-hourly`（:48，只比模式不是 off 的臂，全 off 空轉）、`dispatch-gap-reconcile-daily`（UTC 19:32＝台北 03:32，mode＝off 的臂只記差異不改常駐表）、`dispatch-gap-retention-daily`（UTC 20:26＝台北 04:26，events 處理完 >7 天、reconcile_runs >30 天）、`seed-arm-temp-probe-daily`（UTC 20:44＝台北 04:44，見下）。
> - **觸發器函式補齊**（仍不掛正式表）：`dispatch_gap_on_change` 多 politician_elections、politicians、contributions、tracking_logs 四個分支；只對已登記在 `dispatch_gap_arm_keys` 的臂入列。
> - **外層整理量測（第 6.7 節兩個未知數）——結論：seed 內各段量不到**。正式庫 PG 17.6 唯讀實測：同一交易內 `pg_stat_database.temp_bytes` 不會更新（前後值相同，`pg_stat_force_next_flush()` 也一樣）；`pg_stat_statements` 只追蹤頂層語句（`track=top`），seed 函式內的語句看不到。所以改成程序 `seed_arm_temp_probe()`：每支臂與整張總表各自一個交易（段間 COMMIT），交易前後比 `temp_bytes`，寫進 `seed_arm_timings.temp_bytes`（`arm` 欄為 `temp:<臂名>`，整張總表為 `temp:arms_all`）。「總表後半 CTE 鏈」的暫存 ≈ `temp:arms_all` 減各臂加總；seed 本體其餘各段（建 `_gaps`、更新、插入…）的暫存仍量不到，要另案（例如讓 seed 拆成多個交易，或開 `pg_stat_statements.track=all`）。數字含同時段其他連線的暫存，排在清晨低流量時段每天一次，看量級不看精確值。
> - **尚未做**：`activity_health` 五個巡檢項改由私人 repo policy-ops 的 ops-check「派工缺口」段觀測（policy-ops 另一支 PR）；`arms-parity` 同款正式庫快照比對留到第 1 期切 shadow 時一起做。
> - **回滾**：取消四個 cron、總表與 seed 換回前一版定義、`reconcile_all`／`on_change` 換回 20261126170000 版，新物件清單見 migration 檔頭。

| 項目 | 內容 |
|---|---|
| 新增 | `dispatch_gaps`、`dispatch_gap_dirty`、`dispatch_gap_arms`、`dispatch_gap_settings`、`gap_reconcile_log`；`gap_enqueue()`、`gap_drain()`、`gap_reconcile_all()`、`gap_arm_mode()`、`dispatch_gaps_open(arm)` |
| 改動 | 總表每個臂的分支加上「模式＝live 才讀表」的二段式（所有臂預設 `off`，輸出逐列不變）；`seed` 開頭加 `PERFORM gap_drain()`；`activity_health` 加五個巡檢項 |
| 量測 | 這一期**先量清楚外層整理步驟**：總表去掉臂之後的 CTE 鏈與 seed 本體各自的時間與暫存檔寫入量，對應第 6.7 節兩個未知數 |
| 守門測試 | 新增臂時必須登記 `dispatch_gap_arms`（沿用「新增一支派工臂要三處一起加」的守門，變成四處）；二段式分支與 `off` 模式輸出等價比對 |
| 驗證 | 全部臂 `off`，全站派工輸出與改前逐列相同（`scripts/arms-parity.ts` 同款快照比對）；seed 耗時不增加超過 3% |
| 回滾 | 還原總表與 seed 兩個函式定義（`CREATE OR REPLACE` 要帶 `SET work_mem`／`statement_timeout`）；新表可留著 |
| 節省 | 0 秒（地基） |

### 第 1 期：最貴且事件最單純的三支（約 6 到 8 個工作天，加 7 天雙軌）

| 臂 | 探針 ms | 事件鍵 | 備註 |
|---|---|---|---|
| mismatch | 8,386 | 政見 id | 五種訊號都以政見為單位；`jev_decisions` 每天約 2.3 萬筆新增，觸發器只在「政見×屆別題」才入列；投票日翻轉歸每日掃 |
| issue_too_broad | 3,377 | （縣市，議題） | 先確認 `issues_scoped()` 能否反推鍵；不能則以縣市為單位重算 |
| legacy | 2,379 | 政見 id | #1044 已收窄過；改按鍵後單鍵成本接近零 |

> **PR-1 已上（2026-11-26，`20261126193000_dispatch_gaps_phase1a.sql`，守門 `dispatch-gaps-phase1.test.ts`；派工輸出不變）**：三支臂的按鍵重算 `dispatch_gap_recompute_legacy／_mismatch／_issue_too_broad(p_keys)`（本體與現行臂函式逐字相同，只加鍵過濾，測試逐行比對）、`dispatch_gap_on_change()` 對得更細、觸發器掛上 policies、politician_elections、politicians、jev_decisions、edit_history、source_refs、contributions、policy_subtopics、elections、activity_rules 共 12 支（UPDATE 一律 OF 欄位，高頻表加 WHEN）、新增投票日翻轉排程 `dispatch-gap-date-flip-daily`（台北 00:04）、三支臂切 **shadow**、`events_enabled` 與 seed 開頭 drain 總開關打開、遷移內對三支臂各做一次初始灌入。
> - **shadow 起算日 2026-11-26**（連跑 7 天，最早 2026-12-03 評估切 live）。
> - **切 live 條件**：①每小時雙軌比對（`dispatch_gap_reconcile_runs`，mode＝shadow）連續 7 天 missing＝extra＝changed＝0；②每日對帳（mode＝reconcile）沒有補開補關；③切換前後各 24 小時 `gap_events` 的 opened／closed 數與 `task_dispatches` 派出分佈臂別差距在容許範圍；④seed 開頭 drain 耗時在三支臂都有按鍵版的情況下穩定在秒以內（整臂事件〔issue_too_broad 的政見變動、mismatch 的設定變動〕仍會觸發整表保底，要看佔比）。逐臂切：`SELECT dispatch_gap_set_mode('legacy', 'live', '…')`，回滾 `'shadow'`。
> - **鍵怎麼來**：legacy、mismatch 事件入 `policy:<政見 id>`；mismatch 在參選紀錄變動時只入「同一個人同一屆」的政見；issue_too_broad 的政見／參選紀錄變動反推不出（縣市，議題），入整臂 `*`（但只在 2026 競選承諾相關時入），在途細項貢獻能從 payload 組出 `issue:<選舉>:<縣市>:<議題>` 就入單一鍵。**mismatch 的投票日翻轉不是資料變更**，由 `dispatch_gap_date_flip()` 在投票日當天補一筆整臂事件。
> - **已知限制**：issue_too_broad 沒有（縣市，議題）級的事件來源，政見或 2026 參選紀錄一動就整臂重算約 3.5 秒（shadow 期 seed 開頭的 drain 會多這一段）；之後若切 live 前要壓低，可把 issues_scoped 的縣市拆開入列。`politicians.name` 變動對 issues_scoped 的「不是議題的名字」過濾有極小影響，這期不入列，靠每日對帳補。

- 三支合計 **14,142 ms，佔探針總和 56%**。預估單輪 53 秒 → 約 **39 秒**。
- 做法：每支臂函式加 `p_keys` 參數；註冊 `dispatch_gap_arms`；shadow 7 天；零差異後切 `live`。
- 驗證不漏派不重派：①shadow 每小時比對差異＝0 連續 7 天；②切換前後各抓 24 小時的 `gap_events`（opened／closed 數）與 `task_dispatches` 派出分佈，臂別數量差距在容許範圍；③切換後對帳 `only_old／only_new／changed` 皆 0。
- 回滾：該臂 `mode='shadow'`，一行指令、下一輪 seed 生效。

### 第 2 期：名單清查整族（約 8 到 10 個工作天，加 14 天雙軌）

涵蓋：roster_unit_findings（含七支停用臂的邏輯）、roster_gap_units、ballot_numbers、roster_cec_gap、roster_villages、district_seats、raw:roster_check。

> **PR-1 已上（2026-11-27，`20261127044503_dispatch_gaps_phase2a.sql`，守門 `dispatch-gaps-phase2.test.ts`；派工輸出不變）**：涵蓋 roster_unit_findings、roster_gap_units、ballot_numbers 三支（名單族裡探針最貴的三支，合計約 6.6 秒）；roster_cec_gap、roster_villages、district_seats、raw:roster_check 留給 PR-2。
> - **鍵**：roster_unit_findings 與 roster_gap_units 的缺口鍵是 task_id（`auto:roster_check:<選舉>:<縣市＋鄉鎮>:<職位>`），重算單位 `unit:<選舉>:<縣市＋鄉鎮>:<職位>`（臺→台）；ballot_numbers 的重算單位 `ballot:<選舉>:<職位>:<縣市>:<鄉鎮或空>`，cand_no、cand_no_recheck 與所有 `pN` 分件同一個鍵，只能整單位重算（ROW_NUMBER 每 50 人切件）。task_id→鍵在 `dispatch_gap_scope_key()`，資料欄位→鍵在 `dispatch_gap_roster_keys()`／`dispatch_gap_ballot_keys()`，測試逐筆驗兩邊對得上。
> - **按鍵重算**：`dispatch_gap_recompute_roster_unit_findings／_roster_gap_units／_ballot_numbers(p_keys)`，本體與現行函式逐字相同、只多單位鍵過濾（測試逐行比對最新定義）。roster_unit_findings、roster_gap_units 是總表的輔助函式（`fnd`、`gapu` 兩個 CTE），不是 UNION 分支：切 shadow 只代表常駐表維護與雙軌比對，**總表永遠不讀它們**；ballot_numbers 是總表的真分支，shadow 時總表照舊即時算。三支都是 shadow，初始灌入已做，每小時雙軌比對由 `dispatch_gap_shadow_run()` 一併處理（現在共六支）。
> - **事件**：politician_elections（欄位清單加 cand_no、party_id、party_basis、withdrawn_after_filing）、politicians（加 birth_year、party）、contributions（加 cand_numbers、candidacy、election_results、reassign_candidacy，payload 組得出單位就入單位，組不出就整臂）、elections、election_milestones、contribution_tasks（參選狀態查證）、roster_unify_settings；名冊鏡像是批次寫入，不逐列：`cec_roster_units`（每個單位同步最後一步 UPDATE 一列）列層級觸發器入該單位，`cec_candidates`、`cec_registrations` 語句層級（轉換表）一個語句最多一筆整臂。另提供 `dispatch_gap_enqueue_units(選舉, 職位, 縣市, 鄉鎮, 原因)` 給同步函式結束處呼叫（Edge Function 端要呼叫另一支 PR 補，現在已有觸發器涵蓋）。時間翻轉：`dispatch-gap-date-flip-roster`（UTC 00:06、16:06）。
> - **已知限制**：①名冊鏡像「3 天內抓成功」的新鮮度過期是時間造成、沒有事件，靠每小時雙軌比對與每日對帳補；②roster_unit_findings、roster_gap_units 的鍵過濾在單位彙總那一層，底下的 `roster_diff_findings()`（七支臂的合併）與 `cec_roster_diff()` 沒有單位參數、仍整表算一次，所以一批事件的成本約等於一次整臂（約 4.4 秒與 1.2 秒），把鍵推進它們留給 PR-2；③名冊鏡像單位同步會讓補號次整臂重算（「不在官方名冊」的排除是縣市層級），約 1 秒；④`cec_candidates`、`cec_registrations` 的語句只要有影響到列就整臂。實查 `cec-sync` 是「依單位 delete 再分批 insert」（不是 upsert），每次同步都會刪寫，所以每次同步（選舉夜每 10 分鐘、平時每週）都會入 roster_unit_findings 整臂，與現況每輪全算相同、沒有更糟；`cec_registrations` 只有 migration 載入。**建議 PR-2 改成同步函式結尾呼叫 `dispatch_gap_enqueue_roster_units`（帶該單位）取代語句觸發器**，整臂才降成單位；⑤事件盲區（沒有觸發器，靠每小時雙軌與每日對帳補，shadow 期間這些來源的變動會讓雙軌短暫出現差異，不是漏接錯誤）：regions、election_districts、task_checks、edit_history（region_gap 看的修改紀錄）、verification_sources、cec_registration_sources、cec_results_auto_plan、parties／party_aliases、politician_pair_resolutions；PR-2 把鍵推進 `roster_diff_findings()`／`cec_roster_diff()` 時一併補。⑥`cec_roster_units` 的 town 對鄉鎮市民代表、直轄市山地原住民區民代表是空的（投票後這兩職位的名冊單位是縣市＋鄉鎮），所以這兩個職位的鏡像事件改入名冊兩支的整臂。⑦`dispatch_gap_set_mode` 對非總表 UNION 分支的臂（roster_unit_findings、roster_gap_units 是輔助函式）拒絕 live。⑧contributions 分支的名單族新段包了例外處理，payload 的 election_id 只收 1～9 位數字，怪值只丟 WARNING、不會讓那筆交件寫入失敗。
> - **回滾**：`dispatch_gap_set_mode(<臂>, 'off')`、`events_enabled=false`、`cron.unschedule('dispatch-gap-date-flip-roster')`；觸發器與函式的退回清單在 migration 檔頭。

- 探針合計約 **7,010 ms（28%）**，預估單輪約 **32 秒**。
- 重算單位＝（選舉，縣市，鄉鎮，職位）。外部名單同步（`cec_roster_2026`、`cec_candidates`、`cec_registrations`）是**批次寫入**，觸發器改用單位層級入列（同步函式結束時一次性入列該單位，不逐列觸發）。
- 風險最高的一期：名冊鏡像只在台北 02–06 點更新、2026 的名冊對帳目前暫停（11-07 起，手動分組任務替代）、`ballot_numbers` 與 `election_results` 有 ROW_NUMBER 分批（單位內增減一人會讓後面的 part 全部位移，因此**只能整單位重算**，不能只算那一個人）。
- 雙軌要涵蓋至少兩個週六（中選會週同步）與兩個凌晨鏡像窗口。
- 回滾同第 1 期。

### 第 3 期：其餘人物／政見層級的臂（約 8 到 10 個工作天）

- 涵蓋第 3.1、3.2 節標「3」的臂：raw 其餘 6 型、term_policies、policy_dup、dup、placeholder_politicians、lineage_candidates／roles／links、handover_missing、career_sources、party_info、regional_stats_missing、mayor_policies、not_running、policy_elements、withdrawn_filing、deadline_due。
- 探針合計約 **4,000 ms**，單獨看不大；**這一期的真正價值是把外層整理搬走**：因為此時全部大臂都改讀常駐表，外層（窗口檢查、測試名人物過濾、流量門檻）可以改讀常駐表上已算好的 `eid／etype／person_ids`，不再對 3 萬列做 `strpos(target::text, …)`。找缺口段比探針總和多約 11 到 13 秒，就是第 2.9 節的 CTE 鏈，**預估單輪 → 約 20 秒（含外層整理的減少，推測值，第 0 期量測後修正）**。
- 日掃機制在這一期正式啟用：progress_stale、deadline_due、policy_elements 與 mismatch 的日期翻轉（mismatch 在第 1 期就需要日掃，機制在第 0 期備好，這一期擴到其他臂）。
- 不改：manual_open、manual_visitor（已事件式）、lineage_status／stances／events（合計 24 ms）、roster_gap_fresh_units。這些留在每 10 分鐘全算的輕量路徑。

### 第 4 期：外層常駐化（約 5 到 7 個工作天）

| seed 段落 | 平均 | 做法 |
|---|---|---|
| priority | 8,628 ms | 優先秒數的輸入（屆別、層級、種類）在缺口開啟或內容變動時就算好、存在常駐表；每輪只重算「流量人數或需求疊加有變」的列 |
| traffic_boost | 2,866 ms | `page_traffic_hot` 每小時覆寫一次，改成覆寫後比較熱頁集合的差異，只重算新增或移除的人物／政見名下缺口 |
| refresh_blocked_targets | 2,448 ms | 阻擋標記與驗證目標分數已有觸發器雛形（`trg_contributions_verify_has_votes`），評估改為事件式；不確定可行，列為第 4 期內的探索項 |
| update_existing／rekey／close | 約 2,000 ms | 常駐表有 `source_version`，只處理版本有變的列 |

- 預估單輪 → 約 **7 到 10 秒**（推測值）。
- 可選的下一步（**不在本計畫承諾內**）：`gap_drain()` 直接同步 `task_dispatches`（缺口開關即時反映到佇列），seed 縮成「對帳＋優先秒數＋阻擋標記」。需先確認與換號沿用排隊位置的相容性。

### 5.1 各期節省彙總（估計）

| 期 | 本期切換的探針耗時 | 累計單輪秒數（估） | 累計相對現況 |
|---|---|---|---|
| 現況 | — | 53 | — |
| 第 1 期 | 14.1 秒 | 約 39 | 約 −26% |
| 第 2 期 | 7.0 秒 | 約 32 | 約 −40% |
| 第 3 期 | 4.0 秒＋外層整理（推測 5 到 11 秒） | 約 20 | 約 −62% |
| 第 4 期 | 優先秒數等 10 到 14 秒 | 約 7 到 10 | 約 −80 到 −87% |

暫存檔與記憶體：見第 6.7 節，**不在第 0 期量清楚前承諾具體數字**。

---

## 6. 風險與邊界

### 6.1 漏事件（最大風險）

- **來源**：觸發器被繞過（`session_replication_role = replica` 的批次匯入、`pg_restore`）、有人手動 `UPDATE`／`DELETE` 時關了觸發器、新增了影響缺口的資料來源卻沒人加觸發器、`TRUNCATE`（不觸發列級觸發器）。
- **對策**：①shadow 期每小時比對；②切換後每日凌晨全量對帳，差異數進巡檢；③守門測試掃每支臂的 SQL 讀了哪些表，與觸發器清單比對，**臂讀了某張表卻沒有對應觸發器就紅**（做法同 `activity-arms.test.ts` 的登記守門）；④降級保護：worker 掛了就自動退回整表算。
- **漏事件的最壞後果**：缺口多開（派出一張已補上的工單，代理回報「已存在」，浪費一次派工）或漏關／漏開（缺口晚一天才出現）。不會寫壞資料，因為派工只是建議，落庫仍要通過共識與落庫守門。

### 6.2 觸發器拖慢寫入路徑

- 高頻表近 7 天新增量：貢獻約 4.6 萬、投票 9.0 萬、`jev_decisions` 16.4 萬（每天約 2.3 萬）、來源引用 4.3 萬、政見更新 3.9 萬。
- **鐵則：觸發器只入列，不重算。** 一次 `INSERT … ON CONFLICT DO NOTHING` 到一張小表；過濾條件（只有影響缺口的欄位或題目才入列）寫在觸發器的 `WHEN` 子句，不讓函式白跑。
- 大批寫入（名單同步、`merge_politician`）改用語句層級觸發器（用過渡表一次入列），避免逐列觸發。注意 PostgreSQL 的過渡表不能搭配欄位清單（`UPDATE OF`），所以這類觸發器要在函式內自己比對新舊值。
- 待重算清單是高流量小表，要比照 `task_dispatches` 調勤 autovacuum，並設保留上限。
- **每期上線前要在 PGlite 測入列成本，上線後看 `pg_stat_statements` 的觸發器耗時**；若某表入列成本超過寫入本身的 10%，改成語句層級。

### 6.3 事件風暴

- 名單同步、人物合併、改選舉日期、改規則（`activity_rules`）會一次影響大量缺口。
- 對策：待重算清單同鍵合併；某臂待重算超過門檻就整臂重算（第 2.4 節）；對帳日誌記錄每臂事件量，異常放大時巡檢提示。

### 6.4 與現有機制的互動

- **跨臂共用 task_id**：`policy_missing` 同時由 raw 與 mayor_policies 產生。事件要同時入列兩臂，主鍵含 `arm`，seed 既有的 `DISTINCT ON (task_id)` 會繼續去重。
- **讀 `task_dispatches` 的臂**：term_policies（「已開者保留」）與 web_request_coverage（manual_visitor）有回饋依賴，事件版不要求一致性更強，而是維持「已開不收」的語意；term_policies 的村里長配額改為每小時整臂算。
- **指紋換號臂**：lineage_candidates、lineage_links、policy_dup（duplicate_policy）的 task_id 末段是指紋，格內任何政見變動就換號。`gap_drain()` 必須在同一次重算裡把舊鍵關閉（`closed_reason='superseded'`）、新鍵開啟，seed 的換號沿用排隊位置才能照常運作。
- **gap_events**：由 `task_dispatches` 的觸發器寫，來源不變，收回原因 `window`／`filled` 語意不變。

### 6.5 與日本站（`policy_jp`）

本計畫只改台灣站。日本站 seed 與臂是複本函式，由 `policy-jp-dispatch-drift.test.ts` 管差異；本計畫的 `dispatch_gaps` 架構（登記表加按鍵函式加常駐表）與 schema 無關，日本站要用時另建 `policy_jp.dispatch_gaps`。台灣站動到的函式在該守門測試登記「日本站暫不跟」，並在通知單裡提醒日本站負責人。

### 6.6 失敗模式與降級

| 失敗 | 偵測 | 自動反應 |
|---|---|---|
| worker 連續失敗 | `gap_dirty_failing`、`gap_drain_stale` | 超過 30 分鐘，live 臂自動退回整表算 |
| 對帳差異突然變大 | `gap_reconcile_drift` | 人工判斷；單臂 `mode='shadow'` 即可退回 |
| 觸發器異常拖慢寫入 | `pg_stat_statements` | `events_enabled=false` 全域關閉，靠對帳兜底 |

### 6.7 沒查到或不確定的事

1. **暫存檔量與擁有者的認知不同。** 另一位代理（PR #1048 草稿的量證）量到：`SELECT seed_auto_task_queue()` 5 次共寫暫存 181,805 區塊，**平均每輪約 290 MB**；我今天再查，8 次累計約 2.3 GB、平均每次約 284 MB。單獨跑全部 40 支臂只寫約 2,700 區塊。臂本身幾乎不寫暫存檔，暫存檔來自臂**之後**的整理步驟或 seed 本體。因此「臂事件驅動」不保證暫存檔降到零。第 0 期要先逐段量（第 2.9 節），並找出是否有少數輪次特別大。
   另注意：基準數字有兩組，本文第 3 節與第 5 節用我查到的 7 輪平均（整輪 53.0 秒、找缺口段 36.3 秒），擁有者交辦單給的是 5 輪均值（整輪 55.0 秒、找缺口段 38.5 秒、規則之後的整理約 13 秒）。兩者差在取樣輪次，結論不變。
2. **探針只有 1 個樣本。** 排名可信，絕對值要等累積 24 筆再看。`count(*)` 會修剪沒用到的欄位，單臂耗時是下限（`CLAUDE.md`「量效能先實測」已提醒）。
3. **找缺口段與探針總和的差**（約 11 到 13 秒）屬於總表後半 CTE 鏈（開窗、名單收斂、測試名人物過濾），但這三塊各佔多少沒有分開量；第 0 期逐段 `EXPLAIN` 後才能決定第 3 期的優先順序。
4. **raw 八個型別沒有分開量**，只有整體 1,430 ms。
5. **觸發器入列的實際成本與事件量**沒有在正式庫量過；本文的事件量只是用近 7 天新增量粗估。`edit_history` 與 `tracking_logs` 沒有 `created_at`，沒有納入。
6. **seed 以外的記憶體大戶**已查到函式名與呼叫來源，見下一節 6.8。
7. **帶陣列參數的 SQL 函式 generic plan 把陣列長度估成 10 筆**，按鍵版本的實際計畫要每支臂實測，結果可能要求部分臂改寫法。
8. **seed 外層的 `refresh_dispatch_blocked`（2.4 秒）可否事件化**，未查證。
9. `CLAUDE.md` 既有條目（2026-11-26）寫「總表是現況查詢……不適合用高水位增量化」。本計畫不是高水位增量化，而是「事件重算＋每日全量對帳」，直接處理了那一條擔心的「漏收回」；實作的 PR 要改寫該條目。**本 PR 只有文件，無需更新 `CLAUDE.md`。**

### 6.8 seed 以外的記憶體大戶

2026-11-26 唯讀查 `pg_stat_statements`（統計是自上次重置累計，近期重啟過，樣本小），依累計寫暫存檔量排序：

| 項目 | 次數 | 平均 | 累計暫存檔 | 每次 |
|---|---|---|---|---|
| **`contribution_queue_task_counts`（PostgREST，帶 `p_region`）** | 81 | 763 毫秒（最長 5.7 秒） | 約 2.9 GB | 約 36 MB |
| `seed_auto_task_queue()` | 8 | 51 秒 | 約 2.3 GB | 約 284 MB |
| 主控台隊列頁（計數三件組合查詢） | 1 | 3.5 秒 | 約 95 MB | 95 MB |
| `console_queue_state()`（PostgREST） | 3 | 609 毫秒 | 約 89 MB | 30 MB |
| 另兩支帶 `p_days` 參數的 PostgREST 呼叫 | 各 3 | 1.1 到 1.8 秒 | 各約 50 MB | 約 16 到 19 MB |
| `web_request_gap_sync()` | 9 | 5.6 秒 | 約 49 MB | 5 MB |

- **函式與呼叫來源**：`contribution_queue_task_counts` 由 `supabase/functions/next/index.ts` 在每次 `/next` 回應裡呼叫（取 `open_tasks`），日本站 `jp-next` 也有同款呼叫。`/next` 已有每個 isolate 60 秒的記憶體快取（`_shared/queue-counts-cache.ts`），但快取按 isolate 與 region 分開，Edge Function 實例多、地區值多時仍然會頻繁打到資料庫。81 次是統計累計，不是每分鐘。
- **為什麼值得注意**：單次約 36 MB 暫存檔、每次讀整個佇列（約 3 萬列）。它的暫存檔累計量**比 seed 還大**，但單次比 seed 小得多；若遇到 `/next` 並發高峰，多個實例同時打會與 seed 疊加。
- **建議另案處置（不在本計畫內）**：①把計數改成佇列常駐小表，由 seed 或缺口增刪時維護（與本計畫的常駐缺口表相容，缺口開關時順手更新計數）；②或伺服器端共用快取（資料庫一張單列快取表，每 10 分鐘 seed 結尾更新），`/next` 讀快取表；③確認 `p_region` 值的種類數，種類少就預先算好。處置前先用 `EXPLAIN (ANALYZE, BUFFERS)` 找出哪一段寫暫存檔。
- 其餘幾項單次都不到 100 MB，主控台隊列頁類屬於人工查看，不處理。

---

## 附錄 A：工程細節

### A.1 事件來源與受影響缺口鍵

> `pol`＝人物 id、`pe`＝參選紀錄 id、`policy`＝政見 id、`unit`＝（選舉，縣市，鄉鎮，職位）。受影響臂欄只列主要者。

| 來源表 | 觸發條件（只在這些欄位或情況入列） | 受影響單位鍵 | 受影響臂 |
|---|---|---|---|
| policies | INSERT；DELETE；UPDATE 時 title、description、category、status、proposed_date、last_updated、progress、election_id、politician_id、removed_at、lineage_id 任一欄有變 | policy、pol（`politician_id`）、（縣市，議題）、格（block_key） | legacy、mismatch、policy_validity、policy_election_missing、progress_stale、deadline_due、policy_elements、policy_dup、policy_missing、mayor_policies、term_policies、issue_too_broad、lineage_* |
| politician_elections | INSERT／DELETE；UPDATE 時 candidacy_status、cand_no、region_id、election_type、election_id、party_basis、source_note、withdrawn_after_filing 有變 | pe、pol、unit | profile_gap、candidacy_source_missing、candidate_status_stale、not_running、withdrawn_filing、term_policies、mismatch、ballot_numbers、名單族 |
| politicians | UPDATE 時 name、birth_year、current_position、avatar_url、party_id、merged_into、possible_duplicate_of 有變；INSERT | pol、同名組 | profile_gap、dup、placeholder_politicians、party_info、legacy |
| contributions | INSERT；UPDATE OF status（到或離開 pending／verified／apply_failed／applied） | 依 `payload` 與 `task_id` 反推 pol／policy／unit／lineage | 凡是臂函式內有「在途交件排除」的臂 |
| source_refs | INSERT／DELETE（`target_table` 為 policies、politician_careers 時） | policy、pol | policy_validity、legacy、career_sources |
| jev_decisions | INSERT 且 `subject_type='policy'` 且題目＝屆別 | policy | mismatch |
| edit_history | INSERT 且 `table_name='policies'` 且 field 為 audit 或 `*` | policy | legacy |
| tracking_logs | INSERT／DELETE | policy | progress_stale、deadline_due |
| policy_elements | INSERT／UPDATE／DELETE | policy | policy_elements、deadline_due |
| task_checks | INSERT | 依 `work_key` 反推 | 有「查無冷卻」判斷的臂（多半只影響佇列冷卻，不影響缺口存在，視臂而定） |
| election_districts、cec_registrations、cec_candidates、cec_roster_2026、roster_checks | 批次寫入完成時（語句層級，一次入列該單位） | unit | 名單族 |
| contribution_tasks | 已有觸發器直接入佇列 | — | manual_* |
| elections、election_milestones、activity_rules、activity_overrides、election_task_config、traffic_watch_levels、lineage_settings | 任何變動 | 整臂（`scope_key='*'`） | 依規則的 arm 欄 |

### A.2 表與觸發器草圖

```sql
CREATE TABLE dispatch_gaps (
  arm            TEXT        NOT NULL,
  gap_key        TEXT        NOT NULL,                -- 就是 task_id
  scope_key      TEXT        NOT NULL,                -- 重算單位
  payload        JSONB       NOT NULL,                -- task_type、target、what_we_need、hint_sources、reward、region
  eid            INTEGER,
  etype          TEXT,
  person_ids     UUID[]      NOT NULL DEFAULT '{}',
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  closed_reason  TEXT,
  source_version BIGINT      NOT NULL DEFAULT 1,
  recomputed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (arm, gap_key)
);
CREATE INDEX dispatch_gaps_open_scope_idx ON dispatch_gaps (arm, scope_key) WHERE closed_at IS NULL;
CREATE INDEX dispatch_gaps_people_idx     ON dispatch_gaps USING gin (person_ids) WHERE closed_at IS NULL;

CREATE TABLE dispatch_gap_dirty (
  arm         TEXT        NOT NULL,
  scope_key   TEXT        NOT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts    INTEGER     NOT NULL DEFAULT 0,
  last_error  TEXT,
  PRIMARY KEY (arm, scope_key)
);

CREATE TABLE dispatch_gap_arms (
  arm          TEXT PRIMARY KEY,
  mode         TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','shadow','live')),
  recompute_fn TEXT NOT NULL,    -- 例：contribution_auto_tasks_legacy(text[])
  full_fn      TEXT NOT NULL,    -- 例：contribution_auto_tasks_legacy()
  cadence      TEXT NOT NULL DEFAULT 'event' CHECK (cadence IN ('event','event+daily','hourly','daily'))
);

-- 入列：同鍵自動合併
CREATE FUNCTION gap_enqueue(p_arm TEXT, p_scope TEXT) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO dispatch_gap_dirty (arm, scope_key) VALUES (p_arm, p_scope) ON CONFLICT DO NOTHING
$$;

-- 觸發器：只入列、不重算（以 policies 為例，列級＋欄位比對）
CREATE FUNCTION trg_gap_policies() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r policies;
BEGIN
  IF NOT gap_events_enabled() THEN RETURN NULL; END IF;
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP = 'UPDATE' AND (OLD.title, OLD.category, OLD.status, OLD.last_updated, OLD.election_id,
                           OLD.politician_id, OLD.removed_at, OLD.lineage_id)
                          IS NOT DISTINCT FROM
                          (NEW.title, NEW.category, NEW.status, NEW.last_updated, NEW.election_id,
                           NEW.politician_id, NEW.removed_at, NEW.lineage_id) THEN
    RETURN NULL;
  END IF;
  PERFORM gap_enqueue('legacy',   'policy:' || r.id);
  PERFORM gap_enqueue('mismatch', 'policy:' || r.id);
  PERFORM gap_enqueue('policy_missing', 'pol:' || r.politician_id);   -- raw 型別與 mayor_policies 同單位
  RETURN NULL;
END $$;
```

### A.3 按鍵重算與消化

```sql
-- 臂函式：同一份定義，多一個鍵參數（NULL＝整表，給對帳與 shadow 用）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_legacy(p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET work_mem = '16MB' AS $$
  WITH cand AS MATERIALIZED (
    SELECT p.* FROM policies p
     WHERE p.removed_at IS NULL
       AND (p_keys IS NULL OR 'policy:' || p.id = ANY (p_keys))      -- 鍵條件推到最底層
       AND … 其餘條件與現行定義逐字相同 …
  ) SELECT … FROM cand …
$$;

-- 消化（簡化）
CREATE FUNCTION gap_drain(p_limit INTEGER DEFAULT 500) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE a RECORD; v_keys TEXT[]; v_done INTEGER := 0;
BEGIN
  FOR a IN
    SELECT d.arm, array_agg(d.scope_key) AS keys
      FROM (SELECT arm, scope_key FROM dispatch_gap_dirty ORDER BY enqueued_at
             LIMIT p_limit FOR UPDATE SKIP LOCKED) d
     GROUP BY d.arm
  LOOP
    CREATE TEMP TABLE _gd ON COMMIT DROP AS
      SELECT * FROM gap_recompute(a.arm, a.keys);                  -- 內部以 recompute_fn 動態呼叫
    -- 1) 這些單位原本開著、現在沒有 → 關閉
    UPDATE dispatch_gaps g SET closed_at = now(), closed_reason = 'filled', source_version = source_version + 1
     WHERE g.arm = a.arm AND g.scope_key = ANY (a.keys) AND g.closed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM _gd n WHERE n.gap_key = g.gap_key);
    -- 2) 現在有 → 開或更新（內容沒變不寫，沿用 #465 的 IS DISTINCT FROM 慣例）
    INSERT INTO dispatch_gaps (arm, gap_key, scope_key, payload, eid, etype, person_ids)
      SELECT a.arm, n.gap_key, n.scope_key, n.payload, n.eid, n.etype, n.person_ids FROM _gd n
    ON CONFLICT (arm, gap_key) DO UPDATE
       SET payload = EXCLUDED.payload, scope_key = EXCLUDED.scope_key,
           closed_at = NULL, closed_reason = NULL, recomputed_at = now(),
           source_version = dispatch_gaps.source_version + 1
     WHERE (dispatch_gaps.payload, dispatch_gaps.closed_at) IS DISTINCT FROM (EXCLUDED.payload, NULL::timestamptz);
    DELETE FROM dispatch_gap_dirty WHERE arm = a.arm AND scope_key = ANY (a.keys);
    DROP TABLE _gd;
    v_done := v_done + cardinality(a.keys);
  END LOOP;
  RETURN v_done;
END $$;
```

### A.4 對帳與雙軌比對

```sql
-- 以現有整表函式為準，與常駐表 diff；p_apply=true 時補漏
CREATE FUNCTION gap_reconcile(p_arm TEXT, p_apply BOOLEAN) RETURNS TABLE (only_new INT, only_old INT, changed INT)
LANGUAGE plpgsql AS $$ … $$;
-- 內容：
--   WITH full AS (SELECT … FROM <full_fn>()), cur AS (SELECT … FROM dispatch_gaps WHERE arm = p_arm AND closed_at IS NULL)
--   only_new = full EXCEPT cur；only_old = cur EXCEPT full；changed = 兩邊都有但 payload 不同
--   差異寫 gap_reconcile_log；p_apply 時：only_new 開、only_old 以 'reconcile' 關、changed 更新
```

總表分支與讀取函式（模式切換）：

```sql
-- 讀取函式：回傳與臂函式同形的欄位，讓總表分支可直接 UNION
CREATE FUNCTION dispatch_gaps_open(p_arm TEXT)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT g.gap_key, p.task_type, p.target, p.what_we_need, p.hint_sources, p.reward, p.region
    FROM dispatch_gaps g CROSS JOIN LATERAL jsonb_populate_record(NULL::gap_payload, g.payload) p
   WHERE g.arm = p_arm AND g.closed_at IS NULL
$$;
```

### A.5 排程

| 工作 | 排程 | 備註 |
|---|---|---|
| `gap_drain()` | `3-58/5 * * * *`（3、8、13…，不落整十分鐘） | seed 開頭另呼叫一次；`_shared/cron-shift-off-seed.test.ts` 的 C7 要能解析區間語法，否則改列舉分鐘 |
| `gap_reconcile_all()` | 每日台北約 05:00（UTC 21 點，分鐘由主線配號） | 約 25 秒 |
| `gap_shadow_compare()` | 每小時一次（分鐘由主線配號，避開 :35 探針） | 只跑 `mode='shadow'` 的臂；可併入現有探針排程 |
| `gap_midnight_sweep()` | 台北 00:05 | 只算 `cadence='event+daily'` 且當天有日期翻轉的臂 |
| 巡檢保留清理 | 併入 `dispatch_records_purge` 同類排程 | 已關閉缺口保留 7 天；`gap_reconcile_log` 保留 30 天 |

### A.6 測試策略

沿用既有 PGlite 守門慣例（`_shared/*.test.ts`；`arms-pglite.ts` 是總表的 PGlite 環境，臂函式以 stub 回放表資料）：

1. **文字層守門**（每期各一檔，仿 `seed-arm-timings.test.ts`）：新增表與索引欄位、RLS、權限；總表二段式分支齊全且與 `off` 模式輸出等價；seed 本體只多了 `gap_drain()` 呼叫與標記的行；`SET work_mem`／`SET statement_timeout` 還在；新排程不落整十分鐘；每支臂都登記在 `dispatch_gap_arms`；臂函式讀的表都有對應觸發器（掃 SQL 比對）。
2. **行為層（PGlite）**：①`xxx_for(keys)` 與 `xxx()` 的**同源等價**：任一鍵集合 K，`_for(K)` 等於整表結果中 `scope_key ∈ K` 的子集（用屬性測試造資料）；②`gap_drain()` 的開、更新、關、換號四種情況；③觸發器只在影響欄位變動時入列；④同鍵合併與風暴降級；⑤`gap_reconcile` 能抓到人工製造的漏開、漏關、漏更新。
3. **正式庫快照比對**：仿 `scripts/arms-parity-*.ts`，唯讀把臂的新舊定義在正式庫各跑一次逐列比對（不進 CI）；每期上線前必跑。
4. **窗口與日期**：用假時鐘 `SET app.activity_today` 驗證日期翻轉由每日掃補上。

### A.7 與 #1044／#1046／#1048 的關係

| PR | 關係 |
|---|---|
| #1044（已合併） | 收窄 legacy 與 mismatch 前的候選集、加索引，結論是「不做增量化」。本計畫改變該結論，但**收窄後的臂函式仍是整表算的成本下限**，也就是每日對帳與雙軌比對的成本，所以 #1044 的成果仍然有用 |
| #1046（已合併） | `seed_arm_timings` 與探針是本計畫的量測基礎：每期的節省都用 `stage:arms_all` 與逐臂探針驗證；本計畫沿用其表記錄 `gap:<臂>` 事件量 |
| #1048（草稿，已暫停） | 「最貴的臂改每小時快取」被擁有者否決。其量證（暫存檔來自臂之後）是第 6.7 節第 1 點的依據。建議本計畫實作開始時關閉該草稿 PR |
