-- ============================================================
-- Policy Source Tracking Fields
-- Track where policy data originated (AI extracted vs manual)
-- ============================================================

-- Add source tracking columns to policies
ALTER TABLE policies
ADD COLUMN IF NOT EXISTS source_url TEXT,
ADD COLUMN IF NOT EXISTS ai_extracted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS ai_confidence DECIMAL(3, 2) CHECK (ai_confidence >= 0 AND ai_confidence <= 1);

-- Add source tracking to tracking_logs
ALTER TABLE tracking_logs
ADD COLUMN IF NOT EXISTS source_url TEXT,
ADD COLUMN IF NOT EXISTS ai_extracted BOOLEAN DEFAULT FALSE;

-- Comments
COMMENT ON COLUMN policies.source_url IS 'URL where this policy information was found';
COMMENT ON COLUMN policies.ai_extracted IS 'Whether this policy was extracted by AI';
COMMENT ON COLUMN policies.ai_confidence IS 'AI confidence score when extracted (0-1)';
COMMENT ON COLUMN tracking_logs.source_url IS 'URL where this tracking update was found';
COMMENT ON COLUMN tracking_logs.ai_extracted IS 'Whether this log was extracted by AI';

-- Index for filtering AI-extracted policies
CREATE INDEX IF NOT EXISTS idx_policies_ai_extracted ON policies(ai_extracted);
