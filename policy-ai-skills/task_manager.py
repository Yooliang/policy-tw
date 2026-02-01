"""
Task file manager for Claude CLI integration.
Creates task files for Claude to process and manages the task lifecycle.
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import UUID

from config import get_settings, get_logger, TaskType

logger = get_logger(__name__)
settings = get_settings()

# API 設定
API_ENDPOINT = "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/ai-action"
API_KEY = "policy-ai-2026"
AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpaXFvYXl0cHF2ZWd0a25sYnVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1OTA5MjQsImV4cCI6MjA4NTE2NjkyNH0.2YYUBQd4t3HBP6bjO8LDo-SR4pRpcYl4iTCbz1MCRMc"


class TaskManager:
    """Manages task files for Claude CLI processing."""

    def __init__(self):
        self.tasks_dir = settings.tasks_dir
        self.results_dir = settings.results_dir
        self.skills_dir = settings.skills_dir
        settings.ensure_directories()

    def create_task_file(
        self,
        prompt_id: str,
        task_type: str,
        prompt_template: str,
        parameters: Dict[str, Any],
    ) -> Path:
        """
        Create a task file for Claude to process.
        """
        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        filename = f"task_{timestamp}_{prompt_id[:8]}.md"
        task_path = self.tasks_dir / filename

        # Get skill file for this task type
        skill_name = self._get_skill_for_task_type(task_type)

        # Build the full prompt with context
        full_prompt = self._build_full_prompt(
            prompt_id=prompt_id,
            task_type=task_type,
            prompt_template=prompt_template,
            parameters=parameters,
        )

        # Write task file
        content = f"""# AI Task: {task_type}

## Task ID
{prompt_id}

## Skill
{skill_name}

## Parameters
```json
{json.dumps(parameters, ensure_ascii=False, indent=2)}
```

## Instructions
{full_prompt}
"""

        task_path.write_text(content, encoding="utf-8")
        logger.info("task_file_created", path=str(task_path), task_type=task_type)
        return task_path

    def _get_skill_for_task_type(self, task_type: str) -> str:
        """Map task type to skill file."""
        skill_map = {
            TaskType.CANDIDATE_SEARCH: "taiwan-election-expert.md",
            TaskType.POLICY_SEARCH: "policy-researcher.md",
            TaskType.POLICY_VERIFY: "policy-verifier.md",
            TaskType.PROGRESS_TRACKING: "progress-tracker.md",
        }
        return skill_map.get(task_type, "taiwan-election-expert.md")

    def _build_full_prompt(
        self,
        prompt_id: str,
        task_type: str,
        prompt_template: str,
        parameters: Dict[str, Any],
    ) -> str:
        """Build the complete prompt with API call instructions."""

        if task_type == TaskType.CANDIDATE_SEARCH:
            return self._build_candidate_search_prompt(prompt_id, parameters)
        elif task_type == TaskType.POLICY_SEARCH:
            return self._build_policy_search_prompt(prompt_id, parameters)
        elif task_type == TaskType.POLICY_VERIFY:
            return self._build_policy_verify_prompt(prompt_id, parameters)
        elif task_type == TaskType.PROGRESS_TRACKING:
            return self._build_progress_tracking_prompt(prompt_id, parameters)
        else:
            return prompt_template

    def _build_candidate_search_prompt(
        self,
        prompt_id: str,
        params: Dict[str, Any],
    ) -> str:
        """Build prompt for candidate search with API calls."""
        year = params.get("election_year", 2026)
        region = params.get("region", "")
        position = params.get("position", "")
        name = params.get("name", "")

        return f"""你是台灣選舉專家。請搜尋並整理 {year} 年{region if region else '台灣'}{position if position else ''}選舉的候選人資訊。

{f'特別關注: {name}' if name else ''}

## 步驟 1：先查詢現有候選人（防止重複）

**必須先查詢！** 不要直接新增。

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"query_candidates","election_year":{year},"region":"{region or ''}","position":"{position or ''}"}}'
```

記下回應中已存在的候選人名單。

## 步驟 2：搜尋新候選人

請搜尋最新新聞和官方資訊，找出所有可能的候選人。

**搜尋時評估每位候選人的信心度（0.0-1.0）：**
- 0.9-1.0：官方登記、中選會公告
- 0.8-0.9：候選人正式宣布、黨提名確定
- 0.7-0.8：多家主流媒體報導確認
- 0.5-0.7：單一來源報導（不會被匯入）
- 0.0-0.5：傳聞、推測（不會被匯入）

**重要：只有信心度 >= 0.7 的候選人才會被匯入資料庫！**

## 步驟 3：匯入新候選人（只匯入不重複且信心度 >= 0.7 的）

對照步驟 1 的查詢結果，**只匯入不存在的候選人**：

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"import_candidate","prompt_id":"{prompt_id}","election_year":{year},"candidate":{{"name":"候選人姓名","party":"政黨","position":"縣市長","region":"{region or '台灣'}","status":"confirmed/likely/rumored","current_position":"現任職位","confidence":0.85}}}}'
```

**重要：必須包含 confidence 欄位！**

## 步驟 4：完成任務

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"update_prompt","prompt_id":"{prompt_id}","status":"completed","result_summary":"找到 X 位候選人，新增 Y 位","result_data":{{"total_found":X,"new_added":Y,"existing":Z,"skipped_low_confidence":W,"sources":["來源1"]}}}}'
```

## 候選人資訊格式
- name: 候選人全名
- party: 中國國民黨/民主進步黨/台灣民眾黨/時代力量/台灣基進/無黨籍
- position: 參選職位
- region: 選區
- status: confirmed（已宣布）/ likely（可能參選）/ rumored（傳聞）
- current_position: 現任職位
- confidence: 信心度（0.0-1.0，必須 >= 0.7 才會被匯入）

## 注意事項
- 先查詢再新增：永遠先執行 query_candidates，避免重複
- 信心度門檻：只有 confidence >= 0.7 才會被匯入
- 只列出有明確新聞來源的候選人
- 不要編造資訊
- 每個 curl 命令執行後確認回應是否成功
- 在結果摘要中說明跳過多少低信心度候選人
- 最後務必更新任務狀態為 completed
"""

    def _build_policy_search_prompt(
        self,
        prompt_id: str,
        params: Dict[str, Any],
    ) -> str:
        """Build prompt for policy search with API calls."""
        politician_name = params.get("politician_name", "")
        keywords = params.get("keywords", [])

        return f"""請搜尋並整理政治人物 {politician_name} 的政見資訊。

搜尋關鍵字：{', '.join(keywords) if keywords else '（無指定）'}

## 步驟 1：先查詢現有政見（防止重複）

**必須先查詢！** 不要直接新增。

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"query_policies","politician_name":"{politician_name}"}}'
```

記下回應中已存在的政見標題。

## 步驟 2：搜尋新政見

搜尋該政治人物的政見（競選官網、新聞報導、政見發表會）。

## 步驟 3：新增不重複的政見

對照步驟 1 的查詢結果，**只新增不存在的政見**：

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"add_policy","prompt_id":"{prompt_id}","politician_name":"{politician_name}","policy":{{"title":"政見標題","description":"詳細說明","category":"交通/經濟/社會/環境/教育/其他","source_url":"新聞來源網址"}}}}'
```

**判斷是否重複的標準：**
- 標題相同或高度相似
- 描述內容相同
- 若為同一政見的不同表述，視為重複

## 步驟 4：完成任務

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"update_prompt","prompt_id":"{prompt_id}","status":"completed","result_summary":"新增 X 條政見，跳過 Y 條重複","result_data":{{"new_added":X,"skipped_duplicate":Y,"sources":["來源1"]}}}}'
```

## 注意事項
- 先查詢再新增：永遠先執行 query_policies，避免重複
- 政見標題要簡潔（20字以內）
- 描述要具體，包含數字目標更佳
- 每條政見需有新聞來源
- 相似政見不要重複新增
"""

    def _build_policy_verify_prompt(
        self,
        prompt_id: str,
        params: Dict[str, Any],
    ) -> str:
        """Build prompt for policy verification with API calls."""
        politician_name = params.get("politician_name", "")
        policy_title = params.get("policy_title", "")

        return f"""請驗證政治人物 {politician_name} 的政見：{policy_title}

## 步驟 1：先查詢現有政見資料

**必須先查詢！** 確認政見存在於資料庫。

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"query_policies","politician_name":"{politician_name}","keywords":["{policy_title}"]}}'
```

確認找到要驗證的政見後，記下 policy_id。

## 步驟 2：搜尋驗證證據

搜尋該政見的相關證據：
1. **官方資料**：政府公報、統計數據、工程驗收報告
2. **第三方查核**：事實查核組織、學術研究
3. **主流媒體**：聯合報、自由時報、中時電子報
4. **當事人聲明**：官方新聞稿、記者會

## 步驟 3：更新政見狀態（若驗證發現狀態應改變）

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"update_policy","prompt_id":"{prompt_id}","politician_name":"{politician_name}","policy_title":"{policy_title}","new_status":"Achieved/In Progress/Stalled/Failed","progress_note":"驗證結果說明"}}'
```

## 步驟 4：新增驗證紀錄

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"add_tracking_log","prompt_id":"{prompt_id}","politician_name":"{politician_name}","policy_title":"{policy_title}","log":{{"status":"驗證狀態","content":"【驗證報告】驗證結果說明","source_url":"驗證來源","date":"{datetime.utcnow().strftime("%Y-%m-%d")}"}}}}'
```

## 步驟 5：完成任務

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"update_prompt","prompt_id":"{prompt_id}","status":"completed","result_summary":"驗證完成：verified/partially_verified/unverified","result_data":{{"verification_result":"verified","evidence_count":X}}}}'
```

## 注意事項
- 先查詢：確認政見存在於資料庫才進行驗證
- 驗證必須有具體證據，不能臆測
- 驗證紀錄格式：【驗證報告】+ 結論 + 證據說明
- 若無法驗證，標記為 unverified，不要猜測
"""

    def _build_progress_tracking_prompt(
        self,
        prompt_id: str,
        params: Dict[str, Any],
    ) -> str:
        """Build prompt for progress tracking with API calls."""
        politician_name = params.get("politician_name", "")
        policy_title = params.get("policy_title", "")

        return f"""請追蹤政治人物 {politician_name} 的政見進度：{policy_title}

## 步驟 1：先查詢現有政見資料

**必須先查詢！** 確認政見存在於資料庫。

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"query_policies","politician_name":"{politician_name}","keywords":["{policy_title}"]}}'
```

確認找到要追蹤的政見後，記下 policy_id 和目前狀態。

## 步驟 2：搜尋最新進度

搜尋該政見的最新進度：
1. **政府公告**：市政府新聞稿、施政報告
2. **議會記錄**：質詢答覆、預算審查
3. **新聞報導**：工程進度、政策執行報導
4. **民間監督**：公民團體追蹤報告

## 步驟 3：更新政見狀態

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"update_policy","prompt_id":"{prompt_id}","politician_name":"{politician_name}","policy_title":"{policy_title}","new_status":"In Progress/Achieved/Stalled/Failed","progress_note":"最新進度說明"}}'
```

## 步驟 4：新增追蹤紀錄

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"add_tracking_log","prompt_id":"{prompt_id}","politician_name":"{politician_name}","policy_title":"{policy_title}","log":{{"status":"進度狀態","content":"進度內容說明","source_url":"新聞來源","date":"{datetime.utcnow().strftime("%Y-%m-%d")}"}}}}'
```

## 步驟 5：完成任務

```bash
curl -X POST "{API_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {AUTH_TOKEN}" \\
  -d '{{"api_key":"{API_KEY}","action":"update_prompt","prompt_id":"{prompt_id}","status":"completed","result_summary":"更新 X 條政見進度","result_data":{{"updated_count":X}}}}'
```

## 注意事項
- 先查詢：確認政見存在於資料庫才進行追蹤
- 每次更新需有新聞來源佐證
- 進度說明要具體（日期、數字、事實）
- 避免主觀評論，以事實為依據
"""

    def get_result_path(self, task_path: Path) -> Path:
        """Get the expected result file path for a task."""
        task_name = task_path.stem
        result_name = f"{task_name}_result.md"
        return self.results_dir / result_name

    def check_result_exists(self, task_path: Path) -> bool:
        """Check if result file exists for a task."""
        result_path = self.get_result_path(task_path)
        return result_path.exists()

    def get_pending_tasks(self) -> list[Path]:
        """Get list of task files without corresponding results."""
        pending = []
        for task_file in self.tasks_dir.glob("task_*.md"):
            if not self.check_result_exists(task_file):
                pending.append(task_file)
        return pending

    def cleanup_old_files(self, max_age_days: int = 7) -> int:
        """Clean up old task and result files."""
        deleted = 0
        cutoff = datetime.utcnow().timestamp() - (max_age_days * 24 * 60 * 60)

        for directory in [self.tasks_dir, self.results_dir]:
            for file_path in directory.glob("*.md"):
                if file_path.stat().st_mtime < cutoff:
                    file_path.unlink()
                    deleted += 1
                    logger.info("file_deleted", path=str(file_path))

        return deleted
