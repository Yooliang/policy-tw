-- 帳號額度歷史快照（2026-11-09，維護者小良：VM 頁要看燒速、預估用完時間、產出效率與圖表）
-- ============================================================
--
-- 來源：quota-read（外部只讀端點，只回每個帳號「最新一筆」）。console-vm 新增唯讀 action snapshot_quota_history，
-- 每 10 分鐘由 pg_cron（沿用 agent_usage_cron_secret 的 x-cron-secret 驗證）觸發，把每個帳號每個視窗的已用 %
-- 寫進這張表；captured_at＝上報端的 reported_at，所以同一筆上報被輪詢多次也只留一列（主鍵擋掉重複）。
-- 這張表不公開：只開 RLS、不建 policy，anon／authenticated 讀不到，只有 console-vm 的 service_role 能寫／讀。
-- account_key＝憑證代號（c／y／g／grok／m1／m2／a1），不存 email 與帳號名。保留 8 天（每天清一次）。

CREATE TABLE IF NOT EXISTS quota_snapshots (
  account_key   TEXT NOT NULL,
  window_label  TEXT NOT NULL,
  used_pct      NUMERIC NOT NULL CHECK (used_pct >= 0 AND used_pct <= 100),
  resets_at     TIMESTAMPTZ,
  captured_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_key, window_label, captured_at)
);
COMMENT ON TABLE quota_snapshots IS '各帳號各額度視窗的已用％歷史（每 10 分鐘由 console-vm snapshot_quota_history 寫入，保留 8 天）；不公開，只有 service_role';
CREATE INDEX IF NOT EXISTS idx_quota_snapshots_captured ON quota_snapshots (captured_at);
ALTER TABLE quota_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON quota_snapshots FROM anon, authenticated;

-- 產出（貢獻／投票）按時間查：原本只有 status_created、沒有單獨的 created_at 索引
CREATE INDEX IF NOT EXISTS idx_contributions_created_at ON contributions (created_at);
CREATE INDEX IF NOT EXISTS idx_contribution_votes_created_at ON contribution_votes (created_at);

-- ── 給 console-vm 的唯讀彙整（一次回一個 jsonb，避開 PostgREST 的 1000 列上限）─────────────
-- 代理名字尾碼（_cc01／_mm02／_ag01… 後面可接 @tw／@jp）就是帳號代碼；對不上的歸 'other'。
-- 回傳：
--   snapshots：[[account_key, window_label, used_pct, resets_at(ms|null), captured_at(ms)]…]，每 p_bucket_min 分鐘一格取最後一筆
--   output   ：[[hour(ms), code, contributions, votes]…]，p_hours 內每小時、每帳號代碼（正見＋日本站）
--   agents   ：[[agent_name, hour(ms), contributions, votes]…]，最近 24 小時、合計最多的前 12 隻
--   eff24    ：[[code, contributions, votes]…]，剛好最近 24 小時
CREATE OR REPLACE FUNCTION public.quota_history(p_hours integer, p_bucket_min integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, policy_jp, pg_temp
AS $$
  WITH p AS (
    SELECT LEAST(GREATEST(COALESCE(p_hours, 24), 1), 192) AS h, LEAST(GREATEST(COALESCE(p_bucket_min, 10), 10), 240) AS b
  ),
  snaps AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_array(account_key, window_label, used_pct, (extract(epoch FROM resets_at) * 1000)::bigint, (extract(epoch FROM captured_at) * 1000)::bigint) ORDER BY captured_at), '[]'::jsonb) AS j
      FROM (
        SELECT DISTINCT ON (q.account_key, q.window_label, floor(extract(epoch FROM q.captured_at) / (p.b * 60)))
               q.account_key, q.window_label, q.used_pct, q.resets_at, q.captured_at
          FROM quota_snapshots q, p
         WHERE q.captured_at > now() - make_interval(hours => p.h)
         ORDER BY q.account_key, q.window_label, floor(extract(epoch FROM q.captured_at) / (p.b * 60)), q.captured_at DESC
      ) s
  ),
  ev AS MATERIALIZED (
    SELECT agent_name, created_at, 'c'::text AS k FROM public.contributions, p WHERE created_at > now() - make_interval(hours => p.h)
    UNION ALL SELECT agent_name, created_at, 'v' FROM public.contribution_votes, p WHERE created_at > now() - make_interval(hours => p.h)
    UNION ALL SELECT agent_name, created_at, 'c' FROM policy_jp.contributions, p WHERE created_at > now() - make_interval(hours => p.h)
    UNION ALL SELECT agent_name, created_at, 'v' FROM policy_jp.contribution_votes, p WHERE created_at > now() - make_interval(hours => p.h)
  ),
  outp AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_array(hr, code, c, v) ORDER BY hr), '[]'::jsonb) AS j
      FROM (
        SELECT (extract(epoch FROM date_trunc('hour', created_at)) * 1000)::bigint AS hr,
               COALESCE(substring(agent_name FROM '_([a-z]{2}[0-9]{2})(@|$)'), 'other') AS code,
               count(*) FILTER (WHERE k = 'c') AS c, count(*) FILTER (WHERE k = 'v') AS v
          FROM ev GROUP BY 1, 2
      ) o
  ),
  topag AS (
    SELECT agent_name FROM ev WHERE created_at > now() - interval '24 hours' GROUP BY agent_name ORDER BY count(*) DESC LIMIT 12
  ),
  ag AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_array(agent_name, hr, c, v) ORDER BY agent_name, hr), '[]'::jsonb) AS j
      FROM (
        SELECT e.agent_name, (extract(epoch FROM date_trunc('hour', e.created_at)) * 1000)::bigint AS hr,
               count(*) FILTER (WHERE e.k = 'c') AS c, count(*) FILTER (WHERE e.k = 'v') AS v
          FROM ev e JOIN topag USING (agent_name)
         WHERE e.created_at > now() - interval '24 hours'
         GROUP BY 1, 2
      ) a
  ),
  eff AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_array(code, c, v)), '[]'::jsonb) AS j
      FROM (
        SELECT COALESCE(substring(agent_name FROM '_([a-z]{2}[0-9]{2})(@|$)'), 'other') AS code,
               count(*) FILTER (WHERE k = 'c') AS c, count(*) FILTER (WHERE k = 'v') AS v
          FROM ev WHERE created_at > now() - interval '24 hours' GROUP BY 1
      ) f
  )
  SELECT jsonb_build_object('snapshots', snaps.j, 'output', outp.j, 'agents', ag.j, 'eff24', eff.j, 'now', (extract(epoch FROM now()) * 1000)::bigint)
    FROM snaps, outp, ag, eff;
$$;
REVOKE ALL ON FUNCTION public.quota_history(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quota_history(integer, integer) TO service_role;
COMMENT ON FUNCTION public.quota_history(integer, integer) IS 'console-vm 燒速／效率／圖表用：額度快照（分格）、每小時產出（按帳號代碼）、24 小時各代理產出、24 小時效率分子；只授權 service_role';

-- ── 排程 ───────────────────────────────────────────────────
SELECT cron.unschedule('quota-snapshots-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'quota-snapshots-10min');
SELECT cron.schedule('quota-snapshots-10min', '*/10 * * * *', $$
  SELECT net.http_post(
    url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/console-vm',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'agent_usage_cron_secret' LIMIT 1), '')
    ),
    body := '{"action":"snapshot_quota_history"}'::jsonb,
    timeout_milliseconds := 30000
  );
$$);
SELECT cron.unschedule('quota-snapshots-prune') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'quota-snapshots-prune');
SELECT cron.schedule('quota-snapshots-prune', '23 19 * * *', $$DELETE FROM public.quota_snapshots WHERE captured_at < now() - interval '8 days'$$);

NOTIFY pgrst, 'reload schema';
