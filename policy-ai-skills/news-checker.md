# News Checker（新聞追蹤）

## 重要：直接開始工作
- **不要**探索專案結構、讀取程式碼、查詢 DB schema
- **不要**搜尋 API key — 下方已提供所有必要資訊
- 直接按照步驟執行
- **每次最多處理 10 則新聞**，處理完就結束
- **搜尋最多 3 輪關鍵字就停止**

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

### 新聞來源優先順序
1. 中央通訊社（cna.com.tw）
2. 聯合新聞網、自由時報、中時新聞網
3. ETtoday、TVBS、三立新聞
4. 各縣市政府新聞稿、立法院公報

### 新聞分類與處理
| 分類 | API 動作 |
|------|---------|
| 候選人動態（參選/退選/提名） | import_candidate / update_politician |
| 政見發表 | add_policy |
| 政見進度 | update_policy + add_tracking_log |
| 選舉制度 | 記錄於摘要，不呼叫 API |

### 信心度（候選人匯入用）
0.9-1.0 官方登記、0.8-0.9 正式宣布、0.7-0.8 多家媒體確認、< 0.7 不匯入

---

## 執行步驟

### 步驟 1：掌握資料庫現狀

查詢候選人：
```json
{"api_key":"","action":"query_candidates","election_year":2026}
```

查詢主要政治人物政見：
```json
{"api_key":"","action":"query_policies","politician_name":"<姓名>"}
```

### 步驟 2：搜尋最新新聞（最多 3 輪）

關鍵字範例：`2026選舉 候選人`、`2026 縣市長 參選`、`政見 發表 2026`

限制：只納入過去 24 小時新聞、排除 2022 年或更早資訊、去除重複報導。

### 步驟 3：逐則分析與更新（最多 10 則）

**A. 新候選人**（confidence >= 0.7）：
```json
{"api_key":"","action":"import_candidate","prompt_id":"<TASK_ID>","election_year":2026,"candidate":{"name":"姓名","party":"政黨","position":"縣市長","region":"台北市","status":"confirmed","confidence":0.85,"source_date":"2026-02-28"}}
```

**B. 新政見**：
```json
{"api_key":"","action":"add_policy","prompt_id":"<TASK_ID>","politician_name":"姓名","policy":{"title":"政見標題（20字以內）","description":"詳細說明","category":"交通","source_url":"https://..."}}
```

新增後記錄來源：
```json
{"api_key":"","action":"add_policy_source","policy_id":"<POLICY_ID>","sources":[{"url":"https://...","title":"新聞標題","source_name":"媒體名稱","published_date":"2026-03-01"}]}
```

**C. 政見進度更新**：
```json
{"api_key":"","action":"update_policy","politician_name":"姓名","policy_title":"政見標題","new_status":"in_progress","progress_note":"最新進展說明"}
```

追蹤紀錄：
```json
{"api_key":"","action":"add_tracking_log","politician_name":"姓名","policy_title":"政見標題","log":{"status":"in_progress","content":"進度說明","source_url":"https://...","date":"2026-02-28"}}
```

**D. 候選人資料更新**（退選、轉換選區等）：
```json
{"api_key":"","action":"update_politician","politician_name":"姓名","bio":"更新的簡介"}
```

### 步驟 4：完成任務

```json
{"api_key":"","action":"update_prompt","prompt_id":"<TASK_ID>","status":"completed","result_summary":"檢查 X 則新聞，新增 Y 位候選人、Z 條政見","result_data":{"total_news_found":0,"relevant_count":0,"actions_taken":{"import_candidate":0,"add_policy":0,"update_policy":0,"add_tracking_log":0},"news_summary":[],"sources":[]}}
```

## 注意事項
1. **先查詢再新增**：避免重複
2. **信心度門檻**：候選人 confidence >= 0.7
3. **每個更新附新聞來源 URL**：沒有來源就不新增
4. **政黨名稱**：使用完整正式名稱（中國國民黨、民主進步黨等）
5. **只處理 24 小時內新聞**
6. **去重**：同一事件多家媒體報導只處理一次
