# Data Reviewer（資料品質檢查）

## 重要：直接開始工作
- **不要**探索專案結構、讀取程式碼、查詢 DB schema
- **不要**搜尋 API key — 下方已提供所有必要資訊
- 直接按照步驟執行
- **每次最多處理 10 個問題項目**，處理完就結束
- **TARGET_DATE 預設使用今天的日期（UTC）**

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

### 檢查項目嚴重程度
| 等級 | 問題類型 | 說明 |
|------|---------|------|
| critical | 重複資料 | 同一人多筆記錄 |
| critical | 資料衝突 | 同一人在不同地區有記錄 |
| warning | 缺少重要欄位 | bio、education 為空 |
| info | 缺少非必要欄位 | avatar_url 為空 |
| info | 政見描述過短 | description 少於 10 字 |
| info | 資料來源連結失效 | URL 回應 404 |

### 政黨名稱
中國國民黨、民主進步黨、台灣民眾黨、時代力量、台灣基進、無黨籍

---

## 執行步驟

### 步驟 1：取得資料品質問題清單

```json
{"api_key":"","action":"query_data_quality","target_date":"2026-03-14"}
```

記下回應中的各類問題清單。

### 步驟 2：分析問題嚴重程度

- **critical**：`duplicate_candidates`（同名重複）、`cross_region`（跨地區衝突）
- **warning**：`incomplete_candidates` 中缺少 bio/education 的
- **info**：只缺 avatar_url、`short_policies`、`urls_to_check`

### 步驟 3：處理 incomplete_candidates（缺少 bio/education）

用網路搜尋候選人基本資料，找到可靠來源後用 `update_politician` 補完：

```json
{"api_key":"","action":"update_politician","prompt_id":"<TASK_ID>","politician_id":"<ID>","politician_name":"<NAME>","updates":{"bio":"個人簡介","education":["學歷1","學歷2"]}}
```

**重要**：只使用有明確來源的資料，不要編造。找不到就標記「無法自動補完」。

### 步驟 4：處理 duplicate_candidates（僅預覽）

```json
{"api_key":"","action":"deduplicate_candidates","election_year":2026,"dry_run":true}
```

**`dry_run` 必須為 `true`**，只預覽不刪除！

### 步驟 5：驗證 urls_to_check

```bash
curl -sI "<URL>" -o /dev/null -w "%{http_code}"
```

記錄回應碼不是 200 的 URL。

### 步驟 6：完成任務

```json
{"api_key":"","action":"update_prompt","prompt_id":"<TASK_ID>","status":"completed","result_summary":"資料品質檢查完成：檢查 X 項，發現 Y 個問題，修正 Z 個","result_data":{"total_checked":0,"issues_found":0,"issues_fixed":0,"details":{"incomplete_candidates":{"found":0,"fixed":0},"short_policies":{"found":0},"duplicate_candidates":{"found":0},"broken_urls":{"found":0},"cross_region":{"found":0}},"unfixed_issues":[]}}
```

## 注意事項
1. **不要刪除資料**：只標記問題或補完缺失欄位
2. **補完資料需有來源**：不要編造
3. **重複資料只預覽**：`dry_run: true`
4. **跨地區問題只回報**：不自動修正
5. **result_data 完整**：確保包含所有檢查項目的統計數據
