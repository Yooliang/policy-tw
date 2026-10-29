-- VM 的 DiTrust 代號組別對照表 vm_ditrust_groups ＋ console_quota_now() 新增 ditrust_groups（唯讀，2026-10-29 維護者）
-- ============================================================
--
-- 背景：VM 上的 DiTrust 代號 dt1-a／dt1-b＝第 1 組帳號、dt2-*＝第 2 組、dt3-*＝第 3 組（同組共用同一個 DiTrust 帳號，所有 VM 共用這三組）。
-- 帳號額度按 actor_id（ditrust:<agent_id>）計，主控台要把代號節點畫成「該帳號的用量」，需要「第幾組 -> actor_id」對照。
-- 表裡只有公開識別（actor_id 是公開識別、不是憑證），沒有任何序號／金鑰。anon 可讀，寫入僅 service_role。
--
-- 【人工維護】換序號或組別重排時，要更新這張表（日後可加刷新腳本）；表裡的 display_name 只是後備，
-- 函式以 contributions 最近一筆該 actor_id 的 agent_name 為準（DiTrust 顯示名會改）。
--
-- console_quota_now()：以 20261029070000 的定義為底（20261029080000 只改 quota_limits，本函式未動），簽名與既有欄位不變，
-- 只新增 ditrust_groups 陣列：[{group_no, actor_id, display_name, submits, votes}]，submits／votes＝本時段、依 actor_id 計。授權不變。

CREATE TABLE IF NOT EXISTS vm_ditrust_groups (
  group_no     INTEGER PRIMARY KEY CHECK (group_no IN (1, 2, 3)),
  actor_id     TEXT NOT NULL UNIQUE,
  display_name TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE vm_ditrust_groups IS 'VM 的 DiTrust 代號組別 -> DiTrust 帳號 actor_id 對照（公開識別，無序號）。換序號或組別重排要人工更新。2026-10-29';

ALTER TABLE vm_ditrust_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON vm_ditrust_groups;
CREATE POLICY "Public read" ON vm_ditrust_groups FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON vm_ditrust_groups;
CREATE POLICY "Service role write" ON vm_ditrust_groups FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

INSERT INTO vm_ditrust_groups (group_no, actor_id, display_name) VALUES
  (1, 'ditrust:2f0eb1f5-8a6b-4032-9aa2-dbd79af27d0e', 'QiLiang'),
  (2, 'ditrust:1f27f3c3-f945-4b23-af67-753a9e814b41', '小雯'),
  (3, 'ditrust:3a8e867c-4813-4db0-80e5-9a1bac78775b', '涼糕')
ON CONFLICT (group_no) DO NOTHING;

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
  grp AS (
    SELECT g.group_no, g.actor_id,
           COALESCE((SELECT c.agent_name FROM contributions c WHERE c.actor_id = g.actor_id AND c.agent_name IS NOT NULL
                      ORDER BY c.created_at DESC LIMIT 1), g.display_name) AS display_name,
           (SELECT count(*) FROM contributions c, w WHERE c.actor_id = g.actor_id AND c.created_at >= w.ws) AS submits,
           (SELECT count(*) FROM contribution_votes cv, w WHERE cv.actor_id = g.actor_id AND cv.created_at >= w.ws) AS votes
      FROM vm_ditrust_groups g
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
                               FROM net_rank r JOIN net_agents na ON na.h = r.h WHERE r.rn <= 60), '[]'::jsonb),
    'ditrust_groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('group_no', group_no, 'actor_id', actor_id, 'display_name', display_name,
                                                                    'submits', submits, 'votes', votes) ORDER BY group_no) FROM grp), '[]'::jsonb)
  )
$$;
COMMENT ON FUNCTION console_quota_now IS '主控台 VM 頁（唯讀）：本時段各代理與各網段的提交／驗證用量，只回聚合數字與代理名稱，網段用順序代號。2026-10-29';

REVOKE ALL ON FUNCTION console_quota_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_quota_now() TO anon, authenticated, service_role;
