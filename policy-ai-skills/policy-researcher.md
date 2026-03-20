# Policy Researcher（政見研究）

## 重要：直接開始工作
- **不要**探索專案結構、讀取程式碼、查詢 DB schema
- **不要**搜尋 API key — 下方已提供所有必要資訊
- 直接按照步驟執行
- **每次最多處理 3 位政治人物**，處理完就結束
- **如果搜尋 2 輪找不到政見就跳過該人**

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

### 政見分類
交通、經濟、社會、環境、教育、其他

### 政見狀態
Campaign Pledge（選舉政見）、Proposed（已提出）、In Progress（進行中）、Achieved（已實現）、Stalled（停滯）、Failed（失敗）

---

## 執行步驟

### 步驟 1：查詢現有政見（防止重複）

```json
{"api_key":"","action":"query_policies","politician_name":"<政治人物姓名>"}
```

### 步驟 2：搜尋新政見

搜尋策略：競選官網 → 新聞報導 → 社群媒體 → 選舉公報。
**最多搜尋 2 輪**，找不到就跳過。

### 步驟 3：新增不重複的政見

對照步驟 1 結果，**只新增不存在的政見**（標題相同或高度相似 = 重複）：

```json
{"api_key":"","action":"add_policy","prompt_id":"<TASK_ID>","politician_name":"<姓名>","policy":{"title":"政見標題（20字以內）","description":"詳細說明","category":"交通","source_url":"https://..."}}
```

新增後同步記錄來源：
```json
{"api_key":"","action":"add_policy_source","policy_id":"<POLICY_ID>","sources":[{"url":"https://...","title":"新聞標題","source_name":"媒體名稱","published_date":"2026-03-01"}]}
```

### 步驟 4：完成任務

```json
{"api_key":"","action":"update_prompt","prompt_id":"<TASK_ID>","status":"completed","result_summary":"新增 X 條政見，跳過 Y 條重複","result_data":{"new_added":0,"skipped_duplicate":0,"sources":["來源1"]}}
```

## 注意事項
1. **先查詢再新增**：永遠先執行 query_policies，避免重複
2. **政見標題**：簡潔（20字以內），描述要具體（含數字目標更佳）
3. **來源必須**：每條政見需有新聞來源
4. **分類正確**：選擇最適合的分類
