-- AI 判定帳戶的餘額不公開（維護者 2026-10-21：「不用讓訪客知道我們剩多少呀」）
-- ============================================================
--
-- 原本：platform_costs 有 `platform_costs_public_read USING (true)`，anon 直接 GET /rest/v1/platform_costs 就看得到
-- openrouter_credits／openrouter_usage；RPC platform_cost_summary() 也回 balance_usd。
-- 現在：
--   1. platform_costs 拿掉公開 policy、收回 anon／authenticated 的表權限（RLS 仍開著；寫入端 system-one 用 service_role，BYPASSRLS）。
--   2. 公開出口改成 platform_cost_public()：只回 balance_level（ok／yellow／orange／red）、本月 Jev 判定次數與花費、資料庫大小。
--      等級門檻由資料庫算：< 5 黃、< 3 橘、< 1 紅（platform_balance_level()；前端常數 lib/agent-plans.ts 的 BALANCE_*_USD 要一致，測試對齊）。
--   3. 舊的 platform_cost_summary() 簽章不能直接改（CI 先 db push 再部署，舊前端還在打它），所以保留簽章、balance_usd 一律回 NULL；
--      舊前端拿到 NULL 只是不上色。確認線上前端都改用 platform_cost_public() 之後，下一支 migration 再把它刪掉。

CREATE OR REPLACE FUNCTION platform_balance_level(p_balance NUMERIC)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_balance IS NULL THEN 'ok'
    WHEN p_balance < 1 THEN 'red'
    WHEN p_balance < 3 THEN 'orange'
    WHEN p_balance < 5 THEN 'yellow'
    ELSE 'ok'
  END
$$;
COMMENT ON FUNCTION platform_balance_level IS 'AI 判定帳戶餘額的等級：< 1 red、< 3 orange、< 5 yellow，其餘 ok（沒有資料也 ok）；門檻要跟 lib/agent-plans.ts 的 BALANCE_*_USD 一致';

DROP POLICY IF EXISTS platform_costs_public_read ON platform_costs;
REVOKE ALL ON TABLE platform_costs FROM PUBLIC;
REVOKE ALL ON TABLE platform_costs FROM anon;
REVOKE ALL ON TABLE platform_costs FROM authenticated;

CREATE OR REPLACE FUNCTION platform_cost_public()
RETURNS TABLE (balance_level TEXT, jev_month_calls BIGINT, jev_month_usd NUMERIC, db_bytes BIGINT, refreshed_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH month_start AS (
    SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei') AS t
  )
  SELECT platform_balance_level((SELECT openrouter_credits - openrouter_usage FROM platform_costs WHERE id = 1)),
         (SELECT COUNT(*) FROM jev_decisions j, month_start m WHERE j.asked_at >= m.t AND j.model LIKE 'typesafe/%'),
         (SELECT ROUND(COALESCE(SUM(j.cost_usd), 0)::NUMERIC, 2) FROM jev_decisions j, month_start m WHERE j.asked_at >= m.t),
         pg_database_size(current_database()),
         (SELECT p.refreshed_at FROM platform_costs p WHERE p.id = 1)
$$;
REVOKE ALL ON FUNCTION platform_cost_public() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_cost_public() TO anon, authenticated;
COMMENT ON FUNCTION platform_cost_public IS '捐款頁：AI 判定帳戶餘額「等級」（不含金額）、本月 Jev 判定次數與花費、資料庫大小';

CREATE OR REPLACE FUNCTION platform_cost_summary()
RETURNS TABLE (balance_usd NUMERIC, jev_month_calls BIGINT, jev_month_usd NUMERIC, db_bytes BIGINT, refreshed_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH month_start AS (
    SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei') AS t
  )
  SELECT NULL::NUMERIC,
         (SELECT COUNT(*) FROM jev_decisions j, month_start m WHERE j.asked_at >= m.t AND j.model LIKE 'typesafe/%'),
         (SELECT ROUND(COALESCE(SUM(j.cost_usd), 0)::NUMERIC, 2) FROM jev_decisions j, month_start m WHERE j.asked_at >= m.t),
         pg_database_size(current_database()),
         (SELECT p.refreshed_at FROM platform_costs p WHERE p.id = 1)
$$;
COMMENT ON FUNCTION platform_cost_summary IS '已停用（2026-10-21）：balance_usd 不再公開、一律 NULL；改用 platform_cost_public()。舊前端相容用，之後的 migration 刪除';

NOTIFY pgrst, 'reload schema';
