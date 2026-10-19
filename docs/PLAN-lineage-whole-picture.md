# 正見「脈絡＝一件事的全貌」計畫書（#675）

> **狀態（2026-10-19）**：計畫，agy 同儕審查已過、主線已依審查修訂一輪（修訂處見 PR 內文），待維護者。**不含任何程式或 migration**；各期由主線配 migration 時間戳與協議版號後才動工。
> **前提**：以 #670 PR 2（分支 `lineage-elected-only`、協議 1.99.0、migration `20261019020000`）合併後為準——脈絡只收「那一屆已投票且當選」的政見、`lineage_candidate_scope` 只收資格內、apply-precheck 擋不合格、新派工臂 `lineage_ineligible`。**本計畫不重做它**；撰寫時（main 在 `c5a7568`，只含 #670 PR 1）那支分支還沒有提交，下列用到它的地方都標「待 PR 2 合併後核對」。
> 數字都是 2026-10-19 唯讀查正式庫的結果（方法與可重跑的查詢見附錄 A）；凡是「PR 2 之後的範圍」，我用同一個定義自己算（已投票且 `candidacy_status='elected'`），PR 2 合併後要用它的函式重算一次。

一句話結論：**一條脈絡＝一件事，不分層級、不分地方；頁面拆成「主頁（可收錄）」與「完整關係圖（只在瀏覽器端畫）」；資料上新增三張小表（立場、事件、現況）＋一張設定表，其餘只改欄位的意義，既有 10 條脈絡一筆資料都不動。** 工作分六期，每期單獨上線、只加不刪。

---

## 0. 維護者裁決（本計畫的前提，2026-10-19，#675）

| # | 裁決 | 寫進哪一節 |
|---|---|---|
| 1 | 「脈絡的用意是一件事的全貌」：一件事＝一條，所有層級（中央／縣市／鄉鎮）與所有地方（跨縣市）在同一條。**更正 10-06 #349「一件事在某一層級、某一地方」** | 第 1、2 節；實作時在 `docs/decisions/` 寫「更正」 |
| 2 | 兩頁：主頁（現況＋截至日與出處、這件事摘要、各方立場一覽、大事記、筆數；SSR、可收錄）＋完整關係圖 `/lineage/:id/graph`（泳道時間軸；手機直式；**只在瀏覽器端畫、noindex、不進 sitemap、canonical 指主頁**） | 第 5 節 |
| 3 | 主頁的現況與摘要只寫有出處的事實、不寫評價；立場交給立場表；「讓資料自己說話」：頁面不放解釋規則的文字 | 第 3、5 節 |
| 4 | 新交件：**立場**（人、支持／反對／有條件、日期、原文出處；可隨時間變）、**事件**（政府或議會的決定；日期、出處）、**現況**（一句＋截至日＋出處；太久沒更新派任務） | 第 2、3、4 節 |
| 5 | 上下級連結改義為「大計畫包含哪些項目」（目前 0 筆）；`level`／`region` 改義為「主辦」；涵蓋地方由政見自動算 | 第 2 節 |
| 6 | 分組任務：第一次找＝同縣市同分類跨層級（縣長、縣議員、鄉鎮市長、該縣市選出的立委同一格）；往外擴＝用脈絡標題的專有名詞全國找其他地方／層級的政見 | 第 4 節 |
| 7 | 撤回：「跨縣市同級合作連結」、「鄉長政見一律進鄉鎮那條」 | 第 10 節（不做的事） |
| 8 | 交接照職位：同一條脈絡裡每個職位一條交接線並排 | 第 2.6、5.2 節 |

---

## 1. 現況與要改的落差

### 1.1 落差表

| 面向 | 現況（#349 第一階段＋#670 PR 1） | 目標（#675） | 要改什麼 |
|---|---|---|---|
| 一條脈絡的範圍 | 一件事在**某一層級、某一地方**（`level`＋`region`＋`sub_region`）；唯一索引 `lineages_same_title_same_place`、CHECK `lineages_place` 都綁著地方 | 一件事一條，跨層級跨縣市 | 欄位**不改名、不動資料**，只換意義（主辦）；新增「涵蓋地方」由政見推導（2.6） |
| 分組任務 | 格＝層級＋縣市＋鄉鎮＋類別；區域立委的政見同時放中央格與縣市格 | 格＝縣市＋類別，跨層級；立委只放自己縣市那格 | 新格函式與臂（4.2）。同一範圍實測：舊法 350 格（252 格可派、最大 53 條）→ 新法 316 格（236 格可派、最大 44 條） |
| 找別地方的同一件事 | 沒有；只能靠格內判斷 | 專有名詞全國找 | 新臂 `lineage_expand`（4.3） |
| 上下級連結 | `top_down`／`bottom_up`＋層級檢查觸發器；0 筆；2 件 `lineage_link_candidate` 任務在隊 | 「大計畫包含哪些項目」 | `lineage_links` 改義、新增 `contains`、換觸發器（2.3）；臂先停用、第五期重寫 |
| 立場 | **沒有**。`lineage_participants` 只記提案、連署等行為（官方紀錄或本人宣稱） | 人＋立場＋日期＋原文＋出處，可隨時間變 | 新表 `lineage_stances`、新交件 `lineage_stance`（2.4、3） |
| 事件 | **沒有** | 政府或議會的決定 | 新表 `lineage_events`、新交件 `lineage_event` |
| 現況 | **沒有**；`summary` 200 字、沒有截至日、沒有出處欄 | 一句＋狀態＋截至日＋出處，過期派任務 | 新表 `lineage_statuses`、新交件 `lineage_status` |
| 交接 | 資料已照「人＋那一屆」記，頁面排成一條時間軸 | 每個職位一條交接線並排 | 資料不改；關係圖按職位排泳道（5.2） |
| 頁面 | 一頁 `LineagePage.vue`（時間軸、參與者、上下級），Worker 邊緣渲染、進網站地圖 | 主頁＋關係圖兩頁 | 主頁改版、新增關係圖路由（5） |
| 收錄 | 脈絡頁 canonical 指正見.tw、進 `sitemap-policies.xml` | 關係圖不收錄 | 路由不進 `SSR_ROUTES`、不進 `collectRoutePaths`、canonical 指主頁（5.3） |
| 日本站 | `policy_jp` 有同構的 4 張表與 4 支臂，**0 條政見、0 條脈絡、0 件任務** | 結構跟上、不急 | 第六期（6） |

### 1.2 實測基線（2026-10-19，唯讀）

| 項目 | 數字 |
|---|---|
| 既有脈絡 | 10 條（縣市 7、中央 3）、共 23 條政見；交接 0、參與者 0、關聯 0；`summary` 全有值；`lineages_full` 全表 JSON 4.9 KB |
| 既有脈絡的合格政見（PR 2 之後） | 藍線 2／2、屏南 1／2、永康 3／4、金門電網 2／2，其餘 6 條（嘉義敬老卡、雲林敬老卡、澎湖望安、北宜高鐵、台東午餐、新北大巨蛋）**0／N（全是 2026 候選人的政見）**——合格共 8 條 |
| 全站活躍政見 | 4,480 條；PR 2 範圍（已投票且當選、六種職位）2,188 條：縣市議員 1,747、立委 287、縣市長 109、鄉鎮市長 32、總統副總統 13，其餘職位另有村里長 48、鄉鎮市民代表 10（不在脈絡範圍） |
| 現在隊裡的脈絡任務 | `lineage_candidate` 279 件（舊範圍，含 2026 候選人）、`lineage_roles_missing` 8 件、`lineage_link_candidate` 2 件；已記的格清查結論 `lineage_candidate_reviews` 66 筆（鍵是舊格） |
| 脈絡交件歷史 | `lineage` 通過 10 筆、被退 3 筆；其他三種脈絡交件 0 筆 |
| 日本站 | `policy_jp.policies` 0、`lineages` 0、人物 46、脈絡任務 0 |

---

## 2. 資料結構

### 2.1 總覽（每張表／欄位改什麼）

| 物件 | 動作 | 內容 | 期 |
|---|---|---|---|
| `lineages` | 加欄、換意義 | 加 `search_terms TEXT[]`（往外擴用的專有名詞，2.2）；`level`／`region`／`sub_region`／`admin_code` 改義為**主辦**；索引與 CHECK 不動 | 一 |
| `lineage_links` | 改義＋加值 | `link_type` 加 `contains`（先加、不刪舊值，2.3）；換層級檢查觸發器；欄位名不改 | 一 |
| `lineage_stances`（新） | 新表 | 人、立場、條件、日期、原文、出處（2.4） | 一 |
| `lineage_events`（新） | 新表 | 事件型態、日期、決定機關、描述、出處 | 一 |
| `lineage_statuses`（新） | 新表 | 現況一句、階段、截至日、出處；一條脈絡一個截至日一列，留歷史 | 一 |
| `lineage_settings`（新） | 單列設定表 | 過期天數、往外擴的各個上限（2.7）；改值＝一行 migration 的 `UPDATE`，進 `edit_history` | 一 |
| `source_refs` | 擴 `target_table` | 加 `lineages`、`lineage_stances`、`lineage_events`、`lineage_statuses`（2.5） | 一 |
| `contributions` | 擴型別 CHECK | 每種型別跟著它自己的那一期加（3.1），**不在第一期先加**——只加 CHECK 不加協議，代理交得進來卻沒人處理 | 二 |
| 視圖 `lineages_full` | 尾端加欄 | `coverage`、`search_terms`、`sources`、`stances`、`events`、`status`（最新一筆）、`status_count`（2.6） | 一 |
| 視圖 `lineages_list`（新） | 輕量清單 | 一覽頁與全站快照用，不帶子表 JSON（2.6） | 一 |
| 視圖 `lineage_terms`（新） | 任期泳道原料 | 關係圖用：涉及的人與同職位前後任的任期（2.6） | 一 |
| 函式 `lineage_policy_place()`、`lineage_coverage()`、`lineage_term_df()`、`lineage_norm()` | 新 | 政見的地方（單一真相）、涵蓋地方、專有名詞出現數、文字正規化（2.6） | 一 |
| 觸發器 `lineage_touch_parent` | 新（六張子表共用：參與者、交接、關聯、立場、事件、現況） | 子表新增／修改／刪除時蓋 `lineages.updated_at`（2.6 的發現） | 一 |
| 函式 `merge_politician()`（現行定義在 `20261007020000`） | 改本體（簽名不變，不用分兩次上） | 同名人物合併時，一起搬 `lineage_stances` 與 `lineage_events.initiator_politician_id`（2.9）；回傳的 jsonb 多 `moved_stances`、`moved_events` | 一 |
| 函式 `contribution_auto_tasks_placeholder_politicians()` 的「空殼」那一段 | 改本體 | 「名下什麼都沒有」的判斷要把立場與事件推動者也算進去（2.9） | 一 |
| `policies`、`politicians`、`handovers`、`lineage_participants` | **不動** | `handovers` 已照人與屆別記，職位由 `from_office_id`／`to_office_id` 與視圖推導 | — |

### 2.2 `lineages`

| 項目 | 決定 | 理由 |
|---|---|---|
| 欄位名 | **不改名**（`level`／`region`／`sub_region`／`admin_code`） | 改欄位名要分兩次上線（CLAUDE.md），而且 10 條資料的值本來就是「這件事實際在哪一級政府決定與執行」（協議 `lineage` 段從第一版起就這樣要求代理填），語意已經是主辦；只改 `COMMENT`、協議與畫面用詞 |
| CHECK `lineages_place` | **不動** | 主辦仍是「單一層級＋單一地方」，三種組合（中央無地方、縣市要 5 碼、鄉鎮要 8 碼）照舊成立 |
| 唯一索引 `lineages_same_title_same_place`（層級＋行政區代碼＋標題） | **不動**，但把 `COMMENT` 改成「同一個主辦、同標題不會有兩條」 | 它現在擋的是「同一主辦被建兩次」，一條脈絡跨地方之後這個意思仍成立；它**擋不到**「不同主辦、同一件事」的重複，那個要靠派工（4.2 的 `existing_lineages` 帶涵蓋該縣市的脈絡、4.3 的 `other_lineages` 提示）與驗證，不是索引的事 |
| 沒有單一主辦（例：中彰投合辦） | 填**牽頭或核定的那一級**；實在找不到填中央 | 不為少數情況新增「多主辦」結構；寫進協議的 `lineage` 段 |
| `search_terms TEXT[] NOT NULL DEFAULT '{}'` | 新 | **資料庫的 CHECK 允許空陣列**：`cardinality(search_terms) BETWEEN 0 AND 5`，且每個詞 2～12 字、**必須是標題的子字串**（維護者：「用脈絡標題的專有名詞」），由 `lineage_terms_in_title(title, search_terms)`（IMMUTABLE；空陣列回 true）判斷。這樣 `DEFAULT '{}'` 與既有 10 條不會被擋；改標題時 CHECK 會要求同步改詞。「至少一個詞」是**交件與派工那一端**的要求（新建脈絡建議帶、往外擴的選詞步驟會補），不是資料庫約束；空陣列＝沒有專有名詞，不參與往外擴 |
| 摘要 `summary` | 欄位不動（200 字以內純文字）；**出處走 `source_refs`（目標表 `lineages`）** | 見 2.5；逐句註腳不做，見第 9 節裁決 1 |
| 空脈絡（合格政見 0 條） | 保留不刪；頁面標 `noindex`、不進網站地圖、一覽不列；派工的 `existing_lineages` 仍列出並標「目前 0 條政見」 | 既有 6 條會因 PR 2 變成 0 條（1.2）。2026-11-28 之後 2026 當選者的政見進場時要能接回原脈絡，不要被重建成重複的一條 |

### 2.3 `lineage_links`（大計畫包含哪些項目）

| 項目 | 決定 |
|---|---|
| 意思 | `upper_lineage_id`＝**大計畫**、`lower_lineage_id`＝**項目**；一條項目可屬於多個大計畫（有向、不成環）。欄位名不改（兩次上線規則），前端型別另取別名 `parentId`／`childId` |
| `link_type` | CHECK 改成 `IN ('top_down','bottom_up','contains')`——**先加不刪**（0 筆資料，但舊程式與在途交件仍可能帶舊值）；新交件只收 `contains`。舊兩個值在確認 0 筆、無在途 `lineage_link` 交件後，由後續一支 migration 刪掉（兩次上線） |
| 觸發器 `lineage_links_check_levels`（現在：上級必須是中央、或同縣市的縣市） | 新增 `lineage_links_check_contains` 取代它，三條：①**層級與地方**（下一列，agy 審查指出「只看層級高低」會讓新北市的大計畫包含花蓮縣的鄉鎮項目通過，所以**地方一定要比**）；②**不成環**（遞迴檢查大計畫不是項目的後代）；③`contains` 以外的舊值保留舊檢查直到刪除 |
| 　層級與地方的規則 | 大計畫的主辦 → 項目的主辦可以是：**中央** → 中央、任何縣市、任何鄉鎮；**縣市** → 同一個縣市（`region` 相同）的縣市項目、**同縣市（`region` 相同）的鄉鎮項目**；**鄉鎮** → 同一個鄉鎮（`region` 與 `sub_region` 都相同）的鄉鎮項目。項目的層級高於大計畫、或縣市不同，一律擋（`RAISE EXCEPTION`，回應講明哪一條不合）。例：「台南捷運網」（台南市）包含「藍線一期」（台南市）成立；新北市的大計畫包含花蓮縣吉安鄉的項目不成立；縣市大計畫包含中央項目不成立 |
| 派工臂 `lineage_links` | 第一期：停用規則（`activity_rules` 該列 `enabled=false`，2 件在隊任務被收回；理由是舊說明句「上級立法或補助」與新意思衝突）。第五期：重寫候選＝同類別、大計畫主辦層級不低於項目（同層同地）、**且大計畫的涵蓋地方包含項目的主辦地方**，一條項目一件、同一份候選清單查過不再派 |
| 畫面 | 主頁寫「屬於」（`direction='upper'`）與「包含」（`direction='lower'`）；`LINK_LABEL` 改成「包含」一個詞 |

### 2.4 新表：立場、事件、現況——統一 `lineage_items` 還是分表？

| 比較項 | 統一一張 `lineage_items`（`kind` 區分） | 分表（`lineage_stances`／`lineage_events`／`lineage_statuses`） |
|---|---|---|
| 欄位 | 共用欄位少，三種各有 3～5 個專用欄，約一半欄位是空的 | 每張欄位全是自己的，`NOT NULL` 與 CHECK 直接寫 |
| 約束 | 每種要一組 `CHECK ((kind='stance') = (politician_id IS NOT NULL))`，唯一鍵要三條部分索引，容易寫漏 | 唯一鍵一條各自一張：立場（脈絡＋人＋日期）、事件（脈絡＋型態＋日期＋機關）、現況（脈絡＋截至日） |
| 外鍵 | 人物外鍵只對一種有意義 | 立場有人物外鍵、事件有選填的推動者外鍵、現況沒有 |
| 出處 | `source_refs.target_table` 只加一個名字 | 加三個名字，但**觸發器函式是同一組**（同步與清理出處的 `lineage_rows_sync_source`、`lineage_rows_drop_refs` 用 `TG_TABLE_NAME`，蓋時間的 `lineage_touch_updated_at` 本來就通用，現有三張子表已這樣共用）——多一張表的成本只有 `CREATE TRIGGER` 幾行 |
| 讀取 | `WHERE kind=…` | 視圖各取各的 JSON 欄 |
| 派工臂與守門 | 臂各自查 `kind`，測試要先過濾 | 臂各查各的表，測試對表斷言 |
| 查核履歷還原 | `executeRevert` 用 `.eq("id", record_id)` 刪列，兩種做法都行 | 同左 |
| 日後再加一種（例：預算案） | 加一個 `kind`，最省 | 加一張表，多一點樣板 |

**推薦：分表。** 理由：立場與事件的約束和外鍵不同、唯一鍵也不同，合併後會用大量 `kind` 條件把它們再拆開；三張子表共用同一組觸發器，多張表的成本接近零；日後再加一種的成本不是這期要買的保險。

**`lineage_stances`**

| 欄位 | 型別與約束 | 說明 |
|---|---|---|
| `id` | UUID PK | 查核履歷的紀錄鍵 |
| `lineage_id` | UUID NOT NULL → `lineages` ON DELETE CASCADE | |
| `politician_id` | UUID NOT NULL → `politicians` | 只收**站上已有的人物**（與參與者同規則）；合併後讀取端用 `merged_into` 對到保留者 |
| `stance` | TEXT NOT NULL CHECK IN (`support`,`oppose`,`conditional`) | 支持／反對／有條件 |
| `condition_text` | TEXT CHECK 6～200 字 | 有條件時必填、其他必空（CHECK `(stance='conditional') = (condition_text IS NOT NULL)`） |
| `stated_on` | DATE NOT NULL | 表態當天；只知道年或月就填該期間第一天並標精度（不用 `CURRENT_DATE` 做 CHECK，晚於今天由交件守門擋） |
| `date_precision` | TEXT NOT NULL DEFAULT `day` CHECK IN (`day`,`month`,`year`) | 老的質詢紀錄常只確定年份（示意圖就是「2019」） |
| `quote` | TEXT NOT NULL CHECK 8～300 字 | **原文摘句**，驗證者要在出處找得到一字不差 |
| `source_url`／`source_locator` | NOT NULL；locator 1～200 字 | 同現有三張子表（網址格式 CHECK、位置＝議事紀錄日期與案由、報導段落等） |
| `note` | 選填 1～200 字 | **子表的備註**，對應交件裡「每一項」的 `note`；跟交件外層那個 `note`（交件說明，20～300 字、存在 `contributions.note`）是兩個不同的欄位，協議兩處分開寫、分開命名（外層叫「交件說明」、項目內叫「備註」），避免代理把 201～300 字的說明填進備註而撞 CHECK |
| `contribution_id`、`created_at`、`updated_at` | 同現有三張子表 | |
| 唯一鍵 | `UNIQUE (lineage_id, politician_id, stated_on)` | 同一人同一天一筆；重交＝覆蓋，查核履歷記每欄舊值。「現行立場」＝同一人最新一筆，立場變過看全部列 |

**`lineage_events`**

| 欄位 | 型別與約束 | 說明 |
|---|---|---|
| `id`、`lineage_id` | 同上 | |
| `event_type` | CHECK IN 十值 | `decided` 拍板／`approved` 核定／`budget_added` 編列預算／`budget_cut` 預算刪減／`started` 動工或開辦／`completed` 完工或上路／`paused` 暫緩／`cancelled` 喊卡或終止／`resumed` 重啟／`other` 其他（`other` 的描述要寫清楚是什麼決定） |
| `occurred_on`、`date_precision` | 同立場 | 決定當天（不是報導日） |
| `level`／`region`／`sub_region`／`admin_code` | 與 `lineages_place` **同一組 CHECK**（`lineage_events_place`） | 哪一級在哪個地方做的決定；篩選與關係圖的地方標籤用它。縣市與鄉鎮名稱沿用 `new_lineage` 的行政區解析（對不到當場退回 `target_not_found`） |
| `decided_by` | TEXT NOT NULL 2～40 字 | 機關名稱：縣議會、行政院、交通部、縣政府…（自由文字，不另建機關表） |
| `description` | TEXT NOT NULL 10～300 字 | 只寫發生了什麼，不寫評價 |
| `initiator_politician_id` | 選填 → `politicians` | 誰提案或爭取（關係圖畫「爭取 → 核定」的虛線箭頭用；不填就不畫箭頭）；`initiator_note` 選填 2～30 字（例：「縣府提案」「立委爭取」） |
| `source_url`／`source_locator`、`contribution_id`、時間欄 | 同上 | |
| 唯一鍵 | `UNIQUE (lineage_id, event_type, occurred_on, decided_by)` | **已知取捨**：同一天、同一機關、同一型態的兩項決定（例：議會同日兩筆預算刪減）會撞鍵，後交的覆蓋先交的。協議與任務說明明寫「同日同機關同型態的多項決定合併成一筆、`description` 分點寫」；覆蓋時查核履歷會記下舊值，不會無聲丟失。不把描述雜湊放進鍵，否則同一件事改幾個字重交就變成兩筆 |

**`lineage_statuses`**

| 欄位 | 型別與約束 | 說明 |
|---|---|---|
| `id`、`lineage_id` | 同上 | |
| `phase` | CHECK IN 七值 | `proposed` 提案階段／`planning` 規劃中／`approved` 已核定／`in_progress` 進行中／`completed` 已完成／`paused` 暫緩／`cancelled` 已終止（示意圖那顆標籤；沒有「未知」——沒資料就沒有列，畫面顯示「未調查」） |
| `text` | TEXT NOT NULL 8～120 字 | **一句**現況，只寫有出處的事實 |
| `as_of` | DATE NOT NULL | 截至日＝**出處講到這個狀態的那個日期**，不是查的日子（防止假新鮮）；晚於今天由交件守門擋 |
| `source_url`／`source_locator`、`contribution_id`、時間欄 | 同上 | |
| 唯一鍵 | `UNIQUE (lineage_id, as_of)` | 現行現況＝最大 `as_of` 那一列；歷史留著給查核履歷與日後的「現況變遷」 |
| **撤回與更正**（agy 審查補） | 交件可帶 `remove: true`（撤回某一列）或 `replace_as_of`（以新內容取代某一列），見 3.1 | 現況是單筆交件，不像立場、事件的陣列可以在同一筆裡「拿掉舊的＋加新的」。**不再用「截至日不得早於現有最新」擋交件**（3.2）：錯填的日期若靠這條擋，後面合法的現況永遠進不來；改成日期較舊的照樣收進歷史、不影響「現行」，同時提供撤回與取代，錯的那一列拿掉後視圖自動退回次新的一列 |

三張表共同：RLS 公開讀、`service_role` 寫（同現有）；`BEFORE UPDATE` 蓋 `updated_at`；`AFTER INSERT/UPDATE OF source_url` 同步 `source_refs`（寫不進出處表就讓落庫失敗）；`AFTER DELETE` 清 `source_refs`；`AFTER INSERT/UPDATE/DELETE` 蓋父脈絡的 `updated_at`（2.6）。

### 2.5 出處（`sources`／`source_refs`）

| 對象 | `target_table` | 角色 | 備註 |
|---|---|---|---|
| 立場、事件、現況（每列一個主要出處） | `lineage_stances`／`lineage_events`／`lineage_statuses` | `primary`（交件的 `source_url`） | 觸發器同步，做法同 `handovers` |
| 脈絡本身（摘要的依據） | `lineages` | `primary`＝建立或更正摘要時的第一個 `source_urls`，`supporting`＝其餘 | **#670 PR 1 的說明明講這步沒做**（`lineages_full` 沒有出處欄、`source_refs` 不收 `lineages`）。若 PR 2 已做就沿用它的做法；沒做就在第一期補（先 `git fetch` 看 PR 2 的 migration 再定） |
| 現行 `target_table` 清單 | `policies`、`tracking_logs`、`policy_elements`、`lineage_participants`、`handovers`、`lineage_links`、`politician_careers`、`parties`、`politician_elections`、`regional_stats`（`20261009240000`） | | CHECK 要**整個重寫**（DROP＋ADD），兩個並行 PR 一起改會撞——合併前以 main 最新那一版為準 |
| 視圖取法 | `source_brief(表名, id)`（現有函式，取 `primary` 那一筆：網址、標題、發布者、等級、存檔） | | `lineages_full` 的 `sources` 欄對 `lineages` 取全部（有序），其餘各帶自己的 `source` |

### 2.6 讀取：視圖、函式、觸發器

| 物件 | 內容 |
|---|---|
| `lineage_policy_place(policy_id)` | **一條政見放在哪**（單一真相，格與涵蓋共用）：職位＋縣市＋鄉鎮＋層級。規則同現行 `lineage_candidate_scope`（縣市與鄉鎮只來自那一屆參選紀錄自己、「臺」換「台」、`全國` 不算縣市），但**一條政見只回一列**——立委不再同時出現在中央與縣市兩列。「哪些政見合格」一律呼叫 PR 2 的共用資格函式（待合併後核對名稱），這裡不另寫第二份判斷 |
| `lineages_full` 新增欄（接在 `links` 後面，`CREATE OR REPLACE` 可行；重建後重下 `ALTER VIEW … SET (security_invoker = on)` 與 `GRANT`） | `coverage`（涵蓋地方：`[{level, region, sub_region, policy_count}]`，由 `lineage_policy_place` 對這條的政見分組；**只看政見**，主辦另顯示）；`search_terms`；`sources`；`stances`（每筆帶 `politician_id`〔合併後指保留者〕、`name`、`stance`、`condition`、`stated_on`、`date_precision`、`quote`、`source`）；`events`（同理，帶 `initiator`）；`status`（最新一筆物件或空）；`status_count` |
| `lineages_list`（新） | 一覽頁與 SSG 全站快照用：`id`、標題、摘要、類別、主辦、`updated_at`、各種筆數（政見／人物／交接／事件／立場）、`coverage`、現況的 `phase` 與 `as_of`。**不帶子表 JSON**。原因：`lineages_full` 今天 10 條只有 4.9 KB，但一條成熟的脈絡預估 20 KB（30 筆立場＋15 筆事件），300 條就 6 MB，會塞進 `/analysis` 的 `__INITIAL_STATE__`。先量、超過 500 KB 才切換（前端遇到 `lineages_list` 不存在時退回 `lineages_full`，沿用 `isMissingRelation`） |
| `lineage_terms`（新） | 關係圖的任期原料：對一條脈絡涉及的人（政見持有人、立場持有人、參與者、交接雙方、事件推動者）各取任期表 `politician_offices` 的列（`election_type`、地區、`start_date`、實際或預定 `end_date`），**再補上單席首長職位（縣市長、鄉鎮市長、區長）在脈絡期間的所有前後任**，這樣泳道才連得起來；多席職位（議員、立委）只列涉及的人 |
| `lineage_coverage(lineage_id)`、`lineage_term_df(term, 排除的脈絡, 排除的政見)`、`lineage_norm(text)` | 涵蓋地方；專有名詞在合格政見標題或說明裡出現幾條（**不含**該脈絡自己已有的政見，建立時也扣掉這筆要歸入的，4.3）；正規化（轉小寫、全形轉半形、「臺」換「台」、去空白）。實測涵蓋計算 10 條脈絡 1.1 毫秒（`EXPLAIN ANALYZE`，23 條政見），不是瓶頸 |
| 觸發器 `lineage_touch_parent` | **發現**：`lib/sitemap.ts` 的註解說脈絡頁 `lastmod` 取 `lineages.updated_at`「連參與者、交接、關聯的變動都蓋」，但現行觸發器只蓋**各自那張表**的 `updated_at`，歸入政見（`policies.lineage_id`）也不蓋——實際上子表變動不會讓 `lastmod` 動。新觸發器對六張子表（參與者、交接、關聯、立場、事件、現況）在 `INSERT/UPDATE/DELETE` 後蓋父脈絡；歸入政見另在落庫函式裡蓋一次（這也順手補上既有三張子表的缺口，是第一期會改變現有行為的兩處之一〔另一處是停用 `lineage_links` 臂〕：`lastmod` 會跟著動，方向是正確的） |
| 職位的交接線 | **不新增欄位**。視圖在每筆交接的 JSON 補 `office_type`、`office_region`、`office_sub_region`（由 `from_election_id`＋人物的參選紀錄推導，與 `handover_office_of()` 同一個來源），關係圖照它歸到對應職位的泳道 |

### 2.7 設定表 `lineage_settings`（單列，參數都有預設值、函式裡不寫死數字）

| 欄位 | 預設 | 用途 |
|---|---|---|
| `status_stale_days_active` | 90 | 階段是 `approved`／`in_progress` 的現況，截至日超過幾天就派 |
| `status_stale_days_idle` | 180 | 階段是 `proposed`／`planning`／`paused` |
| `event_recheck_days` | 180 | 有事件的脈絡，最近一筆事件（或最近現況）超過幾天再派事件缺口 |
| `gap_not_found_days` | 60 | 立場、事件、現況三支缺口臂：同一條脈絡的同型任務回報 `not_found` 之後，多久內不再派（臂本體自己查 `task_checks`，見 3.4）。比一般任務的 14 天長，因為這三種「查不到」多半是真的還沒有公開資料 |
| `expand_term_df_cap` | 12 | 專有名詞在合格政見裡出現超過幾條就算太泛（實測見 4.3） |
| `expand_candidates_max` | 30 | 一件往外擴任務最多列幾條候選政見 |
| `expand_stop_terms` | 空陣列 | 緊急時加的停用詞（不是常態維護的詞表） |
| `expand_recheck_days` | 30 | 一條脈絡往外擴看過後，多久才會因「又有新候選」再派 |
| `cell_max_policies` | 60 | 一格超過就依屆別拆（今天最大 44，沒有格超過；是防呆） |
| `open_cap_per_arm` | 空（不設） | 各臂同時開著的上限；初值空＝與今天一致（今天 279 件在隊沒有上限）；要限流改這一格 |
| `enabled` | true | 整組新臂的總開關 |

改值走 migration 的 `UPDATE … SET … , note = '…'`，每次修改由既有觸發器 `activity_audit` 寫進 `edit_history`（同 `traffic_boost_settings`）。

### 2.8 既有 10 條怎麼遷移（只改欄位意義、不動資料者優先）

| 動作 | 做法 | 是否寫資料 |
|---|---|---|
| `level`／`region`／`sub_region`／`admin_code` | **不動**（本來就是「在哪一級決定與執行」） | 否 |
| `search_terms` | 新欄預設空陣列；補值走流程：第五期 `lineage_expand` 對沒有專有名詞的脈絡先派「選詞」一步（`target.step='terms'`，附系統算的 `suggested_terms`，代理用 `lineage` 更正交回） | 否（不寫 migration 補資料；符合「資料走流程」） |
| 立場／事件／現況 | 全部 0 筆，由新臂派任務補 | 否 |
| 6 條合格政見 0 條的脈絡 | 由 PR 2 的拿掉任務處理；本計畫保留脈絡、頁面隱藏（2.2）；不派立場／事件／現況任務（臂只對「有合格政見」的脈絡派） | 否 |
| 舊格的清查結論（`lineage_candidate_reviews` 66 筆 `block:` 鍵） | 新格的鍵空間不同（4.2），舊鍵自然對不上；**不刪**，留著當歷史。代價：新格第一次全部重派（格內容本來就變了，重看是對的） | 否 |
| 在隊的 279 件舊 `lineage_candidate` | 新臂上線後舊 `task_id` 不再由臂產生，seed 依既有規則收回；在途的舊交件照樣可以落庫（落庫只看 payload） | 否 |
| 舊的 `link_type` 兩個值 | 0 筆，保留到第五期確認後刪 | 否 |

### 2.9 人物合併與移除的連動（agy 審查補；第一期一起做）

新表有人物外鍵，**人物合併與「空殼人物」清理本來就會碰脈絡的表**（現況：`merge_politician` 已搬 `lineage_participants` 與 `handovers`，空殼那一段也把這兩張表算進「名下還有東西」）。不處理的話，同名合併後立場掛在被合併的那位身上（視圖雖然用 `merged_into` 顯示保留者，但外鍵留著孤兒），空殼清理還可能把有立場的人當成空殼移除。

| 物件 | 改什麼 | 守門 |
|---|---|---|
| `merge_politician()`（以 main 最新定義為底，現行在 `20261007020000`） | ①`lineage_stances`：同一條脈絡、同一天已有保留者的一列 → 併進來的那列**整列記進 `edit_history` 再刪**；其餘改 `politician_id`（舊→新各記一列履歷）。②`lineage_events.initiator_politician_id`：直接改（沒有唯一鍵衝突）。③回傳多 `moved_stances`、`moved_events` | PGlite 實跑：搬動、撞鍵（同脈絡同日）、履歷、整筆還原；還原驗證＝拿掉搬 `lineage_stances` 的那段 → 測試紅 |
| `contribution_auto_tasks_placeholder_politicians()` 的 `orphan` 那一段（以 main 最新定義為底） | 「名下什麼都沒有」的 `NOT EXISTS` 再加 `lineage_stances`、`lineage_events.initiator_politician_id` | 測試：名下只剩一筆立場的人不被當空殼；拿掉新條件 → 紅 |
| 人物 `removal`（整個人移除） | 比照 `lineage_participants` 現況（外鍵不加 `CASCADE`），實作時對照 `removal` 落庫確認它對這兩張表的行為與參與者一致，不另開例外 | 同上對照測試 |

---

## 3. 交件型別與協議

### 3.1 型別一覽（協議版號 `1.(N+1).0` 起；N＝配號當天 main 的版號，今天是 1.98.0、PR 2 取 1.99.0）

**四處清點**（CLAUDE.md「加新的貢獻型別」）：DB CHECK `contributions_contribution_type_check`（現行最新在 `20261009240000`，要整個重寫）、TS 清單（`CONTRIBUTION_TYPES`、`TASK_TYPES`、`SUGGESTED_TYPE`）、協議（`public/skill-types.md` 加帶 `<!-- spec … -->` 的段落後跑 `scripts/gen-type-spec.ts`）、`lib/task-labels.ts`。**這次還要加**：`system_one_vote_budget_candidates()` 的型別清單（最新在 `20261009240100`）與 `vote-budget.ts` 的風險維度（`vote-budget.test` 規定每個型別都要有）、`system-one.ts` 的 precheck 欄位表、`_shared/task-types.ts`（任務→交件型別）、`verification-sources.ts` 的 `TASK_SOURCE_NEEDS`（沒登記的任務型別會拿到預設那組人物資料來源，是錯的）、`task-guidance.ts`、`task-context.ts`（`item.current`）、`contribution-summary.ts`、`history.ts`（表名與欄位的中文標籤）、`summary-lookup.ts`、`same-claims.ts` 的 `APPLY_IDEMPOTENT_TYPES`、`consensus.ts`。

| 型別 | 欄位（✅＝必填） | 落庫 | 任務 |
|---|---|---|---|
| `lineage`（既有，改） | 新增 `new_lineage.search_terms`（選填，1～5 個、2～12 字、須為標題子字串、通過出現數檢查）；更正時可改 `search_terms`，以及**主辦**（`level`／`region`／`sub_region`，與 `new_lineage` 同規則）；`policy_ids` 歸入的政見可以是別的地方、別的層級（不再限同一格）；協議的定義段改寫成「一件事一條」 | 同現有，多寫 `search_terms`、`source_refs`（`lineages`） | `lineage_candidate`（改格）、`lineage_expand`（新）；歸入既有脈絡時 `lineage_id` 必填 |
| `lineage_stance`（新） | `lineage_id`✅、`stances`✅（1～10 項，每項 `politician_id`✅、`stance`✅、`condition`（有條件必填）、`stated_on`✅、`date_precision`、`quote`✅、`source_locator`✅、`source_url`、**`second_source_url`（這一項的出處不是官方時必填，且要是不同網站，3.2）**、`note`（項目備註，1～200 字）、`remove`）；外層 `note`✅＝交件說明（20～300 字：這個人指的是哪件事、為什麼是同一件事） | 以（脈絡＋人＋日期）覆蓋；`remove:true` 拿掉標錯的列（要改日期＝同一筆裡一項 `remove` 舊的、一項加新的） | `lineage_stance_missing` |
| `lineage_event`（新） | `lineage_id`✅、`events`✅（1～10 項，每項 `event_type`✅、`occurred_on`✅、`date_precision`、`level`✅、`region`／`sub_region`（依層級）、`decided_by`✅、`description`✅、`initiator_politician_id`、`initiator_note`、`source_locator`✅、`source_url`、**`second_source_url`（同立場）**、`remove`）；外層 `note`✅ | 以（脈絡＋型態＋日期＋機關）覆蓋；要改日期同立場的做法 | `lineage_event_missing` |
| `lineage_status`（新） | `lineage_id`✅、`phase`✅、`text`✅（8～120 字）、`as_of`✅、`source_locator`✅、`source_url`；單筆。**更正與撤回**：`replace_as_of`（選填，舊的那一列的截至日＝刪那一列、寫這一筆新的）；`remove: true`（只撤回 `as_of` 那一列，其餘內容欄不必填，外層 `note`✅ 寫為什麼是錯的） | 以（脈絡＋截至日）覆蓋；新截至日＝新增一列；撤回與取代都把被動的整列記進查核履歷（可還原） | `lineage_status_stale` |
| `lineage_link`（既有，改義） | `upper_lineage_id`（大計畫）✅、`lower_lineage_id`（項目）✅、`link_type='contains'`✅、`note`✅、`source_locator`✅ | 同現有，換觸發器檢查 | `lineage_link_candidate`（第五期重寫） |
| `lineage_handover`、`lineage_participants` | **不動** | | `handover_missing`（4.5 小改）、`lineage_roles_missing` |

陣列型（立場、事件）一筆最多 10 項：第一次填一條脈絡常常一次有好幾位表態、好幾個決定；上限比參與者的 50 低，因為每一項都要驗證者開原文逐項核，**一項錯整筆被退**，批次越大越容易被退。

### 3.2 交件守門（`apply-precheck`，交件當下擋、不算被拒）

| 守門 | 立場 | 事件 | 現況 | 錯誤碼（沿用現有的為準；新碼為暫名，實作時定） |
|---|---|---|---|---|
| 脈絡存在、人物存在且未合併 | ✓ | ✓（推動者） | ✓ | `target_not_found` |
| 日期不晚於今天 | `stated_on` | `occurred_on` | `as_of` | `date_in_future` |
| 現況的撤回與取代：`remove`／`replace_as_of` 指到的那一列要存在 | — | — | ✓ | `target_not_found` |
| 現況的 `as_of` 比現有最新的舊：**不擋**，照樣收進歷史、不影響「現行」；回應帶 `older_than_current` 提醒（不算被拒）。原本計畫「不得早於最新」會讓一筆填錯的較晚日期永遠擋住後面合法的現況（agy 審查），改成提醒加上撤回機制 | — | — | 提醒 | 提醒碼暫名 `older_than_current` |
| 條件、原文、描述的長度與必填 | `condition`、`quote` | `description` | `text` | `invalid_payload` |
| 出處不可是讀不到的社群（臉書、IG、Threads）；不可引用正見本身（1d） | ✓ | ✓ | ✓ | 同現有 |
| **媒體不能當唯一出處**（1a）：加進 `SOLE_SOURCE_GUARDED_TYPES`，且**陣列型要逐項檢查**——現行 `soleSourceProblem` 只數外層 `source_urls` 的網站數，一筆交 10 項時，項目 A 只引媒體 1、項目 B 只引媒體 2，外層看起來有 2 個網站就放行，每一項其實都只有單一媒體（agy 審查指出，我核對 `sole-source-guard.ts` 屬實）。新規則：**每一項**的 `source_url` 是官方就過；不是官方就要有 `second_source_url`、而且與前者不同網站（`siteOf` 比），沒有就擋。現況是單筆，外層檢查就夠。錯誤訊息的中文稱謂補「立場」「事件」「現況」（`soleSourceProblem` 現在寫死 政見／交接／政見進度，沒補會把新型別誤稱「政見進度」），`SOLE_SOURCE_TASK_NOTE` 與 `task-guidance.ts` 裡那句型別清單一起改 | ✓（逐項） | ✓（逐項） | ✓（外層） | `single_non_official_source` |
| 專有名詞檢查（`lineage` 的 `search_terms`，可為空陣列）：每個詞須為標題子字串、2～12 字、不是地名、出現數在上限內 | — | — | — | `term_too_generic`（回應帶每個詞的出現數）、`term_not_in_title` |
| 事件的地方解析 | — | 縣市／鄉鎮對行政區 | — | `target_not_found` |
| 一條政見只屬於一條脈絡 | `lineage` 歸入時照現有 | | | `apply_would_fail` |
| **PR 2 的資格檢查**（歸入的政見要是那一屆已投票且當選） | `lineage` 沿用，不重做 | | | 待 PR 2 合併後核對 |

> 事實與評價：沿用 PR 2 對摘要做的「逐句核來源、只寫事實」檢查（待核對它的實作），套到現況句與事件描述；如果 PR 2 只寫在驗證規則裡、沒有程式檢查，本計畫不另造評價詞表（詞表一定漏、也一定誤傷），只靠驗證規則（3.3）。

### 3.3 驗證規則（驗證者怎麼判；寫進 `skill-types.md`「驗證政策脈絡時」那段與各型別的 `type_spec`）

| 型別 | 驗證者要確認 | 投 `disagree` 的情形 |
|---|---|---|
| `lineage_stance` | ①打開出處，`quote` **一字不差**找得到；②說這句話的**就是這個人**（不是幕僚、黨團或政黨聲明）；③講的是**這件事**（同一個標的，不是同名的另一件，例：另一條「藍線」）；④`stance` 與原文相符，有條件的 `condition` 照原文；⑤日期是表態那天，不是報導日（只知道報導日就標精度） | 原文沒有這句話、發言人不對、標的不同、立場方向反了、把「討論」當成「支持」 |
| `lineage_event` | ①出處寫的是**已經做成的決定**（不是提案、規劃、受訪表示）；②日期與機關對；③`event_type` 對（核定不是拍板、預算刪減要寫明哪筆預算）；④描述只有事實 | 只是提案、日期錯、機關錯、型態錯、描述帶評價 |
| `lineage_status` | ①`text` 每個字都能在出處找到；②`as_of` 是出處講到那個狀態的日期；③`phase` 與句子一致；④沒有被**更晚**的事件推翻（先看事件列） | 句子超出原文、日期是查詢日、階段與句子矛盾 |
| `lineage`（新增的往外擴與專有名詞） | 每個 `search_terms` 是這件事的專有名詞（計畫名、路線名、法案名），不是通稱；歸入的別地政見**確實是同一件事**：note 要寫出共同的專有名詞與地點，**同名不同標的（不同縣市的「藍線」）一律不歸入** | 只因為用詞相似就歸入 |

現況的**撤回／取代**：驗證者要確認被指的那一列真的錯（日期對不上出處、句子超出原文），並看外層 `note` 有沒有講清楚為什麼；取代時新內容照 `lineage_status` 那一列驗。立場與事件的 `remove` 項同理。

沿用既有：打不開投 `unsure`；只有確認網頁不存在或與 payload 矛盾才投 `disagree` 並附反證；同一份交件第 1 張 `unsure` 0 分、第 2 張起每張 −1（1.95.0）；系統不給這三種型別系統票、不核第二來源（同現有四種脈絡型別）。

### 3.4 計分

| 項目 | 決定 | 理由與查證 |
|---|---|---|
| 目標分數與退件門檻 | **沿用 normal：目標 3、退件 −3**；`contribution_required_agree` 走 `ELSE` | 與現有四種脈絡型別一致；不改計分，所以不需要為計分通知日本站 |
| 系統票 | 不給（`system_vote_eligible` 不收） | 同現有脈絡型別 |
| `lineage_event` 的 `cancelled`（喊卡／終止） | **比照交接 `stop` 套 `contribution_needs_two_ips`，但 payload 是陣列，不能照 `stop` 讀純量**（agy 審查指出；`stop` 讀的是 `p_payload->>'handover_type'`，交接是單筆）。①**SQL**：`contribution_needs_two_ips` 加一段 `OR (p_type = 'lineage_event' AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload->'events') = 'array' THEN p_payload->'events' ELSE '[]'::jsonb END) e WHERE jsonb_typeof(e) = 'object' AND COALESCE(e->>'event_type', '') = 'cancelled'))`，寫法照 `20261018030000` 的 `changes[]` 那段；**必須以 main 最新那一版的整個函式為底重寫**（它已經有 merge／candidacy／removal／reassign／`stop`／退選更正等分支，漏抄一支就把那支的兩台機器規則悄悄拿掉）。②**TS**：`consensus.ts` 的 `needsTwoIps` 對 `lineage_event` 讀 `payload.events`（非陣列當空）、用 `.some()` 找 `event_type === 'cancelled'`（常數另放 `EVENT_TWO_IP_TYPES = ['cancelled']`，仿 `HANDOVER_TWO_IP_TYPES`）。③**混合 payload**：一筆裡只要有一項 `cancelled`（含 `remove` 那項），整筆都要兩台機器。④`lineage.test.ts` 逐案比對 SQL 與 TS，**案例必須包含陣列 payload**（純量讀法在陣列 payload 上永遠是空，守門會靜默失效） | 錯的「終止」等於公開說政府把這件事停了，跟 `stop` 同級 |
| **發現：兩台機器規則對這些型別實際沒有額外效力** | 單票最高 +2（`contribution_vote_weight`：同意 +1、附的第二來源經系統核過 +2），沒有系統票，目標 3 → **本來就至少要兩個不同來源網段的票**；`stop` 的規則（20261006034900）因此是「明文化」不是「加強」 | 唯讀讀程式與函式得到；真要讓終止更難上線得提高目標分數（改 `contribution_required_agree`、TS 表、skill.md 門檻表、通知日本站），這是改計分，見第 9 節裁決 2 |
| 立場 `oppose` 要不要加高 | 不加 | 原文逐字與兩站規則已經是主要防線；上線兩週看被退比例再議 |
| 冷卻 | **不碰** `task_cooldown_settings.task_types` 與 `apply-contribution.ts` 的 `PROGRESS_COOLDOWN_TASK_TYPES`（agy 審查指出，我核對屬實）：那份清單專屬村里長進度追蹤（#470），`village-progress-cooling.test.ts`（A9）會把常數與 `20261009010000` 的初值逐項比對，加了就紅；而且那條回給代理的句子寫死「已記錄『查無公開進度』」，對立場、事件說不通。**冷卻走 `lineage_settings.gap_not_found_days`**：三支缺口臂的本體各加一個 `NOT EXISTS`，查 `task_checks` 裡 `task_id` 以 `auto:<任務型別>:<脈絡 id>:` 開頭（**不比指紋**，指紋換號也要擋住）、`outcome='not_found'`、`checked_at` 在 `gap_not_found_days` 內的紀錄。一般任務的 14 天冷卻（`task_check_cooldown_days()`，`refresh_dispatch_blocked` 對所有 `auto:` 任務都套）照舊先生效，這個天數只會把它拉長。回給代理的句子走現有的「查過、無異動」那句，不新增文案分支；上線前量這個 `LIKE` 查詢的成本（`task_checks` 有沒有可用索引） | 避免「查不到」的任務一直回來，又不動村里長的守門 |

### 3.5 協議文件改動（`public/skill-types.md` 與 `skill.md`）

| 位置 | 改動 |
|---|---|
| `skill-types.md` 約 288 行「**政策脈絡**」總說明 | 改寫定義：一條脈絡＝一件事的全貌，所有層級與地方在同一條；主辦；涵蓋由政見算；脈絡裡記**六個面向**（政見、前後任、同級多人、立場、事件、現況）與大計畫包含項目；刪「一件事在某一層級、某一地方」；任務清單加入新四種 |
| `lineage` 段 | `search_terms`、主辦更正、歸入跨地方政見的規則、同名不同標的不歸入、專有名詞的挑法 |
| 新 `lineage_stance`／`lineage_event`／`lineage_status` 三段 | 各帶 `<!-- spec contribution: … -->` 與一個 JSON 範例 |
| `lineage_link` 段 | 改成大計畫包含項目；層級說明改成第 2.3 節 |
| 「驗證政策脈絡時」段 | 加 3.3 的三列 |
| 任務 `current` 說明（約 413 行起） | 新任務的 `current` 帶什麼（4.1） |
| `skill.md` §2 第 1a 條、計分表 | 第 1a 條的型別清單加三種；計分表 `lineage_handover` 那列旁加 `lineage_event`（`cancelled`）；版號只改檔頭那一行與 `PROTOCOL_VERSION` |
| `public/llms.txt` 約 22 行 | 「一件事在某一層級、某一地方的來龍去脈」改成新定義 |

---

## 4. 派工臂

### 4.1 臂一覽

新增一支臂要**三處一起加**（CLAUDE.md）：總表 `contribution_auto_tasks_arms()` 加 `UNION ALL SELECT '臂名' AS arm …`（現行定義在 `20261011120000_traffic_watch_arms.sql`，**以 main 最新一支為底**）、`activity_arm_names()` 加名字、`activity_rules` 種一條規則；漏哪一處守門測試 `activity-arms.test.ts` 會紅。這些臂的 `target` 沒有選舉，規則一律「永遠開」（同現有四支，見 `20261011030000` 的說明），優先層用預設（中段，不另設規則）。

| 臂 | 任務型別 | 交件型別 | 狀態 | 一句話條件 |
|---|---|---|---|---|
| `lineage_candidates` | `lineage_candidate` | `lineage`／`no_change` | 改（第五期） | 縣市×類別的格跨層級，≥2 個人或屆別且有未歸入者 |
| `lineage_expand`（新） | `lineage_expand` | `lineage`／`no_change` | 新（第五期） | 脈絡有專有名詞，別地方／層級有合格政見出現它 |
| `lineage_stances`（新） | `lineage_stance_missing` | `lineage_stance`／`no_change` | 新（第二期） | 有合格政見的脈絡，決策職位的人還沒有立場紀錄 |
| `lineage_events`（新） | `lineage_event_missing` | `lineage_event`／`no_change` | 新（第二期） | 沒有任何事件，或進行中卻太久沒新事件 |
| `lineage_status`（新） | `lineage_status_stale` | `lineage_status`／`no_change` | 新（第二期） | 沒有現況，或現況截至日過期 |
| `lineage_links` | `lineage_link_candidate` | `lineage_link`／`no_change` | 第一期停用、第五期重寫 | 見 2.3 |
| `handover_missing` | `handover_missing` | `lineage_handover`／`no_change` | 小改（第五期） | 見 4.5 |
| `lineage_roles` | `lineage_roles_missing` | `lineage_participants`／`no_change` | 不動 | |

**三支缺口臂與往外擴一律只對「有合格政見的脈絡」派**（空脈絡不派，2.2）。上線當天預估新增：有合格政見的 4 條脈絡 × 3 支缺口臂＝12 件；往外擴 ≤ 4 件；格任務約 236 件（取代現在在隊的 279 件）。

### 4.2 分組任務跨層級：怎麼分格、幾格、最大多大

**格的定義**：`(縣市, 類別)`；縣市取自 `lineage_policy_place()`（政見持有人那一屆參選紀錄的縣市）。縣市長、縣市議員、鄉鎮市長與區長、區域立委都歸到**自己的縣市**那一格；總統副總統與沒有縣市的（`全國`）歸一個「全國」格（今天只有總統副總統 13 條）。範圍函式 `lineage_cell_scope()`＝PR 2 的資格函式＋`lineage_policy_place()`，一條政見一列；格鍵＝`lineage_cell_key(縣市或空, 類別)`（雜湊前 12 碼，同 `lineage_block_key` 的做法，鍵空間不同所以不會與舊鍵混）。舊的 `lineage_candidate_scope()`、`lineage_block_key()` 留著不刪（刪函式要分兩次上線，且日本站有複本），第五期之後沒有臂再呼叫它們。任務的指紋、`NOT EXISTS` 在途交件、`lineage_candidate_reviews` 清查都沿用現有寫法：`task_id` 仍是 `auto:lineage_candidate:<12 碼>:<8 碼>`，`parseCandidateTaskId`（`_shared/lineage.ts`）照舊解成 `block:<格鍵>`，**格鍵的雜湊輸入改以 `cell|` 開頭**，與舊格（`level|region|…`）不會相撞，所以解析函式與清查表都不用改。

**實測（2026-10-19，唯讀；範圍＝已投票且當選、六種職位；PR 2 合併後以它的函式重算）**

| | 舊法（層級＋縣市＋鄉鎮＋類別，立委放兩格） | 新法（縣市＋類別，跨層級） |
|---|---|---|
| 格數 | 350 | **316** |
| 可派的格（≥2 個人或屆別、有未歸入） | 252 | **236** |
| 每格政見數：中位數／第 90 百分位／最大 | 4／—／53 | 4／18.5／**44** |
| 超過 30 條的格／超過 60 條的格 | —／— | 6／**0** |
| 一格裡含 ≥2 種職位的格／≥3 種 | — | **161**／57 |
| 最大的五格 | — | 新北市社會福利 44（立委＋議員）、桃園市交通建設 40（立委＋議員＋縣長）、台南市社會福利 39、新北市交通建設 35、苗栗縣社會福利 33 |

- 單一任務的 `target` 大小：舊法最大格 37 條約 10 KB；新法最大 44 條約 12 KB，另加 `existing_lineages`（最多 40 條，4 KB 內），都在可接受範圍。
- **防呆**：超過 `cell_max_policies`（60）的格依屆別拆成多格（鍵多帶屆別）。今天用不到，用合成資料測。
- `existing_lineages`：改為「主辦在這個縣市、**或涵蓋這個縣市**、或主辦是中央」的脈絡，同類別排前面，最多 40 條，每條帶 `policy_count`（0 條的標出來）。舊版只列同一層級同一地方，跨縣市建重複脈絡的主因就在這裡。
- 任務說明改寫：把「同一層級同一地方」換成「這一格含縣長、議員、鄉鎮市長與該縣市選出的立委；講的是同一件事就歸同一條，不論層級」；`level` 的填法改說「主辦＝主要在哪一級決定」。

### 4.3 往外擴：用脈絡標題的專有名詞全國找

**專有名詞怎麼來**（三種比較）

| 做法 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| (a) 系統自動從標題切：所有 2～12 字子字串，依出現數篩，取極大者 | 不用代理填、不用補資料 | 一個標題最多 600 多個子字串 × 2 千多條政見，300 條脈絡每輪 4 億次比對，要物化；結果有雜訊（實測會切出「金門與」「路地下化」） | 只拿來當**建議** |
| (b) 代理在建立或更正脈絡時填 `search_terms`，系統只驗 | 準、便宜、驗證者看得懂 | 既有 10 條沒有值 | **採用** |
| (c) 混合：(b) 為主，沒有值的脈絡由臂附 (a) 的 `suggested_terms` 請代理選 | 補資料也走流程 | 多一個任務步驟 | **採用**（補既有的 10 條） |

**實測（唯讀）：出現數上限 12 能分開專有名詞與通稱**

| 詞 | 在全部合格政見的標題或說明裡出現的條數（含該脈絡自己的政見） | 判定（上限 12） |
|---|---|---|
| 藍線 9、鐵路地下化 9、屏南 4、通電 2、大巨蛋 1 | 1～9 | 留（扣掉自己的政見後更少） |
| 捷運 75、午餐 40、敬老 26、高鐵 25、地下化 20 | 20～75 | **太泛，丟掉** |
| 宜蘭 31、金門 31（地名） | 31 | 丟掉；另外直接排除與行政區名稱相同的詞（出現多只因為是那個縣的政見） |

再用「標題的所有子字串、扣掉自己的政見後出現數 1～12、取最長」在 10 條既有標題上試切：永康鐵路地下化→「鐵路地下化」6 條；台南捷運藍線一期→「捷運藍線」6 條；金門與中國電網併接→「電網」3 條；屏南快速公路建設→「屏南快速」1 條；其餘 6 條標題切不出合格詞。合格詞帶來的候選政見合計不超過 16 條，不會灌爆。機器取「最長」時也會切出「金門與」「路地下化」這類雜訊，所以**挑詞交給代理、系統只驗證與給建議**（見上表 (b)(c)）。

**候選怎麼選、怎麼避免灌爆**

| 控制點 | 做法 |
|---|---|
| 詞的資格 | ①必須是標題子字串；②2～12 字；③不等於任何行政區名稱；④出現數（不含這條脈絡自己的政見）≤ `expand_term_df_cap`（12，臂每輪即時算，變泛了就自動丟並在 `target.dropped_terms` 告知）；⑤不維護手寫詞表，只留 `lineage_settings.expand_stop_terms`（預設空陣列）給緊急時加 |
| 候選 | 別的格的合格政見（標題或說明含至少一個合格詞、正規化後比對）、**尚未歸入任何脈絡**；已歸入**別條**脈絡的另列 `target.other_lineages`（最多 10 條，是「同一件事被建成兩條」的警訊），不放進候選 |
| 排序與上限 | 命中詞數多的先、標題命中先於說明命中、較新的屆別先；一件任務最多 `expand_candidates_max`（30）條 |
| 任務數 | **一條脈絡一件**；指紋＝候選政見 id＋合格詞的雜湊；查過（`no_change`＝`confirmed`，或歸入已落庫）記 `lineage_candidate_reviews` 鍵 `expand:<脈絡 id>`（`parseCandidateTaskId` 要加 `lineage_expand` 這一種；選詞步驟的鍵 `terms:<脈絡 id>`——代理回「這件事沒有專有名詞」＝`confirmed`，記下後不再派選詞，**避免空陣列的脈絡永遠被派選詞**），同一指紋不再派；之後只有「指紋變了且距上次超過 `expand_recheck_days`」才會再派 |
| 總量 | `open_cap_per_arm`；沒有合格詞或沒有候選的脈絡不派 |
| 效能 | 上線前實測臂本體（`EXPLAIN ANALYZE`、**把全部輸出欄加總**，不只 `count(*)`，CLAUDE.md）。**判準**：> 300 毫秒或脈絡 > 200 條時改成物化表 `lineage_expand_candidates`（`pg_cron` 每小時重算），臂只讀表；今天 10 條脈絡直接算 |
| 任務步驟 | `target.step='terms'`（脈絡沒有 `search_terms`）：只附 `suggested_terms`，請代理用 `lineage` 更正交回詞；`target.step='candidates'`：附候選清單與已合格的詞 |

任務說明沿用現有的判斷準則：同一個標的才是同一件事；**同名不同標的（不同縣市各有一條「藍線」）不是**。實測「捷運藍線」在別處出現 6 條，其中可能有別的縣市的另一條線（要驗證者逐條看）——這類任務回 `no_change` 是正常結果，驗證時照合格結果處理。

### 4.4 三支新臂的條件

| 臂 | 派的條件 | 不派／停派的條件 | `task_id`（指紋） | `target` 大致內容 |
|---|---|---|---|---|
| `lineage_stances`（立場缺口） | 脈絡有 ≥1 條合格政見；**應有立場的人**＝①主辦與涵蓋地方的**首長**（縣市長、鄉鎮市長、區長，任期與脈絡期間有重疊者，含前任）②政見持有人③參與者；扣掉已有立場紀錄的人，剩下的 ≥1 人 | 在途的 `lineage_stance` 交件；同一份人名單查過 `confirmed`；`not_found` 後 `gap_not_found_days` 內不派（3.4）；名單上限 30 人 | `auto:lineage_stance_missing:<脈絡 id>:<人名單雜湊 8 碼>` | 脈絡簡述、`people[]`（人、職位與任期、為什麼在名單上）、已有的立場 |
| `lineage_events`（事件缺口） | 有 ≥1 條合格政見，且 ①完全沒有事件，或 ②現況階段是 `planning`／`approved`／`in_progress`／`paused`、而最近一筆事件（沒有事件就看現況截至日）超過 `event_recheck_days` | 階段已是 `completed`／`cancelled` 且至少有一筆事件；在途交件；冷卻 | `auto:lineage_event_missing:<脈絡 id>:<原因 none 或 stale>` | 脈絡、已有事件、現況 |
| `lineage_status`（現況過期） | 有 ≥1 條合格政見，且 ①沒有現況，或 ②階段 `approved`／`in_progress` 截至日超過 `status_stale_days_active`、其他階段超過 `status_stale_days_idle`，或 ③有比現況截至日更晚的事件 | 階段 `completed`／`cancelled` 且有現況；在途交件；冷卻 | `auto:lineage_status_stale:<脈絡 id>:<目前截至日或 none>` | 現行現況、較新的事件、脈絡 |

「查不到」的回報：`no_change`＋`outcome=not_found`（進冷卻）；現況沒變但找得到**近期**文件證明仍如此，用 `lineage_status` 以新截至日交（有出處、有日期的才算，**沒有新消息不等於新截至日**）。

### 4.5 `lineage_links` 臂與 `handover_missing` 臂

| 臂 | 改動 |
|---|---|
| `lineage_links` | 見 2.3：第一期停用，第五期重寫候選與說明；舊說明句整個換掉 |
| `handover_missing`（交接照職位） | 現行已經照職位找後任（同職位、同縣市、鄉鎮另比鄉鎮、前任任期已屆滿、後任是同職位下一個當選者），所以「同一條脈絡裡每個職位一條交接線」資料面不用改。小改一處：**把「有立場紀錄的首長」也納入基礎名單**（現在只看有政見的首長），第五期先量增量再決定要不要。今天沒有任務（2022 屆首長 2026-12-24 才屆滿），2026-12-25 起才會出現 |

### 4.6 帶指紋的 `task_id` 與換號

- 格、往外擴、立場缺口的 `task_id` 帶指紋；清單一變，指紋就變、`task_id` 換號、在隊位置歸零（現行行為）。**#670 PR 4「換號沿用排隊位置」處理這件事**，本計畫只引用：PR 4 合併後，第五期（格、往外擴）與第二期的立場缺口臂要把各自的 `task_id` 家族登記進它的換號對照（具體介面待 PR 4 合併後核對；現在 `rekey-keeps-queue-position` 分支還沒有提交）。
- 在那之前把指紋做成低變動：立場缺口只用人名單雜湊（名單變才換）；現況與事件缺口用「截至日或原因」（有新交件落庫才換，而換號本來就是任務完成的意思）。
- 新臂不要自己造一套沿用位置的邏輯。

---

## 5. 頁面

### 5.1 主頁 `/lineage/:lineageId`（SSR、可收錄）

| 區塊（上到下） | 內容與資料來源 | 空值時 |
|---|---|---|
| 標題列 | 標題、**主辦**（層級＋地方）、**涵蓋**（`coverage` 的地名）、**屬於**（`links` 中 `direction='upper'`，真連結）、類別 | 沒有涵蓋或屬於就不印那一格 |
| 現況 | `status`：階段標籤＋一句＋「截至日」＋出處連結（有存檔附存檔） | 標籤「未調查」 |
| 這件事 | `summary`＋**出處列**（`sources`，編號、真連結）。**不寫評價**；逐句註腳見第 9 節裁決 1 | 沒有摘要就不印 |
| 各方立場 | 表：層級｜人｜立場｜何時｜出處。每人取**最新**一筆；立場變過的在該列標「曾變」（第四期起才連到關係圖，第三期只是文字標籤）；排序：中央→縣市→鄉鎮、再依地區、再依日期新到舊；「條件」寫在立場標籤後。**推導列**（第 9 節裁決 4）：政見持有人若沒有立場紀錄，補一列灰色標籤「提出政見」（日期＝提出日或屆別投票日、出處＝政見頁），**不算進「立場 N 筆」**；**只在畫面算、不寫任何資料表**，這個人之後有正式表態，就由正式那一列取代、不重複列（agy 審查補的兩點） | 標籤「未調查」 |
| 大事記 | 事件＋交接合併，新到舊，最近 4 筆，各附出處；第四期起底下有按鈕「看完整關係圖 →」（真連結，`rel="nofollow"`；**路由上線前整個按鈕不渲染**，避免連到不存在的頁） | 沒有就不印這一區（第四期起只留按鈕） |
| 筆數列 | 「政見 N 條｜交接 N 筆｜事件 N 筆｜立場 N 筆」，每一筆附出處（這句是標籤，不是說明） | 0 也印 |
| 脈絡裡的政見 | 現有的時間軸改成政見清單，依職位與屆別分組（保留：政見頁的內部連結是搜尋引擎找到政見頁的路） | |
| 參與者與角色 | 現有元件原樣（官方紀錄、本人宣稱分開） | |
| 大計畫與項目 | 「屬於」與「包含」兩組，真連結 | 沒有就不印 |

**「讓資料自己說話」的落實**：除了標籤與出處，主頁不放任何解釋規則、排序方式、方法論的句子；現有「還沒有交接紀錄」「還沒有參與者的紀錄」這類句子一併改成標籤式空值（交接區的出現條件是 #670 PR 1 做的，不動）。守門測試把主頁模板的靜態文字抽出來比對**白名單**，多一句說明就紅（第 7 節）。

**其他**：`<title>` 與 `description` 帶現況句（沒有現況就沿用）；JSON-LD 的 `dateModified` 讀 `updated_at`（2.6 的觸發器讓它真的會動）；`hasPart` 不變；不用「N 天前」這類相對時間文字（SSR 快取 10 分鐘、水合會對不上）；空脈絡標 noindex（現有 `noindex` 條件加「合格政見 0 條」）。

**載入器**：`loadLineagePage` 只多撈 `lineages_full` 新欄，`lineagePeople()`（`lib/ssg/page-data.ts`）把立場持有人與事件推動者加進人物清單；預渲染退路 `SSG_EDGE_PAGES=prerender` 與邊緣載入器同一份切片（現有做法）。

### 5.2 完整關係圖 `/lineage/:lineageId/graph`（只在瀏覽器端畫）

| 項目 | 設計 |
|---|---|
| 技術 | **Vue 直接畫 SVG**，不用 ApexCharts（那套要 `ClientOnly`、體積大，而且泳道時間軸不是它的圖型）。排版是**純函式** `lib/lineage-graph.ts`（零執行期依賴、可用 deno 測）：輸入脈絡、政見、人物、任期、選舉日、今天，輸出泳道、任期條、點、標籤、箭頭、座標；元件只負責畫。路由元件以 `() => import()` 分包 |
| 泳道＝職位 | 泳道鍵＝（職位、縣市、鄉鎮或選舉區）；排序：中央→縣市→鄉鎮、同層首長先於民意代表；單席職位（縣市長、鄉鎮市長、區長）一條泳道依序排任期條；多席職位（議員）同一條泳道內依人堆疊成列。預設最多 16 條泳道，其餘折成「另 N 個職位」可展開 |
| 任期條 | 資料來自視圖 `lineage_terms`（任期表）；現任實色、已卸任灰色、尚未開票的下一任**虛線框**（例：「11/28 開票後」，由選舉日推導）；條上寫人名 |
| 政見點 | 放在提出日（沒有就用屆別投票日）；顏色用既有進度色（推動中藍、已實現綠、滯後琥珀、跳票紅） |
| 立場標籤 | 在表態日、落在該人所屬泳道（用表態當天他的任期對泳道；對不到任期就落在「其他（身分待查）」最下一條）；支持綠、反對紅、有條件琥珀 |
| 交接標籤 | 在相鄰兩任之間，**每個職位一條交接線並排**；有交接紀錄的標型態，單席職位有後任而沒有紀錄的標「尚未記錄」。詞彙與顏色照示意圖（照舊做綠／改做法藍／縮小黃／停掉紅／重新開始紫），主頁與協議用的 `HANDOVER_LABEL`、`HANDOVER_BADGE` 同步改（前端一份、`_shared/lineage.ts` 一份，兩邊測試盯） |
| 事件 | 獨立一條「事件」泳道的菱形，旁邊寫短標；`initiator_politician_id` 有值就畫從那個人的泳道到事件的虛線箭頭，標 `initiator_note` |
| 其他 | 「今天」紅虛線；時間軸每兩年一格；參與者另起一行文字列在圖下方 |
| 互動 | 點任何點、標籤、事件、箭頭 → **側邊抽屜**（手機是底部抽屜）：原文摘句、出處連結（有存檔附存檔）、出處位置、日期、備註；抽屜按 Esc 與背景關閉 |
| 手機（≤ 640 px） | **直式時間軸，不畫 SVG**：新到舊、依年分組、每筆一行（圖示＋地方＋人＋內容）；頂端晶片篩選（全部／各地方）；點一筆開底部抽屜。與桌機吃同一份排版純函式的輸出（資料相同、版面不同） |
| 無障礙與文字版 | 圖下方（手機就是主體）放同樣內容的時序清單，給讀屏軟體；**不是給搜尋引擎**（這頁不收錄） |
| 資料載入 | 掛載後才撈（`onMounted`）：`lineages_full` 一列、該脈絡政見、涉及人物、`lineage_terms`；失敗用 `<LoadError>`，不顯示成「找不到」（CLAUDE.md） |
| 效能 | 一般 < 300 個 SVG 節點；超過 60 筆事件或立場時預設收合較舊的、可展開 |

### 5.3 路由、伺服器端渲染、預渲染、Worker、網站地圖、殼檔

| 層 | 做法 | 守門 |
|---|---|---|
| Vue router | `router/index.ts` 新增 `/lineage/:lineageId/graph`，`name: 'lineage-graph'`，排在 `lineage` 後面 | — |
| 邊緣載入器 | `loadPageData` 對 `lineage-graph` 回 `undefined`（預設分支，**不新增 case**）→ Worker 退回代理 | 測試：`loadPageData` 對這個路由名回 `undefined` |
| Worker `SSR_ROUTES` | **不改**。現有 `/^\/lineage\/[^/]+\/?$/` 不會比對到 `/graph`；它走代理到 `policy-tw.web.app` | 測試：這組正規表示式對 `/lineage/<id>/graph` 為 false；還原驗證＝把它放寬成 `^\/lineage\/` |
| Firebase | `firebase.json` 的 `/lineage/**` → `app.html` 已涵蓋 `/graph`（`**` 比對巢狀）；`app.html` 殼本來就帶 `noindex` | 測試（用 `scripts/firebase-rewrites.mjs`）：`/lineage/<id>/graph` 轉到 `/app.html` |
| `usePageHead` | 加選項 `canonical`（站內路徑）；關係圖頁用 `{ noindex: true, canonical: lineagePath(id) }`，`og:url` 同指主頁。**現在 canonical 只吃 `route.path`**，不加選項就會指自己 | 測試：這頁的 head 有 `robots noindex`、canonical 是主頁網址 |
| Worker 標頭（防禦，建議做） | `/lineage/<id>/graph` 代理回應補 `X-Robots-Tag: noindex` 與 `Link: <主頁>; rel="canonical"`——殼的 `noindex` 靠 HTML，標頭是第二道；**不要**在 `robots.txt` 擋（擋了爬蟲讀不到 noindex，反而可能只收網址） | `cloudflare/` 加測試 |
| 預渲染（vite-ssg） | `collectRoutePaths` 不加（沒有列的動態路由不會預渲染） | 測試：`collectRoutePaths` 的輸出不含 `/graph` |
| 網站地圖 | 不收。`scripts/postbuild-ssg.mjs` 現在對 `/lineage/` 開頭一律放進 `sitemap-policies.xml`，所以**加一道建置檢查**：任何網站地圖網址以 `/graph` 結尾就讓 build 紅，並把群組比對改成排除 `/graph` | 測試＋建置檢查；還原驗證＝把關係圖網址塞進 `edgePaths` 看它變紅 |
| 主頁的連結 | `<RouterLink :to="…/graph" rel="nofollow">`（真連結給人點；不鼓勵爬蟲順著找）。**與第四期的路由同一個 PR 才加**（第三期不得有，7 節） | 測試：第四期主頁有這個連結、`rel` 含 `nofollow`；第三期主頁沒有任何 `/graph` 連結 |
| `policy-tw.web.app` | 兩個頁面都回殼檔：主頁 200＋noindex（現況不變，只有正見.tw 做邊緣渲染）、關係圖同樣由瀏覽器畫；資料都是瀏覽器向 Supabase 撈，兩個網域行為一致 | — |
| 分享預覽 | 關係圖頁沒有伺服器端 `og:` 標籤（殼檔只有站名通用的），分享出去預覽是通用圖；接受（第 8 節風險） | — |

### 5.4 `/analysis` 一覽

改讀 `lineages_list`；卡片加現況階段標籤與「政見／事件／立場」筆數；篩選維持縣市、類別、關鍵字，「中央層級在每個縣市都列」改成「主辦是中央、或**涵蓋該縣市**的都列」。空脈絡不列。

---

## 6. 日本站同步範圍

| 項目 | 做法 | 時機 |
|---|---|---|
| 現況 | `policy_jp` 有同構的 `lineages`／`handovers`／`lineage_participants`／`lineage_links`、4 支臂、`lineage_*` 四種交件；**0 條政見、0 條脈絡、0 件任務**；層級是 `national`／`regional`／`local`，地方只用 `lg_code`，`id` 是文字，沒有 `contribution_id` 欄，查過的記錄走 `task_checks` | — |
| 本 repo 要做的（檔名帶 `_jp_`，主線審合；不碰 `public`、`ditrust`） | ①三張新表（立場、事件、現況）＋設定表＋`lineages` 的 `search_terms`；②交件型別三種（CHECK、`apply_types()`、`apply_lineage_*` 落庫函式、`_shared/jp/contribution-schema.ts` 的複本）；③`contribution_needs_two_ips` 的 `cancelled`；④臂：格改跨層級（草案，第六期再定：日本的格＝都道府縣範圍＋類別，國會議員只在國的格，沿用現有「不把國會議員放進地方格」的做法）、往外擴、三支缺口臂，規則種成永遠開＋`cap`；⑤`lineage_links` 改義 | 第六期，**在第一筆日本政見進站前完成即可**，不阻擋台灣各期 |
| 每期都要的小事 | 動到有日本複本的函式（`lineage_candidate_scope`、`lineage_block_key`、`contribution_needs_two_ips`、`contribution_auto_tasks_arms`…），在 `policy-jp-dispatch-drift.test.ts` 登記「日本版暫不跟」（`DEVIATED_*`）；第六期把這些登記清掉 | 每期 |
| 日本站的資格 | #670 要求「合併後通知日本站（`policy_jp.lineage_candidate_scope` 也收選前候選人）」；日本站的「只收已當選」另案，不在本計畫 | 主線通知 |
| 日本站前端（policy-jp repo） | 主頁與關係圖由日本站自己做，本計畫只提供資料與契約；開一件 issue 給 P-日本 | 第六期後 |
| 日文字串的專有名詞 | 出現數上限與最小字數要用日文資料重新量（漢字詞 2 字常見），先 `expand_term_df_cap` 維持 12，上線前實測 | 第六期 |

---

## 7. 分期與 PR 切法

**依賴**：一 → 二（三種交件**合成一個 PR**）∥ 三（主頁）→ 四（關係圖）；五在二之後（兩邊都改 `contribution_auto_tasks_arms()`，同時只派一件）、且在 #670 PR 4 之後較好；六在五之後。**每期合併後 Hosting 先綠、`db push` 再跑**（CLAUDE.md 的 CI 順序），所以前端 PR 對還沒套上的新欄位要容忍（`select('*')`，缺欄當空；缺的新視圖退回舊視圖）。migration 時間戳與協議版號由主線配（下表寫 `<配號>`、`1.(N+k).0` 佔位）。

| 期 | 內容 | migration／協議 | 為什麼可以單獨上線、不破壞現有資料與網址 |
|---|---|---|---|
| **一 定義與骨架** | 裁決檔（`docs/decisions/YYYY-MM-DD-<slug>.md`，**更正 10-06「政策脈絡第一階段」與「畫面」兩條**，再跑 `scripts/decisions-index.ts`）；一支 migration：三張新表＋`lineage_settings`＋`lineages.search_terms`＋`lineage_links` 加 `contains` 與新觸發器＋停用 `lineage_links` 臂＋`source_refs` 清單＋`lineage_touch_parent`＋`lineages_full` 尾端加欄＋`lineages_list`＋`lineage_terms`＋新函式＋**改 `merge_politician()` 與空殼人物那一段（2.9，不放到後面期：新表一建好就可能有人物外鍵，合併路徑要同時到位）**；`lineage` 交件的 `search_terms` 與主辦更正、`term` 檢查；TS 型別與 `mapLineage`（缺欄當空）；`skill-types.md` 的定義段改寫；`CLAUDE.md` 的脈絡描述由主線改 | `<配號 A>`；協議 `1.(N+1).0` | 只加表、欄、視圖尾端欄，沒有任何交件型別開放，頁面與任務照舊；舊 `link_type` 值保留 |
| **二 三種交件與缺口臂**（現況、事件、立場**一個 PR**，主線採 agy 建議：三者改的是同一批約 15 個共用檔案，拆三次要連升三次協議版、連過三次部署佇列，衝突風險比審查便利大；PR 內依現況→事件→立場分三個 commit，審查可以逐段看） | CHECK 加三個型別、`apply-contribution`／`apply-precheck`／`contribution-schema`／`consensus`／`system-one`／`vote-budget`／`task-*`／`verification-sources`／`summary`／`history`／`same-claims`／`task-labels`、`skill-types.md` 三個型別段與 `type_spec`、新臂三處（總表、臂名清單、規則；總表一次加三支）、三支臂的 `gap_not_found_days` 冷卻（**不動** `PROGRESS_COOLDOWN_TASK_TYPES`）、`needsTwoIps` 的 `cancelled`（陣列）、`SOLE_SOURCE_GUARDED_TYPES` 與逐項檢查 | `<配號 B>`；協議**只升一次**：`1.(N+2).0` | 三種型別各自完整（資料、守門、任務、協議）才開；資料先進庫，頁面還沒顯示也不影響 |
| **三 主頁** | 第 5.1、5.4 節：`LineagePage.vue` 重排、`lib/lineage.ts` 與 `types.ts` 補型別與純函式、`loadLineagePage`／`lineagePeople()`、一覽頁改讀 `lineages_list`、JSON-LD、空脈絡 `noindex`、`lineages_list` 缺時退回。**主頁在這一期完全不出現「看完整關係圖」按鈕、也不出現指向 `/graph` 的任何連結**（含立場表「曾變」那顆；這一期「曾變」只是文字標籤）——路由要到第四期才存在，先放連結讀者會點到不存在的頁（agy 審查，主線選「第四期才出現」，不併三四期，因為關係圖的排版純函式與元件是整份工作量最大的一塊，不該擋住主頁上線） | 無 migration；無協議 | 網址不變；新欄還沒資料時各區塊顯示標籤式空值；舊資料 10 條照樣顯示；沒有指向未上線頁面的連結 |
| **四 關係圖** | 第 5.2、5.3 節：路由、`lib/lineage-graph.ts`、元件與抽屜、`usePageHead` 的 `canonical` 選項、Worker 標頭、網站地圖的建置檢查、`HANDOVER_LABEL` 同步；**同一個 PR 才把主頁的「看完整關係圖 →」按鈕與「曾變」連結加上去**（路由與連結同時上線，不會有空窗） | 無 migration；若 `HANDOVER_LABEL` 的後端那份動到 `_shared/lineage.ts`，協議文字跟著小改（併在下一次版號） | 新路由，上線前沒有人連到它，不影響既有頁；不進網站地圖 |
| **五 派工臂改格與往外擴** | 4.2、4.3、4.5：`lineage_cell_scope`／`lineage_cell_key`、改寫 `lineage_candidates`、新 `lineage_expand`、重寫並重新啟用 `lineage_links`、`handover_missing` 小改、協議任務說明；實測臂成本；登記 #670 PR 4 的換號家族 | `<配號 C>`；協議 `1.(N+3).0` | 臂內容換、新舊 `task_id` 不重疊，seed 照規則收回舊的；已落庫與在途交件不受影響；格與往外擴都只產生「請代理判斷」的任務，不直接寫資料 |
| **六 日本站** | 第 6 節 | `<配號 D>`（`_jp_`）；日本協議版號另算 | 日本站 0 條政見，輸出 0 件；結構先到位 |

### 各期守門測試與還原驗證

原則（CLAUDE.md／維護者）：守門測試要**還原驗證**——把被守的東西拿掉，確認測試真的會紅；標記字串必須唯一；兩份真相（SQL 與 TS）必須由測試逐案比對，不是各測各的。測試要有一條**不靠我們自己捏的測試資料**的路徑（用 PGlite 實跑 migration 與臂本體；格與往外擴另用正式庫的唯讀快照比對腳本）。

| 期 | 守門測試（新增，放 `supabase/functions/_shared/` 或 `lib/`） | 還原驗證要點 |
|---|---|---|
| 一 | `lineage-whole-picture-schema.test.ts`：PGlite 實跑 migration，驗①三張表 RLS、CHECK、唯一鍵、`condition` 與 `stance` 的互依②`contains` 不成環、同層同地、舊值仍可寫③子表寫入會蓋父脈絡 `updated_at`④`lineages_full` 前面欄位與前一版**一字不差**、新欄在尾端⑤`source_refs` 清單含四個新名字、舊名字一個不少⑥migration 只加不刪（掃 `DROP TABLE`／`DROP COLUMN`）⑦**`contains` 的層級與地方矩陣逐格測**（縣市大計畫包含**不同縣市**的鄉鎮項目要被擋、同縣市的過；鄉鎮對鄉鎮要 `region` 與 `sub_region` 都同）⑧`search_terms` 空陣列可寫入、既有列不被 CHECK 擋；`lineage.test.ts` 的 SQL／TS 列舉值逐案比對加上立場、事件、現況；`search_terms` 檢查（子字串、字數、地名、出現數）⑨`merge_politician` 與空殼清理（2.9） | ①拿掉成環檢查→成環測試要紅②從 CHECK 清單拿掉 `lineage_events`→寫入事件要失敗而測試紅③把 `lineages_full` 新欄插到中間→前綴測試紅④拿掉 `lineage_touch_parent`→`updated_at` 測試紅⑤把觸發器退回「只看層級高低」→跨縣市鄉鎮項目測試紅⑥拿掉 `merge_politician` 搬立場的那段→測試紅 |
| 二 | 每型別一支：落庫冪等（同鍵覆蓋、`remove`）、讀不到的社群被擋、日期規則、**現況的撤回與取代（`remove`／`replace_as_of`）：錯填較晚日期後，較早的合法現況仍能收進歷史、撤回後「現行」退回次新**、`single_non_official_source` 對三型別成立（掃 `SOLE_SOURCE_GUARDED_TYPES`）且**陣列型逐項檢查**（項目 A 只引媒體 1、項目 B 只引媒體 2 的 10 項交件要被擋）、中文稱謂不再誤稱「政見進度」、`needsTwoIps` 與 SQL `contribution_needs_two_ips` 逐案比對（事件 `cancelled`；**案例含陣列 payload、混合 payload、非陣列、`remove` 項**）、四處清單與 `vote-budget`／`system-one` 欄位表／`TASK_SOURCE_NEEDS`／`task-labels`／`history` 標籤齊全；臂：用假資料測各條件的邊界（過期天數剛好、剛好沒過期、階段終止、在途交件、`gap_not_found_days` 冷卻〔指紋換號也擋〕、空脈絡不派）、`activity-arms.test.ts` 三處齊全、**`village-progress-cooling.test.ts` 不改、照樣綠**（`PROGRESS_COOLDOWN_TASK_TYPES` 與設定表初值沒被動到） | ①把 `lineage_stance` 拿出 `SOLE_SOURCE_GUARDED_TYPES`→測試紅②拿掉臂的「在途交件」`NOT EXISTS`→重複派工測試紅③把空脈絡條件拿掉→測試紅④把 `cancelled` 改成讀純量 `p_payload->>'event_type'`（或 TS 不走 `.some()`）→陣列 payload 案例紅⑤把逐項檢查退回只看外層→跨項引用案例紅⑥把「不得早於最新」守門加回來→錯填日期案例紅 |
| 三 | 主頁模板**靜態文字白名單**測試（多一句說明就紅）；SSR 轉字串的測試（有現況／摘要出處／立場表／大事記／筆數列、**沒有**關係圖的 SVG）；立場表的「最新一筆」「曾變」「提出政見」不計入筆數；JSON-LD 與 canonical 指自己；空脈絡 `noindex` 且不進網站地圖；對缺欄位的資料（舊視圖）不炸；**合格政見 0 條（`policy_ids` 為空）的脈絡直接開網址不報錯、不白屏**（既有 6 條 PR 2 之後就是這樣）；**主頁輸出的站內連結逐一用 router 解析，每一個都要對到已註冊的路由、而且不是找不到頁**（第三期尤其不得有 `/graph`）；「提出政見」推導列只在畫面算、不寫表，該人物之後有正式表態時以正式的取代、不重複列 | ①在模板加一句解釋文字→白名單測試紅②讓「提出政見」列計入筆數→筆數測試紅③把 `lineages_list` 缺的退路拿掉→缺視圖測試紅④在第三期的主頁加上 `/graph` 按鈕→連結解析測試紅⑤讓空脈絡讀 `policy_ids[0]`→空值測試紅 |
| 四 | `lineage-graph` 純函式測試（泳道排序、任期條不重疊、立場落在對的泳道、對不到任期落「其他」、每個職位各一條交接線、下一任虛線、手機版排序新到舊且與桌機同資料）；第 5.3 節那一整張守門表；主頁此時**有**指向 `/graph` 的按鈕與「曾變」連結，且連結解析測試仍綠（路由已註冊）；`HANDOVER_LABEL` 前後端一致 | ①`SSR_ROUTES` 放寬→測試紅②`collectRoutePaths` 加入 `/graph`→紅③postbuild 拿掉 `/graph` 檢查，再把 `/graph` 塞進清單→build 要紅④`usePageHead` 不傳 `canonical`→紅 |
| 五 | `scripts/arms-parity-lineage-cells.ts`（正式庫唯讀快照：舊法對新法的格數、最大格；PR 2 合併後用它的函式重算；空對空要明說）；PGlite 實跑：縣長、議員、鄉鎮市長、區域立委落同一格；總統落全國格；一條政見只回一列；超過 `cell_max_policies` 會拆；往外擴：太泛的詞被丟、地名被排除、已歸入別條的進 `other_lineages` 不進候選、查過同指紋不再派、`expand_recheck_days`、`step='terms'`；臂成本實測寫進 PR 說明 | ①把 `expand_term_df_cap` 調大→「太泛」測試紅②拿掉地名排除→紅③拿掉「已歸入別條」排除→紅④讓立委回兩列→一列測試紅 |
| 六 | `policy-jp-lineage-whole.test.ts`（結構、型別、`cancelled` 兩台機器、臂 0 件）；漂移測試的登記清單歸零 | 拿掉日本版 `cancelled` 規則→漂移與逐案比對紅 |

---

## 8. 風險與「錯了的代價」

| 風險 | 錯了的代價 | 防線 |
|---|---|---|
| 同一件事被建成兩條（跨縣市重複） | 立場、事件分散在兩頁，讀者看不到全貌；搜尋引擎看到兩個近似頁 | 格任務的 `existing_lineages` 帶「涵蓋該縣市」的脈絡；往外擴的 `other_lineages` 提示；補救用現有的 `detach`＋`歸入`（不新增「合併脈絡」功能，第 10 節）。**已知缺口**（agy 審查）：被拿掉政見的那一條若已有立場、事件、現況，這些子表資料**不會跟著搬**，那條會變成「0 條政見、還帶一堆子表資料」的空脈絡（頁面照 2.2 隱藏、資料保留）；第一版接受，重複成常態時另案做合併（要搬六張子表，並照 2.9 處理撞鍵） |
| **不同件事被併成一條**（同名不同標的，例：兩個縣市各一條「藍線」） | **比上一條嚴重**：把 A 縣的立場與決定算到 B 縣；讀者讀到錯的全貌 | 驗證規則要求 note 寫共同專有名詞與地點、同名不同標的一律不歸入（3.3）；往外擴的預期結果多半是 `no_change`；`lineage` 錯歸入可用 `detach` 還原，查核履歷完整 |
| 立場被錯誤歸因給某人 | 對具名的人公開錯誤陳述 | 原文逐字、讀不到的社群不收、媒體需兩站、`remove` 與整筆還原；立場表每筆都附出處 |
| 現況或事件過期、被當成現在 | 讀者以為「施工中」其實早停 | 畫面只印**截至日**（不寫「過期」「N 天前」）；過期派任務；階段 `cancelled`／`completed` 的才停派 |
| 評價滲進摘要、現況、事件描述 | 站方被認定立場偏頗 | 驗證規則「只寫事實、每句有出處」；沿用 PR 2 的檢查；主頁不放評價欄位 |
| 往外擴灌爆隊伍 | 隊裡一次多出數百件，擠掉選舉缺口 | 詞的出現數上限、一脈絡一件、候選上限 30、`open_cap_per_arm`、規則可停；上線前實測成本 |
| `lineages_full` 變大拖慢一覽頁與建置快照 | `/analysis` 載入變慢、`__INITIAL_STATE__` 暴增 | `lineages_list`；量測門檻（> 500 KB 切換） |
| 關係圖不 SSR：分享預覽是通用圖、搜尋引擎看不到 | 這頁不會被搜尋到（刻意）；LINE／臉書貼連結的預覽不是這件事 | 維護者已接受「只能到我們的網站看最清晰」；主頁（可收錄、有正確的 `og:`）才是分享的首選，主頁的按鈕連過去 |
| 前端先於 migration 上線的空窗（Hosting 先、`db push` 後） | 新欄位幾分鐘讀不到 | `select('*')`、缺欄當空、缺視圖退回舊視圖（沿用 `isMissingRelation`）；先合併含 migration 的期，前端期後合 |
| `source_refs` CHECK 與 `contributions` CHECK 清單並行 PR 撞號 | 後上的 migration 把前一支加的名字洗掉，交件被擋而測試全綠（2026-09-20 踩過） | 合併前以 main 最新那一版為底重寫；清單用「掃全部 migration 取最後一版」的測試 |
| 日本站漂移 | 日本站落後、複本與正見不同步 | 每期登記偏離、第六期清零 |
| 2026-11-28 開票後 2026 當選者的政見進場 | 格與可派任務一次增加；6 條空脈絡重新接上 | 格鍵與指紋會自動處理；空脈絡保留（2.2）；`open_cap_per_arm` 可限流 |
| 首次上線的任務量 | 約 236 件格任務取代現有 279 件，量級相當 | 不新增淨量；`open_cap_per_arm` 備用 |
| 人物合併或空殼清理沒顧到新表 | 立場掛在被合併者身上留下孤兒外鍵；有立場的人被當空殼移除 | 第一期就改 `merge_politician` 與空殼那一段（2.9），有測試與還原驗證 |
| 同日同機關同型態的多項事件撞唯一鍵 | 後交的覆蓋先交的 | 協議要求合併成一筆分點寫；覆蓋留查核履歷（2.4） |
| 錯填的現況日期擋住後面的合法現況 | 「現行現況」卡在錯的那一列 | 不再用「不得早於最新」擋；提供 `remove`／`replace_as_of`（2.4、3.1） |
| 借用村里長的冷卻清單 | 動到那份清單會讓 `village-progress-cooling.test.ts` 紅、而且回給代理的句子寫「查無公開進度」 | 不碰，冷卻走 `lineage_settings.gap_not_found_days`（3.4） |

### 8.1 已知限制

| 限制 | 說明 |
|---|---|
| **異名同案抓不到** | 往外擴靠「標題裡的專有名詞」（標題子字串）比對。同一件事在不同地方、不同人嘴裡叫法不同（例：「北宜高鐵」與「高鐵延伸宜蘭」）就比對不到，這個取向是刻意的：誤併的傷害比漏抓大（風險表第 2 列）。**維護者正在討論要不要做「計畫名稱詞表」（同一計畫的別名對照）；本計畫只把它記為後續選項，不設計。** 在那之前，異名同案只能靠格任務（同縣市同類別的人工判斷）接住 |
| 沒有縣市的立委（不分區、原住民）與總統副總統 | 落「全國」格，初次分組不會與縣市首長的政見同格；今天資料裡立委政見全部有縣市，全國格只有總統副總統 13 條，影響很小 |
| 立場只收站上已有的人物 | 機關、團體、非民選官員的表態收不進來；機關的決定走事件的 `decided_by`（第 9 節裁決 3） |
| 不做合併脈絡 | 見風險表第 1 列的已知缺口 |

---

## 9. 需要維護者裁決的點（只列真的需要的）

**狀態**：四點主線 2026-10-19 全部**採用我的建議**（下表「狀態」欄標「主線 10-19 採用」）；維護者若有不同意見，在審這份計畫時直接推翻即可，各點的做法都寫在對應章節。

| # | 要裁決什麼 | 建議（＝主線採用的做法） | 狀態 |
|---|---|---|---|
| 1 | **摘要的註腳形式**：示意圖的摘要每句後面有［1］［2］。要「逐句註腳」，還是「整段出處列」（摘要下方編號列出這條脈絡的出處）？ | **第一期用整段出處列**。逐句註腳要把摘要結構化成多句、每句各自掛出處，交件與驗證成本約加倍；PR 2 的「逐句核來源」是驗證規則，不需要結構化。真要逐句再做第二版（`lineage_summary_points`，另一張表）。示意圖的註腳標記先不畫 | **主線 10-19 採用** |
| 2 | **兩台機器規則其實沒有額外效力**（第 3.4 節的發現）：沒有系統票的型別，目標 3 本來就要至少兩個不同來源網段。「中止」（`stop`）與事件「終止」（`cancelled`）要不要**真的**加高（例：目標 4）？ | **這期不動**：事件 `cancelled` 照 `stop` 套同一條規則（維持對等；陣列寫法見 3.4），**上線兩週後看被退比例與誤報再裁**。若要加高＝改計分，要改 SQL、TS、`skill.md` 門檻表並通知日本站。規則寫進協議時**照實寫成「明文化」**，不寫成「要求更多票」，避免代理誤解 | **主線 10-19 採用** |
| 3 | **立場持有人的範圍**：只收站上已有的人物（`politicians`），還是也收政府機關、民間團體、非民選官員（例：交通部長）？ | **第一版只收站上人物**（與參與者同規則）；機關與團體的決定已由事件的 `decided_by` 涵蓋。要收機關團體得新增「發言者」實體與身分去重，另案 | **主線 10-19 採用** |
| 4 | **立場表要不要補「提出政見」推導列**：政見持有人沒有立場紀錄時，顯示一列灰色「提出政見」（日期＝提出日或屆別投票日、出處＝政見頁），不算進立場筆數 | **要**。否則立場表會漏掉脈絡裡最明顯的一群人（提出者），而且不需要他們再交一次立場；用不同標籤避免把「提出」說成「支持」；只在畫面算、不寫表，有正式表態就由正式的取代 | **主線 10-19 採用** |

不需要裁決、但審閱時請留意的假設：交接標籤改用示意圖詞彙（照舊做／改做法／縮小／停掉／重新開始，第四期同步改）；沒有單一主辦者填牽頭或核定的那一級（2.2）；空脈絡保留並隱藏（2.2）；格任務上線不設上限（`open_cap_per_arm` 空，與今天一致）。

---

## 10. 不做的事

| 項目 | 原因 |
|---|---|
| 跨縣市同級合作連結 | 維護者撤回：一條全貌自然跨縣市 |
| 鄉長政見一律進鄉鎮那條 | 維護者撤回：同一條裡分層並排 |
| 合併兩條脈絡的功能 | 現有 `detach`＋`歸入`夠用；真的重複成常態再另案 |
| 立場的系統票（機器核對原文是否在出處） | 要在 Edge Function 抓任意網頁、與 `system-one` 的預判分開處理；先靠驗證者，之後另案評估 |
| 村里長、鄉鎮市民代表、區民代表的政見進脈絡 | 現行範圍就只有六種職位（總統副總統、立委、縣市長、縣市議員、鄉鎮市長、原住民區長）；本期不擴 |
| 關係圖的伺服器端渲染與收錄 | 維護者：「只能到我們的網站看最清晰」 |
| 摘要逐句註腳 | 見裁決 1，先不做 |
| 以 `policies.origin` 回填或「承諾／政見」全站用詞 | #672 另案，不在本計畫 |

---

## 附錄 A：唯讀查詢（2026-10-19）

全部以 `npx supabase db query --linked -f <檔> -o csv` 跑，檔案第一行 `SET default_transaction_read_only = on;`，沒有寫入。PR 2 範圍的共同底稿（PR 2 合併後以它的資格函式取代）：

```sql
WITH scoped AS (
  SELECT pl.id AS policy_id, pl.category, pl.lineage_id, p.id AS politician_id, pl.election_id,
         x.election_type, replace(r.region, '臺', '台') AS county, r.sub_region AS town
    FROM policies pl
    JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
    JOIN elections e ON e.id = pl.election_id
    JOIN LATERAL (
      SELECT q.election_type, q.candidacy_status, q.region_id FROM politician_elections q
       WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
       ORDER BY (q.candidacy_status = 'elected') DESC NULLS LAST, q.id LIMIT 1
    ) x ON true
    LEFT JOIN regions r ON r.id = x.region_id
   WHERE pl.removed_at IS NULL AND pl.category IS NOT NULL
     AND e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected'   -- 年份與先後一律看 election_date，不從 id 推
     AND x.election_type IN ('總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')
)
-- 新格：縣市（總統副總統與「全國」歸一個全國格）× 類別
SELECT CASE WHEN election_type = '總統副總統' OR county IS NULL OR county = '全國' THEN '(全國)' ELSE county END AS cell_county,
       category, count(*) AS n, count(DISTINCT (politician_id, election_id)) AS terms,
       count(DISTINCT election_type) AS n_types, count(*) FILTER (WHERE lineage_id IS NULL) AS loose
  FROM scoped GROUP BY 1, 2;
```

| 查詢 | 得到 | 用在 |
|---|---|---|
| 既有脈絡逐條的政見、交接、參與者、關聯筆數 | 10 條、23 條政見、其餘 0 | 1.2、2.8 |
| 各職位在範圍內的政見數 | 2,188 條（六種職位） | 1.2 |
| 新格分布（上面的查詢再彙總） | 316 格、236 可派、中位數 4、第 90 百分位 18.5、最大 44、>30 有 6 格、>60 有 0 格、含 ≥2 種職位 161 格 | 4.2 |
| 舊格（層級＋縣市＋鄉鎮＋類別，立委放兩格）在同一範圍 | 350 格、252 可派、最大 53 | 4.2 |
| 專有名詞出現數（17 個詞） | 專有名詞 1～9；通稱 20～75；地名 31 | 4.3 |
| 標題子字串切法在 10 條既有標題上（出現數 1～12 取最長） | 4 條切得出合格詞、6 條切不出 | 4.3 |
| 既有脈絡的合格政見（PR 2 之後） | 4 條保留（合計 8 條政見）、6 條歸 0 | 1.2、2.2、2.8 |
| 現在隊裡與歷史 | 279 件 `lineage_candidate`、8 件 `lineage_roles_missing`、2 件 `lineage_link_candidate`、66 筆格清查結論、`lineage` 通過 10 筆被退 3 筆 | 1.2、2.8、4.6 |
| 涵蓋地方計算 `EXPLAIN ANALYZE` | 10 條脈絡 1.1 毫秒 | 2.6 |
| `lineages_full` 全表 JSON 大小 | 10 列 4.9 KB | 2.6 |
| 日本站 | 政見 0、脈絡 0、人物 46、脈絡任務 0 | 第 6 節 |

## 附錄 B：這些計畫會動到的檔案（供派工時查「同時只派一件」）

| 範圍 | 檔案 |
|---|---|
| SQL | 新 migration（各期）；`contribution_auto_tasks_arms()`、`activity_arm_names()`、`activity_rules`（第二、五期都動，**同時只派一件**）；`contribution_needs_two_ips()`（以 main 最新一版為底整支重寫）；`system_one_vote_budget_candidates()`；`source_refs` 與 `contributions` 的 CHECK；**`merge_politician()`、`contribution_auto_tasks_placeholder_politicians()`（第一期，2.9）**；不動 `task_cooldown_settings` 與 `PROGRESS_COOLDOWN_TASK_TYPES` |
| Edge Function 共用 | `_shared/lineage.ts`（含 `parseCandidateTaskId` 加 `lineage_expand`）、`contribution-schema.ts`、`apply-contribution.ts`、`apply-precheck.ts`、`consensus.ts`、`sole-source-guard.ts`、`system-one.ts`、`vote-budget.ts`、`task-types.ts`、`task-context.ts`、`task-guidance.ts`、`verification-sources.ts`、`contribution-summary.ts`、`summary-lookup.ts`、`history.ts`、`same-claims.ts`、`protocol.ts`（版號）、`type-spec.gen.ts`（產物） |
| 協議與文件 | `public/skill.md`（檔頭版號、第 1a 條、計分表）、`public/skill-types.md`、`public/llms.txt`、`docs/decisions/`（新裁決檔）、`CLAUDE.md`（由主線改）、`docs/PIPELINE.md` |
| 前端 | `types.ts`、`lib/lineage.ts`、新 `lib/lineage-graph.ts`、`lib/task-labels.ts`、`lib/ssg/page-data.ts`、`lib/ssr/loaders.ts`、`composables/useSupabase.ts`（載入 `lineage_terms`）、`composables/usePageHead.ts`、`router/index.ts`、`pages/LineagePage.vue`、新 `pages/LineageGraphPage.vue`、新 `components/lineage/*`、`pages/PolicyAnalysis.vue` |
| 建置與邊緣 | `scripts/postbuild-ssg.mjs`、`lib/ssg/server-data.ts`（確認不加 `/graph`）、`cloudflare/ssr-worker.js`（標頭，選做）、`firebase.json`（不改，只加測試） |
| 日本站 | `supabase/migrations/*_jp_*`、`_shared/jp/*`、`policy-jp-dispatch-drift.test.ts` |
