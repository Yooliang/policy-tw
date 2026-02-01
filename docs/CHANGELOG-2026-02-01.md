# 開發進度記錄 - 2026-02-01

## 本次更新摘要

針對 AI 系統進行了重大改進，解決了資料重複、品質控制和自動化排程的問題。

---

## 已完成的功能

### 1. 資料驗證機制

#### 查詢先行 API
新增兩個查詢 API，讓 Claude 在新增資料前先檢查是否重複：

| API Action | 用途 |
|------------|------|
| `query_candidates` | 查詢現有候選人 |
| `query_policies` | 查詢現有政見 |

**修改檔案**：`supabase/functions/ai-action/index.ts`

#### 信心度門檻
`import_candidate` 現在需要 `confidence` 欄位：
- confidence >= 0.7：允許匯入
- confidence < 0.7：跳過，僅記錄

**信心度評估標準**：
| 分數 | 來源可信度 |
|------|-----------|
| 0.9-1.0 | 官方登記、中選會公告 |
| 0.8-0.9 | 候選人正式宣布、黨提名確定 |
| 0.7-0.8 | 多家主流媒體報導確認 |
| 0.5-0.7 | 單一來源報導（不匯入）|
| 0.0-0.5 | 傳聞、推測（不匯入）|

---

### 2. 搜尋日期限制

在技能檔案中加入搜尋日期限制，避免使用過時資訊：

```markdown
## 搜尋日期限制

**重要**：只搜尋最近 30 天的新聞資料，避免使用過時資訊。

搜尋技巧：
1. Google 搜尋加入時間過濾：`2026年台北市長候選人 after:2026-01-01`
2. 排除明顯過時的資訊（如：2022 年選舉結果）
3. 優先使用最近一週的新聞來源
4. 在匯入時記錄新聞發布日期

若搜尋結果都是舊資料，回報「無最新消息」並完成任務。
```

**修改檔案**：
- `policy-ai-skills/taiwan-election-expert.md`
- `policy-ai-skills/policy-researcher.md`
- `policy-ai-skills/policy-verifier.md`
- `policy-ai-skills/progress-tracker.md`

---

### 3. 自動化排程系統

建立 `ai-scheduler` Edge Function，支援每日自動排程：

**週排程**：
```
週一：六都（台北、新北、桃園、台中、台南、高雄）
週二：北部（基隆、新竹市、新竹縣、苗栗、宜蘭）
週三：中部（彰化、南投、雲林、嘉義市、嘉義縣）
週四：南部東部（屏東、花蓮、台東、澎湖）
週五：離島（金門、連江）
週六日：休息
```

**使用方式**：
```bash
# 按週排程（自動判斷今天）
curl -X POST "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/ai-scheduler"

# 手動指定縣市
curl -X POST "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/ai-scheduler" \
  -d '{"mode":"manual","regions":["台北市","新北市"]}'

# 所有縣市
curl -X POST "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/ai-scheduler" \
  -d '{"mode":"all"}'
```

**新增檔案**：`supabase/functions/ai-scheduler/index.ts`

---

### 4. 技能檔案更新

所有技能檔案都加入了「先查詢再新增」的步驟：

| 檔案 | 更新內容 |
|------|---------|
| `taiwan-election-expert.md` | 查詢先行、信心度評估、日期限制 |
| `policy-researcher.md` | 查詢先行、重複判斷標準 |
| `policy-verifier.md` | 查詢先行、驗證步驟 |
| `progress-tracker.md` | 查詢先行、進度追蹤步驟 |
| `task_manager.py` | 更新所有提示詞模板 |

---

### 5. 架構文件更新

更新 `docs/AI-ARCHITECTURE.md`，包含：
- 完整系統架構圖
- 資料驗證機制說明
- 潛在問題與解決方案
- 自動化排程設計
- 日期限制設計
- 部署與監控指令

---

## 已部署的 Edge Functions

| 函數名稱 | 狀態 | 用途 |
|---------|------|------|
| `ai-action` | ✅ 已部署 | 統一 AI API（含查詢功能） |
| `ai-scheduler` | ✅ 已部署 | 自動化排程 |

---

## 修改的檔案清單

### Supabase Edge Functions
- `supabase/functions/ai-action/index.ts` - 新增 query_candidates, query_policies, 信心度檢查
- `supabase/functions/ai-scheduler/index.ts` - 新建，自動化排程

### 技能檔案
- `policy-ai-skills/taiwan-election-expert.md` - 查詢先行、信心度、日期限制
- `policy-ai-skills/policy-researcher.md` - 查詢先行
- `policy-ai-skills/policy-verifier.md` - 查詢先行
- `policy-ai-skills/progress-tracker.md` - 查詢先行
- `policy-ai-skills/task_manager.py` - 更新所有提示詞模板

### 文件
- `docs/AI-ARCHITECTURE.md` - 完整架構更新
- `docs/CHANGELOG-2026-02-01.md` - 本文件

---

## 待完成項目

### 優先順序 1：設定 Cron 自動觸發
- [ ] 使用 GCP Cloud Scheduler 或 Supabase pg_cron
- [ ] 每日凌晨自動觸發 ai-scheduler

### 優先順序 2：同步到 GCP
- [ ] 上傳技能檔案到 GCP
- [ ] 重啟 Claude PM 服務

```bash
# 同步技能檔案
gcloud compute scp policy-ai-skills/*.md \
  claude-pm-server:/home/cwen0/projects/policy-ai/skills/ \
  --zone=us-central1-a

gcloud compute scp policy-ai-skills/task_manager.py \
  claude-pm-server:/home/cwen0/projects/policy-ai/ \
  --zone=us-central1-a
```

### 優先順序 3：監控告警
- [ ] 設定 PM2 自動重啟
- [ ] 建立每日執行報告
- [ ] 設定失敗任務告警

### 優先順序 4：測試驗證
- [ ] 測試 query_candidates API
- [ ] 測試 query_policies API
- [ ] 測試信心度門檻
- [ ] 測試排程功能

---

## API 變更摘要

### ai-action 新增的 Actions

#### query_candidates
```json
{
  "api_key": "policy-ai-2026",
  "action": "query_candidates",
  "election_year": 2026,
  "region": "台北市",
  "position": "縣市長"
}
```

回應：
```json
{
  "success": true,
  "count": 3,
  "candidates": [
    {"id": 1, "name": "王小明", "party": "民主進步黨", ...}
  ],
  "message": "找到 3 位現有候選人"
}
```

#### query_policies
```json
{
  "api_key": "policy-ai-2026",
  "action": "query_policies",
  "politician_name": "蔣萬安",
  "keywords": ["捷運"]
}
```

回應：
```json
{
  "success": true,
  "count": 5,
  "policies": [
    {"id": 1, "title": "捷運綠線", "category": "交通", ...}
  ],
  "message": "找到 5 條現有政見"
}
```

### import_candidate 變更

新增必要欄位：
- `confidence`: 信心度（0.0-1.0），必須 >= 0.7 才會被匯入
- `source_date`: 新聞發布日期（建議提供）

```json
{
  "api_key": "policy-ai-2026",
  "action": "import_candidate",
  "prompt_id": "xxx",
  "election_year": 2026,
  "candidate": {
    "name": "王小明",
    "party": "民主進步黨",
    "position": "縣市長",
    "region": "台北市",
    "status": "confirmed",
    "confidence": 0.85,
    "source_date": "2026-01-15"
  }
}
```

---

## 備註

- 所有 Edge Functions 已部署到 Supabase
- 技能檔案需要手動同步到 GCP
- 建議先測試單一縣市的排程功能再啟用全自動
