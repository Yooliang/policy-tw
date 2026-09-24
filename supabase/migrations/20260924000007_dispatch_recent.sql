-- /queue 看得到「誰領走了什麼」（小良哥 2026-09-24：「a-zhen 領走的應該看的到吧」）
--
-- 派工本來就會記：任務認領（contribution_task_leases，30 分鐘）、驗證派發（verify_dispatches）。
-- 這裡把最近 p_minutes 分鐘的兩者合成一份給頁面讀；只回代號，不回來源 IP。
CREATE OR REPLACE FUNCTION dispatch_recent(p_minutes INTEGER DEFAULT 30)
RETURNS TABLE (kind TEXT, task_id TEXT, agent_name TEXT, dispatched_at TIMESTAMPTZ, active_until TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'task', l.task_id, l.agent_name, l.leased_until - INTERVAL '30 minutes', l.leased_until
    FROM contribution_task_leases l
   WHERE l.leased_until - INTERVAL '30 minutes' > now() - make_interval(mins => LEAST(GREATEST(COALESCE(p_minutes, 30), 1), 240))
  UNION ALL
  SELECT 'verify', 'verify:' || v.contribution_id, v.agent_name, v.dispatched_at, v.dispatched_at + INTERVAL '30 minutes'
    FROM verify_dispatches v
   WHERE v.dispatched_at > now() - make_interval(mins => LEAST(GREATEST(COALESCE(p_minutes, 30), 1), 240))
  ORDER BY 4 DESC
  LIMIT 500;
$$;
REVOKE ALL ON FUNCTION dispatch_recent(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dispatch_recent(INTEGER) TO anon, authenticated;
COMMENT ON FUNCTION dispatch_recent IS '最近 N 分鐘派出了什麼、派給哪個代號（/queue 頁用；不含來源 IP）';
