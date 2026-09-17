-- 動態牆的統計改在資料庫算，不再把整份資料撈進 Edge Function。
--
-- 2026-09-17 小良哥問「fetchAllRows 會不會造成伺服器的負擔」——會。
-- 起因是更早發現的那個 bug：PostgREST 一次最多回 1000 列，程式寫 .limit(20000) 沒有用，
-- 於是貢獻榜的驗證票合計卡死在 1000、貢獻總數也卡在 1000（實際已有 1,430 筆）。
-- 當時先用翻頁撈止血，代價是每次載入動態牆都要把上千列搬進函式再算一次，
-- 而資料每天 +400 筆，那個成本只會越長越大。
--
-- 這一支一次 GROUP BY 算完，回傳的形狀與 _shared/contribution-summary.ts 的 FeedSummary 相同。
-- 規則鏡射那一份（由 contribution-summary.test.ts 的守門測試盯著兩邊不要漂開）：
--   * 代號空白視為 (unknown)
--   * 測試代號不上榜、也不算「近 30 天貢獻者」
--   * 分數 = 提交 + 上線 + 驗證票；同分時先看上線、再看提交
--   * 榜取前 30、分數 0 不上榜
--   * 每日統計用台灣時間（UTC+8）分日

-- 貢獻榜：p_days = NULL 是總榜，30／7 是時間窗
CREATE OR REPLACE FUNCTION contribution_leaderboard(p_days INTEGER)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
WITH excluded AS (
  SELECT unnest(ARRAY[
    'test-deepseek','test-deepseek-1','test-deepseek-2','test-deepseek-3','test-deepseek-4','test-deepseek-5',
    'test-claude','test-gemini','xiaoliang-roster','xiaoliang-probe'
  ]) AS agent_name
),
since AS (SELECT CASE WHEN p_days IS NULL THEN NULL ELSE now() - make_interval(days => p_days) END AS ts),
sub AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name,
         COUNT(*) AS submitted,
         COUNT(*) FILTER (WHERE status = 'applied') AS applied
  FROM contributions
  WHERE (SELECT ts FROM since) IS NULL OR created_at >= (SELECT ts FROM since)
  GROUP BY 1
),
vot AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name, COUNT(*) AS verified_votes
  FROM contribution_votes
  WHERE (SELECT ts FROM since) IS NULL OR created_at >= (SELECT ts FROM since)
  GROUP BY 1
),
merged AS (
  SELECT COALESCE(s.agent_name, v.agent_name) AS agent_name,
         COALESCE(s.submitted, 0) AS submitted,
         COALESCE(s.applied, 0) AS applied,
         COALESCE(v.verified_votes, 0) AS verified_votes
  FROM sub s FULL OUTER JOIN vot v ON v.agent_name = s.agent_name
)
SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'score')::int DESC, (x->>'applied')::int DESC, (x->>'submitted')::int DESC), '[]'::jsonb)
FROM (
  SELECT jsonb_build_object(
    'agent_name', agent_name,
    'submitted', submitted,
    'applied', applied,
    'verified_votes', verified_votes,
    'score', submitted + applied + verified_votes
  ) AS x
  FROM merged
  WHERE agent_name NOT IN (SELECT agent_name FROM excluded)
    AND submitted + applied + verified_votes > 0
  ORDER BY submitted + applied + verified_votes DESC, applied DESC, submitted DESC
  LIMIT 30
) t;
$$;

COMMENT ON FUNCTION contribution_leaderboard IS
  '貢獻榜：分數 = 提交 + 上線 + 驗證票，同分先看上線再看提交，取前 30；測試代號不上榜。p_days NULL＝總榜。';

CREATE OR REPLACE FUNCTION contribution_feed_summary()
RETURNS JSONB
LANGUAGE sql
STABLE
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
  'daily_last_7', COALESCE((SELECT arr FROM daily), '[]'::jsonb),
  'leaderboard', contribution_leaderboard(NULL),
  'leaderboard_30d', contribution_leaderboard(30),
  'leaderboard_7d', contribution_leaderboard(7)
);
$$;

COMMENT ON FUNCTION contribution_feed_summary IS
  '動態牆的統計（總數、各狀態、近 7 日、貢獻榜三個時間窗）。規則鏡射 _shared/contribution-summary.ts。';

GRANT EXECUTE ON FUNCTION contribution_feed_summary() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION contribution_leaderboard(INTEGER) TO anon, authenticated, service_role;
