# Progress Tracker（政見進度追蹤）

## 重要：直接開始工作
- **不要**探索專案結構、讀取程式碼、查詢 DB schema
- **不要**搜尋 API key — 下方已提供所有必要資訊
- 直接按照步驟執行
- **每次最多追蹤 5 條政見進度**，追蹤完就結束

## API 設定

所有 API 呼叫使用以下設定：

```bash
API_URL="https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/ai-action"
AUTH="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpaXFvYXl0cHF2ZWd0a25sYnVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1OTA5MjQsImV4cCI6MjA4NTE2NjkyNH0.2YYUBQd4t3HBP6bjO8LDo-SR4pRpcYl4iTCbz1MCRMc"
API_KEY="__POLICY_AI_KEY__"
```

呼叫格式：
```bash
curl -s -X POST "$API_URL"   -H "Content-Type: application/json"   -H "Authorization: $AUTH"   -d '{...}'
```

### 關於 TASK_ID
- 如果卡片內容中有提供 `prompt_id`，使用該值
- 否則填 `null`

---

## 專業知識

### 政見狀態
- **Proposed**：已提出
- **In Progress**：進行中（已開始執行）
- **Achieved**：已實現（目標達成）
- **Stalled**：停滯（遇到阻礙）
- **Failed**：失敗（確定無法達成）

### 進度評估標準
- 已實現：有具體成果、達成承諾目標
- 進行中：有預算編列、工程開工、政策推動中
- 停滯：超過預期時間未有進展
- 失敗：明確宣布取消、無法執行

---

## 執行步驟

### 步驟 1：查詢現有政見

```json
{"api_key":"","action":"query_policies","politician_name":"<姓名>","keywords":["<政見關鍵字>"]}
```

確認找到要追蹤的政見，記下 policy_id 和目前狀態。

### 步驟 2：搜尋最新進度

搜尋來源：政府公告 → 議會記錄 → 新聞報導 → 民間監督報告

### 步驟 3：更新政見狀態

```json
{"api_key":"","action":"update_policy","prompt_id":"<TASK_ID>","politician_name":"姓名","policy_title":"政見標題關鍵字","new_status":"In Progress","progress_note":"最新進度說明"}
```

### 步驟 4：新增追蹤紀錄

```json
{"api_key":"","action":"add_tracking_log","prompt_id":"<TASK_ID>","politician_name":"姓名","policy_title":"政見標題關鍵字","log":{"status":"In Progress","content":"進度內容說明","source_url":"新聞來源","date":"2026-02-01"}}
```

### 步驟 5：完成任務

```json
{"api_key":"","action":"update_prompt","prompt_id":"<TASK_ID>","status":"completed","result_summary":"更新 X 條政見進度","result_data":{"updated_count":0}}
```

## 注意事項
1. **先查詢**：確認政見存在於資料庫才進行追蹤
2. **來源佐證**：每次更新需有新聞來源
3. **具體說明**：進度說明要具體（日期、數字、事實）
4. **客觀陳述**：避免主觀評論，以事實為依據
