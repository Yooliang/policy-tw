# Policy-AI 智能系統架構

## 概述

Policy-AI 是一個基於 Claude 驅動的自動化系統，用於搜尋、驗證台灣選舉候選人與政見資料。系統採用非同步任務佇列模式，Claude 直接呼叫 API 更新資料庫。

---

## 系統架構圖

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           使用者介面層                                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │   policy-tw     │  │  Claude PM Web  │  │     AdminAI.vue         │  │
│  │   (前端網站)     │  │  (任務監控)      │  │   (AI 任務管理)          │  │
│  └────────┬────────┘  └────────┬────────┘  └───────────┬─────────────┘  │
└───────────┼─────────────────────┼──────────────────────┼────────────────┘
            │                     │                      │
            ▼                     ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Supabase 層                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Edge Functions                                │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │   │
│  │  │  ai-search   │  │  ai-action   │  │  ai-prompt-status    │  │   │
│  │  │  (建立任務)   │  │  (統一 API)   │  │  (查詢狀態)           │  │   │
│  │  └──────┬───────┘  └──────┬───────┘  └──────────────────────┘  │   │
│  │         │                 │                                      │   │
│  │         ▼                 ▼                                      │   │
│  │  ┌────────────────────────────────────────────────────────────┐ │   │
│  │  │                   ai_prompts 表                             │ │   │
│  │  │  - id, task_type, parameters, status                       │ │   │
│  │  │  - result_summary, result_data, error_message              │ │   │
│  │  │  - created_at, started_at, completed_at                    │ │   │
│  │  └────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    核心資料表                                     │   │
│  │  politicians │ policies │ tracking_logs │ elections │ ...       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
            │
            │ 輪詢 (polling)
            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        GCP Compute Engine                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Claude PM                                    │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │   │
│  │  │   Poller     │  │  Executor    │  │  policy-ai-skills    │  │   │
│  │  │ (輪詢任務)    │  │ (執行 Claude) │  │    (技能庫)           │  │   │
│  │  └──────┬───────┘  └──────┬───────┘  └──────────────────────┘  │   │
│  │         │                 │                                      │   │
│  │         ▼                 ▼                                      │   │
│  │  ┌────────────────────────────────────────────────────────────┐ │   │
│  │  │               Claude CLI (claude -p)                        │ │   │
│  │  │  - 接收任務檔案                                              │ │   │
│  │  │  - 執行網路搜尋                                              │ │   │
│  │  │  - 直接呼叫 ai-action API 更新資料庫                          │ │   │
│  │  └────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 核心元件

### 1. Edge Functions

| 函數名稱 | 用途 | 狀態 |
|---------|------|------|
| `ai-action` | 統一的 AI 任務 API（主要使用） | ✅ 使用中 |
| `ai-search` | 建立新的 AI 搜尋任務 | ✅ 使用中 |
| `ai-prompt-status` | 查詢任務狀態 | ✅ 使用中 |

### 2. ai-action 支援的操作

| Action | 用途 | 必要欄位 |
|--------|------|---------|
| `query_candidates` | 查詢現有候選人（防止重複） | election_year, region?, position? |
| `query_policies` | 查詢現有政見（防止重複） | politician_name |
| `import_candidate` | 匯入候選人（需 confidence >= 0.7） | election_year, candidate |
| `add_policy` | 新增政見 | politician_name, policy |
| `update_policy` | 更新政見狀態 | politician_name, policy_title, new_status |
| `add_tracking_log` | 新增追蹤紀錄 | politician_name, policy_title, log |
| `update_prompt` | 更新任務狀態 | prompt_id, status |

### 3. 技能庫 (policy-ai-skills/)

| 檔案 | 用途 |
|------|------|
| `taiwan-election-expert.md` | 候選人搜尋技能 |
| `policy-researcher.md` | 政見搜尋技能 |
| `policy-verifier.md` | 政見驗證技能 |
| `progress-tracker.md` | 進度追蹤技能 |
| `task_manager.py` | 任務檔案管理 |

---

## 資料驗證機制

### 1. 查詢先行

Claude 執行任務時必須先查詢現有資料：

```bash
# 步驟 1：查詢現有候選人
curl -X POST "https://.../ai-action" \
  -d '{"action":"query_candidates","election_year":2026,"region":"台北市"}'

# 回應：
# {"success":true,"count":3,"candidates":[...]}

# 步驟 2：只新增不存在的候選人
```

### 2. 信心度門檻

| 信心度 | 來源可信度 | 是否匯入 |
|--------|-----------|---------|
| 0.9-1.0 | 官方登記、中選會公告 | ✅ |
| 0.8-0.9 | 候選人正式宣布、黨提名確定 | ✅ |
| 0.7-0.8 | 多家主流媒體報導確認 | ✅ |
| 0.5-0.7 | 單一來源報導 | ❌ |
| 0.0-0.5 | 傳聞、推測 | ❌ |

### 3. 無效名稱過濾

自動跳過包含以下模式的名稱：
- 未定、待定、待確認、未知、人選、待公布
- 長度 < 2 或 > 10 的名稱

---

## 潛在問題與解決方案

### 問題 1：搜尋到舊資料

**現象**：搜尋到過時的新聞或過去的選舉資料

**解決方案**：在搜尋時加入日期限制

```
搜尋時請加入時間限制：
- 只搜尋最近 30 天的新聞
- 使用搜尋語法：site:news.google.com after:2026-01-01
- 排除超過 6 個月的舊聞
```

### 問題 2：任務超時

**現象**：任務執行超過 5 分鐘被終止

**解決方案**：
1. 將大任務拆分成小任務（每個縣市一個任務）
2. 設定合理的搜尋範圍
3. 增加任務續傳機制

### 問題 3：服務中斷

**現象**：PM2 服務停止，任務無法執行

**解決方案**：
1. 設定 PM2 自動重啟
2. 增加健康檢查
3. 設定告警機制

---

## 自動化排程設計

### 方案 A：每日輪換排程

```
週一：六都（台北、新北、桃園、台中、台南、高雄）
週二：北部縣市（基隆、新竹市、新竹縣、苗栗、宜蘭）
週三：中部縣市（彰化、南投、雲林、嘉義市、嘉義縣）
週四：南部縣市（屏東、澎湖）+ 東部（花蓮、台東）
週五：離島（金門、連江）+ 全台政見進度追蹤
週六：重點候選人政見驗證
週日：休息 / 系統維護
```

### 方案 B：定時排程（每 30 分鐘一個縣市）

```
00:00  台北市
00:30  新北市
01:00  桃園市
...
10:30  連江縣
12:00  政見進度追蹤
18:00  政見驗證
```

### 實作方式

#### 選項 1：Supabase Cron + Edge Function

建立 `ai-scheduler` Edge Function：

```typescript
// supabase/functions/ai-scheduler/index.ts
Deno.serve(async () => {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();

  // 根據時間決定要處理的縣市
  const regions = getScheduledRegions(dayOfWeek, hour);

  for (const region of regions) {
    await createSearchTask(region);
  }
});
```

使用 Supabase 的 pg_cron 或外部 cron 服務觸發。

#### 選項 2：GCP Cloud Scheduler

```bash
# 建立 Cloud Scheduler Job
gcloud scheduler jobs create http policy-ai-daily \
  --schedule="0 0 * * *" \
  --uri="https://.../functions/v1/ai-scheduler" \
  --http-method=POST
```

#### 選項 3：Python Cron 排程器

在 policy-ai 服務中加入排程器：

```python
# scheduler.py
from apscheduler.schedulers.asyncio import AsyncIOScheduler

scheduler = AsyncIOScheduler()

# 定義排程
SCHEDULE = {
    0: ["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市"],  # 週一
    1: ["基隆市", "新竹市", "新竹縣", "苗栗縣", "宜蘭縣"],  # 週二
    # ...
}

@scheduler.scheduled_job('cron', hour=0, minute=0)
async def daily_search():
    today = datetime.now().weekday()
    regions = SCHEDULE.get(today, [])

    for i, region in enumerate(regions):
        # 每 30 分鐘一個任務
        await asyncio.sleep(i * 30 * 60)
        await create_search_task(region)
```

---

## 日期限制設計

### 在提示詞中加入日期限制

修改技能檔案，加入日期過濾指示：

```markdown
## 搜尋時間限制

**重要**：只搜尋最近 30 天的新聞資料。

搜尋技巧：
1. Google 搜尋加入時間過濾：`2026年台北市長候選人 after:2026-01-01`
2. 排除明顯過時的資訊（如：2022 年選舉結果）
3. 優先使用最近一週的新聞來源
4. 在結果中記錄新聞發布日期

若搜尋結果都是舊資料，回報「無最新消息」而非使用過時資訊。
```

### 在 API 中驗證日期

```typescript
// ai-action Edge Function
async function handleImportCandidate(supabase: any, body: any) {
  const { candidate } = body;

  // 驗證來源日期
  if (candidate.source_date) {
    const sourceDate = new Date(candidate.source_date);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);

    if (sourceDate < cutoffDate) {
      return successResponse({
        skipped: true,
        reason: "outdated_source",
        message: `來源日期過舊: ${candidate.source_date}`
      });
    }
  }

  // ... 繼續處理
}
```

---

## 任務類型與參數

### candidate_search（候選人搜尋）

```json
{
  "task_type": "candidate_search",
  "parameters": {
    "election_year": 2026,
    "region": "台北市",
    "position": "縣市長",
    "search_date_limit": 30
  }
}
```

### policy_search（政見搜尋）

```json
{
  "task_type": "policy_search",
  "parameters": {
    "politician_name": "蔣萬安",
    "keywords": ["交通", "捷運"],
    "search_date_limit": 30
  }
}
```

### progress_tracking（進度追蹤）

```json
{
  "task_type": "progress_tracking",
  "parameters": {
    "politician_name": "蔣萬安",
    "policy_title": "捷運綠線",
    "search_date_limit": 30
  }
}
```

### policy_verify（政見驗證）

```json
{
  "task_type": "policy_verify",
  "parameters": {
    "politician_name": "蔣萬安",
    "policy_title": "捷運綠線"
  }
}
```

---

## 部署指令

### GCP 服務

```bash
# SSH 連線
gcloud compute ssh claude-pm-server --zone=us-central1-a --tunnel-through-iap

# 查看服務狀態
sudo -u cwen0 pm2 list

# 重啟服務
sudo -u cwen0 pm2 restart all

# 查看日誌
sudo -u cwen0 pm2 logs
```

### Edge Functions

```bash
# 部署 ai-action
npx supabase functions deploy ai-action --no-verify-jwt

# 部署 ai-search
npx supabase functions deploy ai-search --no-verify-jwt
```

### 同步技能檔案到 GCP

```bash
# 從本地上傳
gcloud compute scp policy-ai-skills/*.md \
  claude-pm-server:/home/cwen0/projects/policy-ai/skills/ \
  --zone=us-central1-a

gcloud compute scp policy-ai-skills/task_manager.py \
  claude-pm-server:/home/cwen0/projects/policy-ai/ \
  --zone=us-central1-a
```

---

## 監控與告警

### PM2 監控

```bash
# 設定自動重啟
pm2 startup
pm2 save

# 健康檢查
pm2 monit
```

### 任務監控 SQL

```sql
-- 查看今日任務統計
SELECT
  status,
  COUNT(*) as count,
  AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_seconds
FROM ai_prompts
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;

-- 查看失敗任務
SELECT id, task_type, parameters, error_message, created_at
FROM ai_prompts
WHERE status = 'failed'
  AND created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

---

## 下一步行動

### 優先順序 1：日期限制
- [ ] 修改技能檔案，加入搜尋日期限制
- [ ] 在 AI 呼叫時要求記錄新聞日期
- [ ] 在 API 中驗證來源日期

### 優先順序 2：排程系統
- [ ] 建立 `ai-scheduler` Edge Function
- [ ] 設定 Cron 排程
- [ ] 實作輪換排程配置

### 優先順序 3：監控告警
- [ ] 設定 PM2 自動重啟
- [ ] 建立每日報告 SQL
- [ ] 設定失敗告警

---

## 相關檔案

| 用途 | 路徑 |
|------|------|
| 前端 AI 管理頁 | `pages/AdminAI.vue` |
| 統一 AI API | `supabase/functions/ai-action/index.ts` |
| 觸發 Edge Function | `supabase/functions/ai-search/index.ts` |
| 狀態查詢 Function | `supabase/functions/ai-prompt-status/index.ts` |
| 候選人搜尋技能 | `policy-ai-skills/taiwan-election-expert.md` |
| 政見搜尋技能 | `policy-ai-skills/policy-researcher.md` |
| 政見驗證技能 | `policy-ai-skills/policy-verifier.md` |
| 進度追蹤技能 | `policy-ai-skills/progress-tracker.md` |
| 任務管理器 | `policy-ai-skills/task_manager.py` |
| Claude PM 配置 | `Claude-PM/config.gcp.yaml` |
