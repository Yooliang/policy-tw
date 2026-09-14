> **歷史文件（2026-02）**：描述的是 Claude-PM／`ai_prompts` 輪詢與管理頁架構，已被外部貢獻協議（`public/skill.md`、`CONTRIBUTIONS-ADMIN.md`）與 `BLUEPRINT-admin-to-tasks.md` 取代。保留供查歷史脈絡，不代表現況。

# 管理頁面功能分析報告

## 現有管理頁面

| 頁面 | 路由 | 主要功能 |
|------|------|----------|
| AdminAI.vue | /admin/ai | AI 候選人搜尋、政見更新、任務歷史 |
| AdminDuplicates.vue | /admin/duplicates | 重複政治人物偵測與合併 |
| AdminImport.vue | /admin/import | Excel 檔案匯入候選人 |
| AdminScraper.vue | /admin/scraper | 中選會 API 抓取候選人 |

---

## 詳細功能分析

### 1. AdminAI.vue (AI 管理)

**四個 Tab：**

| Tab | 功能 | 調用的 Edge Function |
|-----|------|---------------------|
| 搜尋 | Claude AI 搜尋候選人 | ai-search, ai-prompt-status |
| 更新 | 更新政見執行進度 | ai-update-progress |
| 歷史 | 查看過往搜尋任務 | 直接查詢 ai_prompts |
| 日誌 | 查看 AI 使用紀錄 | 直接查詢 ai_usage_logs |

**特色功能：**
- 自動批次模式：一鍵搜尋 22 縣市
- 輪詢機制：5秒間隔，5分鐘超時
- 逐個或批量匯入候選人

### 2. AdminDuplicates.vue (重複資料清理)

**功能：**
- 偵測同名政治人物
- 中選會官方資料核對
- 自動合併重複項

**調用的 Edge Function：**
- fetch-cec-data
- merge-politicians
- update-politician

### 3. AdminImport.vue (Excel 匯入)

**功能：**
- 解析中選會 Excel 檔案
- 預覽並選擇要匯入的資料
- 批次匯入（100筆/批）

**調用的 Edge Function：**
- batch-import-candidates

### 4. AdminScraper.vue (中選會抓取)

**功能：**
- 直接呼叫中選會 API
- 22縣市 × 8選舉類型 矩陣抓取
- 選舉區對應表建立
- LocalStorage 進度持久化

**調用的 Edge Function：**
- add-politician

---

## 🔴 功能重複問題

### 問題 1: 候選人匯入有三種方式

| 方式 | 頁面 | 資料來源 | 優缺點 |
|------|------|----------|--------|
| AI 搜尋 | AdminAI | 網路新聞 | 可找到未宣布的候選人，但需驗證 |
| Excel 匯入 | AdminImport | 中選會檔案 | 官方資料但需手動下載 |
| API 抓取 | AdminScraper | 中選會 API | 自動化但僅限已登記 |

**建議：** 統一為 API 優先，AI 補充未登記人選

### 問題 2: 無效名稱過濾重複實作

AdminAI 和 AdminScraper 都有相同的過濾邏輯：
```javascript
const invalidPatterns = ['未定', '待定', '待確認', '尚待確認', '未知', '人選', '其他', '待公布']
```

**建議：** 抽取為共用工具函數

### 問題 3: 進度管理不一致

| 頁面 | 進度儲存方式 |
|------|-------------|
| AdminScraper | LocalStorage（可續接） |
| AdminImport | 臨時 UI 狀態（重新整理丟失） |
| AdminAI | ai_prompts 表（永久） |

**建議：** 統一使用 ai_prompts 或 LocalStorage

### 問題 4: 中選會資料使用分散

| 頁面 | 中選會資料用途 |
|------|---------------|
| AdminDuplicates | 驗證身份 |
| AdminScraper | 抓取候選人 |
| AdminImport | 解析結果檔 |

**建議：** 建立統一的中選會資料服務層

---

## 📊 Edge Functions 使用分布

```
ai-search ─────────────► AdminAI
ai-prompt-status ──────► AdminAI
ai-update-progress ────► AdminAI
import-candidate ──────► AdminAI
batch-import-candidates ► AdminImport
add-politician ────────► AdminScraper
fetch-cec-data ────────► AdminDuplicates
merge-politicians ─────► AdminDuplicates
update-politician ─────► AdminDuplicates
```

---

## 💡 重構建議

### 建議 1: 統一資料匯入入口

建立 `AdminDataHub.vue`：
- Tab 1: 自動抓取（中選會 API）
- Tab 2: AI 搜尋（補充未登記）
- Tab 3: 手動匯入（Excel）
- Tab 4: 資料驗證（重複/核對）

### 建議 2: 共用元件抽取

```
components/admin/
├── CandidateTable.vue      # 候選人表格（含選擇、匯入）
├── ProgressTracker.vue     # 進度追蹤元件
├── TaskHistory.vue         # 任務歷史清單
└── CecVerifier.vue         # 中選會資料驗證
```

### 建議 3: 服務層抽取

```typescript
// services/candidateService.ts
export const candidateService = {
  validateName(name: string): boolean
  importSingle(candidate: Candidate): Promise<Result>
  importBatch(candidates: Candidate[]): Promise<BatchResult>
  checkDuplicate(name: string, region: string): Promise<Politician[]>
}

// services/cecService.ts
export const cecService = {
  fetchCandidates(year: number, type: string, region: string): Promise<Candidate[]>
  fetchElectoralDistricts(year: number, region: string): Promise<District[]>
  verifyIdentity(name: string, birthYear: number): Promise<CecRecord>
}
```

---

## 現有 AI 功能架構

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend                              │
├─────────────────┬─────────────────┬─────────────────────┤
│   AdminAI.vue   │ VerifyContent   │   (未來) AIChat     │
│   (管理員)      │   (公民驗證)     │   (通用對話)        │
└────────┬────────┴────────┬────────┴──────────┬──────────┘
         │                 │                   │
         ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────────┐
│              Supabase Edge Functions                     │
├─────────────────┬─────────────────┬─────────────────────┤
│   ai-search     │   ai-verify     │   ai-classify       │
│   (Claude)      │   (Gemini)      │   (新增: 分類)      │
└────────┬────────┴────────┬────────┴──────────┬──────────┘
         │                 │                   │
         ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────────┐
│                   ai_prompts 表                          │
│   task_type: candidate_search | policy_search |          │
│              policy_verify | progress_tracking |         │
│              user_contribution (新增)                    │
└─────────────────────────────────────────────────────────┘
```

---

## 下一步行動

1. ✅ 建立資料庫結構文件
2. ✅ 建立管理頁面分析文件
3. ⏳ 設計通用 AI 對話頁面
4. ⏳ 設計任務分類路由邏輯
5. ⏳ 整合現有架構
