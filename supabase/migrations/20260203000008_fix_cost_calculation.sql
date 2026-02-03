-- ============================================================
-- Fix cost calculation - calculate from tokens instead of CLI value
-- Using Haiku 4.5 pricing: Input $1/MTok, Output $5/MTok
-- ============================================================

-- Update trigger function to calculate cost from tokens
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

    -- Calculate cost based on Haiku 4.5 pricing: Input $1/MTok, Output $5/MTok
    v_cost := (v_input_tokens * 1.0 / 1000000) + (v_output_tokens * 5.0 / 1000000);

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

-- Recalculate all stats with correct pricing
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
  -- Calculate cost: Input $1/MTok + Output $5/MTok (Haiku 4.5)
  COALESCE(SUM(
    (COALESCE((result_data->'usage'->>'input_tokens')::INTEGER, 0) * 1.0 / 1000000) +
    (COALESCE((result_data->'usage'->>'output_tokens')::INTEGER, 0) * 5.0 / 1000000)
  ), 0) AS total_cost
FROM ai_prompts
WHERE status = 'completed'
  AND result_data->'usage' IS NOT NULL
  AND completed_at IS NOT NULL
GROUP BY DATE_TRUNC('month', completed_at)::DATE, map_task_to_function_type(task_type);

-- Show recalculated stats
DO $$
DECLARE
  r RECORD;
  sum_tokens INTEGER := 0;
  sum_cost DECIMAL := 0;
BEGIN
  RAISE NOTICE '=== Recalculated AI Usage Stats (Haiku 4.5 pricing) ===';
  FOR r IN SELECT month, function_type, request_count, total_tokens, total_cost FROM ai_usage_stats ORDER BY month DESC, function_type LOOP
    RAISE NOTICE 'Month: %, Type: %, Requests: %, Tokens: %, Cost: $%', r.month, r.function_type, r.request_count, r.total_tokens, ROUND(r.total_cost::NUMERIC, 4);
    sum_tokens := sum_tokens + r.total_tokens;
    sum_cost := sum_cost + r.total_cost;
  END LOOP;
  RAISE NOTICE '=== Total: % tokens, $% USD ===', sum_tokens, ROUND(sum_cost::NUMERIC, 4);
END $$;
