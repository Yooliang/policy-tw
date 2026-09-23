-- queue_preview：驗證項目的主角補上（2026-09-23）
-- no_change／correction／removal 的 payload 沒有 name／title，佇列頁一整排「驗證 correction」看不出是誰的；
-- 用 contribution_subject_politician() 反查人物姓名，政見類再退回政見標題。CREATE OR REPLACE 會重設安全屬性，
-- SECURITY DEFINER 與 search_path 要再寫一次（000002 的理由：contributions 對 anon 關閉）。
CREATE OR REPLACE FUNCTION queue_preview(p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (pos INTEGER, kind TEXT, task_id TEXT, task_type TEXT, subject TEXT, region TEXT, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH items AS (
    SELECT 'task'::TEXT AS kind, g.task_id, g.task_type,
           COALESCE(NULLIF(g.target->>'name', ''), NULLIF(g.target->>'policy_title', ''), NULLIF(g.target->>'title', ''), '') AS subject,
           COALESCE(g.region, g.target->>'region') AS region,
           d.queue_at
      FROM contribution_auto_tasks_arms() g
      JOIN task_dispatches d ON d.task_id = g.task_id
    UNION ALL
    SELECT 'task', t.id::TEXT, t.task_type, t.title, t.region,
           COALESCE(t.last_dispatched_at,
                    CASE WHEN t.source IN ('manual', 'auto_dispute', 'web_request') THEN TIMESTAMPTZ '1980-01-01' ELSE t.created_at END)
      FROM contribution_tasks t
     WHERE t.status = 'open'
    UNION ALL
    SELECT 'verify', 'verify:' || c.id, c.contribution_type,
           COALESCE(
             NULLIF(c.payload->>'name', ''),
             (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(c.payload)),
             (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(c.payload->>'policy_id')),
             NULLIF(c.payload->>'title', ''),
             ''
           ),
           COALESCE(c.payload->>'region', (SELECT p.region FROM politicians p WHERE p.id = contribution_subject_politician(c.payload))),
           COALESCE(d.queue_at, c.created_at)
      FROM contributions c
      LEFT JOIN task_dispatches d ON d.task_id = 'verify:' || c.id
     WHERE c.status = 'pending'
  )
  SELECT row_number() OVER (ORDER BY i.queue_at, i.kind, i.task_id)::INTEGER AS pos,
         i.kind, i.task_id, i.task_type, i.subject, i.region, i.queue_at
    FROM items i
   ORDER BY i.queue_at, i.kind, i.task_id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 2000));
$$;
REVOKE ALL ON FUNCTION queue_preview(INTEGER) FROM public;
GRANT EXECUTE ON FUNCTION queue_preview(INTEGER) TO anon, authenticated;
