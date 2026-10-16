-- 統計頁「提交與驗證」7D 改按小時（維護者 2026-10-16，policy-ops docs/decisions/2026-10-16-統計頁7D按小時.md）
-- 原本 48 小時內按小時、以上按天；改成 7 天（168 小時）內都按小時。48 小時以內的標籤照舊 HH:00，
-- 超過 48 小時的小時桶帶日期（MM-DD HH:00，一週裡同一個鐘點會出現七次）；30D／90D 照舊按天（MM-DD）。
-- 日本站的複本在 20261016000002_policy_jp_stats_activity_hourly.sql 跟進。
CREATE OR REPLACE FUNCTION contribution_activity(p_hours INTEGER DEFAULT 168)
RETURNS TABLE (bucket TEXT, submissions BIGINT, verifications BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
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
      FROM contributions c
     WHERE c.created_at > now() - make_interval(hours => (SELECT h FROM unit))
     GROUP BY 1
  ),
  v AS (
    SELECT date_trunc((SELECT u FROM unit), x.created_at AT TIME ZONE 'Asia/Taipei') AS b, COUNT(*) AS n
      FROM contribution_votes x
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
GRANT EXECUTE ON FUNCTION contribution_activity(INTEGER) TO anon, authenticated;
COMMENT ON FUNCTION contribution_activity IS '統計頁「提交與驗證」：最近 p_hours 小時，168 小時內按小時（48 小時以上的標籤帶日期）、以上按天（台北時間）';
