-- /queue 的驗證清單被截在 200 筆（小良哥 09-24：「佇列裡還是大量的 A 跟大量的 B 集中在一起」）
--
-- queue_preview 讀驗證時借用了 contribution_verify_pool，而驗證池一次最多回 200 筆（那是給 /next 用的上限）。
-- 1,565 筆待驗證只顯示前 200 筆，後面全是任務，看起來像「驗證排完、只剩一大串任務」——實際佇列照 2:1 交錯。
-- 改成直接讀待驗證的貢獻，套同一條可派條件。

CREATE OR REPLACE FUNCTION queue_preview(p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (pos INTEGER, kind TEXT, task_id TEXT, task_type TEXT, subject TEXT, region TEXT, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH items AS (
    SELECT 'task'::TEXT AS kind, g.task_id, g.task_type,
           COALESCE(NULLIF(g.target->>'name', ''), NULLIF(g.target->>'policy_title', ''), NULLIF(g.target->>'title', ''), '') AS subject,
           g.target->>'region' AS region, g.queue_at, 2 AS tie
      FROM contribution_auto_tasks(NULL, NULL, 100000, '', NULL, NULL) g
    UNION ALL
    SELECT 'task', t.id::TEXT, t.task_type, t.title, t.region,
           COALESCE(t.last_dispatched_at,
                    CASE WHEN t.source IN ('manual', 'auto_dispute', 'web_request') THEN TIMESTAMPTZ '1980-01-01' ELSE t.created_at END), 1
      FROM contribution_tasks t
     WHERE t.status = 'open'
    UNION ALL
    SELECT 'verify', 'verify:' || v.id, v.contribution_type,
           COALESCE(NULLIF(v.payload->>'name', ''),
                    (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(v.payload)),
                    (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(v.payload->>'policy_id')),
                    NULLIF(v.payload->>'title', ''), ''),
           COALESCE(v.payload->>'region', (SELECT p.region FROM politicians p WHERE p.id = contribution_subject_politician(v.payload))),
           COALESCE(d.queue_at, v.created_at), 0
      FROM contributions v
      LEFT JOIN task_dispatches d ON d.task_id = 'verify:' || v.id
     WHERE v.status = 'pending'
       -- 跟驗證池同一條可派條件（分數未達標，或高風險型別還不到兩台機器）；不用驗證池本身，因為它一次最多回 200 筆
       AND (v.score < COALESCE(v.target_score, contribution_effective_agree(v.id))
            OR (v.contribution_type IN ('merge_politician', 'candidacy', 'removal') AND v.voter_ips < 2))
  )
  SELECT row_number() OVER (ORDER BY i.queue_at, i.tie, i.task_id)::INTEGER AS pos,
         i.kind, i.task_id, i.task_type, i.subject, i.region, i.queue_at
    FROM items i
   ORDER BY i.queue_at, i.tie, i.task_id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 2000));
$$;
COMMENT ON FUNCTION queue_preview IS '派工佇列預覽（/queue 頁）：跟 /next 同一個時間軸（task_dispatches.queue_at，進表時已按驗證：任務 2:1 排好）';
