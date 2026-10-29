-- console_quota_now()：網段用量拆成匿名與 DiTrust（唯讀，2026-10-29 維護者要求）
-- ============================================================
--
-- 原因：網段上限（每時段提交 80／驗證 200）只約束匿名；DiTrust 帳號另按 actor_id 算（500／1000），
-- 不受網段上限約束。舊版把兩者混在一起數，網段顯示「驗證 673／200」會誤導。
-- 新增欄位（原有欄位與簽名不變）：
--   per_network[]：submits_anon／votes_anon（匿名）、submits_ditrust／votes_ditrust（DiTrust）；submits／votes＝兩者合計
--   per_agent[]  ：is_ditrust（該代理名下本時段有任一筆 DiTrust 身份的紀錄則 true）
-- DiTrust 的判斷：actor_id LIKE 'ditrust:%'（actor.ts：匿名是 'ip:<雜湊>'，DiTrust 是 'ditrust:<agent_id>'）；
-- actor_id 為空的舊資料視為匿名。授權不變。

CREATE OR REPLACE FUNCTION console_quota_now() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH w AS (SELECT quota_window_start(now()) AS ws),
  s AS (SELECT c.agent_name, c.contributor_ip_hash AS h, (c.actor_id LIKE 'ditrust:%') AS dt FROM contributions c, w WHERE c.created_at >= w.ws),
  v AS (SELECT cv.agent_name, cv.verifier_ip_hash AS h, (cv.actor_id LIKE 'ditrust:%') AS dt FROM contribution_votes cv, w WHERE cv.created_at >= w.ws),
  agent_s AS (SELECT agent_name, count(*) AS n, bool_or(COALESCE(dt, false)) AS dt FROM s GROUP BY 1),
  agent_v AS (SELECT agent_name, count(*) AS n, bool_or(COALESCE(dt, false)) AS dt FROM v GROUP BY 1),
  per_agent AS (
    SELECT COALESCE(a.agent_name, b.agent_name) AS agent_name, COALESCE(a.n, 0) AS submits, COALESCE(b.n, 0) AS votes,
           (COALESCE(a.dt, false) OR COALESCE(b.dt, false)) AS is_ditrust
      FROM agent_s a FULL JOIN agent_v b ON a.agent_name = b.agent_name
  ),
  net_s AS (SELECT h, count(*) AS n, count(*) FILTER (WHERE COALESCE(dt, false)) AS dt FROM s GROUP BY 1),
  net_v AS (SELECT h, count(*) AS n, count(*) FILTER (WHERE COALESCE(dt, false)) AS dt FROM v GROUP BY 1),
  net AS (
    SELECT COALESCE(a.h, b.h) AS h, COALESCE(a.n, 0) AS submits, COALESCE(b.n, 0) AS votes,
           COALESCE(a.dt, 0) AS submits_dt, COALESCE(b.dt, 0) AS votes_dt
      FROM net_s a FULL JOIN net_v b ON a.h = b.h
  ),
  net_rank AS (
    SELECT n.*, row_number() OVER (ORDER BY n.submits + n.votes DESC, n.h) AS rn FROM net n
  ),
  net_agents AS (
    SELECT h, array_agg(DISTINCT agent_name ORDER BY agent_name) AS agents
      FROM (SELECT h, agent_name FROM s UNION SELECT h, agent_name FROM v) u GROUP BY h
  )
  SELECT quota_limits() || jsonb_build_object(
    'window_start', (SELECT ws FROM w),
    'window_resets_at', (SELECT ws FROM w) + interval '4 hours',
    'per_agent', COALESCE((SELECT jsonb_agg(jsonb_build_object('agent_name', agent_name, 'submits', submits, 'votes', votes, 'is_ditrust', is_ditrust)
                                            ORDER BY submits + votes DESC, agent_name) FROM per_agent), '[]'::jsonb),
    'per_network', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                               'network', CASE WHEN r.rn <= 26 THEN chr(64 + r.rn::int) ELSE 'N' || r.rn END,
                               'submits', r.submits, 'votes', r.votes,
                               'submits_anon', r.submits - r.submits_dt, 'votes_anon', r.votes - r.votes_dt,
                               'submits_ditrust', r.submits_dt, 'votes_ditrust', r.votes_dt, 'agents', to_jsonb(na.agents)) ORDER BY r.rn)
                               FROM net_rank r JOIN net_agents na ON na.h = r.h WHERE r.rn <= 60), '[]'::jsonb)
  )
$$;
COMMENT ON FUNCTION console_quota_now IS '主控台 VM 頁（唯讀）：本時段各代理與各網段的提交／驗證用量，只回聚合數字與代理名稱，網段用順序代號。2026-10-29';

REVOKE ALL ON FUNCTION console_quota_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_quota_now() TO anon, authenticated, service_role;
