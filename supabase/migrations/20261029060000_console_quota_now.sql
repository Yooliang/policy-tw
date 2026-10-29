-- 主控台 VM 頁「各代理本時段的額度用量」（唯讀，2026-10-29 維護者要求）
-- ============================================================
--
-- 三支函式，不動任何端點、資料、額度規則：
--   * quota_window_start(timestamptz)：與 _shared/quota-window.ts 的 quotaWindowStart 同一個定義——
--     先換成台北時間（Asia/Taipei），小時數往下捨到 4 的倍數，再換回絕對時間。測試逐案對 TS。
--   * quota_limits()：四個上限（每網段提交 80／驗證 200、DiTrust 帳號提交 500／驗證 1000）。
--     數字與 contribute-handler／verify-handler 的常數是兩份，測試逐一比對，走樣就紅。
--   * console_quota_now()：本時段用量的聚合數字，只回數字與代理名稱，不回內容、不回完整 IP 雜湊。
--       window_start、window_resets_at、per_ip_*／per_ditrust_* 上限、
--       per_agent  [{agent_name, submits, votes}]   submits＝contributions、votes＝contribution_votes
--                                                   （與提交／驗證額度同口徑：created_at ≥ 時段起點，不排除任何狀態）
--       per_network[{network, submits, votes, agents}] 依 contributor_ip_hash／verifier_ip_hash 分組；network 是依用量排序的
--                                                   順序代號 A、B、C…（超過 26 個用 N27…），完整雜湊不外洩；最多 60 組
-- 授權比照 console_queue_state：SECURITY DEFINER、釘 search_path、REVOKE ALL FROM PUBLIC、GRANT EXECUTE 給 anon／authenticated／service_role。

CREATE OR REPLACE FUNCTION quota_window_start(p_now timestamptz DEFAULT now()) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (date_trunc('hour', p_now AT TIME ZONE 'Asia/Taipei')
          - make_interval(hours => (extract(hour FROM p_now AT TIME ZONE 'Asia/Taipei'))::int % 4)) AT TIME ZONE 'Asia/Taipei'
$$;
COMMENT ON FUNCTION quota_window_start IS '額度時段起點（台北 00／04／08／12／16／20 點），與 quota-window.ts 的 quotaWindowStart 逐案對齊。2026-10-29';

CREATE OR REPLACE FUNCTION quota_limits() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('per_ip_submit_limit', 80, 'per_ip_verify_limit', 200,
                            'per_ditrust_submit_limit', 500, 'per_ditrust_verify_limit', 1000)
$$;
COMMENT ON FUNCTION quota_limits IS '每時段額度上限；與 contribute-handler／verify-handler 的常數由測試比對。2026-10-29';

CREATE OR REPLACE FUNCTION console_quota_now() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH w AS (SELECT quota_window_start(now()) AS ws),
  s AS (SELECT c.agent_name, c.contributor_ip_hash AS h FROM contributions c, w WHERE c.created_at >= w.ws),
  v AS (SELECT cv.agent_name, cv.verifier_ip_hash AS h FROM contribution_votes cv, w WHERE cv.created_at >= w.ws),
  agent_s AS (SELECT agent_name, count(*) AS n FROM s GROUP BY 1),
  agent_v AS (SELECT agent_name, count(*) AS n FROM v GROUP BY 1),
  per_agent AS (
    SELECT COALESCE(a.agent_name, b.agent_name) AS agent_name, COALESCE(a.n, 0) AS submits, COALESCE(b.n, 0) AS votes
      FROM agent_s a FULL JOIN agent_v b ON a.agent_name = b.agent_name
  ),
  net_s AS (SELECT h, count(*) AS n FROM s GROUP BY 1),
  net_v AS (SELECT h, count(*) AS n FROM v GROUP BY 1),
  net AS (
    SELECT COALESCE(a.h, b.h) AS h, COALESCE(a.n, 0) AS submits, COALESCE(b.n, 0) AS votes
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
    'per_agent', COALESCE((SELECT jsonb_agg(jsonb_build_object('agent_name', agent_name, 'submits', submits, 'votes', votes)
                                            ORDER BY submits + votes DESC, agent_name) FROM per_agent), '[]'::jsonb),
    'per_network', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                               'network', CASE WHEN r.rn <= 26 THEN chr(64 + r.rn::int) ELSE 'N' || r.rn END,
                               'submits', r.submits, 'votes', r.votes, 'agents', to_jsonb(na.agents)) ORDER BY r.rn)
                               FROM net_rank r JOIN net_agents na ON na.h = r.h WHERE r.rn <= 60), '[]'::jsonb)
  )
$$;
COMMENT ON FUNCTION console_quota_now IS '主控台 VM 頁（唯讀）：本時段各代理與各網段的提交／驗證用量，只回聚合數字與代理名稱，網段用順序代號。2026-10-29';

REVOKE ALL ON FUNCTION console_quota_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_quota_now() TO anon, authenticated, service_role;
