-- 統計頁的「提交與驗證」「AI 讀取」跟著整頁時間窗走（24h／7D／30D／90D；小良哥 2026-09-24）
-- 原本提交與驗證只有 contributions-feed 的 daily_last_7，AI 讀取前端直接讀 ai_reads_daily 7 天（90 天會超過 1,000 列上限）。
-- 兩個都改成資料庫端聚合，前端只拿結果。

-- 提交與驗證：48 小時以內按小時、以上按天（台北時間）
CREATE OR REPLACE FUNCTION contribution_activity(p_hours INTEGER DEFAULT 168)
RETURNS TABLE (bucket TEXT, submissions BIGINT, verifications BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH p AS (
    SELECT LEAST(GREATEST(COALESCE(p_hours, 168), 1), 24 * 90) AS h
  ),
  unit AS (SELECT CASE WHEN h <= 48 THEN 'hour' ELSE 'day' END AS u, h FROM p),
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
  SELECT CASE WHEN (SELECT u FROM unit) = 'hour' THEN to_char(series.b, 'HH24:00') ELSE to_char(series.b, 'MM-DD') END,
         COALESCE(s.n, 0), COALESCE(v.n, 0)
    FROM series LEFT JOIN s ON s.b = series.b LEFT JOIN v ON v.b = series.b
   ORDER BY series.b
$$;
GRANT EXECUTE ON FUNCTION contribution_activity(INTEGER) TO anon, authenticated;
COMMENT ON FUNCTION contribution_activity IS '統計頁「提交與驗證」：最近 p_hours 小時，48 小時內按小時、以上按天（台北時間）';

-- AI 讀取：最近 p_days 天，按類別與代理加總
CREATE OR REPLACE FUNCTION ai_reads_summary(p_days INTEGER DEFAULT 7)
RETURNS TABLE (kind TEXT, agent TEXT, hits BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.kind, r.agent, SUM(r.hits)::BIGINT
    FROM ai_reads_daily r
   WHERE r.day > (now() AT TIME ZONE 'Asia/Taipei')::DATE - LEAST(GREATEST(COALESCE(p_days, 7), 1), 90)
   GROUP BY r.kind, r.agent
$$;
GRANT EXECUTE ON FUNCTION ai_reads_summary(INTEGER) TO anon, authenticated;
COMMENT ON FUNCTION ai_reads_summary IS '統計頁「AI 讀取」：最近 p_days 天（台北日期），按類別與代理加總';
