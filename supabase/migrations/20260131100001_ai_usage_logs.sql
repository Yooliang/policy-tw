-- ============================================================
-- AI Usage Logs Table
-- Tracks all AI API calls for monitoring and billing purposes
-- ============================================================

CREATE TABLE ai_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Function type: 'verify', 'contribute', 'search', 'update'
  function_type TEXT NOT NULL CHECK (function_type IN ('verify', 'contribute', 'search', 'update')),

  -- Input data
  input_url TEXT,
  input_message TEXT,

  -- AI response metadata
  model_used TEXT NOT NULL,     -- e.g., 'gemini-2.5-flash'
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,

  -- Cost estimation (USD)
  estimated_cost DECIMAL(10, 6),

  -- Result tracking
  success BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  confidence DECIMAL(3, 2) CHECK (confidence >= 0 AND confidence <= 1),

  -- User contribution tracking
  contributed BOOLEAN DEFAULT FALSE,
  contributed_policy_id UUID REFERENCES policies(id) ON DELETE SET NULL,

  -- User/session info
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ip_address TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_ai_usage_logs_function_type ON ai_usage_logs(function_type);
CREATE INDEX idx_ai_usage_logs_created_at ON ai_usage_logs(created_at);
CREATE INDEX idx_ai_usage_logs_user_id ON ai_usage_logs(user_id);
CREATE INDEX idx_ai_usage_logs_ip_address ON ai_usage_logs(ip_address);

-- Statistics view for public display
CREATE OR REPLACE VIEW ai_usage_stats AS
SELECT
  DATE_TRUNC('month', created_at) AS month,
  function_type,
  COUNT(*) AS request_count,
  SUM(total_tokens) AS total_tokens,
  SUM(estimated_cost) AS total_cost
FROM ai_usage_logs
WHERE success = TRUE
GROUP BY DATE_TRUNC('month', created_at), function_type;

-- RLS policies
ALTER TABLE ai_usage_logs ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (rate limiting handled in Edge Function)
CREATE POLICY "Public can insert" ON ai_usage_logs
  FOR INSERT WITH CHECK (true);

-- Only authenticated users can read their own logs
CREATE POLICY "Users can read own logs" ON ai_usage_logs
  FOR SELECT USING (
    auth.uid() = user_id
  );

-- Service role can read all (for Edge Functions)
CREATE POLICY "Service role can read all" ON ai_usage_logs
  FOR SELECT USING (
    auth.role() = 'service_role'
  );

-- Grant access to the view (views bypass RLS by default when using security definer)
GRANT SELECT ON ai_usage_stats TO anon, authenticated;
