-- ============================================================
-- Remove prompt_template column (redundant with user_input)
-- Migrate data to user_input if needed, then drop column
-- ============================================================

-- 1. Ensure user_input has data (copy from prompt_template if user_input is empty)
UPDATE ai_prompts
SET user_input = prompt_template
WHERE user_input IS NULL AND prompt_template IS NOT NULL;

-- 2. Drop the prompt_template column
ALTER TABLE ai_prompts
DROP COLUMN IF EXISTS prompt_template;

-- 3. Add comment explaining the change
COMMENT ON COLUMN ai_prompts.user_input IS '使用者輸入文字（原 prompt_template 已合併至此欄位）';
