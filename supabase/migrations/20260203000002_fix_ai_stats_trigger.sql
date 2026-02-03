-- ============================================================
-- Fix ai_usage_stats trigger to handle usage updates
-- Trigger should fire when result_data->usage is added/changed
-- ============================================================

-- Update trigger function to also fire when usage data is added
CREATE OR REPLACE FUNCTION update_ai_usage_stats()
RETURNS TRIGGER AS $$
DECLARE
  v_month DATE;
  v_function_type TEXT;
  v_input_tokens INTEGER;
  v_output_tokens INTEGER;
  v_total_tokens INTEGER;
  v_cost DECIMAL(10, 6);
  v_old_has_usage BOOLEAN;
  v_new_has_usage BOOLEAN;
BEGIN
  -- Check if usage data exists
  v_old_has_usage := (OLD IS NOT NULL AND OLD.result_data->'usage' IS NOT NULL);
  v_new_has_usage := (NEW.result_data->'usage' IS NOT NULL);

  -- Process when:
  -- 1. Status changes to 'completed' with usage data, OR
  -- 2. Usage data is added to an already completed record
  IF NEW.status = 'completed' AND v_new_has_usage AND NOT v_old_has_usage THEN

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

-- Backfill existing data with usage
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
