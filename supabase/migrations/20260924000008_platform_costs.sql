-- 捐款頁的運轉成本（小良哥 2026-09-24，W-Policy 轉：「不用太顯眼，一個基本的資料就好」）
--
-- AI 判定（Jev）的帳戶餘額要帶金鑰才查得到，所以由後端排程每 15 分鐘查一次存進 platform_costs，頁面只讀這張表。
-- 餘額用 OpenRouter /credits 的 total_credits − total_usage（不是 /key 的 limit_remaining，那是花費上限，W-Policy 踩過）。
-- 這個帳戶與其他專案共用；正見自己的 AI 花費用 jev_decisions.cost_usd 加總，兩者分開顯示。

CREATE TABLE IF NOT EXISTS platform_costs (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  openrouter_credits  NUMERIC,
  openrouter_usage    NUMERIC,
  refreshed_at        TIMESTAMPTZ
);
COMMENT ON TABLE platform_costs IS 'AI 判定帳戶的儲值與已用（system-one?action=costs 每 15 分鐘更新）；捐款頁顯示用';
ALTER TABLE platform_costs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_costs_public_read ON platform_costs;
CREATE POLICY platform_costs_public_read ON platform_costs FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION platform_cost_summary()
RETURNS TABLE (balance_usd NUMERIC, jev_month_calls BIGINT, jev_month_usd NUMERIC, db_bytes BIGINT, refreshed_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH month_start AS (
    SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei') AS t
  )
  SELECT (SELECT openrouter_credits - openrouter_usage FROM platform_costs WHERE id = 1),
         (SELECT COUNT(*) FROM jev_decisions j, month_start m WHERE j.asked_at >= m.t AND j.model LIKE 'typesafe/%'),
         (SELECT ROUND(COALESCE(SUM(j.cost_usd), 0)::NUMERIC, 2) FROM jev_decisions j, month_start m WHERE j.asked_at >= m.t),
         pg_database_size(current_database()),
         (SELECT refreshed_at FROM platform_costs WHERE id = 1)
$$;
REVOKE ALL ON FUNCTION platform_cost_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_cost_summary() TO anon, authenticated;
COMMENT ON FUNCTION platform_cost_summary IS '捐款頁：AI 判定帳戶餘額、本月 Jev 判定次數與花費、資料庫大小';

SELECT cron.unschedule('platform-costs-15min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'platform-costs-15min');
SELECT cron.schedule(
  'platform-costs-15min',
  '7,22,37,52 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=costs',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );$$
);
