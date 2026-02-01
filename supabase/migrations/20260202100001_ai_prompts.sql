-- ============================================================
-- AI Prompts Table
-- Stores AI task requests for async processing by policy-ai service
-- ============================================================

CREATE TABLE ai_prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Task type: what kind of AI operation
    task_type TEXT NOT NULL CHECK (task_type IN (
        'candidate_search',   -- Search for election candidates
        'policy_search',      -- Search for policy information
        'policy_verify',      -- Verify policy claims
        'progress_tracking'   -- Track policy progress
    )),

    -- Prompt content
    prompt_template TEXT NOT NULL,      -- The prompt text or template
    parameters JSONB DEFAULT '{}',      -- Dynamic parameters (election_year, region, etc.)

    -- Scheduling (for recurring tasks)
    cron_expression TEXT,               -- e.g., '0 0 * * *' for daily
    is_recurring BOOLEAN DEFAULT FALSE,

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',      -- Waiting to be processed
        'scheduled',    -- Scheduled for future execution
        'processing',   -- Currently being processed by Claude
        'completed',    -- Successfully completed
        'failed'        -- Failed with error
    )),
    priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),  -- 1=lowest, 10=highest

    -- Execution tracking
    started_at TIMESTAMPTZ,             -- When processing started
    completed_at TIMESTAMPTZ,           -- When processing finished
    last_run TIMESTAMPTZ,               -- For recurring tasks

    -- Result storage
    result_summary TEXT,                -- Brief summary of result
    result_data JSONB,                  -- Full structured result
    confidence DECIMAL(3, 2) CHECK (confidence >= 0 AND confidence <= 1),
    error_message TEXT,                 -- Error details if failed

    -- Scope filters (optional, to limit what data to process)
    election_id INTEGER REFERENCES elections(id) ON DELETE SET NULL,
    region TEXT,
    politician_id UUID REFERENCES politicians(id) ON DELETE SET NULL,

    -- Metadata
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_ai_prompts_status ON ai_prompts(status);
CREATE INDEX idx_ai_prompts_task_type ON ai_prompts(task_type);
CREATE INDEX idx_ai_prompts_priority ON ai_prompts(priority DESC);
CREATE INDEX idx_ai_prompts_created_at ON ai_prompts(created_at DESC);
CREATE INDEX idx_ai_prompts_pending ON ai_prompts(status, priority DESC, created_at)
    WHERE status = 'pending';

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_ai_prompts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_prompts_updated_at
    BEFORE UPDATE ON ai_prompts
    FOR EACH ROW
    EXECUTE FUNCTION update_ai_prompts_updated_at();

-- RLS policies
ALTER TABLE ai_prompts ENABLE ROW LEVEL SECURITY;

-- Service role has full access (for policy-ai service)
CREATE POLICY "Service role full access" ON ai_prompts
    FOR ALL
    USING (auth.role() = 'service_role');

-- Admins can manage prompts
CREATE POLICY "Admins can manage prompts" ON ai_prompts
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id = auth.uid() AND is_admin = TRUE
        )
    );

-- Users can view their own prompts
CREATE POLICY "Users can view own prompts" ON ai_prompts
    FOR SELECT
    USING (created_by = auth.uid());

-- Grant access
GRANT SELECT, INSERT ON ai_prompts TO authenticated;
GRANT ALL ON ai_prompts TO service_role;

-- ============================================================
-- Comments
-- ============================================================
COMMENT ON TABLE ai_prompts IS 'Stores AI task requests for async processing by policy-ai Python service';
COMMENT ON COLUMN ai_prompts.task_type IS 'Type of AI task: candidate_search, policy_search, policy_verify, progress_tracking';
COMMENT ON COLUMN ai_prompts.status IS 'Task status: pending -> processing -> completed/failed';
COMMENT ON COLUMN ai_prompts.priority IS 'Processing priority: 1=lowest, 10=highest';
COMMENT ON COLUMN ai_prompts.result_data IS 'Structured JSON result from Claude processing';
