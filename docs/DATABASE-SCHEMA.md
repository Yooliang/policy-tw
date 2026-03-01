# 資料庫結構說明文件

## 概述

正見 (Zheng Jian) 平台使用 Supabase PostgreSQL 資料庫，共有 18 個資料表、4 個 ENUM 類型、6 個視圖。

---

## ENUM 類型定義

### policy_status - 政策狀態
| 值 | 說明 |
|---|---|
| `Proposed` | 提出 |
| `In Progress` | 進行中 |
| `Achieved` | 已實現 |
| `Stalled` | 滯後/卡關 |
| `Failed` | 跳票 |
| `Campaign Pledge` | 競選承諾 |

### political_party - 政黨
| 值 | 說明 |
|---|---|
| `國民黨` | 中國國民黨 (KMT) |
| `民進黨` | 民主進步黨 (DPP) |
| `民眾黨` | 台灣民眾黨 (TPP) |
| `無黨籍` | 獨立參選 |

### election_type - 選舉類型
| 值 | 說明 |
|---|---|
| `總統副總統` | 總統、副總統選舉 |
| `立法委員` | 立法委員選舉 |
| `縣市長` | 縣市長選舉 |
| `縣市議員` | 縣市議員選舉 |
| `鄉鎮市長` | 鄉鎮市長選舉 |
| `直轄市山地原住民區長` | 六都山原區長選舉 |
| `鄉鎮市民代表` | 鄉鎮市民代表選舉 |
| `直轄市山地原住民區民代表` | 六都山原區代表選舉 |
| `村里長` | 村里長選舉 |

### politician_status - 政治人物狀態
| 值 | 說明 |
|---|---|
| `incumbent` | 現任 |
| `politician` | 已登記參選 |
| `potential` | 潛在人選 |
| `former` | 前任 |

---

## 核心資料表

### 1. elections - 選舉
儲存選舉基本資訊。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | 選舉 ID（也作為年份，如 2026） |
| name | TEXT | 選舉名稱 |
| short_name | TEXT | 簡稱 |
| election_date | DATE | 投票日期 |
| start_date | DATE | 任期開始 |
| end_date | DATE | 任期結束 |

### 2. election_types - 選舉類型對應
一場選舉可包含多種選舉類型。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| election_id | INTEGER FK | → elections.id |
| type | election_type | 選舉類型 |

**約束:** `UNIQUE(election_id, type)`

### 3. politicians - 政治人物
儲存政治人物基本資料。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | UUID PK | 政治人物 ID |
| name | TEXT | 姓名 |
| party | TEXT | 政黨 |
| status | politician_status | 狀態 |
| election_type | TEXT | 參選類型 |
| position | TEXT | 參選職位 |
| region | TEXT | 縣市 |
| sub_region | TEXT | 鄉鎮市區 |
| village | TEXT | 村里 |
| current_position | TEXT | 現任職位 |
| avatar_url | TEXT | 頭像網址 |
| slogan | TEXT | 競選口號 |
| bio | TEXT | 個人簡介 |
| birth_year | INTEGER | 出生年份 |
| education_level | TEXT | 學歷等級 |
| education | TEXT[] | 學歷陣列 |
| experience | TEXT[] | 經歷陣列 |
| created_at | TIMESTAMPTZ | 建立時間 |
| updated_at | TIMESTAMPTZ | 更新時間 |

**索引:** `idx_politicians_region`, `idx_politicians_status`

### 4. politician_elections - 參選紀錄
政治人物與選舉的關聯表。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| politician_id | UUID FK | → politicians.id |
| election_id | INTEGER FK | → elections.id |
| position | TEXT | 參選職位 |
| region | TEXT | 參選選區 |
| sub_region | TEXT | 子選區 |
| village | TEXT | 村里 |
| slogan | TEXT | 競選口號 |
| election_type | TEXT | 選舉類型 |
| region_id | INTEGER | 地區 ID |
| candidate_status | TEXT | 參選狀態 (confirmed/likely/rumored) |
| source_note | TEXT | 來源備註 |
| election_result | TEXT | 選舉結果 (elected/not_elected/withdrawn/pending) |
| votes_received | INTEGER | 得票數 |
| vote_percentage | DECIMAL(5,2) | 得票率 |
| verified | BOOLEAN | 是否已驗證 |
| verified_at | TIMESTAMPTZ | 驗證時間 |
| verified_by | UUID FK | → auth.users.id |
| created_at | TIMESTAMPTZ | 建立時間 |

**約束:** `UNIQUE(politician_id, election_id)`
**索引:** `idx_politician_elections_politician_id`, `idx_politician_elections_election_id`

### 5. policies - 政見
儲存政見/承諾內容。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | UUID PK | 政見 ID |
| politician_id | UUID FK | → politicians.id |
| election_id | INTEGER FK | → elections.id |
| title | TEXT | 標題 |
| description | TEXT | 內容描述 |
| category | TEXT | 分類 |
| status | policy_status | 狀態 |
| proposed_date | DATE | 提出日期 |
| last_updated | DATE | 最後更新 |
| progress | INTEGER | 進度 (0-100) |
| tags | TEXT[] | 標籤 |
| ai_analysis | TEXT | AI 分析摘要 |
| support_count | INTEGER | 支持數 |
| source_url | TEXT | 來源網址 |
| ai_extracted | BOOLEAN | AI 提取標記 |
| ai_confidence | DECIMAL(3,2) | AI 信心度 |
| created_at | TIMESTAMPTZ | 建立時間 |

**約束:** `CHECK(progress >= 0 AND progress <= 100)`
**索引:** `idx_policies_politician_id`, `idx_policies_status`, `idx_policies_category`

### 6. tracking_logs - 政見追蹤紀錄
政見執行進度的時間軸記錄。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| policy_id | UUID FK | → policies.id |
| date | DATE | 事件日期 |
| event | TEXT | 事件標題 |
| description | TEXT | 詳細描述 |
| source_url | TEXT | 來源網址 |
| ai_extracted | BOOLEAN | AI 提取標記 |
| created_at | TIMESTAMPTZ | 建立時間 |

### 7. policy_sources - 政見資料來源
儲存政見的新聞來源連結。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| policy_id | UUID FK | → policies.id (CASCADE) |
| url | TEXT | 來源網址 |
| title | TEXT | 新聞標題 |
| source_name | TEXT | 媒體名稱（中央通訊社、聯合報等） |
| published_date | DATE | 發布日期 |
| created_at | TIMESTAMPTZ | 建立時間 |

**索引:** `idx_policy_sources_policy_id`
**約束:** `UNIQUE(policy_id, url)` — 防止同一政見的重複 URL

### 8. related_policies - 相關政見
政見之間的關聯（如：前後任延續）。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| policy_id | UUID FK | → policies.id |
| related_policy_id | UUID FK | → policies.id |

**約束:** `UNIQUE(policy_id, related_policy_id)`, `CHECK(policy_id <> related_policy_id)`

### 9. discussions - 討論
政見相關的討論串。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| policy_id | UUID FK | → policies.id |
| policy_title | TEXT | 政見標題（冗餘） |
| author_id | TEXT | 作者 ID |
| author_name | TEXT | 作者名稱 |
| author_avatar_url | TEXT | 作者頭像 |
| title | TEXT | 討論標題 |
| content | TEXT | 討論內容 |
| likes | INTEGER | 按讚數 |
| tags | TEXT[] | 標籤 |
| view_count | INTEGER | 瀏覽次數 |
| created_at | TEXT | 建立時間 |
| created_at_ts | BIGINT | 時間戳 |

### 10. discussion_comments - 討論留言

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| discussion_id | INTEGER FK | → discussions.id |
| author_id | TEXT | 作者 ID |
| author_name | TEXT | 作者名稱 |
| author_avatar_url | TEXT | 作者頭像 |
| content | TEXT | 留言內容 |
| likes | INTEGER | 按讚數 |
| created_at | TEXT | 建立時間 |

### 11. comment_replies - 留言回覆

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| comment_id | INTEGER FK | → discussion_comments.id |
| author_id | TEXT | 作者 ID |
| author_name | TEXT | 作者名稱 |
| author_avatar_url | TEXT | 作者頭像 |
| content | TEXT | 回覆內容 |
| likes | INTEGER | 按讚數 |
| created_at | TEXT | 建立時間 |

---

## 地區與選區資料表

### 12. regions - 地區統計
正規化的地區資料與統計。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| region | TEXT | 縣市 |
| sub_region | TEXT | 鄉鎮市區 |
| village | TEXT | 村里 |
| total_politicians | INTEGER | 政治人物總數 |
| mayor_count | INTEGER | 縣市長數 |
| councilor_count | INTEGER | 議員數 |
| township_mayor_count | INTEGER | 鄉鎮市長數 |
| representative_count | INTEGER | 代表數 |
| village_chief_count | INTEGER | 村里長數 |
| policy_count | INTEGER | 政見總數 |
| updated_at | TIMESTAMPTZ | 更新時間 |

**約束:** `UNIQUE NULLS NOT DISTINCT (region, sub_region, village)`

### 13. electoral_district_areas - 選舉區對應
議員選區與鄉鎮市區的對應關係。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| region | TEXT | 縣市 |
| electoral_district | TEXT | 選舉區（如：第01選舉區） |
| township | TEXT | 鄉鎮市區 |
| election_id | INTEGER | 選舉年份 |
| prv_code | TEXT | 中選會省代碼 |
| area_code | TEXT | 中選會選區代碼 |
| dept_code | TEXT | 中選會鄉鎮代碼 |
| created_at | TIMESTAMPTZ | 建立時間 |

**用途:** 使用者選「茂林區」→ 查詢對應「第01選舉區」→ 顯示該選區議員

---

## AI 相關資料表

### 14. ai_prompts - AI 任務佇列
儲存非同步 AI 任務。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | UUID PK | 任務 ID |
| task_type | TEXT | 任務類型 |
| prompt_template | TEXT | 提示內容 |
| parameters | JSONB | 動態參數 |
| status | TEXT | 狀態 (pending/scheduled/processing/completed/failed) |
| priority | INTEGER | 優先級 (1-10) |
| cron_expression | TEXT | Cron 表達式 |
| is_recurring | BOOLEAN | 是否循環 |
| started_at | TIMESTAMPTZ | 開始時間 |
| completed_at | TIMESTAMPTZ | 完成時間 |
| last_run | TIMESTAMPTZ | 最後執行 |
| result_summary | TEXT | 結果摘要 |
| result_data | JSONB | 完整結果 |
| confidence | DECIMAL(3,2) | 信心度 |
| error_message | TEXT | 錯誤訊息 |
| election_id | INTEGER FK | 關聯選舉 |
| region | TEXT | 關聯地區 |
| politician_id | UUID FK | 關聯政治人物 |
| created_by | UUID FK | 建立者 |
| created_at | TIMESTAMPTZ | 建立時間 |
| updated_at | TIMESTAMPTZ | 更新時間 |

**task_type 允許值:**
- `candidate_search` - 候選人搜尋
- `policy_search` - 政見搜尋
- `policy_verify` - 政見驗證
- `progress_tracking` - 進度追蹤

### 15. ai_usage_logs - AI 使用紀錄
追蹤所有 AI API 調用。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | UUID PK | |
| function_type | TEXT | 功能類型 (search/verify/update/contribute) |
| input_url | TEXT | 輸入網址 |
| input_message | TEXT | 輸入訊息 |
| model_used | TEXT | 使用模型 |
| prompt_tokens | INTEGER | 輸入 token |
| completion_tokens | INTEGER | 輸出 token |
| total_tokens | INTEGER | 總 token |
| estimated_cost | DECIMAL(10,6) | 估計成本 (USD) |
| success | BOOLEAN | 是否成功 |
| error_message | TEXT | 錯誤訊息 |
| confidence | DECIMAL(3,2) | 信心度 |
| raw_response | TEXT | 原始回應 |
| contributed | BOOLEAN | 是否已貢獻 |
| contributed_policy_id | UUID FK | 貢獻的政見 ID |
| user_id | UUID FK | 使用者 ID |
| ip_address | TEXT | IP 位址 |
| created_at | TIMESTAMPTZ | 建立時間 |

---

## 使用者資料表

### 16. user_profiles - 使用者資料

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | UUID PK/FK | → auth.users.id |
| email | TEXT | 電子郵件 |
| display_name | TEXT | 顯示名稱 |
| avatar_url | TEXT | 頭像網址 |
| is_admin | BOOLEAN | 是否管理員 |
| created_at | TIMESTAMPTZ | 建立時間 |
| updated_at | TIMESTAMPTZ | 更新時間 |

---

## 參考資料表

### 17. categories - 分類

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| name | TEXT UNIQUE | 分類名稱 |

### 18. locations - 位置

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PK | |
| name | TEXT UNIQUE | 位置名稱 |

---

## 視圖 (Views)

### policies_with_logs
政見資料含追蹤紀錄。
```sql
SELECT p.*,
  COALESCE(json_agg(l.*), '[]') as logs,
  COALESCE(json_agg(rp.related_policy_id), '[]') as related_policy_ids
FROM policies p
LEFT JOIN tracking_logs l ON p.id = l.policy_id
LEFT JOIN related_policies rp ON p.id = rp.policy_id
GROUP BY p.id
```

### politicians_with_elections
政治人物含參選紀錄。
```sql
SELECT p.*,
  COALESCE(json_agg(pe.election_id), '[]') as election_ids,
  COALESCE(json_agg(pe.*), '[]') as elections
FROM politicians p
LEFT JOIN politician_elections pe ON p.id = pe.politician_id
GROUP BY p.id
```

### discussions_full
討論含完整留言與回覆。

### elected_politicians
已當選政治人物清單。

### ai_usage_stats
AI 使用統計（按月/功能分組）。

### politician_stats_by_region
地區政治人物統計（向後相容，實際讀取 regions 表）。

---

## 關聯圖

```
elections ─────────────────────────────────────────┐
    │                                               │
    ├── election_types                              │
    │                                               │
    └── politician_elections ◄──── politicians     │
              │                        │            │
              │                        └── policies │
              │                              │      │
              │                              ├── tracking_logs
              │                              │
              │                              ├── policy_sources
              │                              │
              │                              └── related_policies
              │
              │                              └── discussions
              │                                     │
              │                                     └── discussion_comments
              │                                            │
              │                                            └── comment_replies
              │
              └────────────────── ai_prompts
                                      │
                                      └── ai_usage_logs

regions ◄──── electoral_district_areas

user_profiles ──► auth.users
```

---

## 觸發器

| 觸發器 | 表 | 用途 |
|--------|---|------|
| update_politician_stats | politicians | 自動更新 regions 統計 |
| update_policy_stats | policies | 自動更新 regions.policy_count |
| handle_new_user | auth.users | 自動建立 user_profiles |
| update_ai_prompts_updated_at | ai_prompts | 自動更新時間戳 |

---

## RLS 政策摘要

| 表 | 讀取 | 寫入 |
|---|------|------|
| elections, politicians, policies, policy_sources | 公開 | 管理員/Service Role |
| ai_prompts | 本人/管理員 | 認證使用者 |
| ai_usage_logs | 本人/管理員 | Service Role |
| user_profiles | 本人 | 本人 |
