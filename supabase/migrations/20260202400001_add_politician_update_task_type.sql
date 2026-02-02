-- ============================================================
-- Add politician_update task type to ai_prompts
-- ============================================================

-- Drop and recreate task_type check constraint with new value
ALTER TABLE ai_prompts
DROP CONSTRAINT IF EXISTS ai_prompts_task_type_check;

ALTER TABLE ai_prompts
ADD CONSTRAINT ai_prompts_task_type_check
CHECK (task_type IN (
    'candidate_search',    -- 搜尋候選人
    'politician_update',   -- 更新政治人物資料 (新增)
    'policy_search',       -- 搜尋政見
    'policy_verify',       -- 驗證政見
    'progress_tracking',   -- 進度追蹤
    'policy_import',       -- 匯入政見
    'user_contribution'    -- 使用者貢獻
));

COMMENT ON COLUMN ai_prompts.task_type IS 'Type of AI task: candidate_search, politician_update, policy_search, policy_verify, progress_tracking, policy_import, user_contribution';
