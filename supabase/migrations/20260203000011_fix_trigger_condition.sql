-- ============================================================
-- Fix trigger condition to detect when usage data is added
-- ============================================================

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
  -- Trigger when:
  -- 1. Status becomes 'completed' with usage data, OR
  -- 2. Usage data is added to an already completed record
  IF NEW.status = 'completed'
     AND NEW.result_data->'usage' IS NOT NULL
     AND (
       -- Case 1: Status just changed to completed
       (OLD IS NULL OR OLD.status != 'completed')
       OR
       -- Case 2: Already completed but usage just added
       (OLD.status = 'completed' AND OLD.result_data->'usage' IS NULL)
       OR
       -- Case 3: Usage data changed (total_cost_usd was 0 or null, now has value)
       (OLD.status = 'completed'
        AND OLD.result_data->'usage' IS NOT NULL
        AND COALESCE((OLD.result_data->'usage'->>'total_cost_usd')::DECIMAL, 0) = 0
        AND COALESCE((NEW.result_data->'usage'->>'total_cost_usd')::DECIMAL, 0) > 0)
     ) THEN

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

-- Recalculate all stats from scratch
TRUNCATE ai_usage_stats;

INSERT INTO ai_usage_stats (month, function_type, request_count, total_tokens, total_cost)
SELECT
  DATE_TRUNC('month', completed_at)::DATE AS month,
  map_task_to_function_type(task_type) AS function_type,
  COUNT(*) AS request_count,
  COALESCE(SUM(
    COALESCE((result_data->'usage'->>'input_tokens')::INTEGER, 0) +
    COALESCE((result_data->'usage'->>'output_tokens')::INTEGER, 0)
  ), 0) AS total_tokens,
  COALESCE(SUM((result_data->'usage'->>'total_cost_usd')::DECIMAL), 0) AS total_cost
FROM ai_prompts
WHERE status = 'completed'
  AND result_data->'usage' IS NOT NULL
  AND completed_at IS NOT NULL
GROUP BY DATE_TRUNC('month', completed_at)::DATE, map_task_to_function_type(task_type);
