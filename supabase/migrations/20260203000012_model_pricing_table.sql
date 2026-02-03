-- ============================================================
-- Model Pricing Table & Cost Calculation Trigger
-- Stores Anthropic model pricing for dynamic cost calculation
-- Adds total_tokens and total_cost columns to ai_prompts
-- ============================================================

-- 0. Add total_tokens and total_cost columns to ai_prompts
ALTER TABLE ai_prompts
ADD COLUMN IF NOT EXISTS total_tokens INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_cost DECIMAL(10, 6) DEFAULT 0;

-- Create index for cost queries
CREATE INDEX IF NOT EXISTS idx_ai_prompts_total_cost ON ai_prompts(total_cost);
CREATE INDEX IF NOT EXISTS idx_ai_prompts_completed_cost ON ai_prompts(completed_at, total_cost)
    WHERE status = 'completed';

COMMENT ON COLUMN ai_prompts.total_tokens IS 'Total tokens used (input + output + cache)';
COMMENT ON COLUMN ai_prompts.total_cost IS 'Calculated cost in USD based on model_pricing table';

-- 1. Create model_pricing table
CREATE TABLE IF NOT EXISTS model_pricing (
    id SERIAL PRIMARY KEY,
    model_name TEXT NOT NULL UNIQUE,           -- e.g., 'claude-haiku-4-5'
    model_aliases TEXT[] DEFAULT '{}',         -- e.g., '{claude-3-5-haiku, haiku}'

    -- Pricing per million tokens (MTok)
    input_price_per_mtok DECIMAL(10, 4) NOT NULL,      -- e.g., 1.00 for Haiku
    output_price_per_mtok DECIMAL(10, 4) NOT NULL,     -- e.g., 5.00 for Haiku
    cache_read_price_per_mtok DECIMAL(10, 4) NOT NULL, -- e.g., 0.10 for Haiku (90% discount)
    cache_write_price_per_mtok DECIMAL(10, 4) NOT NULL,-- e.g., 1.25 for Haiku (25% surcharge)

    -- Metadata
    is_default BOOLEAN DEFAULT FALSE,          -- Default model for cost calculation
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for model lookup
CREATE INDEX idx_model_pricing_name ON model_pricing(model_name);

-- 2. Insert pricing data (as of 2026-02)
INSERT INTO model_pricing (model_name, model_aliases, input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok, cache_write_price_per_mtok, is_default, description)
VALUES
    ('claude-haiku-4-5',
     ARRAY['claude-3-5-haiku', 'claude-haiku-4-5-20251001', 'haiku-4-5', 'haiku'],
     1.00, 5.00, 0.10, 1.25,
     TRUE,
     'Claude Haiku 4.5 - Fast & cost-effective'),

    ('claude-sonnet-4',
     ARRAY['claude-4-sonnet', 'claude-sonnet-4-20250514', 'sonnet-4', 'sonnet'],
     3.00, 15.00, 0.30, 3.75,
     FALSE,
     'Claude Sonnet 4 - Balanced performance'),

    ('claude-opus-4-5',
     ARRAY['claude-4-5-opus', 'claude-opus-4-5-20251101', 'opus-4-5', 'opus'],
     15.00, 75.00, 1.50, 18.75,
     FALSE,
     'Claude Opus 4.5 - Most capable')
ON CONFLICT (model_name) DO UPDATE SET
    model_aliases = EXCLUDED.model_aliases,
    input_price_per_mtok = EXCLUDED.input_price_per_mtok,
    output_price_per_mtok = EXCLUDED.output_price_per_mtok,
    cache_read_price_per_mtok = EXCLUDED.cache_read_price_per_mtok,
    cache_write_price_per_mtok = EXCLUDED.cache_write_price_per_mtok,
    description = EXCLUDED.description,
    updated_at = NOW();

-- 3. Create function to get pricing for a model
CREATE OR REPLACE FUNCTION get_model_pricing(p_model_name TEXT)
RETURNS TABLE (
    input_price DECIMAL(10, 4),
    output_price DECIMAL(10, 4),
    cache_read_price DECIMAL(10, 4),
    cache_write_price DECIMAL(10, 4)
) AS $$
DECLARE
    v_model_lower TEXT;
BEGIN
    v_model_lower := LOWER(COALESCE(p_model_name, ''));

    -- Try exact match first
    RETURN QUERY
    SELECT
        mp.input_price_per_mtok,
        mp.output_price_per_mtok,
        mp.cache_read_price_per_mtok,
        mp.cache_write_price_per_mtok
    FROM model_pricing mp
    WHERE LOWER(mp.model_name) = v_model_lower
       OR v_model_lower = ANY(SELECT LOWER(unnest(mp.model_aliases)))
    LIMIT 1;

    -- If no match, return default pricing
    IF NOT FOUND THEN
        RETURN QUERY
        SELECT
            mp.input_price_per_mtok,
            mp.output_price_per_mtok,
            mp.cache_read_price_per_mtok,
            mp.cache_write_price_per_mtok
        FROM model_pricing mp
        WHERE mp.is_default = TRUE
        LIMIT 1;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- 4. Create function to calculate cost
CREATE OR REPLACE FUNCTION calculate_token_cost(
    p_model TEXT,
    p_input_tokens INTEGER,
    p_output_tokens INTEGER,
    p_cache_read_tokens INTEGER DEFAULT 0,
    p_cache_creation_tokens INTEGER DEFAULT 0
) RETURNS DECIMAL(10, 6) AS $$
DECLARE
    v_pricing RECORD;
    v_cost DECIMAL(10, 6);
BEGIN
    -- Get pricing for the model
    SELECT * INTO v_pricing FROM get_model_pricing(p_model);

    -- Calculate cost (prices are per MTok, so divide by 1,000,000)
    v_cost := (
        (COALESCE(p_input_tokens, 0) * v_pricing.input_price / 1000000.0) +
        (COALESCE(p_output_tokens, 0) * v_pricing.output_price / 1000000.0) +
        (COALESCE(p_cache_read_tokens, 0) * v_pricing.cache_read_price / 1000000.0) +
        (COALESCE(p_cache_creation_tokens, 0) * v_pricing.cache_write_price / 1000000.0)
    );

    RETURN v_cost;
END;
$$ LANGUAGE plpgsql STABLE;

-- 5. Update the trigger function to use the new pricing table
CREATE OR REPLACE FUNCTION update_ai_usage_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_month DATE;
    v_function_type TEXT;
    v_model TEXT;
    v_input_tokens INTEGER;
    v_output_tokens INTEGER;
    v_cache_read_tokens INTEGER;
    v_cache_creation_tokens INTEGER;
    v_total_tokens INTEGER;
    v_cost DECIMAL(10, 6);
BEGIN
    -- Only process when status changes to 'completed' and has usage data
    IF NEW.status = 'completed'
       AND NEW.result_data->'usage' IS NOT NULL
       AND (OLD IS NULL OR OLD.status != 'completed') THEN

        -- Extract values from usage
        v_month := DATE_TRUNC('month', COALESCE(NEW.completed_at, NOW()))::DATE;
        v_function_type := map_task_to_function_type(NEW.task_type);
        v_model := COALESCE(NEW.result_data->'usage'->>'model', 'claude-haiku-4-5');
        v_input_tokens := COALESCE((NEW.result_data->'usage'->>'input_tokens')::INTEGER, 0);
        v_output_tokens := COALESCE((NEW.result_data->'usage'->>'output_tokens')::INTEGER, 0);
        v_cache_read_tokens := COALESCE((NEW.result_data->'usage'->>'cache_read_input_tokens')::INTEGER, 0);
        v_cache_creation_tokens := COALESCE((NEW.result_data->'usage'->>'cache_creation_input_tokens')::INTEGER, 0);

        -- Total tokens (input + output + cache)
        v_total_tokens := v_input_tokens + v_output_tokens + v_cache_read_tokens + v_cache_creation_tokens;

        -- Calculate cost using pricing table
        v_cost := calculate_token_cost(
            v_model,
            v_input_tokens,
            v_output_tokens,
            v_cache_read_tokens,
            v_cache_creation_tokens
        );

        -- Upsert stats
        INSERT INTO ai_usage_stats (month, function_type, request_count, total_tokens, total_cost, updated_at)
        VALUES (v_month, v_function_type, 1, v_total_tokens, v_cost, NOW())
        ON CONFLICT (month, function_type)
        DO UPDATE SET
            request_count = ai_usage_stats.request_count + 1,
            total_tokens = ai_usage_stats.total_tokens + v_total_tokens,
            total_cost = ai_usage_stats.total_cost + v_cost,
            updated_at = NOW();

        -- Update the ai_prompts columns directly
        NEW.total_tokens := v_total_tokens;
        NEW.total_cost := v_cost;

        -- Also update the result_data with calculated cost
        NEW.result_data := jsonb_set(
            NEW.result_data,
            '{usage,calculated_cost_usd}',
            to_jsonb(v_cost)
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. Recalculate all stats with new pricing (including cache tokens)
TRUNCATE ai_usage_stats;

INSERT INTO ai_usage_stats (month, function_type, request_count, total_tokens, total_cost)
SELECT
    DATE_TRUNC('month', completed_at)::DATE AS month,
    map_task_to_function_type(task_type) AS function_type,
    COUNT(*) AS request_count,
    COALESCE(SUM(
        COALESCE((result_data->'usage'->>'input_tokens')::INTEGER, 0) +
        COALESCE((result_data->'usage'->>'output_tokens')::INTEGER, 0) +
        COALESCE((result_data->'usage'->>'cache_read_input_tokens')::INTEGER, 0) +
        COALESCE((result_data->'usage'->>'cache_creation_input_tokens')::INTEGER, 0)
    ), 0) AS total_tokens,
    COALESCE(SUM(
        calculate_token_cost(
            COALESCE(result_data->'usage'->>'model', 'claude-haiku-4-5'),
            COALESCE((result_data->'usage'->>'input_tokens')::INTEGER, 0),
            COALESCE((result_data->'usage'->>'output_tokens')::INTEGER, 0),
            COALESCE((result_data->'usage'->>'cache_read_input_tokens')::INTEGER, 0),
            COALESCE((result_data->'usage'->>'cache_creation_input_tokens')::INTEGER, 0)
        )
    ), 0) AS total_cost
FROM ai_prompts
WHERE status = 'completed'
    AND result_data->'usage' IS NOT NULL
    AND completed_at IS NOT NULL
GROUP BY DATE_TRUNC('month', completed_at)::DATE, map_task_to_function_type(task_type);

-- 7. RLS for model_pricing (public read, admin write)
ALTER TABLE model_pricing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read pricing" ON model_pricing
    FOR SELECT USING (TRUE);

CREATE POLICY "Admins can manage pricing" ON model_pricing
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id = auth.uid() AND is_admin = TRUE
        )
    );

GRANT SELECT ON model_pricing TO anon, authenticated;
GRANT ALL ON model_pricing TO service_role;

-- 8. Updated_at trigger for model_pricing
CREATE TRIGGER model_pricing_updated_at
    BEFORE UPDATE ON model_pricing
    FOR EACH ROW
    EXECUTE FUNCTION update_ai_prompts_updated_at();

-- 9. Show recalculated stats
DO $$
DECLARE
    r RECORD;
    sum_tokens BIGINT := 0;
    sum_cost DECIMAL := 0;
BEGIN
    RAISE NOTICE '=== Recalculated AI Usage Stats (with cache tokens) ===';
    RAISE NOTICE 'Using pricing from model_pricing table';
    RAISE NOTICE '';

    FOR r IN
        SELECT month, function_type, request_count, total_tokens, total_cost
        FROM ai_usage_stats
        ORDER BY month DESC, function_type
    LOOP
        RAISE NOTICE 'Month: %, Type: %, Requests: %, Tokens: %, Cost: $%',
            r.month, r.function_type, r.request_count, r.total_tokens, ROUND(r.total_cost::NUMERIC, 4);
        sum_tokens := sum_tokens + r.total_tokens;
        sum_cost := sum_cost + r.total_cost;
    END LOOP;

    RAISE NOTICE '';
    RAISE NOTICE '=== Total: % tokens, $% USD ===', sum_tokens, ROUND(sum_cost::NUMERIC, 4);
END $$;

-- 10. Backfill ai_prompts total_tokens and total_cost for existing records
UPDATE ai_prompts
SET
    total_tokens = (
        COALESCE((result_data->'usage'->>'input_tokens')::INTEGER, 0) +
        COALESCE((result_data->'usage'->>'output_tokens')::INTEGER, 0) +
        COALESCE((result_data->'usage'->>'cache_read_input_tokens')::INTEGER, 0) +
        COALESCE((result_data->'usage'->>'cache_creation_input_tokens')::INTEGER, 0)
    ),
    total_cost = calculate_token_cost(
        COALESCE(result_data->'usage'->>'model', 'claude-haiku-4-5'),
        COALESCE((result_data->'usage'->>'input_tokens')::INTEGER, 0),
        COALESCE((result_data->'usage'->>'output_tokens')::INTEGER, 0),
        COALESCE((result_data->'usage'->>'cache_read_input_tokens')::INTEGER, 0),
        COALESCE((result_data->'usage'->>'cache_creation_input_tokens')::INTEGER, 0)
    )
WHERE status = 'completed'
    AND result_data->'usage' IS NOT NULL;

-- Show backfill results
DO $$
DECLARE
    v_count INTEGER;
    v_total_tokens BIGINT;
    v_total_cost DECIMAL;
BEGIN
    SELECT COUNT(*), SUM(total_tokens), SUM(total_cost)
    INTO v_count, v_total_tokens, v_total_cost
    FROM ai_prompts
    WHERE status = 'completed' AND total_cost > 0;

    RAISE NOTICE '';
    RAISE NOTICE '=== Backfilled ai_prompts ===';
    RAISE NOTICE 'Records updated: %', v_count;
    RAISE NOTICE 'Total tokens: %', v_total_tokens;
    RAISE NOTICE 'Total cost: $% USD', ROUND(v_total_cost::NUMERIC, 4);
END $$;

-- Comments
COMMENT ON TABLE model_pricing IS 'Anthropic model pricing for dynamic cost calculation';
COMMENT ON FUNCTION get_model_pricing(TEXT) IS 'Get pricing for a model by name or alias';
COMMENT ON FUNCTION calculate_token_cost(TEXT, INTEGER, INTEGER, INTEGER, INTEGER) IS 'Calculate cost based on token usage and model pricing';
