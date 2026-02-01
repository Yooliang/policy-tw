-- ============================================================
-- Extend ai_prompts for AI Chat feature
-- Adds new task types and review workflow fields
-- ============================================================

-- Drop and recreate task_type check constraint with new values
ALTER TABLE ai_prompts
DROP CONSTRAINT IF EXISTS ai_prompts_task_type_check;

ALTER TABLE ai_prompts
ADD CONSTRAINT ai_prompts_task_type_check
CHECK (task_type IN (
    'candidate_search',   -- 搜尋候選人
    'policy_search',      -- 搜尋政見
    'policy_verify',      -- 驗證政見
    'progress_tracking',  -- 進度追蹤
    'policy_import',      -- 匯入政見 (新增)
    'user_contribution'   -- 使用者貢獻 (新增)
));

-- Add new columns for review workflow
ALTER TABLE ai_prompts
ADD COLUMN IF NOT EXISTS source_url TEXT,
ADD COLUMN IF NOT EXISTS requires_review BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS review_notes TEXT,
ADD COLUMN IF NOT EXISTS user_input TEXT;  -- 原始使用者輸入

-- Add index for review workflow
CREATE INDEX IF NOT EXISTS idx_ai_prompts_requires_review
ON ai_prompts(requires_review, status)
WHERE requires_review = TRUE;

-- Comments
COMMENT ON COLUMN ai_prompts.source_url IS '來源網址（使用者提供）';
COMMENT ON COLUMN ai_prompts.requires_review IS '是否需要人工審核';
COMMENT ON COLUMN ai_prompts.reviewed_by IS '審核者 ID';
COMMENT ON COLUMN ai_prompts.reviewed_at IS '審核時間';
COMMENT ON COLUMN ai_prompts.review_notes IS '審核備註';
COMMENT ON COLUMN ai_prompts.user_input IS '原始使用者輸入文字';

-- Update RLS to allow public read of own prompts
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Users can view own prompts' AND tablename = 'ai_prompts'
    ) THEN
        CREATE POLICY "Users can view own prompts" ON ai_prompts
            FOR SELECT
            USING (created_by = auth.uid());
    END IF;
END $$;

-- Allow authenticated users to insert
DROP POLICY IF EXISTS "Authenticated users can insert" ON ai_prompts;
CREATE POLICY "Authenticated users can insert" ON ai_prompts
    FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');
