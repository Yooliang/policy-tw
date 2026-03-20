# Policy Verifier（政見驗證）

## 重要：直接開始工作
- **不要**探索專案結構、讀取程式碼、查詢 DB schema
- **不要**搜尋 API key — 下方已提供所有必要資訊
- 直接按照步驟執行
- **每次最多驗證 3 條政見**，驗證完就結束

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

### 驗證結果
- **verified**：有可靠來源證實
- **partially_verified**：部分內容可證實
- **unverified**：無法找到證據
- **false**：內容與事實不符

### 政見狀態更新
Achieved（已完成）、In Progress（進行中）、Stalled（停滯）、Failed（失敗）

---

## 執行步驟

### 步驟 1：查詢現有政見

```json
{"api_key":"","action":"query_policies","politician_name":"<姓名>","keywords":["<政見關鍵字>"]}
```

確認找到要驗證的政見，記下 policy_id。

### 步驟 2：搜尋驗證證據

搜尋來源：政府公報 → 第三方查核 → 主流媒體 → 當事人聲明

### 步驟 3：更新政見狀態（若驗證發現狀態應改變）

```json
{"api_key":"","action":"update_policy","prompt_id":"<TASK_ID>","politician_name":"姓名","policy_title":"政見標題","new_status":"Achieved","progress_note":"驗證結果：已於2026年1月完成"}
```

### 步驟 4：新增驗證紀錄

```json
{"api_key":"","action":"add_tracking_log","prompt_id":"<TASK_ID>","politician_name":"姓名","policy_title":"政見標題","log":{"status":"Achieved","content":"【驗證報告】經查證，此政見已於...完成。證據：...","source_url":"驗證來源","date":"2026-02-01"}}
```

### 步驟 5：完成任務

```json
{"api_key":"","action":"update_prompt","prompt_id":"<TASK_ID>","status":"completed","result_summary":"驗證完成：verified/partially_verified/unverified","result_data":{"verification_result":"verified","evidence_count":0}}
```

## 注意事項
1. **先查詢**：確認政見存在於資料庫才進行驗證
2. **證據必須**：驗證必須有具體證據，不能臆測
3. **紀錄格式**：【驗證報告】+ 結論 + 證據說明
4. **無法驗證**：標記為 unverified，不要猜測
5. **來源說明**：紀錄中要說明驗證方法和證據來源
