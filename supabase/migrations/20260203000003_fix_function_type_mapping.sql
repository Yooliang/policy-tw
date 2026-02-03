-- ============================================================
-- Fix function_type mapping - separate politician_update
-- ============================================================

-- Update mapping function
CREATE OR REPLACE FUNCTION map_task_to_function_type(task_type TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN CASE task_type
    WHEN 'policy_verify' THEN 'verify'
    WHEN 'candidate_search' THEN 'search'
    WHEN 'policy_search' THEN 'search'
    WHEN 'progress_tracking' THEN 'policy_update'
    WHEN 'policy_import' THEN 'policy_update'
    WHEN 'user_contribution' THEN 'contribute'
    WHEN 'politician_update' THEN 'politician_update'
    ELSE 'other'
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Rebuild stats with new mapping
TRUNCATE ai_usage_stats;

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
