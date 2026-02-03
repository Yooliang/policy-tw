-- ============================================================
-- Replace ai_usage_stats VIEW with a materialized stats TABLE
-- Uses trigger to maintain aggregated statistics
-- ============================================================

-- Drop old VIEW
DROP VIEW IF EXISTS ai_usage_stats;

-- Create statistics table
CREATE TABLE ai_usage_stats (
  id SERIAL PRIMARY KEY,
  month DATE NOT NULL,                    -- First day of month
  function_type TEXT NOT NULL,            -- verify, search, update, contribute
  request_count INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_cost DECIMAL(10, 6) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(month, function_type)
);

-- Enable RLS with public read
ALTER TABLE ai_usage_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access" ON ai_usage_stats
  FOR SELECT USING (true);

GRANT SELECT ON ai_usage_stats TO anon, authenticated;

-- Function to map task_type to function_type
CREATE OR REPLACE FUNCTION map_task_to_function_type(task_type TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN CASE task_type
    WHEN 'policy_verify' THEN 'verify'
    WHEN 'candidate_search' THEN 'search'
    WHEN 'policy_search' THEN 'search'
    WHEN 'progress_tracking' THEN 'update'
    WHEN 'policy_import' THEN 'update'
    WHEN 'user_contribution' THEN 'contribute'
    WHEN 'politician_update' THEN 'update'
    ELSE 'other'
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Trigger function to update stats when ai_prompts is updated
CREATE OR REPLACE FUNCTION update_ai_usage_stats()
RETURNS TRIGGER AS $$
DECLARE
  v_month DATE;
  v_function_type TEXT;
  v_input_tokens INTEGER;
  v_output_tokens INTEGER;
  v_total_tokens INTEGER;
  v_cost DECIMAL(10, 6);
BEGIN
  -- Only process when status changes to 'completed' and has usage data
  IF NEW.status = 'completed'
     AND NEW.result_data->'usage' IS NOT NULL
     AND (OLD IS NULL OR OLD.status != 'completed') THEN

    -- Extract values
    v_month := DATE_TRUNC('month', COALESCE(NEW.completed_at, NOW()))::DATE;
    v_function_type := map_task_to_function_type(NEW.task_type);
    v_input_tokens := COALESCE((NEW.result_data->'usage'->>'input_tokens')::INTEGER, 0);
    v_output_tokens := COALESCE((NEW.result_data->'usage'->>'output_tokens')::INTEGER, 0);
    v_total_tokens := v_input_tokens + v_output_tokens;
    v_cost := COALESCE((NEW.result_data->'usage'->>'total_cost_usd')::DECIMAL, 0);

    -- Upsert stats
    INSERT INTO ai_usage_stats (month, function_type, request_count, total_tokens, total_cost, updated_at)
    VALUES (v_month, v_function_type, 1, v_total_tokens, v_cost, NOW())
    ON CONFLICT (month, function_type)
    DO UPDATE SET
      request_count = ai_usage_stats.request_count + 1,
      total_tokens = ai_usage_stats.total_tokens + v_total_tokens,
      total_cost = ai_usage_stats.total_cost + v_cost,
      updated_at = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS ai_prompts_update_stats ON ai_prompts;
CREATE TRIGGER ai_prompts_update_stats
  AFTER INSERT OR UPDATE ON ai_prompts
  FOR EACH ROW
  EXECUTE FUNCTION update_ai_usage_stats();

-- Backfill existing data
INSERT INTO ai_usage_stats (month, function_type, request_count, total_tokens, total_cost)
SELECT
  DATE_TRUNC('month', completed_at)::DATE AS month,
  map_task_to_function_type(task_type) AS function_type,
  COUNT(*) AS request_count,
  COALESCE(SUM(
    (result_data->'usage'->>'input_tokens')::INTEGER +
    (result_data->'usage'->>'output_tokens')::INTEGER
  ), 0) AS total_tokens,
  COALESCE(SUM((result_data->'usage'->>'total_cost_usd')::DECIMAL), 0) AS total_cost
FROM ai_prompts
WHERE status = 'completed'
  AND result_data->'usage' IS NOT NULL
  AND completed_at IS NOT NULL
GROUP BY DATE_TRUNC('month', completed_at)::DATE, map_task_to_function_type(task_type)
ON CONFLICT (month, function_type)
DO UPDATE SET
  request_count = EXCLUDED.request_count,
  total_tokens = EXCLUDED.total_tokens,
  total_cost = EXCLUDED.total_cost,
  updated_at = NOW();
