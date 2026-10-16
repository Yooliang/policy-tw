-- 日本站跟進正見 20261016000001_stats_activity_hourly.sql：提交與驗證 168 小時內按小時（維護者 2026-10-16）
-- 抄法同 20261009200000（R1 policy_jp. 前綴、R2 search_path）；逐字比對在 policy-jp-public-stats.test.ts（STATS_FOLLOWED 改讀這支）。
-- 權限沿用 20261009200000（CREATE OR REPLACE 不動既有授權），這裡再寫一次讓這支單獨也成立。
CREATE OR REPLACE FUNCTION policy_jp.contribution_activity(p_hours INTEGER DEFAULT 168)
RETURNS TABLE (bucket TEXT, submissions BIGINT, verifications BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT LEAST(GREATEST(COALESCE(p_hours, 168), 1), 24 * 90) AS h
  ),
  unit AS (SELECT CASE WHEN h <= 168 THEN 'hour' ELSE 'day' END AS u, h FROM p),
  series AS (
    SELECT generate_series(
             date_trunc((SELECT u FROM unit), (now() AT TIME ZONE 'Asia/Taipei') - make_interval(hours => (SELECT h FROM unit) - 1)),
             date_trunc((SELECT u FROM unit), now() AT TIME ZONE 'Asia/Taipei'),
             CASE WHEN (SELECT u FROM unit) = 'hour' THEN INTERVAL '1 hour' ELSE INTERVAL '1 day' END) AS b
  ),
  s AS (
    SELECT date_trunc((SELECT u FROM unit), c.created_at AT TIME ZONE 'Asia/Taipei') AS b, COUNT(*) AS n
      FROM policy_jp.contributions c
     WHERE c.created_at > now() - make_interval(hours => (SELECT h FROM unit))
     GROUP BY 1
  ),
  v AS (
    SELECT date_trunc((SELECT u FROM unit), x.created_at AT TIME ZONE 'Asia/Taipei') AS b, COUNT(*) AS n
      FROM policy_jp.contribution_votes x
     WHERE x.created_at > now() - make_interval(hours => (SELECT h FROM unit))
     GROUP BY 1
  )
  SELECT CASE WHEN (SELECT u FROM unit) = 'day' THEN to_char(series.b, 'MM-DD')
              WHEN (SELECT h FROM unit) <= 48 THEN to_char(series.b, 'HH24:00')
              ELSE to_char(series.b, 'MM-DD HH24:00') END,
         COALESCE(s.n, 0), COALESCE(v.n, 0)
    FROM series LEFT JOIN s ON s.b = series.b LEFT JOIN v ON v.b = series.b
   ORDER BY series.b
$$;
COMMENT ON FUNCTION policy_jp.contribution_activity(INTEGER) IS
  '提交與驗證（日本站，正見的複本）：最近 p_hours 小時，168 小時內按小時（48 小時以上的標籤帶日期）、以上按天（台北時間）。anon 可呼叫';
REVOKE ALL ON FUNCTION policy_jp.contribution_activity(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_activity(INTEGER) TO anon, authenticated, service_role;
