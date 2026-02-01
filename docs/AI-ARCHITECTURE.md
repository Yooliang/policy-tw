# Policy-AI 智能系統架構

## 概述

Policy-AI 是一個基於 Claude 驅動的 Python 服務，用於自動化搜尋、驗證台灣選舉候選人與政見資料。系統採用非同步任務佇列模式，將 AI 處理與前端解耦。

---

## 系統架構圖

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (Vue)                               │
│        AdminAI.vue / VerifyContent.vue / Donation.vue           │
└─────────────────────────────┬───────────────────────────────────┘
                              │ HTTP API
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Supabase Edge Functions (Trigger Layer)             │
│  ai-search / ai-verify / ai-prompt-status                       │
│  • 建立 ai_prompts 記錄                                          │
│  • 回傳 prompt_id 供前端輪詢                                      │
└─────────────────────────────┬───────────────────────────────────┘
                              │ INSERT INTO ai_prompts
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Supabase Database                             │
│  ai_prompts │ ai_usage_logs │ politicians │ policies            │
└─────────────────────────────┬───────────────────────────────────┘
                              │ SELECT WHERE status='pending'
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│            policy-ai (GCP Python Service)                        │
├──────────────────────┬──────────────────────────────────────────┤
│  poller.py           │  parser.py                                │
│  • 每 60 秒查詢任務   │  • 監控 results/ 目錄                      │
│  • 建立 task 檔案     │  • 解析 Claude 輸出                        │
│  • 支援 cron 排程     │  • 寫入 Supabase                          │
└──────────┬───────────┴─────────────────┬────────────────────────┘
           │ tasks/*.md                   │ results/*_result.md
           ▼                              ▲
┌─────────────────────────────────────────────────────────────────┐
│                    Claude PM + Claude CLI                        │
│  claude -p "..." --output results/                               │
│  • 執行 AI 搜尋任務                                               │
│  • 輸出結構化 JSON 結果                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 核心元件

### 1. Supabase Edge Functions

#### `ai-search`
觸發 AI 搜尋任務，建立 `ai_prompts` 記錄。

**端點:** `POST /functions/v1/ai-search`

**請求參數:**
```typescript
{
  election_year: number;      // 選舉年份 (e.g., 2026)
  region?: string;            // 地區 (e.g., "台北市")
  position?: string;          // 職位 (e.g., "縣市長")
  search_query?: string;      // 自訂搜尋內容
}
```

**回應:**
```typescript
{
  success: boolean;
  prompt_id: string;          // UUID，用於輪詢狀態
  message: string;
}
```

#### `ai-prompt-status`
查詢任務狀態與結果。

**端點:** `POST /functions/v1/ai-prompt-status`

**請求參數:**
```typescript
{
  prompt_id: string;          // 任務 UUID
}
```

**回應:**
```typescript
{
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result_data?: {
    candidates: Candidate[];
    summary: string;
    sources: string[];
  };
  error_message?: string;
  completed_at?: string;
}
```

---

### 2. ai_prompts 資料表

儲存所有 AI 任務的佇列與結果。

```sql
CREATE TABLE ai_prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 任務類型
    task_type TEXT NOT NULL CHECK (task_type IN (
        'candidate_search',
        'policy_search',
        'policy_verify',
        'progress_tracking'
    )),

    -- Prompt 內容
    prompt_template TEXT NOT NULL,
    parameters JSONB DEFAULT '{}',

    -- 狀態追蹤
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'scheduled', 'processing', 'completed', 'failed'
    )),
    priority INTEGER DEFAULT 5,

    -- 執行追蹤
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    -- 結果儲存
    result_summary TEXT,
    result_data JSONB,
    confidence DECIMAL(3, 2),
    error_message TEXT,

    -- 範圍篩選
    election_id INTEGER REFERENCES elections(id),
    region TEXT,

    -- 中繼資料
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### 3. Python 服務 (policy-ai)

位於 GCP 伺服器，由 PM2 管理。

#### 專案結構

```
/home/cwen0/projects/policy-ai/
├── config/
│   ├── __init__.py
│   └── settings.py           # 環境變數與常數
├── core/
│   ├── __init__.py
│   ├── poller.py             # 輪詢 ai_prompts 表
│   └── parser.py             # 解析 Claude 結果
├── db/
│   ├── __init__.py
│   └── supabase_client.py    # Supabase 客戶端
├── models/
│   ├── __init__.py
│   └── models.py             # Pydantic 模型
├── tasks/                    # Claude 輸入檔案
├── results/                  # Claude 輸出檔案
├── .env                      # 環境變數
├── requirements.txt
└── ecosystem.config.js       # PM2 設定
```

#### poller.py

每 60 秒查詢 `ai_prompts` 表中 `status='pending'` 的任務：

```python
class Poller:
    async def _poll_cycle(self):
        # 1. 查詢待處理任務
        prompts = self.db.get_pending_prompts()

        # 2. 建立 task 檔案
        for prompt in prompts:
            task_file = self._create_task_file(prompt)

            # 3. 更新狀態為 processing
            self.db.update_prompt_status(prompt['id'], 'processing')
```

#### parser.py

使用 Watchdog 監控 `results/` 目錄：

```python
class Parser:
    async def process_result_file(self, file_path):
        # 1. 讀取結果檔案
        content = file_path.read_text()

        # 2. 提取 prompt_id (從 ## Task ID 區塊)
        prompt_id = self._extract_prompt_id(file_path.name, content)

        # 3. 解析 JSON 結果
        result = self._extract_json(content)

        # 4. 處理候選人資料
        if task_type == 'candidate_search':
            await self._handle_candidate_search(prompt_id, result)

        # 5. 更新 ai_prompts 狀態
        self.db.save_prompt_result(prompt_id, result)
```

---

### 4. Claude PM

Claude PM 監控 `tasks/` 目錄，當新檔案出現時自動執行 Claude CLI。

**配置檔案:** `/home/cwen0/Claude-PM/config.yaml`

```yaml
projects:
  - name: policy-ai
    path: /home/cwen0/projects/policy-ai
    task_dir: tasks
    result_dir: results
    done_dir: done
    claude_args:
      - "--dangerously-skip-permissions"
```

---

## 任務流程

### 候選人搜尋流程

```
1. 使用者在 AdminAI.vue 點擊「搜尋候選人」
   ↓
2. 呼叫 ai-search Edge Function
   ↓
3. 建立 ai_prompts 記錄 (status: pending)
   ↓
4. 回傳 prompt_id，前端開始輪詢
   ↓
5. poller.py 偵測到新任務
   ↓
6. 建立 tasks/task_YYYYMMDD_HHMMSS_XXXXXXXX.md
   ↓
7. 更新狀態為 processing
   ↓
8. Claude PM 偵測到新檔案，執行 Claude CLI
   ↓
9. Claude 輸出結果到 results/task_..._result.md
   ↓
10. parser.py 偵測到結果檔案
    ↓
11. 解析 JSON，匯入 politicians 表
    ↓
12. 更新 ai_prompts 狀態為 completed
    ↓
13. 前端輪詢取得結果，顯示候選人清單
```

---

## 前端整合

### AdminAI.vue

提供四個 Tab：

1. **搜尋** - 觸發新的 AI 搜尋任務
2. **更新** - 批次更新政見資料
3. **日誌** - 查看 AI 使用紀錄
4. **搜尋歷史** - 查看過往任務與結果

```typescript
// 觸發搜尋
const searchCandidates = async () => {
  const { prompt_id } = await triggerSearch(params);

  // 輪詢等待結果
  const result = await pollForResult(prompt_id, {
    interval: 5000,   // 每 5 秒
    timeout: 300000,  // 最長 5 分鐘
  });

  searchResults.value = result.candidates;
};

// 查看歷史結果
const viewPromptResult = async (prompt: any) => {
  if (prompt.status === 'completed') {
    searchResults.value = prompt.result_data.candidates;
  }
};
```

---

## 部署指令

### GCP 服務

```bash
# SSH 連線
gcloud compute ssh claude-pm-server --zone=asia-east1-b

# 啟動服務
cd /home/cwen0/projects/policy-ai
pm2 start ecosystem.config.js

# 查看日誌
pm2 logs policy-ai-poller
pm2 logs policy-ai-parser
```

### Edge Functions

```bash
# 部署 ai-search
npx supabase functions deploy ai-search

# 部署 ai-prompt-status
npx supabase functions deploy ai-prompt-status
```

### 前端

```bash
pnpm build
npx firebase deploy --only hosting
```

---

## 環境變數

### policy-ai/.env

```
SUPABASE_URL=https://wiiqoaytpqvegtknlbue.supabase.co
SUPABASE_SERVICE_KEY=<service_role_key>
RESULTS_DIR=./results
TASKS_DIR=./tasks
LOG_LEVEL=INFO
```

---

## 錯誤處理

| 錯誤情境 | 處理方式 |
|---------|---------|
| Claude 執行超時 | 前端顯示超時訊息，可從歷史 Tab 查看後續結果 |
| JSON 解析失敗 | 記錄錯誤到 ai_prompts.error_message |
| 候選人名稱無效 | 跳過無效資料，只匯入有效候選人 |
| 資料庫寫入失敗 | 重試 3 次後標記為 failed |

---

## 相關檔案

| 用途 | 路徑 |
|------|------|
| 前端 AI 管理頁 | `pages/AdminAI.vue` |
| 觸發 Edge Function | `supabase/functions/ai-search/index.ts` |
| 狀態查詢 Function | `supabase/functions/ai-prompt-status/index.ts` |
| 資料表 Migration | `supabase/migrations/20260202100001_ai_prompts.sql` |
| Python Poller | `policy-ai/core/poller.py` |
| Python Parser | `policy-ai/core/parser.py` |
| PM2 配置 | `policy-ai/ecosystem.config.js` |
