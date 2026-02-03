-- ============================================================
-- Recalculate AI usage stats from scratch
-- Fix potential duplicate counting issues
-- ============================================================

-- Clear existing stats
TRUNCATE ai_usage_stats;

-- Recalculate from ai_prompts
INSERT INTO ai_usage_stats (month, function_type, request_count, total_tokens, total_cost)
SELECT
  DATE_TRUNC('month', completed_at)::DATE AS month,
  map_task_to_function_type(task_type) AS function_type,
  COUNT(*) AS request_count,
  COALESCE(SUM(
    COALESCE((result_data->'usage'->>'input_tokens')::INTEGER, 0) +
    COALESCE((result_data->'usage'->>'output_tokens')::INTEGER, 0)
  ), 0) AS total_tokens,
  COALESCE(SUM(COALESCE((result_data->'usage'->>'total_cost_usd')::DECIMAL, 0)), 0) AS total_cost
FROM ai_prompts
WHERE status = 'completed'
  AND result_data->'usage' IS NOT NULL
  AND completed_at IS NOT NULL
GROUP BY DATE_TRUNC('month', completed_at)::DATE, map_task_to_function_type(task_type);

-- Show recalculated stats
DO $$
DECLARE
  r RECORD;
BEGIN
  RAISE NOTICE '=== Recalculated AI Usage Stats ===';
  FOR r IN SELECT month, function_type, request_count, total_tokens, total_cost FROM ai_usage_stats ORDER BY month DESC, function_type LOOP
    RAISE NOTICE 'Month: %, Type: %, Requests: %, Tokens: %, Cost: $%', r.month, r.function_type, r.request_count, r.total_tokens, r.total_cost;
  END LOOP;
END $$;
