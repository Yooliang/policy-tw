# AI 系統狀態記錄

> 最後更新: 2026-02-03 10:30 (UTC+8)

## 已完成的修改

### Claude-PM (已推送到 GitHub)

1. **executor.py** - 使用 `--output-format json`，輸出 `_result.json` 而非 `_result.md`
2. **utils.py** - 保留 `format_result_document`（含 usage 資訊）但目前未使用
3. **policy-ai/parser.py** - 直接讀取 JSON，解析 usage 存入 `ai_prompts.result_data`
4. **policy-ai/poller.py** - 狀態 `running` → `processing`

### GCP 狀態

- `/home/cwen0/Claude-PM/config.yaml` 已用 `config.gcp.yaml` 覆蓋（Linux 路徑）
- Claude PM 正確監控 `/home/cwen0/projects/policy-ai/tasks`
- GCP 有兩個 Claude-PM 位置:
  - Git Repo: `/home/cwen0/repos/Claude-PM/`
  - 運行位置: `/home/cwen0/Claude-PM/`

## 待確認

- [ ] 兩個 politician_update 任務 (`f06b8891...`, `e4641ac8...`) 完成後，檢查 `result_data.usage` 是否有 token 資訊

## 服務狀態

| 服務 | 狀態 | 說明 |
|------|------|------|
| policy-ai-poller | 運行中 | 輪詢 `ai_prompts` 表，建立任務檔案 |
| policy-ai-parser | 運行中 | 監控 `_result.json`，更新資料庫 |
| claude-pm | 運行中 | 執行 Claude CLI 任務 |

## 架構流程

```
網頁發送任務 → ai_prompts (pending)
    ↓
poller.py → 建立任務檔案 → ai_prompts (processing)
    ↓
Claude PM executor → 執行 Claude CLI (--output-format json) → _result.json
    ↓
parser.py → 讀取 JSON → ai_prompts (completed + result_data.usage)
```

## JSON 結果檔案結構

```json
{
  "source_file": "tasks/prompt_xxx.md",
  "execution_time": "2026-02-03T01:30:00",
  "status": "success",
  "duration_seconds": 28.5,
  "output": "Claude 的回應內容...",
  "error": null,
  "original_task": "原始任務內容...",
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_read_input_tokens": 14180,
    "cache_creation_input_tokens": 9030,
    "total_cost_usd": 0.064142,
    "model": "claude-opus-4-5-20251101",
    "session_id": "xxx"
  }
}
```

## result_data 儲存結構

存入 `ai_prompts.result_data` JSONB 欄位:

```json
{
  "duration_ms": 28500,
  "api_calls_count": 2,
  "api_calls_success": 2,
  "executed_at": "2026-02-03T01:30:00Z",
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_read_input_tokens": 14180,
    "cache_creation_input_tokens": 9030,
    "total_cost_usd": 0.064142,
    "model": "claude-opus-4-5-20251101"
  }
}
```

## 相關檔案位置

### 本地 (Windows)
- `D:\Github\Claude-PM\claude_pm\executor.py`
- `D:\Github\Claude-PM\claude_pm\utils.py`
- `D:\Github\Claude-PM\policy-ai\parser.py`
- `D:\Github\Claude-PM\policy-ai\poller.py`
- `D:\Github\Claude-PM\config.gcp.yaml` (GCP 專用設定)

### GCP
- `/home/cwen0/Claude-PM/` - 運行位置
- `/home/cwen0/repos/Claude-PM/` - Git 同步位置
- `/home/cwen0/projects/policy-ai/` - policy-ai 專案目錄
- `/home/cwen0/projects/policy-ai/tasks/` - 任務檔案目錄
- `/home/cwen0/projects/policy-ai/results/` - 結果檔案目錄
