-- 派工佇列預覽（2026-09-23 小良哥：「一個頁面，最近 1000 筆的任務依它會被領走的順序向下排」）
--
-- 跟 /next 同一把尺：三個來源（待驗證貢獻、手動任務、自動缺口）各自的 queue_at，全站按 queue_at 排。
-- 這是「全站」順序，不含每個代理各自的排除（自己交的、投過的、15 分鐘內派過的），所以某個代理實際領到的
-- 可能是清單裡靠後一點的那筆；但整體先後就是這樣。手動任務的 queue_at 照 _shared/dispatch.ts 的 manualQueueAt：
-- 派過＝上次派出時間；沒派過而來源是 manual／auto_dispute／web_request＝1980-01-01；其餘＝建立時間。

CREATE OR REPLACE FUNCTION queue_preview(p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (pos INTEGER, kind TEXT, task_id TEXT, task_type TEXT, subject TEXT, region TEXT, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
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
           COALESCE(NULLIF(c.payload->>'name', ''), NULLIF(c.payload->>'title', ''), ''),
           c.payload->>'region',
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
COMMENT ON FUNCTION queue_preview IS '全站派工順序前 N 筆（驗證＋手動任務＋自動缺口，按 queue_at）。給 /queue 頁用；公開可讀，跟 /next 同一把尺但不含每個代理各自的排除。';
GRANT EXECUTE ON FUNCTION queue_preview(INTEGER) TO anon, authenticated;
