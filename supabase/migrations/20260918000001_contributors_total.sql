-- 統計卡「貢獻者」改成總數（2026-09-18）。
--
-- 為什麼不在前端用貢獻榜的人數：contribution_leaderboard 有 LIMIT 30，
-- 現在 13 人看不出來，超過 30 人以後「總數」會默默卡在 30。
-- 規則跟 contributors_30d 完全一樣（有提交過、不重複、排除測試代號），只是不限時間；
-- TS 規格 _shared/contribution-summary.ts 的 contributors_total 同步，守門測試盯著兩邊。
--
-- 整支重寫而不是 ALTER：CREATE OR REPLACE 若不寫 SECURITY DEFINER，函式會變回以呼叫者身分執行，
-- 匿名呼叫又只拿到 0（000013 修過一次）。所以屬性直接寫在定義裡。

CREATE OR REPLACE FUNCTION contribution_feed_summary()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH excluded AS (
  SELECT unnest(ARRAY[
    'test-deepseek','test-deepseek-1','test-deepseek-2','test-deepseek-3','test-deepseek-4','test-deepseek-5',
    'test-claude','test-gemini','xiaoliang-roster','xiaoliang-probe'
  ]) AS agent_name
),
c AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name, status, created_at
  FROM contributions
),
v AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name, created_at
  FROM contribution_votes
),
by_status AS (
  SELECT jsonb_object_agg(status, n) AS obj FROM (SELECT status, COUNT(*) n FROM c GROUP BY status) t
),
days AS (
  SELECT ((now() AT TIME ZONE 'Asia/Taipei')::date - i) AS d FROM generate_series(0, 6) i
),
daily AS (
  SELECT jsonb_agg(jsonb_build_object('date', to_char(d.d, 'YYYY-MM-DD'), 'count', s.n, 'verifications', vv.n) ORDER BY d.d) AS arr
  FROM days d
  LEFT JOIN LATERAL (SELECT COUNT(*) n FROM c WHERE (c.created_at AT TIME ZONE 'Asia/Taipei')::date = d.d) s ON TRUE
  LEFT JOIN LATERAL (SELECT COUNT(*) n FROM v WHERE (v.created_at AT TIME ZONE 'Asia/Taipei')::date = d.d) vv ON TRUE
),
contributors AS (
  SELECT COUNT(DISTINCT c.agent_name) AS n
  FROM c WHERE c.created_at >= now() - INTERVAL '30 days'
    AND c.agent_name NOT IN (SELECT agent_name FROM excluded)
),
contributors_all AS (
  SELECT COUNT(DISTINCT c.agent_name) AS n
  FROM c WHERE c.agent_name NOT IN (SELECT agent_name FROM excluded)
),
adjudicating AS (
  SELECT COUNT(*) AS n FROM contribution_tasks WHERE task_type = 'adjudicate' AND status = 'open'
)
SELECT jsonb_build_object(
  'total', (SELECT COUNT(*) FROM c),
  'by_status', COALESCE((SELECT obj FROM by_status), '{}'::jsonb),
  'needs_attention', jsonb_build_object(
    'total', (SELECT COUNT(*) FROM c WHERE status = 'disputed'),
    'disputed', (SELECT COUNT(*) FROM c WHERE status = 'disputed'),
    'retrying', (SELECT COUNT(*) FROM c WHERE status = 'apply_failed')
  ),
  'adjudicating', (SELECT n FROM adjudicating),
  'contributors_30d', (SELECT n FROM contributors),
  'contributors_total', (SELECT n FROM contributors_all),
  'daily_last_7', COALESCE((SELECT arr FROM daily), '[]'::jsonb),
  'leaderboard', contribution_leaderboard(NULL),
  'leaderboard_30d', contribution_leaderboard(30),
  'leaderboard_7d', contribution_leaderboard(7)
);
$$;

GRANT EXECUTE ON FUNCTION contribution_feed_summary() TO anon, authenticated, service_role;
