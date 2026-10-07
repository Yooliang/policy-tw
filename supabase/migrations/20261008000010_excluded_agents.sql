-- 貢獻榜的測試代號排除清單搬到表 excluded_agents（盤點 #5，2026-10-07 維護者同意）
--
-- 起因：公開的貢獻榜與「貢獻者」數字要排除維護者自己開的測試與探測代號，名單原本寫死在三支 SQL 函式裡
-- （contribution_leaderboard 的天數版與區間版、contribution_feed_summary 的兩個子查詢），再加 TS 一份；
-- 每出現一個新測試代號就要發 migration、改三處。貢獻榜是公開頁、選前流量最大，名單漏一個就是榜被測試帳號污染。
--
-- 做法：新表 excluded_agents(agent_name, reason, added_at)；三支函式的 excluded CTE 改成 SELECT agent_name FROM excluded_agents。
-- 種子＝原本寫死的 10 個代號，一個不多一個不少。以後加新的測試代號：INSERT INTO excluded_agents，不用發版。
-- 行為不變：函式的其餘部分一個字沒動（SECURITY DEFINER、search_path、排序、榜長 30、時間窗全部原樣）。
--
-- 這是「營運值」：只決定誰不上榜；計分（submitted + applied + verified_votes）、榜長、窗口天數都沒動。
-- 刻意明列代號、不用 test-／xiaoliang- 前綴：前綴會誤殺未來真的這樣取名的貢獻者（沿用 contribution-summary.ts 的原則）。

CREATE TABLE IF NOT EXISTS excluded_agents (
  agent_name TEXT PRIMARY KEY CHECK (agent_name = btrim(agent_name) AND agent_name <> ''),
  reason TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE excluded_agents IS
  '不列入貢獻榜與「貢獻者」數字的代號（維護者自己開的測試與探測代理）。它們交的資料是真的，但不是外部參與者；數字不能說謊。contribution_leaderboard、contribution_feed_summary 讀這張表。比對的是 btrim 後的 agent_name，要明列代號（不用前綴）';

ALTER TABLE excluded_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON excluded_agents;
CREATE POLICY "Public read" ON excluded_agents FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON excluded_agents;
CREATE POLICY "Service role write" ON excluded_agents FOR ALL USING (auth.role() = 'service_role');
GRANT SELECT ON excluded_agents TO anon, authenticated;

-- 種子：原本寫死的 10 個（contribution-summary.ts 的 EXCLUDED_AGENTS 同一份，contribution-summary.test.ts 對照）
INSERT INTO excluded_agents (agent_name, reason, added_at) VALUES
  ('test-deepseek',   '2026-09-11 盲測協議用的多方代理', TIMESTAMPTZ '2026-09-11 00:00:00+08'),
  ('test-deepseek-1', '2026-09-11 盲測協議用的多方代理', TIMESTAMPTZ '2026-09-11 00:00:00+08'),
  ('test-deepseek-2', '2026-09-11 盲測協議用的多方代理', TIMESTAMPTZ '2026-09-11 00:00:00+08'),
  ('test-deepseek-3', '2026-09-11 盲測協議用的多方代理', TIMESTAMPTZ '2026-09-11 00:00:00+08'),
  ('test-deepseek-4', '2026-09-11 盲測協議用的多方代理', TIMESTAMPTZ '2026-09-11 00:00:00+08'),
  ('test-deepseek-5', '2026-09-11 盲測協議用的多方代理', TIMESTAMPTZ '2026-09-11 00:00:00+08'),
  ('test-claude',     '2026-09-11 盲測協議用的多方代理', TIMESTAMPTZ '2026-09-11 00:00:00+08'),
  ('test-gemini',     '2026-09-11 盲測協議用的多方代理', TIMESTAMPTZ '2026-09-11 00:00:00+08'),
  ('xiaoliang-roster','2026-09-12 驗證派工／清查流程時的探測代號（送出的貢獻都已退件）', TIMESTAMPTZ '2026-09-12 00:00:00+08'),
  ('xiaoliang-probe', '2026-09-12 驗證派工／清查流程時的探測代號（送出的貢獻都已退件）', TIMESTAMPTZ '2026-09-12 00:00:00+08')
ON CONFLICT (agent_name) DO NOTHING;

CREATE OR REPLACE FUNCTION contribution_leaderboard(p_days integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public
AS $$
WITH excluded AS (
  -- 測試與探測代號讀 excluded_agents（以前是這裡寫死的一串名字，同一串抄在三支函式裡）
  SELECT agent_name FROM excluded_agents
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

CREATE OR REPLACE FUNCTION contribution_leaderboard(p_since timestamp with time zone, p_until timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public
AS $$
WITH excluded AS (
  -- 測試與探測代號讀 excluded_agents（以前是這裡寫死的一串名字，同一串抄在三支函式裡）
  SELECT agent_name FROM excluded_agents
),
sub AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name,
         COUNT(*) AS submitted,
         COUNT(*) FILTER (WHERE status = 'applied') AS applied
  FROM contributions
  WHERE (p_since IS NULL OR created_at >= p_since) AND (p_until IS NULL OR created_at < p_until)
  GROUP BY 1
),
vot AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name, COUNT(*) AS verified_votes
  FROM contribution_votes
  WHERE (p_since IS NULL OR created_at >= p_since) AND (p_until IS NULL OR created_at < p_until)
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

CREATE OR REPLACE FUNCTION contribution_feed_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public
AS $$
WITH excluded AS (
  -- 測試與探測代號讀 excluded_agents（以前是這裡寫死的一串名字，同一串抄在三支函式裡）
  SELECT agent_name FROM excluded_agents
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
