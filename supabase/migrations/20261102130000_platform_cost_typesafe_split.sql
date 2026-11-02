-- 捐款頁：OpenRouter 儲值帳戶與 TypeSafe 直連 Jev 分開顯示（2026-11-02）
-- OpenRouter 餘額等級仍讀 platform_costs（system-one?action=costs）；TypeSafe 無公開帳單 API，花費由 jev_decisions 依 model 分路徑加總。
-- 直連：typesafe/jev-1.13.0（語意版本）；OpenRouter 時期：typesafe/jev-1.13-20260917（日期後綴）。與 _shared/system-one.ts 的 MODEL_RE 一致。

CREATE OR REPLACE FUNCTION jev_model_is_typesafe_direct(p_model TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_model ~ '^typesafe/.+-[0-9]+\.[0-9]+\.[0-9]+$'
$$;
COMMENT ON FUNCTION jev_model_is_typesafe_direct IS 'jev_decisions.model 是否為 TypeSafe 直連（語意版本 x.y.z）';

CREATE OR REPLACE FUNCTION jev_model_is_openrouter_jev(p_model TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_model ~ '^typesafe/.+-[0-9]{8}$'
$$;
COMMENT ON FUNCTION jev_model_is_openrouter_jev IS 'jev_decisions.model 是否為經 OpenRouter 的 Jev（日期後綴 YYYYMMDD）';

DROP FUNCTION IF EXISTS platform_cost_public();

CREATE OR REPLACE FUNCTION platform_cost_public()
RETURNS TABLE (
  balance_level TEXT,
  openrouter_month_calls BIGINT,
  openrouter_month_usd NUMERIC,
  typesafe_month_calls BIGINT,
  typesafe_month_usd NUMERIC,
  db_bytes BIGINT,
  refreshed_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH month_start AS (
    SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei') AS t
  )
  SELECT platform_balance_level((SELECT openrouter_credits - openrouter_usage FROM platform_costs WHERE id = 1)),
         (SELECT COUNT(*) FROM jev_decisions j, month_start m
          WHERE j.asked_at >= m.t AND jev_model_is_openrouter_jev(j.model)),
         (SELECT ROUND(COALESCE(SUM(j.cost_usd), 0)::NUMERIC, 2) FROM jev_decisions j, month_start m
          WHERE j.asked_at >= m.t AND jev_model_is_openrouter_jev(j.model)),
         (SELECT COUNT(*) FROM jev_decisions j, month_start m
          WHERE j.asked_at >= m.t AND jev_model_is_typesafe_direct(j.model)),
         (SELECT ROUND(COALESCE(SUM(j.cost_usd), 0)::NUMERIC, 2) FROM jev_decisions j, month_start m
          WHERE j.asked_at >= m.t AND jev_model_is_typesafe_direct(j.model)),
         pg_database_size(current_database()),
         (SELECT p.refreshed_at FROM platform_costs p WHERE p.id = 1)
$$;
REVOKE ALL ON FUNCTION platform_cost_public() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_cost_public() TO anon, authenticated;
COMMENT ON FUNCTION platform_cost_public IS '捐款頁：OpenRouter 餘額等級（不含金額）、本月 OpenRouter／TypeSafe 直連 Jev 判定次數與花費（TypeSafe 依 jev_decisions 推算）、資料庫大小';

CREATE OR REPLACE FUNCTION platform_cost_summary()
RETURNS TABLE (balance_usd NUMERIC, jev_month_calls BIGINT, jev_month_usd NUMERIC, db_bytes BIGINT, refreshed_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH month_start AS (
    SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei') AS t
  ),
  pub AS (SELECT * FROM platform_cost_public() LIMIT 1)
  SELECT NULL::NUMERIC,
         (SELECT openrouter_month_calls + typesafe_month_calls FROM pub),
         (SELECT openrouter_month_usd + typesafe_month_usd FROM pub),
         (SELECT db_bytes FROM pub),
         (SELECT refreshed_at FROM pub)
$$;

NOTIFY pgrst, 'reload schema';
